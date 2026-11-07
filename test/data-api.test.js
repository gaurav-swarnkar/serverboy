// Runs the Data API engine (templates/data-api/server.js) against a real MongoDB and checks the
// public/key rules, hidden and read-only fields, filters, parameters and limits.
// Needs TEST_MONGODB_URI (CI starts a MongoDB service); skipped otherwise.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT, tempDir, freePort, startProcess } = require('./helpers');

const URI = process.env.TEST_MONGODB_URI;
const DB = `sbtest_engine_${crypto.randomBytes(3).toString('hex')}`;
const KEY = 'test-key-0123456789';
const READ_KEY = 'read-only-key-0123456789';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
let engine;
let base;

const config = {
  name: 'test-api',
  database: DB,
  cors: ['https://shop.example'],
  rateLimitPerMinute: 0,
  maxLimit: 5,
  apis: {
    items: {
      title: 'Items',
      collection: 'items',
      ops: { list: 'public', get: 'public', count: 'public', create: 'key', update: 'key', delete: 'key' },
      hidden: ['secret'],
      readonly: ['owner'],
      required: ['title'],
      timestamps: true,
    },
    'by-status': {
      title: 'By status',
      collection: 'items',
      ops: { list: 'public', get: 'off', count: 'off', create: 'off', update: 'off', delete: 'off' },
      params: [{ name: 'status', type: 'string', required: true }],
      filter: { status: '{{status}}' },
      callerFilters: false,
      fields: 'title,status',
    },
  },
  keys: [
    { id: 'k1', label: 'admin app', hash: sha(KEY), access: { items: ['read', 'create', 'update', 'delete'] } },
    { id: 'k2', label: 'reader', hash: sha(READ_KEY), access: { '*': ['read'] } },
  ],
};

const call = (p, { method = 'GET', body, key, headers = {} } = {}) =>
  fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'x-api-key': key } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });

test('Data API engine', { skip: !URI && 'set TEST_MONGODB_URI to run (CI does)' }, async (t) => {
  const dir = tempDir('sb-engine-');
  fs.copyFileSync(path.join(ROOT, 'templates/data-api/server.js'), path.join(dir, 'server.js'));
  fs.writeFileSync(path.join(dir, 'api.config.json'), JSON.stringify(config));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  engine = await startProcess([path.join(dir, 'server.js')], { cwd: dir, port, readyPath: '/health', env: { MONGODB_URI: URI, PORT: String(port), NODE_PATH: path.join(ROOT, 'node_modules') } });
  t.after(async () => {
    await engine.stop();
    const { MongoClient } = require('mongodb');
    const c = new MongoClient(URI);
    await c.connect();
    await c.db(DB).dropDatabase();
    await c.close();
  });

  let id;
  await t.test('health lists the APIs', async () => {
    const h = await (await call('/health')).json();
    assert.equal(h.ok, true);
    assert.deepEqual(h.apis.sort(), ['by-status', 'items']);
  });

  await t.test('writing needs a key with the right rights', async () => {
    assert.equal((await call('/api/items', { method: 'POST', body: { title: 'x' } })).status, 401);
    assert.equal((await call('/api/items', { method: 'POST', body: { title: 'x' }, key: 'wrong-key-123456' })).status, 401);
    assert.equal((await call('/api/items', { method: 'POST', body: { title: 'x' }, key: READ_KEY })).status, 403);
  });

  await t.test('create applies required, read-only and timestamps', async () => {
    assert.equal((await call('/api/items', { method: 'POST', body: { status: 'new' }, key: KEY })).status, 400);
    const res = await call('/api/items', { method: 'POST', body: { title: 'Tea', status: 'new', owner: 'hacker', secret: 's3cret', $where: 'x' }, key: KEY });
    assert.equal(res.status, 400, '$-fields are refused');
    const ok = await call('/api/items', { method: 'POST', body: { title: 'Tea', status: 'new', owner: 'hacker', secret: 's3cret' }, key: KEY });
    assert.equal(ok.status, 201);
    const doc = await ok.json();
    id = doc._id;
    assert.equal(doc.owner, undefined, 'read-only field ignored');
    assert.equal(doc.secret, undefined, 'hidden field not returned');
    assert.ok(doc.createdAt && doc.updatedAt);
    for (let i = 0; i < 7; i++) await call('/api/items', { method: 'POST', body: { title: `Item ${i}`, status: i % 2 ? 'done' : 'new' }, key: KEY });
  });

  await t.test('public list hides fields, caps the page size and filters', async () => {
    const list = await (await call('/api/items?limit=100')).json();
    assert.equal(list.total, 8);
    assert.equal(list.data.length, 5, 'maxLimit caps the page');
    assert.ok(list.data.every((d) => d.secret === undefined));
    const done = await (await call('/api/items?status=done')).json();
    assert.equal(done.total, 3);
    assert.equal((await call('/api/items?secret=s3cret')).status, 400, 'cannot filter on hidden fields');
    assert.equal((await call(`/api/items?filter=${encodeURIComponent('{"$where":"sleep(1000)"}')}`)).status, 400, 'no JavaScript operators');
    assert.equal((await (await call('/api/items/count')).json()).count, 8);
  });

  await t.test('an API with a parameter only shows matching documents and fields', async () => {
    assert.equal((await call('/api/by-status')).status, 400, 'missing required parameter');
    const r = await (await call('/api/by-status?status=new&limit=5')).json();
    assert.equal(r.total, 5);
    assert.ok(r.data.every((d) => d.status === 'new' && d.secret === undefined && Object.keys(d).every((k) => ['_id', 'title', 'status'].includes(k))));
    const injected = await (await call(`/api/by-status?status=${encodeURIComponent('{"$ne":null}')}`)).json();
    assert.equal(injected.total, 0, 'a parameter is a value, never an operator');
    assert.equal((await call(`/api/by-status/${id}`)).status, 404, 'get is off');
  });

  await t.test('get, update and delete one item', async () => {
    const one = await (await call(`/api/items/${id}`)).json();
    assert.equal(one.title, 'Tea');
    const upd = await call(`/api/items/${id}`, { method: 'PATCH', body: { title: 'Green tea', owner: 'x' }, key: KEY });
    assert.equal(upd.status, 200);
    assert.equal((await upd.json()).title, 'Green tea');
    assert.equal((await call(`/api/items/${id}`, { method: 'DELETE', key: KEY })).status, 200);
    assert.equal((await call(`/api/items/${id}`)).status, 404);
  });

  await t.test('CORS only for allowed websites; unknown APIs are 404', async () => {
    const ok = await call('/api/items', { headers: { origin: 'https://shop.example' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://shop.example');
    const other = await call('/api/items', { headers: { origin: 'https://evil.example' } });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    assert.equal((await call('/api/nope')).status, 404);
  });
  await t.test('a saved change is live within seconds and /health reports its revision', async () => {
    const h = await (await call('/health')).json();
    assert.ok(h.engine >= 4, 'engine version in /health');
    const next = { ...config, revision: 'rev-2', apis: { ...config.apis, notes: { title: 'Notes', collection: 'notes', ops: { list: 'public', get: 'public', count: 'public', create: 'off', update: 'off', delete: 'off' } } } };
    fs.writeFileSync(path.join(dir, 'api.config.json'), JSON.stringify(next));
    let live;
    for (let i = 0; i < 40 && !live; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const x = await (await call('/health')).json();
      if (x.revision === 'rev-2') live = x;
    }
    assert.ok(live, 'the engine reloaded the new settings within 4 seconds');
    assert.ok(live.apis.includes('notes'));
    assert.equal((await call('/api/notes')).status, 200);
  });
});
