'use strict';
// Who may use the AI connector: everyone by default; the owner can turn it off for the team or
// for single people, and the owner always may.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ai-allowed-'));
const ai = require('../../lib/ai-access');

const owner = { id: 'owner', isOwner: true };
const dev = { id: '65a1b2c3d4e5f6a7b8c9d0e1', isOwner: false };
const other = { id: '65a1b2c3d4e5f6a7b8c9d0e2', isOwner: false };

test('on for everyone by default', () => {
  assert.deepEqual(ai.settings(), { team: true, blocked: [] });
  assert.equal(ai.allowed(owner), true);
  assert.equal(ai.allowed(dev), true);
  assert.equal(ai.allowed(null), false);
});

test('off for one person, then back on', () => {
  ai.setUserAllowed(dev.id, false);
  assert.equal(ai.allowed(dev), false);
  assert.equal(ai.allowed(other), true);
  ai.setUserAllowed(dev.id, false);
  assert.deepEqual(ai.settings().blocked, [dev.id], 'no duplicates');
  ai.setUserAllowed(dev.id, true);
  assert.equal(ai.allowed(dev), true);
});

test('off for the whole team: the owner still may; the setting is saved', () => {
  ai.setTeamAllowed(false);
  assert.equal(ai.allowed(dev), false);
  assert.equal(ai.allowed(owner), true);
  ai.setUserAllowed(other.id, false);
  ai.reload();
  assert.deepEqual(ai.settings(), { team: false, blocked: [other.id] });
  ai.forgetUser(other.id);
  ai.setTeamAllowed(true);
  assert.deepEqual(ai.settings(), { team: true, blocked: [] });
});
