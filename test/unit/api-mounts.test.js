'use strict';
// API folders inside websites: https://<site>/<folder>/<group>/<api>.
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../../lib/api-mounts');

const blog = {
  name: 'blog-api',
  app: { name: 'blog-api', port: 4101, site: 'shop.com', folder: 'data-k3x9' },
  cfg: { name: 'blog-api', database: 'blog', apis: { posts: { group: 'Blog' }, comments: { group: 'blog' }, health: {} } },
};
const auth = {
  name: 'auth-api',
  app: { name: 'auth-api', port: 4102, site: 'shop.com', folder: 'data-k3x9' },
  cfg: { name: 'auth-api', database: 'users', apis: { login: { group: 'Auth APIs' }, register: { group: 'Auth APIs' } } },
};

test('folder names are checked, groups become sub-folders', () => {
  assert.equal(m.folderName(' /Data-K3x9/ '), 'data-k3x9');
  for (const bad of ['', '../etc', 'a b', 'x'.repeat(41), '.well-known', 'a/b']) assert.throws(() => m.folderName(bad), /API folder/);
  assert.equal(m.groupSlug('Auth APIs'), 'auth-apis');
  assert.equal(m.apiPath('data-k3x9', 'login', { group: 'Auth APIs' }), '/data-k3x9/auth-apis/login');
  assert.equal(m.apiPath('data-k3x9', 'health', {}), '/data-k3x9/health');
  assert.deepEqual(m.pathsOf(blog.app, blog.cfg), { posts: '/data-k3x9/blog/posts', comments: '/data-k3x9/blog/comments', health: '/data-k3x9/health' });
  assert.deepEqual(m.pathsOf({ port: 1 }, blog.cfg), {});
});

test('public paths map back to what the engine answers', () => {
  assert.equal(m.toInternal(blog.app, blog.cfg, '/data-k3x9/blog/posts?limit=5'), '/api/posts?limit=5');
  assert.equal(m.toInternal(blog.app, blog.cfg, '/data-k3x9/blog/posts/665f1c2ab4e3/x?a=1'), '/api/posts/665f1c2ab4e3/x?a=1');
  assert.equal(m.toInternal(blog.app, blog.cfg, '/data-k3x9/blog/postsX'), '/data-k3x9/blog/postsX');
  assert.equal(m.toInternal(blog.app, blog.cfg, '/api/posts'), '/api/posts');
});

test('several databases share one website folder; the same address twice is refused', () => {
  const p = m.plan('shop.com', [blog, auth]);
  assert.deepEqual(p.folders, ['data-k3x9']);
  assert.equal(p.routes.length, 5);
  assert.deepEqual(p.conflicts, []);
  const clash = { ...auth, cfg: { ...auth.cfg, apis: { posts: { group: 'blog' } } } };
  assert.match(m.plan('shop.com', [blog, clash]).conflicts[0], /\/data-k3x9\/blog\/posts/);
  // Other websites are not affected.
  assert.equal(m.plan('other.com', [blog, auth]).routes.length, 0);
});

test('copies of an API server (copied folder or restored backup) are never routed', () => {
  const copy = { ...blog, name: 'blog-api-restored-20261107-024723' };
  assert.equal(m.isCopy(copy), true);
  assert.equal(m.isCopy({ ...copy, app: { ...copy.app, name: copy.name, independent: true }, cfg: { ...copy.cfg, name: copy.name } }), false);
  assert.equal(m.isCopy({ name: 'x', app: { name: 'y' }, cfg: {} }), true);
  const p = m.plan('shop.com', [blog, copy]);
  assert.deepEqual(p.conflicts, []);
  assert.equal(p.mounted.length, 1);
});

test('the Nginx routes forward each API to its server, and the folder answers 404 JSON', () => {
  const text = m.snippet('shop.com', m.plan('shop.com', [blog, auth]));
  assert.match(text, /location \^~ \/data-k3x9\/ \{ default_type application\/json; return 404/);
  assert.match(text, /location = \/data-k3x9\/auth-apis\/login \{ proxy_pass http:\/\/127\.0\.0\.1:4102\/api\/login;/);
  assert.match(text, /location \^~ \/data-k3x9\/blog\/posts\/ \{ proxy_pass http:\/\/127\.0\.0\.1:4101\/api\/posts\/;/);
  assert.match(m.snippet('shop.com', m.plan('shop.com', [])), /no API folder/);
});
