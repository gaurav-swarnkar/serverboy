// Keep Serverboy from breaking itself. When a managed server is the machine Serverboy runs on
// (same /etc/machine-id), actions that would delete, stop or cut off Serverboy are refused:
//   - its code, data, settings file, systemd service and the Node.js it runs on
//   - the Nginx site that serves its address, and that address's HTTPS certificate
//   - stopping Nginx or Serverboy, uninstalling Node.js / Nginx / certbot
//   - firewall rules that would close ports 80 / 443
// On every server, the SSH service and the last firewall rule for the SSH port are kept as well:
// Serverboy reaches every server through SSH.
// The Terminal is not limited: it is a full shell on purpose.
const fs = require('fs');
const path = require('path').posix;
const ssh = require('./ssh');
const store = require('./store');

const { q, HttpError } = ssh;
const ROOT = path.normalize(require('path').resolve(__dirname, '..'));
const PORT = Number(process.env.PORT) || 3000;
const TTL = 5 * 60 * 1000;
let localId = null;
try {
  localId = fs.readFileSync('/etc/machine-id', 'utf8').trim() || null;
} catch {
  localId = null;
}
const cache = new Map(); // serverId -> { at, self, sites: [{ name, file, domains }], domains }

const WHY = 'Serverboy runs on this server, and this would take Serverboy itself offline (you would have to repair it over SSH).';

// Facts about one server: is it the machine Serverboy runs on, and which Nginx sites serve Serverboy?
async function facts(serverId) {
  const c = cache.get(serverId);
  if (c && Date.now() - c.at < TTL) return c;
  const out = { at: Date.now(), self: false, sites: [], domains: [] };
  if (localId) {
    const pattern = `proxy_pass[[:space:]]+https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${PORT}([/;[:space:]]|$)`;
    const r = await ssh
      .exec(
        serverId,
        `cat /etc/machine-id 2>/dev/null; echo __SITES__; for f in $(grep -lE ${q(pattern)} /etc/nginx/sites-available/* /etc/nginx/conf.d/*.conf 2>/dev/null); do echo "$f|$(grep -hE '^[[:space:]]*server_name' "$f" | sed -E 's/^[[:space:]]*server_name[[:space:]]+//; s/;.*//' | tr '\\n' ' ')"; done`,
        { timeout: 20000 },
      )
      .catch(() => null);
    if (r && r.stdout.includes('__SITES__')) {
      out.checked = true;
      const [id, sites = ''] = r.stdout.split('__SITES__');
      out.self = id.trim() === localId;
      if (out.self) {
        for (const line of sites.split('\n').filter(Boolean)) {
          const [file, names = ''] = line.split('|');
          const domains = [...new Set(names.split(/\s+/).filter((d) => d && d !== '_'))];
          out.sites.push({ name: path.basename(file).replace(/\.conf$/, ''), file, domains });
          out.domains.push(...domains);
        }
      }
    }
  }
  // Only remember a real answer: after a failed check, ask again next time.
  if (out.checked || !localId) cache.set(serverId, out);
  return out;
}

const forget = (serverId) => cache.delete(serverId);

// Paths that belong to Serverboy on its own machine, with what they are.
function protectedPaths(f) {
  if (!f.self) return [];
  const list = [
    [ROOT, "Serverboy's program files"],
    [path.normalize(require('path').resolve(store.DATA_DIR)), "Serverboy's data (servers, logins, keys, settings)"],
    ['/etc/serverboy.env', "Serverboy's settings file"],
    ['/etc/systemd/system/serverboy.service', "Serverboy's service"],
    [process.execPath, 'the Node.js program Serverboy runs on'],
  ];
  for (const s of f.sites) {
    list.push([s.file, `the Nginx site that serves Serverboy (${s.domains[0] || s.name})`]);
    list.push([`/etc/nginx/sites-enabled/${path.basename(s.file)}`, `the Nginx site that serves Serverboy (${s.domains[0] || s.name})`]);
  }
  for (const d of f.domains) {
    for (const p of [`/etc/letsencrypt/live/${d}`, `/etc/letsencrypt/archive/${d}`, `/etc/letsencrypt/renewal/${d}.conf`]) list.push([p, `the HTTPS certificate of Serverboy's address ${d}`]);
  }
  return list;
}

const inside = (p, root) => p === root || p.startsWith(`${root}/`);

// mode 'change': refuse writing at or inside a protected path.
// mode 'remove': also refuse removing, moving or re-permissioning a folder that contains one.
async function checkPaths(serverId, paths, mode = 'change') {
  const f = await facts(serverId);
  const prot = protectedPaths(f);
  if (!prot.length || !paths.length) return;
  // Resolve symlinks on the server, so a link cannot be used to reach a protected path.
  const r = await ssh.exec(serverId, `realpath -m -- ${paths.map(q).join(' ')}`);
  const real = r.stdout.split('\n').filter(Boolean);
  paths.forEach((given, i) => {
    for (const p of [path.normalize(given), real[i] || given]) {
      const hit = prot.find(([root]) => inside(p, root) || (mode === 'remove' && inside(root, p)));
      if (hit) {
        const contains = !inside(p, hit[0]);
        throw new HttpError(403, `${given} ${contains ? 'contains' : 'is part of'} ${hit[1]}. ${WHY}`);
      }
    }
  });
}

// Is this domain (or Nginx site name) the address of Serverboy itself?
async function isOwnSite(serverId, nameOrDomain) {
  const f = await facts(serverId);
  if (!f.self) return false;
  const n = String(nameOrDomain || '').toLowerCase();
  return f.sites.some((s) => s.name.toLowerCase() === n || s.domains.some((d) => d.toLowerCase() === n));
}

async function checkSite(serverId, nameOrDomain, what) {
  if (await isOwnSite(serverId, nameOrDomain)) throw new HttpError(403, `${nameOrDomain} is the address of Serverboy itself, so it cannot be ${what} here. ${WHY}`);
}

const SSH_UNITS = new Set(['ssh', 'sshd', 'ssh.socket']);
async function checkService(serverId, unitIn, action) {
  if (!['stop', 'disable', 'mask'].includes(action)) return;
  const unit = String(unitIn).replace(/\.service$/, '');
  if (SSH_UNITS.has(unit)) throw new HttpError(403, `Stopping ${unit} would cut Serverboy (and you) off from this server: Serverboy works over SSH. Not done.`);
  const f = await facts(serverId);
  if (f.self && (unit === 'serverboy' || unit === 'nginx')) throw new HttpError(403, `${unit === 'nginx' ? 'Nginx serves Serverboy\'s address' : 'This is Serverboy itself'}: stopping it here would take Serverboy offline. Use Restart instead.`);
}

async function checkProcess(serverId, pid) {
  const r = await ssh.exec(serverId, `ps -o comm= -p ${Number(pid)} 2>/dev/null; echo __CMD__; tr '\\0' ' ' < /proc/${Number(pid)}/cmdline 2>/dev/null`);
  const [comm, cmd = ''] = r.stdout.split('__CMD__').map((s) => s.trim());
  if (comm === 'sshd' && /sshd(:|\s).*listener|\/usr\/sbin\/sshd(\s|$)/.test(cmd)) throw new HttpError(403, 'This is the SSH server: Serverboy (and you) would lose the connection to this server. Not stopped.');
  const f = await facts(serverId);
  if (!f.self) return;
  if (comm === 'nginx') throw new HttpError(403, 'Nginx serves Serverboy\'s address: stopping it would take Serverboy offline. Restart Nginx under Services instead.');
  if (cmd.includes(`${ROOT}/server.js`) || Number(pid) === process.pid) throw new HttpError(403, 'This is Serverboy itself. Not stopped.');
}

const SELF_PACKAGES = /^(nodejs|libnode\d*|nginx|nginx-(common|core|full|light|extras)|libnginx-mod-.*|certbot|python3-certbot(-nginx)?)$/;
const ALWAYS_PACKAGES = /^(openssh-server|sudo)$/;
async function checkPackages(serverId, packages) {
  const f = await facts(serverId);
  const bad = packages.filter((p) => ALWAYS_PACKAGES.test(p) || (f.self && SELF_PACKAGES.test(p)));
  if (bad.length) throw new HttpError(403, `Removing ${bad.join(', ')} would break Serverboy${f.self ? ' (it runs on this server and needs Node.js, Nginx and certbot)' : ' (it needs SSH and sudo on every server)'}. Not removed.`);
}

// What a package removal would really remove (apt simulates it), then check that.
async function checkPackageRemoval(serverId, name) {
  const r = await ssh.exec(serverId, `apt-get -s remove ${q(name)} 2>/dev/null | awk '/^Remv/{print $2}'`);
  await checkPackages(serverId, [name, ...r.stdout.split('\n').map((x) => x.trim()).filter(Boolean)]);
}

const SELF_APPS = new Set(['nodejs', 'nginx', 'certbot']);
async function checkAppUninstall(serverId, appId) {
  const f = await facts(serverId);
  if (f.self && SELF_APPS.has(appId)) throw new HttpError(403, `Serverboy runs on this server and needs ${appId === 'nodejs' ? 'Node.js' : appId === 'nginx' ? 'Nginx' : 'certbot (for its HTTPS certificate)'}. Not removed.`);
}

// Firewall: which rule targets keep Serverboy reachable.
function portKind(to, sshPort) {
  const t = String(to).replace(/\s*\(v6\)\s*$/, '').trim();
  if (t === 'OpenSSH' || t === String(sshPort) || t === `${sshPort}/tcp`) return 'ssh';
  if (/^(80|80\/tcp|Nginx HTTP|WWW)$/.test(t)) return 'http';
  if (/^(443|443\/tcp|Nginx HTTPS|WWW Secure)$/.test(t)) return 'https';
  if (/^(Nginx Full|WWW Full|80,443(\/tcp)?|443,80(\/tcp)?)$/.test(t)) return 'web';
  return null;
}
const covers = (kind, need) => kind === need || (kind === 'web' && (need === 'http' || need === 'https'));

async function sshPort(serverId) {
  const entry = await ssh.connect(serverId);
  return Number(entry.server.port) || 22;
}

// A new deny / reject rule that would block SSH (any server) or the web ports (Serverboy's machine).
async function checkFirewallRule(serverId, { action, port, from }) {
  if (!['deny', 'reject'].includes(action) || from) return;
  const kind = portKind(port, await sshPort(serverId));
  if (!kind) return;
  const f = await facts(serverId);
  if (kind === 'ssh') throw new HttpError(403, `Blocking port ${port} would cut Serverboy (and you) off from this server: Serverboy works over SSH. Not added.`);
  if (f.self) throw new HttpError(403, `Blocking port ${port} would make Serverboy's address unreachable. Not added.`);
}

// Deleting the last rule that lets SSH (any server) or the web (Serverboy's machine) in.
async function checkFirewallDelete(serverId, rules, num) {
  const rule = rules.find((r) => r.num === num);
  if (!rule || rule.action !== 'ALLOW' || (rule.from && !/^Anywhere/.test(rule.from))) return;
  const port = await sshPort(serverId);
  const kind = portKind(rule.to, port);
  if (!kind) return;
  const f = await facts(serverId);
  const needs = kind === 'ssh' ? ['ssh'] : f.self ? (kind === 'web' ? ['http', 'https'] : [kind]) : [];
  const v6 = /\(v6\)/.test(rule.to);
  for (const need of needs) {
    const others = rules.filter((r) => r.num !== num && r.action === 'ALLOW' && /\(v6\)/.test(r.to) === v6 && (!r.from || /^Anywhere/.test(r.from)) && covers(portKind(r.to, port), need));
    if (!others.length) throw new HttpError(403, need === 'ssh' ? `This is the last rule that lets SSH in: deleting it would cut Serverboy (and you) off from this server once the firewall is on. Not deleted.` : `This is the last rule that opens port ${need === 'http' ? 80 : 443}: deleting it would make Serverboy's address unreachable. Not deleted.`);
  }
}

module.exports = { facts, forget, isOwnSite, checkSite, checkPaths, checkService, checkProcess, checkPackages, checkPackageRemoval, checkAppUninstall, checkFirewallRule, checkFirewallDelete, protectedPaths, _test: { portKind, ROOT } };
