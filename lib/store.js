// Persistent storage for portal config and saved servers.
// Server secrets (passwords, private keys, DB URIs) are encrypted at rest with AES-256-GCM.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const config = readJson(CONFIG_FILE, {});
if (!config.secret) {
  config.secret = crypto.randomBytes(32).toString('hex');
  writeJson(CONFIG_FILE, config);
}

const key = crypto.scryptSync(process.env.SERVERBOY_SECRET || config.secret, 'serverboy-store', 32);

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  const data = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
  return JSON.parse(data.toString('utf8'));
}

// ---- Portal admin password ----

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyHash(password, stored) {
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// ADMIN_PASSWORD is the *initial* password: it is applied once, and again only when its value
// changes (so editing the env file works as a reset). Otherwise Settings can change it freely.
function initAdminPassword() {
  const envPassword = process.env.ADMIN_PASSWORD;
  if (envPassword) {
    if (!config.envPasswordSeed || !verifyHash(envPassword, config.envPasswordSeed)) {
      config.passwordHash = hashPassword(envPassword);
      config.envPasswordSeed = hashPassword(envPassword);
      writeJson(CONFIG_FILE, config);
    }
    return;
  }
  if (config.passwordHash) return;
  const generated = crypto.randomBytes(9).toString('base64url');
  config.passwordHash = hashPassword(generated);
  writeJson(CONFIG_FILE, config);
  console.log('\n==============================================================');
  console.log(' First run: a portal admin password was generated for you.');
  console.log(`   Password: ${generated}`);
  console.log(' Change it under Settings after logging in.');
  console.log('==============================================================\n');
}

function verifyAdminPassword(password) {
  if (typeof password !== 'string' || !password) return false;
  return Boolean(config.passwordHash) && verifyHash(password, config.passwordHash);
}

function setAdminPassword(password) {
  config.passwordHash = hashPassword(password);
  writeJson(CONFIG_FILE, config);
}

// ---- Servers ----

const SECRET_FIELDS = ['password', 'privateKey', 'passphrase', 'mongoUri'];

let servers = readJson(SERVERS_FILE, []);

function saveServers() {
  writeJson(SERVERS_FILE, servers);
}

function publicView(record) {
  const secrets = decrypt(record.enc);
  return {
    id: record.id,
    name: record.name,
    host: record.host,
    port: record.port,
    username: record.username,
    authType: secrets.privateKey ? 'key' : 'password',
    hasMongoUri: Boolean(secrets.mongoUri),
    hostFingerprint: record.hostFingerprint || null,
    createdAt: record.createdAt,
  };
}

function listServers() {
  return servers.map(publicView);
}

function getServer(id) {
  const record = servers.find((s) => s.id === id);
  if (!record) return null;
  return { ...record, ...decrypt(record.enc), enc: undefined };
}

function normalize(input, existing = {}) {
  const out = {
    name: String(input.name ?? existing.name ?? '').trim(),
    host: String(input.host ?? existing.host ?? '').trim(),
    port: Number(input.port ?? existing.port ?? 22),
    username: String(input.username ?? existing.username ?? '').trim(),
  };
  if (!out.host) throw Object.assign(new Error('Host / IP is required'), { status: 400 });
  if (!out.username) throw Object.assign(new Error('Username is required'), { status: 400 });
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) {
    throw Object.assign(new Error('Port must be between 1 and 65535'), { status: 400 });
  }
  if (!out.name) out.name = out.host;
  return out;
}

function addServer(input) {
  const base = normalize(input);
  const secrets = {};
  for (const f of SECRET_FIELDS) if (input[f]) secrets[f] = String(input[f]);
  if (!secrets.password && !secrets.privateKey) {
    throw Object.assign(new Error('Provide a password or a private key'), { status: 400 });
  }
  const record = {
    id: crypto.randomUUID(),
    ...base,
    enc: encrypt(secrets),
    hostFingerprint: null,
    createdAt: new Date().toISOString(),
  };
  servers.push(record);
  saveServers();
  return publicView(record);
}

function updateServer(id, input) {
  const record = servers.find((s) => s.id === id);
  if (!record) return null;
  const base = normalize(input, record);
  const secrets = decrypt(record.enc);
  for (const f of SECRET_FIELDS) {
    // Empty string clears a field; undefined keeps the current value.
    if (input[f] === '') delete secrets[f];
    else if (input[f] !== undefined && input[f] !== null) secrets[f] = String(input[f]);
  }
  if (!secrets.password && !secrets.privateKey) {
    throw Object.assign(new Error('Provide a password or a private key'), { status: 400 });
  }
  const hostChanged = base.host !== record.host || base.port !== record.port;
  Object.assign(record, base, { enc: encrypt(secrets) });
  if (hostChanged || input.resetFingerprint) record.hostFingerprint = null;
  saveServers();
  return publicView(record);
}

function setFingerprint(id, fingerprint) {
  const record = servers.find((s) => s.id === id);
  if (!record) return;
  record.hostFingerprint = fingerprint;
  saveServers();
}

function removeServer(id) {
  const before = servers.length;
  servers = servers.filter((s) => s.id !== id);
  saveServers();
  return servers.length !== before;
}

module.exports = {
  DATA_DIR,
  initAdminPassword,
  verifyAdminPassword,
  setAdminPassword,
  listServers,
  getServer,
  addServer,
  updateServer,
  setFingerprint,
  removeServer,
};
