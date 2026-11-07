'use strict';
const { useTempData } = require('../helpers');
useTempData();
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const store = require('../../lib/store');
const ssh = require('../../lib/ssh');
const alerts = require('../../lib/alerts');

// A simulated server: the health check returns whatever `problems` holds (or throws).
let problems = [];
let unreachable = false;
require.cache[require.resolve('../../lib/health')] = { id: 'h', filename: path.resolve(__dirname, '../../lib/health.js'), loaded: true, exports: { check: async () => { if (unreachable) throw new Error('SSH connection refused'); return { problems }; } } };
ssh.exec = async () => ({ code: 0, stdout: '', stderr: '' }); // no certificates
const sent = [];
alerts.notify = async (a) => {
  sent.push(a);
  return [];
};
const monitor = require('../../lib/monitor');
const server = store.addServer({ name: 'web', host: '10.0.0.5', port: 22, username: 'u', password: 'p' });
const check = () => monitor.checkServer(server.id);
const site = (d) => ({ level: 'bad', area: 'site', target: d, text: `${d}: down` });

test('a problem alerts on the second check, once, then "fixed"', async () => {
  sent.length = 0;
  problems = [site('a.com')];
  await check();
  assert.equal(sent.length, 0, 'no alert for a single blip');
  await check();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'problem');
  assert.equal(sent[0].server, 'web');
  await check();
  assert.equal(sent.length, 1, 'not repeated');
  problems = [];
  await check();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].kind, 'fixed');
  assert.match(sent[1].title, /^Fixed: a\.com/);
});

test('a blip that clears before the second check sends nothing', async () => {
  sent.length = 0;
  problems = [site('b.com')];
  await check();
  problems = [];
  await check();
  assert.equal(sent.length, 0);
});

test('many problems at once are grouped into one alert', async () => {
  sent.length = 0;
  problems = ['c1', 'c2', 'c3', 'c4'].map((d) => site(`${d}.com`));
  await check();
  await check();
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /4 problems found/);
  assert.equal(sent[0].text.split('\n').length, 4);
  problems = [];
  await check();
  assert.equal(sent.length, 2);
  assert.match(sent[1].title, /4 problems are fixed/);
});

test('disk 91% and 93% are the same problem', async () => {
  sent.length = 0;
  problems = [{ level: 'bad', area: 'disk', text: 'The disk is 91% full.' }];
  await check();
  problems = [{ level: 'bad', area: 'disk', text: 'The disk is 93% full.' }];
  await check();
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /93%/);
  problems = [];
  await check();
});

test('an unreachable server alerts after two failed checks, and when it is back', async () => {
  sent.length = 0;
  unreachable = true;
  await check();
  await check();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].category, 'unreachable');
  assert.match(sent[0].title, /cannot reach web/);
  unreachable = false;
  await check();
  assert.equal(sent[1].kind, 'fixed');
});

test('warnings use their own category; backup problems are left to the backup system', async () => {
  sent.length = 0;
  problems = [{ level: 'warn', area: 'app', target: 'x', text: 'app restarts a lot' }, { level: 'bad', area: 'backup', text: 'No backups are set up.' }];
  await check();
  await check();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].category, 'warnings');
  assert.equal(sent[0].kind, 'warning');
  problems = [];
  await check();
});

test('problems hidden by a bigger one are not reported as fixed', async () => {
  sent.length = 0;
  problems = [site('e.com'), { level: 'bad', area: 'disk', text: 'The disk is 95% full.' }];
  await check();
  await check();
  assert.equal(sent.length, 2);
  unreachable = true; // nothing can be checked now
  await check();
  await check();
  assert.equal(sent.filter((a) => a.kind === 'fixed').length, 0, 'nothing is "fixed" while the server cannot be reached');
  unreachable = false;
  problems = [{ level: 'bad', area: 'site', target: 'nginx', text: 'All sites are down because Nginx is not answering.' }, { level: 'bad', area: 'disk', text: 'The disk is 95% full.' }];
  await check();
  await check();
  assert.ok(!sent.some((a) => a.kind === 'fixed' && /e\.com/.test(a.title)), 'e.com is hidden by Nginx, not fixed');
  problems = [];
  await check();
  assert.ok(sent.some((a) => a.kind === 'fixed' && /e\.com|problems are fixed/.test(a.title)));
});

test('state is saved, so a restart does not repeat alerts', async () => {
  sent.length = 0;
  problems = [site('d.com')];
  await check();
  await check();
  const saved = require('fs').readFileSync(path.join(process.env.DATA_DIR, 'alert-state.json'), 'utf8');
  assert.match(saved, /d\.com/);
  assert.match(saved, /alertedAt/);
});
