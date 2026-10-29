// Server health: essential services, websites (real HTTP checks), Node apps, disk and memory,
// plus a diagnosis of known problems with one-click fixes.
const ssh = require('./ssh');

const { q, HttpError } = ssh;

const ESSENTIAL = [
  { unit: 'ssh', name: 'SSH', why: 'Remote login. If it stops, nobody (including Serverboy) can connect.', always: true },
  { unit: 'nginx', name: 'Nginx', why: 'Web server: every website and app domain goes through it.' },
  { unit: 'mongod', name: 'MongoDB', why: 'Database used by your apps.' },
  { unit: 'mariadb', name: 'MariaDB', why: 'MySQL database (WordPress, PHP apps).' },
  { unit: 'redis-server', name: 'Redis', why: 'Cache / queue used by apps.' },
  { unit: 'docker', name: 'Docker', why: 'Runs containers.' },
  { unit: 'fail2ban', name: 'Fail2ban', why: 'Blocks attackers guessing SSH passwords.' },
  { unit: 'cron', name: 'Cron', why: 'Scheduled jobs and certificate renewal.' },
  { unit: 'serverboy', name: 'Serverboy', why: 'This control panel (when installed on this server).' },
];

const SERVICE_RE = /^[A-Za-z0-9@._:-]+$/;

function sections(text) {
  const out = {};
  let current = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^##([A-Z0-9]+)$/);
    if (m) {
      current = m[1];
      out[current] = [];
    } else if (current) out[current].push(line);
  }
  return out;
}

function parseShow(block) {
  const o = {};
  for (const line of block) {
    const i = line.indexOf('=');
    if (i > 0) o[line.slice(0, i)] = line.slice(i + 1);
  }
  return o;
}

async function check(serverId) {
  const entry = await ssh.connect(serverId);
  const user = entry.server.username;
  const units = ESSENTIAL.map((e) => e.unit);
  const script = `
units="${units.join(' ')} pm2-${user} $(systemctl list-units --all --plain --no-legend 'php*-fpm.service' 2>/dev/null | awk '{print $1}' | sed 's/\\.service$//')"
echo "##UNITS"
for u in $units; do
  systemctl show "$u" -p Id,LoadState,ActiveState,SubState,UnitFileState,Result,NRestarts --no-pager 2>/dev/null
  echo "SinceEpoch=$(date -d "$(systemctl show -p ActiveEnterTimestamp --value "$u" 2>/dev/null)" +%s 2>/dev/null)"
  echo "--"
done
echo "##LISTEN"
ss -ltnH 2>/dev/null | awk '{print $4}'
echo "##SITES"
for f in /etc/nginx/sites-enabled/*; do
  [ -f "$f" ] || continue
  d=$(grep -m1 -E '^\\s*server_name' "$f" | sed -E 's/^\\s*server_name\\s+//; s/;.*//' | awk '{print $1}')
  [ -z "$d" ] || [ "$d" = "_" ] && continue
  ssl=0; grep -Eq '^\\s*(listen\\s.*443|ssl_certificate\\s)' "$f" && ssl=1
  port=$(grep -m1 -E '^\\s*proxy_pass' "$f" | grep -oE ':[0-9]+' | tr -d ':')
  if [ "$ssl" = 1 ]; then
    r=$(curl -s -o /dev/null -m 8 -w '%{http_code} %{time_total}' --resolve "$d:443:127.0.0.1" "https://$d/"); rc=$?
    end=$(echo | timeout 5 openssl s_client -servername "$d" -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    days=""; [ -n "$end" ] && days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
  else
    r=$(curl -s -o /dev/null -m 8 -w '%{http_code} %{time_total}' -H "Host: $d" http://127.0.0.1/); rc=$?; days=""
  fi
  echo "$d|$ssl|$r|$rc|$days|$port|$(basename "$f")"
done
echo "##PM2"
command -v pm2 >/dev/null && pm2 jlist 2>/dev/null | tail -1; echo
echo "##RES"
df -P / | tail -1 | awk '{print $5}' | tr -d '%'
awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} /SwapTotal/{s=$2} END{print t, a, s}' /proc/meminfo
echo "##END"
`;
  const r = await ssh.exec(serverId, script, { timeout: 90000 });
  const s = sections(r.stdout);
  const listening = new Set((s.LISTEN || []).map((a) => a.split(':').pop()).filter(Boolean));
  const problems = [];

  // ---- services ----
  const blocks = [];
  let cur = [];
  for (const line of s.UNITS || []) {
    if (line === '--') {
      blocks.push(parseShow(cur));
      cur = [];
    } else cur.push(line);
  }
  const services = [];
  for (const b of blocks) {
    const unit = (b.Id || '').replace(/\.service$/, '');
    if (!unit || b.LoadState !== 'loaded') continue;
    const meta = ESSENTIAL.find((e) => e.unit === unit) ||
      (unit.startsWith('pm2-') ? { name: 'PM2 (Node apps on boot)', why: 'Starts your Node apps after a reboot.' } : null) ||
      (/^php.*-fpm$/.test(unit) ? { name: `PHP-FPM (${unit.replace(/^php|-fpm$/g, '')})`, why: 'Runs PHP for PHP websites.' } : { name: unit, why: '' });
    const ok = b.ActiveState === 'active';
    let state = ok ? 'ok' : b.ActiveState === 'failed' || b.Result !== 'success' ? 'bad' : 'warn';
    // ufw-style oneshot units sit in "exited"; that is fine. A unit that is simply off but not
    // enabled on boot is just unused.
    if (!ok && b.UnitFileState !== 'enabled' && b.ActiveState === 'inactive') state = 'off';
    const since = ok && Number(b.SinceEpoch) ? Number(b.SinceEpoch) * 1000 : null;
    const svc = {
      unit,
      name: meta.name,
      why: meta.why,
      active: b.ActiveState,
      sub: b.SubState,
      enabled: b.UnitFileState,
      restarts: Number(b.NRestarts) || 0,
      since,
      state,
    };
    if (unit === 'nginx' && state === 'warn') svc.state = state = 'bad';
    services.push(svc);
    if (state === 'bad') problems.push({ level: 'bad', area: 'service', target: unit, text: `${meta.name} is ${b.ActiveState === 'failed' ? 'crashed (failed)' : b.ActiveState}.`, hint: 'Click Diagnose to see why.' });
    else if (state === 'warn') problems.push({ level: 'warn', area: 'service', target: unit, text: `${meta.name} is ${b.ActiveState} but set to start on boot.`, hint: 'Start it, or Diagnose if it will not start.' });
  }

  // ---- websites ----
  const sites = (s.SITES || []).filter(Boolean).map((line) => {
    const [domain, ssl, result, rc, days, port, file] = line.split('|');
    const [code, time] = (result || '').split(' ');
    const httpCode = Number(code) || 0;
    const exit = Number(rc) || 0;
    const site = { domain, file, ssl: ssl === '1', code: httpCode, ms: Math.round(Number(time) * 1000) || null, certDays: days === '' ? null : Number(days), port: port || null };
    let level = 'ok';
    let text = '';
    if (exit === 60 || exit === 35) {
      level = 'bad';
      text = 'The SSL certificate is invalid or expired.';
    } else if (!httpCode) {
      level = 'bad';
      text = exit === 28 ? 'The site timed out (no answer in 8 s).' : 'Nginx is not answering.';
    } else if (httpCode === 502 || httpCode === 504) {
      level = 'bad';
      text = port && !listening.has(port)
        ? `The app behind this site is down: nothing is listening on port ${port}. Start the Node app.`
        : 'The app behind this site is not responding (bad gateway).';
    } else if (httpCode >= 500) {
      level = 'bad';
      text = `The site returns an error (${httpCode}). Check its app or PHP logs.`;
    } else if (httpCode === 404) {
      level = 'warn';
      text = 'Page not found (404). Is there an index.html / index.php in the site folder?';
    } else if (httpCode === 403) {
      level = 'warn';
      text = 'Forbidden (403). Often means the folder has no index file, or wrong permissions.';
    }
    if (level === 'ok' && site.certDays !== null && site.certDays < 14) {
      level = site.certDays < 0 ? 'bad' : 'warn';
      text = site.certDays < 0 ? 'The SSL certificate has expired.' : `The SSL certificate expires in ${site.certDays} days and has not renewed yet.`;
    }
    site.level = level;
    site.text = text;
    return site;
  });
  const nginx = services.find((x) => x.unit === 'nginx');
  const nothingAnswers = sites.length > 1 && sites.every((x) => !x.code);
  if (sites.length && ((nginx && nginx.state !== 'ok') || nothingAnswers)) {
    // One cause, one problem: every site is down because the web server is.
    const why = nginx && nginx.state !== 'ok' ? 'Nginx is not running' : 'Nginx is not answering on port 80/443';
    for (const site of sites) Object.assign(site, { level: 'bad', text: `Down because ${why}.` });
    problems.push({ level: 'bad', area: 'site', target: 'nginx', text: `All ${sites.length} website(s) are down because ${why}.`, hint: 'Diagnose Nginx.' });
  } else {
    for (const site of sites) if (site.level !== 'ok') problems.push({ level: site.level, area: 'site', target: site.domain, text: `${site.domain}: ${site.text}` });
  }

  // ---- Node apps (PM2) ----
  let apps = [];
  try {
    apps = JSON.parse((s.PM2 || []).join('').trim() || '[]').map((p) => ({
      name: p.name,
      status: p.pm2_env?.status,
      restarts: p.pm2_env?.restart_time ?? 0,
      memory: p.monit?.memory ?? 0,
    }));
  } catch {
    apps = [];
  }
  for (const a of apps) {
    if (a.status !== 'online') problems.push({ level: 'bad', area: 'app', target: a.name, text: `Node app "${a.name}" is ${a.status}.`, hint: 'Open Node Apps → Logs to see the error.' });
    else if (a.restarts > 10) problems.push({ level: 'warn', area: 'app', target: a.name, text: `Node app "${a.name}" has restarted ${a.restarts} times; it may be crashing repeatedly.`, hint: 'Check its logs.' });
  }

  // ---- disk & memory ----
  const [diskLine, memLine] = s.RES || [];
  const diskPct = Number(diskLine) || 0;
  const [memTotal, memAvail, swapTotal] = (memLine || '').split(' ').map(Number);
  const memPct = memTotal ? Math.round(((memTotal - memAvail) / memTotal) * 100) : 0;
  if (diskPct >= 90) problems.push({ level: 'bad', area: 'disk', text: `The disk is ${diskPct}% full. Services crash when it reaches 100%.`, fix: 'cleanup' });
  else if (diskPct >= 80) problems.push({ level: 'warn', area: 'disk', text: `The disk is ${diskPct}% full.`, fix: 'cleanup' });
  if (memPct >= 92) problems.push({ level: swapTotal ? 'warn' : 'bad', area: 'memory', text: `Memory is ${memPct}% used${swapTotal ? '' : ' and there is no swap'}. Apps may be killed when it runs out.`, fix: swapTotal ? undefined : 'add-swap' });

  return {
    checkedAt: new Date().toISOString(),
    status: problems.some((p) => p.level === 'bad') ? 'bad' : problems.length ? 'warn' : 'ok',
    problems,
    services,
    sites,
    apps,
    resources: { diskPct, memPct, swap: Boolean(swapTotal) },
  };
}

// ---------- diagnosis ----------

const FIXES = {
  start: { label: 'Start it', permission: 'services', cmd: (u) => `systemctl start ${q(u)}` },
  restart: { label: 'Restart it', permission: 'services', cmd: (u) => `systemctl restart ${q(u)}` },
  'mongod-rseq': {
    label: 'Apply the MongoDB kernel fix',
    permission: 'system',
    cmd: () =>
      "mkdir -p /etc/systemd/system/mongod.service.d && printf '[Service]\\nEnvironment=GLIBC_TUNABLES=glibc.pthread.rseq=1\\n' > /etc/systemd/system/mongod.service.d/serverboy-rseq.conf && systemctl daemon-reload && systemctl restart mongod",
  },
  'mongod-perms': {
    label: 'Fix MongoDB file owners and restart',
    permission: 'system',
    cmd: () => 'chown -R mongodb:mongodb /var/lib/mongodb /var/log/mongodb && rm -f /tmp/mongodb-27017.sock && systemctl restart mongod',
  },
  cleanup: {
    label: 'Free disk space (package cache + old logs)',
    permission: 'system',
    cmd: () => 'apt-get clean && apt-get autoremove -y && journalctl --vacuum-time=7d && df -h /',
  },
  'add-swap': {
    label: 'Add 2 GB of swap memory',
    permission: 'system',
    cmd: () =>
      '[ -f /swapfile ] && { echo "/swapfile already exists"; swapon /swapfile 2>/dev/null; exit 0; }; fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo "/swapfile none swap sw 0 0" >> /etc/fstab && free -h',
  },
};

// Patterns in logs that point to a known problem. Order matters: the first matches are shown first.
const KNOWN = [
  {
    test: (o, u) => u === 'mongod' && /kernel versions 6\.19 and newer/i.test(o),
    title: 'MongoDB refuses to run on this Linux kernel (6.19 or newer).',
    detail: 'A known MongoDB bug (SERVER-121912). A glibc setting makes it start safely.',
    fix: 'mongod-rseq',
  },
  {
    test: (o, u) => u === 'mongod' && (/status=14/.test(o) || /permission denied/i.test(o)),
    title: 'MongoDB cannot open its files (wrong owner).',
    detail: 'Usually happens after mongod was started once as root. Its data folders must belong to the mongodb user.',
    fix: 'mongod-perms',
  },
  {
    test: (o) => /No space left on device/i.test(o),
    title: 'The disk is full.',
    detail: 'Services cannot write logs or data. Free space, then restart the service.',
    fix: 'cleanup',
  },
  {
    test: (o) => /Out of memory|oom-kill|Killed process|signal=KILL/i.test(o),
    title: 'The server ran out of memory and the system killed the process.',
    detail: 'Add swap, use a bigger VM size, or reduce what runs on it.',
    fix: 'add-swap',
  },
  {
    test: (o) => /Address already in use|bind\(\) to .* failed \(98/i.test(o),
    title: 'Another program is already using its port.',
    detail: 'See "Listening ports" below for which program holds it, then stop that program or change the port.',
  },
  {
    test: (o, u) => u === 'nginx' && /\[emerg\]|test failed/.test(o),
    title: 'Nginx configuration has an error.',
    detail: 'The exact file and line are shown in the "nginx -t" output below. Fix it under Websites → Config, or undo your last change.',
  },
  {
    test: (o) => /\(97: Address family not supported/.test(o),
    title: 'IPv6 is disabled on this server, but a site listens on [::]:80.',
    detail: 'Remove the "listen [::]:80;" lines from the site configs under Websites → Config.',
  },
  {
    test: (o, u) => u === 'mongod' && /Unrecognized option|Error parsing|YAML/i.test(o),
    title: 'There is a mistake in /etc/mongod.conf.',
    detail: 'If you used "Secure MongoDB", a backup is at /etc/mongod.conf.bak-serverboy. Restore it with: sudo cp /etc/mongod.conf.bak-serverboy /etc/mongod.conf',
  },
];

async function diagnose(serverId, unit) {
  if (!SERVICE_RE.test(unit)) throw new HttpError(400, 'Invalid service name');
  const r = await ssh.exec(
    serverId,
    `echo "##STATUS"; systemctl status ${q(unit)} --no-pager -l 2>&1 | head -25
echo "##ACTIVE"; systemctl is-active ${q(unit)} 2>&1
echo "##LOGS"; journalctl -u ${q(unit)} -n 60 --no-pager 2>&1
${unit === 'nginx' ? 'echo "##NGINXT"; nginx -t 2>&1' : ''}
${unit === 'mongod' ? `echo "##MONGOLOG"; tail -n 300 /var/log/mongodb/mongod.log 2>/dev/null | grep -E '"s":"(E|F)"' | tail -5` : ''}
echo "##PORTS"; ss -ltnp 2>/dev/null | head -30
echo "##RES"; df -h / | tail -1; free -m | head -3`,
    { sudo: true, timeout: 60000 },
  );
  const s = sections(r.stdout);
  const all = r.stdout;
  const active = (s.ACTIVE || []).join('').trim();
  const findings = [];
  for (const k of KNOWN) if (k.test(all, unit)) findings.push({ title: k.title, detail: k.detail, fix: k.fix || null });
  if (!findings.length && active !== 'active') {
    findings.push({
      title: active === 'failed' ? 'The service crashed. No known cause was found in the logs.' : 'The service is not running.',
      detail: 'Read the logs below (the last lines usually say why). Try starting it; if it stops again, the reason appears at the bottom of the logs.',
      fix: active === 'failed' ? 'restart' : 'start',
    });
  }
  return {
    unit,
    active,
    findings: findings.map((f) => ({ ...f, fixLabel: f.fix ? FIXES[f.fix].label : null, fixPermission: f.fix ? FIXES[f.fix].permission : null })),
    output: {
      status: (s.STATUS || []).join('\n').trim(),
      logs: (s.LOGS || []).join('\n').trim(),
      nginxTest: (s.NGINXT || []).join('\n').trim(),
      mongoLog: (s.MONGOLOG || []).join('\n').trim(),
      ports: (s.PORTS || []).join('\n').trim(),
      resources: (s.RES || []).join('\n').trim(),
    },
  };
}

async function applyFix(serverId, fixId, unit) {
  const fix = FIXES[fixId];
  if (!fix) throw new HttpError(400, 'Unknown fix');
  if (unit && !SERVICE_RE.test(unit)) throw new HttpError(400, 'Invalid service name');
  const r = await ssh.exec(serverId, fix.cmd(unit), { sudo: true, timeout: 5 * 60 * 1000 });
  const after = unit ? (await ssh.exec(serverId, `systemctl is-active ${q(unit)}`)).stdout.trim() : null;
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim().slice(-4000), active: after };
}

module.exports = { check, diagnose, applyFix, FIXES };
