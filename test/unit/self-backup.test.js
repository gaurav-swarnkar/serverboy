'use strict';
const { useTempData } = require('../helpers');
useTempData();
const test = require('node:test');
const assert = require('node:assert/strict');
const selfBackup = require('../../lib/self-backup');
const store = require('../../lib/store');

test('encrypt / decrypt round trip', () => {
  const data = { format: 'serverboy-backup', files: { 'servers.json': '[]' }, n: 42 };
  const buf = selfBackup.encrypt(data, 'a long passphrase here');
  assert.equal(buf.subarray(0, 5).toString(), 'SBBK1');
  assert.deepEqual(selfBackup.decrypt(buf, 'a long passphrase here'), data);
});

test('wrong passphrase, tampered file and other files are refused', () => {
  const buf = selfBackup.encrypt({ format: 'serverboy-backup' }, 'a long passphrase here');
  assert.throws(() => selfBackup.decrypt(buf, 'another passphrase!'), /Wrong passphrase/);
  const bad = Buffer.from(buf);
  bad[bad.length - 1] ^= 1;
  assert.throws(() => selfBackup.decrypt(bad, 'a long passphrase here'), /Wrong passphrase/);
  assert.throws(() => selfBackup.decrypt(Buffer.from('PK\u0003\u0004 a zip file, not a backup...........................'), 'x'), /not a Serverboy backup/);
});

test('the file contains no readable secrets', async () => {
  store.addServer({ name: 'web', host: '10.0.0.1', port: 22, username: 'u', password: 'VERY-SECRET-PASSWORD' });
  const { data, summary } = await selfBackup.createFile('a long passphrase here');
  assert.doesNotMatch(data.toString('latin1'), /VERY-SECRET-PASSWORD|10\.0\.0\.1|servers/);
  assert.deepEqual(summary.servers, ['web']);
  assert.equal(selfBackup.preview(data, 'a long passphrase here').servers[0], 'web');
});

test('short passphrases are refused and the saved one is encrypted', async () => {
  await assert.rejects(() => selfBackup.createFile('short'), /at least 12/);
  assert.throws(() => selfBackup.saveSettings({ passphrase: 'short' }), /at least 12/);
  assert.throws(() => selfBackup.saveSettings({ enabled: true, passphrase: 'a long passphrase here' }), /Choose where/);
  selfBackup.saveSettings({ enabled: false, passphrase: 'a long passphrase here' });
  const raw = require('fs').readFileSync(require('path').join(process.env.DATA_DIR, 'config.json'), 'utf8');
  assert.doesNotMatch(raw, /a long passphrase here/);
  assert.equal(selfBackup.publicSettings().passphraseSet, true);
});
