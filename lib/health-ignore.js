// Health warnings you chose to ignore, per server: for 7 days, 30 days or always. An ignored
// problem leaves the dashboard count, the server's status and the alerts; it is listed under
// "Ignored" and can be brought back. Kept in data/health-ignores.json (mode 600).
const fs = require('fs');
const path = require('path');
const store = require('./store');

const FILE = path.join(store.DATA_DIR, 'health-ignores.json');
let data = {};
try {
  data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {
  data = {};
}
function save() {
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

// One key per thing that can be wrong (same as the monitor's), so "disk 81%" and "disk 84%"
// are the same warning.
function keyOf(p) {
  if (p.area === 'disk' || p.area === 'memory') return p.area;
  return `${p.area}:${p.target || p.text}`;
}

function active(serverId) {
  const list = data[serverId] || {};
  const now = Date.now();
  let changed = false;
  for (const [k, v] of Object.entries(list)) {
    if (v.until && Date.parse(v.until) < now) {
      delete list[k];
      changed = true;
    }
  }
  if (changed) save();
  return list;
}

// Split a health result's problems into the ones shown and the ones ignored.
function apply(serverId, problems) {
  const list = active(serverId);
  const shown = [];
  const ignored = [];
  for (const p of problems) {
    const key = keyOf(p);
    p.key = key;
    if (list[key]) ignored.push({ ...p, ignoredBy: list[key].by, ignoredAt: list[key].at, until: list[key].until || null });
    else shown.push(p);
  }
  return { shown, ignored };
}

function ignore(serverId, key, { days = 0, by = '', text = '' } = {}) {
  const k = String(key || '').slice(0, 300);
  if (!k) throw new Error('Nothing to ignore');
  data[serverId] = data[serverId] || {};
  data[serverId][k] = { by, text: String(text).slice(0, 300), at: new Date().toISOString(), until: days ? new Date(Date.now() + days * 86400e3).toISOString() : null };
  save();
  return data[serverId][k];
}

function unignore(serverId, key) {
  if (!data[serverId]?.[key]) return false;
  delete data[serverId][key];
  save();
  return true;
}

function removeServer(serverId) {
  if (!data[serverId]) return;
  delete data[serverId];
  save();
}

function reload() {
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    data = {};
  }
}

module.exports = { reload, keyOf, apply, ignore, unignore, removeServer, active };
