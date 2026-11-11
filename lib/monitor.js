// Health monitor: checks every server on a schedule and sends alerts (lib/alerts.js) when a
// problem appears, a reminder once a day while it lasts, and "fixed" when it is gone.
//   - a problem must be seen on 2 checks in a row before it alerts (no alerts for blips)
//   - "server cannot be reached" when SSH fails 2 checks in a row
//   - HTTPS certificates are checked every 6 hours (alert under 14 days)
// State survives restarts (data/alert-state.json), so an update does not re-send old alerts.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const ssh = require('./ssh');
const alerts = require('./alerts');

const STATE_FILE = path.join(store.DATA_DIR, 'alert-state.json');
const REMIND_MS = 24 * 3600e3;
const SSL_EVERY_MS = 6 * 3600e3;
let state = {}; // serverId -> { problems: { key: {...} }, lastCheck, lastError, lastSsl, sslProblems }
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch {
  state = {};
}
const running = new Set();

function save() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
  } catch {
    /* not critical */
  }
}

// One key per thing that can be broken, so "disk 91%" and "disk 93%" are the same problem.
function keyOf(p) {
  if (p.area === 'disk' || p.area === 'memory') return p.area;
  return `${p.area}:${p.target || p.text}`;
}

function withTimeout(promise, ms, what) {
  let t;
  const limit = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${what} took longer than ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(t));
}

async function sslProblems(serverId) {
  const r = await ssh.exec(serverId, `for c in /etc/letsencrypt/live/*/cert.pem; do [ -f "$c" ] || continue; e=$(openssl x509 -enddate -noout -in "$c" 2>/dev/null | cut -d= -f2); [ -n "$e" ] && echo "$(basename "$(dirname "$c")")|$(date -d "$e" +%s)"; done`, { sudo: true, timeout: 30000 });
  const out = [];
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [domain, until] = line.split('|');
    const days = Math.floor((Number(until) * 1000 - Date.now()) / 86400e3);
    if (!Number.isFinite(days) || days >= 14) continue;
    out.push({
      category: 'ssl',
      level: days < 7 ? 'bad' : 'warn',
      area: 'ssl',
      target: domain,
      text: days < 0 ? `The HTTPS certificate of ${domain} expired ${-days} day(s) ago. Visitors see a security warning.` : `The HTTPS certificate of ${domain} expires in ${days} day(s).`,
      hint: 'Certificates renew by themselves (certbot). If this stays, check that port 80 is open and the domain still points to this server, then run: sudo certbot renew',
    });
  }
  return out;
}

const dur = (mins) => (mins < 120 ? `${mins} min` : `${Math.round(mins / 60)} h`);

// Send what changed in one check. Up to 2 changes of a kind go out one by one; more are grouped
// into one message, so an outage that breaks ten sites is one alert, not ten.
async function send(serverName, out) {
  const one = (list, make) => Promise.all(list.map((p) => alerts.notify(make(p))));
  const group = (list, category, kind, title, line, hint) =>
    alerts.notify({ category, kind, server: serverName, title, text: list.map((p) => `• ${line(p)}`).join('\n'), hint });
  for (const [kind, list] of [['problem', out.problem], ['warning', out.warning]]) {
    if (list.length <= 2) await one(list, (p) => ({ category: p.category, kind, server: serverName, title: p.text, hint: p.hint }));
    else await group(list, list.some((p) => p.category === 'unreachable') ? 'unreachable' : kind === 'problem' ? 'health' : 'warnings', kind, `${list.length} ${kind === 'problem' ? 'problems' : 'warnings'} found`, (p) => p.text, 'Open the server dashboard in Serverboy for details and fix buttons.');
  }
  if (out.reminder.length <= 2) await one(out.reminder, (p) => ({ category: p.category, kind: p.level === 'bad' ? 'problem' : 'warning', server: serverName, title: `Still not fixed (${p.hours} h): ${p.text}`, hint: p.hint }));
  else await group(out.reminder, 'health', 'problem', `${out.reminder.length} problems are still not fixed`, (p) => `${p.text} (${p.hours} h)`);
  if (out.fixed.length <= 2) await one(out.fixed, (p) => ({ category: p.category, kind: 'fixed', server: serverName, title: `Fixed: ${p.text}`, text: `It was a problem for about ${dur(p.mins)}.` }));
  else await group(out.fixed, 'health', 'fixed', `${out.fixed.length} problems are fixed`, (p) => `${p.text} (after ${dur(p.mins)})`);
}

async function checkServer(serverId) {
  if (running.has(serverId)) return;
  running.add(serverId);
  const server = store.getServer(serverId);
  const st = (state[serverId] = state[serverId] || { problems: {} });
  const now = Date.now();
  try {
    let found = [];
    let ignoredKeys = new Set();
    try {
      const health = await withTimeout(require('./health').check(serverId), 120000, 'The health check');
      ignoredKeys = new Set((health.ignored || []).map(keyOf));
      // Backups report their own failures (when they happen), so they are left out here.
      found = health.problems
        .filter((p) => p.area !== 'backup')
        .map((p) => ({ ...p, category: p.level === 'bad' ? 'health' : 'warnings' }));
      st.lastError = null;
      if (!st.lastSsl || now - st.lastSsl > SSL_EVERY_MS) {
        st.sslProblems = await sslProblems(serverId).catch(() => st.sslProblems || []);
        st.lastSsl = now;
      }
      found.push(...(st.sslProblems || []));
    } catch (err) {
      st.lastError = err.message;
      found = [{ category: 'unreachable', level: 'bad', area: 'unreachable', text: `Serverboy cannot reach ${server.name}: ${err.message}`, hint: 'Is the server running? Check it in the Azure portal. If it was restarted, it may need a few minutes.' }];
    }
    st.lastCheck = new Date(now).toISOString();
    const seen = new Set();
    const out = { problem: [], warning: [], reminder: [], fixed: [] };
    for (const p of found) {
      const key = keyOf(p);
      seen.add(key);
      const cur = st.problems[key] || { firstSeen: new Date(now).toISOString(), count: 0 };
      cur.count += 1;
      Object.assign(cur, { text: p.text, level: p.level, category: p.category, hint: p.hint || '' });
      st.problems[key] = cur;
      const due = p.category === 'ssl' ? cur.count >= 1 : cur.count >= 2;
      if (due && !cur.alertedAt) {
        cur.alertedAt = new Date(now).toISOString();
        cur.remindedAt = cur.alertedAt;
        out[p.level === 'bad' ? 'problem' : 'warning'].push(p);
      } else if (cur.alertedAt && now - Date.parse(cur.remindedAt) > REMIND_MS) {
        cur.remindedAt = new Date(now).toISOString();
        out.reminder.push({ ...p, hours: Math.round((now - Date.parse(cur.firstSeen)) / 3600e3) });
      }
    }
    // A bigger problem can hide smaller ones: when the server cannot be reached nothing else can be
    // checked, and when Nginx is down every site looks the same. Those are not "fixed"; keep them.
    const hidesAll = found.some((p) => p.area === 'unreachable');
    const hidesSites = found.some((p) => p.area === 'site' && p.target === 'nginx');
    for (const [key, p] of Object.entries(st.problems)) {
      if (seen.has(key)) continue;
      // Ignored on the dashboard: gone from alerts, without a "Fixed" message.
      if (ignoredKeys.has(key)) {
        delete st.problems[key];
        continue;
      }
      if (hidesAll && !key.startsWith('unreachable')) continue;
      if (hidesSites && key.startsWith('site:') && key !== 'site:nginx') continue;
      // SSL problems are only re-checked every 6 hours; keep them until then.
      if (p.category === 'ssl' && (st.sslProblems || []).some((x) => keyOf(x) === key)) continue;
      if (p.alertedAt) out.fixed.push({ ...p, mins: Math.max(1, Math.round((now - Date.parse(p.firstSeen)) / 60000)) });
      delete st.problems[key];
    }
    await send(server.name, out);
  } finally {
    running.delete(serverId);
    save();
  }
}

async function tick() {
  const s = alerts.settings();
  if (!s.enabled) return;
  const servers = store.listServers().filter((sv) => !s.muted.includes(sv.id));
  for (const sv of servers) {
    const st = state[sv.id];
    if (st?.lastCheck && Date.now() - Date.parse(st.lastCheck) < s.every * 60e3 - 15000) continue;
    checkServer(sv.id).catch((err) => console.error(`Monitor ${sv.name}: ${err.message}`));
  }
  // Forget removed servers.
  for (const id of Object.keys(state)) if (!store.getServer(id)) delete state[id];
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => tick().catch(() => {}), 60 * 1000);
  timer.unref?.();
  setTimeout(() => tick().catch(() => {}), 30 * 1000).unref?.();
}

// For the Alerts page: what is being watched right now.
function status() {
  return store.listServers().map((sv) => {
    const st = state[sv.id] || { problems: {} };
    return {
      id: sv.id,
      name: sv.name,
      lastCheck: st.lastCheck || null,
      lastError: st.lastError || null,
      problems: Object.entries(st.problems || {}).map(([key, p]) => ({ key, text: p.text, level: p.level, category: p.category, since: p.firstSeen, alerted: Boolean(p.alertedAt), checks: p.count })),
    };
  });
}

module.exports = { start, status, checkServer, keyOf, _state: () => state };
