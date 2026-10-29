// Data APIs: REST APIs for MongoDB collections. Each API is its own small Node.js service
// (templates/data-api) deployed in /var/www/<name> and run by PM2. Its settings live on the
// server in api.config.json, which the service reloads by itself when Serverboy changes it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const ssh = require('../lib/ssh');
const jobs = require('../lib/jobs');
const nginx = require('../lib/nginx');
const team = require('../lib/team');
const { mongosh } = require('../lib/mongosh');
const { buildSteps, readRemote } = require('./nodeapps');
const catalog = require('../lib/catalog');
const { can } = require('../lib/permissions');
const scope = require('../lib/scope');

const { q, HttpError } = ssh;
const router = express.Router({ mergeParams: true });

const TEMPLATE_DIR = path.join(__dirname, '..', 'templates', 'data-api');
const ENGINE_FILES = ['server.js', 'package.json'];
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const DB_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COLL_RE = /^[A-Za-z0-9_.-]{1,120}$/;
const FIELD_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const ENDPOINTS = ['list', 'count', 'get', 'create', 'update', 'replace', 'delete'];
const MODES = ['off', 'public', 'key'];
const OPS = ['read', 'create', 'update', 'delete'];
const ENGINE_VERSION = Number((fs.readFileSync(path.join(TEMPLATE_DIR, 'server.js'), 'utf8').match(/ENGINE_VERSION = (\d+)/) || [])[1]) || 1;
const CUSTOM_KINDS = ['list', 'count', 'one', 'create'];
const PARAM_TYPES = ['string', 'number', 'boolean', 'date', 'objectId'];
const CUSTOM_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const RESERVED_PARAMS = ['limit', 'skip', 'page', 'sort', 'fields', 'filter'];
const FORBIDDEN_OPERATORS = ['$where', '$function', '$accumulator'];

const dir = (name) => `/var/www/${name}`;
const configPath = (name) => `${dir(name)}/api.config.json`;

function apiName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!NAME_RE.test(n)) throw new HttpError(400, 'API name: lowercase letters, numbers, - and _ (e.g. shop-api)');
  return n;
}

async function loadConfig(serverId, name) {
  const text = await readRemote(serverId, configPath(apiName(name)));
  if (!text) throw new HttpError(404, `No API named "${name}" on this server`);
  return JSON.parse(text);
}

async function saveConfig(serverId, name, cfg) {
  await ssh.writeFile(serverId, configPath(name), `${JSON.stringify(cfg, null, 2)}\n`, { sudo: false });
}

function publicConfig(cfg) {
  return { ...cfg, keys: (cfg.keys || []).map(({ hash, ...k }) => k) };
}

async function freePort(serverId) {
  const r = await ssh.exec(serverId, `ss -ltnH 2>/dev/null | awk '{print $4}' | sed 's/.*://'; cat /var/www/*/.serverboy-app.json 2>/dev/null | grep -o '"port": *[0-9]*' | grep -o '[0-9]*$'`);
  const used = new Set(r.stdout.split('\n').map((x) => x.trim()).filter(Boolean));
  for (let p = 4100; p < 5000; p++) if (!used.has(String(p))) return p;
  throw new HttpError(500, 'No free port found between 4100 and 4999');
}

function audit(req, action) {
  team.audit({ user: req.user.username, ip: req.ip, action, server: undefined });
}

// An API belongs to one database, so it follows that database's access (lib/scope.js):
// view to see it, edit to change it.
router.use('/mongo/apis/:name', async (req, res, next) => {
  if (scope.isAll(req.user, 'databases')) return next();
  const cfg = await loadConfig(req.params.id, req.params.name);
  // A test request sent as "the public" (no key) can only do what anyone on the internet can.
  const publicTest = req.method === 'POST' && req.path === '/test' && req.body?.auth !== 'console' && req.body?.auth !== 'key';
  scope.requireDb(req, 'mongo', cfg.database, req.method === 'GET' || publicTest ? 'view' : 'edit');
  next();
});

// ---------- list / details ----------

router.get('/mongo/apis', async (req, res) => {
  const r = await ssh.exec(
    req.params.id,
    `for f in /var/www/*/api.config.json; do
  [ -f "$f" ] || continue
  d=$(dirname "$f")
  echo "##API $(basename "$d")"; cat "$f"; echo
  echo "##APP"; cat "$d/.serverboy-app.json" 2>/dev/null; echo
done
echo "##PM2"; command -v pm2 >/dev/null && pm2 jlist 2>/dev/null | tail -1; echo`,
  );
  const [apisPart, pm2Part] = r.stdout.split('##PM2');
  let pm2 = [];
  try {
    pm2 = JSON.parse((pm2Part || '').trim() || '[]');
  } catch {
    pm2 = [];
  }
  const apis = [];
  for (const chunk of apisPart.split('##API ').slice(1)) {
    const [head, appJson] = chunk.split('##APP');
    const nl = head.indexOf('\n');
    const name = head.slice(0, nl).trim();
    try {
      const cfg = JSON.parse(head.slice(nl + 1));
      const app = appJson && appJson.trim() ? JSON.parse(appJson) : {};
      const proc = pm2.find((p) => p.name === name);
      apis.push({
        name,
        database: cfg.database,
        port: app.port || null,
        domain: app.domain || null,
        status: proc ? proc.pm2_env?.status : 'not running',
        collections: Object.keys(cfg.collections || {}),
        keys: (cfg.keys || []).length,
      });
    } catch {
      apis.push({ name, broken: true });
    }
  }
  res.json(apis.filter((a) => a.broken ? scope.isAll(req.user, 'databases') : scope.canSeeDb(req.user, req.params.id, 'mongo', a.database)));
});

router.get('/mongo/apis/:name', async (req, res) => {
  const name = apiName(req.params.name);
  const cfg = await loadConfig(req.params.id, name);
  const app = JSON.parse((await readRemote(req.params.id, `${dir(name)}/.serverboy-app.json`)) || '{}');
  const r = await ssh.exec(
    req.params.id,
    `pm2 jlist 2>/dev/null | tail -1; echo; ${app.port ? `curl -s -m 3 http://127.0.0.1:${Number(app.port)}/health; ` : ''}echo; grep -l 'ssl_certificate' /etc/nginx/sites-enabled/${q(app.domain || 'none')} 2>/dev/null`,
  );
  const [jlist, healthLine, ...rest] = r.stdout.split('\n');
  let engine = null;
  try {
    engine = JSON.parse(healthLine).engine || null;
  } catch {
    /* not answering */
  }
  let status = 'not running';
  try {
    status = JSON.parse(jlist || '[]').find((p) => p.name === name)?.pm2_env?.status || 'not running';
  } catch {
    /* keep default */
  }
  const https = rest.join('').includes('/etc/nginx');
  res.json({
    ...publicConfig(cfg),
    port: app.port,
    domain: app.domain || null,
    url: app.domain ? `${https ? 'https' : 'http'}://${app.domain}` : null,
    status,
    engine,
    latestEngine: ENGINE_VERSION,
  });
});

// ---------- create ----------

router.post('/mongo/apis', async (req, res) => {
  const serverId = req.params.id;
  const name = apiName(req.body?.name);
  const domain = req.body?.domain ? nginx.validDomain(req.body.domain) : null;

  // Check everything first, so a missing requirement never leaves a half-made API behind.
  const pre = await ssh.exec(
    serverId,
    `command -v node >/dev/null && echo HAS_NODE; command -v npm >/dev/null && echo HAS_NPM; command -v pm2 >/dev/null && echo HAS_PM2
[ -e ${q(dir(name))} ] && echo DIR_EXISTS; [ -f ${q(configPath(name))} ] && echo HAS_CONFIG
command -v pm2 >/dev/null && pm2 jlist 2>/dev/null | grep -qF '"name":"${name}"' && echo IN_PM2`,
  );
  const has = (flag) => pre.stdout.includes(flag);
  // A folder with api.config.json but no PM2 process is an earlier attempt that did not finish:
  // resume it, keeping its collections and keys.
  const resume = has('HAS_CONFIG') && !has('IN_PM2');
  if (has('DIR_EXISTS') && !resume) {
    throw new HttpError(409, has('IN_PM2') ? `An API named "${name}" already exists.` : `${dir(name)} already exists and is not a Data API. Pick another name.`);
  }
  const previous = resume ? await loadConfig(serverId, name) : null;
  const database = previous?.database || String(req.body?.database || '').trim();
  if (!DB_RE.test(database)) throw new HttpError(400, 'Invalid database name');
  scope.requireDb(req, 'mongo', database, 'edit');

  const prereqSteps = [];
  if (!has('HAS_NODE') || !has('HAS_NPM') || !has('HAS_PM2')) {
    const missing = [!has('HAS_NODE') || !has('HAS_NPM') ? 'Node.js' : null, !has('HAS_PM2') ? 'PM2' : null].filter(Boolean).join(' and ');
    if (!can(req.user, 'system')) {
      throw new HttpError(400, `${missing} must be installed first (App Store). Ask the owner, or someone with the System permission.`);
    }
    if (!has('HAS_NODE') || !has('HAS_NPM')) prereqSteps.push({ label: 'Installing Node.js (needed by the API service)', cmd: catalog.find('nodejs').install, sudo: true });
    prereqSteps.push({ label: 'Installing PM2 (keeps the API running)', cmd: catalog.find('pm2').install, sudo: true });
  }

  const app = resume ? JSON.parse((await readRemote(serverId, `${dir(name)}/.serverboy-app.json`)) || '{}') : {};
  const port = app.port || (await freePort(serverId));
  const dbUser = `api_${name.replace(/-/g, '_')}`;
  const dbPassword = crypto.randomBytes(24).toString('base64url');
  const consoleKey = `sbc_${crypto.randomBytes(24).toString('base64url')}`;
  const mongoUri = `mongodb://${dbUser}:${dbPassword}@127.0.0.1:27017/${database}?authSource=${database}`;
  const config = previous || {
    name,
    database,
    cors: ['*'],
    rateLimitPerMinute: 300,
    maxLimit: 100,
    collections: {},
    keys: [],
  };
  const cfg = { name, repo: '', branch: 'main', port, installCmd: '', buildCmd: '', startCmd: 'node server.js', domain };
  const envText = `MONGODB_URI=${mongoUri}\nSB_CONSOLE_KEY=${consoleKey}\n`;
  const steps = buildSteps(serverId, cfg, { envText, fresh: true });
  steps.unshift(...prereqSteps);
  // Put the engine and its settings in place right after the folder is created.
  steps.splice(prereqSteps.length + 1, 0, {
    label: `Creating MongoDB user "${dbUser}" (read/write on ${database} only)`,
    fn: async (log) => {
      await mongosh(
        serverId,
        `const d = db.getSiblingDB(${JSON.stringify(database)});
const roles = [{ role: 'readWrite', db: ${JSON.stringify(database)} }];
if (d.getUser(${JSON.stringify(dbUser)})) d.updateUser(${JSON.stringify(dbUser)}, { pwd: ${JSON.stringify(dbPassword)}, roles });
else d.createUser({ user: ${JSON.stringify(dbUser)}, pwd: ${JSON.stringify(dbPassword)}, roles });
out({ ok: 1 });`,
      );
      log('Done.\n');
    },
  }, {
    label: 'Installing the Data API engine',
    fn: async (log) => {
      for (const f of ENGINE_FILES) await ssh.writeFile(serverId, `${dir(name)}/${f}`, fs.readFileSync(path.join(TEMPLATE_DIR, f)), { sudo: false });
      await saveConfig(serverId, name, config);
      log(`Engine and api.config.json written to ${dir(name)}\n`);
    },
  });
  if (domain) {
    steps.push({
      label: `Publishing on ${domain}`,
      fn: async (log) => {
        try {
          await nginx.createSite(serverId, { domain, type: 'proxy', port });
          log(`Nginx now forwards http://${domain} to the API.\n`);
        } catch (err) {
          if (err.status !== 409) throw err;
          log(`${domain} is already set up in Nginx.\n`);
        }
      },
    });
    if (req.body?.https) {
      steps.push({
        label: `Getting a free HTTPS certificate for ${domain}`,
        allowFail: true,
        sudo: true,
        cmd: `command -v certbot >/dev/null || { apt-get update -y && apt-get install -y certbot python3-certbot-nginx; }; certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email --redirect -d ${q(domain)}`,
      });
    }
  }
  steps.push({ label: 'Checking the API answers', cmd: `sleep 2; curl -s -m 10 http://127.0.0.1:${port}/health; echo` });
  audit(req, `${resume ? 'Finished setting up' : 'Created'} data API ${name} (database ${database})`);
  res.json(jobs.create(serverId, `${resume ? 'Finish setting up' : 'Create'} data API ${name}`, steps));
});

// ---------- collections ----------

function cleanFields(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(',');
  return [...new Set(arr.map((f) => String(f).trim()).filter(Boolean))].map((f) => {
    if (!FIELD_RE.test(f)) throw new HttpError(400, `Invalid field name "${f}"`);
    return f;
  });
}

router.put('/mongo/apis/:name/collections/:col', async (req, res) => {
  const name = apiName(req.params.name);
  const col = String(req.params.col);
  if (!COLL_RE.test(col)) throw new HttpError(400, 'Invalid collection name');
  const cfg = await loadConfig(req.params.id, name);
  const endpoints = {};
  for (const e of ENDPOINTS) {
    const m = req.body?.endpoints?.[e] || 'off';
    if (!MODES.includes(m)) throw new HttpError(400, `Endpoint ${e}: use off, public or key`);
    endpoints[e] = m;
  }
  cfg.collections = cfg.collections || {};
  cfg.collections[col] = {
    endpoints,
    hidden: cleanFields(req.body?.hidden),
    readonly: cleanFields(req.body?.readonly),
    required: cleanFields(req.body?.required),
    timestamps: Boolean(req.body?.timestamps),
    custom: cfg.collections[col]?.custom || [],
  };
  await saveConfig(req.params.id, name, cfg);
  audit(req, `Data API ${name}: saved ${col} (${ENDPOINTS.filter((e) => endpoints[e] !== 'off').map((e) => `${e}=${endpoints[e]}`).join(', ') || 'all off'})`);
  res.json(publicConfig(cfg));
});

// ---------- custom endpoints (saved queries and forms) ----------

function jsonObject(value, label) {
  let v = value;
  if (typeof v === 'string') {
    if (!v.trim()) return {};
    try {
      v = JSON.parse(v);
    } catch {
      throw new HttpError(400, `${label} must be valid JSON`);
    }
  }
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, `${label} must be a JSON object like { "status": "published" }`);
  const walk = (x, depth) => {
    if (depth > 20) throw new HttpError(400, `${label} is nested too deeply`);
    if (Array.isArray(x)) return x.forEach((y) => walk(y, depth + 1));
    if (x && typeof x === 'object') {
      for (const [k, y] of Object.entries(x)) {
        if (FORBIDDEN_OPERATORS.includes(k)) throw new HttpError(400, `The ${k} operator is not allowed`);
        walk(y, depth + 1);
      }
    }
  };
  walk(v, 0);
  if (JSON.stringify(v).length > 20000) throw new HttpError(400, `${label} is too large`);
  return v;
}

function cleanCustom(body, col) {
  const id = String(body?.id || '').trim().toLowerCase();
  if (!CUSTOM_ID_RE.test(id)) throw new HttpError(400, 'Path name: lowercase letters, numbers, - and _ (e.g. published)');
  const kind = CUSTOM_KINDS.includes(body?.kind) ? body.kind : 'list';
  const mode = MODES.includes(body?.mode) ? body.mode : 'off';
  const params = (Array.isArray(body?.params) ? body.params : []).map((p) => {
    const name = String(p?.name || '').trim();
    if (!PARAM_RE.test(name)) throw new HttpError(400, `Invalid parameter name "${name}"`);
    if (RESERVED_PARAMS.includes(name)) throw new HttpError(400, `"${name}" is reserved for paging; pick another parameter name`);
    return {
      name,
      type: PARAM_TYPES.includes(p.type) ? p.type : 'string',
      required: Boolean(p.required),
      default: p.default === undefined || p.default === null ? '' : String(p.default).slice(0, 200),
      description: String(p.description || '').slice(0, 300),
    };
  });
  if (new Set(params.map((p) => p.name)).size !== params.length) throw new HttpError(400, 'Two parameters have the same name');
  const filter = kind === 'create' ? {} : jsonObject(body?.filter, 'Filter');
  const used = [...JSON.stringify(filter).matchAll(/"\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}"/g)].map((m) => m[1]);
  const missing = used.filter((u) => !params.some((p) => p.name === u));
  if (missing.length) throw new HttpError(400, `The filter uses {{${missing[0]}}}; add it as a parameter`);
  const set = kind === 'create' ? jsonObject(body?.set, 'Fixed values') : {};
  if (Object.keys(set).some((k) => k === '_id' || k.startsWith('$'))) throw new HttpError(400, 'Fixed values cannot set _id or use $ operators');
  const sort = String(body?.sort || '').trim();
  if (sort && !sort.split(',').every((f) => FIELD_RE.test(f.trim().replace(/^-/, '')))) throw new HttpError(400, 'Sort: field names separated by commas, - for descending (e.g. -createdAt)');
  return {
    id,
    title: String(body?.title || id).trim().slice(0, 80),
    group: String(body?.group || '').trim().slice(0, 40),
    description: String(body?.description || '').trim().slice(0, 1000),
    kind,
    mode,
    filter,
    sort: kind === 'create' || kind === 'count' ? '' : sort,
    fields: cleanFields(body?.fields).join(','),
    limit: kind === 'list' ? Math.max(1, Math.min(Number(body?.limit) || 20, 1000)) : undefined,
    params: kind === 'create' ? [] : params,
    set,
    required: kind === 'create' ? cleanFields(body?.required) : [],
    collection: col,
  };
}

router.put('/mongo/apis/:name/collections/:col/custom/:cid', async (req, res) => {
  const name = apiName(req.params.name);
  const col = String(req.params.col);
  const cfg = await loadConfig(req.params.id, name);
  const c = cfg.collections?.[col];
  if (!c) throw new HttpError(404, `Expose ${col} first`);
  const ep = cleanCustom(req.body, col);
  delete ep.collection;
  const list = (c.custom || []).filter((x) => x.id !== req.params.cid);
  if (list.some((x) => x.id === ep.id)) throw new HttpError(409, `${col} already has an endpoint named "${ep.id}"`);
  const at = (c.custom || []).findIndex((x) => x.id === req.params.cid);
  list.splice(at < 0 ? list.length : at, 0, ep);
  c.custom = list;
  await saveConfig(req.params.id, name, cfg);
  audit(req, `Data API ${name}: saved custom endpoint ${col}/views/${ep.id} (${ep.kind}, ${ep.mode})`);
  res.json(publicConfig(cfg));
});

router.delete('/mongo/apis/:name/collections/:col/custom/:cid', async (req, res) => {
  const name = apiName(req.params.name);
  const cfg = await loadConfig(req.params.id, name);
  const c = cfg.collections?.[req.params.col];
  if (c) c.custom = (c.custom || []).filter((x) => x.id !== req.params.cid);
  await saveConfig(req.params.id, name, cfg);
  audit(req, `Data API ${name}: deleted custom endpoint ${req.params.col}/views/${req.params.cid}`);
  res.json(publicConfig(cfg));
});

router.delete('/mongo/apis/:name/collections/:col', async (req, res) => {
  const name = apiName(req.params.name);
  const cfg = await loadConfig(req.params.id, name);
  delete cfg.collections?.[req.params.col];
  await saveConfig(req.params.id, name, cfg);
  audit(req, `Data API ${name}: stopped exposing ${req.params.col}`);
  res.json(publicConfig(cfg));
});

// ---------- settings ----------

router.put('/mongo/apis/:name/settings', async (req, res) => {
  const name = apiName(req.params.name);
  const cfg = await loadConfig(req.params.id, name);
  const cors = String(req.body?.cors ?? '*')
    .split(/[\s,]+/)
    .map((x) => x.trim().replace(/\/$/, ''))
    .filter(Boolean);
  for (const o of cors) if (o !== '*' && !/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(o)) throw new HttpError(400, `"${o}" is not a website origin like https://example.com`);
  cfg.cors = cors;
  cfg.rateLimitPerMinute = Math.max(0, Math.min(Number(req.body?.rateLimitPerMinute) || 0, 100000));
  cfg.maxLimit = Math.max(1, Math.min(Number(req.body?.maxLimit) || 100, 1000));
  await saveConfig(req.params.id, name, cfg);
  audit(req, `Data API ${name}: updated settings`);
  res.json(publicConfig(cfg));
});

// ---------- API keys ----------

router.post('/mongo/apis/:name/keys', async (req, res) => {
  const name = apiName(req.params.name);
  const cfg = await loadConfig(req.params.id, name);
  const label = String(req.body?.label || '').trim().slice(0, 60);
  if (!label) throw new HttpError(400, 'Give the key a name, e.g. "website backend"');
  const access = {};
  for (const [col, ops] of Object.entries(req.body?.access || {})) {
    if (col !== '*' && !COLL_RE.test(col)) throw new HttpError(400, 'Invalid collection in access');
    const clean = (Array.isArray(ops) ? ops : []).filter((o) => OPS.includes(o));
    if (clean.length) access[col] = clean;
  }
  if (!Object.keys(access).length) throw new HttpError(400, 'Give the key at least one permission');
  const key = `sbk_${crypto.randomBytes(24).toString('base64url')}`;
  const entry = {
    id: crypto.randomBytes(6).toString('hex'),
    label,
    prefix: key.slice(0, 8),
    hash: crypto.createHash('sha256').update(key).digest('hex'),
    access,
    createdAt: new Date().toISOString(),
    createdBy: req.user.username,
  };
  cfg.keys = [...(cfg.keys || []), entry];
  await saveConfig(req.params.id, name, cfg);
  audit(req, `Data API ${name}: created key "${label}"`);
  const { hash, ...shown } = entry;
  res.json({ ...shown, key });
});

router.delete('/mongo/apis/:name/keys/:keyId', async (req, res) => {
  const name = apiName(req.params.name);
  const cfg = await loadConfig(req.params.id, name);
  const k = (cfg.keys || []).find((x) => x.id === req.params.keyId);
  if (!k) throw new HttpError(404, 'Key not found');
  cfg.keys = cfg.keys.filter((x) => x.id !== k.id);
  await saveConfig(req.params.id, name, cfg);
  audit(req, `Data API ${name}: revoked key "${k.label}"`);
  res.json({ ok: true });
});

// ---------- try it ----------

// Sends a request to the API from the server itself (it only listens on 127.0.0.1).
router.post('/mongo/apis/:name/test', async (req, res) => {
  const name = apiName(req.params.name);
  const method = String(req.body?.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) throw new HttpError(400, 'Invalid method');
  const reqPath = String(req.body?.path || '/api');
  if (!/^\/[A-Za-z0-9_.~\-/%?=&+,:@!$'()*[\]{}"]*$/.test(reqPath)) throw new HttpError(400, 'Invalid path');
  const app = JSON.parse((await readRemote(req.params.id, `${dir(name)}/.serverboy-app.json`)) || '{}');
  if (!app.port) throw new HttpError(404, 'API not found');
  let keyHeader = '';
  if (req.body?.auth === 'console') {
    const env = (await readRemote(req.params.id, `${dir(name)}/.env`)) || '';
    const key = (env.match(/^SB_CONSOLE_KEY=(.+)$/m) || [])[1];
    if (key) keyHeader = `-H ${q(`x-api-key: ${key.trim()}`)}`;
  } else if (req.body?.auth === 'key' && req.body?.key) {
    keyHeader = `-H ${q(`x-api-key: ${String(req.body.key).trim()}`)}`;
  }
  const body = req.body?.body ? String(req.body.body) : '';
  if (body.length > 200000) throw new HttpError(400, 'Body too large');
  const started = Date.now();
  const r = await ssh.exec(
    req.params.id,
    `curl -s -m 20 -X ${method} ${keyHeader} ${body ? `-H 'content-type: application/json' --data-binary ${q(body)}` : ''} -w '\\n__SB_STATUS__%{http_code}' ${q(`http://127.0.0.1:${app.port}${reqPath}`)}`,
  );
  const [text, status] = r.stdout.split('\n__SB_STATUS__');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  res.json({ status: Number(status) || 0, ms: Date.now() - started, body: json ?? text.slice(0, 20000) });
});

// Give an existing (private) API a public address later, e.g. once you have a domain.
router.post('/mongo/apis/:name/publish', async (req, res) => {
  const serverId = req.params.id;
  const name = apiName(req.params.name);
  await loadConfig(serverId, name);
  const domain = nginx.validDomain(req.body?.domain);
  const appFile = `${dir(name)}/.serverboy-app.json`;
  const app = JSON.parse((await readRemote(serverId, appFile)) || '{}');
  if (!app.port) throw new HttpError(404, 'API not found');
  const steps = [
    {
      label: `Publishing on ${domain}`,
      fn: async (log) => {
        await nginx.createSite(serverId, { domain, type: 'proxy', port: app.port });
        await ssh.writeFile(serverId, appFile, JSON.stringify({ ...app, domain }, null, 2), { sudo: false });
        log(`Nginx now forwards http://${domain} to the API.\n`);
      },
    },
  ];
  if (req.body?.https) {
    steps.push({
      label: `Getting a free HTTPS certificate for ${domain}`,
      allowFail: true,
      sudo: true,
      cmd: `command -v certbot >/dev/null || { apt-get update -y && apt-get install -y certbot python3-certbot-nginx; }; certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email --redirect -d ${q(domain)}`,
    });
  }
  audit(req, `Data API ${name}: published on ${domain}`);
  res.json(jobs.create(serverId, `Publish ${name} on ${domain}`, steps));
});

// ---------- maintenance ----------

router.post('/mongo/apis/:name/upgrade', async (req, res) => {
  const serverId = req.params.id;
  const name = apiName(req.params.name);
  await loadConfig(serverId, name);
  res.json(
    jobs.create(serverId, `Update data API engine: ${name}`, [
      {
        label: 'Writing the latest engine',
        fn: async (log) => {
          for (const f of ENGINE_FILES) await ssh.writeFile(serverId, `${dir(name)}/${f}`, fs.readFileSync(path.join(TEMPLATE_DIR, f)), { sudo: false });
          log('Done.\n');
        },
      },
      { label: 'Installing dependencies', cmd: `cd ${q(dir(name))} && npm install --omit=dev --no-audit --no-fund` },
      { label: 'Restarting', cmd: `pm2 restart ${q(name)} && pm2 save && sleep 2 && curl -s -m 10 http://127.0.0.1:$(grep -o '"port": *[0-9]*' ${q(`${dir(name)}/.serverboy-app.json`)} | grep -o '[0-9]*$')/health; echo` },
    ]),
  );
});

router.delete('/mongo/apis/:name', async (req, res) => {
  const serverId = req.params.id;
  const name = apiName(req.params.name);
  const cfg = await loadConfig(serverId, name);
  const app = JSON.parse((await readRemote(serverId, `${dir(name)}/.serverboy-app.json`)) || '{}');
  await ssh.exec(serverId, `pm2 delete ${q(name)} >/dev/null 2>&1; pm2 save >/dev/null 2>&1; true`);
  const dbUser = `api_${name.replace(/-/g, '_')}`;
  await mongosh(serverId, `const d = db.getSiblingDB(${JSON.stringify(cfg.database)}); if (d.getUser(${JSON.stringify(dbUser)})) d.dropUser(${JSON.stringify(dbUser)}); out({ ok: 1 });`).catch(() => {});
  let cmd = `rm -rf -- ${q(dir(name))}`;
  if (app.domain) cmd += ` && rm -f ${q(`/etc/nginx/sites-enabled/${app.domain}`)} ${q(`/etc/nginx/sites-available/${app.domain}`)} && (nginx -t && systemctl reload nginx || true)`;
  await ssh.exec(serverId, cmd, { sudo: true, check: true });
  audit(req, `Deleted data API ${name} (the data in ${cfg.database} was not touched)`);
  res.json({ ok: true });
});

module.exports = router;
