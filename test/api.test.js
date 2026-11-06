// Starts a real Serverboy (empty data folder, no team database) and checks login, sessions,
// CSRF protection, security headers, permissions and the Serverboy backup endpoints.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDir, freePort, startProcess } = require('./helpers');

const PASSWORD = 'test-owner-password';
let app;
let base;
let cookie = '';

test.before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = await startProcess(['server.js'], { port, env: { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tempDir('sb-api-'), ADMIN_PASSWORD: PASSWORD, TRUST_PROXY: '1', SERVERBOY_MONGO_URI: '' } });
});
test.after(() => app?.stop());

const call = (path, { method = 'GET', body, headers = {}, auth = true, csrf = true } = {}) =>
  fetch(base + path, {
    method,
    redirect: 'manual',
    headers: { ...(csrf ? { 'x-serverboy': '1' } : {}), ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(auth && cookie ? { cookie } : {}), ...headers },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });

test('the app page loads with security headers', async () => {
  const res = await call('/', { auth: false });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<html/i);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'.*frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('strict-transport-security'), null, 'no HSTS over plain http');
  const https = await call('/', { auth: false, headers: { 'x-forwarded-proto': 'https' } });
  assert.match(https.headers.get('strict-transport-security'), /max-age=/);
});

test('files outside public/ cannot be fetched', async () => {
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/data/config.json', '/lib/store.js', '/package.json']) {
    const res = await call(p, { auth: false });
    const text = await res.text();
    assert.doesNotMatch(text, /require\(|"secret"|"dependencies"/, p);
  }
});

test('API needs a login', async () => {
  assert.equal((await call('/api/servers', { auth: false })).status, 401);
  assert.deepEqual(await (await call('/api/me', { auth: false })).json(), { loggedIn: false, user: null });
});

test('wrong password is refused', async () => {
  const res = await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'nope' }, auth: false });
  assert.equal(res.status, 401);
});

test('owner logs in with an HttpOnly, SameSite=Strict cookie', async () => {
  const res = await call('/api/login', { method: 'POST', body: { username: 'admin', password: PASSWORD }, auth: false });
  assert.equal(res.status, 200);
  const set = res.headers.get('set-cookie');
  assert.match(set, /sb_session=[a-f0-9]{64}/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  cookie = set.split(';')[0];
  const me = await (await call('/api/me')).json();
  assert.equal(me.user.isOwner, true);
});

test('changes need the x-serverboy header (CSRF protection)', async () => {
  const res = await call('/api/servers', { method: 'POST', body: { name: 'x', host: 'h', username: 'u', password: 'p' }, csrf: false });
  assert.equal(res.status, 403);
});

test('servers: add, list without secrets, unknown id is 404', async () => {
  const add = await call('/api/servers', { method: 'POST', body: { name: 'web', host: '192.0.2.10', port: 22, username: 'azureuser', password: 'server-pass' } });
  assert.equal(add.status, 200);
  const list = await (await call('/api/servers')).json();
  assert.equal(list.length, 1);
  assert.equal(JSON.stringify(list).includes('server-pass'), false);
  assert.equal((await call('/api/servers/does-not-exist/stats')).status, 404);
});

test('unknown API routes answer 404 JSON', async () => {
  const res = await call('/api/nothing-here');
  assert.equal(res.status, 404);
  assert.ok((await res.json()).error);
});

test('Log in as needs a real team member', async () => {
  const res = await call('/api/view-as/123456789012345678901234', { method: 'POST' });
  assert.notEqual(res.status, 200);
  const bad = await call('/api/view-as-start', { method: 'POST', body: { code: 'f'.repeat(48) }, auth: false });
  assert.equal(bad.status, 400);
});

test('a forged session header gives no access', async () => {
  const res = await call('/api/me', { auth: false, headers: { 'x-serverboy-session': 'a'.repeat(64) } });
  assert.equal((await res.json()).loggedIn, false);
});

test('Serverboy backup: download, preview, wrong passphrase', async () => {
  assert.equal((await call('/api/serverboy-backup/file', { method: 'POST', body: { passphrase: 'short' } })).status, 400);
  const res = await call('/api/serverboy-backup/file', { method: 'POST', body: { passphrase: 'a long test passphrase' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /serverboy-\d{8}-\d{6}\.sbbackup/);
  const file = Buffer.from(await res.arrayBuffer());
  assert.equal(file.subarray(0, 5).toString(), 'SBBK1');
  const form = (pass) => {
    const f = new FormData();
    f.append('file', new Blob([file]), 'x.sbbackup');
    f.append('passphrase', pass);
    return f;
  };
  const ok = await call('/api/serverboy-backup/preview', { method: 'POST', body: form('a long test passphrase') });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).servers, ['web']);
  const wrong = await call('/api/serverboy-backup/preview', { method: 'POST', body: form('the wrong passphrase') });
  assert.equal(wrong.status, 400);
});

test('backups settings of a server are owner data', async () => {
  const [srv] = await (await call('/api/servers')).json();
  const res = await call(`/api/servers/${srv.id}/backups`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).configured, false);
  const bad = await call(`/api/servers/${srv.id}/backups/settings`, { method: 'PUT', body: { remote: { type: 's3', bucket: 'x' } } });
  assert.equal(bad.status, 400);
});

test('logout ends the session', async () => {
  assert.equal((await call('/api/logout', { method: 'POST' })).status, 200);
  assert.equal((await (await call('/api/me')).json()).loggedIn, false);
});

test('five wrong passwords lock the login for a while', async () => {
  for (let i = 0; i < 5; i++) await call('/api/login', { method: 'POST', body: { username: 'admin', password: `wrong-${i}` }, auth: false });
  const res = await call('/api/login', { method: 'POST', body: { username: 'admin', password: PASSWORD }, auth: false });
  assert.equal(res.status, 429, 'even the right password waits until the lock ends');
});

test('behind Nginx (TRUST_PROXY=1) each visitor has their own login lock', async () => {
  // The previous test locked 127.0.0.1-direct; a different real client IP is not blocked.
  const res = await call('/api/login', { method: 'POST', body: { username: 'admin', password: PASSWORD }, auth: false, headers: { 'x-forwarded-for': '203.0.113.7' } });
  assert.equal(res.status, 200);
});
