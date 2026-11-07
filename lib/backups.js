// Backups of a managed server: MongoDB, MySQL/MariaDB, website and app folders, and server
// settings (Nginx, SSL certificates, PM2 list, crontabs).
//
// Each backup is a folder on the server, /var/backups/serverboy/<id>/, holding one compressed file
// per item and a manifest.json. Optionally every file is also copied to S3-compatible storage or
// Azure Blob (lib/backup-remote.js) under <prefix>/<server>/<id>/. Serverboy runs the schedule.
const crypto = require('crypto');
const ssh = require('./ssh');
const store = require('./store');
const jobs = require('./jobs');
const remote = require('./backup-remote');
const { DEFAULT_MONGO_URI } = require('./mongosh');

const { q, HttpError } = ssh;
const ROOT = '/var/backups/serverboy';
const ID_RE = /^\d{8}-\d{6}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,99}$/;
const MYSQL_SYSTEM = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
const MONGO_SYSTEM = new Set(['admin', 'local', 'config']);
// Files above this are uploaded in 4 GiB parts (single-upload limit is 5 GB). Overridable for tests.
const PART_SIZE = Number(process.env.SERVERBOY_BACKUP_PART_BYTES) || 4 * 1024 ** 3;
const running = new Map(); // serverId -> job id (backup or restore)

const DEFAULTS = {
  enabled: false,
  schedule: { every: 'day', time: '03:00', weekday: 0, tz: 'UTC' },
  include: { mongo: true, mongoDbs: 'all', mysql: true, mysqlDbs: 'all', files: true, fileDirs: 'all', skipNodeModules: true, settings: true },
  keepLocal: 7,
  keepRemote: 30,
  drill: 'week', // automatic test-restore: 'week' | 'month' | 'off'
  localOnlyOk: false, // the owner chose to keep backups on the server only: no warning about it
};
const DRILL_DAYS = { week: 7, month: 30 };

// ---------------- settings ----------------

function settings(serverId) {
  const c = store.getBackupConfig(serverId) || {};
  return {
    ...DEFAULTS,
    ...c,
    schedule: { ...DEFAULTS.schedule, ...(c.schedule || {}) },
    include: { ...DEFAULTS.include, ...(c.include || {}) },
    remote: c.remote || { type: 'none' },
    state: c.state || {},
  };
}

const intIn = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

function validTz(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

const nameList = (v) => (v === 'all' || !Array.isArray(v) ? 'all' : [...new Set(v.map(String).filter((n) => SAFE_NAME.test(n)))]);

function saveSettings(serverId, body, current = settings(serverId)) {
  const s = body.schedule || {};
  const inc = body.include || {};
  const next = {
    enabled: Boolean(body.enabled),
    schedule: {
      every: ['6h', '12h', 'day', 'week'].includes(s.every) ? s.every : 'day',
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time) ? s.time : '03:00',
      weekday: intIn(s.weekday, 0, 6, 0),
      tz: validTz(String(s.tz || 'UTC')),
    },
    include: {
      mongo: inc.mongo !== false,
      mongoDbs: nameList(inc.mongoDbs),
      mysql: inc.mysql !== false,
      mysqlDbs: nameList(inc.mysqlDbs),
      files: inc.files !== false,
      fileDirs: nameList(inc.fileDirs),
      skipNodeModules: inc.skipNodeModules !== false,
      settings: inc.settings !== false,
    },
    keepLocal: intIn(body.keepLocal, 1, 90, 7),
    keepRemote: intIn(body.keepRemote, 1, 365, 30),
    drill: ['week', 'month', 'off'].includes(body.drill) ? body.drill : 'week',
    localOnlyOk: body.localOnlyOk === undefined ? Boolean(current.localOnlyOk) : Boolean(body.localOnlyOk),
  };
  // Storage: keep the stored secret when the form sends it back empty ("unchanged").
  let r = body.remote || current.remote || { type: 'none' };
  if (r.type === 's3') {
    r = {
      type: 's3',
      endpoint: String(r.endpoint || '').trim(),
      region: String(r.region || '').trim(),
      bucket: String(r.bucket || '').trim(),
      prefix: remote.cleanPrefix(r.prefix),
      accessKeyId: String(r.accessKeyId || '').trim(),
      secretAccessKey: String(r.secretAccessKey || '') || (current.remote.type === 's3' ? current.remote.secretAccessKey : ''),
    };
  } else if (r.type === 'azure') {
    r = { type: 'azure', sasUrl: String(r.sasUrl || '').trim() || (current.remote.type === 'azure' ? current.remote.sasUrl : ''), prefix: remote.cleanPrefix(r.prefix) };
  } else r = { type: 'none' };
  remote.validate(r);
  next.remote = r;
  const wasEnabled = current.enabled;
  store.setBackupConfig(serverId, next);
  // Start the schedule from now, so turning it on does not fire a missed run at once.
  if (next.enabled && !wasEnabled) store.setBackupState(serverId, { cursor: floorMinute(new Date()).toISOString() });
  return publicSettings(serverId);
}

// Settings for the browser: secrets are replaced by "is set".
function publicSettings(serverId) {
  const s = settings(serverId);
  const r = { ...s.remote };
  if (r.secretAccessKey) r.secretAccessKey = '';
  if (r.sasUrl) r.sasUrl = '';
  return {
    enabled: s.enabled,
    schedule: s.schedule,
    include: s.include,
    keepLocal: s.keepLocal,
    keepRemote: s.keepRemote,
    drill: s.drill,
    localOnlyOk: Boolean(s.localOnlyOk),
    remote: r,
    remoteSecretSet: Boolean(s.remote.secretAccessKey || s.remote.sasUrl),
    remoteLabel: remote.describe(s.remote),
    state: { last: s.state.last || null, lastSuccessAt: s.state.lastSuccessAt || null, lastDrill: s.state.lastDrill || null, running: running.get(serverId) || null },
    nextRun: s.enabled ? nextRun(s.schedule)?.toISOString() || null : null,
    configured: Boolean(store.getBackupConfig(serverId)),
  };
}

// ---------------- schedule ----------------

const floorMinute = (d) => new Date(Math.floor(d.getTime() / 60000) * 60000);
const fmtCache = new Map();
function localParts(date, tz) {
  if (!fmtCache.has(tz)) fmtCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' }));
  const p = Object.fromEntries(fmtCache.get(tz).formatToParts(date).map((x) => [x.type, x.value]));
  return { hh: Number(p.hour) % 24, mm: Number(p.minute), wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

function isSlot(date, sch) {
  const { hh, mm, wd } = localParts(date, sch.tz);
  const [H, M] = sch.time.split(':').map(Number);
  if (mm !== M) return false;
  if (sch.every === '6h') return hh % 6 === H % 6;
  if (sch.every === '12h') return hh % 12 === H % 12;
  if (sch.every === 'week') return wd === Number(sch.weekday) && hh === H;
  return hh === H;
}

function nextRun(sch, from = new Date()) {
  let t = floorMinute(from).getTime() + 60000;
  for (let i = 0; i < 8 * 24 * 60; i++, t += 60000) if (isSlot(new Date(t), sch)) return new Date(t);
  return null;
}

const PERIOD_H = { '6h': 6, '12h': 12, day: 24, week: 168 };

// Called every minute: run any backup whose time came since the last check (also catches up
// once after Serverboy was stopped through a scheduled time).
function tick() {
  const now = floorMinute(new Date());
  for (const serverId of store.listBackupServers()) {
    try {
      if (!store.getServer(serverId)) continue;
      const s = settings(serverId);
      if (!s.enabled) continue;
      let cursor = s.state.cursor ? new Date(s.state.cursor) : new Date(now.getTime() - 60000);
      if (now - cursor > 8 * 24 * 3600e3) cursor = new Date(now.getTime() - 8 * 24 * 3600e3);
      let due = false;
      for (let t = cursor.getTime() + 60000; t <= now.getTime(); t += 60000) {
        if (isSlot(new Date(t), s.schedule)) {
          due = true;
          break;
        }
      }
      if (now > cursor) store.setBackupState(serverId, { cursor: now.toISOString() });
      if (due && !running.has(serverId)) startBackup(serverId, { reason: 'scheduled' });
    } catch (err) {
      console.error(`Backup schedule for ${serverId}: ${err.message}`);
    }
  }
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(tick, 60 * 1000);
  timer.unref?.();
}

// ---------------- helpers ----------------

function serverSlug(serverId) {
  const server = store.getServer(serverId);
  const name = String(server?.name || 'server').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server';
  return `${name}-${serverId.slice(0, 8)}`;
}

// mongodump/mongorestore refuse a database in the URI together with --db / --nsInclude.
function toolUri(serverId) {
  const raw = store.getServer(serverId).mongoUri || DEFAULT_MONGO_URI;
  const m = raw.match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/);
  if (!m) return raw;
  const params = new URLSearchParams(m[3] || '');
  if (m[2] && !params.has('authSource') && /@/.test(m[1])) params.set('authSource', decodeURIComponent(m[2]));
  const qs = params.toString();
  return `${m[1]}/${qs ? `?${qs}` : ''}`;
}

// curl output → one short line (it repeats the same error on every retry).
const curlError = (r) => [...new Set((r.stdout + r.stderr).replace(/^\d{3}(?=curl:)/m, '').split('\n').map((l) => l.trim()).filter(Boolean))].slice(-2).join(' ').slice(0, 300);

const fmtSize = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function newId(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function itemOf(file) {
  let m;
  if ((m = file.match(/^mongo-(.+)\.archive\.gz$/))) return { type: 'mongo', name: m[1] };
  if ((m = file.match(/^mysql-(.+)\.sql\.gz$/))) return { type: 'mysql', name: m[1] };
  if ((m = file.match(/^files-(.+)\.tar\.gz$/))) return { type: 'files', name: m[1] };
  if (file === 'server-settings.tar.gz') return { type: 'settings', name: 'Server settings' };
  return null;
}

// Tell the owner in Messages (shows in the ✉ count) when a scheduled backup fails.
async function notifyOwner(subject, body) {
  const team = require('./team');
  if (!team.isConfigured()) return;
  try {
    const db = await team.getDb();
    const now = new Date();
    await db.collection('messages').insertOne({ fromId: 'serverboy', fromName: 'Serverboy', to: ['owner'], subject, body, level: 'important', createdAt: now, lastAt: now, readBy: [], replies: [] });
  } catch {
    /* never break the backup over a message */
  }
}

// ---------------- what can be backed up ----------------

// Run discovery with the MongoDB URI in a private temp file (never in the command line).
async function inventory(serverId) {
  const uriFile = await ssh.writeSecretTemp(serverId, store.getServer(serverId).mongoUri || DEFAULT_MONGO_URI);
  const server = store.getServer(serverId);
  try {
    const r = await ssh.exec(
      serverId,
      `SB_URI=$(cat ${q(uriFile)}); rm -f ${q(uriFile)}
echo "##MONGO"; if command -v mongosh >/dev/null; then mongosh "$SB_URI" --quiet --norc --eval 'print(EJSON.stringify(db.adminCommand({listDatabases:1}).databases.map(d=>({name:d.name,size:d.sizeOnDisk}))))' 2>&1 | tail -1; fi
echo "##DUMP"; command -v mongodump >/dev/null && echo yes
echo "##MYSQL"; if command -v mysql >/dev/null; then mysql -N -e "SELECT s.schema_name, COALESCE(SUM(t.data_length+t.index_length),0) FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema=s.schema_name GROUP BY s.schema_name" 2>/tmp/.sb-mysql-err || { echo "##MYSQLERR"; head -c 300 /tmp/.sb-mysql-err; }; rm -f /tmp/.sb-mysql-err; else echo "##NOMYSQL"; fi
echo "##FILES"; for d in /var/www/*/; do [ -d "$d" ] || continue; n=$(basename "$d"); s=$(du -sb --exclude=node_modules "$d" 2>/dev/null | cut -f1); echo "$n	$s"; done
echo "##FREE"; mkdir -p ${ROOT} && chmod 700 ${ROOT}; df -B1 --output=avail ${ROOT} | tail -1
echo "##END"`,
      { sudo: true, timeout: 5 * 60 * 1000 },
    );
    // Output is split into sections by marker lines (##NAME); an empty section stays empty.
    const sections = {};
    let cur = null;
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^##([A-Z]+)$/);
      if (m) {
        cur = m[1];
        sections[cur] = [];
      } else if (cur) sections[cur].push(line);
    }
    const part = (name) => (sections[name] || []).join('\n').trim();
    let mongo = null;
    let mongoError = null;
    const mongoLine = part('MONGO');
    if (mongoLine) {
      try {
        mongo = JSON.parse(mongoLine).filter((d) => !MONGO_SYSTEM.has(d.name));
      } catch {
        mongoError = mongoLine.slice(0, 300);
      }
    }
    const mysqlInstalled = !('NOMYSQL' in sections);
    const mysqlError = 'MYSQLERR' in sections ? part('MYSQLERR') || 'MySQL is not answering' : null;
    const mysql = mysqlInstalled && !mysqlError
      ? part('MYSQL')
          .split('\n')
          .map((l) => l.split('\t'))
          .filter(([n]) => n && !MYSQL_SYSTEM.has(n))
          .map(([name, size]) => ({ name, size: Number(size) || 0 }))
      : null;
    const files = part('FILES')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t'))
      .map(([name, size]) => ({ name, size: Number(size) || 0 }));
    return { mongo, mongoError, mongodump: part('DUMP') === 'yes', mysql, mysqlError, files, free: Number(part('FREE')) || 0, username: server.username };
  } finally {
    ssh.exec(serverId, `rm -f ${q(uriFile)}`).catch(() => {});
  }
}

const pick = (list, chosen) => (chosen === 'all' ? list : list.filter((x) => chosen.includes(x.name)));

// ---------------- backup ----------------

function backupScript({ id, plan, username, uriFile, skipNodeModules }) {
  const L = [];
  L.push(`set -u -o pipefail
umask 077
ROOT=${ROOT}; ID=${id}; DIR="$ROOT/$ID"
mkdir -p "$DIR" || exit 1
exec 9>"$ROOT/.lock"; flock -n 9 || { echo "Another backup or restore is running on this server."; rm -rf "$DIR"; exit 75; }
ITEMS="$DIR/.items"; : > "$ITEMS"; OK=0; BAD=0
add() { local f="$DIR/$3"; printf '{"type":"%s","name":"%s","file":"%s","size":%s,"sha256":"%s"}\\n' "$1" "$2" "$3" "$(stat -c %s "$f")" "$(sha256sum "$f" | cut -d' ' -f1)" >> "$ITEMS"; OK=$((OK+1)); echo "  ✔ $3 ($(du -h "$f" | cut -f1))"; }
bad() { printf '{"type":"%s","name":"%s","error":"%s"}\\n' "$1" "$2" "$3" >> "$ITEMS"; BAD=$((BAD+1)); rm -f "$DIR/$4"; echo "  ✘ $2: $3"; }
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)`);
  if (plan.mongo.length) {
    L.push(`CFG="$DIR/.mongo.yaml"; { printf 'uri: '; cat ${q(uriFile)}; echo; } > "$CFG"; rm -f ${q(uriFile)}
# YAML: the URI is written as a JSON string, which YAML reads as a quoted string.`);
    for (const d of plan.mongo) {
      const f = `mongo-${d.name}.archive.gz`;
      L.push(`echo "• MongoDB database ${d.name}"
if mongodump --config="$CFG" --db=${q(d.name)} --archive="$DIR/${f}" --gzip --quiet; then add mongo ${q(d.name)} ${q(f)}; else bad mongo ${q(d.name)} "mongodump failed (see above)" ${q(f)}; fi`);
    }
    L.push('rm -f "$CFG"');
  }
  for (const d of plan.mysql) {
    const f = `mysql-${d.name}.sql.gz`;
    L.push(`echo "• MySQL database ${d.name}"
if mysqldump --single-transaction --routines --triggers --events ${q(d.name)} | gzip > "$DIR/${f}"; then add mysql ${q(d.name)} ${q(f)}; else bad mysql ${q(d.name)} "mysqldump failed (see above)" ${q(f)}; fi`);
  }
  for (const d of plan.files) {
    const f = `files-${d.name}.tar.gz`;
    L.push(`echo "• Folder /var/www/${d.name}"
tar -czf "$DIR/${f}" --warning=no-file-changed ${skipNodeModules ? '--exclude=node_modules ' : ''}-C /var/www ${q(d.name)}; rc=$?
if [ $rc -le 1 ]; then add files ${q(d.name)} ${q(f)}; else bad files ${q(d.name)} "tar failed with code $rc" ${q(f)}; fi`);
  }
  if (plan.settings) {
    L.push(`echo "• Server settings (Nginx, SSL certificates, PM2 app list, crontabs)"
S="$DIR/.settings"; mkdir -p "$S"
for u in root ${q(username)}; do crontab -l -u "$u" > "$S/crontab-$u.txt" 2>/dev/null || rm -f "$S/crontab-$u.txt"; done
H=$(getent passwd ${q(username)} | cut -d: -f6)
P=(); for p in etc/nginx/sites-available etc/nginx/sites-enabled etc/nginx/serverboy etc/letsencrypt "\${H#/}/.pm2/dump.pm2" etc/ufw/user.rules etc/ufw/user6.rules; do [ -e "/$p" ] && P+=("$p"); done
if tar -czf "$DIR/server-settings.tar.gz" -C / "\${P[@]}" -C "$DIR" .settings 2>/dev/null; then add settings "Server settings" server-settings.tar.gz; else bad settings "Server settings" "tar failed" server-settings.tar.gz; fi
rm -rf "$S"`);
  }
  L.push(`STATUS=success; [ $BAD -gt 0 ] && STATUS=partial; [ $OK -eq 0 ] && STATUS=failed
printf '{"id":"%s","startedAt":"%s","finishedAt":"%s","status":"%s","items":[%s]}\\n' "$ID" "$STARTED" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STATUS" "$(paste -sd, "$ITEMS")" > "$DIR/manifest.json"
rm -f "$ITEMS"
echo; echo "Backup $STATUS: $OK item(s) saved$([ $BAD -gt 0 ] && echo ", $BAD failed") · total $(du -sh "$DIR" | cut -f1)"
exit 0`);
  return L.join('\n');
}

async function readManifest(serverId, id) {
  const r = await ssh.exec(serverId, `cat ${q(`${ROOT}/${id}/manifest.json`)} 2>/dev/null`, { sudo: true });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// Upload every file of a backup with curl, using signed URLs written to private temp files.
async function upload(serverId, cfg, id, manifest, log) {
  const slug = serverSlug(serverId);
  const files = manifest.items.filter((i) => i.file);
  for (const it of files) {
    const local = `${ROOT}/${id}/${it.file}`;
    const parts = it.size > PART_SIZE ? Math.ceil(it.size / PART_SIZE) : 0;
    const names = parts ? Array.from({ length: parts }, (_, i) => `${it.file}.part${String(i).padStart(3, '0')}`) : [it.file];
    if (parts) {
      log(`  splitting ${it.file} into ${parts} parts…\n`);
      await ssh.exec(serverId, `cd ${q(`${ROOT}/${id}`)} && split -b ${PART_SIZE} -d -a 3 ${q(it.file)} ${q(`${it.file}.part`)}`, { sudo: true, check: true, timeout: 60 * 60 * 1000 });
      it.parts = parts;
    }
    for (const name of names) {
      const { url, headers } = remote.signedUrl(cfg, 'PUT', `${slug}/${id}/${name}`);
      const conf = await ssh.writeSecretTemp(serverId, [`url = "${url}"`, ...headers.map((h) => `header = "${h}"`)].join('\n'));
      const r = await ssh.exec(
        serverId,
        `curl -sS --fail-with-body --retry 3 --retry-all-errors --connect-timeout 20 -T ${q(`${ROOT}/${id}/${name}`)} -K ${q(conf)} -o /dev/null -w '%{http_code}'; rc=$?; rm -f ${q(conf)}; exit $rc`,
        { sudo: true, timeout: 3 * 60 * 60 * 1000 },
      );
      if (r.code !== 0) throw new Error(`Upload of ${name} failed: ${curlError(r)}`);
      log(`  ✔ uploaded ${name}\n`);
    }
    if (parts) await ssh.exec(serverId, `rm -f ${q(local)}.part*`, { sudo: true });
  }
  await remote.putText(cfg, `${slug}/${id}/manifest.json`, JSON.stringify(manifest, null, 2));
}

async function applyRetention(serverId, s, log) {
  // On the server: keep the newest N good backups; failed ones go after 3 days. Safety copies after 14 days.
  const local = await listLocal(serverId);
  const good = local.filter((b) => b.status !== 'failed');
  const drop = good.slice(s.keepLocal).map((b) => b.id);
  const cutoff = newId(new Date(Date.now() - 3 * 24 * 3600e3));
  for (const b of local) if (b.status === 'failed' && b.id < cutoff) drop.push(b.id);
  if (drop.length) {
    await ssh.exec(serverId, `cd ${ROOT} && rm -rf ${drop.filter((d) => ID_RE.test(d)).map(q).join(' ')}`, { sudo: true });
    log(`Removed ${drop.length} old backup(s) from the server (keeping ${s.keepLocal}).\n`);
  }
  await ssh.exec(serverId, `[ -d ${ROOT}/safety ] && find ${ROOT}/safety -mindepth 1 -maxdepth 1 -mtime +14 -exec rm -rf {} + ; true`, { sudo: true });
  // In the cloud: keep the newest N backups.
  if (s.remote.type !== 'none') {
    const ids = await listRemoteIds(serverId, s.remote);
    const old = [...ids.keys()].sort().reverse().slice(s.keepRemote);
    for (const id of old) for (const f of ids.get(id).files) await remote.remove(s.remote, `${serverSlug(serverId)}/${id}/${f.name}`);
    if (old.length) log(`Removed ${old.length} old backup(s) from cloud storage (keeping ${s.keepRemote}).\n`);
  }
}

// "Keep backups on this server only": hide (or show again) the warning about it.
function setLocalOnlyOk(serverId, ok) {
  const current = settings(serverId);
  if (!store.getBackupConfig(serverId)) throw new HttpError(400, 'Set up backups first.');
  store.setBackupConfig(serverId, { ...store.getBackupConfig(serverId), remote: current.remote, localOnlyOk: Boolean(ok) });
  return publicSettings(serverId);
}

function startBackup(serverId, { reason = 'manual', user = 'serverboy' } = {}) {
  if (running.has(serverId)) throw new HttpError(409, 'A backup or restore is already running on this server.');
  const s = settings(serverId);
  const server = store.getServer(serverId);
  const id = newId();
  const ctx = { plan: null, manifest: null, uploaded: false, uploadError: null };
  const steps = [
    {
      label: 'Checking what to back up and the free disk space',
      fn: async (log) => {
        const inv = await inventory(serverId);
        const inc = s.include;
        const plan = {
          mongo: inc.mongo && inv.mongo ? pick(inv.mongo, inc.mongoDbs) : [],
          mysql: inc.mysql && inv.mysql ? pick(inv.mysql, inc.mysqlDbs) : [],
          files: inc.files ? pick(inv.files, inc.fileDirs) : [],
          settings: inc.settings,
        };
        for (const k of ['mongo', 'mysql', 'files']) {
          const skipped = plan[k].filter((x) => !SAFE_NAME.test(x.name));
          if (skipped.length) log(`Skipping ${skipped.map((x) => x.name).join(', ')}: unusual characters in the name.\n`);
          plan[k] = plan[k].filter((x) => SAFE_NAME.test(x.name));
        }
        if (inc.mongo && inv.mongoError) log(`MongoDB could not be listed, so it is skipped: ${inv.mongoError}\n`);
        if (inc.mysql && inv.mysqlError) {
          log(`MySQL is installed but not answering, so it is skipped: ${inv.mysqlError}\n`);
          ctx.warnings = [...(ctx.warnings || []), `MySQL was not backed up: ${inv.mysqlError.split('\n')[0]}`];
        }
        if (inc.mongo && inv.mongoError) ctx.warnings = [...(ctx.warnings || []), `MongoDB was not backed up: ${inv.mongoError.split('\n')[0]}`];
        if (plan.mongo.length && !inv.mongodump) throw new Error('mongodump is not installed. Install the "MongoDB database tools" (sudo apt-get install -y mongodb-database-tools) or reinstall MongoDB from the App Store.');
        const estimate = [...plan.mongo, ...plan.mysql, ...plan.files].reduce((n, x) => n + x.size, 0);
        log(`MongoDB: ${plan.mongo.map((d) => d.name).join(', ') || 'none'}\nMySQL: ${plan.mysql.map((d) => d.name).join(', ') || 'none'}\nFolders: ${plan.files.map((d) => d.name).join(', ') || 'none'}\nServer settings: ${plan.settings ? 'yes' : 'no'}\n`);
        log(`Data to read: about ${fmtSize(estimate)} · free on the disk: ${fmtSize(inv.free)}\n`);
        if (!plan.mongo.length && !plan.mysql.length && !plan.files.length && !plan.settings) throw new Error('Nothing to back up: choose at least one thing in the backup settings.');
        // Compressed backups are usually much smaller; still demand room for the raw size plus a margin.
        if (inv.free < estimate * 0.8 + 300 * 1024 ** 2) throw new Error(`Not enough free disk space: the backup needs up to ${fmtSize(estimate)} and only ${fmtSize(inv.free)} is free. Free some space (Disk & cleanup) or keep fewer backups.`);
        ctx.plan = plan;
        ctx.username = inv.username;
      },
    },
    {
      label: 'Creating the backup',
      fn: async (log) => {
        const uriFile = ctx.plan.mongo.length ? await ssh.writeSecretTemp(serverId, JSON.stringify(toolUri(serverId))) : '/dev/null';
        const scriptFile = await ssh.writeSecretTemp(serverId, backupScript({ id, plan: ctx.plan, username: ctx.username, uriFile, skipNodeModules: s.include.skipNodeModules }));
        const r = await ssh.exec(serverId, `bash ${q(scriptFile)}; rc=$?; rm -f ${q(scriptFile)} ${uriFile === '/dev/null' ? '' : q(uriFile)}; exit $rc`, { sudo: true, onData: log, timeout: 6 * 60 * 60 * 1000 });
        if (r.code === 75) throw new Error('Another backup or restore is running on this server.');
        ctx.manifest = await readManifest(serverId, id);
        if (!ctx.manifest) throw new Error('The backup did not finish (no manifest was written).');
        if (ctx.manifest.status === 'failed') throw new Error('No item could be backed up. See the log above.');
      },
    },
  ];
  if (s.remote.type !== 'none') {
    steps.push({
      label: `Copying to ${remote.describe(s.remote)}`,
      allowFail: true,
      fn: async (log) => {
        try {
          await upload(serverId, s.remote, id, ctx.manifest, log);
          ctx.uploaded = true;
        } catch (err) {
          ctx.uploadError = err.message;
          throw err;
        }
      },
    });
  }
  steps.push({ label: 'Removing old backups', allowFail: true, fn: (log) => applyRetention(serverId, s, log) });

  const finish = (status, error) => {
    running.delete(serverId);
    const m = ctx.manifest;
    const size = m ? m.items.reduce((n, i) => n + (i.size || 0), 0) : 0;
    const finalStatus = status === 'success' && (m?.status === 'partial' || ctx.uploadError || ctx.warnings?.length) ? 'partial' : status;
    const why = error || (ctx.uploadError ? `Saved on the server, but the cloud copy failed: ${ctx.uploadError}` : ctx.warnings?.length ? ctx.warnings.join(' ') : m?.status === 'partial' ? 'Some items failed; see the task log.' : null);
    const last = { id, status: finalStatus, at: new Date().toISOString(), size, items: m ? m.items.filter((i) => i.file).length : 0, uploaded: ctx.uploaded, error: why, reason, job: job.id };
    store.setBackupState(serverId, { last, ...(finalStatus !== 'failed' ? { lastSuccessAt: last.at } : {}) });
    // Prove the backups can be restored: a test-restore every week / month, after a scheduled backup.
    const ld = settings(serverId).state.lastDrill;
    // After a failed test, test the next scheduled backup right away.
    if (reason === 'scheduled' && finalStatus !== 'failed' && s.drill !== 'off' && (!ld || ld.status === 'failed' || Date.now() - Date.parse(ld.at) > DRILL_DAYS[s.drill] * 24 * 3600e3 - 3600e3)) {
      setTimeout(() => {
        try {
          startDrill(serverId, { reason: 'scheduled' });
        } catch (err) {
          console.error(`Test-restore of ${server.name}: ${err.message}`);
        }
      }, 5000).unref?.();
    }
    if (finalStatus !== 'success' && reason === 'scheduled') {
      notifyOwner(`Backup ${finalStatus === 'failed' ? 'failed' : 'incomplete'} on ${server.name}`, `The scheduled backup of ${server.name} ${finalStatus === 'failed' ? 'failed' : 'finished with problems'}.\n\n${why || ''}\n\nOpen ${server.name} → Backups to see the log.`);
    }
  };
  const job = jobs.create(serverId, `Backup of ${server.name}${reason === 'scheduled' ? ' (scheduled)' : ''}`, steps, { onDone: (status, error) => finish(status, error) });
  running.set(serverId, job.id);
  require('./team').audit({ user, action: `Started a backup of ${server.name}${reason === 'scheduled' ? ' (scheduled)' : ''}` });
  return job;
}

// ---------------- listing ----------------

async function listLocal(serverId) {
  const r = await ssh.exec(serverId, `[ -d ${ROOT} ] || exit 0; for d in ${ROOT}/*/; do n=$(basename "$d"); case "$n" in [0-9]*-[0-9]*) echo "##$n"; cat "$d/manifest.json" 2>/dev/null; echo;; esac; done`, { sudo: true });
  const out = [];
  for (const chunk of r.stdout.split('##').slice(1)) {
    const nl = chunk.indexOf('\n');
    const id = chunk.slice(0, nl).trim();
    if (!ID_RE.test(id)) continue;
    let m = null;
    try {
      m = JSON.parse(chunk.slice(nl + 1).trim());
    } catch {
      /* in progress or broken */
    }
    out.push({ id, status: m ? m.status : running.has(serverId) ? 'running' : 'failed', startedAt: m?.startedAt, finishedAt: m?.finishedAt, items: m?.items || [] });
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

async function listRemoteIds(serverId, cfg) {
  const objects = await remote.list(cfg, `${serverSlug(serverId)}/`);
  const ids = new Map();
  for (const o of objects) {
    const [id, ...rest] = o.rel.split('/').slice(1);
    const name = rest.join('/');
    if (!ID_RE.test(id || '') || !name) continue;
    if (!ids.has(id)) ids.set(id, { files: [] });
    ids.get(id).files.push({ name, size: o.size });
  }
  return ids;
}

// Backups from the server and from cloud storage, merged by id.
async function listAll(serverId) {
  const s = settings(serverId);
  const local = await listLocal(serverId);
  let cloud = new Map();
  let cloudError = null;
  if (s.remote.type !== 'none') {
    try {
      cloud = await listRemoteIds(serverId, s.remote);
    } catch (err) {
      cloudError = err.message;
    }
  }
  const byId = new Map(local.map((b) => [b.id, { ...b, onServer: true, inCloud: cloud.has(b.id) }]));
  for (const [id, c] of cloud) {
    if (byId.has(id)) continue;
    // Cloud only (e.g. removed from the server by retention): rebuild the item list from file names.
    const items = [];
    for (const f of c.files) {
      const base = f.name.replace(/\.part\d{3}$/, '');
      const kind = itemOf(base);
      if (!kind) continue;
      const existing = items.find((i) => i.file === base);
      if (existing) {
        existing.size += f.size;
        existing.parts = (existing.parts || 1) + 1;
      } else items.push({ ...kind, file: base, size: f.size, ...(base !== f.name ? { parts: 1 } : {}) });
    }
    byId.set(id, { id, status: 'success', items, onServer: false, inCloud: true });
  }
  const list = [...byId.values()].sort((a, b) => (a.id < b.id ? 1 : -1)).map((b) => ({ ...b, size: b.items.reduce((n, i) => n + (i.size || 0), 0), at: idToIso(b.id) }));
  return { backups: list, cloudError, root: ROOT };
}

const idToIso = (id) => `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:${id.slice(13, 15)}Z`;

// ---------------- restore ----------------

function checkId(id) {
  if (!ID_RE.test(String(id))) throw new HttpError(400, 'Unknown backup');
  return String(id);
}

// Make sure the files exist on the server, downloading from cloud storage when needed.
async function ensureLocal(serverId, s, id, files, log) {
  const have = await ssh.exec(serverId, `cd ${q(`${ROOT}/${id}`)} 2>/dev/null && ls -1`, { sudo: true });
  const present = new Set(have.stdout.split('\n').filter(Boolean));
  const missing = files.filter((f) => !present.has(f));
  if (!missing.length) return;
  if (s.remote.type === 'none') throw new Error(`These files are no longer on the server: ${missing.join(', ')}`);
  const cloud = (await listRemoteIds(serverId, s.remote)).get(id);
  if (!cloud) throw new Error('This backup is not in cloud storage either.');
  await ssh.exec(serverId, `mkdir -p ${q(`${ROOT}/${id}`)} && chmod 700 ${ROOT} ${q(`${ROOT}/${id}`)}`, { sudo: true, check: true });
  for (const file of missing) {
    const parts = cloud.files.map((f) => f.name).filter((n) => n === file || n.startsWith(`${file}.part`)).sort();
    if (!parts.length) throw new Error(`${file} is missing in cloud storage.`);
    for (const name of parts) {
      const { url, headers } = remote.signedUrl(s.remote, 'GET', `${serverSlug(serverId)}/${id}/${name}`);
      const conf = await ssh.writeSecretTemp(serverId, [`url = "${url}"`, ...headers.map((h) => `header = "${h}"`)].join('\n'));
      const r = await ssh.exec(serverId, `curl -sS --fail --retry 3 --connect-timeout 20 -K ${q(conf)} -o ${q(`${ROOT}/${id}/${name}`)}; rc=$?; rm -f ${q(conf)}; exit $rc`, { sudo: true, timeout: 3 * 60 * 60 * 1000 });
      if (r.code !== 0) throw new Error(`Download of ${name} failed: ${curlError(r)}`);
      log(`  ✔ downloaded ${name}\n`);
    }
    if (parts[0] !== file) await ssh.exec(serverId, `cd ${q(`${ROOT}/${id}`)} && cat ${parts.map(q).join(' ')} > ${q(file)} && rm -f ${parts.map(q).join(' ')}`, { sudo: true, check: true, timeout: 60 * 60 * 1000 });
  }
  // Keep the cloud manifest too, so checksums can be verified.
  if (!present.has('manifest.json')) {
    try {
      const text = await remote.getText(s.remote, `${serverSlug(serverId)}/${id}/manifest.json`);
      JSON.parse(text);
      await ssh.writeFile(serverId, `${ROOT}/${id}/manifest.json`, text, { sudo: true });
    } catch {
      /* optional */
    }
  }
}

/**
 * items: [{ file, target, mode }]
 *   mongo / mysql: target = database name; mode 'replace' (drop it first, after a safety copy) or 'merge'
 *   files:          mode 'replace' (current folder moved to a safety copy) or 'alongside' (new folder)
 *   settings:       unpacked into a folder to copy from (never written over the live config)
 */
function startRestore(serverId, id, items, { user = 'owner' } = {}) {
  checkId(id);
  if (running.has(serverId)) throw new HttpError(409, 'A backup or restore is already running on this server.');
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Choose what to restore');
  const s = settings(serverId);
  const server = store.getServer(serverId);
  const plan = items.map((it) => {
    const kind = itemOf(String(it.file || ''));
    if (!kind) throw new HttpError(400, `Unknown backup file ${it.file}`);
    const target = String(it.target || kind.name);
    if (kind.type !== 'settings' && !SAFE_NAME.test(target)) throw new HttpError(400, `"${target}" is not a valid name`);
    const mode = kind.type === 'files' ? (it.mode === 'replace' ? 'replace' : 'alongside') : it.mode === 'merge' ? 'merge' : 'replace';
    return { ...kind, file: it.file, target, mode };
  });
  const stamp = newId();
  const steps = [
    { label: 'Getting the backup files', fn: (log) => ensureLocal(serverId, s, id, plan.map((p) => p.file), log) },
    {
      label: 'Checking the files are intact',
      fn: async (log) => {
        const m = await readManifest(serverId, id);
        const sums = plan.map((p) => m?.items?.find((i) => i.file === p.file)).filter((i) => i?.sha256);
        if (!sums.length) return log('No checksums recorded for these files; skipping the check.\n');
        const r = await ssh.exec(serverId, `cd ${q(`${ROOT}/${id}`)} && sha256sum -c <<'EOF'\n${sums.map((i) => `${i.sha256}  ${i.file}`).join('\n')}\nEOF`, { sudo: true, timeout: 60 * 60 * 1000 });
        log(r.stdout);
        if (r.code !== 0) throw new Error('A backup file is damaged (checksum mismatch). Try another backup.');
      },
    },
  ];
  let uriFile = null;
  const mongoCfg = async () => {
    if (!uriFile) uriFile = await ssh.writeSecretTemp(serverId, `uri: ${JSON.stringify(toolUri(serverId))}\n`);
    return uriFile;
  };
  for (const p of plan) {
    const src = `${ROOT}/${id}/${p.file}`;
    const safety = `${ROOT}/safety/${stamp}`;
    if (p.type === 'mongo') {
      steps.push({
        label: `MongoDB: ${p.name} → ${p.target}${p.mode === 'replace' ? ' (replace)' : ' (add missing)'}`,
        fn: async (log) => {
          const cfg = await mongoCfg();
          const ns = p.target === p.name ? `--nsInclude=${q(`${p.name}.*`)}` : `--nsInclude=${q(`${p.name}.*`)} --nsFrom=${q(`${p.name}.*`)} --nsTo=${q(`${p.target}.*`)}`;
          const r = await ssh.exec(
            serverId,
            `set -o pipefail; mkdir -p ${q(safety)} && chmod 700 ${ROOT}/safety
${p.mode === 'replace' ? `echo "Safety copy of the current ${p.target} → ${safety}/mongo-${p.target}.archive.gz"; mongodump --config=${q(cfg)} --db=${q(p.target)} --archive=${q(`${safety}/mongo-${p.target}.archive.gz`)} --gzip --quiet || exit 1` : ''}
mongorestore --config=${q(cfg)} --archive=${q(src)} --gzip ${ns} ${p.mode === 'replace' ? '--drop' : ''} 2>&1 | grep -vE '^\\s*$' | tail -15`,
            { sudo: true, onData: log, timeout: 6 * 60 * 60 * 1000 },
          );
          if (r.code !== 0) throw new Error(`Restoring ${p.name} failed`);
        },
      });
    } else if (p.type === 'mysql') {
      const t = p.target; // SAFE_NAME: letters, digits, _ . @ + -
      const bt = (x) => '`' + x + '`';
      steps.push({
        label: `MySQL: ${p.name} → ${t}${p.mode === 'replace' ? ' (replace)' : ' (import into it)'}`,
        sudo: true,
        cmd: [
          'set -o pipefail',
          `mkdir -p ${q(safety)} && chmod 700 ${ROOT}/safety`,
          `if mysql -N -e 'SHOW DATABASES' | grep -qFx ${q(t)}; then`,
          `  echo "Safety copy of the current ${t} → ${safety}/mysql-${t}.sql.gz"`,
          `  mysqldump --single-transaction --routines --triggers --events ${q(t)} | gzip > ${q(`${safety}/mysql-${t}.sql.gz`)} || exit 1`,
          p.mode === 'replace' ? `  mysql -e ${q(`DROP DATABASE ${bt(t)}`)} || exit 1` : '  true',
          'fi',
          `mysql -e ${q(`CREATE DATABASE IF NOT EXISTS ${bt(t)}`)} && zcat ${q(src)} | mysql ${q(t)} && echo "Imported into ${t}"`,
        ].join('\n'),
      });
    } else if (p.type === 'files') {
      const dest = p.mode === 'replace' ? `/var/www/${p.target}` : `/var/www/${p.target}-restored-${stamp}`;
      steps.push({
        label: `Folder: ${p.name} → ${dest}${p.mode === 'replace' ? ' (replace)' : ''}`,
        sudo: true,
        cmd: `set -e -o pipefail; T=$(mktemp -d /var/www/.serverboy-restore-XXXXXX)
tar -xzf ${q(src)} -C "$T"
NEW="$T/${p.name}"; [ -d "$NEW" ] || { echo "The archive does not contain ${p.name}"; rm -rf "$T"; exit 1; }
${
  p.mode === 'replace'
    ? `if [ -e ${q(dest)} ]; then mkdir -p ${q(safety)} && chmod 700 ${ROOT}/safety
  [ -d ${q(`${dest}/node_modules`)} ] && [ ! -e "$NEW/node_modules" ] && mv ${q(`${dest}/node_modules`)} "$NEW/node_modules" && echo "Kept the current node_modules"
  mv ${q(dest)} ${q(`${safety}/files-${p.target}`)} && echo "Current folder moved to ${safety}/files-${p.target}"
fi`
    : ''
}
mv "$NEW" ${q(dest)}; rm -rf "$T"
echo "Restored to ${dest}"
[ -f ${q(`${dest}/package.json`)} ] && [ ! -d ${q(`${dest}/node_modules`)} ] && echo "Note: node_modules is not in backups. Run npm install in ${dest} (Node Apps → Deploy does it)." || true`,
      });
    } else {
      const dest = `${ROOT}/restored-settings-${stamp}`;
      steps.push({
        label: `Server settings → ${dest}`,
        sudo: true,
        cmd: `set -e; mkdir -p ${q(dest)} && chmod 700 ${q(dest)} && tar -xzf ${q(src)} -C ${q(dest)} && echo "Unpacked to ${dest}. Nothing live was changed; copy what you need from there (for example with the Terminal)." && (cd ${q(dest)} && find . -maxdepth 3 | head -40)`,
      });
    }
  }
  steps.push({
    label: 'Cleaning up',
    allowFail: true,
    fn: async () => {
      if (uriFile) await ssh.exec(serverId, `rm -f ${q(uriFile)}`);
    },
  });
  const job = jobs.create(serverId, `Restore from backup ${id}`, steps, {
    onDone: async () => {
      running.delete(serverId);
      if (uriFile) await ssh.exec(serverId, `rm -f ${q(uriFile)}`).catch(() => {});
    },
  });
  running.set(serverId, job.id);
  require('./team').audit({ user, action: `Started a restore on ${server.name} from backup ${id}: ${plan.map((p) => `${p.type} ${p.name}${p.target !== p.name ? ` → ${p.target}` : ''} (${p.mode})`).join(', ')}` });
  return job;
}


// ---------------- test-restore (drill) ----------------

// Restore the newest backup into throw-away databases / a temp folder, check that the data can be
// read, then delete everything again. Uses the cloud copy when there is one (that is the copy you
// would need if the server were lost), otherwise the copy on the server. Nothing live is touched.
function startDrill(serverId, { backupId = null, reason = 'manual', user = 'serverboy' } = {}) {
  if (running.has(serverId)) throw new HttpError(409, 'A backup or restore is already running on this server.');
  const s = settings(serverId);
  const server = store.getServer(serverId);
  const tag = `sbtest_${crypto.randomBytes(3).toString('hex')}`;
  const work = `${ROOT}/.drill-${tag}`;
  const ctx = { id: backupId, source: null, results: [], started: Date.now() };
  let uriFile = null;
  let yamlFile = null;
  const steps = [
    {
      label: 'Choosing the backup to test',
      fn: async (log) => {
        const { backups } = await listAll(serverId);
        const good = backups.filter((b) => b.status !== 'failed' && b.items.some((i) => i.file));
        const b = backupId ? good.find((x) => x.id === backupId) : good[0];
        if (!b) throw new Error(backupId ? `Backup ${backupId} was not found` : 'There is no backup to test yet.');
        ctx.id = b.id;
        ctx.backup = b;
        ctx.source = b.inCloud ? 'cloud' : 'server';
        ctx.items = b.items.filter((i) => i.file);
        const size = ctx.items.reduce((n, i) => n + (i.size || 0), 0);
        const free = Number((await ssh.exec(serverId, `mkdir -p ${ROOT} && df -B1 --output=avail ${ROOT} | tail -1`, { sudo: true })).stdout.trim()) || 0;
        log(`Backup ${b.id} (${when(b.id)}), ${ctx.items.length} item(s), ${fmtSize(size)}, from the ${ctx.source === 'cloud' ? `cloud copy (${remote.describe(s.remote)})` : 'copy on the server'}.\n`);
        // Restored databases take several times the compressed size.
        if (free < size * 6 + 500 * 1024 ** 2) throw new Error(`Not enough free disk space to test-restore (${fmtSize(free)} free, about ${fmtSize(size * 6)} needed).`);
      },
    },
    {
      label: 'Getting the files and checking them',
      fn: async (log) => {
        let dir = `${ROOT}/${ctx.id}`;
        if (ctx.source === 'cloud') {
          dir = work;
          await ssh.exec(serverId, `mkdir -p ${q(work)} && chmod 700 ${q(work)}`, { sudo: true, check: true });
          const cloud = (await listRemoteIds(serverId, s.remote)).get(ctx.id);
          for (const f of cloud.files.map((x) => x.name).sort()) {
            const { url, headers } = remote.signedUrl(s.remote, 'GET', `${serverSlug(serverId)}/${ctx.id}/${f}`);
            const conf = await ssh.writeSecretTemp(serverId, [`url = "${url}"`, ...headers.map((h) => `header = "${h}"`)].join('\n'));
            const r = await ssh.exec(serverId, `curl -sS --fail --retry 3 --connect-timeout 20 -K ${q(conf)} -o ${q(`${work}/${f}`)}; rc=$?; rm -f ${q(conf)}; exit $rc`, { sudo: true, timeout: 3 * 60 * 60 * 1000 });
            if (r.code !== 0) throw new Error(`Could not download ${f} from cloud storage: ${curlError(r)}`);
          }
          // Join files that were uploaded in parts.
          await ssh.exec(serverId, `cd ${q(work)} && for p in *.part000; do [ -e "$p" ] || continue; b=\${p%.part000}; cat "$b".part* > "$b" && rm -f "$b".part*; done`, { sudo: true, check: true, timeout: 60 * 60 * 1000 });
          log(`Downloaded ${cloud.files.length} file(s) from cloud storage.\n`);
        }
        ctx.dir = dir;
        const m = await ssh.exec(serverId, `cat ${q(`${dir}/manifest.json`)} 2>/dev/null`, { sudo: true });
        let manifest = null;
        try {
          manifest = JSON.parse(m.stdout);
        } catch {
          /* none */
        }
        const sums = (manifest?.items || []).filter((i) => i.file && i.sha256);
        if (!sums.length) return log('No checksums recorded; skipping the checksum check.\n');
        const r = await ssh.exec(serverId, `cd ${q(dir)} && sha256sum -c --quiet <<'EOF'\n${sums.map((i) => `${i.sha256}  ${i.file}`).join('\n')}\nEOF`, { sudo: true, timeout: 60 * 60 * 1000 });
        if (r.code !== 0) throw new Error(`Checksum mismatch: a backup file is damaged.\n${(r.stdout + r.stderr).trim().slice(-400)}`);
        log(`All ${sums.length} checksums match.\n`);
      },
    },
    {
      label: 'Restoring into temporary databases and folders',
      fn: async (log) => {
        const hasMongo = ctx.items.some((i) => i.type === 'mongo');
        if (hasMongo) {
          uriFile = await ssh.writeSecretTemp(serverId, store.getServer(serverId).mongoUri || DEFAULT_MONGO_URI);
          yamlFile = await ssh.writeSecretTemp(serverId, `uri: ${JSON.stringify(toolUri(serverId))}\n`);
        }
        const tmpName = (n) => `${tag}_${n}`.slice(0, 60);
        const L = [`set -u -o pipefail
umask 077
exec 9>${ROOT}/.lock; flock -n 9 || { echo "Another backup or restore is running."; exit 75; }
D=${q(ctx.dir)}; TMP=$(mktemp -d ${ROOT}/.drill-files-XXXXXX)
MONGO_TMP=(); MYSQL_TMP=()
cleanup() {
  ${hasMongo ? `for t in "\${MONGO_TMP[@]}"; do mongosh "$(cat ${q(uriFile)})" --quiet --norc --eval "db.getSiblingDB('$t').dropDatabase()" >/dev/null 2>&1; done` : 'true'}
  for t in "\${MYSQL_TMP[@]}"; do mysql -e "DROP DATABASE IF EXISTS \\\`$t\\\`" 2>/dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT
res() { printf '__SB_DRILL__{"file":"%s","type":"%s","ok":%s,"detail":"%s"}\\n' "$1" "$2" "$3" "$4"; }`];
        for (const it of ctx.items) {
          const f = `"$D"/${q(it.file)}`;
          if (it.type === 'mongo') {
            const t = tmpName(it.name);
            L.push(`echo "• MongoDB ${it.name} → temporary database ${t}"; MONGO_TMP+=(${q(t)})
OUT=$(mongorestore --config=${q(yamlFile)} --archive=${f} --gzip --nsInclude=${q(`${it.name}.*`)} --nsFrom=${q(`${it.name}.*`)} --nsTo=${q(`${t}.*`)} 2>&1); rc=$?
OKN=$(echo "$OUT" | grep -oE '[0-9]+ document\\(s\\) restored successfully' | grep -oE '^[0-9]+' | tail -1); BADN=$(echo "$OUT" | grep -oE '[0-9]+ document\\(s\\) failed' | grep -oE '^[0-9]+' | tail -1)
CHK=$(mongosh "$(cat ${q(uriFile)})" --quiet --norc --eval "const d=db.getSiblingDB('${t}'); let n=0; const c=d.getCollectionNames(); c.forEach(x=>{n+=d.getCollection(x).countDocuments()}); print(c.length+' collection(s), '+n+' document(s)')" 2>&1 | tail -1)
if [ $rc -eq 0 ] && [ "\${BADN:-0}" = "0" ]; then echo "  ✔ $CHK readable"; res ${q(it.file)} mongo true "$CHK"; else echo "$OUT" | tail -5; res ${q(it.file)} mongo false "mongorestore failed ($((\${BADN:-0})) documents failed)"; fi
mongosh "$(cat ${q(uriFile)})" --quiet --norc --eval "db.getSiblingDB('${t}').dropDatabase()" >/dev/null 2>&1`);
          } else if (it.type === 'mysql') {
            const t = tmpName(it.name);
            L.push(`echo "• MySQL ${it.name} → temporary database ${t}"; MYSQL_TMP+=(${q(t)})
if mysql -e ${q(`CREATE DATABASE \`${t}\``)} && zcat ${f} | mysql ${q(t)}; then
  CHK=$(mysql -N -e "SELECT CONCAT(COUNT(*), ' table(s), about ', COALESCE(SUM(table_rows),0), ' row(s)') FROM information_schema.tables WHERE table_schema='${t}'")
  echo "  ✔ $CHK readable"; res ${q(it.file)} mysql true "$CHK"
else res ${q(it.file)} mysql false "import failed"; fi
mysql -e ${q(`DROP DATABASE IF EXISTS \`${t}\``)}`);
          } else {
            L.push(`echo "• ${it.type === 'settings' ? 'Server settings' : `Folder ${it.name}`} → temporary folder"
if tar -xzf ${f} -C "$TMP"; then N=$(find "$TMP" -mindepth 1 | wc -l); echo "  ✔ $N files and folders unpacked"; res ${q(it.file)} ${it.type} true "$N files and folders"; else res ${q(it.file)} ${it.type} false "the archive could not be unpacked"; fi
rm -rf "$TMP"/* "$TMP"/.[!.]* 2>/dev/null; true`);
          }
        }
        L.push('exit 0');
        const script = await ssh.writeSecretTemp(serverId, L.join('\n'));
        const r = await ssh.exec(serverId, `bash ${q(script)}; rc=$?; rm -f ${q(script)}; exit $rc`, { sudo: true, timeout: 6 * 60 * 60 * 1000, onData: (t) => log(t.replace(/^__SB_DRILL__.*\n?/gm, '')) });
        if (r.code === 75) throw new Error('Another backup or restore is running on this server.');
        for (const line of r.stdout.split('\n')) {
          if (!line.startsWith('__SB_DRILL__')) continue;
          try {
            ctx.results.push(JSON.parse(line.slice(12)));
          } catch {
            /* ignore */
          }
        }
        const bad = ctx.results.filter((x) => !x.ok);
        if (ctx.results.length < ctx.items.length) throw new Error('The test did not finish for every item.');
        if (bad.length) throw new Error(`${bad.length} of ${ctx.results.length} item(s) could not be restored: ${bad.map((x) => x.file).join(', ')}`);
      },
    },
  ];
  const cleanup = async () => {
    await ssh.exec(serverId, `rm -rf ${q(work)}; rm -f ${uriFile ? q(uriFile) : ''} ${yamlFile ? q(yamlFile) : ''}`, { sudo: true }).catch(() => {});
  };
  const job = jobs.create(serverId, `Test-restore of ${server.name}${reason === 'scheduled' ? ' (scheduled)' : ''}`, steps, {
    onDone: async (status, error) => {
      await cleanup();
      running.delete(serverId);
      const ok = status === 'success';
      const lastDrill = { at: new Date().toISOString(), status: ok ? 'success' : 'failed', backupId: ctx.id, source: ctx.source, items: ctx.results, error: ok ? null : error, seconds: Math.round((Date.now() - ctx.started) / 1000), job: job.id, reason };
      store.setBackupState(serverId, { lastDrill });
      if (!ok && reason === 'scheduled') notifyOwner(`Test-restore failed on ${server.name}`, `Serverboy tried to restore the latest backup of ${server.name} into temporary databases and it did not work.\n\n${error || ''}\n\nYour live data was not touched. Open ${server.name} → Backups to see the log, and make a new backup.`);
    },
  });
  running.set(serverId, job.id);
  require('./team').audit({ user, action: `Started a test-restore on ${server.name}` });
  return job;
}

const when = (id) => idToIso(id).slice(0, 16).replace('T', ' ') + ' UTC';

// ---------------- delete / download / test ----------------

async function deleteBackup(serverId, id, where = 'both') {
  checkId(id);
  const s = settings(serverId);
  if (where !== 'cloud') await ssh.exec(serverId, `rm -rf ${q(`${ROOT}/${id}`)}`, { sudo: true, check: true });
  if (where !== 'server' && s.remote.type !== 'none') {
    const c = (await listRemoteIds(serverId, s.remote)).get(id);
    for (const f of c?.files || []) await remote.remove(s.remote, `${serverSlug(serverId)}/${id}/${f.name}`);
  }
}

async function downloadSource(serverId, id, file) {
  checkId(id);
  if (!itemOf(file) && file !== 'manifest.json') throw new HttpError(400, 'Unknown file');
  const path = `${ROOT}/${id}/${file}`;
  const r = await ssh.exec(serverId, `[ -f ${q(path)} ] && stat -c %s ${q(path)}`, { sudo: true });
  if (r.code === 0) return { local: path, size: Number(r.stdout.trim()) };
  const s = settings(serverId);
  if (s.remote.type === 'none') throw new HttpError(404, 'This file is no longer on the server');
  const c = (await listRemoteIds(serverId, s.remote)).get(id);
  if (!c?.files.some((f) => f.name === file)) throw new HttpError(404, c?.files.some((f) => f.name.startsWith(`${file}.part`)) ? 'This file is stored in parts in the cloud; use Restore, which joins them.' : 'File not found');
  return { url: remote.signedUrl(s.remote, 'GET', `${serverSlug(serverId)}/${id}/${file}`, 900).url };
}

// Check the storage from Serverboy (list, write, delete) and from the server (upload with curl).
async function testRemote(serverId, cfgIn) {
  const current = settings(serverId);
  let cfg = cfgIn || current.remote;
  if (cfg.type === 's3' && !cfg.secretAccessKey && current.remote.type === 's3') cfg = { ...cfg, secretAccessKey: current.remote.secretAccessKey };
  if (cfg.type === 'azure' && !cfg.sasUrl && current.remote.type === 'azure') cfg = { ...cfg, sasUrl: current.remote.sasUrl };
  if (!remote.validate(cfg)) throw new HttpError(400, 'Choose a storage service first');
  const rel = `${serverSlug(serverId)}/.serverboy-test-${crypto.randomBytes(4).toString('hex')}`;
  await remote.putText(cfg, rel, 'serverboy storage test');
  const seen = (await remote.list(cfg, `${serverSlug(serverId)}/.serverboy-test`)).some((o) => o.rel === rel);
  await remote.remove(cfg, rel);
  if (!seen) throw new HttpError(502, 'A test file was written but could not be listed. Check that the key may list the bucket / container.');
  // The server uploads by itself, so it must reach the storage too.
  const { url, headers } = remote.signedUrl(cfg, 'PUT', `${rel}-server`, 300);
  const conf = await ssh.writeSecretTemp(serverId, [`url = "${url}"`, ...headers.map((h) => `header = "${h}"`)].join('\n'));
  const r = await ssh.exec(serverId, `echo test | curl -sS --fail-with-body --connect-timeout 15 -T - -K ${q(conf)} -o /dev/null; rc=$?; rm -f ${q(conf)}; exit $rc`);
  await remote.remove(cfg, `${rel}-server`).catch(() => {});
  if (r.code !== 0) throw new HttpError(502, `Serverboy can reach the storage, but the server cannot upload to it: ${curlError(r)}. Check the server's outbound internet / firewall.`);
  return { ok: true, label: remote.describe(cfg) };
}

// For the dashboard health check (no SSH).
function healthProblems(serverId) {
  const c = store.getBackupConfig(serverId);
  if (!c) return [{ level: 'warn', area: 'backup', text: 'No backups are set up. If the server or a database is lost, the data is gone.', hint: 'Turn on daily backups.' }];
  const s = settings(serverId);
  const out = [];
  const last = s.state.last;
  if (last?.status === 'failed') out.push({ level: 'bad', area: 'backup', text: `The last backup failed: ${last.error || 'see Backups'}` });
  else if (last?.status === 'partial') out.push({ level: 'warn', area: 'backup', text: `The last backup is incomplete: ${last.error || 'see Backups'}` });
  if (!s.enabled) out.push({ level: 'warn', area: 'backup', text: 'Automatic backups are turned off.' });
  else if (s.state.lastSuccessAt && Date.now() - Date.parse(s.state.lastSuccessAt) > (PERIOD_H[s.schedule.every] * 2 + 2) * 3600e3) {
    out.push({ level: 'warn', area: 'backup', text: `No successful backup since ${new Date(s.state.lastSuccessAt).toUTCString().slice(5, 22)} UTC.` });
  }
  const ld = s.state.lastDrill;
  if (ld?.status === 'failed') out.push({ level: 'bad', area: 'backup', text: `The last test-restore failed: the backup from ${ld.backupId ? idToIso(ld.backupId).slice(0, 16).replace('T', ' ') : '?'} could not be restored. ${ld.error || ''}`.trim() });
  else if (s.enabled && s.drill !== 'off' && s.state.lastSuccessAt && (!ld || Date.now() - Date.parse(ld.at) > (DRILL_DAYS[s.drill] * 2 + 1) * 24 * 3600e3)) {
    out.push({ level: 'warn', area: 'backup', text: ld ? `No test-restore since ${new Date(ld.at).toUTCString().slice(5, 16)}. Untested backups may not work when you need them.` : 'Your backups have never been test-restored.', hint: 'Backups → Test a restore.' });
  }
  if (s.enabled && s.remote.type === 'none' && !s.localOnlyOk) out.push({ level: 'warn', area: 'backup', dismiss: 'local-only', text: 'Backups are only kept on this server. If the server is lost, so are they.', hint: 'Add cloud storage in Backups → Settings, or keep them here and hide this warning.' });
  return out;
}

module.exports = {
  ROOT,
  settings,
  publicSettings,
  saveSettings,
  inventory,
  startBackup,
  startRestore,
  startDrill,
  setLocalOnlyOk,
  notifyOwner,
  listAll,
  deleteBackup,
  downloadSource,
  testRemote,
  healthProblems,
  startScheduler,
  nextRun,
  isSlot,
  toolUri,
  isRunning: (serverId) => running.has(serverId),
};
