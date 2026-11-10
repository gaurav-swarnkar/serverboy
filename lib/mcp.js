// MCP connector: lets Claude (claude.ai, Claude Code) or any other AI agent manage Serverboy.
//
//   POST /mcp   Model Context Protocol over Streamable HTTP (JSON-RPC, plain JSON answers,
//               stateless). Needs "Authorization: Bearer sbt_…" (an AI access token).
//   OAuth 2.1 for apps that connect by themselves (claude.ai custom connectors):
//               /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server,
//               /oauth/register (dynamic client registration), /oauth/authorize (you approve,
//               logged in to Serverboy), /oauth/token (PKCE S256, refresh tokens).
//
// Every tool calls Serverboy's own REST API with the same token, so the AI can do exactly what
// its person can: the same role and website / database limits, "read" tokens only look, and the
// self-protection (lib/self-protect.js) applies. Everything it changes is in the activity log.
const crypto = require('crypto');
const express = require('express');
const ai = require('./ai-access');
const auth = require('./auth');
const ssh = require('./ssh');
const team = require('./team');
const { can } = require('./permissions');

const router = express.Router();
const PORT = Number(process.env.PORT) || 3000;
const LOOP = !process.env.HOST || ['0.0.0.0', '::', '127.0.0.1', 'localhost'].includes(process.env.HOST) ? '127.0.0.1' : process.env.HOST;
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SECRET = crypto.randomBytes(32);
const MAX_TEXT = 60000;

const originOf = (req) => `${req.protocol}://${req.get('host')}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Agents in a browser (and MCP inspectors) call these from other sites; no cookies are involved.
function cors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}
router.use(['/mcp', '/oauth/token', '/oauth/register', '/.well-known'], cors);

// ======================= tools =======================

class ToolError extends Error {}

const TEMPLATES = {
  website: { list: 'public', get: 'public', count: 'public', create: 'off', update: 'off', delete: 'off' },
  managed: { list: 'public', get: 'public', count: 'public', create: 'key', update: 'key', delete: 'key' },
  private: { list: 'key', get: 'key', count: 'key', create: 'key', update: 'key', delete: 'key' },
  form: { list: 'off', get: 'off', count: 'off', create: 'public', update: 'off', delete: 'off' },
};
const slugify = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const SERVER = S('Server name or id (from list_servers). Can be left out when there is only one server.');

async function waitJob(c, serverId, jobId, ms = 300000) {
  const until = Date.now() + ms;
  for (;;) {
    const j = await c.api('GET', `/servers/${serverId}/jobs/${jobId}?offset=0`);
    if (j.status !== 'running' || Date.now() > until) return j;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
const tail = (log, n = 25) => String(log || '').trim().split('\n').slice(-n).join('\n');

// name, what it does, its inputs, whether it only reads, and how it runs.
const TOOLS = [
  {
    name: 'list_servers',
    description: 'List the servers in Serverboy (name, id, address). Start here: other tools take a server name or id.',
    read: true,
    run: async (a, c) => (await c.api('GET', '/servers')).map((s) => ({ id: s.id, name: s.name, host: s.host, user: s.username })),
  },
  {
    name: 'server_health',
    description: 'Health of a server: CPU, memory, disk, websites, services, and a list of problems in plain words.',
    props: { server: SERVER },
    read: true,
    run: async (a, c) => c.api('GET', `/servers/${await c.sid(a.server)}/health`),
  },
  {
    name: 'list_websites',
    perm: 'sites',
    description: 'Websites (Nginx sites) on a server: domains, folder or app port, live / test mode, HTTPS.',
    props: { server: SERVER },
    read: true,
    run: async (a, c) => (await c.api('GET', `/servers/${await c.sid(a.server)}/sites`)).sites,
  },
  {
    name: 'create_website',
    perm: 'sites',
    description: 'Create a website. It starts in test mode (visitors see "Coming soon"); use set_website_live to publish it. The domain must point to the server for HTTPS to work.',
    props: {
      server: SERVER,
      domain: S('Domain, e.g. shop.com'),
      type: S('static (HTML files), spa (React/Vue build), php, or proxy (an app on a port)', { enum: ['static', 'spa', 'php', 'proxy'] }),
      port: { type: 'number', description: 'App port, only for type proxy' },
      www: { type: 'boolean', description: 'Also serve www.<domain> (default true)' },
    },
    required: ['domain'],
    run: async (a, c) => c.api('POST', `/servers/${await c.sid(a.server)}/sites`, { domain: a.domain, type: a.type || 'static', port: a.port, www: a.www !== false }),
  },
  {
    name: 'set_website_live',
    perm: 'sites',
    description: 'Make a website live for everyone (live: true), or put it back in test mode (live: false). Making it live needs the owner.',
    props: { server: SERVER, site: S('The website name (its domain)'), live: { type: 'boolean' } },
    required: ['site', 'live'],
    run: async (a, c) => c.api('POST', `/servers/${await c.sid(a.server)}/sites/${encodeURIComponent(a.site)}/test-mode`, { on: !a.live }),
  },
  {
    name: 'enable_https',
    perm: 'sites',
    description: 'Get a free HTTPS certificate (Let\'s Encrypt) for a website. The domain must point to the server and port 80 must be open. Waits for the result.',
    props: { server: SERVER, site: S('The website name (its domain)'), email: S('Email for renewal notices') },
    required: ['site', 'email'],
    run: async (a, c) => {
      const id = await c.sid(a.server);
      const job = await c.api('POST', `/servers/${id}/sites/${encodeURIComponent(a.site)}/ssl`, { email: a.email });
      const j = await waitJob(c, id, job.id);
      return { status: j.status, error: j.error || null, log: tail(j.log) };
    },
  },
  {
    name: 'list_databases',
    perm: 'databases',
    description: 'MongoDB and MariaDB/MySQL databases on a server.',
    props: { server: SERVER },
    read: true,
    run: async (a, c) => {
      const id = await c.sid(a.server);
      const [mongo, mysql] = await Promise.all([c.api('GET', `/servers/${id}/mongo/databases`).catch((e) => ({ error: e.message })), c.api('GET', `/servers/${id}/mysql/databases`).catch((e) => ({ error: e.message }))]);
      return { mongodb: mongo, mysql };
    },
  },
  {
    name: 'list_collections',
    perm: 'databases',
    description: 'Collections of a MongoDB database, with how many documents each has.',
    props: { server: SERVER, database: S('MongoDB database name') },
    required: ['database'],
    read: true,
    run: async (a, c) => c.api('GET', `/servers/${await c.sid(a.server)}/mongo/databases/${encodeURIComponent(a.database)}/collections`),
  },
  {
    name: 'find_documents',
    perm: 'databases',
    description: 'Read documents from a MongoDB collection, with an optional filter (MongoDB query) and sort.',
    props: {
      server: SERVER,
      database: S('Database'),
      collection: S('Collection'),
      filter: { type: 'object', description: 'MongoDB filter, e.g. {"status": "active"}' },
      sort: { type: 'object', description: 'e.g. {"createdAt": -1}' },
      limit: { type: 'number', description: '1-100 (default 20)' },
    },
    required: ['database', 'collection'],
    read: true,
    run: async (a, c) => c.api('POST', `/servers/${await c.sid(a.server)}/mongo/find`, { db: a.database, collection: a.collection, filter: JSON.stringify(a.filter || {}), sort: JSON.stringify(a.sort || {}), limit: Math.min(Number(a.limit) || 20, 100) }),
  },
  {
    name: 'insert_document',
    perm: 'databases',
    description: 'Add one document to a MongoDB collection (the collection is created if needed).',
    props: { server: SERVER, database: S('Database'), collection: S('Collection'), document: { type: 'object', description: 'The document' } },
    required: ['database', 'collection', 'document'],
    run: async (a, c) => c.api('POST', `/servers/${await c.sid(a.server)}/mongo/insert`, { db: a.database, collection: a.collection, document: JSON.stringify(a.document) }),
  },
  {
    name: 'list_apis',
    perm: 'databases',
    description: 'APIs (MongoDB data over HTTPS) on a server, by API server: their public paths (website API folder / group / name), status, and copies.',
    props: { server: SERVER },
    read: true,
    run: async (a, c) =>
      (await c.api('GET', `/servers/${await c.sid(a.server)}/mongo/apis`)).map((s) => ({
        apiServer: s.name,
        database: s.database,
        status: s.status,
        website: s.site ? `${s.site}/${s.folder}` : null,
        ownAddress: s.domain,
        copyOf: s.copyOf,
        apis: (s.apis || []).map((x) => ({ slug: x.slug, title: x.title, collection: x.collection, group: x.group || null, path: s.paths?.[x.slug] || `/api/${x.slug}`, ops: x.ops })),
      })),
  },
  {
    name: 'create_api',
    perm: 'databases',
    description:
      'Create an API for a MongoDB collection. Sets up the database\'s API server first if needed (about a minute). With a website, the API lives at https://<website>/<folder>/<group>/<name>. Templates: website (read-only for everyone), managed (anyone reads, apps with a key change), private (key for everything), form (anyone adds, nobody reads).',
    props: {
      server: SERVER,
      database: S('MongoDB database'),
      collection: S('Collection'),
      title: S('Name, e.g. Products'),
      slug: S('Address name (default: from the title)'),
      group: S('Group / sub-folder, e.g. auth or blog (optional)'),
      template: S('website, managed, private or form (default managed)', { enum: Object.keys(TEMPLATES) }),
      api_server: S('API server to put it on: an existing one of this database, or a new name to set up a new API server (default: the database\'s first API server)'),
      website: S('Website (domain) whose API folder it lives in (optional)'),
      folder: S('API folder name for a website that has none yet (default: random like data-k3x9)'),
    },
    required: ['database', 'collection', 'title'],
    run: async (a, c) => {
      const id = await c.sid(a.server);
      const B = `/servers/${id}/mongo/apis`;
      const services = (await c.api('GET', B)).filter((s) => !s.broken && !s.copyOf && s.database === a.database);
      let svc = a.api_server ? services.find((s) => s.name === a.api_server) : services[0];
      const done = [];
      const folder = a.folder || `data-${crypto.randomBytes(2).toString('hex')}`;
      if (!svc) {
        const name = a.api_server || `${a.database}-api`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
        const job = await c.api('POST', B, { name, database: a.database, ...(a.website ? { site: a.website, folder } : {}) });
        const j = await waitJob(c, id, job.id);
        if (j.status !== 'success') throw new ToolError(`Setting up the API server ${name} failed: ${j.error || j.status}\n${tail(j.log)}`);
        svc = { name, site: a.website || null };
        done.push(`Set up the API server ${name}`);
      }
      const slug = a.slug || slugify(a.title);
      const template = TEMPLATES[a.template] ? a.template : 'managed';
      await c.api('PUT', `${B}/${svc.name}/resources/new`, { slug, title: a.title, group: a.group || '', collection: a.collection, ops: TEMPLATES[template], timestamps: true, callerFilters: template !== 'form' });
      done.push(`Created the API ${slug}`);
      if (a.website && !svc.site) {
        const m = await c.api('POST', `${B}/${svc.name}/mount`, { site: a.website, folder });
        done.push(...m.changes);
      }
      const info = await c.api('GET', `${B}/${svc.name}`);
      return { done, apiServer: svc.name, address: `${info.url || '(private: only the server can call it)'}${info.paths?.[slug] || `/api/${slug}`}`, template };
    },
  },
  {
    name: 'move_api',
    perm: 'databases',
    description: 'Move an API (or, without "api", every API) of an API server to another API server of the same database. Its settings and keys move with it; in the same website folder its address stays the same.',
    props: { server: SERVER, api_server: S('The API server it is on now'), api: S('API slug (leave out to move all of them)'), to: S('The API server to move it to') },
    required: ['api_server', 'to'],
    run: async (a, c) => {
      const B = `/servers/${await c.sid(a.server)}/mongo/apis/${encodeURIComponent(a.api_server)}`;
      return a.api ? c.api('POST', `${B}/resources/${encodeURIComponent(a.api)}/move`, { to: a.to }) : c.api('POST', `${B}/move-all`, { to: a.to });
    },
  },
  {
    name: 'diagnose_api',
    perm: 'databases',
    description: 'Find what is wrong with an API server or one API, step by step, with the suggested next action.',
    props: { server: SERVER, api_server: S('API server name (from list_apis)'), api: S('API slug (optional)') },
    required: ['api_server'],
    read: true,
    run: async (a, c) => c.api('GET', `/servers/${await c.sid(a.server)}/mongo/apis/${encodeURIComponent(a.api_server)}/diagnose${a.api ? `?slug=${encodeURIComponent(a.api)}` : ''}`),
  },
  {
    name: 'restart_api_server',
    perm: 'databases',
    description: 'Restart an API server (the background program that answers a database\'s APIs).',
    props: { server: SERVER, api_server: S('API server name') },
    required: ['api_server'],
    run: async (a, c) => c.api('POST', `/servers/${await c.sid(a.server)}/mongo/apis/${encodeURIComponent(a.api_server)}/restart`),
  },
  {
    name: 'list_services',
    description: 'Background services (systemd) that are running or failed.',
    props: { server: SERVER },
    read: true,
    run: async (a, c) => (await c.api('GET', `/servers/${await c.sid(a.server)}/services`)).filter((s) => s.active === 'active' || s.active === 'failed').map((s) => ({ unit: s.unit, active: s.active, sub: s.sub, enabled: s.enabled, description: s.description })),
  },
  {
    name: 'service_logs',
    perm: 'services',
    description: 'Status and last log lines of a service.',
    props: { server: SERVER, service: S('Service name, e.g. nginx or mongod'), lines: { type: 'number' } },
    required: ['service'],
    read: true,
    run: async (a, c) => (await c.api('GET', `/servers/${await c.sid(a.server)}/services/${encodeURIComponent(a.service)}/logs?lines=${Math.min(Number(a.lines) || 80, 500)}`)).log,
  },
  {
    name: 'service_action',
    perm: 'services',
    description: 'Start, stop, restart or reload a service. Serverboy refuses actions that would take itself, Nginx (on its own server) or SSH offline.',
    props: { server: SERVER, service: S('Service name'), action: S('start, stop, restart or reload', { enum: ['start', 'stop', 'restart', 'reload'] }) },
    required: ['service', 'action'],
    destructive: true,
    run: async (a, c) => c.api('POST', `/servers/${await c.sid(a.server)}/services/${encodeURIComponent(a.service)}/${a.action}`),
  },
  {
    name: 'list_node_apps',
    perm: 'nodeapps',
    description: 'Node.js apps run by PM2: status, port, repository, address.',
    props: { server: SERVER },
    read: true,
    run: async (a, c) => c.api('GET', `/servers/${await c.sid(a.server)}/node-apps`),
  },
  {
    name: 'node_app_action',
    perm: 'nodeapps',
    description: 'Restart, stop, start or redeploy (pull, install, build, restart) a Node.js app.',
    props: { server: SERVER, app: S('App name'), action: S('restart, stop, start or redeploy', { enum: ['restart', 'stop', 'start', 'redeploy'] }) },
    required: ['app', 'action'],
    run: async (a, c) => {
      const id = await c.sid(a.server);
      const r = await c.api('POST', `/servers/${id}/node-apps/${encodeURIComponent(a.app)}/${a.action}`);
      if (r?.id && r.status === 'running') {
        const j = await waitJob(c, id, r.id);
        return { status: j.status, error: j.error || null, log: tail(j.log) };
      }
      return r;
    },
  },
  {
    name: 'node_app_logs',
    perm: 'nodeapps',
    description: 'Last log lines of a Node.js app.',
    props: { server: SERVER, app: S('App name') },
    required: ['app'],
    read: true,
    run: async (a, c) => c.api('GET', `/servers/${await c.sid(a.server)}/node-apps/${encodeURIComponent(a.app)}/logs`),
  },
  {
    name: 'backups_status',
    perm: 'owner',
    description: 'Backup settings, the last backups and test-restores of a server.',
    props: { server: SERVER },
    read: true,
    run: async (a, c) => c.api('GET', `/servers/${await c.sid(a.server)}/backups`),
  },
  {
    name: 'run_backup',
    perm: 'owner',
    description: 'Start a backup of a server now (databases, website files, apps, settings). Returns the task; check it with task_status.',
    props: { server: SERVER },
    run: async (a, c) => c.api('POST', `/servers/${await c.sid(a.server)}/backups/run`),
  },
  {
    name: 'task_status',
    description: 'Status and log of a background task (install, deploy, backup…), by its id.',
    props: { server: SERVER, task: S('Task id') },
    required: ['task'],
    read: true,
    run: async (a, c) => {
      const j = await c.api('GET', `/servers/${await c.sid(a.server)}/jobs/${encodeURIComponent(a.task)}?offset=0`);
      return { title: j.title, status: j.status, error: j.error || null, log: tail(j.log, 60) };
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command on a server over SSH (as the server\'s SSH user; prefix sudo when needed) and return its output. Needs the Terminal permission. Use the other tools when they can do the job.',
    props: { server: SERVER, command: S('The command, e.g. df -h'), timeout_seconds: { type: 'number', description: 'Default 60, at most 600' } },
    required: ['command'],
    destructive: true,
    terminal: true,
    run: async (a, c) => {
      const id = await c.sid(a.server);
      const cmd = String(a.command || '').trim();
      if (!cmd) throw new ToolError('Empty command');
      team.audit({ user: c.user.username, action: `Ran a command on ${id}: ${cmd.slice(0, 200)} (via AI: ${c.token.label})` });
      const r = await ssh.exec(id, cmd, { timeout: Math.min(Number(a.timeout_seconds) || 60, 600) * 1000 });
      return { exitCode: r.code, stdout: r.stdout.slice(-30000), stderr: r.stderr.slice(-10000) };
    },
  },
  {
    name: 'call_api',
    description:
      'Call any Serverboy REST API endpoint (paths under /api, e.g. GET /servers/<id>/firewall, POST /servers/<id>/docker-apps, GET /servers/<id>/mongo/apis/<name>). For things the other tools do not cover. Same permissions as the person who connected.',
    props: { method: S('GET, POST, PUT, PATCH or DELETE', { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }), path: S('Path after /api, starting with /'), body: { type: 'object', description: 'JSON body for POST/PUT/PATCH' } },
    required: ['method', 'path'],
    run: async (a, c) => {
      const p = String(a.path || '');
      if (!p.startsWith('/') || p.includes('..')) throw new ToolError('The path must start with / (for example /servers)');
      return c.api(String(a.method).toUpperCase(), p, a.body);
    },
  },
];

// The tools this person's AI may use: only those their role allows (perm, as in lib/permissions.js;
// owner-only tools only for the owner), "read" tokens only the reading ones, run_command needs
// the Terminal permission. Serverboy checks every call again anyway.
function toolsFor(user, token) {
  return TOOLS.filter((t) => can(user, t.perm ?? null) && (t.read || t.name === 'call_api' || token.access === 'manage') && (!t.terminal || (token.access === 'manage' && can(user, 'terminal'))));
}

function describe(t) {
  return {
    name: t.name,
    title: t.name.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase()),
    description: t.description,
    inputSchema: { type: 'object', properties: t.props || {}, ...(t.required ? { required: t.required } : {}), additionalProperties: false },
    annotations: { readOnlyHint: Boolean(t.read), destructiveHint: Boolean(t.destructive), openWorldHint: false },
  };
}

function context(rawToken, user, token) {
  let servers = null;
  const api = async (method, path, body) => {
    const r = await fetch(`http://${LOOP}:${PORT}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${rawToken}`, 'content-type': 'application/json', 'x-serverboy': '1' },
      body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    if (!r.ok) throw new ToolError(json?.error || `Serverboy answered ${r.status}`);
    return json;
  };
  const sid = async (nameOrId) => {
    servers = servers || (await api('GET', '/servers'));
    if (!nameOrId) {
      if (servers.length === 1) return servers[0].id;
      throw new ToolError(`Which server? ${servers.map((s) => s.name).join(', ') || 'There are no servers yet.'}`);
    }
    const n = String(nameOrId).toLowerCase();
    const s = servers.find((x) => x.id === nameOrId) || servers.find((x) => x.name.toLowerCase() === n);
    if (!s) throw new ToolError(`No server "${nameOrId}". Servers: ${servers.map((x) => x.name).join(', ') || 'none'}`);
    return s.id;
  };
  return { api, sid, user, token };
}

// ======================= MCP (JSON-RPC) =======================

const INSTRUCTIONS =
  'Serverboy is a control panel for Linux servers: websites (Nginx + HTTPS), MongoDB/MySQL databases, APIs over MongoDB (in a website\'s API folder: https://<site>/<folder>/<group>/<api>), Node.js apps, Docker 1-click apps, services, backups and the firewall. Start with list_servers. Prefer the specific tools; use call_api for anything else. Ask before deleting data or stopping things.';

async function handle(msg, req, b, rawToken) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
  if (msg.id === undefined || msg.id === null) return null; // a notification: nothing to answer
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'serverboy', title: 'Serverboy', version: require('../package.json').version },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: toolsFor(b.user, b.token).map(describe) });
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    case 'tools/call': {
      const t = toolsFor(b.user, b.token).find((x) => x.name === msg.params?.name);
      if (!t) return fail(-32602, `Unknown tool: ${msg.params?.name}`);
      try {
        const out = await t.run(msg.params?.arguments || {}, context(rawToken, b.user, b.token));
        let text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
        if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n… (cut: ${text.length} characters in all)`;
        return reply({ content: [{ type: 'text', text: text || 'Done.' }] });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: err.message || String(err) }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

function unauthorized(req, res, message) {
  res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${originOf(req)}/.well-known/oauth-protected-resource"`);
  res.status(401).json({ error: message || 'Connect with an AI access token (Serverboy → AI connector) or sign in with OAuth.' });
}

router.post('/mcp', async (req, res) => {
  const b = await auth.userFromBearer(req);
  if (!b) return unauthorized(req, res);
  const raw = String(req.headers.authorization).replace(/^Bearer\s+/, '');
  const run = (m) => auth.requestContext.run({ viaAi: b.token.label }, () => handle(m, req, b, raw));
  if (Array.isArray(req.body)) {
    const out = (await Promise.all(req.body.map(run))).filter(Boolean);
    return out.length ? res.json(out) : res.status(202).end();
  }
  const out = await run(req.body);
  if (!out) return res.status(202).end();
  res.json(out);
});
// No server-to-client stream: every answer comes back on the POST.
router.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST' }));
router.delete('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());

// ======================= OAuth 2.1 =======================

function protectedResource(req, res) {
  const o = originOf(req);
  res.json({ resource: `${o}/mcp`, authorization_servers: [o], scopes_supported: ai.ACCESS, bearer_methods_supported: ['header'], resource_name: 'Serverboy' });
}
router.get('/.well-known/oauth-protected-resource', protectedResource);
router.get('/.well-known/oauth-protected-resource/mcp', protectedResource);
router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const o = originOf(req);
  res.json({
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ai.ACCESS,
  });
});

router.post('/oauth/register', (req, res) => {
  try {
    const c = ai.registerClient(req.body || {});
    res.status(201).json({ ...c, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  } catch (err) {
    res.status(400).json({ error: err.oauth || 'invalid_client_metadata', error_description: err.message });
  }
});

// A small page (no scripts: the security policy allows none inline).
function page(res, title, body, code = 200) {
  res.status(code).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Serverboy</title>
<style>body{font-family:system-ui,sans-serif;background:#f2f3ef;color:#16231b;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
.card{background:#fff;border-radius:18px;padding:28px;max-width:440px;width:100%;box-shadow:0 8px 30px rgba(0,0,0,.08)}h1{font-size:22px;margin:0 0 10px}p{line-height:1.5;color:#3d4a42}
.btn{display:inline-block;border:0;border-radius:999px;padding:11px 20px;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;background:#e7ebe5;color:#16231b}.primary{background:#14452f;color:#fff}
label.opt{display:block;border:1px solid #dfe4dc;border-radius:12px;padding:10px 12px;margin:8px 0;cursor:pointer}label.opt small{display:block;color:#6b766f}.row{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}
@media (prefers-color-scheme:dark){body{background:#0f1612;color:#e6ece7}.card{background:#17211b}p{color:#b8c3bb}.btn{background:#243129;color:#e6ece7}label.opt{border-color:#2c3a31}}</style></head>
<body><div class="card">${body}</div></body></html>`);
}

const sign = (parts) => crypto.createHmac('sha256', SECRET).update(parts.join('|')).digest('base64url');

function checkParams(q) {
  const client = ai.getClient(String(q.client_id || ''));
  if (!client) return { error: 'This app is not registered with Serverboy. Add the connector again.' };
  const redirect = String(q.redirect_uri || '');
  if (!client.redirect_uris.includes(redirect)) return { error: 'The return address of this app is not the one it registered.' };
  if (q.response_type !== 'code') return { client, redirect, oauthError: 'unsupported_response_type' };
  if (!q.code_challenge || q.code_challenge_method !== 'S256') return { client, redirect, oauthError: 'invalid_request' };
  return { client, redirect };
}

function backTo(redirect, params) {
  const u = new URL(redirect);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  return u.toString();
}

router.get('/oauth/authorize', async (req, res) => {
  const q = req.query;
  const p = checkParams(q);
  if (p.error) return page(res, 'Cannot connect', `<h1>Cannot connect</h1><p>${esc(p.error)}</p>`, 400);
  if (p.oauthError) return res.redirect(backTo(p.redirect, { error: p.oauthError, state: q.state }));
  const user = await auth.userFromRequest(req);
  if (!user) {
    // The login cookie is not sent when coming from another site; a click from this page sends it.
    if (!q.sb) return page(res, 'Connect to Serverboy', `<h1>Connect ${esc(p.client.client_name)} to Serverboy</h1><p>Continue to sign in with your Serverboy account.</p><div class="row"><a class="btn primary" href="${esc(`${req.originalUrl}&sb=1`)}">Continue</a></div>`);
    const back = req.originalUrl;
    return page(res, 'Log in first', `<h1>Log in to Serverboy first</h1><p>Then you come straight back here to approve <b>${esc(p.client.client_name)}</b>.</p><div class="row"><a class="btn primary" href="/?return=${encodeURIComponent(back)}">Log in</a></div>`);
  }
  if (user.viewAs) return page(res, 'Not available', '<h1>Not available</h1><p>You are logged in as someone else ("Log in as"). Exit that first.</p>', 403);
  const csrf = sign([user.id, p.client.client_id, p.redirect, q.code_challenge]);
  const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type'].map((k) => `<input type="hidden" name="${k}" value="${esc(q[k] || '')}">`).join('');
  const wantsRead = String(q.scope || '').trim() === 'read';
  page(
    res,
    'Allow access',
    `<h1>Allow ${esc(p.client.client_name)} to use Serverboy?</h1>
    <p class="small" style="color:#6b766f">The app returns to <b>${esc(new URL(p.redirect).host)}</b>. Only allow apps you started connecting yourself.</p>
    <p>It will act as <b>${esc(user.name || user.username)}</b>: it can do what you can do in Serverboy, and nothing more. Everything it changes is in the activity log, and you can disconnect it any time under <b>AI connector</b>.</p>
    <form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="csrf" value="${esc(csrf)}">
      <label class="opt"><input type="radio" name="access" value="manage" ${wantsRead ? '' : 'checked'}> <b>Look and manage</b><small>See everything and make changes (create websites and APIs, restart, back up…).</small></label>
      <label class="opt"><input type="radio" name="access" value="read" ${wantsRead ? 'checked' : ''}> <b>Only look</b><small>See servers, websites, databases and logs. No changes.</small></label>
      <div class="row"><button class="btn primary" name="decision" value="allow">Allow</button><button class="btn" name="decision" value="deny">Cancel</button></div>
    </form>`,
  );
});

router.post('/oauth/authorize', express.urlencoded({ extended: false }), async (req, res) => {
  const q = req.body || {};
  const p = checkParams(q);
  if (p.error || p.oauthError) return page(res, 'Cannot connect', `<h1>Cannot connect</h1><p>${esc(p.error || 'The request is not valid.')}</p>`, 400);
  const user = await auth.userFromRequest(req);
  if (!user || user.viewAs) return page(res, 'Log in first', '<h1>Log in to Serverboy first</h1><p>Then start connecting again from your AI app.</p>', 401);
  const expected = sign([user.id, p.client.client_id, p.redirect, q.code_challenge]);
  if (!q.csrf || q.csrf.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(q.csrf), Buffer.from(expected))) return page(res, 'Expired', '<h1>This page expired</h1><p>Start connecting again from your AI app.</p>', 400);
  if (q.decision !== 'allow') return res.redirect(backTo(p.redirect, { error: 'access_denied', state: q.state }));
  const access = q.access === 'read' ? 'read' : 'manage';
  const code = ai.createCode({ clientId: p.client.client_id, redirectUri: p.redirect, challenge: q.code_challenge, userId: user.id, username: user.username, access });
  team.audit({ user: user.username, ip: req.ip, action: `Connected the AI app "${p.client.client_name}" (${access === 'read' ? 'only look' : 'look and manage'})` });
  res.redirect(backTo(p.redirect, { code, state: q.state }));
});

router.post('/oauth/token', express.urlencoded({ extended: false }), (req, res) => {
  const b = req.body || {};
  res.setHeader('Cache-Control', 'no-store');
  let out = null;
  if (b.grant_type === 'authorization_code') out = ai.redeemCode({ code: String(b.code || ''), clientId: String(b.client_id || ''), redirectUri: String(b.redirect_uri || ''), verifier: String(b.code_verifier || '') });
  else if (b.grant_type === 'refresh_token') out = ai.refresh({ refreshToken: String(b.refresh_token || ''), clientId: String(b.client_id || '') });
  else return res.status(400).json({ error: 'unsupported_grant_type' });
  if (!out) return res.status(400).json({ error: 'invalid_grant', error_description: 'The code or refresh token is not valid (any more).' });
  res.json(out);
});

module.exports = { router, TOOLS, toolsFor, handle };
