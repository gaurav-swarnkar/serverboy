'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requiredForServerRoute, can, cleanPermissions, OWNER } = require('../../lib/permissions');
const scope = require('../../lib/scope');

test('server routes need the right permission; unknown routes are owner-only', () => {
  const cases = [
    ['GET', '/stats', null],
    ['GET', '/health', null],
    ['POST', '/files/write', 'files'],
    ['POST', '/files/chown', OWNER],
    ['GET', '/mongo/databases', 'databases'],
    ['POST', '/mongo/secure', OWNER],
    ['PUT', '/sites/a.com/config', OWNER],
    ['POST', '/sites', 'sites'],
    ['POST', '/node-apps/x/deploy', 'nodeapps'],
    ['POST', '/reboot', 'system'],
    ['GET', '/backups', OWNER],
    ['POST', '/backups/run', OWNER],
    ['GET', '/something-new', OWNER],
  ];
  for (const [m, p, want] of cases) assert.equal(requiredForServerRoute(m, p), want, `${m} ${p}`);
});

test('can() for owner, members and anonymous', () => {
  const owner = { isOwner: true };
  const dev = { isOwner: false, permissions: ['sites', 'files'] };
  assert.equal(can(owner, OWNER), true);
  assert.equal(can(dev, OWNER), false);
  assert.equal(can(dev, 'sites'), true);
  assert.equal(can(dev, 'terminal'), false);
  assert.equal(can(dev, null), true);
  assert.equal(can(null, null), false);
});

test('cleanPermissions drops unknown values', () => {
  assert.deepEqual(cleanPermissions(['sites', 'sites', 'root', 'files']), ['sites', 'files']);
  assert.deepEqual(cleanPermissions('sites'), []);
});

test('scoped access to websites and databases', () => {
  const dev = { isOwner: false, permissions: ['sites', 'databases'], scope: { sites: [{ s: 'srv1', n: 'a.com', l: 'view' }], databases: [{ s: 'srv1', e: 'mongo', n: 'shop', l: 'edit' }] } };
  assert.equal(scope.siteLevel(dev, 'srv1', 'a.com'), 'view');
  assert.equal(scope.siteLevel(dev, 'srv1', 'b.com'), null);
  assert.equal(scope.siteLevel(dev, 'srv2', 'a.com'), null);
  assert.equal(scope.dbLevel(dev, 'srv1', 'mongo', 'shop'), 'edit');
  assert.equal(scope.dbLevel(dev, 'srv1', 'mysql', 'shop'), null);
  assert.equal(scope.isAll({ isOwner: true }, 'sites'), true);
  assert.equal(scope.isAll(dev, 'sites'), false);
});
