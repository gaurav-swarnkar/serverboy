// Backup of Serverboy itself: its data folder (servers with their encrypted SSH secrets, settings,
// backup settings, the encryption key) and the team database (users, roles, messages, activity).
//
// The file is encrypted with a passphrase chosen by the owner (AES-256-GCM, key from scrypt),
// because it contains the key that unlocks every stored server password and SSH key. Without the
// passphrase the file is useless, to an attacker and to you, so it must be written down.
//
// File layout: "SBBK1" | salt(16) | iv(12) | tag(16) | AES-256-GCM(gzip(JSON))
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const store = require('./store');
const team = require('./team');
const remote = require('./backup-remote');
const version = require('./version');
const { HttpError } = require('./ssh');

const MAGIC = Buffer.from('SBBK1');
// Two-step login, notification devices and AI access belong to the people too.
const DATA_FILES = ['config.json', 'servers.json', 'twofactor.json', 'push.json', 'ai-access.json', 'health-ignores.json'];
const TEAM_COLLECTIONS = ['users', 'roles', 'messages', 'audit'];
const MIN_PASSPHRASE = 12;

function keyFrom(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function encrypt(obj, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(JSON.stringify(obj))), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

function decrypt(buf, passphrase) {
  if (!Buffer.isBuffer(buf) || buf.length < 50 || !buf.subarray(0, 5).equals(MAGIC)) throw new HttpError(400, 'This is not a Serverboy backup file (.sbbackup).');
  const salt = buf.subarray(5, 21);
  const iv = buf.subarray(21, 33);
  const tag = buf.subarray(33, 49);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(passphrase, salt), iv);
    d.setAuthTag(tag);
    const plain = Buffer.concat([d.update(buf.subarray(49)), d.final()]);
    return JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Wrong passphrase, or the file is damaged.');
  }
}

// ---------------- settings (stored in config.json; passphrase encrypted with the store key) ----------------

function settings() {
  const s = store.getSelfBackup() || {};
  return { enabled: false, keep: 14, storageFrom: null, ...s };
}

function publicSettings() {
  const s = settings();
  return {
    enabled: s.enabled,
    keep: s.keep,
    storageFrom: s.storageFrom,
    passphraseSet: Boolean(s.passphrase),
    last: s.last || null,
    usesEnvSecret: Boolean(process.env.SERVERBOY_SECRET),
    storages: store
      .listServers()
      .map((sv) => ({ id: sv.id, name: sv.name, label: remote.describe(store.getBackupConfig(sv.id)?.remote) }))
      .filter((x) => store.getBackupConfig(x.id)?.remote?.type && store.getBackupConfig(x.id).remote.type !== 'none'),
  };
}

function saveSettings(body) {
  const cur = settings();
  const next = { ...cur, enabled: Boolean(body.enabled), keep: Math.min(90, Math.max(1, Math.round(Number(body.keep) || 14))), storageFrom: body.storageFrom ? String(body.storageFrom) : null };
  if (body.passphrase) {
    if (String(body.passphrase).length < MIN_PASSPHRASE) throw new HttpError(400, `The passphrase must be at least ${MIN_PASSPHRASE} characters.`);
    next.passphrase = String(body.passphrase);
  }
  if (next.enabled) {
    if (!next.passphrase) throw new HttpError(400, 'Choose a passphrase first.');
    if (!next.storageFrom || !storageOf(next.storageFrom)) throw new HttpError(400, 'Choose where to keep the copies (a server whose backups go to cloud storage).');
  }
  store.setSelfBackup(next);
  return publicSettings();
}

function storageOf(serverId) {
  const r = store.getBackupConfig(serverId)?.remote;
  return r && r.type !== 'none' ? r : null;
}

// ---------------- create ----------------

async function snapshot() {
  const files = {};
  for (const f of DATA_FILES) {
    try {
      files[f] = fs.readFileSync(path.join(store.DATA_DIR, f), 'utf8');
    } catch {
      /* not created yet */
    }
  }
  const out = {
    format: 'serverboy-backup',
    v: 1,
    createdAt: new Date().toISOString(),
    serverboyVersion: version.version,
    usesEnvSecret: Boolean(process.env.SERVERBOY_SECRET),
    files,
    team: null,
  };
  if (team.isConfigured()) {
    const db = await team.getDb();
    out.team = {};
    const { EJSON } = require('mongodb').BSON;
    for (const c of TEAM_COLLECTIONS) {
      const limit = c === 'audit' ? 20000 : 0;
      const docs = await db.collection(c).find({}).sort(c === 'audit' ? { at: -1 } : {}).limit(limit).toArray();
      out.team[c] = EJSON.serialize(docs, { relaxed: false });
    }
  }
  return out;
}

function summary(snap) {
  let servers = [];
  try {
    servers = JSON.parse(snap.files['servers.json'] || '[]').map((s) => s.name);
  } catch {
    /* empty */
  }
  return {
    createdAt: snap.createdAt,
    serverboyVersion: snap.serverboyVersion,
    servers,
    users: snap.team?.users?.length ?? null,
    roles: snap.team?.roles?.length ?? null,
    messages: snap.team?.messages?.length ?? null,
    activity: snap.team?.audit?.length ?? null,
    usesEnvSecret: snap.usesEnvSecret,
  };
}

const fileName = (d = new Date()) => `serverboy-${d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.sbbackup`;

async function createFile(passphrase) {
  if (!passphrase || String(passphrase).length < MIN_PASSPHRASE) throw new HttpError(400, `Enter a passphrase of at least ${MIN_PASSPHRASE} characters.`);
  const snap = await snapshot();
  return { name: fileName(), data: encrypt(snap, passphrase), summary: summary(snap) };
}

// Automatic copy to cloud storage (called daily by the scheduler).
async function runScheduled({ force = false } = {}) {
  const s = settings();
  if (!force && !s.enabled) return null;
  const cfg = storageOf(s.storageFrom);
  if (!cfg || !s.passphrase) throw new HttpError(400, 'Serverboy backups need a passphrase and cloud storage.');
  const { name, data, summary: sum } = await createFile(s.passphrase);
  try {
    // Signed upload straight from Serverboy (it is small: settings and the team database).
    const { url, headers } = remote.signedUrl(cfg, 'PUT', `_serverboy/${name}`, 600);
    const res = await fetch(url, { method: 'PUT', body: data, headers: Object.fromEntries(headers.map((h) => h.split(': '))), signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`storage said ${res.status}: ${(await res.text()).slice(0, 200)}`);
    // Keep the newest N.
    const all = (await remote.list(cfg, '_serverboy/')).filter((o) => /\/serverboy-\d{8}-\d{6}\.sbbackup$/.test(o.rel)).sort((a, b) => (a.rel < b.rel ? 1 : -1));
    for (const o of all.slice(s.keep)) await remote.remove(cfg, o.rel);
    const last = { at: new Date().toISOString(), status: 'success', name, size: data.length, where: remote.describe(cfg), servers: sum.servers.length, users: sum.users };
    store.setSelfBackup({ ...settings(), last });
    return last;
  } catch (err) {
    const last = { at: new Date().toISOString(), status: 'failed', error: err.message, where: remote.describe(cfg) };
    store.setSelfBackup({ ...settings(), last });
    throw new HttpError(502, `Could not copy the Serverboy backup to cloud storage: ${err.message}`);
  }
}

async function listCloud() {
  const cfg = storageOf(settings().storageFrom);
  if (!cfg) return [];
  return (await remote.list(cfg, '_serverboy/'))
    .filter((o) => /serverboy-\d{8}-\d{6}\.sbbackup$/.test(o.rel))
    .map((o) => ({ name: o.rel.split('/').pop(), size: o.size, modified: o.modified }))
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

async function readCloud(name) {
  if (!/^serverboy-\d{8}-\d{6}\.sbbackup$/.test(String(name))) throw new HttpError(400, 'Unknown file');
  const cfg = storageOf(settings().storageFrom);
  if (!cfg) throw new HttpError(400, 'No cloud storage chosen');
  const { url, headers } = remote.signedUrl(cfg, 'GET', `_serverboy/${name}`, 300);
  const res = await fetch(url, { headers: Object.fromEntries(headers.map((h) => h.split(': '))), signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new HttpError(502, `Storage said ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------- restore ----------------

function preview(buf, passphrase) {
  const snap = decrypt(buf, passphrase);
  if (snap.format !== 'serverboy-backup') throw new HttpError(400, 'Not a Serverboy backup');
  return summary(snap);
}

// Replace Serverboy's data with the backup, then restart (systemd starts it again).
async function restore(buf, passphrase, { log = () => {} } = {}) {
  const snap = decrypt(buf, passphrase);
  if (snap.format !== 'serverboy-backup') throw new HttpError(400, 'Not a Serverboy backup');
  if (snap.usesEnvSecret && !process.env.SERVERBOY_SECRET) {
    throw new HttpError(400, 'This backup was made while SERVERBOY_SECRET was set. Set the same SERVERBOY_SECRET in /etc/serverboy.env first, restart, then restore.');
  }
  // Keep the current data next to it, just in case.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const keepDir = path.join(store.DATA_DIR, `before-restore-${stamp}`);
  fs.mkdirSync(keepDir, { recursive: true, mode: 0o700 });
  for (const f of DATA_FILES) {
    const p = path.join(store.DATA_DIR, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(keepDir, f));
  }
  log(`Current data copied to ${keepDir}`);
  // Team database: restore into the database named in the backup's settings (the restored
  // config.json may point to a different team database than now).
  if (snap.team) {
    const restoredConfig = JSON.parse(snap.files['config.json'] || '{}');
    const uri = process.env.SERVERBOY_MONGO_URI || (restoredConfig.teamDb ? decryptWith(restoredConfig, restoredConfig.teamDb).uri : '');
    if (uri) {
      const { MongoClient, BSON } = require('mongodb');
      const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
      try {
        await client.connect();
        const db = client.db();
        for (const c of TEAM_COLLECTIONS) {
          const docs = BSON.EJSON.deserialize(snap.team[c] || [], { relaxed: false });
          await db.collection(c).deleteMany({});
          if (docs.length) await db.collection(c).insertMany(docs, { ordered: false });
          log(`Team database: ${c} restored (${docs.length})`);
        }
      } catch (err) {
        throw new HttpError(502, `Could not restore the team database (${err.message}). Nothing else was changed; your current data is in ${keepDir}.`);
      } finally {
        await client.close().catch(() => {});
      }
    } else log('The backup has team data but no team database is set; skipped.');
  }
  for (const f of DATA_FILES) {
    if (snap.files[f] === undefined) continue;
    const p = path.join(store.DATA_DIR, f);
    fs.writeFileSync(`${p}.restore-tmp`, snap.files[f], { mode: 0o600 });
    fs.renameSync(`${p}.restore-tmp`, p);
  }
  // Old sessions belong to the previous data: everyone logs in again (also clears the ones in
  // memory, which would otherwise be written back to disk when this process exits).
  require('./auth').clearAllSessions();
  // Read the restored files now, so nothing in memory writes the old ones back before the restart.
  for (const m of ['./twofactor', './push', './ai-access', './health-ignore']) require(m).reload();
  log('Serverboy data restored. Restarting…');
  if (process.env.ADMIN_PASSWORD) log('Log in with the admin password of this installation (ADMIN_PASSWORD in /etc/serverboy.env).');
  return { restarting: true, underSystemd: Boolean(process.env.INVOCATION_ID), summary: summary(snap) };
}

// Decrypt a value from another config.json (same key derivation as lib/store.js).
function decryptWith(config, box) {
  const key = crypto.scryptSync(process.env.SERVERBOY_SECRET || config.secret, 'serverboy-store', 32);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
}

// Once a day (and a retry 6 hours after a failure) while automatic copies are on.
let timer = null;
function startScheduler() {
  if (timer) return;
  const tick = () => {
    const s = settings();
    if (!s.enabled) return;
    const age = s.last ? Date.now() - Date.parse(s.last.at) : Infinity;
    if (age < (s.last?.status === 'failed' ? 6 : 23.5) * 3600e3) return;
    runScheduled().catch((err) => {
      console.error(`Serverboy backup: ${err.message}`);
      require('./backups').notifyOwner('Serverboy backup failed', `The daily backup of Serverboy itself (servers, settings, team) could not be copied to cloud storage.\n\n${err.message}\n\nOpen Administration → Settings → Serverboy backup.`);
    });
  };
  timer = setInterval(tick, 10 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 60 * 1000).unref?.();
}

module.exports = {
  startScheduler, settings, publicSettings, saveSettings, createFile, runScheduled, listCloud, readCloud, preview, restore, encrypt, decrypt, MIN_PASSPHRASE };
