// Which Serverboy is running: the package version plus a build id that changes whenever any
// code file changes. Browsers compare it with the one they loaded to offer a refresh.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pkg = require('../package.json');
const changelog = require('./changelog');

const ROOT = path.join(__dirname, '..');
const PARTS = ['server.js', 'package.json', 'public', 'lib', 'routes', 'templates'];

function files(p) {
  const full = path.join(ROOT, p);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [p];
  return fs.readdirSync(full).sort().flatMap((n) => files(path.join(p, n)));
}

const hash = crypto.createHash('sha1');
for (const f of PARTS.flatMap(files)) hash.update(f).update(fs.readFileSync(path.join(ROOT, f)));

// What the installer put here (scripts/install-on-server.sh writes RELEASE): a tag such as
// v1.6.0, or a branch name for development installs.
function installed() {
  try {
    const out = {};
    for (const line of fs.readFileSync(path.join(ROOT, 'RELEASE'), 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    return out;
  } catch {
    return null;
  }
}

// Newest published release on GitHub, checked at most once an hour.
const REPO = process.env.SERVERBOY_GITHUB_REPO || 'gaurav-swarnkar/serverboy';
let cache = null;
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => String(v).replace(/^v/, '').split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
async function latestRelease() {
  if (cache && Date.now() - cache.at < 3600e3) return cache.value;
  let value;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'serverboy' }, signal: AbortSignal.timeout(8000) });
    if (res.status === 404) value = { none: true };
    else if (!res.ok) throw new Error(`GitHub said ${res.status}`);
    else {
      const r = await res.json();
      value = { tag: r.tag_name, name: r.name, url: r.html_url, publishedAt: r.published_at, notes: String(r.body || '').slice(0, 4000) };
    }
  } catch (err) {
    return { error: `Could not check for updates: ${err.message}` };
  }
  cache = { at: Date.now(), value };
  return value;
}

async function updateInfo() {
  const latest = await latestRelease();
  const inst = installed();
  return {
    current: pkg.version,
    installed: inst,
    channel: inst?.ref && /^v\d+\.\d+\.\d+$/.test(inst.ref) ? 'release' : inst ? 'development' : 'unknown',
    latest,
    updateAvailable: Boolean(latest?.tag && newer(latest.tag, pkg.version)),
    command: `curl -fsSL https://raw.githubusercontent.com/${REPO}/${latest?.tag || 'HEAD'}/scripts/install-on-server.sh | sudo bash`,
  };
}

module.exports = {
  updateInfo,
  newer,
  version: pkg.version,
  build: hash.digest('hex').slice(0, 12),
  startedAt: new Date().toISOString(),
  changelog,
};
