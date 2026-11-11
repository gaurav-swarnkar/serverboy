'use strict';
// Tasks remember who started them: the owner sees all, others only their own.
const { useTempData } = require('../helpers');
useTempData();
const test = require('node:test');
const assert = require('node:assert/strict');
const jobs = require('../../lib/jobs');
const { requestContext } = require('../../lib/auth');

test('a task started by a person is theirs; the owner sees every task', async () => {
  const mine = requestContext.run({ userId: 'dev1' }, () => jobs.create('srv', 'Dev task', []));
  const other = requestContext.run({ userId: 'dev2' }, () => jobs.create('srv', 'Other task', []));
  const scheduled = jobs.create('srv', 'Scheduled backup', []);
  const titles = (user) => jobs.list('srv', user).map((j) => j.title).sort();
  assert.deepEqual(titles({ id: 'dev1', isOwner: false }), ['Dev task']);
  assert.deepEqual(titles({ id: 'owner', isOwner: true }), ['Dev task', 'Other task', 'Scheduled backup']);
  assert.ok(!jobs.canSee(jobs.get(other.id), { id: 'dev1', isOwner: false }));
  assert.ok(!jobs.canSee(jobs.get(scheduled.id), { id: 'dev1', isOwner: false }), 'tasks nobody started are the owner\'s');
  assert.ok(jobs.canSee(jobs.get(mine.id), { id: 'dev1', isOwner: false }));
});
