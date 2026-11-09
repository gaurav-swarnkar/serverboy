// 1-click apps: ready-made apps (WordPress, n8n, Uptime Kuma…) run with Docker Compose.
//
// Each installed app lives in /opt/serverboy-apps/<name>/:
//   app.json            what was installed (catalog id, port, domain, when)
//   docker-compose.yml  generated from the catalog
//   .env                passwords and settings (mode 600)
//   data/…              the app's data (bind mounts, so backups can simply copy the folder)
// Containers only listen on 127.0.0.1, so Docker never opens a port past the firewall; the
// internet reaches an app through Nginx (with HTTPS) on its domain.
const crypto = require('crypto');
const ssh = require('./ssh');
const jobs = require('./jobs');
const nginx = require('./nginx');

const { q, HttpError } = ssh;
const ROOT = '/opt/serverboy-apps';
const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
const pw = (n = 24) => crypto.randomBytes(n).toString('base64url').slice(0, n);

// ---------------- catalog ----------------

const CATALOG = [
  {
    id: 'wordpress',
    name: 'WordPress',
    icon: 'globe',
    tagline: 'Websites and blogs',
    description: 'The most used website and blog builder, with its own MariaDB database. You finish the setup (site title, admin user) in the browser.',
    ram: '512 MB',
    port: 80,
    images: ['wordpress:6-apache', 'mariadb:11.4'],
    fields: [],
    env: () => ({ DB_PASSWORD: pw(), DB_ROOT_PASSWORD: pw() }),
    dirs: [{ path: 'data/html', owner: '33:33' }, { path: 'data/db', owner: '999:999' }],
    compose: (a) => `services:
  db:
    image: mariadb:11.4
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: wordpress
      MARIADB_USER: wordpress
      MARIADB_PASSWORD: \${DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - ./data/db:/var/lib/mysql
  app:
    image: wordpress:6-apache
    restart: unless-stopped
    depends_on: [db]
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: \${DB_PASSWORD}
      WORDPRESS_DB_NAME: wordpress
      # Behind Nginx with HTTPS: tell WordPress the visitor uses https.
      WORDPRESS_CONFIG_EXTRA: |
        if (isset($$_SERVER['HTTP_X_FORWARDED_PROTO']) && $$_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') { $$_SERVER['HTTPS'] = 'on'; }
    volumes:
      - ./data/html:/var/www/html
    ports:
      - "127.0.0.1:${a.hostPort}:80"
`,
    // A consistent database copy next to the files, made before every backup.
    preBackup: 'docker compose exec -T db sh -c \'exec mariadb-dump --single-transaction --all-databases -uroot -p"$MARIADB_ROOT_PASSWORD"\' > data/db-dump.sql',
    pauseForBackup: ['db'],
    afterInstall: 'Open the address to choose the language, site title and admin account.',
  },
  {
    id: 'n8n',
    name: 'n8n',
    icon: 'activity',
    tagline: 'Workflow automation',
    description: 'Connect apps and automate tasks with a visual editor (like Zapier, on your own server). You create the owner account on first visit.',
    ram: '512 MB',
    port: 5678,
    images: ['n8nio/n8n:latest'],
    fields: [{ name: 'timezone', label: 'Time zone for schedules', placeholder: 'Asia/Kolkata', default: 'UTC' }],
    env: (a, f) => ({
      N8N_HOST: a.domain || 'localhost',
      N8N_PROTOCOL: a.https ? 'https' : 'http',
      WEBHOOK_URL: a.domain ? `${a.https ? 'https' : 'http'}://${a.domain}/` : '',
      N8N_SECURE_COOKIE: a.https ? 'true' : 'false',
      GENERIC_TIMEZONE: /^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/.test(f.timezone || '') ? f.timezone : 'UTC',
      N8N_ENCRYPTION_KEY: pw(32),
      // n8n listens on IPv6 (::) by default and crashes where containers have no IPv6.
      N8N_LISTEN_ADDRESS: '0.0.0.0',
    }),
    dirs: [{ path: 'data/n8n', owner: '1000:1000' }],
    compose: (a) => `services:
  app:
    image: n8nio/n8n:latest
    restart: unless-stopped
    env_file: .env
    environment:
      TZ: \${GENERIC_TIMEZONE}
    volumes:
      - ./data/n8n:/home/node/.n8n
    ports:
      - "127.0.0.1:${a.hostPort}:5678"
`,
    afterInstall: 'Open the address and create the owner account.',
  },
  {
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    icon: 'clock',
    tagline: 'Uptime monitoring',
    description: 'Checks your websites and services every minute and alerts you (email, Telegram, Slack and 90 more) when one goes down, with a public status page.',
    ram: '256 MB',
    port: 3001,
    images: ['louislam/uptime-kuma:1'],
    fields: [],
    env: () => ({}),
    dirs: [{ path: 'data/kuma', owner: '0:0' }],
    compose: (a) => `services:
  app:
    image: louislam/uptime-kuma:1
    restart: unless-stopped
    volumes:
      - ./data/kuma:/app/data
    ports:
      - "127.0.0.1:${a.hostPort}:3001"
`,
    afterInstall: 'Open the address and create the admin account, then add your sites to watch.',
  },
];

const byId = (id) => CATALOG.find((c) => c.id === id);
const publicCatalog = () => CATALOG.map(({ id, name, icon, tagline, description, ram, images, fields, afterInstall }) => ({ id, name, icon, tagline, description, ram, images, fields, afterInstall }));

function appName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!NAME_RE.test(n)) throw new HttpError(400, 'Name: lowercase letters, numbers and dashes, starting with a letter (2–31 characters).');
  return n;
}

const dir = (name) => `${ROOT}/${name}`;
const compose = (name, args) => `cd ${q(dir(name))} && docker compose -p sb-${name} ${args}`;

// ---------------- list ----------------

async function list(serverId) {
  const r = await ssh.exec(
    serverId,
    `if ! command -v docker >/dev/null; then echo NO_DOCKER; exit 0; fi
docker compose version >/dev/null 2>&1 || echo NO_COMPOSE
[ -d ${ROOT} ] || exit 0
for d in ${ROOT}/*/; do [ -f "$d/app.json" ] || continue; n=$(basename "$d"); echo "##APP $n"; cat "$d/app.json"; echo; echo "##PS"; (cd "$d" && docker compose -p "sb-$n" ps -a --format json 2>/dev/null); echo; echo "##SIZE $(du -sb "$d/data" 2>/dev/null | cut -f1)"; done`,
    { sudo: true, timeout: 60000 },
  );
  if (r.stdout.includes('NO_DOCKER')) return { docker: false, compose: false, apps: [], catalog: publicCatalog() };
  const apps = [];
  for (const chunk of r.stdout.split('##APP ').slice(1)) {
    const name = chunk.slice(0, chunk.indexOf('\n')).trim();
    try {
      const info = JSON.parse(chunk.slice(chunk.indexOf('\n') + 1, chunk.indexOf('##PS')).trim());
      const psText = chunk.slice(chunk.indexOf('##PS') + 4, chunk.indexOf('##SIZE')).trim();
      // `docker compose ps --format json` prints one JSON object per line (newer) or an array (older).
      let containers = [];
      if (psText.startsWith('[')) containers = JSON.parse(psText);
      else containers = psText.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
      const states = containers.map((c) => ({ service: c.Service, state: c.State, status: c.Status, health: c.Health || '' }));
      const status = !states.length ? 'stopped' : states.every((s) => s.state === 'running') ? 'running' : states.some((s) => s.state === 'running') ? 'partly running' : states.some((s) => s.state === 'restarting') ? 'restarting' : 'stopped';
      const cat = byId(info.app);
      apps.push({ ...info, name, title: cat?.name || info.app, icon: cat?.icon || 'package', status, containers: states, size: Number(chunk.match(/##SIZE (\d+)/)?.[1]) || 0, url: info.domain ? `${info.https ? 'https' : 'http'}://${info.domain}` : null });
    } catch {
      apps.push({ name, broken: true, status: 'unknown' });
    }
  }
  return { docker: true, compose: !r.stdout.includes('NO_COMPOSE'), apps, catalog: publicCatalog() };
}

// A free port on 127.0.0.1 for the app (8100–8999), avoiding ones other apps already claim.
async function freePort(serverId) {
  const r = await ssh.exec(serverId, `ss -ltnH 2>/dev/null | awk '{print $4}' | sed 's/.*://'; cat ${ROOT}/*/app.json 2>/dev/null | grep -o '"hostPort": *[0-9]*' | grep -o '[0-9]*$'`, { sudo: true });
  const used = new Set(r.stdout.split('\n').map(Number).filter(Boolean));
  for (let p = 8100; p < 9000; p++) if (!used.has(p)) return p;
  throw new HttpError(503, 'No free port between 8100 and 8999');
}

// ---------------- install ----------------

function install(serverId, body, { user = 'owner' } = {}) {
  const cat = byId(body.app);
  if (!cat) throw new HttpError(400, 'Unknown app');
  const name = appName(body.name || cat.id);
  const domain = body.domain ? nginx.validDomain(body.domain) : null;
  const https = Boolean(domain && body.https);
  const fields = {};
  for (const f of cat.fields) fields[f.name] = String(body.fields?.[f.name] ?? f.default ?? '').trim().slice(0, 200);
  const ctx = {};
  const steps = [
    {
      label: 'Checking Docker',
      fn: async (log) => {
        const r = await ssh.exec(serverId, 'command -v docker >/dev/null || { echo NO_DOCKER; exit 0; }; docker compose version 2>&1 | head -1; systemctl is-active docker', { sudo: true });
        if (r.stdout.includes('NO_DOCKER')) throw new Error('Docker is not installed. Install "Docker" from the App Store first.');
        if (!/Docker Compose/i.test(r.stdout)) throw new Error('The Docker Compose plugin is missing. Reinstall Docker from the App Store.');
        log(r.stdout);
        const exists = await ssh.exec(serverId, `[ -e ${q(dir(name))} ] && echo EXISTS`, { sudo: true });
        if (exists.stdout.includes('EXISTS')) throw new Error(`An app named "${name}" already exists. Choose another name.`);
      },
    },
    {
      label: 'Preparing the app folder',
      fn: async (log) => {
        const hostPort = await freePort(serverId);
        const a = { name, app: cat.id, hostPort, domain, https, installedAt: new Date().toISOString(), installedBy: user, images: cat.images };
        ctx.app = a;
        const env = cat.env(a, fields);
        const mk = cat.dirs.map((d) => `mkdir -p ${q(`${dir(name)}/${d.path}`)} && chown ${d.owner} ${q(`${dir(name)}/${d.path}`)}`).join(' && ');
        await ssh.exec(serverId, `mkdir -p ${ROOT} && chmod 711 ${ROOT} && mkdir -p ${q(dir(name))} && chmod 700 ${q(dir(name))} && ${mk}`, { sudo: true, check: true });
        await ssh.writeFile(serverId, `${dir(name)}/docker-compose.yml`, cat.compose(a), { sudo: true });
        await ssh.writeFile(serverId, `${dir(name)}/.env`, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { sudo: true });
        await ssh.writeFile(serverId, `${dir(name)}/app.json`, JSON.stringify(a, null, 2), { sudo: true });
        await ssh.exec(serverId, `chmod 600 ${q(`${dir(name)}/.env`)}`, { sudo: true, check: true });
        log(`${dir(name)}, listening on 127.0.0.1:${hostPort}\n`);
      },
    },
    { label: `Downloading ${cat.images.join(', ')} (can take a few minutes the first time)`, sudo: true, cmd: compose(name, 'pull -q'), timeout: 30 * 60 * 1000 },
    { label: `Starting ${cat.name}`, sudo: true, cmd: `${compose(name, 'up -d')} && sleep 3 && ${compose(name, 'ps')}`, timeout: 10 * 60 * 1000 },
    {
      label: 'Waiting for it to answer',
      fn: async (log) => {
        // Wait for a real answer: some apps answer 500/502 while their database starts.
        const r = await ssh.exec(serverId, `last=000; for i in $(seq 1 75); do c=$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:${ctx.app.hostPort}/ || true); last=$c; case "$c" in 000|5*) sleep 2;; *) echo "answers with HTTP $c"; exit 0;; esac; done; echo "last answer: HTTP $last"; [ "$last" != "000" ] && exit 2; exit 1`, { timeout: 180000 });
        log(r.stdout);
        if (r.code === 2) log(`${cat.name} is running but still reports an error. It may need another minute; if it stays like this, check Logs.\n`);
        else if (r.code !== 0) throw new Error(`${cat.name} did not answer within 2½ minutes. Open 1-click apps → ${name} → Logs to see why.`);
      },
    },
  ];
  if (domain) {
    steps.push({
      label: `Publishing on ${domain}`,
      fn: async (log) => {
        await nginx.createSite(serverId, { domain, type: 'proxy', port: ctx.app.hostPort });
        log(`Nginx now forwards http://${domain} to ${cat.name}.\n`);
      },
    });
    if (https) {
      steps.push({
        label: `Getting a free HTTPS certificate for ${domain}`,
        allowFail: true,
        sudo: true,
        cmd: `command -v certbot >/dev/null || { apt-get update -y && apt-get install -y certbot python3-certbot-nginx; }; certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email --redirect -d ${q(domain)}`,
      });
    }
  }
  require('./team').audit({ user, action: `Installed ${cat.name} as "${name}"${domain ? ` on ${domain}` : ''}` });
  return jobs.create(serverId, `Install ${cat.name} (${name})`, steps);
}

// ---------------- actions ----------------

async function readApp(serverId, name) {
  const r = await ssh.exec(serverId, `cat ${q(`${dir(appName(name))}/app.json`)} 2>/dev/null`, { sudo: true });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new HttpError(404, `No app named ${name}`);
  }
}

async function action(serverId, name, act, { deleteData = false, user = 'owner' } = {}) {
  const a = await readApp(serverId, name);
  const team = require('./team');
  if (act === 'start') await ssh.exec(serverId, compose(a.name, 'up -d'), { sudo: true, check: true, timeout: 300000 });
  else if (act === 'stop') await ssh.exec(serverId, compose(a.name, 'stop'), { sudo: true, check: true, timeout: 300000 });
  else if (act === 'restart') await ssh.exec(serverId, compose(a.name, 'restart'), { sudo: true, check: true, timeout: 300000 });
  else if (act === 'update') {
    team.audit({ user, action: `Updated app ${a.name}` });
    return jobs.create(serverId, `Update ${a.name}`, [
      { label: 'Downloading newer images', sudo: true, cmd: compose(a.name, 'pull'), timeout: 30 * 60 * 1000 },
      { label: 'Restarting with them', sudo: true, cmd: `${compose(a.name, 'up -d')} && ${compose(a.name, 'ps')}`, timeout: 600000 },
      { label: 'Removing old images', sudo: true, allowFail: true, cmd: 'docker image prune -f' },
    ]);
  } else if (act === 'delete') {
    await ssh.exec(serverId, compose(a.name, 'down --remove-orphans'), { sudo: true, timeout: 300000 });
    if (deleteData) await ssh.exec(serverId, `rm -rf -- ${q(dir(a.name))}`, { sudo: true, check: true });
    else await ssh.exec(serverId, `mv ${q(dir(a.name))} ${q(`${ROOT}/.removed-${a.name}-${Date.now()}`)}`, { sudo: true, check: true });
    if (a.domain) {
      if (!(await require('./self-protect').isOwnSite(serverId, a.domain))) await ssh.exec(serverId, `rm -f ${q(`/etc/nginx/sites-enabled/${a.domain}`)} ${q(`/etc/nginx/sites-available/${a.domain}`)} && (nginx -t && systemctl reload nginx || true)`, { sudo: true });
    }
  } else throw new HttpError(400, 'Unknown action');
  team.audit({ user, action: `${act} app ${a.name}${act === 'delete' ? (deleteData ? ' (data deleted)' : ' (data kept)') : ''}` });
  return { ok: true };
}

async function logs(serverId, name, lines = 200) {
  const a = await readApp(serverId, name);
  const r = await ssh.exec(serverId, compose(a.name, `logs --no-color --tail ${Math.min(Math.max(Number(lines) || 200, 10), 2000)}`), { sudo: true, timeout: 60000 });
  return r.stdout + r.stderr;
}

// For backups: shell lines that make the app's data safe to copy (database dump, pause), and undo.
function backupHooks(appInfo) {
  const cat = byId(appInfo.app);
  const name = appInfo.name;
  const before = [];
  const after = [];
  if (cat?.preBackup) before.push(`(cd ${q(dir(name))} && ${cat.preBackup.replace(/docker compose /g, `docker compose -p sb-${name} `)}) || echo "  (database dump failed; copying the files anyway)"`);
  for (const svc of cat?.pauseForBackup || []) {
    before.push(`(cd ${q(dir(name))} && docker compose -p sb-${name} pause ${q(svc)} >/dev/null 2>&1) || true`);
    after.push(`(cd ${q(dir(name))} && docker compose -p sb-${name} unpause ${q(svc)} >/dev/null 2>&1) || true`);
  }
  return { before, after };
}

module.exports = { CATALOG, publicCatalog, list, install, action, logs, readApp, backupHooks, appName, ROOT };
