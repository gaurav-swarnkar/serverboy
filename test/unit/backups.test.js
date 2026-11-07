'use strict';
const { useTempData } = require('../helpers');
useTempData();
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../../lib/store');
const backups = require('../../lib/backups');

const ist = { every: 'day', time: '03:00', weekday: 0, tz: 'Asia/Kolkata' };

test('daily schedule follows the chosen time zone', () => {
  // 03:00 in India is 21:30 UTC the day before.
  assert.equal(backups.nextRun(ist, new Date('2026-11-06T10:00:00Z')).toISOString(), '2026-11-06T21:30:00.000Z');
  assert.equal(backups.isSlot(new Date('2026-11-06T21:30:00Z'), ist), true);
  assert.equal(backups.isSlot(new Date('2026-11-06T21:31:00Z'), ist), false);
});

test('every 6 hours, every 12 hours and weekly schedules', () => {
  assert.equal(backups.nextRun({ ...ist, every: '6h' }, new Date('2026-11-06T10:00:00Z')).toISOString(), '2026-11-06T15:30:00.000Z');
  // 12 h slots are 03:00 and 15:00 IST = 21:30 and 09:30 UTC.
  assert.equal(backups.nextRun({ ...ist, every: '12h' }, new Date('2026-11-06T10:00:00Z')).toISOString(), '2026-11-06T21:30:00.000Z');
  assert.equal(backups.nextRun({ ...ist, every: '12h' }, new Date('2026-11-06T09:00:00Z')).toISOString(), '2026-11-06T09:30:00.000Z');
  // 6 Nov 2026 is a Friday; the next Sunday 03:00 IST is Saturday 21:30 UTC.
  assert.equal(backups.nextRun({ ...ist, every: 'week', weekday: 0 }, new Date('2026-11-06T10:00:00Z')).toISOString(), '2026-11-07T21:30:00.000Z');
  assert.equal(backups.nextRun({ every: 'day', time: '00:00', tz: 'UTC' }, new Date('2026-12-31T23:59:30Z')).toISOString(), '2027-01-01T00:00:00.000Z');
});

test('mongodump gets a URI without a database path', () => {
  const orig = store.getServer;
  const cases = [
    ['mongodb://127.0.0.1:27017', 'mongodb://127.0.0.1:27017/'],
    ['mongodb://u:p%40x@h:27017/admin', 'mongodb://u:p%40x@h:27017/?authSource=admin'],
    ['mongodb://u:p@h/shop?retryWrites=true', 'mongodb://u:p@h/?retryWrites=true&authSource=shop'],
    ['mongodb+srv://u:p@c.x.net/?authSource=admin', 'mongodb+srv://u:p@c.x.net/?authSource=admin'],
    ['mongodb://h:1/db', 'mongodb://h:1/'],
  ];
  try {
    for (const [input, out] of cases) {
      store.getServer = () => ({ mongoUri: input });
      assert.equal(backups.toolUri('x'), out, input);
    }
  } finally {
    store.getServer = orig;
  }
});

test('settings validate input and keep cloud secrets encrypted', () => {
  const server = store.addServer({ name: 'web', host: '10.0.0.1', port: 22, username: 'u', password: 'pw' });
  const saved = backups.saveSettings(server.id, {
    enabled: true,
    schedule: { every: 'hourly', time: '25:99', tz: 'Not/AZone' },
    include: { mongoDbs: ['ok_db', 'bad;rm -rf'], files: false },
    keepLocal: 9999,
    drill: 'sometimes',
    remote: { type: 's3', bucket: 'my-bucket', accessKeyId: 'AK', secretAccessKey: 'TOPSECRET' },
  });
  assert.deepEqual(saved.schedule, { every: 'day', time: '03:00', weekday: 0, tz: 'UTC' });
  assert.deepEqual(saved.include.mongoDbs, ['ok_db']);
  assert.equal(saved.include.files, false);
  assert.equal(saved.keepLocal, 90);
  assert.equal(saved.drill, 'week');
  assert.equal(saved.remote.secretAccessKey, '', 'secret never goes back to the browser');
  assert.equal(saved.remoteSecretSet, true);
  const raw = require('fs').readFileSync(require('path').join(process.env.DATA_DIR, 'config.json'), 'utf8');
  assert.doesNotMatch(raw, /TOPSECRET/);
  // An empty secret keeps the stored one.
  backups.saveSettings(server.id, { ...saved, remote: { type: 's3', bucket: 'my-bucket', accessKeyId: 'AK', secretAccessKey: '' } });
  assert.equal(backups.settings(server.id).remote.secretAccessKey, 'TOPSECRET');
});

test('health warns when backups are missing, off or failing', () => {
  const server = store.addServer({ name: 'db', host: '10.0.0.2', port: 22, username: 'u', password: 'pw' });
  assert.match(backups.healthProblems(server.id)[0].text, /No backups are set up/);
  backups.saveSettings(server.id, { enabled: false, remote: { type: 'none' } });
  assert.ok(backups.healthProblems(server.id).some((p) => /turned off/.test(p.text)));
  store.setBackupState(server.id, { last: { status: 'failed', error: 'disk full', at: new Date().toISOString() } });
  assert.ok(backups.healthProblems(server.id).some((p) => p.level === 'bad' && /disk full/.test(p.text)));
  store.setBackupState(server.id, { lastDrill: { status: 'failed', backupId: '20261106-030000', at: new Date().toISOString(), error: 'checksum' } });
  assert.ok(backups.healthProblems(server.id).some((p) => p.level === 'bad' && /test-restore failed/.test(p.text)));
});

test('keeping backups on the server only can be chosen, which hides that warning', () => {
  const server = store.addServer({ name: 'solo', host: '10.0.0.3', port: 22, username: 'u', password: 'pw' });
  backups.saveSettings(server.id, { enabled: true, remote: { type: 'none' } });
  const onlyHere = (id) => backups.healthProblems(id).filter((p) => /only kept on this server/.test(p.text));
  assert.equal(onlyHere(server.id).length, 1);
  assert.equal(onlyHere(server.id)[0].dismiss, 'local-only');
  assert.equal(backups.setLocalOnlyOk(server.id, true).localOnlyOk, true);
  assert.equal(onlyHere(server.id).length, 0);
  // Saving other settings keeps the choice; turning it off brings the warning back.
  backups.saveSettings(server.id, { enabled: true, keepLocal: 5, remote: { type: 'none' } });
  assert.equal(onlyHere(server.id).length, 0);
  backups.setLocalOnlyOk(server.id, false);
  assert.equal(onlyHere(server.id).length, 1);
});
