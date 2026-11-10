// Push notifications to phones and computers (Web Push), straight from this Serverboy: no
// account at Apple, Google or any other service is needed.
//   - VAPID (RFC 8292): Serverboy has its own key pair (made once, data/push.json, private key
//     encrypted); each push carries a short signed token, so push services know who sends it.
//   - Encryption (RFC 8291, aes128gcm): every message is encrypted for the receiving browser;
//     the push service in between cannot read it.
// Devices subscribe from Serverboy (My account → This device); each belongs to one person.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const FILE = path.join(store.DATA_DIR, 'push.json');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const KINDS = ['alerts', 'messages'];

let data = { vapid: null, subs: [], prefs: {} };
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

// ---------- VAPID keys ----------

function keys() {
  if (!data.vapid) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    data.vapid = { publicKey: b64u(publicKey.export({ type: 'spki', format: 'der' }).subarray(-65)), privateKey: store.encrypt(jwk) };
    save();
  }
  return data.vapid;
}
const publicKey = () => keys().publicKey;
let signingKey = null;
const privateKey = () => (signingKey ||= crypto.createPrivateKey({ key: store.decrypt(keys().privateKey), format: 'jwk' }));

function vapidHeader(endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: privateKey(), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${publicKey()}`;
}

// ---------- encryption (RFC 8291) ----------

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// test: { salt, asPrivate } fixes the random parts (to check against the RFC's example).
function encrypt(plaintext, p256dh, auth, test = {}) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (test.asPrivate) ecdh.setPrivateKey(unb64u(test.asPrivate));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const salt = test.salt ? unb64u(test.salt) : crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // One record: the message, then the 0x02 delimiter that marks the last record.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// ---------- devices ----------

function subscribe(userId, { endpoint, keys: k }, ua = '') {
  const url = new URL(String(endpoint || ''));
  // Tests only: a local plain-http stand-in for a push service.
  const testHttp = process.env.SERVERBOY_TEST_PUSH_HTTP === '1' && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !testHttp) throw new Error('Push endpoints use https');
  if (!k?.p256dh || !k?.auth || unb64u(k.p256dh).length !== 65 || unb64u(k.auth).length !== 16) throw new Error('Invalid push keys');
  data.subs = data.subs.filter((s) => s.endpoint !== url.href);
  const sub = { id: crypto.randomBytes(6).toString('hex'), userId: String(userId), endpoint: url.href, p256dh: k.p256dh, auth: k.auth, device: describe(ua), createdAt: new Date().toISOString(), lastOk: null };
  data.subs.push(sub);
  save();
  return publicSub(sub);
}

function describe(ua) {
  const u = String(ua);
  const os = /iPhone|iPad/.test(u) ? 'iPhone / iPad' : /Android/.test(u) ? 'Android' : /Mac OS X/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : /Linux/.test(u) ? 'Linux' : 'Device';
  const br = /Edg\//.test(u) ? 'Edge' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : 'browser';
  return `${br} on ${os}`;
}

const publicSub = ({ p256dh, auth, endpoint, ...s }) => ({ ...s, service: new URL(endpoint).host });
const devices = (userId) => data.subs.filter((s) => s.userId === String(userId)).map(publicSub);
function unsubscribe(userId, idOrEndpoint) {
  const before = data.subs.length;
  data.subs = data.subs.filter((s) => !(s.userId === String(userId) && (s.id === idOrEndpoint || s.endpoint === idOrEndpoint)));
  save();
  return data.subs.length < before;
}
function removeUser(userId) {
  data.subs = data.subs.filter((s) => s.userId !== String(userId));
  delete data.prefs[String(userId)];
  save();
}

const prefs = (userId) => ({ alerts: true, messages: true, ...(data.prefs[String(userId)] || {}) });
function setPrefs(userId, p) {
  data.prefs[String(userId)] = Object.fromEntries(KINDS.map((k) => [k, p[k] !== false]));
  save();
  return prefs(userId);
}

// ---------- sending ----------

function subject() {
  const email = store.getOwnerEmail();
  return email ? `mailto:${email}` : 'https://github.com/gaurav-swarnkar/serverboy';
}

async function sendTo(sub, message, { ttl = 86400, urgency = 'normal' } = {}) {
  const body = encrypt(JSON.stringify(message), sub.p256dh, sub.auth);
  const ctrl = AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined;
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { TTL: String(ttl), Urgency: urgency, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidHeader(sub.endpoint, subject()) },
    body,
    signal: ctrl,
  });
  if (r.status === 404 || r.status === 410) {
    // The browser unsubscribed or the app was removed: forget the device.
    data.subs = data.subs.filter((s) => s.endpoint !== sub.endpoint);
    save();
    return { ok: false, gone: true, status: r.status };
  }
  if (!r.ok) return { ok: false, status: r.status, error: (await r.text().catch(() => '')).slice(0, 200) };
  sub.lastOk = new Date().toISOString();
  save();
  return { ok: true, status: r.status };
}

// Send to every device of one person. kind: alerts | messages | logins (each can be switched off).
// message: { title, body, url, tag }. Never throws: push is best effort.
// kind null = always sent (login approvals, tests).
async function notifyUser(userId, message, { kind = 'alerts', urgency, ttl } = {}) {
  if (kind && prefs(userId)[kind] === false) return [];
  const subs = data.subs.filter((s) => s.userId === String(userId));
  return Promise.all(subs.map((s) => sendTo(s, { kind, ...message }, { urgency: urgency || 'normal', ttl: ttl || 86400 }).catch((err) => ({ ok: false, error: err.message }))));
}

const hasDevices = (userId) => data.subs.some((s) => s.userId === String(userId));

function reload() {
  signingKey = null;
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    /* none in the backup */
  }
}

module.exports = {
  reload, KINDS, publicKey, encrypt, subscribe, unsubscribe, devices, removeUser, prefs, setPrefs, notifyUser, hasDevices, describe, _data: () => data };
