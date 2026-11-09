// API folders inside websites.
//
//   https://<website>/<folder>/<group>/<api>      e.g. https://shop.com/data-k3x9/auth/login
//
// A website has one API folder, named by you (not /api, which everyone tries first). Any number of
// API servers (one per database) can live in that folder, and each API can sit in a group, which
// becomes a sub-folder: Auth APIs, Blog APIs and so on stay apart.
//
// Each API server keeps answering /api/<api> on 127.0.0.1 (so tests and keys work as before).
// Serverboy writes one Nginx route per API into /etc/nginx/serverboy/api/<website>.conf, which the
// website includes, and rewrites it whenever an API is added, renamed, moved or deleted.
const ssh = require('./ssh');
const nginx = require('./nginx');

const { q, HttpError } = ssh;
const DIR = '/etc/nginx/serverboy/api';
const FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
// The [f] makes it a pattern, so Nginx still starts if the file is ever missing.
const includeLine = (site) => `include ${DIR}/${site}.con[f];`;

function folderName(f) {
  const s = String(f || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  if (!FOLDER_RE.test(s)) throw new HttpError(400, 'API folder: 1-40 lowercase letters, numbers, - and _ (for example data-k3x9)');
  return s;
}

// "Auth APIs" -> "auth-apis". Empty: the API sits directly in the folder.
function groupSlug(g) {
  return String(g || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function apiPath(folder, slug, api) {
  const g = groupSlug(api?.group);
  return `/${folder}/${g ? `${g}/` : ''}${slug}`;
}

// The public path of each API of one API server ({} when it is not in a website folder).
function pathsOf(app, cfg) {
  if (!app?.site || !app?.folder) return {};
  return Object.fromEntries(Object.entries(cfg?.apis || {}).map(([slug, a]) => [slug, apiPath(app.folder, slug, a)]));
}

// A public path (as websites call it) -> the path the engine answers on 127.0.0.1.
function toInternal(app, cfg, reqPath) {
  if (!app?.folder || !reqPath.startsWith(`/${app.folder}/`)) return reqPath;
  const [pathOnly, qs = ''] = reqPath.split(/\?(.*)/s);
  for (const [slug, p] of Object.entries(pathsOf(app, cfg)).sort((a, b) => b[1].length - a[1].length)) {
    if (pathOnly === p || pathOnly.startsWith(`${p}/`)) return `/api/${slug}${pathOnly.slice(p.length)}${qs ? `?${qs}` : ''}`;
  }
  return reqPath;
}

// A folder copied from another API server (by hand or by a backup restore) still carries the
// original's identity; it is never routed (Diagnose offers to make it independent).
const isCopy = (s) => Boolean((s.app.name && s.app.name !== s.name) || (s.cfg.name && s.cfg.name !== s.name) || (/-restored-\d{8}-\d{6}$/.test(s.name) && !s.app.independent));

// Every API server on the server: { name, cfg, app }.
async function servers(serverId) {
  const r = await ssh.exec(serverId, `for f in /var/www/*/api.config.json; do [ -f "$f" ] || continue; d=$(dirname "$f"); echo "##API $(basename "$d")"; cat "$f"; echo; echo "##APP"; cat "$d/.serverboy-app.json" 2>/dev/null; echo; done`);
  const out = [];
  for (const chunk of r.stdout.split('##API ').slice(1)) {
    const [head, appJson = ''] = chunk.split('##APP');
    const nl = head.indexOf('\n');
    try {
      out.push({ name: head.slice(0, nl).trim(), cfg: JSON.parse(head.slice(nl + 1)), app: appJson.trim() ? JSON.parse(appJson) : {} });
    } catch {
      /* unreadable settings: skipped (the APIs page shows it as broken) */
    }
  }
  return out;
}

// The routes of one website, from the API servers in its folder. Conflicts: two APIs on one path.
function plan(site, list) {
  const mounted = list.filter((s) => s.app.site === site && s.app.folder && s.app.port && !isCopy(s));
  const folders = [...new Set(mounted.map((s) => s.app.folder))];
  const routes = [];
  const seen = new Map();
  const conflicts = [];
  for (const s of mounted) {
    for (const [slug, a] of Object.entries(s.cfg.apis || {})) {
      const p = apiPath(s.app.folder, slug, a);
      if (seen.has(p)) conflicts.push(`${p} (${seen.get(p)} and ${s.name})`);
      else seen.set(p, s.name);
      routes.push({ path: p, port: Number(s.app.port), slug, server: s.name });
    }
  }
  return { mounted, folders, routes, conflicts };
}

function snippet(site, p, rev = '') {
  if (!p.mounted.length) return `# Serverboy: no API folder on ${site}.\n`;
  const H = 'proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme;';
  const lines = [`# Serverboy: the API folder of ${site}. Written by Serverboy; changes here are overwritten.`];
  for (const f of p.folders) {
    lines.push(`location ^~ /${f}/ { default_type application/json; return 404 '{"error":"Not found"}'; }`);
    // Lets Serverboy see when Nginx serves this version of the routes.
    if (rev) lines.push(`location = /${f}/__serverboy_check { default_type application/json; return 404 '{"error":"Not found","v":"${rev}"}'; }`);
  }
  for (const r of p.routes.sort((a, b) => a.path.localeCompare(b.path))) {
    lines.push(`# ${r.server} → /api/${r.slug}`);
    lines.push(`location = ${r.path} { proxy_pass http://127.0.0.1:${r.port}/api/${r.slug}; ${H} }`);
    lines.push(`location ^~ ${r.path}/ { proxy_pass http://127.0.0.1:${r.port}/api/${r.slug}/; ${H} }`);
  }
  return `${lines.join('\n')}\n`;
}

// What the routes of SITE would be with one API server changed ({ name, cfg, app }, or
// { name, remove: true }). Throws when two APIs would get the same address.
async function check(serverId, site, override) {
  let list = await servers(serverId);
  if (override) {
    list = list.filter((s) => s.name !== override.name);
    if (!override.remove) list.push(override);
  }
  const p = plan(site, list);
  if (p.conflicts.length) throw new HttpError(409, `Two APIs would have the same address: ${p.conflicts.join(', ')}. Give one of them another address or group.`);
  if (p.folders.length > 1) throw new HttpError(409, `${site} already has the API folder /${p.folders.find((f) => f !== override?.app?.folder) || p.folders[0]}. A website has one API folder; use that one (or rename it for the whole website).`);
  return p;
}

// Write the Nginx routes of SITE from the API servers in its folder, and make sure the website
// includes them. Nginx is tested first; on any problem the previous state is put back.
async function sync(serverId, site, override) {
  const p = await check(serverId, site, override);
  const { sites } = await nginx.listSites(serverId);
  const s = sites.find((x) => x.name === site);
  const file = `${DIR}/${site}.conf`;
  if (!s) {
    if (p.mounted.length) throw new HttpError(404, `The website ${site} does not exist any more. Put the API server in another website (API server → Settings → Address).`);
    await ssh.exec(serverId, `rm -f ${q(file)}`, { sudo: true });
    return { folder: null, routes: 0 };
  }
  const siteFile = nginx.siteFile(site);
  const [oldSnippet, conf] = await Promise.all([ssh.exec(serverId, `cat ${q(file)} 2>/dev/null`, { sudo: true }).then((r) => r.stdout), ssh.readFile(serverId, siteFile).then((b) => b.toString('utf8'))]);
  const rev = Date.now().toString(36);
  const next = snippet(site, p, rev);
  await ssh.exec(serverId, `mkdir -p ${q(DIR)}`, { sudo: true, check: true });
  await ssh.writeFile(serverId, file, next, { sudo: true });
  let newConf = conf;
  if (!conf.includes(includeLine(site))) {
    newConf = conf.replace(/^([ \t]*)server_name\s[^;]*;[^\n]*$/gm, (line, indent) => `${line}\n${indent}${includeLine(site)}`);
    if (newConf === conf) throw new HttpError(400, `Could not find a server_name line in ${site}`);
    await ssh.writeFile(serverId, siteFile, newConf, { sudo: true });
  }
  const result = await nginx.testAndReload(serverId);
  if (!result.ok) {
    await ssh.writeFile(serverId, file, oldSnippet || `# Serverboy: no API folder on ${site}.\n`, { sudo: true });
    if (newConf !== conf) await ssh.writeFile(serverId, siteFile, conf, { sudo: true });
    await nginx.testAndReload(serverId);
    throw new HttpError(400, `Nginx rejected the API routes of ${site}, nothing was changed:\n${result.output}`);
  }
  // Nginx reloads in the background: wait (up to 3 s) until it serves the new routes, so the very
  // first call after a change already reaches the API.
  if (p.folders[0]) {
    const url = `${s.ssl ? 'https' : 'http'}://${site}/${p.folders[0]}/__serverboy_check`;
    for (let i = 0; i < 12; i++) {
      const r = await ssh.exec(serverId, `curl -sk -m 2 --resolve ${q(`${site}:${s.ssl ? 443 : 80}:127.0.0.1`)} ${q(url)}`).catch(() => ({ stdout: '' }));
      if (r.stdout.includes(`"v":"${rev}"`)) break;
      await new Promise((res) => setTimeout(res, 250));
    }
  }
  return { folder: p.folders[0] || null, routes: p.routes.length, testMode: s.testMode, ssl: s.ssl };
}

// Websites with their API folder (if any) and the API servers in it.
async function websites(serverId) {
  const [{ installed, sites = [] }, list] = await Promise.all([nginx.listSites(serverId), servers(serverId)]);
  if (!installed) return [];
  const protect = require('./self-protect');
  const out = [];
  for (const s of sites) {
    if (s.name === 'default' || (await protect.isOwnSite(serverId, s.name))) continue;
    const p = plan(s.name, list);
    out.push({ name: s.name, serverNames: s.serverNames, ssl: s.ssl, enabled: s.enabled, testMode: s.testMode, folder: p.folders[0] || null, servers: p.mounted.map((m) => ({ name: m.name, database: m.cfg.database })) });
  }
  return out;
}

const originOf = (site) => `${site.ssl ? 'https' : 'http'}://${site.name}`;

module.exports = { folderName, groupSlug, apiPath, pathsOf, toInternal, isCopy, servers, plan, snippet, check, sync, websites, originOf, DIR, includeLine };
