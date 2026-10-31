// Dashboard stats, services, processes, software catalog, packages, firewall and jobs.
const express = require('express');
const ssh = require('../lib/ssh');
const pm2 = require('../lib/pm2');
const jobs = require('../lib/jobs');
const catalog = require('../lib/catalog');

const { q, HttpError } = ssh;
const router = express.Router({ mergeParams: true });

const SERVICE_RE = /^[A-Za-z0-9@._:-]+$/;
const PACKAGE_RE = /^[a-z0-9][a-z0-9+.-]*$/;

// ---------- Stats ----------

const STATS_SCRIPT = `
echo "##hostname"; hostname
echo "##os"; ( . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME" )
echo "##kernel"; uname -r
echo "##uptime"; cat /proc/uptime
echo "##load"; cat /proc/loadavg
echo "##cpus"; nproc
echo "##cpumodel"; grep -m1 'model name' /proc/cpuinfo | cut -d: -f2
echo "##cpu1"; head -1 /proc/stat; sleep 0.5
echo "##cpu2"; head -1 /proc/stat
echo "##mem"; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
echo "##disk"; df -B1 -P -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null | tail -n +2
echo "##ips"; hostname -I 2>/dev/null
echo "##procs"; ps -eo pid=,user=,pcpu=,pmem=,rss=,comm= --sort=-pcpu | head -15
echo "##reboot"; [ -f /var/run/reboot-required ] && echo yes || echo no
echo "##end"
`;

function sections(text) {
  const out = {};
  let current = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^##(\w+)$/);
    if (m) {
      current = m[1];
      out[current] = [];
    } else if (current) out[current].push(line);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n').trim();
  return out;
}

function cpuTimes(line) {
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = parts[3] + (parts[4] || 0);
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

router.get('/stats', async (req, res) => {
  const r = await ssh.exec(req.params.id, STATS_SCRIPT, { check: true });
  const s = sections(r.stdout);
  const c1 = cpuTimes(s.cpu1);
  const c2 = cpuTimes(s.cpu2);
  const dt = c2.total - c1.total;
  const mem = Object.fromEntries(
    s.mem.split('\n').map((l) => {
      const [k, v] = l.split(':');
      return [k.trim(), Number.parseInt(v, 10) * 1024];
    }),
  );
  const [load1, load5, load15] = s.load.split(' ').map(Number);
  res.json({
    hostname: s.hostname,
    os: s.os,
    kernel: s.kernel,
    uptimeSeconds: Number(s.uptime.split(' ')[0]),
    load: [load1, load5, load15],
    cpus: Number(s.cpus),
    cpuModel: s.cpumodel,
    cpuPercent: dt > 0 ? Math.round((1 - (c2.idle - c1.idle) / dt) * 1000) / 10 : 0,
    memory: { total: mem.MemTotal, available: mem.MemAvailable, used: mem.MemTotal - mem.MemAvailable },
    swap: { total: mem.SwapTotal, used: mem.SwapTotal - mem.SwapFree },
    disks: s.disk
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [fs, size, used, avail, , mount] = l.split(/\s+/);
        return { fs, size: Number(size), used: Number(used), available: Number(avail), mount };
      }),
    ips: s.ips.split(/\s+/).filter(Boolean),
    processes: s.procs
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [pid, user, cpu, mem2, rss, ...cmd] = l.trim().split(/\s+/);
        return { pid: Number(pid), user, cpu: Number(cpu), mem: Number(mem2), rss: Number(rss) * 1024, command: cmd.join(' ') };
      }),
    rebootRequired: s.reboot === 'yes',
  });
});

router.post('/processes/:pid/kill', async (req, res) => {
  const pid = Number(req.params.pid);
  if (!Number.isInteger(pid) || pid < 2) throw new HttpError(400, 'Invalid PID');
  const signal = req.body?.force ? 'KILL' : 'TERM';
  await ssh.execMaybeSudo(req.params.id, `kill -${signal} ${pid}`, { check: true });
  res.json({ ok: true });
});

router.post('/reboot', async (req, res) => {
  await ssh.exec(req.params.id, '(sleep 1; systemctl reboot) >/dev/null 2>&1 &', { sudo: true, check: true });
  ssh.disconnect(req.params.id);
  res.json({ ok: true });
});

router.post('/system-update', (req, res) => {
  res.json(
    jobs.create(req.params.id, 'System update (apt upgrade)', [
      { label: 'Refreshing package lists', cmd: 'apt-get update -y', sudo: true },
      {
        label: 'Upgrading packages',
        cmd: 'apt-get -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" upgrade -y',
        sudo: true,
      },
      { label: 'Cleaning up', cmd: 'apt-get autoremove -y', sudo: true },
    ]),
  );
});

// ---------- Services ----------

router.get('/services', async (req, res) => {
  const r = await ssh.exec(
    req.params.id,
    `systemctl list-units --type=service --all --no-pager --plain --no-legend;
echo "##files"; systemctl list-unit-files --type=service --no-pager --plain --no-legend`,
    { check: true },
  );
  const [units, files] = r.stdout.split('##files');
  const enabled = {};
  for (const line of (files || '').split('\n')) {
    const [name, state] = line.trim().split(/\s+/);
    if (name) enabled[name] = state;
  }
  const services = units
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [unit, load, active, sub, ...desc] = l.replace(/^●\s*/, '').split(/\s+/);
      return { unit, load, active, sub, description: desc.join(' '), enabled: enabled[unit] || '' };
    })
    .filter((s) => s.load !== 'not-found');
  res.json(services);
});

router.post('/services/:name/:action', async (req, res) => {
  const { name, action } = req.params;
  if (!SERVICE_RE.test(name)) throw new HttpError(400, 'Invalid service name');
  if (!['start', 'stop', 'restart', 'reload', 'enable', 'disable'].includes(action)) throw new HttpError(400, 'Invalid action');
  const unit = name.replace(/\.service$/, '');
  if (/^pm2-/.test(unit) && (action === 'start' || action === 'restart')) {
    // A PM2 started outside systemd (by "pm2 start" in a terminal) makes a plain start fail;
    // take it over instead (lib/pm2.js).
    if (action === 'restart') await ssh.exec(req.params.id, `systemctl stop ${q(unit)}`, { sudo: true });
    await ssh.exec(req.params.id, pm2.adoptScript(unit.slice(4)), { sudo: true, check: true, timeout: 120000 });
    return res.json({ ok: true });
  }
  await ssh.exec(req.params.id, `systemctl ${action} ${q(name)}`, { sudo: true, check: true });
  res.json({ ok: true });
});

router.get('/services/:name/logs', async (req, res) => {
  const { name } = req.params;
  if (!SERVICE_RE.test(name)) throw new HttpError(400, 'Invalid service name');
  const lines = Math.min(Number(req.query.lines) || 200, 2000);
  const r = await ssh.exec(
    req.params.id,
    `systemctl status ${q(name)} --no-pager -l 2>&1 | head -20; echo; echo "----- last ${lines} log lines -----"; journalctl -u ${q(name)} -n ${lines} --no-pager 2>&1`,
    { sudo: true },
  );
  res.json({ log: r.stdout + r.stderr });
});

// ---------- Software catalog ----------

router.get('/apps', async (req, res) => {
  const r = await ssh.exec(req.params.id, catalog.statusScript());
  const status = {};
  for (const line of r.stdout.split('\n')) {
    const [id, installed, ...version] = line.split('|');
    if (id) status[id] = { installed: installed === '1', version: version.join('|').trim() };
  }
  res.json(
    catalog.catalog.map(({ id, name, category, description, service, uninstall }) => ({
      id,
      name,
      category,
      description,
      service: service || null,
      canUninstall: Boolean(uninstall),
      ...(status[id] || { installed: false, version: '' }),
    })),
  );
});

router.post('/apps/:appId/:action', (req, res) => {
  const app = catalog.find(req.params.appId);
  if (!app) throw new HttpError(404, 'Unknown app');
  const { action } = req.params;
  if (action === 'install') {
    return res.json(jobs.create(req.params.id, `Install ${app.name}`, [{ label: `Installing ${app.name}`, cmd: app.install, sudo: true }]));
  }
  if (action === 'uninstall' && app.uninstall) {
    return res.json(jobs.create(req.params.id, `Uninstall ${app.name}`, [{ label: `Removing ${app.name}`, cmd: app.uninstall, sudo: true }]));
  }
  throw new HttpError(400, 'Invalid action');
});

// ---------- Any apt package ----------

router.get('/packages/search', async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (!/^[A-Za-z0-9+.-]{2,50}$/.test(term)) throw new HttpError(400, 'Enter at least 2 letters (letters, numbers, + . -)');
  const r = await ssh.exec(
    req.params.id,
    `apt-cache search --names-only ${q(term)} | head -60; echo "##installed"; dpkg-query -W -f='\${Package}\\n' 2>/dev/null`,
  );
  const [found, installedList] = r.stdout.split('##installed');
  const installed = new Set((installedList || '').split('\n').map((s) => s.trim()));
  res.json(
    found
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, ...desc] = l.split(' - ');
        return { name: name.trim(), description: desc.join(' - '), installed: installed.has(name.trim()) };
      }),
  );
});

router.post('/packages/:action', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!PACKAGE_RE.test(name)) throw new HttpError(400, 'Invalid package name');
  const { action } = req.params;
  if (action === 'install') {
    return res.json(jobs.create(req.params.id, `apt install ${name}`, [{ label: `Installing ${name}`, cmd: `apt-get update -y && apt-get install -y ${q(name)}`, sudo: true }]));
  }
  if (action === 'remove') {
    return res.json(jobs.create(req.params.id, `apt remove ${name}`, [{ label: `Removing ${name}`, cmd: `apt-get remove -y ${q(name)}`, sudo: true }]));
  }
  throw new HttpError(400, 'Invalid action');
});

// ---------- Firewall (ufw) ----------

router.get('/firewall', async (req, res) => {
  const r = await ssh.exec(req.params.id, 'command -v ufw >/dev/null || { echo NOT_INSTALLED; exit 0; }; ufw status numbered', { sudo: true });
  const out = r.stdout.trim();
  if (out.includes('NOT_INSTALLED')) return res.json({ installed: false, active: false, rules: [] });
  const active = /Status: active/.test(out);
  const rules = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\[\s*(\d+)\]\s+(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)\s+(IN|OUT|FWD)?\s*(.*)$/);
    if (m) rules.push({ num: Number(m[1]), to: m[2].trim(), action: m[3], direction: m[4] || 'IN', from: m[5].trim() });
  }
  res.json({ installed: true, active, rules });
});

router.post('/firewall/rule', async (req, res) => {
  const { action = 'allow', port, proto = 'tcp', from = '' } = req.body || {};
  if (!['allow', 'deny', 'limit'].includes(action)) throw new HttpError(400, 'Invalid action');
  if (!/^\d{1,5}(:\d{1,5})?$/.test(String(port)) && !/^[A-Za-z][A-Za-z0-9 ._-]{1,40}$/.test(String(port))) {
    throw new HttpError(400, 'Port must be a number, a range like 3000:3010, or an app profile name like OpenSSH');
  }
  if (!['tcp', 'udp', 'any'].includes(proto)) throw new HttpError(400, 'Invalid protocol');
  if (from && !/^[0-9a-fA-F.:/]+$/.test(from)) throw new HttpError(400, 'Source must be an IP or CIDR');
  const isProfile = !/^\d/.test(String(port));
  let cmd;
  if (from) {
    cmd = `ufw ${action} from ${q(from)} to any${isProfile ? ` app ${q(port)}` : ` port ${q(port)}${proto !== 'any' ? ` proto ${proto}` : ''}`}`;
  } else {
    cmd = `ufw ${action} ${q(isProfile || proto === 'any' ? port : `${port}/${proto}`)}`;
  }
  const r = await ssh.exec(req.params.id, cmd, { sudo: true, check: true });
  res.json({ ok: true, output: r.stdout });
});

router.delete('/firewall/rule/:num', async (req, res) => {
  const num = Number(req.params.num);
  if (!Number.isInteger(num) || num < 1) throw new HttpError(400, 'Invalid rule number');
  await ssh.exec(req.params.id, `ufw --force delete ${num}`, { sudo: true, check: true });
  res.json({ ok: true });
});

router.post('/firewall/:state', async (req, res) => {
  const { state } = req.params;
  if (state === 'enable') {
    // Never lock ourselves out: always keep the current SSH port open first.
    const entry = await ssh.connect(req.params.id);
    await ssh.exec(req.params.id, `ufw allow ${Number(entry.server.port)}/tcp && ufw --force enable`, { sudo: true, check: true });
  } else if (state === 'disable') {
    await ssh.exec(req.params.id, 'ufw disable', { sudo: true, check: true });
  } else throw new HttpError(400, 'Invalid state');
  res.json({ ok: true });
});

// ---------- Jobs ----------

router.get('/jobs', (req, res) => {
  res.json(jobs.list(req.params.id));
});

router.get('/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.serverId !== req.params.id) throw new HttpError(404, 'Job not found');
  const offset = Math.max(0, Number(req.query.offset) || 0);
  // If the log was trimmed past our offset, resend the whole thing.
  const restart = offset > job.log.length;
  res.json({ ...jobs.summary(job), log: restart ? job.log : job.log.slice(offset), offset: job.log.length, restart });
});

module.exports = router;
