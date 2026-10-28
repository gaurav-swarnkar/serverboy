// Nginx virtual host generation and management.
const ssh = require('./ssh');

const { q, HttpError } = ssh;
const AVAILABLE = '/etc/nginx/sites-available';
const ENABLED = '/etc/nginx/sites-enabled';
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
    root = String(opts.root || `/var/www/${domain}/public_html`).trim();
    if (!/^\/[A-Za-z0-9._\/-]+$/.test(root)) throw new HttpError(400, 'Invalid document root');
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
  const result = await testAndReload(serverId);
  if (!result.ok) {
    await ssh.exec(serverId, `rm -f ${q(file)} ${q(`${ENABLED}/${domain}`)}`, { sudo: true });
    throw new HttpError(400, `Nginx rejected the configuration:\n${result.output}`);
  }
  return { domain, serverNames, type, root, port };
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
  echo "$n|$en|$sn|$root|$proxy|$ssl"
done`,
  );
  if (r.stdout.includes('NO_NGINX')) return { installed: false, sites: [] };
  const sites = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, enabled, serverNames, root, proxy, ssl] = l.split('|');
      return { name, enabled: enabled === '1', serverNames: serverNames.split(/\s+/).filter(Boolean), root, proxy, ssl: ssl === '1' };
    });
  return { installed: true, sites };
}

function siteFile(name) {
  const n = String(name || '');
  if (n !== 'default' && !DOMAIN_RE.test(n)) throw new HttpError(400, 'Invalid site name');
  return `${AVAILABLE}/${n}`;
}

module.exports = { createSite, listSites, testAndReload, siteFile, validDomain, AVAILABLE, ENABLED };
