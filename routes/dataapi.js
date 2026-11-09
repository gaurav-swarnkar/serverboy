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
const mounts = require('../lib/api-mounts');

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

// Save api.config.json. With wait, return only once the running engine has loaded it, so the
// next request (e.g. opening the new API right after creating it) never gets an old answer.
async function saveConfig(serverId, name, cfg, { wait = false } = {}) {
  cfg.revision = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  // An API server in a website folder: no two APIs may get the same address there.
  const app = JSON.parse((await readRemote(serverId, `${dir(name)}/.serverboy-app.json`)) || '{}');
  const mounted = app.site && app.folder ? app : null;
  if (mounted) await mounts.check(serverId, app.site, { name, cfg, app });
  const savedAt = Date.now();
  await ssh.writeFile(serverId, configPath(name), `${JSON.stringify(cfg, null, 2)}\n`, { sudo: false });
  if (wait) await waitForEngine(serverId, name, cfg, savedAt);
  // Then the website's routes, so new or renamed APIs answer at their address right away.
  if (mounted) await mounts.sync(serverId, app.site);
}

async function engineHealth(serverId, port) {
  const r = await ssh.exec(serverId, `curl -s -m 3 -w '\n%{http_code}' http://127.0.0.1:${Number(port)}/health`, { timeout: 10000 });
  const [body, code] = [r.stdout.slice(0, r.stdout.lastIndexOf('\n')), r.stdout.slice(r.stdout.lastIndexOf('\n') + 1).trim()];
  try {
    return { code: Number(code) || 0, ...JSON.parse(body) };
  } catch {
    return { code: Number(code) || 0 };
  }
}

async function waitForEngine(serverId, name, cfg, savedAt) {
  const app = JSON.parse((await readRemote(serverId, `${dir(name)}/.serverboy-app.json`)) || '{}');
  if (!app.port) return false;
  const slugs = Object.keys(cfg.apis || {});
  for (let i = 0; i < 30; i++) {
    const h = await engineHealth(serverId, app.port).catch(() => ({ code: 0 }));
    if (!h.code) return false; // not running: nothing to wait for (Diagnose explains)
    // Engine v4+ reports the revision it runs; older ones: wait for its poll (2 s) and the API list.
    if (h.revision !== undefined ? h.revision === cfg.revision : Date.now() - savedAt > 2300 && slugs.every((s) => (h.apis || []).includes(s))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
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

// Ports in use: listening now, saved for a Serverboy app (even one that is stopped), or given to a
// PM2 process (PORT), so two API servers never get the same port.
async function usedPorts(serverId) {
  const r = await ssh.exec(serverId, `ss -ltnH 2>/dev/null | awk '{print $4}' | sed 's/.*://'; cat /var/www/*/.serverboy-app.json 2>/dev/null | grep -o '"port": *[0-9]*' | grep -o '[0-9]*$'; echo __PM2__; ${pm2.whenRunning('pm2 jlist 2>/dev/null | tail -1')}`);
  const [plain, pm2Part = ''] = r.stdout.split('__PM2__');
  const used = new Set(plain.split('\n').map((x) => x.trim()).filter(Boolean));
  try {
    for (const p of JSON.parse(pm2Part.trim().split('\n').pop() || '[]')) {
      const port = p.pm2_env?.PORT ?? p.pm2_env?.env?.PORT;
      if (port) used.add(String(port));
    }
  } catch {
    /* PM2 output not readable */
  }
  return used;
}

async function freePort(serverId) {
  const used = await usedPorts(serverId);
  for (let p = 4100; p < 5000; p++) if (!used.has(String(p))) return p;
  throw new HttpError(500, 'No free port found between 4100 and 4999');
}

// Which other app uses this port: another Serverboy app folder, or a PM2 process started with it?
async function portOwner(serverId, port, except) {
  const r = await ssh.exec(serverId, `for f in /var/www/*/.serverboy-app.json; do [ -f "$f" ] && echo "$(basename "$(dirname "$f")") $(grep -o '"port": *[0-9]*' "$f" | grep -o '[0-9]*$')"; done; echo __PM2__; ${pm2.whenRunning('pm2 jlist 2>/dev/null | tail -1')}`);
  const [files, pm2Part = ''] = r.stdout.split('__PM2__');
  try {
    for (const p of JSON.parse(pm2Part.trim().split('\n').pop() || '[]')) {
      if (p.name !== except && Number(p.pm2_env?.PORT ?? p.pm2_env?.env?.PORT) === Number(port)) return p.name;
    }
  } catch {
    /* PM2 output not readable */
  }
  for (const line of files.split('\n')) {
    const [n, p] = line.trim().split(' ');
    if (n && n !== except && Number(p) === Number(port)) return n;
  }
  return null;
}

// Something else answers on this API server's port: explain it (the classic "404: There is no API
// called ..." while this one is not running) and offer to move to a free port.
async function portClash(serverId, name, port, h) {
  const owner = await portOwner(serverId, port, name).catch(() => null);
  const who = owner ? `the app "${owner}"` : 'another program';
  return {
    title: `Port ${port} is taken by ${owner ? `"${owner}"` : 'another program'}`,
    detail: `This API server should answer on 127.0.0.1:${port}, but ${who} already uses that port${h?.database ? ` (an API server for the database "${h.database}")` : ''}. Requests meant for this API reach that one instead: that is why you see 404 "There is no API called …". Move this API server to a free port; its APIs, keys and public address are kept.`,
  };
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
      const full = migrate(cfg);
      apis.push({
        name,
        database: cfg.database,
        port: app.port || null,
        domain: app.domain || null,
        site: app.site || null,
        folder: app.folder || null,
        paths: mounts.pathsOf(app, full),
        copyOf: mounts.isCopy({ name, cfg, app }) ? cfg.name || app.name || name.replace(/-restored-\d{8}-\d{6}$/, '') : null,
        status: proc ? proc.pm2_env?.status : 'not running',
        apis: Object.entries(full.apis).map(([slug, a]) => ({ slug, title: a.title, collection: a.collection, group: a.group, description: a.description, ops: a.ops })),
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
  const full = migrate(cfg);
  // In a website folder: that is the address websites and apps use.
  let site = null;
  if (app.site) {
    const s = (await nginx.listSites(req.params.id)).sites.find((x) => x.name === app.site);
    site = { name: app.site, folder: app.folder, exists: Boolean(s), ssl: Boolean(s?.ssl), testMode: Boolean(s?.testMode), url: `${s?.ssl ? 'https' : 'http'}://${app.site}` };
  }
  res.json({
    ...publicConfig(full),
    needsUpgrade: !isMigrated(cfg),
    port: app.port,
    domain: app.domain || null,
    site,
    paths: mounts.pathsOf(app, full),
    copyOf: mounts.isCopy({ name, cfg, app }) ? cfg.name || app.name || name.replace(/-restored-\d{8}-\d{6}$/, '') : null,
    url: site ? site.url : app.domain ? `${https ? 'https' : 'http'}://${app.domain}` : null,
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
  // Or inside a website, in its API folder (https://<site>/<folder>/…).
  let site = req.body?.site ? nginx.validDomain(req.body.site) : null;
  let folder = site ? mounts.folderName(req.body?.folder) : null;

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
  if (site) {
    scope.requireSite(req, site, 'edit');
    const w = (await mounts.websites(serverId)).find((x) => x.name === site);
    if (!w) throw new HttpError(404, `There is no website ${site} on this server (or it is Serverboy itself).`);
    if (w.folder && w.folder !== folder) folder = w.folder; // a website has one API folder
  }

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
  if (!site && app.site) [site, folder] = [app.site, app.folder];
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
  const cfg = { name, repo: '', branch: 'main', port, installCmd: '', buildCmd: '', startCmd: 'node server.js', domain, ...(site ? { site, folder } : {}) };
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
  if (site) {
    steps.push({
      label: `Adding the API folder /${folder} to ${site}`,
      fn: async (log) => {
        const r = await mounts.sync(serverId, site);
        log(`APIs of this server answer at ${r.ssl ? 'https' : 'http'}://${site}/${folder}/…${r.testMode ? `\nNote: ${site} is in test mode, so the internet gets "Coming soon" until the owner makes it live (Websites).` : ''}\n`);
      },
    });
  }
  steps.push({
    label: 'Checking the API answers',
    cmd: `for i in 1 2 3 4 5 6 7 8 9 10; do out=$(curl -s -m 5 http://127.0.0.1:${port}/health); [ -n "$out" ] && break; sleep 1; done; echo "$out"
case "$out" in *'"database":${JSON.stringify(database)}'*) ;; '') echo "Nothing answers on port ${port}. Open Diagnose on the API page."; exit 1 ;; *) echo "Port ${port} is answered by a different API server. Open Diagnose on the API page and move this one to a free port."; exit 1 ;; esac`,
  });
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
  await saveConfig(req.params.id, name, cfg, { wait: true });
  audit(req, `Data API ${name}: saved /api/${slug} on ${api.collection} (${API_OPS.filter((o) => api.ops[o] !== 'off').map((o) => `${o}=${api.ops[o]}`).join(', ') || 'all off'})`);
  res.json(publicConfig(cfg));
});

router.delete('/mongo/apis/:name/resources/:slug', async (req, res) => {
  const name = apiName(req.params.name);
  const cfg = await loadConfig(req.params.id, name);
  await requireMigrated(req.params.id, name, cfg);
  delete cfg.apis[req.params.slug];
  for (const k of cfg.keys || []) delete k.access?.[req.params.slug];
  await saveConfig(req.params.id, name, cfg, { wait: true });
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
  await saveConfig(req.params.id, name, cfg, { wait: true });
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
  await saveConfig(req.params.id, name, cfg, { wait: true });
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
  await saveConfig(req.params.id, name, cfg, { wait: true });
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
  const paths = mounts.pathsOf(app, cfg);
  if (app.site) {
    const ssl = (await ssh.exec(req.params.id, `grep -l 'ssl_certificate' /etc/nginx/sites-enabled/${q(app.site)} 2>/dev/null`)).stdout.includes('/etc/nginx');
    servers[req.query.download ? 'unshift' : 'push']({ url: `${ssl ? 'https' : 'http'}://${app.site}`, description: 'Public address (what websites and apps use)' });
  } else if (app.domain) servers[req.query.download ? 'unshift' : 'push']({ url: `${https ? 'https' : 'http'}://${app.domain}`, description: 'Public address (what websites and apps use)' });
  const spec = openapi.build({ info: cfg, slugs, samples, servers, pathOf: (slug) => paths[slug] || `/api/${slug}` });
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
  const app = JSON.parse((await readRemote(req.params.id, `${dir(name)}/.serverboy-app.json`)) || '{}');
  // Swagger lists the public folder paths (/<folder>/<group>/<api>); the engine answers /api/<api>.
  const reqPath = mounts.toInternal(app, migrate(await loadConfig(req.params.id, name)), `/${rest}${qs}`);
  if (!/^\/(api\/|health)/.test(reqPath) || !/^\/[A-Za-z0-9_.~\-/%?=&+,:@!$'()*[\]{}"]*$/.test(reqPath)) throw new HttpError(400, 'Invalid path');
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

// ---------- Diagnose: find what is wrong with an API and say what to do next ----------
// Checks run in order and stop at the first blocking problem. Each step:
//   { id, status: ok | warn | bad | skip, title, detail, action?: finish | restart | logs | upgrade | fix-address | publish }
router.get('/mongo/apis/:name/diagnose', async (req, res) => {
  const serverId = req.params.id;
  const name = apiName(req.params.name);
  const slug = req.query.slug ? String(req.query.slug) : null;
  const steps = [];
  const add = (id, status, title, detail = '', action = null) => steps.push({ id, status, title, detail, action });
  const done = () => res.json({ name, slug, ok: steps.every((x) => x.status === 'ok' || x.status === 'skip'), steps, next: steps.find((x) => x.status === 'bad') || steps.find((x) => x.status === 'warn') || null });

  // 1. Settings file
  let cfg;
  const raw = await readRemote(serverId, configPath(name));
  if (!raw) {
    add('config', 'bad', 'The API server settings are missing', `${configPath(name)} does not exist. The API server may have been deleted, or its setup never started.`, 'finish');
    return done();
  }
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    add('config', 'bad', 'The settings file is damaged', `api.config.json is not valid JSON (${err.message}). Restore it from a backup, or save the API settings again.`);
    return done();
  }
  add('config', 'ok', 'Settings found', `${Object.keys(cfg.apis || {}).length} API(s) for the database ${cfg.database}`);

  // A copied folder still answers to the other API server's name, port and address.
  const ident = await identityOf(serverId, name);
  if (ident.copyOf) {
    add('copy', 'bad', `This is a copy of the API server "${ident.copyOf}"`, `Its folder (${dir(name)}) was copied from ${ident.copyOf}, so its files still use ${ident.copyOf}'s name${ident.app?.port ? `, port ${ident.app.port}` : ''}${ident.app?.domain ? ` and address ${ident.app.domain}` : ''}. Everything meant for this API server goes to ${ident.copyOf} instead. "Make it independent" gives it its own name, a free port and its own PM2 entry. ${ident.copyOf} is not touched; its APIs and keys stay as they are, and so do the ones in this copy.`, 'move-port');
    return done();
  }
  if (!ident.writable) add('files', 'warn', 'Serverboy cannot change this folder', `${dir(name)} belongs to another user (for example after copying it as root), so saving its settings fails. "Make it independent" gives the files back.`, 'move-port');

  // 2. Setup finished (port, packages, PM2 entry)
  const app = JSON.parse((await readRemote(serverId, `${dir(name)}/.serverboy-app.json`)) || '{}');
  const facts = await ssh.exec(
    serverId,
    `[ -d ${q(`${dir(name)}/node_modules/express`)} ] && [ -d ${q(`${dir(name)}/node_modules/mongodb`)} ] && echo HAS_MODULES
${pm2.whenRunning(`pm2 jlist 2>/dev/null | tail -1`, 'echo "[]"')}`,
    { timeout: 30000 },
  );
  let proc = null;
  try {
    proc = JSON.parse(facts.stdout.split('\n').filter((l) => l.trim().startsWith('[')).pop() || '[]').find((p) => p.name === name) || null;
  } catch {
    /* PM2 output not readable */
  }
  // Not running (or not set up), yet something answers on its port: another app has it.
  if (app.port && proc?.pm2_env?.status !== 'online') {
    const other = await engineHealth(serverId, app.port).catch(() => ({ code: 0 }));
    if (other.code) {
      const c = await portClash(serverId, name, app.port, other);
      add('port', 'bad', c.title, c.detail, 'move-port');
      return done();
    }
  }
  if (!app.port || !facts.stdout.includes('HAS_MODULES') || !proc) {
    const what = !app.port ? 'it has no port yet' : !facts.stdout.includes('HAS_MODULES') ? 'its packages (npm install) are missing' : 'it is not registered in PM2';
    add('setup', 'bad', 'The setup of this API server did not finish', `It stopped part-way: ${what}. "Finish setup" continues where it stopped and keeps your APIs and keys. If it stops again at "Installing dependencies", the server could not download packages: check its internet access and free disk space.`, 'finish');
    return done();
  }
  add('setup', 'ok', 'Setup finished', `Runs on 127.0.0.1:${app.port}`);

  // 3. Process running
  const status = proc.pm2_env?.status;
  if (status !== 'online') {
    const log = await ssh.exec(serverId, `tail -n 12 ~/.pm2/logs/${q(name)}-error.log 2>/dev/null`);
    const why = status === 'stopped' ? 'Someone stopped it (PM2 stop), or the server was restarted before PM2 saved it. Restart it.' : status === 'errored' ? 'It crashed again and again, so PM2 gave up. The last errors below say why; fix that, then restart it.' : 'It is not running.';
    add('process', 'bad', `The API server is ${status || 'not running'}`, `${why}${log.stdout.trim() ? `\n\nLast errors:\n${log.stdout.trim()}` : ''}`, status === 'errored' && log.stdout.trim() ? 'logs' : 'restart');
    return done();
  }
  add('process', 'ok', 'Running', `${proc.pm2_env?.restart_time || 0} restart(s)`);

  // 4. Answers on its port, 5. database
  const h = await engineHealth(serverId, app.port).catch(() => ({ code: 0 }));
  if (!h.code) {
    add('answer', 'bad', 'It does not answer', `Nothing answers on 127.0.0.1:${app.port}, although PM2 says it runs. It may be starting, or stuck. Restart it; if it stays like this, open the logs.`, 'restart');
    return done();
  }
  // It answers, but as a different API server (two apps on one port).
  if ((h.name && h.name !== name) || (h.database && h.database !== cfg.database)) {
    const c = await portClash(serverId, name, app.port, h);
    add('port', 'bad', c.title, c.detail, 'move-port');
    return done();
  }
  add('answer', 'ok', 'It answers', `engine v${h.engine || '?'}`);
  if (h.ok === false || h.code >= 500) {
    add('database', 'bad', 'It cannot reach the database', `${h.error || `Health check answered ${h.code}.`} Is MongoDB running (Services)? If the login is wrong, "Finish setup" creates a new database user for the API server.`, 'finish');
    return done();
  }
  add('database', 'ok', 'Database reachable', cfg.database);

  // 6. Engine version, 7. settings loaded
  if ((h.engine || 0) < ENGINE_VERSION) add('engine', 'warn', `Engine v${h.engine} (v${ENGINE_VERSION} is available)`, 'Updating makes changes apply instantly and adds better checks. Your APIs and keys are kept.', 'upgrade');
  else add('engine', 'ok', `Engine v${h.engine} (latest)`);
  const loaded = h.revision !== undefined && h.revision !== null ? h.revision === cfg.revision : Object.keys(cfg.apis || {}).every((x) => (h.apis || []).includes(x));
  if (!loaded) add('loaded', 'warn', 'It runs older settings than the saved ones', 'It normally picks up changes within seconds. If this stays, restart it.', 'restart');
  else add('loaded', 'ok', 'Latest settings loaded');

  // 8. The API itself
  if (slug) {
    const a = (cfg.apis || {})[slug];
    if (!a) {
      const alias = cfg.legacy?.[slug];
      add('api', 'bad', `There is no API at /api/${slug}`, alias ? `/api/${slug} is an old address for /api/${alias}.` : `This API server has: ${Object.keys(cfg.apis || {}).map((x) => `/api/${x}`).join(', ') || 'no APIs yet'}. It may have been renamed or deleted.`);
      return done();
    }
    const offOps = Object.entries(a.ops || {}).filter(([, m]) => m === 'off').map(([op]) => op);
    add('api', 'ok', `API /api/${slug} exists`, `Reads "${a.collection}"${offOps.length ? `; switched off: ${offOps.join(', ')}` : ''}`);
    try {
      const info = await mongosh(serverId, `const d = db.getSiblingDB(${JSON.stringify(cfg.database)}); const names = d.getCollectionNames(); out({ exists: names.includes(${JSON.stringify(a.collection)}), count: names.includes(${JSON.stringify(a.collection)}) ? d.getCollection(${JSON.stringify(a.collection)}).countDocuments() : 0, names });`);
      if (!info.exists) {
        const similar = info.names.filter((n) => n.toLowerCase().replace(/s$/, '') === a.collection.toLowerCase().replace(/s$/, '') && n !== a.collection);
        add('data', 'warn', `The collection "${a.collection}" does not exist yet`, `The list will be empty until something is added.${similar.length ? ` Did you mean "${similar[0]}"? Change it in the API's Settings.` : ''}`);
      } else if (!info.count) add('data', 'warn', `The collection "${a.collection}" is empty`, 'The API works, but has nothing to show yet. Add items in Databases or with the API.');
      else add('data', 'ok', `${info.count} item(s) in "${a.collection}"`);
    } catch (err) {
      add('data', 'skip', 'Could not count the items', err.message.split('\n')[0]);
    }
    // 9. A real request, as the console (so key-only APIs can be checked too)
    const env = (await readRemote(serverId, `${dir(name)}/.env`)) || '';
    const key = (env.match(/^SB_CONSOLE_KEY=(.+)$/m) || [])[1];
    const op = a.ops?.list && a.ops.list !== 'off' ? `/api/${slug}?limit=1` : a.ops?.count && a.ops.count !== 'off' ? `/api/${slug}/count` : null;
    if (op) {
      const r = await ssh.exec(serverId, `curl -s -m 10 ${key ? `-H ${q(`x-api-key: ${key.trim()}`)}` : ''} -o /dev/null -w '%{http_code}' ${q(`http://127.0.0.1:${app.port}${op}`)}`);
      const code = Number(r.stdout.trim()) || 0;
      if (code >= 200 && code < 300) add('request', 'ok', `A real request works`, `GET ${op} answered ${code}`);
      else add('request', 'bad', `A real request fails (${code || 'no answer'})`, `GET ${op} did not work. ${code === 404 ? 'The engine does not know this API: restart it so it reloads its settings.' : 'Open the logs to see why.'}`, code === 404 ? 'restart' : 'logs');
    } else add('request', 'skip', 'No read operation is switched on to test');
  }

  // 10. Public address: the website folder, or its own address
  if (app.site) {
    const sites = (await nginx.listSites(serverId)).sites;
    const s = sites.find((x) => x.name === app.site);
    const first = slug && cfg.apis?.[slug] ? slug : Object.keys(cfg.apis || {})[0];
    const p = first ? mounts.apiPath(app.folder, first, cfg.apis[first]) : `/${app.folder}/__serverboy_check`;
    if (!s) add('address', 'bad', `The website ${app.site} does not exist any more`, 'Put this API server in another website (Settings → Address).', 'mount');
    else if (!s.enabled) add('address', 'bad', `The website ${app.site} is switched off`, 'Switch it on under Websites; its API folder comes back with it.');
    else if (s.testMode) add('address', 'warn', `${app.site} is in test mode`, `The internet gets "Coming soon" for the whole website, its API folder included, until the owner makes it live (Websites → Make live).`);
    else {
      const scheme = s.ssl ? 'https' : 'http';
      const r = await ssh.exec(serverId, `curl -sk -m 8 -o /tmp/.sb-probe -w '%{http_code} %{content_type}' --resolve ${q(`${app.site}:${s.ssl ? 443 : 80}:127.0.0.1`)} ${q(`${scheme}://${app.site}${p}?limit=1`)}; echo " $(head -c 200 /tmp/.sb-probe | tr -d '\n')"; rm -f /tmp/.sb-probe`);
      const code = Number(r.stdout.split(' ')[0]) || 0;
      const json = /application\/json/.test(r.stdout);
      if (json && (first ? code < 500 && !/"Not found"\}/.test(r.stdout) || code === 401 : code === 404)) add('address', 'ok', 'Its website address works', `${scheme}://${app.site}/${app.folder}/…`);
      else add('address', 'bad', `${scheme}://${app.site}${p} does not reach it (${code || 'no answer'})`, 'The routes of the website folder are missing or out of date. "Update the website routes" writes them again.', 'mount');
    }
  } else if (app.domain) {
    const chk = await nginx.checkApiAddress(serverId, app.domain, app.port).catch((err) => ({ ok: false, problem: err.message, fixable: false }));
    if (chk.ok) add('address', 'ok', `Public address works`, app.domain);
    else add('address', 'bad', `The public address ${app.domain} does not reach it`, chk.problem || '', chk.fixable ? 'fix-address' : null);
  } else add('address', 'warn', 'Not published yet', 'Only this server can reach the API. Put it in a website\'s API folder (or give it its own address) so websites and apps can use it.', 'mount');
  done();
});

// Is this folder really its own API server, or a copy of another one (copied in the File Manager
// or by hand)? A copy still carries the other's name, port, PM2 entry and address.
async function identityOf(serverId, name) {
  const read = async (f) => {
    try {
      return JSON.parse((await readRemote(serverId, `${dir(name)}/${f}`)) || 'null');
    } catch {
      return null;
    }
  };
  const [cfg, app, pm2File] = await Promise.all([read('api.config.json'), read('.serverboy-app.json'), read('.serverboy-pm2.json')]);
  const p = pm2File?.apps?.[0];
  // A backup restored as a copy is named <original>-restored-<date>-<time>.
  const restored = /-restored-\d{8}-\d{6}$/.test(name) && !app?.independent ? name.replace(/-restored-\d{8}-\d{6}$/, '') : null;
  const copyOf = [cfg?.name, app?.name, p?.name].find((n) => n && n !== name) || (p?.cwd && p.cwd !== dir(name) ? p.cwd.split('/').pop() : null) || restored;
  const owner = await ssh.exec(serverId, `[ -w ${q(dir(name))} ] && [ -w ${q(`${dir(name)}/.serverboy-app.json`)} ] && echo WRITABLE`);
  return { cfg, app, pm2File, copyOf: copyOf || null, writable: owner.stdout.includes('WRITABLE') };
}

// Make an API server independent: its own name everywhere, its own free port, files it can
// change, and its own PM2 entry. Used for a taken port and for a copied folder. Its public address
// is pointed at the new port only if no other app uses the same address.
router.post('/mongo/apis/:name/move-port', async (req, res) => {
  const serverId = req.params.id;
  const name = apiName(req.params.name);
  await loadConfig(serverId, name);
  const changes = [];
  let id = await identityOf(serverId, name);
  if (!id.writable) {
    const entry = await ssh.connect(serverId);
    await ssh.exec(serverId, `chown -R ${q(entry.server.username)}: ${q(dir(name))}`, { sudo: true, check: true });
    changes.push(`Gave ${entry.server.username} back the files of ${name}`);
    id = await identityOf(serverId, name);
  }
  if (id.copyOf) changes.push(`It was a copy of ${id.copyOf}: it now has its own name`);
  if (id.copyOf && id.app?.site) {
    changes.push(`It no longer claims the API folder /${id.app.folder} of ${id.app.site} (that belongs to ${id.copyOf}). Put it in a website under Settings → Address`);
    delete id.app.site;
    delete id.app.folder;
  }
  const app = id.app || {};
  const old = app.port;
  const port = await freePort(serverId);
  Object.assign(app, { name, port, independent: true });
  // Never keep an address another app also uses: that address belongs to the other app.
  if (app.domain) {
    const r = await ssh.exec(serverId, `grep -l ${q(`"domain": ${JSON.stringify(app.domain)}`)} /var/www/*/.serverboy-app.json 2>/dev/null`);
    const others = r.stdout.split('\n').map((f) => f.split('/')[3]).filter((n) => n && n !== name);
    if (others.length) {
      changes.push(`${app.domain} belongs to ${others.join(', ')}, so this API server no longer claims it. Give it its own address with Publish`);
      app.domain = null;
    }
  }
  await ssh.writeFile(serverId, `${dir(name)}/.serverboy-app.json`, JSON.stringify(app, null, 2), { sudo: false });
  changes.push(`Port ${old || '(none)'} → ${port}`);
  if (id.cfg && id.cfg.name !== name) await ssh.writeFile(serverId, configPath(name), JSON.stringify({ ...id.cfg, name }, null, 2), { sudo: false });
  const p = id.pm2File?.apps?.[0];
  // A copy logs in to MongoDB as the original: give it its own login, so deleting one never breaks the other.
  const database = id.cfg?.database;
  if (id.copyOf && database && DB_RE.test(database)) {
    const dbUser = `api_${name.replace(/-/g, '_')}`;
    const dbPassword = crypto.randomBytes(24).toString('base64url');
    await mongosh(
      serverId,
      `const d = db.getSiblingDB(${JSON.stringify(database)});
const roles = [{ role: 'readWrite', db: ${JSON.stringify(database)} }];
if (d.getUser(${JSON.stringify(dbUser)})) d.updateUser(${JSON.stringify(dbUser)}, { pwd: ${JSON.stringify(dbPassword)}, roles });
else d.createUser({ user: ${JSON.stringify(dbUser)}, pwd: ${JSON.stringify(dbPassword)}, roles });
out({ ok: 1 });`,
    );
    const uri = `mongodb://${dbUser}:${dbPassword}@127.0.0.1:27017/${database}?authSource=${database}`;
    const env = (await readRemote(serverId, `${dir(name)}/.env`)) || '';
    const nextEnv = /^MONGODB_URI=.*$/m.test(env) ? env.replace(/^MONGODB_URI=.*$/m, `MONGODB_URI=${uri}`) : `MONGODB_URI=${uri}\n${env}`;
    await ssh.writeFile(serverId, `${dir(name)}/.env`, nextEnv, { sudo: false });
    await ssh.exec(serverId, `chmod 600 ${q(`${dir(name)}/.env`)}`);
    if (p) p.env = { ...(p.env || {}), MONGODB_URI: uri };
    changes.push(`Its own database login (${dbUser})`);
  }
  if (p) {
    Object.assign(p, { name, cwd: dir(name) });
    p.env = { ...(p.env || {}), PORT: String(port) };
    await ssh.writeFile(serverId, `${dir(name)}/.serverboy-pm2.json`, JSON.stringify(id.pm2File, null, 2), { sudo: false });
    await ssh.exec(serverId, `chmod 600 ${q(`${dir(name)}/.serverboy-pm2.json`)}`);
  }
  if (app.domain) changes.push(...(await nginx.pointSiteToApi(serverId, app.domain, port)));
  let started = false;
  if (p) {
    await pm2.ensureDaemon(serverId);
    const r = await ssh.exec(serverId, `cd ${q(dir(name))} && pm2 delete ${q(name)} >/dev/null 2>&1; pm2 start .serverboy-pm2.json >/dev/null && pm2 save >/dev/null && echo started`);
    started = r.stdout.includes('started');
    if (started) changes.push('Started');
  }
  if (app.site) changes.push(`Routes of ${app.site} updated (${(await mounts.sync(serverId, app.site)).routes} APIs)`);
  audit(req, `Data API ${name}: made independent on port ${port}${id.copyOf ? ` (was a copy of ${id.copyOf})` : ''}`);
  res.json({ ok: true, port, changes, started });
});

// Restart the API server (PM2) and its logs, for people who manage APIs but not Node Apps.
router.post('/mongo/apis/:name/restart', async (req, res) => {
  const name = apiName(req.params.name);
  await loadConfig(req.params.id, name);
  await pm2.ensureDaemon(req.params.id);
  const ident = await identityOf(req.params.id, name);
  if (ident.copyOf) throw new HttpError(409, `${name} is a copy of ${ident.copyOf}: restarting it would restart ${ident.copyOf}. Open Diagnose and click "Make it independent" first.`);
  await ssh.exec(req.params.id, `cd ${q(dir(name))} && (pm2 restart ${q(name)} --update-env >/dev/null 2>&1 || pm2 start .serverboy-pm2.json >/dev/null) && pm2 save >/dev/null && echo ok`, { check: true });
  audit(req, `Data API ${name}: restarted`);
  res.json({ ok: true });
});

router.get('/mongo/apis/:name/logs', async (req, res) => {
  const name = apiName(req.params.name);
  await loadConfig(req.params.id, name);
  const r = await ssh.exec(req.params.id, `tail -n 120 ~/.pm2/logs/${q(name)}-out.log ~/.pm2/logs/${q(name)}-error.log 2>&1`);
  res.json({ log: r.stdout });
});

// ---------- API folders inside websites ----------

// Websites with their API folder, for "where should the API live?".
router.get('/mongo/api-folders', async (req, res) => {
  const list = await mounts.websites(req.params.id);
  res.json(list.filter((w) => scope.canSeeSite(req.user, req.params.id, w.name)));
});

// Rename the API folder of a website (moves every API in it to the new address).
router.post('/mongo/api-folders', async (req, res) => {
  const serverId = req.params.id;
  const site = nginx.validDomain(req.body?.site);
  const folder = mounts.folderName(req.body?.folder);
  scope.requireSite(req, site, 'all');
  if (!scope.isAll(req.user, 'databases')) throw new HttpError(403, 'Renaming a website\'s API folder moves the APIs of every database in it, so it needs access to all databases.');
  const list = (await mounts.servers(serverId)).filter((s) => s.app.site === site && !mounts.isCopy(s));
  if (!list.length) throw new HttpError(404, `${site} has no API folder yet.`);
  const old = list[0].app.folder;
  for (const s of list) await ssh.writeFile(serverId, `${dir(s.name)}/.serverboy-app.json`, JSON.stringify({ ...s.app, folder }, null, 2), { sudo: false });
  try {
    await mounts.sync(serverId, site);
  } catch (err) {
    for (const s of list) await ssh.writeFile(serverId, `${dir(s.name)}/.serverboy-app.json`, JSON.stringify(s.app, null, 2), { sudo: false });
    await mounts.sync(serverId, site).catch(() => {});
    throw err;
  }
  audit(req, `API folder of ${site}: /${old} → /${folder}`);
  res.json({ ok: true, site, folder, old });
});

// Put an API server in a website's API folder (or, with no body, write its routes again).
router.post('/mongo/apis/:name/mount', async (req, res) => {
  const serverId = req.params.id;
  const name = apiName(req.params.name);
  const cfg = migrate(await loadConfig(serverId, name));
  const appFile = `${dir(name)}/.serverboy-app.json`;
  const app = JSON.parse((await readRemote(serverId, appFile)) || '{}');
  if (!app.port) throw new HttpError(409, 'Finish the setup of this API server first.');
  if (mounts.isCopy({ name, cfg, app })) throw new HttpError(409, `${name} is a copy of another API server. Open Diagnose and click "Make it independent" first.`);
  const site = req.body?.site ? nginx.validDomain(req.body.site) : app.site;
  if (!site) throw new HttpError(400, 'Choose a website');
  scope.requireSite(req, site, 'edit');
  const w = (await mounts.websites(serverId)).find((x) => x.name === site);
  if (!w) throw new HttpError(404, `There is no website ${site} on this server (or it is Serverboy itself).`);
  let folder = req.body?.folder ? mounts.folderName(req.body.folder) : app.folder;
  const changes = [];
  if (w.folder && w.folder !== folder && !w.servers.every((x) => x.name === name)) {
    changes.push(`${site} already has the API folder /${w.folder}, so this API server uses it too`);
    folder = w.folder;
  }
  if (!folder) throw new HttpError(400, 'Choose a folder name');
  const before = { site: app.site, folder: app.folder };
  const next = { ...app, site, folder };
  await mounts.check(serverId, site, { name, cfg, app: next });
  await ssh.writeFile(serverId, appFile, JSON.stringify(next, null, 2), { sudo: false });
  try {
    const r = await mounts.sync(serverId, site);
    changes.push(`Its ${r.routes ? `APIs answer at ${r.ssl ? 'https' : 'http'}://${site}/${folder}/…` : `folder is ${site}/${folder}`}`);
    if (r.testMode) changes.push(`${site} is in test mode: the internet gets "Coming soon" until the owner makes it live (Websites)`);
    // Moved from another website: take the routes out of the old one.
    if (before.site && before.site !== site) {
      await mounts.sync(serverId, before.site).catch(() => {});
      changes.push(`Removed from ${before.site}`);
    }
  } catch (err) {
    await ssh.writeFile(serverId, appFile, JSON.stringify(app, null, 2), { sudo: false });
    throw err;
  }
  audit(req, `Data API ${name}: in ${site}/${folder}`);
  res.json({ ok: true, site, folder, changes, paths: mounts.pathsOf(next, cfg) });
});

// Take an API server out of its website folder.
router.post('/mongo/apis/:name/unmount', async (req, res) => {
  const serverId = req.params.id;
  const name = apiName(req.params.name);
  await loadConfig(serverId, name);
  const appFile = `${dir(name)}/.serverboy-app.json`;
  const app = JSON.parse((await readRemote(serverId, appFile)) || '{}');
  if (!app.site) return res.json({ ok: true });
  scope.requireSite(req, app.site, 'edit');
  const { site, folder, ...rest } = app;
  await ssh.writeFile(serverId, appFile, JSON.stringify(rest, null, 2), { sudo: false });
  await mounts.sync(serverId, site).catch(() => {});
  audit(req, `Data API ${name}: removed from ${site}/${folder}`);
  res.json({ ok: true });
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
  const shared = app.domain ? (await ssh.exec(serverId, `grep -l ${q(`"domain": ${JSON.stringify(app.domain)}`)} /var/www/*/.serverboy-app.json 2>/dev/null`)).stdout.split('\n').some((f) => f.split('/')[3] && f.split('/')[3] !== name) : false;
  const own = app.domain ? await require('../lib/self-protect').isOwnSite(serverId, app.domain) : false;
  if (app.domain && !shared && !own) cmd += ` && rm -f ${q(`/etc/nginx/sites-enabled/${app.domain}`)} ${q(`/etc/nginx/sites-available/${app.domain}`)} && (nginx -t && systemctl reload nginx || true)`;
  await ssh.exec(serverId, cmd, { sudo: true, check: true });
  if (app.site) await mounts.sync(serverId, app.site).catch(() => {});
  audit(req, `Deleted data API ${name} (the data in ${cfg.database} was not touched)`);
  res.json({ ok: true });
});

module.exports = router;
