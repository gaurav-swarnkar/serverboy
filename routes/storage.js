// Disk & cleanup: what uses the disk, what can be cleaned safely, and which installed software
// is still used. Everything here needs the "system" permission (lib/permissions.js).
const express = require('express');
const ssh = require('../lib/ssh');
const jobs = require('../lib/jobs');
const catalog = require('../lib/catalog');
const team = require('../lib/team');
const { mongosh } = require('../lib/mongosh');

const { q, HttpError } = ssh;
const router = express.Router({ mergeParams: true });

const PACKAGE_RE = /^[a-z0-9][a-z0-9+.-]{0,100}$/;
// Never offered for removal: the system, remote access, the Azure agent, Serverboy's own needs.
const PROTECTED_RE = /^(linux-|ubuntu-|grub|shim|systemd|udev|openssh|ssh$|sudo$|apt|dpkg|libc|libstdc|bash$|coreutils|util-linux|login$|passwd$|cloud-|walinuxagent|waagent|netplan|network|iproute|iptables|nftables|ca-certificates|openssl$|libssl|python3(\.\d+)?(-minimal)?$|python3-apt|snapd$|e2fsprogs|mount$|init|base-|tzdata|locales|keyboard|console-setup|gnupg|gpg|curl$|wget$|tar$|gzip$|rsync$|nodejs$)/;

const sizeOf = (line) => Number(String(line || '').trim().split(/\s+/)[0]) || 0;

// Sizes of things that can be removed without breaking anything.
const CLEANERS = {
  'apt-cache': {
    label: 'Downloaded package files',
    why: 'Copies of packages apt already installed. apt downloads them again if ever needed.',
    cmd: () => 'apt-get clean && echo "Package cache emptied."',
  },
  autoremove: {
    label: 'Packages nothing needs any more',
    why: 'Installed automatically for something that was removed since (often old Linux kernels).',
    cmd: () => 'DEBIAN_FRONTEND=noninteractive apt-get autoremove -y --purge',
  },
  journal: {
    label: 'Old system logs (journal)',
    why: 'Keeps the newest 100 MB of system logs, deletes older ones.',
    cmd: () => 'journalctl --vacuum-size=100M',
  },
  'old-logs': {
    label: 'Old rotated log files',
    why: 'Compressed or numbered copies of old logs in /var/log (e.g. syslog.2.gz). Current logs are kept.',
    cmd: () => "find /var/log -type f \\( -name '*.gz' -o -regex '.*\\.[0-9]+' -o -name '*.old' \\) -print -delete | wc -l | xargs echo 'Deleted files:'",
  },
  snaps: {
    label: 'Old snap versions',
    why: 'Snap keeps the previous version of each snap after an update. The current ones stay.',
    cmd: () => `snap list --all 2>/dev/null | awk '/disabled/{print $1, $3}' | while read n r; do snap remove "$n" --revision="$r"; done; echo done`,
  },
  crash: {
    label: 'Crash reports',
    why: 'Reports from programs that crashed in the past (/var/crash).',
    cmd: () => 'rm -rf /var/crash/* && echo "Crash reports deleted."',
  },
  'npm-cache': {
    label: 'npm download cache',
    why: 'Copies of Node.js packages npm downloaded before. Deploys download them again if needed.',
    cmd: (u) => `rm -rf "$(getent passwd ${q(u)} | cut -d: -f6)/.npm/_cacache" /root/.npm/_cacache && echo "npm cache emptied."`,
  },
  'pm2-logs': {
    label: 'Node app logs (PM2)',
    why: 'Everything your Node apps printed so far. The apps keep running; new output is logged as usual.',
    cmd: (u) => `find "$(getent passwd ${q(u)} | cut -d: -f6)/.pm2/logs" -type f -exec truncate -s 0 {} + && echo "PM2 logs emptied."`,
  },
  docker: {
    label: 'Unused Docker data',
    why: 'Stopped containers, images no container uses, unused networks and build cache. Volumes (data) are kept.',
    cmd: () => 'docker system prune -af',
  },
  'serverboy-tmp': {
    label: 'Serverboy leftovers',
    why: 'Unfinished uploads and imports in /tmp.',
    cmd: () => 'rm -rf /tmp/.serverboy-* /tmp/serverboy-* && echo "Removed."',
  },
};

// How each App Store item is detected as in use, and its program / data folders.
const APP_USAGE = {
  nginx: { pkgs: 'nginx*', data: '' },
  mongodb: { pkgs: 'mongodb-*', data: '/var/lib/mongodb' },
  mariadb: { pkgs: 'mariadb-*', data: '/var/lib/mysql' },
  redis: { pkgs: 'redis*', data: '/var/lib/redis' },
  nodejs: { pkgs: 'nodejs', data: '' },
  pm2: { pkgs: '', data: '' },
  php: { pkgs: 'php*', data: '' },
  docker: { pkgs: 'docker-ce* containerd.io', data: '/var/lib/docker' },
  certbot: { pkgs: 'certbot python3-certbot*', data: '/etc/letsencrypt' },
  ufw: { pkgs: 'ufw', data: '' },
  fail2ban: { pkgs: 'fail2ban', data: '' },
  git: { pkgs: 'git', data: '' },
};

function overviewScript(user) {
  const appSizes = Object.entries(APP_USAGE)
    .map(([id, a]) => `echo "${id}|$( ${a.pkgs ? `dpkg-query -W -f='\${Installed-Size}\\n' ${a.pkgs} 2>/dev/null | awk '{s+=$1} END {print s*1024+0}'` : 'echo 0'} )|$( ${a.data ? `du -sb ${a.data} 2>/dev/null | cut -f1` : 'echo 0'} )"`)
    .join('\n');
  return `U=${q(user)}; H=$(getent passwd "$U" | cut -d: -f6)
sum() { awk '{s+=$1} END {print s+0}'; }
echo "##DF"; df -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs --output=target,size,used,avail 2>/dev/null | tail -n +2
echo "##CLEAN"
echo "apt-cache|$(du -sb /var/cache/apt/archives 2>/dev/null | cut -f1)"
AR=$(apt-get -s autoremove 2>/dev/null | awk '/^Remv/{print $2}')
echo "autoremove|$( [ -n "$AR" ] && dpkg-query -W -f='\${Installed-Size}\\n' $AR 2>/dev/null | awk '{s+=$1} END {print s*1024+0}' || echo 0 )|$(echo $AR)"
J=$(du -sb /var/log/journal 2>/dev/null | cut -f1); echo "journal|$(( \${J:-0} > 104857600 ? J - 104857600 : 0 ))"
echo "old-logs|$(find /var/log -type f \\( -name '*.gz' -o -regex '.*\\.[0-9]+' -o -name '*.old' \\) -printf '%s\\n' 2>/dev/null | sum)"
echo "snaps|$(command -v snap >/dev/null && snap list --all 2>/dev/null | awk '/disabled/{print "/var/lib/snapd/snaps/"$1"_"$3".snap"}' | xargs -r du -cb 2>/dev/null | tail -1 | cut -f1 || echo 0)"
echo "crash|$(du -sb /var/crash 2>/dev/null | cut -f1)"
echo "npm-cache|$( (du -sb "$H/.npm/_cacache" /root/.npm/_cacache 2>/dev/null | cut -f1) | sum)"
echo "pm2-logs|$(du -sb "$H/.pm2/logs" 2>/dev/null | cut -f1)"
echo "docker|$(command -v docker >/dev/null && docker system df --format '{{.Reclaimable}}' 2>/dev/null | awk '{v=$1; n=v+0; u=v; gsub(/[0-9.]/,"",u); m=1; if(u=="kB"||u=="KB")m=1e3; if(u=="MB")m=1e6; if(u=="GB")m=1e9; if(u=="TB")m=1e12; s+=n*m} END {printf "%d", s}' || echo 0)"
echo "serverboy-tmp|$( (du -sb /tmp/.serverboy-* /tmp/serverboy-* 2>/dev/null | cut -f1) | sum)"
echo "##APPS"
${appSizes}
echo "##USE"
SBPORT=$(grep -oE '^PORT=[0-9]+' /etc/serverboy.env 2>/dev/null | cut -d= -f2); SBPORT=\${SBPORT:-3000}
[ -f /opt/serverboy/server.js ] && echo "serverboy|1"
echo "sites|$(ls /etc/nginx/sites-enabled 2>/dev/null | grep -vx default | wc -l)"
echo "sb-site|$(grep -ls "127.0.0.1:$SBPORT" /etc/nginx/sites-enabled/* 2>/dev/null | wc -l)"
echo "php-sites|$(grep -ls 'fastcgi_pass' /etc/nginx/sites-enabled/* 2>/dev/null | wc -l)"
echo "certs|$(ls /etc/letsencrypt/live 2>/dev/null | grep -v README | wc -l)"
echo "node-apps|$(ls /var/www/*/.serverboy-app.json 2>/dev/null | wc -l)"
echo "mysql-dbs|$(ls -d /var/lib/mysql/*/ 2>/dev/null | xargs -rn1 basename | grep -vxE 'mysql|performance_schema|sys|information_schema|#.*' | wc -l)"
echo "redis-keys|$(command -v redis-cli >/dev/null && timeout 3 redis-cli dbsize 2>/dev/null | tail -1)"
echo "docker-containers|$(command -v docker >/dev/null && docker ps -aq 2>/dev/null | wc -l)"
echo "docker-running|$(command -v docker >/dev/null && docker ps -q 2>/dev/null | wc -l)"
for s in nginx mongod mariadb redis-server docker php8.3-fpm php8.2-fpm php8.1-fpm fail2ban; do echo "svc-$s|$(systemctl is-active $s 2>/dev/null)"; done
echo "ufw|$(ufw status 2>/dev/null | head -1)"`;
}

function parseLines(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf('|');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

// For each installed App Store item: is it used, and why we think so.
function verdicts(installed, use, sizes) {
  const n = (k) => Number(use[k]) || 0;
  const sb = use.serverboy === '1';
  const mongoDbs = (use['mongo-dbs'] || '').split(',').filter((x) => x && x !== '?');
  const own = (dbs) => dbs.includes('serverboy');
  const out = [];
  for (const app of catalog.catalog) {
    if (!installed[app.id]) continue;
    const [program, data] = sizes[app.id] || [0, 0];
    let state = 'unused';
    let reason = '';
    switch (app.id) {
      case 'nginx':
        if (n('sb-site')) [state, reason] = ['needed', 'Serverboy itself is reached through Nginx.'];
        else if (n('sites')) [state, reason] = ['used', `${n('sites')} website(s) use it.`];
        else reason = 'No websites are set up.';
        break;
      case 'mongodb':
        if (use['mongo-dbs'] === '?') [state, reason] = ['used', 'Could not list its databases (add its login under Databases → MongoDB); assume it is used.'];
        else if (own(mongoDbs)) [state, reason] = ['needed', `Serverboy keeps team accounts in it${mongoDbs.length > 1 ? `, and ${mongoDbs.length - 1} other database(s)` : ''}.`];
        else if (mongoDbs.length) [state, reason] = ['used', `${mongoDbs.length} database(s): ${mongoDbs.slice(0, 4).join(', ')}${mongoDbs.length > 4 ? '…' : ''}`];
        else reason = 'It has no databases of its own.';
        break;
      case 'mariadb':
        if (n('mysql-dbs')) [state, reason] = ['used', `${n('mysql-dbs')} database(s).`];
        else reason = 'It has no databases of its own.';
        break;
      case 'redis':
        if (n('redis-keys')) [state, reason] = ['used', `It holds ${n('redis-keys')} key(s).`];
        else reason = 'It is empty (no keys).';
        break;
      case 'nodejs':
        if (sb) [state, reason] = ['needed', 'Serverboy runs on Node.js.'];
        else if (n('node-apps')) [state, reason] = ['used', `${n('node-apps')} Node app(s) / API server(s).`];
        else reason = 'No Node apps are deployed.';
        break;
      case 'pm2':
        if (n('node-apps')) [state, reason] = ['used', `Runs ${n('node-apps')} Node app(s) / API server(s).`];
        else reason = 'No Node apps are deployed.';
        break;
      case 'php':
        if (n('php-sites')) [state, reason] = ['used', `${n('php-sites')} website(s) run PHP.`];
        else reason = 'No website uses PHP.';
        break;
      case 'docker':
        if (n('docker-containers')) [state, reason] = ['used', `${n('docker-containers')} container(s), ${n('docker-running')} running.`];
        else reason = 'No containers.';
        break;
      case 'certbot':
        if (n('certs')) [state, reason] = ['used', `Renews ${n('certs')} HTTPS certificate(s). Removing it makes them expire.`];
        else reason = 'No HTTPS certificates.';
        break;
      case 'ufw':
      case 'fail2ban':
        [state, reason] = ['keep', 'Security: protects the server. Keep it.'];
        break;
      case 'git':
        [state, reason] = ['keep', 'Small, and used to deploy apps from Git.'];
        break;
      default:
        state = 'used';
    }
    out.push({ id: app.id, name: app.name, category: app.category, version: installed[app.id], state, reason, program, data, canUninstall: Boolean(app.uninstall) && state !== 'needed' });
  }
  return out;
}

router.get('/storage', async (req, res) => {
  const entry = await ssh.connect(req.params.id);
  const [status, r, mongoDbs] = await Promise.all([
    ssh.exec(req.params.id, catalog.statusScript()),
    ssh.exec(req.params.id, overviewScript(entry.server.username), { sudo: true, timeout: 120000 }),
    // With the MongoDB login saved in Serverboy (authentication is usually on).
    mongosh(req.params.id, `out(db.adminCommand({ listDatabases: 1, nameOnly: true }).databases.map((d) => d.name).filter((n) => !['admin', 'local', 'config'].includes(n)));`, undefined, { timeout: 20000 }).catch(() => null),
  ]);
  const installed = {};
  for (const line of status.stdout.split('\n')) {
    const [id, ok, ...version] = line.split('|');
    if (id && ok === '1') installed[id] = version.join('|').trim();
  }
  const parts = {};
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^##(\w+)$/);
    if (m) {
      cur = m[1];
      parts[cur] = [];
    } else if (cur) parts[cur].push(line);
  }
  const disks = (parts.DF || [])
    .map((l) => l.trim().split(/\s+/))
    .filter((x) => x.length >= 4)
    .map(([mount, size, used, avail]) => ({ mount, size: Number(size), used: Number(used), avail: Number(avail) }));
  const clean = parseLines((parts.CLEAN || []).join('\n'));
  const cleanups = Object.entries(CLEANERS)
    .map(([id, c]) => {
      const [bytes, extra] = String(clean[id] || '0').split('|');
      return { id, label: c.label, why: c.why, bytes: sizeOf(bytes), packages: id === 'autoremove' ? String(extra || '').split(/\s+/).filter(Boolean) : undefined };
    })
    .filter((c) => c.bytes >= 1024 * 1024 || (c.packages && c.packages.length));
  const sizes = {};
  for (const line of parts.APPS || []) {
    const [id, program, data] = line.split('|');
    if (id) sizes[id] = [sizeOf(program), sizeOf(data)];
  }
  const use = parseLines((parts.USE || []).join('\n'));
  use['mongo-dbs'] = Array.isArray(mongoDbs) ? mongoDbs.join(',') : '?';
  res.json({ disks, cleanups, apps: verdicts(installed, use, sizes) });
});

router.post('/storage/clean', (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((id) => CLEANERS[id]);
  if (!ids.length) throw new HttpError(400, 'Choose something to clean');
  const user = ssh.connect(req.params.id).then((e) => e.server.username);
  const steps = ids.map((id) => ({
    label: CLEANERS[id].label,
    allowFail: true,
    fn: async (log) => {
      const r = await ssh.exec(req.params.id, CLEANERS[id].cmd(await user), { sudo: true, timeout: 10 * 60 * 1000 });
      log(`${(r.stdout + r.stderr).trim().split('\n').slice(-15).join('\n')}\n`);
      if (r.code !== 0) throw new Error(`exit code ${r.code}`);
    },
  }));
  steps.push({ label: 'Free space now', cmd: 'df -h / | tail -1', allowFail: true });
  team.audit({ user: req.user.username, ip: req.ip, action: `Disk cleanup: ${ids.join(', ')}` });
  res.json(jobs.create(req.params.id, 'Disk cleanup', steps));
});

// Biggest folders inside a folder (on the same disk).
router.get('/storage/folders', async (req, res) => {
  const p = String(req.query.path || '/');
  if (!p.startsWith('/') || p.includes('/../') || p.endsWith('/..') || p.length > 500 || /[\0\n]/.test(p)) throw new HttpError(400, 'Invalid path');
  const r = await ssh.exec(
    req.params.id,
    `du -x -B1 -d1 -- ${q(p)} 2>/dev/null | sort -nr | head -31; echo "##FILES"; find ${q(p)} -xdev -maxdepth 1 -type f -printf '%s\\t%p\\n' 2>/dev/null | sort -nr | head -10`,
    { sudo: true, timeout: 120000 },
  );
  const [dirs, files] = r.stdout.split('##FILES');
  const rows = (dirs || '').split('\n').filter(Boolean).map((l) => {
    const [size, ...name] = l.split('\t');
    return { size: Number(size), path: name.join('\t') };
  });
  const total = rows.find((x) => x.path === p.replace(/(.)\/$/, '$1'))?.size || 0;
  res.json({
    path: p,
    total,
    folders: rows.filter((x) => x.path !== p.replace(/(.)\/$/, '$1')),
    files: (files || '').split('\n').filter(Boolean).map((l) => {
      const [size, ...name] = l.split('\t');
      return { size: Number(size), path: name.join('\t') };
    }),
  });
});

// The biggest single files on the main disk (old backups, dumps, logs…).
router.get('/storage/big-files', async (req, res) => {
  const r = await ssh.exec(req.params.id, "find / -xdev -type f -size +50M -printf '%s\\t%TY-%Tm-%Td\\t%p\\n' 2>/dev/null | sort -nr | head -25", { sudo: true, timeout: 180000 });
  res.json(
    r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [size, date, ...name] = l.split('\t');
        return { size: Number(size), modified: date, path: name.join('\t') };
      }),
  );
});

// Installed packages, biggest first, with what you installed yourself vs. what came with the system.
router.get('/storage/packages', async (req, res) => {
  const r = await ssh.exec(
    req.params.id,
    `dpkg-query -W -f='\${Installed-Size}\\t\${Package}\\t\${Priority}\\t\${Essential}\\t\${binary:Summary}\\n' 2>/dev/null | sort -nr | head -60; echo "##MANUAL"; apt-mark showmanual 2>/dev/null`,
  );
  const [list, manual] = r.stdout.split('##MANUAL');
  const mine = new Set((manual || '').split('\n').map((x) => x.trim()));
  res.json(
    list
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [kb, name, priority, essential, summary] = l.split('\t');
        const protectedReason = essential === 'yes' || ['required', 'important'].includes(priority) ? 'Part of the operating system' : PROTECTED_RE.test(name) ? 'Needed by the system, remote access or Serverboy' : '';
        return { name, size: Number(kb) * 1024, summary, manual: mine.has(name), protected: protectedReason };
      }),
  );
});

async function removalPlan(serverId, name) {
  if (!PACKAGE_RE.test(name)) throw new HttpError(400, 'Invalid package name');
  const r = await ssh.exec(serverId, `apt-get -s remove ${q(name)} 2>&1 | awk '/^Remv/{print $2}'`);
  const pkgs = r.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!pkgs.length) throw new HttpError(400, `${name} is not installed`);
  const sizes = await ssh.exec(serverId, `dpkg-query -W -f='\${Package}\\t\${Installed-Size}\\t\${Priority}\\t\${Essential}\\n' ${pkgs.map(q).join(' ')} 2>/dev/null`);
  const rows = sizes.stdout.split('\n').filter(Boolean).map((l) => {
    const [pkg, kb, priority, essential] = l.split('\t');
    return { name: pkg, size: Number(kb) * 1024, protected: essential === 'yes' || ['required', 'important'].includes(priority) || PROTECTED_RE.test(pkg) };
  });
  return { packages: rows, total: rows.reduce((s, x) => s + x.size, 0), blocked: rows.filter((x) => x.protected).map((x) => x.name) };
}

router.post('/storage/packages/preview', async (req, res) => {
  res.json(await removalPlan(req.params.id, String(req.body?.name || '').trim()));
});

router.post('/storage/packages/remove', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const plan = await removalPlan(req.params.id, name);
  if (plan.blocked.length) throw new HttpError(400, `Removing ${name} would also remove ${plan.blocked.join(', ')}, which the system needs. Not removed.`);
  team.audit({ user: req.user.username, ip: req.ip, action: `Removed package ${name} (${plan.packages.map((x) => x.name).join(', ')})` });
  res.json(
    jobs.create(req.params.id, `Remove ${name}`, [
      { label: `Removing ${plan.packages.map((x) => x.name).join(', ')}`, cmd: `DEBIAN_FRONTEND=noninteractive apt-get remove -y ${q(name)}`, sudo: true },
      { label: 'Removing packages nothing needs any more', cmd: 'DEBIAN_FRONTEND=noninteractive apt-get autoremove -y', sudo: true, allowFail: true },
    ]),
  );
});

module.exports = router;
