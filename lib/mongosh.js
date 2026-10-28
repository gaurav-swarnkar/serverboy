// Run JavaScript in mongosh on a managed server (over SSH) and return its result.
const ssh = require('./ssh');
const store = require('./store');

const { q, HttpError } = ssh;
const DEFAULT_MONGO_URI = 'mongodb://127.0.0.1:27017';
const MARK = '__SERVERBOY__';

// Run JavaScript in mongosh; the script must call out(value) once with the result.
async function mongosh(serverId, script, uriOverride) {
  const server = store.getServer(serverId);
  const uri = uriOverride || server.mongoUri || DEFAULT_MONGO_URI;
  const js = `const out = (v) => print(${JSON.stringify(MARK)} + EJSON.stringify(v, null, 0, { relaxed: true }));\n${script}`;
  const r = await ssh.exec(
    serverId,
    `command -v mongosh >/dev/null || { echo "MongoDB shell (mongosh) is not installed. Install MongoDB from the App Store." >&2; exit 1; }
mongosh ${q(uri)} --quiet --norc --eval ${q(js)}`,
    { timeout: 2 * 60 * 1000 },
  );
  const line = r.stdout.split('\n').find((l) => l.startsWith(MARK));
  if (r.code !== 0 || !line) {
    const msg = (r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n');
    throw new HttpError(500, msg || 'mongosh failed');
  }
  return JSON.parse(line.slice(MARK.length));
}

module.exports = { mongosh, DEFAULT_MONGO_URI };
