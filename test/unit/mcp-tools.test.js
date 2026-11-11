'use strict';
// Each person's AI only sees the tools their role allows.
const { useTempData } = require('../helpers');
useTempData();
const test = require('node:test');
const assert = require('node:assert/strict');
const { toolsFor } = require('../../lib/mcp');

const names = (user, access) => toolsFor(user, { access }).map((t) => t.name);
const owner = { isOwner: true, permissions: [] };
const developer = { isOwner: false, permissions: ['databases', 'sites', 'files', 'services'] };
const viewer = { isOwner: false, permissions: [] };

test('the owner gets every tool with a manage token', () => {
  const all = names(owner, 'manage');
  for (const t of ['create_api', 'run_backup', 'run_command', 'node_app_action']) assert.ok(all.includes(t), t);
});

test('a developer gets the tools of their role, no owner-only or Terminal tools', () => {
  const dev = names(developer, 'manage');
  for (const t of ['create_website', 'create_api', 'move_api', 'service_action', 'find_documents']) assert.ok(dev.includes(t), t);
  for (const t of ['run_backup', 'backups_status', 'run_command', 'node_app_action', 'list_node_apps']) assert.ok(!dev.includes(t), t);
  assert.ok(!names(developer, 'read').includes('create_api'), 'read tokens never change things');
});

test('a viewer can still look at servers and health', () => {
  const v = names(viewer, 'manage');
  assert.ok(v.includes('list_servers') && v.includes('server_health'));
  assert.ok(!v.includes('list_databases') && !v.includes('create_website'));
});

test('someone limited to some websites cannot be offered "create website"', () => {
  const limited = { isOwner: false, permissions: ['databases', 'sites'], scope: { sites: [{ s: 'x', n: 'shop.com', l: 'edit' }], databases: 'all' } };
  const t = names(limited, 'manage');
  assert.ok(!t.includes('create_website'));
  assert.ok(t.includes('set_website_live') && t.includes('create_api') && t.includes('my_access'));
});
