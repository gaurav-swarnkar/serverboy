// The MCP connector: tokens, the MCP protocol, permissions of read-only tokens, and the OAuth
// sign-in that claude.ai uses (registration, approval, PKCE, refresh, revoke).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { tempDir, freePort, startProcess } = require('./helpers');

const PASSWORD = 'test-owner-password';
let app;
let base;
let cookie = '';
let readToken;
let manageToken;

test.before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = await startProcess(['server.js'], { port, env: { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tempDir('sb-mcp-'), ADMIN_PASSWORD: PASSWORD, SERVERBOY_MONGO_URI: '' } });
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-serverboy': '1' }, body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await api('/api/servers', 'POST', { name: 'web1', host: '10.0.0.9', port: 22, username: 'azureuser', password: 'x' });
});
test.after(() => app?.stop());

function api(path, method = 'GET', body, headers = {}) {
  return fetch(base + path, { method, redirect: 'manual', headers: { 'x-serverboy': '1', cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
}
let rpcId = 0;
async function mcp(token, method, params) {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  return { status: r.status, headers: r.headers, body: r.status === 202 ? null : await r.json() };
}
const tool = async (token, name, args = {}) => (await mcp(token, 'tools/call', { name, arguments: args })).body.result;

test('without a token, /mcp points to the OAuth sign-in', async () => {
  const r = await mcp(null, 'initialize', {});
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /resource_metadata=".*\/\.well-known\/oauth-protected-resource"/);
  const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(pr.resource, `${base}/mcp`);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.registration_endpoint, `${base}/oauth/register`);
});

test('tokens are made by a logged-in person and shown once', async () => {
  const a = await (await api('/api/ai-tokens', 'POST', { label: 'reader', access: 'read', days: 30 })).json();
  const b = await (await api('/api/ai-tokens', 'POST', { label: 'manager', access: 'manage' })).json();
  assert.match(a.token, /^sbt_/);
  readToken = a.token;
  manageToken = b.token;
  const list = await (await api('/api/ai-tokens')).json();
  assert.equal(list.tokens.length, 2);
  assert.ok(!JSON.stringify(list).includes(readToken), 'the token itself is never listed');
});

test('MCP: initialize, notifications, and the tools a token may use', async () => {
  const init = await mcp(readToken, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.equal(init.body.result.serverInfo.name, 'serverboy');
  const note = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${readToken}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);
  const readTools = (await mcp(readToken, 'tools/list')).body.result.tools.map((t) => t.name);
  assert.ok(readTools.includes('list_servers') && readTools.includes('find_documents'));
  assert.ok(!readTools.includes('create_website') && !readTools.includes('run_command'));
  const all = (await mcp(manageToken, 'tools/list')).body.result.tools;
  assert.ok(all.some((t) => t.name === 'create_api' && t.inputSchema.required.includes('collection')));
  assert.ok(all.find((t) => t.name === 'service_action').annotations.destructiveHint);
  assert.equal((await mcp(readToken, 'nope/method')).body.error.code, -32601);
});

test('tools act as the person, with the token\'s access', async () => {
  const servers = JSON.parse((await tool(readToken, 'list_servers')).content[0].text);
  assert.equal(servers[0].name, 'web1');
  assert.ok(!JSON.stringify(servers).includes('"password"'));
  // A read-only token cannot change anything, also not through call_api.
  const r = await tool(readToken, 'call_api', { method: 'POST', path: '/servers', body: { name: 'x', host: '1.2.3.4', username: 'u', password: 'p' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /only look/);
  assert.equal((await api('/api/servers', 'POST', { name: 'y' }, { cookie: '', authorization: `Bearer ${readToken}` })).status, 403);
  // No token can manage tokens or passwords.
  assert.equal((await fetch(`${base}/api/ai-tokens`, { headers: { authorization: `Bearer ${manageToken}` } })).status, 403);
  // Asking for an unknown server explains which exist.
  const bad = await tool(manageToken, 'list_websites', { server: 'nope' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /web1/);
});

test('OAuth: register, approve while logged in, PKCE, refresh and disconnect', async () => {
  const redirect = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect] }) });
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();
  assert.equal((await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) })).status, 400);

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const qs = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' });
  // Arriving from another site, the login cookie is not sent: a Continue link first.
  const first = await (await fetch(`${base}/oauth/authorize?${qs}`)).text();
  assert.match(first, /Continue/);
  const consent = await (await fetch(`${base}/oauth/authorize?${qs}&sb=1`, { headers: { cookie } })).text();
  assert.match(consent, /Allow Claude to use Serverboy/);
  const csrf = consent.match(/name="csrf" value="([^"]+)"/)[1];
  const form = new URLSearchParams({ ...Object.fromEntries(qs), csrf, access: 'manage', decision: 'allow' });
  // A forged form (wrong csrf) is refused.
  const forged = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(form), csrf: 'x'.repeat(csrf.length) }) });
  assert.equal(forged.status, 400);
  const ok = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  assert.equal(ok.status, 302);
  const back = new URL(ok.headers.get('location'));
  assert.equal(`${back.origin}${back.pathname}`, redirect);
  assert.equal(back.searchParams.get('state'), 'xyz');
  const code = back.searchParams.get('code');

  const tok = (body) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  assert.equal((await tok({ grant_type: 'authorization_code', code, client_id, redirect_uri: redirect, code_verifier: 'wrong' })).status, 400);
  // The code worked only once: after a wrong verifier it is gone. Start again for the real exchange.
  const again = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  const code2 = new URL(again.headers.get('location')).searchParams.get('code');
  const t = await (await tok({ grant_type: 'authorization_code', code: code2, client_id, redirect_uri: redirect, code_verifier: verifier })).json();
  assert.equal(t.token_type, 'Bearer');
  assert.equal(t.scope, 'manage');
  assert.equal((await mcp(t.access_token, 'tools/list')).status, 200);

  const t2 = await (await tok({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id })).json();
  assert.ok(t2.access_token && t2.access_token !== t.access_token);
  assert.equal((await tok({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id })).status, 400, 'a refresh token works once');
  assert.equal((await mcp(t.access_token, 'tools/list')).status, 401, 'the old access token ends');

  const list = (await (await api('/api/ai-tokens')).json()).tokens;
  const app = list.find((x) => x.via === 'oauth');
  assert.equal(app.client, 'Claude');
  assert.equal((await api(`/api/ai-tokens/${app.id}`, 'DELETE')).status, 200);
  assert.equal((await mcp(t2.access_token, 'tools/list')).status, 401);
  assert.equal((await tok({ grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id })).status, 400);
});

test('a revoked token stops working', async () => {
  const id = (await (await api('/api/ai-tokens')).json()).tokens.find((x) => x.label === 'reader').id;
  await api(`/api/ai-tokens/${id}`, 'DELETE');
  assert.equal((await mcp(readToken, 'tools/list')).status, 401);
});
