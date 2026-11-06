'use strict';
const { useTempData } = require('../helpers');
useTempData();
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../../lib/store');
const protect = require('../../lib/db-protect');

test('database server system databases are protected', () => {
  for (const n of ['admin', 'local', 'config']) assert.equal(protect.classify('mongo', n).kind, 'system');
  for (const n of ['mysql', 'information_schema', 'performance_schema', 'sys']) assert.equal(protect.classify('mysql', n).kind, 'system');
  assert.equal(protect.classify('mongo', 'mysql'), null, 'names only count for their own engine');
  assert.equal(protect.classify('mongo', 'shop'), null);
  assert.equal(protect.classify('mongo', 'constructor'), null, 'no prototype lookups');
});

test("Serverboy's team database and test-restore copies are protected", () => {
  assert.equal(protect.classify('mongo', 'serverboy'), null, 'not protected before the team database is set up');
  store.setTeamDbUri('mongodb://u:p@127.0.0.1:27017/sb_team?authSource=admin');
  assert.equal(protect.teamDbName(), 'sb_team');
  assert.equal(protect.classify('mongo', 'sb_team').kind, 'serverboy');
  assert.equal(protect.classify('mongo', 'sbtest_ab12cd_shop').kind, 'serverboy');
  assert.equal(protect.classify('mysql', 'sbtest_ab12cd_shop').kind, 'serverboy');
});

test('changes to protected places are refused with a reason', () => {
  assert.throws(() => protect.assertWritable('mongo', 'admin'), (e) => e.status === 403 && /protected/.test(e.message));
  assert.throws(() => protect.assertWritable('mongo', 'shop', 'system.views'), (e) => e.status === 403);
  assert.throws(() => protect.assertWritable('mysql', 'mysql'), (e) => e.status === 403);
  assert.doesNotThrow(() => protect.assertWritable('mongo', 'shop', 'orders'));
  assert.doesNotThrow(() => protect.assertWritable('mysql', 'wordpress'));
});
