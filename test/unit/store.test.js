'use strict';
const { useTempData } = require('../helpers');
const dir = useTempData();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const store = require('../../lib/store');

test('server passwords and keys are encrypted at rest', () => {
  const s = store.addServer({ name: 'web', host: 'example.com', port: 22, username: 'azureuser', password: 'P@ssw0rd!', privateKey: '-----BEGIN KEY-----abc' });
  const raw = fs.readFileSync(path.join(dir, 'servers.json'), 'utf8');
  assert.doesNotMatch(raw, /P@ssw0rd|BEGIN KEY/);
  const full = store.getServer(s.id);
  assert.equal(full.password, 'P@ssw0rd!');
  assert.equal(store.listServers()[0].authType, 'key');
  assert.equal(store.listServers()[0].password, undefined, 'the list never includes secrets');
});

test('data files are private (mode 600)', () => {
  const mode = fs.statSync(path.join(dir, 'servers.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('removing a server also removes its backup settings', () => {
  const s = store.addServer({ name: 'tmp', host: 'h', port: 22, username: 'u', password: 'p' });
  store.setBackupConfig(s.id, { enabled: true, remote: { type: 'none' } });
  assert.ok(store.getBackupConfig(s.id));
  store.removeServer(s.id);
  assert.equal(store.getBackupConfig(s.id), null);
});

test('the owner password is hashed, and ADMIN_PASSWORD seeds it', () => {
  process.env.ADMIN_PASSWORD = 'first-password-1';
  store.initAdminPassword();
  assert.equal(store.verifyAdminPassword('first-password-1'), true);
  assert.equal(store.verifyAdminPassword('wrong'), false);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), /first-password-1/);
  store.setAdminPassword('changed-in-the-app');
  store.initAdminPassword(); // same env value: the changed password stays
  assert.equal(store.verifyAdminPassword('changed-in-the-app'), true);
  delete process.env.ADMIN_PASSWORD;
});
