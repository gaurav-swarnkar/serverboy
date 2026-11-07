'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const apps = require('../../lib/docker-apps');

const sample = { name: 'demo', hostPort: 8123, domain: 'demo.example.com', https: true };

test('every app listens on 127.0.0.1 only, so Docker never opens a port past the firewall', () => {
  for (const cat of apps.CATALOG) {
    const yml = cat.compose(sample);
    const ports = [...yml.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)].map((m) => m[1]).filter((p) => /:\d+$/.test(p) && !p.startsWith('./'));
    assert.ok(ports.length >= 1, `${cat.id} publishes a port`);
    for (const p of ports) assert.match(p, /^127\.0\.0\.1:8123:\d+$/, `${cat.id}: ${p}`);
    assert.doesNotMatch(yml, /network_mode:\s*host|privileged:\s*true/, `${cat.id} must not use host networking or privileged mode`);
  }
});

test('data is kept in bind mounts inside the app folder (so backups copy it)', () => {
  for (const cat of apps.CATALOG) {
    const yml = cat.compose(sample);
    const mounts = [...yml.matchAll(/^\s*-\s*(\.\/data\/[^:]+):/gm)].map((m) => m[1]);
    assert.ok(mounts.length >= 1, `${cat.id} keeps data under ./data`);
    for (const d of cat.dirs) assert.ok(mounts.includes(`./${d.path}`), `${cat.id} mounts ${d.path}`);
  }
});

test('generated passwords are strong and different every time', () => {
  const wp = apps.CATALOG.find((c) => c.id === 'wordpress');
  const a = wp.env(sample, {});
  const b = wp.env(sample, {});
  assert.ok(a.DB_PASSWORD.length >= 20 && a.DB_ROOT_PASSWORD.length >= 20);
  assert.notEqual(a.DB_PASSWORD, b.DB_PASSWORD);
  assert.notEqual(a.DB_PASSWORD, a.DB_ROOT_PASSWORD);
  const n8n = apps.CATALOG.find((c) => c.id === 'n8n').env(sample, { timezone: 'Asia/Kolkata' });
  assert.equal(n8n.WEBHOOK_URL, 'https://demo.example.com/');
  assert.equal(n8n.N8N_SECURE_COOKIE, 'true');
  assert.equal(n8n.N8N_LISTEN_ADDRESS, '0.0.0.0', 'IPv4 inside the container (IPv6-less hosts)');
  assert.equal(apps.CATALOG.find((c) => c.id === 'n8n').env(sample, { timezone: 'x; rm -rf /' }).GENERIC_TIMEZONE, 'UTC');
});

test('app names are validated', () => {
  assert.equal(apps.appName(' Blog '), 'blog');
  for (const bad of ['', 'a', '1blog', 'my_blog', 'blog!', '../etc', 'a'.repeat(40)]) assert.throws(() => apps.appName(bad), /Name:/, bad);
});

test('backup hooks dump the WordPress database and pause it during the copy', () => {
  const h = apps.backupHooks({ name: 'blog', app: 'wordpress' });
  assert.match(h.before[0], /docker compose -p sb-blog exec -T db .*mariadb-dump/);
  assert.match(h.before[1], /pause 'db'|pause db/);
  assert.match(h.after[0], /unpause/);
  assert.deepEqual(apps.backupHooks({ name: 'status', app: 'uptime-kuma' }), { before: [], after: [] });
});
