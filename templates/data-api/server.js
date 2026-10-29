// Serverboy Data API: a REST API for MongoDB collections.
// Everything is configured in api.config.json (edited from Serverboy); changes apply within
// a couple of seconds without a restart. Environment: MONGODB_URI, PORT, SB_CONSOLE_KEY.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { MongoClient, ObjectId, BSON } = require('mongodb');

const ENGINE_VERSION = 2;
const CONFIG_FILE = path.join(__dirname, 'api.config.json');
const OPERATIONS = {
  list: 'read',
  count: 'read',
  get: 'read',
  create: 'create',
  update: 'update',
  replace: 'update',
  delete: 'delete',
};
// Query operators that run JavaScript on the database server.
const FORBIDDEN_OPERATORS = new Set(['$where', '$function', '$accumulator']);
const RESERVED_PARAMS = new Set(['limit', 'skip', 'sort', 'fields', 'filter', 'page']);

// ---------- configuration ----------

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

let config = readConfig();
fs.watchFile(CONFIG_FILE, { interval: 2000 }, () => {
  try {
    config = readConfig();
    console.log('Configuration reloaded');
  } catch (err) {
    console.error(`api.config.json is invalid, keeping the previous configuration: ${err.message}`);
  }
});

// ---------- database ----------

const client = new MongoClient(process.env.MONGODB_URI, { appName: 'serverboy-data-api' });
const db = () => client.db(config.database);

// ---------- helpers ----------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function keyFromRequest(req) {
  const header = req.get('x-api-key');
  if (header) return header.trim();
  const auth = req.get('authorization') || '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
}

// The key's permissions for one collection: a set of read / create / update / delete.
function keyAccess(key, collection) {
  if (!key) return null;
  if (process.env.SB_CONSOLE_KEY && key.length === process.env.SB_CONSOLE_KEY.length &&
      crypto.timingSafeEqual(Buffer.from(key), Buffer.from(process.env.SB_CONSOLE_KEY))) {
    return { label: 'serverboy-console', ops: new Set(['read', 'create', 'update', 'delete']) };
  }
  const hash = sha256(key);
  const k = (config.keys || []).find((x) => x.hash === hash);
  if (!k) return null;
  const ops = k.access?.[collection] || k.access?.['*'] || [];
  return { label: k.label, ops: new Set(ops) };
}

function collectionConfig(name) {
  const c = config.collections?.[name];
  if (!c) throw new ApiError(404, `Unknown collection "${name}"`);
  return c;
}

// Checks that the endpoint is on, and that the caller may use it.
function guard(op) {
  return (req, res, next) => {
    const c = collectionConfig(req.params.collection);
    const mode = c.endpoints?.[op] || 'off';
    if (mode === 'off') throw new ApiError(404, `This endpoint is turned off for "${req.params.collection}"`);
    const key = keyFromRequest(req);
    const access = keyAccess(key, req.params.collection);
    if (key && !access) throw new ApiError(401, 'Invalid API key');
    if (mode === 'key') {
      if (!access) throw new ApiError(401, 'This endpoint needs an API key (x-api-key header)');
      if (!access.ops.has(OPERATIONS[op])) throw new ApiError(403, `This API key may not ${OPERATIONS[op]} "${req.params.collection}"`);
    }
    req.col = c;
    req.keyLabel = access?.label || 'public';
    next();
  };
}

// Custom endpoints: saved queries / forms defined per collection (config.collections[c].custom).
const CUSTOM_OPS = { list: 'read', count: 'read', one: 'read', create: 'create' };

function customGuard(method) {
  return (req, res, next) => {
    const c = collectionConfig(req.params.collection);
    const ep = (c.custom || []).find((x) => x.id === req.params.name);
    const kindMethod = ep && (ep.kind === 'create' ? 'POST' : 'GET');
    if (!ep || kindMethod !== method || (ep.mode || 'off') === 'off') throw new ApiError(404, `No endpoint "${req.params.name}" for "${req.params.collection}"`);
    const key = keyFromRequest(req);
    const access = keyAccess(key, req.params.collection);
    if (key && !access) throw new ApiError(401, 'Invalid API key');
    if (ep.mode === 'key') {
      if (!access) throw new ApiError(401, 'This endpoint needs an API key (x-api-key header)');
      if (!access.ops.has(CUSTOM_OPS[ep.kind])) throw new ApiError(403, `This API key may not ${CUSTOM_OPS[ep.kind]} "${req.params.collection}"`);
    }
    req.col = c;
    req.ep = ep;
    req.keyLabel = access?.label || 'public';
    next();
  };
}

function typedParam(p, raw) {
  const v = String(raw);
  switch (p.type) {
    case 'number': {
      const n = Number(v);
      if (v.trim() === '' || !Number.isFinite(n)) throw new ApiError(400, `"${p.name}" must be a number`);
      return n;
    }
    case 'boolean':
      if (!['true', 'false', '1', '0'].includes(v)) throw new ApiError(400, `"${p.name}" must be true or false`);
      return v === 'true' || v === '1';
    case 'date': {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new ApiError(400, `"${p.name}" must be a date like 2025-01-31`);
      return d;
    }
    case 'objectId':
      if (!/^[0-9a-f]{24}$/i.test(v)) throw new ApiError(400, `"${p.name}" must be a 24-character id`);
      return new ObjectId(v);
    default:
      if (v.length > 1000) throw new ApiError(400, `"${p.name}" is too long`);
      return v;
  }
}

// The endpoint's filter with each "{{param}}" value replaced by the caller's (typed) value.
// A placeholder only ever becomes a value, never an operator or a field name. A missing
// optional parameter without a default removes the condition it is in.
function customFilter(ep, query) {
  const values = {};
  for (const p of ep.params || []) {
    const raw = query[p.name] ?? (p.default !== undefined && p.default !== '' ? p.default : undefined);
    if (raw === undefined || Array.isArray(raw) || typeof raw === 'object') {
      if (p.required) throw new ApiError(400, `Missing parameter "${p.name}"`);
      continue;
    }
    values[p.name] = typedParam(p, raw);
  }
  const plain = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof ObjectId) && !(v instanceof Date);
  const empty = (v) => v === undefined || (plain(v) && !Object.keys(v).length) || (Array.isArray(v) && !v.length);
  const fill = (v) => {
    if (typeof v === 'string') {
      const m = v.match(/^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$/);
      if (!m) return v;
      return m[1] in values ? values[m[1]] : undefined;
    }
    if (Array.isArray(v)) {
      // {"$in": ["{{a}}", "{{b}}"]} keeps the values given; {"$and": [{...}]} drops emptied conditions
      return v.map(fill).filter((x) => !empty(x));
    }
    if (plain(v)) {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        const f = fill(x);
        // Drop a condition that lost all of its values (e.g. {"price": {"$gte": "{{min}}"}} without min).
        if (empty(f) && !empty(x)) continue;
        out[k] = f;
      }
      return out;
    }
    return v;
  };
  const template = BSON.EJSON.deserialize(ep.filter || {}, { relaxed: true });
  return fill(template);
}

function customProjection(req) {
  const hidden = req.col.hidden || [];
  const fields = String(req.ep.fields || '').split(',').map((f) => f.trim()).filter(Boolean).filter((f) => !startsWithField(f, hidden));
  if (fields.length) return Object.fromEntries(fields.map((f) => [f, 1]));
  return hidden.length ? Object.fromEntries(hidden.map((f) => [f, 0])) : undefined;
}

function idFilter(id) {
  return /^[0-9a-f]{24}$/i.test(id) ? { _id: new ObjectId(id) } : { _id: id };
}

function startsWithField(key, fields) {
  return fields.some((f) => key === f || key.startsWith(`${f}.`));
}

// Reject JavaScript operators anywhere in a filter, and filtering on hidden fields.
function checkFilter(value, hidden, depth = 0) {
  if (depth > 20) throw new ApiError(400, 'Filter is nested too deeply');
  if (Array.isArray(value)) return value.forEach((v) => checkFilter(v, hidden, depth + 1));
  if (value && typeof value === 'object' && !(value instanceof ObjectId) && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_OPERATORS.has(k)) throw new ApiError(400, `The ${k} operator is not allowed`);
      if (!k.startsWith('$') && startsWithField(k, hidden)) throw new ApiError(400, `Cannot filter on the hidden field "${k}"`);
      checkFilter(v, hidden, depth + 1);
    }
  }
}

function parseJsonParam(text, name) {
  try {
    return BSON.EJSON.parse(text, { relaxed: true });
  } catch {
    throw new ApiError(400, `"${name}" must be valid JSON`);
  }
}

function buildFilter(req) {
  const hidden = req.col.hidden || [];
  const filter = req.query.filter ? parseJsonParam(String(req.query.filter), 'filter') : {};
  if (typeof filter !== 'object' || Array.isArray(filter)) throw new ApiError(400, '"filter" must be a JSON object');
  // Simple equality filters: ?status=active&category=shoes
  for (const [k, v] of Object.entries(req.query)) {
    if (!RESERVED_PARAMS.has(k) && typeof v === 'string') filter[k] = v;
  }
  checkFilter(filter, hidden);
  return filter;
}

function projection(req) {
  const hidden = req.col.hidden || [];
  const fields = String(req.query.fields || '').split(',').map((f) => f.trim()).filter(Boolean);
  if (fields.length) {
    const p = {};
    for (const f of fields) if (!startsWithField(f, hidden)) p[f] = 1;
    return Object.keys(p).length ? p : { _id: 1 };
  }
  return hidden.length ? Object.fromEntries(hidden.map((f) => [f, 0])) : undefined;
}

function sortSpec(text) {
  const spec = {};
  for (const part of String(text || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    spec[part.replace(/^-/, '')] = part.startsWith('-') ? -1 : 1;
  }
  return Object.keys(spec).length ? spec : { _id: -1 };
}

function stripHidden(doc, hidden) {
  if (!doc) return doc;
  const out = { ...doc };
  for (const f of hidden || []) delete out[f];
  return out;
}

// Remove fields the client may not write, and add timestamps.
function writable(body, c, { creating }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Send a JSON object in the request body');
  const doc = { ...body };
  delete doc._id;
  for (const f of c.readonly || []) delete doc[f];
  if (c.timestamps) {
    delete doc.createdAt;
    delete doc.updatedAt;
    doc.updatedAt = new Date();
    if (creating) doc.createdAt = doc.updatedAt;
  }
  checkFilter(doc, []); // no $where & co. smuggled into documents
  if (creating) {
    const missing = (c.required || []).filter((f) => doc[f] === undefined || doc[f] === null || doc[f] === '');
    if (missing.length) throw new ApiError(400, `Missing required field(s): ${missing.join(', ')}`);
  }
  return doc;
}

// ---------- rate limiting ----------

const hits = new Map();
setInterval(() => hits.clear(), 60 * 1000).unref();

function rateLimit(req, res, next) {
  const limit = Number(config.rateLimitPerMinute) || 0;
  if (!limit) return next();
  const who = keyFromRequest(req) ? sha256(keyFromRequest(req)) : req.ip;
  const n = (hits.get(who) || 0) + 1;
  hits.set(who, n);
  res.set('X-RateLimit-Limit', String(limit));
  res.set('X-RateLimit-Remaining', String(Math.max(0, limit - n)));
  if (n > limit) throw new ApiError(429, 'Too many requests, slow down');
  next();
}

// ---------- app ----------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => console.log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - started}ms ${req.keyLabel || ''}`));
  next();
});

// CORS: which websites may call this API from the browser.
app.use((req, res, next) => {
  const origin = req.get('origin');
  const allowed = config.cors || [];
  if (origin && (allowed.includes('*') || allowed.includes(origin))) {
    res.set('Access-Control-Allow-Origin', allowed.includes('*') ? '*' : origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    res.set('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', async (req, res) => {
  await db().command({ ping: 1 });
  res.json({ ok: true, engine: ENGINE_VERSION, database: config.database, collections: Object.keys(config.collections || {}) });
});

app.use('/api', rateLimit);

app.get('/api/:collection', guard('list'), async (req, res) => {
  const max = Number(config.maxLimit) || 100;
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), max);
  const skip = Math.max(Number(req.query.skip) || 0, 0) || (Math.max(Number(req.query.page) || 1, 1) - 1) * limit;
  const filter = buildFilter(req);
  const coll = db().collection(req.params.collection);
  const [data, total] = await Promise.all([
    coll.find(filter, { projection: projection(req) }).sort(sortSpec(req.query.sort)).skip(skip).limit(limit).toArray(),
    coll.countDocuments(filter),
  ]);
  res.json({ data, total, limit, skip });
});

app.get('/api/:collection/views/:name', customGuard('GET'), async (req, res) => {
  const ep = req.ep;
  const filter = customFilter(ep, req.query);
  checkFilter(filter, req.col.hidden || []);
  const coll = db().collection(req.params.collection);
  if (ep.kind === 'count') return res.json({ count: await coll.countDocuments(filter) });
  const sort = sortSpec(ep.sort);
  if (ep.kind === 'one') {
    const doc = await coll.find(filter, { projection: customProjection(req) }).sort(sort).limit(1).next();
    if (!doc) throw new ApiError(404, 'Not found');
    return res.json(doc);
  }
  const max = Math.min(Number(ep.limit) || Number(config.maxLimit) || 100, Number(config.maxLimit) || 100);
  const limit = Math.min(Math.max(Number(req.query.limit) || max, 1), max);
  const skip = Math.max(Number(req.query.skip) || 0, 0) || (Math.max(Number(req.query.page) || 1, 1) - 1) * limit;
  const [data, total] = await Promise.all([
    coll.find(filter, { projection: customProjection(req) }).sort(sort).skip(skip).limit(limit).toArray(),
    coll.countDocuments(filter),
  ]);
  res.json({ data, total, limit, skip });
});

app.post('/api/:collection/views/:name', customGuard('POST'), async (req, res) => {
  const ep = req.ep;
  const allowed = String(ep.fields || '').split(',').map((f) => f.trim()).filter(Boolean);
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!body) throw new ApiError(400, 'Send a JSON object in the request body');
  const input = allowed.length ? Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k))) : body;
  const fixed = BSON.EJSON.deserialize(ep.set || {}, { relaxed: true });
  const doc = writable({ ...input, ...fixed }, { ...req.col, required: [...new Set([...(req.col.required || []), ...(ep.required || [])])] }, { creating: true });
  Object.assign(doc, fixed); // fixed values win, even on read-only fields
  const r = await db().collection(req.params.collection).insertOne(doc);
  res.status(201).json(stripHidden({ _id: r.insertedId, ...doc }, req.col.hidden));
});

app.get('/api/:collection/count', guard('count'), async (req, res) => {
  res.json({ count: await db().collection(req.params.collection).countDocuments(buildFilter(req)) });
});

app.get('/api/:collection/:id', guard('get'), async (req, res) => {
  const doc = await db().collection(req.params.collection).findOne(idFilter(req.params.id), { projection: projection(req) });
  if (!doc) throw new ApiError(404, 'Not found');
  res.json(doc);
});

app.post('/api/:collection', guard('create'), async (req, res) => {
  const doc = writable(req.body, req.col, { creating: true });
  const r = await db().collection(req.params.collection).insertOne(doc);
  res.status(201).json(stripHidden({ _id: r.insertedId, ...doc }, req.col.hidden));
});

app.patch('/api/:collection/:id', guard('update'), async (req, res) => {
  const changes = writable(req.body, req.col, { creating: false });
  if (!Object.keys(changes).length) throw new ApiError(400, 'Nothing to update');
  const doc = await db()
    .collection(req.params.collection)
    .findOneAndUpdate(idFilter(req.params.id), { $set: changes }, { returnDocument: 'after', projection: projection(req) });
  if (!doc) throw new ApiError(404, 'Not found');
  res.json(doc);
});

app.put('/api/:collection/:id', guard('replace'), async (req, res) => {
  const coll = db().collection(req.params.collection);
  const existing = await coll.findOne(idFilter(req.params.id));
  if (!existing) throw new ApiError(404, 'Not found');
  const doc = writable(req.body, req.col, { creating: true });
  // Read-only fields (and the original creation time) survive a replace.
  for (const f of [...(req.col.readonly || []), ...(req.col.timestamps ? ['createdAt'] : [])]) {
    if (existing[f] !== undefined) doc[f] = existing[f];
  }
  await coll.replaceOne({ _id: existing._id }, doc);
  res.json(stripHidden({ _id: existing._id, ...doc }, req.col.hidden));
});

app.delete('/api/:collection/:id', guard('delete'), async (req, res) => {
  const r = await db().collection(req.params.collection).deleteOne(idFilter(req.params.id));
  if (!r.deletedCount) throw new ApiError(404, 'Not found');
  res.json({ deleted: true });
});

app.use((req, res) => res.status(404).json({ error: 'Not found. Endpoints are under /api/<collection>' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON' });
  const status = err.status || (err.code === 11000 ? 409 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && !err.status ? 'Server error' : err.code === 11000 ? 'Duplicate value for a unique field' : err.message });
});

client
  .connect()
  .then(() => {
    const port = Number(process.env.PORT) || 4100;
    app.listen(port, '127.0.0.1', () => console.log(`Data API "${config.name}" (database ${config.database}) on 127.0.0.1:${port}`));
  })
  .catch((err) => {
    console.error(`Cannot connect to MongoDB: ${err.message}`);
    process.exit(1);
  });
