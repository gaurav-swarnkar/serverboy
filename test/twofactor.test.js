// Two-step login against a real Serverboy: set up with an authenticator code, log in with a code
// or a recovery code, and approve a login on a "phone" whose push service is a local stand-in
// that decrypts the real Web Push message (RFC 8291) with the phone's own key.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { tempDir, freePort, startProcess } = require('./helpers');
const totp = require('../lib/totp');

const PASSWORD = 'test-owner-password';
let app;
let base;
let phone = ''; // the session cookie of the already logged-in phone
let secret;
let recovery;

test.before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = await startProcess(['server.js'], { port, env: { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tempDir('sb-2fa-'), ADMIN_PASSWORD: PASSWORD, SERVERBOY_MONGO_URI: '', SERVERBOY_TEST_PUSH_HTTP: '1', TRUST_PROXY: '1' } });
});
test.after(() => app?.stop());

const call = (path, { method = 'GET', body, cookie = '', ip = '' } = {}) =>
  fetch(base + path, { method, redirect: 'manual', headers: { 'x-serverboy': '1', ...(ip ? { 'x-forwarded-for': ip } : {}), ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
const password = () => call('/api/login', { method: 'POST', body: { username: 'admin', password: PASSWORD } });
// A code for a step the server has not seen yet (each code works once).
let lastStep = 0;
function freshCode() {
  const now = totp.stepOf();
  const step = Math.max(now, lastStep + 1);
  if (step > now + 1) throw new Error('out of fresh codes');
  lastStep = step;
  return totp.codeAt(secret, step);
}

test('turn on two-step login with a code from the app', async () => {
  phone = cookieOf(await password());
  assert.ok(phone);
  const s = await (await call('/api/2fa/setup', { method: 'POST', cookie: phone })).json();
  assert.match(s.uri, /^otpauth:\/\/totp\//);
  secret = s.secret;
  assert.equal((await call('/api/2fa/confirm', { method: 'POST', body: { code: '000000' }, cookie: phone })).status, 400);
  lastStep = totp.stepOf() - 2;
  const r = await (await call('/api/2fa/confirm', { method: 'POST', body: { code: freshCode() }, cookie: phone })).json();
  assert.equal(r.recoveryCodes.length, 10);
  recovery = r.recoveryCodes;
  const st = await (await call('/api/2fa/status', { cookie: phone })).json();
  assert.equal(st.enabled, true);
});

test('the password alone no longer logs in; a code or a recovery code does', async () => {
  const first = await password();
  assert.equal(cookieOf(first), '', 'no session after the password alone');
  const { ticket, twoFactor } = await first.json();
  assert.equal(twoFactor, true);
  assert.equal((await call('/api/login/2fa', { method: 'POST', body: { ticket, code: '123456' } })).status, 400);
  // The code just used to confirm cannot be used again.
  assert.equal((await call('/api/login/2fa', { method: 'POST', body: { ticket, code: totp.codeAt(secret, lastStep) } })).status, 400);
  const ok = await call('/api/login/2fa', { method: 'POST', body: { ticket, code: freshCode() } });
  assert.equal(ok.status, 200);
  assert.ok(cookieOf(ok));

  const { ticket: t2 } = await (await password()).json();
  const rec = await call('/api/login/2fa', { method: 'POST', body: { ticket: t2, code: recovery[0].toUpperCase() } });
  assert.equal(rec.status, 200, 'recovery codes work, any case');
  const { ticket: t3 } = await (await password()).json();
  assert.equal((await call('/api/login/2fa', { method: 'POST', body: { ticket: t3, code: recovery[0] } })).status, 400, 'each recovery code works once');
  assert.equal((await (await call('/api/2fa/status', { cookie: phone })).json()).recoveryLeft, 9);
});

test('wrong codes lock the address like wrong passwords, and a right password does not reset that', async () => {
  const ip = '10.9.9.9';
  const login = async () => (await call('/api/login', { method: 'POST', ip, body: { username: 'admin', password: PASSWORD } })).json();
  let { ticket } = await login();
  for (let i = 0; i < 3; i++) assert.equal((await call('/api/login/2fa', { method: 'POST', ip, body: { ticket, code: '000000' } })).status, 400);
  // A new login attempt with the right password keeps the count.
  ({ ticket } = await login());
  assert.equal((await call('/api/login/2fa', { method: 'POST', ip, body: { ticket, code: '000000' } })).status, 400);
  assert.equal((await call('/api/login/2fa', { method: 'POST', ip, body: { ticket, code: '000000' } })).status, 400);
  // Fifth wrong code: this address is locked, also for the password step.
  assert.equal((await call('/api/login/2fa', { method: 'POST', ip, body: { ticket, code: '000000' } })).status, 429);
  assert.equal((await call('/api/login', { method: 'POST', ip, body: { username: 'admin', password: PASSWORD } })).status, 429);
});

// The phone's push service: stores what Serverboy sends, decrypted with the phone's key.
function decrypt(body, uaEcdh, authSecret) {
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = uaEcdh.computeSecret(asPublic);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
}

test('approve a login on a phone: push, number matching, then the session', async () => {
  const received = [];
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const svc = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, msg: decrypt(Buffer.concat(chunks), ua, auth) });
      res.writeHead(201).end();
    });
  });
  await new Promise((r) => svc.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${svc.address().port}/push/phone1`;
  try {
    const sub = await call('/api/push/subscribe', { method: 'POST', cookie: phone, body: { subscription: { endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } } });
    assert.equal(sub.status, 200);

    const login = await (await password()).json();
    assert.equal(login.canApprove, true);
    const { number } = await (await call('/api/login/approve', { method: 'POST', body: { ticket: login.ticket } })).json();
    assert.ok(number >= 10 && number <= 99);
    assert.equal(received.length, 1);
    const { headers, msg } = received[0];
    assert.match(headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    assert.equal(headers['content-encoding'], 'aes128gcm');
    assert.equal(headers.urgency, 'high');
    assert.match(msg.title, /logging in/);
    const id = msg.url.split('/approve/')[1];

    assert.equal((await (await call('/api/login/approve-status', { method: 'POST', body: { ticket: login.ticket } })).json()).status, 'pending');
    const shown = await (await call(`/api/login-approvals/${id}`, { cookie: phone })).json();
    assert.equal(shown.choices.length, 3);
    assert.ok(shown.choices.includes(number));
    assert.equal((await (await call(`/api/login-approvals/${id}`, { method: 'POST', cookie: phone, body: { decision: 'approve', number } })).json()).status, 'approved');
    const done = await call('/api/login/approve-status', { method: 'POST', body: { ticket: login.ticket } });
    assert.ok(cookieOf(done), 'the approved login gets its session');

    // Picking the wrong number denies the login.
    const l2 = await (await password()).json();
    const n2 = (await (await call('/api/login/approve', { method: 'POST', body: { ticket: l2.ticket } })).json()).number;
    const id2 = received.at(-1).msg.url.split('/approve/')[1];
    const wrong = n2 === 99 ? 98 : n2 + 1;
    assert.equal((await (await call(`/api/login-approvals/${id2}`, { method: 'POST', cookie: phone, body: { decision: 'approve', number: wrong } })).json()).status, 'denied');
    assert.equal((await (await call('/api/login/approve-status', { method: 'POST', body: { ticket: l2.ticket } })).json()).status, 'denied');

    // A test notification arrives too.
    assert.equal((await call('/api/push/test', { method: 'POST', cookie: phone })).status, 200);
    assert.equal(received.at(-1).msg.body, 'Notifications work on this device.');
  } finally {
    svc.close();
  }
});

test('the owner can require it for everyone; AI tokens cannot touch it', async () => {
  const r = await (await call('/api/2fa/settings', { method: 'PUT', cookie: phone, body: { required: true } })).json();
  assert.equal(r.required, true);
  assert.equal((await call('/api/2fa/disable', { method: 'POST', cookie: phone, body: { code: '000000' } })).status, 403, 'cannot turn off while required');
  const tok = await (await call('/api/ai-tokens', { method: 'POST', cookie: phone, body: { label: 'x', access: 'manage' } })).json();
  const viaAi = await fetch(`${base}/api/2fa/status`, { headers: { authorization: `Bearer ${tok.token}` } });
  assert.equal(viaAi.status, 403);
});
