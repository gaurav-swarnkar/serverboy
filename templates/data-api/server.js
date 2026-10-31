// Serverboy Data API: REST APIs for MongoDB collections.
// Everything is configured in api.config.json (edited from Serverboy); changes apply within
// a couple of seconds without a restart. Environment: MONGODB_URI, PORT, SB_CONSOLE_KEY.
//
// Each entry in config.apis is one API, served at /api/<slug>. Several APIs can use the same
// collection with different rules (who may do what, which documents, which fields).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { MongoClient, ObjectId, BSON } = require('mongodb');

const ENGINE_VERSION = 3;
const CONFIG_FILE = path.join(__dirname, 'api.config.json');
// What a key needs for each operation.
const OPERATIONS = { list: 'read', count: 'read', get: 'read', create: 'create', update: 'update', delete: 'delete' };
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

// The key's permissions for one API: a set of read / create / update / delete.
function keyAccess(key, slug) {
  if (!key) return null;
  if (process.env.SB_CONSOLE_KEY && key.length === process.env.SB_CONSOLE_KEY.length &&
      crypto.timingSafeEqual(Buffer.from(key), Buffer.from(process.env.SB_CONSOLE_KEY))) {
    return { label: 'serverboy-console', ops: new Set(['read', 'create', 'update', 'delete']) };
  }
  const hash = sha256(key);
  const k = (config.keys || []).find((x) => x.hash === hash);
  if (!k) return null;
  const ops = k.access?.[slug] || k.access?.['*'] || [];
  return { label: k.label, ops: new Set(ops) };
}

// Old addresses (engine v1/v2) keep working: /api/<collection> and /api/<collection>/views/<name>.
function resolve(slug) {
  const apis = config.apis || {};
  if (apis[slug]) return slug;
  const alias = config.legacy?.[slug];
  return typeof alias === 'string' && apis[alias] ? alias : null;
}

// Checks that the API exists, that the operation is on, and that the caller may use it.
function guard(op) {
  return (req, res, next) => {
    const slug = resolve(req.params.api);
    if (!slug) throw new ApiError(404, `There is no API called "${req.params.api}"`);
    const api = config.apis[slug];
    const mode = api.ops?.[op] || 'off';
    if (mode === 'off') throw new ApiError(404, `"${slug}" does not allow this (${op} is turned off)`);
    const key = keyFromRequest(req);
    const access = keyAccess(key, slug);
    if (key && !access) throw new ApiError(401, 'Invalid API key');
    if (mode === 'key') {
      if (!access) throw new ApiError(401, 'This needs an API key (send it in the x-api-key header)');
      if (!access.ops.has(OPERATIONS[op])) throw new ApiError(403, `This API key may not ${OPERATIONS[op]} in "${slug}"`);
    }
    req.api = api;
    req.slug = slug;
    req.keyLabel = access?.label || 'public';
    next();
  };
}

function idFilter(id) {
  return /^[0-9a-f]{24}$/i.test(id) ? { _id: new ObjectId(id) } : { _id: id };
}

function startsWithField(key, fields) {
  return fields.some((f) => key === f || key.startsWith(`${f}.`));
}

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof ObjectId) && !(v instanceof Date);

// Reject JavaScript operators anywhere in a filter, and filtering on hidden fields.
function checkFilter(value, hidden, depth = 0) {
  if (depth > 20) throw new ApiError(400, 'Filter is nested too deeply');
  if (Array.isArray(value)) return value.forEach((v) => checkFilter(v, hidden, depth + 1));
  if (isPlain(value)) {
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

// The API's own filter ("only these documents"), with each "{{param}}" value replaced by the
// caller's typed value. A placeholder only ever becomes a value, never an operator or a field
// name. A missing optional parameter without a default removes the condition it is in.
function apiFilter(api, query) {
  const values = {};
  for (const p of api.params || []) {
    const raw = query[p.name] ?? (p.default !== undefined && p.default !== '' ? p.default : undefined);
    if (raw === undefined || Array.isArray(raw) || typeof raw === 'object') {
      if (p.required) throw new ApiError(400, `Missing parameter "${p.name}"`);
      continue;
    }
    values[p.name] = typedParam(p, raw);
  }
  const empty = (v) => v === undefined || (isPlain(v) && !Object.keys(v).length) || (Array.isArray(v) && !v.length);
  const fill = (v) => {
    if (typeof v === 'string') {
      const m = v.match(/^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$/);
      if (!m) return v;
      return m[1] in values ? values[m[1]] : undefined;
    }
    if (Array.isArray(v)) return v.map(fill).filter((x) => !empty(x));
    if (isPlain(v)) {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        const f = fill(x);
        if (empty(f) && !empty(x)) continue; // the condition lost all of its values
        out[k] = f;
      }
      return out;
    }
    return v;
  };
  return fill(BSON.EJSON.deserialize(api.filter || {}, { relaxed: true }));
}

// Everything that limits which documents a request sees: the API's filter plus, for lists and
// counts, the caller's own ?filter= / ?field=value (if the API allows it).
function buildFilter(req, { callerFilters }) {
  const api = req.api;
  const hidden = api.hidden || [];
  const parts = [];
  const own = apiFilter(api, req.query);
  if (Object.keys(own).length) parts.push(own);
  if (callerFilters && api.callerFilters !== false) {
    const f = req.query.filter ? parseJsonParam(String(req.query.filter), 'filter') : {};
    if (!isPlain(f)) throw new ApiError(400, '"filter" must be a JSON object');
    const paramNames = new Set((api.params || []).map((p) => p.name));
    for (const [k, v] of Object.entries(req.query)) {
      if (!RESERVED_PARAMS.has(k) && !paramNames.has(k) && typeof v === 'string') f[k] = v;
    }
    checkFilter(f, hidden);
    if (Object.keys(f).length) parts.push(f);
  }
  checkFilter(own, []);
  return parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { $and: parts };
}

function projection(req) {
  const api = req.api;
  const hidden = api.hidden || [];
  const allowed = String(api.fields || '').split(',').map((f) => f.trim()).filter(Boolean);
  let wanted = String(req.query.fields || '').split(',').map((f) => f.trim()).filter(Boolean);
  if (allowed.length) wanted = wanted.length ? wanted.filter((f) => allowed.includes(f)) : allowed;
  wanted = wanted.filter((f) => !startsWithField(f, hidden));
  if (wanted.length) return Object.fromEntries(wanted.map((f) => [f, 1]));
  if (allowed.length) return { _id: 1 };
  return hidden.length ? Object.fromEntries(hidden.map((f) => [f, 0])) : undefined;
}

function sortSpec(text) {
  const spec = {};
  for (const part of String(text || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    spec[part.replace(/^-/, '')] = part.startsWith('-') ? -1 : 1;
  }
  return Object.keys(spec).length ? spec : { _id: -1 };
}

function shape(doc, req) {
  if (!doc) return doc;
  const p = projection(req);
  const out = { ...doc };
  if (p && Object.values(p).some((v) => v === 1)) {
    for (const k of Object.keys(out)) if (k !== '_id' && !p[k]) delete out[k];
  } else for (const f of req.api.hidden || []) delete out[f];
  return out;
}

// What a caller may write: accepted fields only, no read-only fields, fixed values on top.
function writable(body, api, { creating }) {
  if (!isPlain(body)) throw new ApiError(400, 'Send a JSON object in the request body');
  const accepted = api.writable || [];
  let doc = { ...body };
  delete doc._id;
  if (accepted.length) doc = Object.fromEntries(Object.entries(doc).filter(([k]) => accepted.includes(k)));
  for (const f of api.readonly || []) delete doc[f];
  checkFilter(doc, []); // no $where & co. smuggled into documents
  for (const k of Object.keys(doc)) if (k.startsWith('$')) throw new ApiError(400, `Field names cannot start with $ ("${k}")`);
  const fixed = BSON.EJSON.deserialize(api.set || {}, { relaxed: true });
  Object.assign(doc, fixed);
  if (api.timestamps) {
    delete doc.createdAt;
    doc.updatedAt = new Date();
    if (creating) doc.createdAt = doc.updatedAt;
  }
  if (creating) {
    const missing = (api.required || []).filter((f) => doc[f] === undefined || doc[f] === null || doc[f] === '');
    if (missing.length) throw new ApiError(400, `Missing required field(s): ${missing.join(', ')}`);
  }
  return doc;
}

const coll = (req) => db().collection(req.api.collection);
const pageLimit = (req) => {
  const max = Math.min(Number(req.api.limit) || Number(config.maxLimit) || 100, Number(config.maxLimit) || 100);
  return Math.min(Math.max(Number(req.query.limit) || Math.min(20, max), 1), max);
};

// ---------- operations ----------

async function list(req) {
  const limit = pageLimit(req);
  const skip = Math.max(Number(req.query.skip) || 0, 0) || (Math.max(Number(req.query.page) || 1, 1) - 1) * limit;
  const filter = buildFilter(req, { callerFilters: true });
  const sort = req.query.sort && req.api.callerSort !== false ? sortSpec(req.query.sort) : sortSpec(req.api.sort);
  const [data, total] = await Promise.all([
    coll(req).find(filter, { projection: projection(req) }).sort(sort).skip(skip).limit(limit).toArray(),
    coll(req).countDocuments(filter),
  ]);
  return { data, total, limit, skip };
}

// A document by id, but only if it is one this API may see.
function byId(req) {
  const own = buildFilter(req, { callerFilters: false });
  const id = idFilter(req.params.id);
  return Object.keys(own).length ? { $and: [id, own] } : id;
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
  res.json({ ok: true, engine: ENGINE_VERSION, database: config.database, apis: Object.keys(config.apis || {}) });
});

app.use('/api', rateLimit);

// Old v2 "custom endpoint" addresses: /api/<collection>/views/<name>.
app.all('/api/:collection/views/:name', (req, res, next) => {
  const alias = config.legacy?.[`${req.params.collection}/views/${req.params.name}`];
  if (!alias || !config.apis?.[alias.api]) throw new ApiError(404, 'Not found');
  req.params.api = alias.api;
  const op = req.method === 'POST' ? 'create' : alias.kind === 'count' ? 'count' : 'list';
  guard(op)(req, res, async () => {
    try {
      if (op === 'create') {
        const doc = writable(req.body, req.api, { creating: true });
        const r = await coll(req).insertOne(doc);
        return res.status(201).json(shape({ _id: r.insertedId, ...doc }, req));
      }
      if (op === 'count') return res.json({ count: await coll(req).countDocuments(buildFilter(req, { callerFilters: true })) });
      const r = await list(req);
      if (alias.kind === 'one') {
        if (!r.data.length) throw new ApiError(404, 'Not found');
        return res.json(r.data[0]);
      }
      res.json(r);
    } catch (err) {
      next(err);
    }
  });
});

app.get('/api/:api', guard('list'), async (req, res) => {
  res.json(await list(req));
});

app.get('/api/:api/count', guard('count'), async (req, res) => {
  res.json({ count: await coll(req).countDocuments(buildFilter(req, { callerFilters: true })) });
});

app.get('/api/:api/:id', guard('get'), async (req, res) => {
  const doc = await coll(req).findOne(byId(req), { projection: projection(req) });
  if (!doc) throw new ApiError(404, 'Not found');
  res.json(doc);
});

app.post('/api/:api', guard('create'), async (req, res) => {
  const doc = writable(req.body, req.api, { creating: true });
  const r = await coll(req).insertOne(doc);
  res.status(201).json(shape({ _id: r.insertedId, ...doc }, req));
});

app.patch('/api/:api/:id', guard('update'), async (req, res) => {
  const changes = writable(req.body, req.api, { creating: false });
  if (!Object.keys(changes).length) throw new ApiError(400, 'Nothing to update');
  const doc = await coll(req).findOneAndUpdate(byId(req), { $set: changes }, { returnDocument: 'after', projection: projection(req) });
  if (!doc) throw new ApiError(404, 'Not found');
  res.json(doc);
});

// Replace a whole document; read-only fields and the creation time are kept.
app.put('/api/:api/:id', guard('update'), async (req, res) => {
  const existing = await coll(req).findOne(byId(req));
  if (!existing) throw new ApiError(404, 'Not found');
  const doc = writable(req.body, req.api, { creating: true });
  for (const f of [...(req.api.readonly || []), ...(req.api.timestamps ? ['createdAt'] : [])]) {
    if (existing[f] !== undefined) doc[f] = existing[f];
  }
  await coll(req).replaceOne({ _id: existing._id }, doc);
  res.json(shape({ _id: existing._id, ...doc }, req));
});

app.delete('/api/:api/:id', guard('delete'), async (req, res) => {
  const r = await coll(req).deleteOne(byId(req));
  if (!r.deletedCount) throw new ApiError(404, 'Not found');
  res.json({ deleted: true });
});

app.use((req, res) => res.status(404).json({ error: `Not found. APIs: ${Object.keys(config.apis || {}).map((s) => `/api/${s}`).join(', ') || 'none yet'}` }));

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
