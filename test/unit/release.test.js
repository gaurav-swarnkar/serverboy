'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const changelog = require('../../lib/changelog');
const pkg = require('../../package.json');

const cmp = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

test('package.json version is the newest changelog entry', () => {
  assert.equal(pkg.version, changelog[0].version, 'add a changelog entry for this version (or fix package.json)');
});

test('changelog versions are valid, unique and newest first', () => {
  const seen = new Set();
  for (let i = 0; i < changelog.length; i++) {
    const e = changelog[i];
    assert.match(e.version, /^\d+\.\d+\.\d+$/);
    assert.ok(!seen.has(e.version), `duplicate ${e.version}`);
    seen.add(e.version);
    assert.ok(Array.isArray(e.items) && e.items.length, `${e.version} needs items`);
    if (i) assert.ok(cmp(changelog[i - 1].version, e.version) > 0, `${changelog[i - 1].version} should be newer than ${e.version}`);
  }
});

test('version comparison used for update notices', () => {
  const { newer } = require('../../lib/version');
  assert.equal(newer('v1.10.0', '1.9.9'), true);
  assert.equal(newer('1.5.0', '1.5.0'), false);
  assert.equal(newer('v1.4.9', '1.5.0'), false);
  assert.equal(newer('2.0.0', '1.99.99'), true);
});
