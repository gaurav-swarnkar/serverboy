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
const pm2 = require('../lib/pm2');
const openapi = require('../lib/openapi');

const { q, HttpError } = ssh;
const router = express.Router({ mergeParams: true });

const TEMPLATE_DIR = path.join(__dirname, '..', 'templates', 'data-api');
const ENGINE_FILES = ['server.js', 'package.json'];
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const DB_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COLL_RE = /^[A-Za-z0-9_.-]{1,120}$/;
const FIELD_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const API_OPS = ['list', 'get', 'count', 'create', 'update', 'delete'];
const MODES = ['off', 'public', 'key'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const OPS = ['read', 'create', 'update', 'delete'];
const ENGINE_VERSION = Number((fs.readFileSync(path.join(TEMPLATE_DIR, 'server.js'), 'utf8').match(/ENGINE_VERSION = (\d+)/) || [])[1]) || 1;
const PARAM_TYPES = ['string', 'number', 'boolean', 'date', 'objectId'];
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

// ---------- settings format ----------
// Engine v3 serves config.apis: { <slug>: { collection, ops, filter, fields… } }, several per
// collection if you like. Older engines used config.collections (one set of endpoints per
// collection, plus "custom endpoints"); "Update engine" converts those, keeping their addresses.

const isMigrated = (cfg) => Boolean(cfg.apis);

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'api';
}

function blankApi(collection) {
  return { title: collection.charAt(0).toUpperCase() + collection.slice(1), description: '', group: '', collection, ops: Object.fromEntries(API_OPS.map((o) => [o, 'off'])), filter: {}, params: [], sort: '', fields: '', hidden: [], readonly: [], required: [], writable: [], set: {}, timestamps: true, limit: 0, callerFilters: true, callerSort: true };
}

function migrate(cfg) {
  if (isMigrated(cfg)) return cfg;
  const apis = {};
  const legacy = {};
  const unique = (base) => {
    let slug = slugify(base);
    for (let i = 2; apis[slug]; i++) slug = `${slugify(base).slice(0, 36)}-${i}`;
    return slug;
  };
  const bySlugs = {}; // collection -> slugs made from it (for keys)
  const stronger = (a, b) => (a === 'public' || b === 'public' ? 'public' : a === 'key' || b === 'key' ? 'key' : 'off');
  for (const [col, c] of Object.entries(cfg.collections || {})) {
    const e = c.endpoints || {};
    const slug = unique(col);
    if (slug !== col) legacy[col] = slug;
    apis[slug] = {
      ...blankApi(col),
      ops: { list: e.list || 'off', get: e.get || 'off', count: e.count || 'off', create: e.create || 'off', update: stronger(e.update, e.replace), delete: e.delete || 'off' },
      hidden: c.hidden || [],
      readonly: c.readonly || [],
      required: c.required || [],
      timestamps: Boolean(c.timestamps),
    };
    bySlugs[col] = [slug];
    for (const v of c.custom || []) {
      const vs = unique(`${col}-${v.id}`);
      const read = v.kind !== 'create';
      apis[vs] = {
        ...blankApi(col),
        title: v.title || v.id,
        description: v.description || '',
        group: v.group || '',
        ops: { ...blankApi(col).ops, ...(read ? { [v.kind === 'count' ? 'count' : 'list']: v.mode || 'off' } : { create: v.mode || 'off' }) },
        filter: v.filter || {},
        params: v.params || [],
        sort: v.sort || '',
        fields: read ? v.fields || '' : '',
        writable: read ? [] : String(v.fields || '').split(',').map((x) => x.trim()).filter(Boolean),
        set: v.set || {},
        hidden: c.hidden || [],
        readonly: c.readonly || [],
        required: [...new Set([...(read ? [] : c.required || []), ...(v.required || [])])],
        timestamps: Boolean(c.timestamps),
        limit: v.kind === 'one' ? 1 : Number(v.limit) || 0,
        callerFilters: false,
        callerSort: false,
      };
      legacy[`${col}/views/${v.id}`] = { api: vs, kind: v.kind };
      bySlugs[col].push(vs);
    }
  }
  const keys = (cfg.keys || []).map((k) => {
    const access = {};
    for (const [target, ops] of Object.entries(k.access || {})) {
      if (target === '*') access['*'] = ops;
      else for (const slug of bySlugs[target] || []) access[slug] = ops;
    }
    return { ...k, access };
  });
  const { collections, ...rest } = cfg;
  return { ...rest, apis, legacy, keys };
}

async function requireMigrated(serverId, name, cfg) {
  if (!isMigrated(cfg)) throw new HttpError(409, `${name} runs an older API engine. Click "Update engine" first (one click, nothing is lost).`);
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
  // Swagger "Try it out" goes through /proxy with the caller's own key (or none): it can only do
  // what that key could do on the internet anyway.
  if (req.path.startsWith('/proxy/') || req.path === '/openapi.json') {
    scope.requireDb(req, 'mongo', cfg.database, 'view');
    return next();
  }
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
echo "##PM2"; command -v pm2 >/dev/null && ${pm2.whenRunning('pm2 jlist 2>/dev/null | tail -1')}; echo`,
  );
  const [apisPart, pm2Part] = r.stdout.split('##PM2');
  let procs = [];
  try {
    procs = JSON.parse((pm2Part || '').trim() || '[]');
  } catch {
    procs = [];
  }
  const apis = [];
  for (const chunk of apisPart.split('##API ').slice(1)) {
    const [head, appJson] = chunk.split('##APP');
    const nl = head.indexOf('\n');
    const name = head.slice(0, nl).trim();
    try {
      const cfg = JSON.parse(head.slice(nl + 1));
      const app = appJson && appJson.trim() ? JSON.parse(appJson) : {};
      const proc = procs.find((p) => p.name === name);
      apis.push({
        name,
        database: cfg.database,
        port: app.port || null,
        domain: app.domain || null,
        status: proc ? proc.pm2_env?.status : 'not running',
        apis: Object.entries(migrate(cfg).apis).map(([slug, a]) => ({ slug, title: a.title, collection: a.collection, group: a.group, description: a.description, ops: a.ops })),
        needsUpgrade: !isMigrated(cfg),
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
    `${pm2.whenRunning('pm2 jlist 2>/dev/null | tail -1')}; echo; ${app.port ? `curl -s -m 3 http://127.0.0.1:${Number(app.port)}/health; ` : ''}echo; grep -l 'ssl_certificate' /etc/nginx/sites-enabled/${q(app.domain || 'none')} 2>/dev/null`,
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
    ...publicConfig(migrate(cfg)),
    needsUpgrade: !isMigrated(cfg),
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
command -v pm2 >/dev/null && ${pm2.whenRunning(`pm2 jlist 2>/dev/null | grep -qF '"name":"${name}"' && echo IN_PM2`, `grep -qE '"name": ?"${name}"' ~/.pm2/dump.pm2 2>/dev/null && echo IN_PM2`)}`,
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
    apis: {},
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
        // An existing website on this domain is pointed at the API instead of being left as is.
        const changes = await nginx.pointSiteToApi(serverId, domain, port);
        log(`${changes.length ? changes.join('\n') : `${domain} already forwards to the API.`}\nhttp://${domain}/api/… now reaches the API.\n`);
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

// ---------- APIs (one service can have many, several per collection) ----------

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

function cleanApi(body) {
  const slug = String(body?.slug || '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'Address: lowercase letters, numbers and - only (e.g. products or blog-posts)');
  const collection = String(body?.collection || '').trim();
  if (!COLL_RE.test(collection)) throw new HttpError(400, 'Choose which collection this API uses');
  const ops = {};
  for (const o of API_OPS) {
    const m = body?.ops?.[o] || 'off';
    if (!MODES.includes(m)) throw new HttpError(400, `${o}: use off, public or key`);
    ops[o] = m;
  }
  const params = (Array.isArray(body?.params) ? body.params : []).map((p) => {
    const name = String(p?.name || '').trim();
    if (!PARAM_RE.test(name)) throw new HttpError(400, `Invalid link value name "${name}"`);
    if (RESERVED_PARAMS.includes(name)) throw new HttpError(400, `"${name}" is reserved for paging; pick another name`);
    return {
      name,
      type: PARAM_TYPES.includes(p.type) ? p.type : 'string',
      required: Boolean(p.required),
      default: p.default === undefined || p.default === null ? '' : String(p.default).slice(0, 200),
      description: String(p.description || '').slice(0, 300),
    };
  });
  if (new Set(params.map((p) => p.name)).size !== params.length) throw new HttpError(400, 'Two link values have the same name');
  const filter = jsonObject(body?.filter, 'Which items');
  const used = [...JSON.stringify(filter).matchAll(/"\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}"/g)].map((m) => m[1]);
  const missing = used.filter((u) => !params.some((p) => p.name === u));
  if (missing.length) throw new HttpError(400, `"Which items" uses {{${missing[0]}}}; add it as a value from the link`);
  const set = jsonObject(body?.set, 'Fixed values');
  if (Object.keys(set).some((k) => k === '_id' || k.startsWith('$'))) throw new HttpError(400, 'Fixed values cannot set _id or use $ operators');
  const sort = String(body?.sort || '').trim();
  if (sort && !sort.split(',').every((f) => FIELD_RE.test(f.trim().replace(/^-/, '')))) throw new HttpError(400, 'Order: field names separated by commas, - for newest / largest first (e.g. -createdAt)');
  return {
    slug,
    api: {
      title: String(body?.title || slug).trim().slice(0, 80),
      description: String(body?.description || '').trim().slice(0, 1000),
      group: String(body?.group || '').trim().slice(0, 40),
      collection,
      ops,
      filter,
      params,
      sort,
      fields: cleanFields(body?.fields).join(','),
      hidden: cleanFields(body?.hidden),
      readonly: cleanFields(body?.readonly),
      required: cleanFields(body?.required),
      writable: cleanFields(body?.writable),
      set,
      timestamps: body?.timestamps !== false,
      limit: Math.max(0, Math.min(Number(body?.limit) || 0, 1000)),
      callerFilters: body?.callerFilters !== false,
      callerSort: body?.callerSort !== false,
    },
  };
}

// Create (slug "new") or change an API; renaming its address moves keys and old addresses along.
router.put('/mongo/apis/:name/resources/:slug', async (req, res) => {
  const name = apiName(req.params.name);
  const cfg = await loadConfig(req.params.id, name);
  await requireMigrated(req.params.id, name, cfg);
  const { slug, api } = cleanApi(req.body);
  const old = req.params.slug;
  if (slug !== old && cfg.apis[slug]) throw new HttpError(409, `There is already an API at /api/${slug}`);
  const next = {};
  for (const [k, v] of Object.entries(cfg.apis)) next[k === old ? slug : k] = k === old ? api : v;
  if (!(slug in next)) next[slug] = api;
  cfg.apis = next;
  if (slug !== old && old !== 'new') {
    for (const k of cfg.keys || []) if (k.access?.[old]) {
      k.access[slug] = k.access[old];
      delete k.access[old];
    }
    for (const [from, to] of Object.entries(cfg.legacy || {})) {
      if (to === old) cfg.legacy[from] = slug;
      else if (to && to.api === old) to.api = slug;
    }
  }
  await saveConfig(req.params.id, name, cfg);
  audit(req, `Data API ${name}: saved /api/${slug} on ${api.collection} (${API_OPS.filter((o) => api.ops[o] !== 'off').map((o) => `${o}=${api.ops[o]}`).join(', ') || 'all off'})`);
  res.json(publicConfig(cfg));
});

router.delete('/mongo/apis/:name/resources/:slug', async (req, res) => {
  const name = apiName(req.params.name);
  const cfg = await loadConfig(req.params.id, name);
  await requireMigrated(req.params.id, name, cfg);
  delete cfg.apis[req.params.slug];
  for (const k of cfg.keys || []) delete k.access?.[req.params.slug];
  await saveConfig(req.params.id, name, cfg);
  audit(req, `Data API ${name}: deleted /api/${req.params.slug}`);
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
  await requireMigrated(req.params.id, name, cfg);
  for (const [target, ops] of Object.entries(req.body?.access || {})) {
    if (target !== '*' && !cfg.apis[target]) throw new HttpError(400, `Unknown API "${target}"`);
    const clean = (Array.isArray(ops) ? ops : []).filter((o) => OPS.includes(o));
    if (clean.length) access[target] = clean;
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

// ---------- Swagger / OpenAPI ----------

router.get('/mongo/apis/:name/openapi.json', async (req, res) => {
  const name = apiName(req.params.name);
  const cfg = migrate(await loadConfig(req.params.id, name));
  const app = JSON.parse((await readRemote(req.params.id, `${dir(name)}/.serverboy-app.json`)) || '{}');
  const slugs = req.query.api ? String(req.query.api).split(',').filter((x) => cfg.apis[x]) : null;
  const cols = [...new Set(Object.entries(cfg.apis).filter(([s]) => !slugs || slugs.includes(s)).map(([, a]) => a.collection))];
  const samples = {};
  if (cols.length) {
    const r = await mongosh(
      req.params.id,
      `const d = db.getSiblingDB(${JSON.stringify(cfg.database)});
out(Object.fromEntries(${JSON.stringify(cols)}.map((c) => [c, d.getCollection(c).find().sort({ _id: -1 }).limit(20).toArray()])));`,
    ).catch(() => ({}));
    Object.assign(samples, r);
  }
  const https = app.domain ? (await ssh.exec(req.params.id, `grep -l 'ssl_certificate' /etc/nginx/sites-enabled/${q(app.domain)} 2>/dev/null`)).stdout.includes('/etc/nginx') : false;
  // "Try it out" works best through Serverboy (also before publishing); the public address is
  // what websites and apps use, so a downloaded spec lists that first.
  const servers = [{ url: `/api/servers/${req.params.id}/mongo/apis/${name}/proxy`, description: 'Through Serverboy (for trying it out here)' }];
  if (app.domain) servers[req.query.download ? 'unshift' : 'push']({ url: `${https ? 'https' : 'http'}://${app.domain}`, description: 'Public address (what websites and apps use)' });
  const spec = openapi.build({ info: cfg, slugs, samples, servers });
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${slugs?.length === 1 ? slugs[0] : name}-openapi.json"`);
  res.json(spec);
});

// Forwards a request to the API on the server (it only listens on 127.0.0.1). Only the
// caller's own x-api-key is passed on.
router.all('/mongo/apis/:name/proxy/*rest', async (req, res) => {
  const name = apiName(req.params.name);
  const method = req.method.toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) throw new HttpError(405, 'Method not allowed');
  const rest = [].concat(req.params.rest || []).join('/');
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  const reqPath = `/${rest}${qs}`;
  if (!/^\/(api\/|health)/.test(reqPath) || !/^\/[A-Za-z0-9_.~\-/%?=&+,:@!$'()*[\]{}"]*$/.test(reqPath)) throw new HttpError(400, 'Invalid path');
  const app = JSON.parse((await readRemote(req.params.id, `${dir(name)}/.serverboy-app.json`)) || '{}');
  if (!app.port) throw new HttpError(404, 'API not found');
  const key = String(req.get('x-api-key') || '').trim();
  if (key && !/^[A-Za-z0-9_-]{8,200}$/.test(key)) throw new HttpError(400, 'Invalid API key format');
  const body = ['POST', 'PATCH', 'PUT'].includes(method) && req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : '';
  if (body.length > 200000) throw new HttpError(400, 'Body too large');
  const r = await ssh.exec(
    req.params.id,
    `curl -s -m 20 -X ${method} ${key ? `-H ${q(`x-api-key: ${key}`)}` : ''} ${body ? `-H 'content-type: application/json' --data-binary ${q(body)}` : ''} -w '\n__SB_STATUS__%{http_code}' ${q(`http://127.0.0.1:${app.port}${reqPath}`)}`,
  );
  const [text, status] = r.stdout.split('\n__SB_STATUS__');
  res.status(Number(status) || 502).type('application/json').send(text || JSON.stringify({ error: 'The API did not answer' }));
});

// Does the public address really reach the API? (Nginx is asked on the server itself.)
router.get('/mongo/apis/:name/address-check', async (req, res) => {
  const name = apiName(req.params.name);
  const app = JSON.parse((await readRemote(req.params.id, `${dir(name)}/.serverboy-app.json`)) || '{}');
  if (!app.port) throw new HttpError(404, 'API not found');
  if (!app.domain) return res.json({ ok: false, domain: null, problem: 'Not published yet: only this server can reach it.', fixable: false });
  res.json(await nginx.checkApiAddress(req.params.id, app.domain, app.port));
});

// Repair the public address: point the domain's Nginx website at the API.
router.post('/mongo/apis/:name/address-fix', async (req, res) => {
  const name = apiName(req.params.name);
  const app = JSON.parse((await readRemote(req.params.id, `${dir(name)}/.serverboy-app.json`)) || '{}');
  if (!app.port || !app.domain) throw new HttpError(400, 'This API has no public address yet. Publish it first.');
  const changes = await nginx.pointSiteToApi(req.params.id, app.domain, app.port);
  audit(req, `Data API ${name}: repaired the public address ${app.domain}${changes.length ? ` (${changes.join('; ')})` : ''}`);
  res.json({ changes, check: await nginx.checkApiAddress(req.params.id, app.domain, app.port) });
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
        const changes = await nginx.pointSiteToApi(serverId, domain, app.port);
        await ssh.writeFile(serverId, appFile, JSON.stringify({ ...app, domain }, null, 2), { sudo: false });
        log(`${changes.length ? changes.join('\n') : `${domain} already forwards to the API.`}\nhttp://${domain}/api/… now reaches the API.\n`);
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
      {
        label: 'Converting settings to the new format',
        fn: async (log) => {
          const cfg = await loadConfig(serverId, name);
          if (isMigrated(cfg)) return log('Already up to date.\n');
          await ssh.exec(serverId, `cp -p ${q(configPath(name))} ${q(`${configPath(name)}.bak-v2`)}`);
          const next = migrate(cfg);
          await saveConfig(serverId, name, next);
          log(`Saved ${Object.keys(next.apis).length} API(s): ${Object.keys(next.apis).map((x) => `/api/${x}`).join(', ') || 'none'}. Old addresses keep working. Backup: api.config.json.bak-v2\n`);
        },
      },
      { label: 'Checking PM2', fn: async (log) => log(`${await pm2.ensureDaemon(serverId)}\n`) },
      { label: 'Restarting', cmd: `pm2 restart ${q(name)} && pm2 save && sleep 2 && curl -s -m 10 http://127.0.0.1:$(grep -o '"port": *[0-9]*' ${q(`${dir(name)}/.serverboy-app.json`)} | grep -o '[0-9]*$')/health; echo` },
    ]),
  );
});

router.delete('/mongo/apis/:name', async (req, res) => {
  const serverId = req.params.id;
  const name = apiName(req.params.name);
  const cfg = await loadConfig(serverId, name);
  const app = JSON.parse((await readRemote(serverId, `${dir(name)}/.serverboy-app.json`)) || '{}');
  await ssh.exec(serverId, pm2.whenRunning(`pm2 delete ${q(name)} >/dev/null 2>&1; pm2 save >/dev/null 2>&1; true`, 'true'));
  const dbUser = `api_${name.replace(/-/g, '_')}`;
  await mongosh(serverId, `const d = db.getSiblingDB(${JSON.stringify(cfg.database)}); if (d.getUser(${JSON.stringify(dbUser)})) d.dropUser(${JSON.stringify(dbUser)}); out({ ok: 1 });`).catch(() => {});
  let cmd = `rm -rf -- ${q(dir(name))}`;
  if (app.domain) cmd += ` && rm -f ${q(`/etc/nginx/sites-enabled/${app.domain}`)} ${q(`/etc/nginx/sites-available/${app.domain}`)} && (nginx -t && systemctl reload nginx || true)`;
  await ssh.exec(serverId, cmd, { sudo: true, check: true });
  audit(req, `Deleted data API ${name} (the data in ${cfg.database} was not touched)`);
  res.json({ ok: true });
});

module.exports = router;
