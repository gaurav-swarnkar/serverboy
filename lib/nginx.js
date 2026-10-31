// Nginx virtual host generation and management.
const path = require('path').posix;
const ssh = require('./ssh');

const { q, HttpError } = ssh;
const AVAILABLE = '/etc/nginx/sites-available';
const ENABLED = '/etc/nginx/sites-enabled';
const SYSTEM_DIRS = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/boot', '/proc', '/sys', '/dev', '/root', '/run', '/var/lib', '/var/log', '/opt/serverboy'];
// Test mode: each site includes TEST_DIR/<site>.conf. While the site is in test mode that file
// shows a "coming soon" page to everyone without the preview cookie; when live it is empty.
const SB_DIR = '/etc/nginx/serverboy';
const TEST_DIR = `${SB_DIR}/test-mode`;
// The [f] makes it a pattern, so Nginx still starts if the file is ever missing.
const testInclude = (site) => `include ${TEST_DIR}/${site}.con[f];`;
const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*$/;

function validDomain(name) {
  const d = String(name || '').trim().toLowerCase();
  if (!DOMAIN_RE.test(d)) throw new HttpError(400, `Invalid domain: ${name}`);
  return d;
}

function siteConfig({ domain, serverNames, type, root, port, phpSocket, ipv6 }) {
  const head = `# Managed by Serverboy (type: ${type})
server {
    listen 80;${ipv6 ? '\n    listen [::]:80;' : ''}
    server_name ${serverNames.join(' ')};
    ${testInclude(domain)}

    access_log /var/log/nginx/${domain}.access.log;
    error_log /var/log/nginx/${domain}.error.log;
    client_max_body_size 100M;
`;
  let body;
  if (type === 'proxy') {
    body = `
    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
`;
  } else if (type === 'php') {
    body = `
    root ${root};
    index index.php index.html index.htm;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:${phpSocket};
    }

    location ~ /\\.(?!well-known) {
        deny all;
    }
`;
  } else {
    const fallback = type === 'spa' ? '/index.html' : '=404';
    body = `
    root ${root};
    index index.html index.htm;

    location / {
        try_files $uri $uri/ ${fallback};
    }

    location ~ /\\.(?!well-known) {
        deny all;
    }
`;
  }
  return `${head}${body}}
`;
}

const PLACEHOLDER = (domain) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${domain}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0}</style>
</head><body><div><h1>${domain} is live</h1><p>Upload your website files to replace this page.</p></div></body></html>
`;

function testSnippet(token) {
  return `# Serverboy test mode: only people with the preview link see this website.
set $sb_preview_ok 0;
if ($cookie_sb_preview = "${token}") { set $sb_preview_ok 1; }
if ($uri ~ "^/(\\.well-known/acme-challenge/|__serverboy-preview$|__serverboy-test-mode\\.html$)") { set $sb_preview_ok 1; }
if ($sb_preview_ok = 0) { return 503; }
add_header X-Robots-Tag "noindex, nofollow" always;
error_page 503 /__serverboy-test-mode.html;
location = /__serverboy-test-mode.html { internal; root ${SB_DIR}; add_header Cache-Control "no-store" always; add_header X-Robots-Tag "noindex, nofollow" always; }
location = /__serverboy-preview {
    if ($arg_t != "${token}") { return 403; }
    add_header Set-Cookie "sb_preview=${token}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax";
    return 302 /;
}
`;
}

const TEST_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Coming soon</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0;text-align:center}p{color:#94a3b8}</style>
</head><body><div><h1>Coming soon</h1><p>This website is being prepared and is not public yet.</p></div></body></html>
`;

// Turn test mode on (returns the preview token) or off for a site.
async function setTestMode(serverId, site, on) {
  const file = siteFile(site);
  const snippet = `${TEST_DIR}/${site}.conf`;
  // Keep the same preview link when a site goes back into test mode.
  const r = await ssh.exec(serverId, `grep -oE '(sb_preview=|preview token: )[A-Za-z0-9]+' ${q(snippet)} 2>/dev/null | head -1 | sed -E 's/.*[=:] ?//'`, { sudo: true });
  const token = r.stdout.trim() || require('crypto').randomBytes(16).toString('hex');
  await ssh.exec(serverId, `mkdir -p ${q(TEST_DIR)} && [ -f ${q(`${SB_DIR}/__serverboy-test-mode.html`)} ] || true`, { sudo: true, check: true });
  await ssh.writeFile(serverId, `${SB_DIR}/__serverboy-test-mode.html`, TEST_PAGE, { sudo: true });
  await ssh.writeFile(serverId, snippet, on ? testSnippet(token) : `# live (last preview token: ${token})\n`, { sudo: true });
  // Sites made before test mode existed get the include line after each server_name.
  const conf = (await ssh.readFile(serverId, file)).toString('utf8');
  let backup = null;
  if (!conf.includes(testInclude(site))) {
    backup = conf;
    const next = conf.replace(/^([ \t]*)server_name\s[^;]*;[^\n]*$/gm, (line, indent) => `${line}\n${indent}${testInclude(site)}`);
    await ssh.writeFile(serverId, file, next, { sudo: true });
  }
  const result = await testAndReload(serverId);
  if (!result.ok) {
    if (backup !== null) await ssh.writeFile(serverId, file, backup, { sudo: true });
    await ssh.writeFile(serverId, snippet, '# live\n', { sudo: true });
    await testAndReload(serverId);
    throw new HttpError(400, `Nginx rejected the test-mode settings, nothing was changed:\n${result.output}`);
  }
  return on ? token : null;
}

async function testAndReload(serverId) {
  const r = await ssh.exec(serverId, 'nginx -t 2>&1', { sudo: true });
  if (r.code !== 0) return { ok: false, output: r.stdout + r.stderr };
  await ssh.exec(serverId, 'systemctl reload nginx', { sudo: true, check: true });
  return { ok: true };
}

async function createSite(serverId, opts) {
  const domain = validDomain(opts.domain);
  const type = ['static', 'spa', 'php', 'proxy'].includes(opts.type) ? opts.type : 'static';
  const serverNames = [domain];
  if (opts.www && !domain.startsWith('www.')) serverNames.push(`www.${domain}`);
  for (const a of opts.aliases || []) if (a) serverNames.push(validDomain(a));

  const check = await ssh.exec(serverId, `command -v nginx >/dev/null || echo NO_NGINX; [ -e ${q(`${AVAILABLE}/${domain}`)} ] && echo EXISTS; [ -f /proc/net/if_inet6 ] && echo IPV6; ls /run/php/php*-fpm.sock 2>/dev/null | sort -V | tail -1`);
  if (check.stdout.includes('NO_NGINX')) throw new HttpError(400, 'Nginx is not installed. Install it from the App Store first.');
  if (check.stdout.includes('EXISTS')) throw new HttpError(409, `A site named ${domain} already exists`);
  const phpSocket = check.stdout.split('\n').find((l) => l.startsWith('/run/php/'));
  if (type === 'php' && !phpSocket) throw new HttpError(400, 'PHP-FPM is not installed or not running. Install PHP-FPM from the App Store first.');

  let root = null;
  let port = null;
  if (type === 'proxy') {
    port = Number(opts.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Enter the port your app listens on');
  } else {
    root = path.normalize(String(opts.root || `/var/www/${domain}/public_html`).trim());
    if (!/^\/[A-Za-z0-9._\/-]+$/.test(root)) throw new HttpError(400, 'Invalid document root');
    // The web root is chown'ed to the SSH user below, so never allow a system folder.
    if (SYSTEM_DIRS.some((d) => root === d || root.startsWith(`${d}/`)) || ['/', '/var', '/home', '/srv', '/opt'].includes(root)) {
      throw new HttpError(400, `${root} is a system folder and cannot be a website folder. Use something under /var/www.`);
    }
    if (opts.restrictRoot) {
      const real = (await ssh.exec(serverId, `realpath -m -- ${q(root)}`, { check: true })).stdout.trim();
      if (!real.startsWith('/var/www/')) throw new HttpError(403, 'Team members can only use website folders inside /var/www.');
      root = real;
    }
    const entry = await ssh.connect(serverId);
    const owner = entry.server.username;
    // Give the SSH user ownership of the web root so the file manager can upload without sudo (like cPanel).
    const r = await ssh.exec(
      serverId,
      `mkdir -p ${q(root)} && chown -R ${q(owner)}: ${q(root)} && chmod 755 ${q(root)}
[ -z "$(ls -A ${q(root)})" ] && echo EMPTY || true`,
      { sudo: true, check: true },
    );
    if (r.stdout.includes('EMPTY')) await ssh.writeFile(serverId, `${root}/index.html`, PLACEHOLDER(domain));
  }

  const config = siteConfig({ domain, serverNames, type, root, port, phpSocket, ipv6: check.stdout.includes('IPV6') });
  const file = `${AVAILABLE}/${domain}`;
  await ssh.writeFile(serverId, file, config, { sudo: true });
  await ssh.exec(serverId, `ln -sf ${q(file)} ${q(`${ENABLED}/${domain}`)}`, { sudo: true, check: true });
  // New websites start in test mode (opts.live skips it, e.g. for API servers and apps).
  await ssh.exec(serverId, `mkdir -p ${q(TEST_DIR)}`, { sudo: true, check: true });
  await ssh.writeFile(serverId, `${TEST_DIR}/${domain}.conf`, '# live\n', { sudo: true });
  const result = await testAndReload(serverId);
  if (!result.ok) {
    await ssh.exec(serverId, `rm -f ${q(file)} ${q(`${ENABLED}/${domain}`)}`, { sudo: true });
    throw new HttpError(400, `Nginx rejected the configuration:\n${result.output}`);
  }
  const previewToken = opts.testMode ? await setTestMode(serverId, domain, true) : null;
  return { domain, serverNames, type, root, port, testMode: Boolean(previewToken), previewToken };
}

async function listSites(serverId) {
  const r = await ssh.exec(
    serverId,
    `[ -d ${AVAILABLE} ] || { echo NO_NGINX; exit 0; }
for f in ${AVAILABLE}/*; do
  [ -f "$f" ] || continue
  n=$(basename "$f"); en=0; [ -e "${ENABLED}/$n" ] && en=1
  sn=$(grep -m1 -E '^\\s*server_name' "$f" | sed -E 's/^\\s*server_name\\s+//; s/;.*//')
  root=$(grep -m1 -E '^\\s*root\\s' "$f" | sed -E 's/^\\s*root\\s+//; s/;.*//')
  proxy=$(grep -m1 -E '^\\s*proxy_pass' "$f" | sed -E 's/^\\s*proxy_pass\\s+//; s/;.*//')
  ssl=0; grep -Eq '^\\s*(listen\\s.*443|ssl_certificate\\s)' "$f" && ssl=1
  tok=$(grep -o 'sb_preview=[A-Za-z0-9]*' "${TEST_DIR}/$n.conf" 2>/dev/null | head -1 | cut -d= -f2)
  echo "$n|$en|$sn|$root|$proxy|$ssl|$tok"
done`,
  );
  if (r.stdout.includes('NO_NGINX')) return { installed: false, sites: [] };
  const sites = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, enabled, serverNames, root, proxy, ssl, token] = l.split('|');
      return { name, enabled: enabled === '1', serverNames: serverNames.split(/\s+/).filter(Boolean), root, proxy, ssl: ssl === '1', testMode: Boolean(token), previewToken: token || null };
    });
  return { installed: true, sites };
}

// Make DOMAIN answer the API on PORT. Missing site: a new proxy site. A proxy site pointing
// elsewhere: its local proxy_pass is moved to PORT. A static/PHP website: it keeps its pages and
// gets a "location /api/" block (plus /health) that forwards to the API. Disabled: enabled again.
// Returns a list of what changed (empty when it was already right).
async function pointSiteToApi(serverId, domainIn, portIn) {
  const domain = validDomain(domainIn);
  const port = Number(portIn);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'The API has no port');
  const { installed, sites } = await listSites(serverId);
  if (!installed) throw new HttpError(400, 'Nginx is not installed. Install it from the App Store first.');
  const site = sites.find((x) => x.name === domain) || sites.find((x) => x.serverNames.includes(domain));
  if (!site) {
    await createSite(serverId, { domain, type: 'proxy', port });
    return [`Created the website ${domain}, forwarding to the API`];
  }
  const changes = [];
  const file = siteFile(site.name);
  const target = `http://127.0.0.1:${port}`;
  const conf = (await ssh.readFile(serverId, file)).toString('utf8');
  let next = conf;
  if (/^[ \t]*proxy_pass\s/m.test(conf) || /^[ \t]*location \/api\/ \{ proxy_pass /m.test(conf)) {
    next = conf.replace(/(^[ \t]*|location \/api\/ \{ |location = \/health \{ )proxy_pass\s+http:\/\/(127\.0\.0\.1|localhost):\d+\/?;/gm, `$1proxy_pass ${target};`);
    next = next.replace(/(# Serverboy: the Data API on port )\d+/g, `$1${port}`);
    if (next !== conf) changes.push(`Pointed ${site.name} to the API (port ${port})`);
    else if (!next.includes(target)) throw new HttpError(409, `${site.name} forwards to ${site.proxy}, not to this server. Change it under Websites → Config.`);
  } else {
    const block = (indent) => `${indent}# Serverboy: the Data API on port ${port}
${indent}location /api/ { proxy_pass ${target}; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; }
${indent}location = /health { proxy_pass ${target}; }`;
    next = conf.replace(/^([ \t]*)server_name\s[^;]*;[^\n]*$/gm, (line, indent) => `${line}\n${block(indent)}`);
    if (next === conf) throw new HttpError(400, `Could not find a server_name line in ${site.name}`);
    changes.push(`Added /api/ to the website ${site.name} (its pages stay as they are)`);
  }
  if (next !== conf) await ssh.writeFile(serverId, file, next, { sudo: true });
  if (!site.enabled) {
    await ssh.exec(serverId, `ln -sf ${q(file)} ${q(`${ENABLED}/${site.name}`)}`, { sudo: true, check: true });
    changes.push(`Enabled ${site.name}`);
  }
  if (changes.length) {
    const result = await testAndReload(serverId);
    if (!result.ok) {
      await ssh.writeFile(serverId, file, conf, { sudo: true });
      if (!site.enabled) await ssh.exec(serverId, `rm -f ${q(`${ENABLED}/${site.name}`)}`, { sudo: true });
      await testAndReload(serverId);
      throw new HttpError(400, `Nginx rejected the change, nothing was changed:\n${result.output}`);
    }
  }
  return changes;
}

// Ask Nginx on the server (as the internet would) whether DOMAIN reaches the API engine.
async function checkApiAddress(serverId, domainIn, port) {
  const domain = validDomain(domainIn);
  const { sites = [] } = await listSites(serverId);
  const site = sites.find((x) => x.name === domain) || sites.find((x) => x.serverNames.includes(domain));
  const probe = (scheme) =>
    `curl -sk -m 6 -o /tmp/.sb-probe -w '%{http_code} %{content_type}' --resolve ${q(`${domain}:${scheme === 'https' ? 443 : 80}:127.0.0.1`)} ${q(`${scheme}://${domain}/api/__serverboy_check`)}; echo " $(head -c 300 /tmp/.sb-probe | tr -d '\\n')"; rm -f /tmp/.sb-probe`;
  const r = await ssh.exec(serverId, `${probe('http')}; echo; ${site?.ssl ? probe('https') : 'echo'}`);
  const [httpLine = '', httpsLine = ''] = r.stdout.split('\n');
  const reaches = (line) => /application\/json/.test(line) && /There is no API called|"error"/.test(line);
  const code = (line) => Number(line.split(' ')[0]) || 0;
  const res = { domain, site: site ? { name: site.name, enabled: site.enabled, proxy: site.proxy || null, root: site.root || null, ssl: site.ssl, testMode: site.testMode } : null, http: code(httpLine), https: site?.ssl ? code(httpsLine) : null };
  res.ok = site?.ssl ? reaches(httpsLine) || (reaches(httpLine) && code(httpsLine) === 0) : reaches(httpLine);
  if (res.ok) res.problem = null;
  else if (!site) res.problem = `Nginx has no website for ${domain}, so it answers with its default page (404).`;
  else if (!site.enabled) res.problem = `The website ${site.name} is disabled.`;
  else if (site.testMode) res.problem = `The website ${site.name} is in test mode, so the internet gets "Coming soon" (503). The owner can make it live under Websites.`;
  else if (site.proxy && site.proxy.replace(/\/$/, '') !== `http://127.0.0.1:${port}`) res.problem = `The website ${site.name} forwards to ${site.proxy}, but this API listens on port ${port}.`;
  else if (res.http === 502 || res.https === 502) res.problem = `Nginx forwards ${domain} to a port where this API is not answering (502); the API listens on port ${port}.`;
  else if (!site.proxy) res.problem = `${site.name} is a normal website (files in ${site.root || 'a folder'}), so /api/… is looked up as a file and gives 404.`;
  else res.problem = `Nginx answered ${res.https || res.http || 'nothing'} instead of the API. Is the API server running?`;
  res.fixable = !res.ok && !(site && site.testMode) && !(site?.proxy && !/127\.0\.0\.1|localhost/.test(site.proxy));
  return res;
}

function siteFile(name) {
  const n = String(name || '');
  if (n !== 'default' && !DOMAIN_RE.test(n)) throw new HttpError(400, 'Invalid site name');
  return `${AVAILABLE}/${n}`;
}

module.exports = { pointSiteToApi, checkApiAddress, createSite, listSites, testAndReload, siteFile, validDomain, setTestMode, AVAILABLE, ENABLED };
