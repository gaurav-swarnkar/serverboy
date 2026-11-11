'use strict';
// Ignored health warnings: keys, expiry, and how they leave the shown list.
const { useTempData } = require('../helpers');
useTempData();
const test = require('node:test');
const assert = require('node:assert/strict');
const ig = require('../../lib/health-ignore');

const site404 = { level: 'warn', area: 'site', target: 'smiloquotes.example', text: 'smiloquotes.example: Page not found (404).' };
const disk = (pct) => ({ level: 'warn', area: 'disk', text: `The disk is ${pct}% full.` });

test('the same thing keeps the same key, whatever its numbers', () => {
  assert.equal(ig.keyOf(disk(81)), ig.keyOf(disk(87)));
  assert.equal(ig.keyOf(site404), 'site:smiloquotes.example');
});

test('ignored problems leave the shown list, and come back when un-ignored', () => {
  ig.ignore('s1', ig.keyOf(site404), { days: 0, by: 'admin', text: site404.text });
  const { shown, ignored } = ig.apply('s1', [site404, disk(85)]);
  assert.deepEqual(shown.map((p) => p.area), ['disk']);
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].until, null, 'always');
  assert.equal(ignored[0].ignoredBy, 'admin');
  // Other servers are not affected.
  assert.equal(ig.apply('s2', [site404]).shown.length, 1);
  assert.ok(ig.unignore('s1', 'site:smiloquotes.example'));
  assert.equal(ig.apply('s1', [site404]).shown.length, 1);
});

test('an ignore for some days ends by itself', () => {
  ig.ignore('s1', 'disk', { days: 7 });
  assert.equal(ig.apply('s1', [disk(85)]).shown.length, 0);
  const entry = ig.active('s1').disk;
  entry.until = new Date(Date.now() - 1000).toISOString(); // pretend 7 days passed
  assert.equal(ig.apply('s1', [disk(85)]).shown.length, 1);
  ig.removeServer('s1');
  assert.deepEqual(ig.active('s1'), {});
});
