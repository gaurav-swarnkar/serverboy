'use strict';
const { useTempData } = require('../helpers');
useTempData();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const store = require('../../lib/store');
const deploy = require('../../lib/deploy');

const server = store.addServer({ name: 'web', host: '10.0.0.9', port: 22, username: 'u', password: 'p' });
const hook = deploy.enableHook(server.id, 'shop');
const cfg = async () => ({ name: 'shop', repo: 'git@github.com:me/shop.git', branch: 'main' });
const sign = (body, secret = hook.secret) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
const gh = (event, payload, secret) => {
  const raw = Buffer.from(JSON.stringify(payload));
  return deploy.handleHook(hook.id, { 'x-github-event': event, 'x-hub-signature-256': sign(raw, secret) }, raw, cfg);
};

test('kept paths are validated', () => {
  assert.deepEqual(deploy.cleanKeep('uploads\n./data/app.db\nuploads/'), ['uploads', 'data/app.db']);
  for (const bad of ['../etc', '/etc/passwd', '.git', 'node_modules', 'a/../../b', 'x; rm -rf /', 'a b']) {
    assert.throws(() => deploy.cleanKeep([bad]), /cannot be kept/, bad);
  }
});

test('enabling twice keeps the same hook; the secret is stored encrypted', () => {
  assert.equal(deploy.enableHook(server.id, 'shop').id, hook.id);
  assert.match(hook.id, /^[a-f0-9]{32}$/);
  const raw = require('fs').readFileSync(require('path').join(process.env.DATA_DIR, 'config.json'), 'utf8');
  assert.equal(raw.includes(hook.secret), false);
});

test('deliveries without the right secret are refused', async () => {
  const raw = Buffer.from('{"ref":"refs/heads/main"}');
  assert.equal((await deploy.handleHook(hook.id, { 'x-github-event': 'push' }, raw, cfg)).status, 401);
  assert.equal((await gh('push', { ref: 'refs/heads/main' }, 'wrong-secret')).status, 401);
  assert.equal((await deploy.handleHook(hook.id, { 'x-gitlab-token': 'nope' }, raw, cfg)).status, 401);
  assert.equal((await deploy.handleHook('f'.repeat(32), { 'x-hub-signature-256': sign(raw) }, raw, cfg)).status, 404);
  assert.equal((await deploy.handleHook('../../x', {}, raw, cfg)).status, 404);
});

test('a signed body that was changed in transit is refused', async () => {
  const raw = Buffer.from('{"ref":"refs/heads/main"}');
  const r = await deploy.handleHook(hook.id, { 'x-github-event': 'push', 'x-hub-signature-256': sign(raw) }, Buffer.from('{"ref":"refs/heads/evil"}'), cfg);
  assert.equal(r.status, 401);
});

test('ping, other branches, deleted branches and other events do not deploy', async () => {
  assert.equal((await gh('ping', { zen: 'x' })).status, 200);
  const other = await gh('push', { ref: 'refs/heads/feature', after: 'a'.repeat(40) });
  assert.equal(other.status, 202);
  assert.match(other.body.ignored, /deploys main/);
  assert.match((await gh('push', { ref: 'refs/heads/main', after: '0'.repeat(40), deleted: true })).body.ignored, /deleted/);
  assert.match((await gh('issues', { action: 'opened' })).body.ignored, /not a push/);
  const gl = await deploy.handleHook(hook.id, { 'x-gitlab-token': hook.secret, 'x-gitlab-event': 'Push Hook' }, Buffer.from(JSON.stringify({ object_kind: 'push', ref: 'refs/heads/dev' })), cfg);
  assert.equal(gl.status, 202);
  const list = deploy.hookFor(server.id, 'shop').deliveries;
  assert.ok(list.length >= 5 && list.every((d) => !/deploying/.test(d.result)));
});

test('turning it off forgets the hook', async () => {
  deploy.disableHook(server.id, 'shop');
  assert.equal(deploy.hookFor(server.id, 'shop'), null);
  const raw = Buffer.from('{}');
  assert.equal((await deploy.handleHook(hook.id, { 'x-hub-signature-256': sign(raw) }, raw, cfg)).status, 404);
});
