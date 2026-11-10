// Two-step login: an authenticator-app code (lib/totp.js) after the password, or an approval on
// a phone where you are already logged in (lib/push.js), with 10 one-time recovery codes.
// Per person (owner or team member), kept in data/twofactor.json (mode 600):
//   users[userId] = { secret (encrypted), enabledAt, recovery: [sha256…], lastStep }
//   pending[userId] = { secret (encrypted), at }  while setting up (not yet confirmed)
//   settings.required = true → everyone must set it up at their next login.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const totp = require('./totp');

const FILE = path.join(store.DATA_DIR, 'twofactor.json');
const PENDING_MS = 15 * 60e3;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

let data = { users: {}, pending: {}, settings: { required: false } };
try {
  data = { ...data, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch {
  /* first start */
}
function save() {
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

const enabled = (userId) => Boolean(data.users[String(userId)]);

function status(userId) {
  const u = data.users[String(userId)];
  return { enabled: Boolean(u), enabledAt: u?.enabledAt || null, recoveryLeft: u ? u.recovery.length : 0, required: Boolean(data.settings.required) };
}

// Step 1 of setting up: a new secret, shown as a QR code until it is confirmed with a code.
function begin(userId, account) {
  const secret = totp.newSecret();
  data.pending[String(userId)] = { secret: store.encrypt(secret), at: Date.now() };
  save();
  return { secret, uri: totp.uri({ secret, account }) };
}

function newRecovery() {
  // 10 codes like 7f3k-92ma-x1qd, shown once; stored only as hashes.
  const codes = Array.from({ length: 10 }, () => crypto.randomBytes(8).toString('base64url').replace(/[-_]/g, '').slice(0, 12).toLowerCase().replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3'));
  return { codes, hashes: codes.map((c) => sha(c.replace(/-/g, ''))) };
}

// Step 2: the first code from the app proves it is set up; returns the recovery codes.
function confirm(userId, code) {
  const p = data.pending[String(userId)];
  if (!p || Date.now() - p.at > PENDING_MS) return null;
  const secret = store.decrypt(p.secret);
  const step = totp.check(secret, code);
  if (step === null) return null;
  const { codes, hashes } = newRecovery();
  data.users[String(userId)] = { secret: p.secret, enabledAt: new Date().toISOString(), recovery: hashes, lastStep: step };
  delete data.pending[String(userId)];
  save();
  return codes;
}

// A code from the app (each code works once) or a recovery code (used up). Returns how, or null.
function verify(userId, code) {
  const u = data.users[String(userId)];
  if (!u) return null;
  const c = String(code || '').trim().toLowerCase();
  if (/^\d{6}$/.test(c.replace(/\s/g, ''))) {
    const step = totp.check(store.decrypt(u.secret), c);
    if (step === null || step <= (u.lastStep || 0)) return null;
    u.lastStep = step;
    save();
    return 'code';
  }
  const h = sha(c.replace(/[\s-]/g, ''));
  const i = u.recovery.indexOf(h);
  if (i < 0) return null;
  u.recovery.splice(i, 1);
  save();
  return 'recovery';
}

function regenerateRecovery(userId) {
  const u = data.users[String(userId)];
  if (!u) return null;
  const { codes, hashes } = newRecovery();
  u.recovery = hashes;
  save();
  return codes;
}

function disable(userId) {
  delete data.users[String(userId)];
  delete data.pending[String(userId)];
  save();
}

const required = () => Boolean(data.settings.required);
function setRequired(on) {
  data.settings.required = Boolean(on);
  save();
}

function reload() {
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    /* none in the backup */
  }
}

module.exports = {
  reload, enabled, status, begin, confirm, verify, regenerateRecovery, disable, required, setRequired, _data: () => data };
