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

module.exports = {
  version: pkg.version,
  build: hash.digest('hex').slice(0, 12),
  startedAt: new Date().toISOString(),
  changelog,
};
