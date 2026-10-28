// MariaDB/MySQL and MongoDB management, run on the server through the mysql / mongosh CLIs.
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const ssh = require('../lib/ssh');
const store = require('../lib/store');
const jobs = require('../lib/jobs');

const { q, HttpError } = ssh;
const router = express.Router({ mergeParams: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } });

const IDENT_RE = /^[A-Za-z0-9_]{1,64}$/;
const MONGO_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const SYSTEM_MYSQL_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

function ident(name, what = 'name') {
  if (!IDENT_RE.test(String(name || ''))) throw new HttpError(400, `Invalid ${what}: use letters, numbers and _ only`);
  return String(name);
}

function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function hostValue(host) {
  const h = String(host || 'localhost');
  if (!/^[A-Za-z0-9.%_:-]{1,255}$/.test(h)) throw new HttpError(400, 'Invalid host');
  return h;
}

// ======================= MariaDB / MySQL =======================

function unescapeBatch(v) {
  if (v === 'NULL') return null;
  return v.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', 0: '\0', '\\': '\\' })[c] ?? c);
}

function parseBatch(out) {
  const lines = out.split('\n').filter((l) => l.length);
  if (!lines.length) return { columns: [], rows: [] };
  const columns = lines[0].split('\t');
  const rows = lines.slice(1).map((l) => l.split('\t').map(unescapeBatch));
  return { columns, rows };
}

async function mysql(serverId, sql, db) {
  const r = await ssh.exec(
    serverId,
    `command -v mysql >/dev/null || { echo "MariaDB/MySQL is not installed. Install it from the App Store." >&2; exit 1; }
mysql --batch ${db ? `-D ${q(db)} ` : ''}-e ${q(sql)}`,
    { sudo: true, check: true, timeout: 5 * 60 * 1000 },
  );
  return r.stdout;
}

router.get('/mysql/databases', async (req, res) => {
  const out = await mysql(
    req.params.id,
    `SELECT s.schema_name AS name, COALESCE(SUM(t.data_length + t.index_length), 0) AS size, COUNT(t.table_name) AS tables
     FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name
     GROUP BY s.schema_name ORDER BY s.schema_name`,
  );
  const { rows } = parseBatch(out);
  res.json(rows.map(([name, size, tables]) => ({ name, size: Number(size), tables: Number(tables), system: SYSTEM_MYSQL_DBS.has(name) })));
});

router.post('/mysql/databases', async (req, res) => {
  const name = ident(req.body?.name, 'database name');
  let sql = `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`;
  if (req.body?.user) {
    const user = ident(req.body.user, 'user name');
    const password = String(req.body.password || '');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    sql += ` CREATE USER IF NOT EXISTS ${sqlString(user)}@'localhost' IDENTIFIED BY ${sqlString(password)};
GRANT ALL PRIVILEGES ON \`${name}\`.* TO ${sqlString(user)}@'localhost'; FLUSH PRIVILEGES;`;
  }
  await mysql(req.params.id, sql);
  res.json({ ok: true });
});

router.delete('/mysql/databases/:name', async (req, res) => {
  const name = ident(req.params.name, 'database name');
  if (SYSTEM_MYSQL_DBS.has(name)) throw new HttpError(400, 'Refusing to drop a system database');
  await mysql(req.params.id, `DROP DATABASE \`${name}\`;`);
  res.json({ ok: true });
});

router.get('/mysql/databases/:name/tables', async (req, res) => {
  const name = ident(req.params.name, 'database name');
  const out = await mysql(
    req.params.id,
    `SELECT table_name, table_rows, data_length + index_length, engine FROM information_schema.tables WHERE table_schema = ${sqlString(name)} ORDER BY table_name`,
  );
  res.json(parseBatch(out).rows.map(([table, rows, size, engine]) => ({ name: table, rows: Number(rows), size: Number(size), engine })));
});

router.get('/mysql/users', async (req, res) => {
  const out = await mysql(req.params.id, 'SELECT User, Host FROM mysql.user ORDER BY User, Host');
  res.json(parseBatch(out).rows.map(([user, host]) => ({ user, host })));
});

router.post('/mysql/users', async (req, res) => {
  const user = ident(req.body?.user, 'user name');
  const host = hostValue(req.body?.host);
  const password = String(req.body?.password || '');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  let sql = `CREATE USER IF NOT EXISTS ${sqlString(user)}@${sqlString(host)} IDENTIFIED BY ${sqlString(password)};
ALTER USER ${sqlString(user)}@${sqlString(host)} IDENTIFIED BY ${sqlString(password)};`;
  if (req.body?.database) {
    const db = ident(req.body.database, 'database name');
    sql += ` GRANT ALL PRIVILEGES ON \`${db}\`.* TO ${sqlString(user)}@${sqlString(host)};`;
  }
  await mysql(req.params.id, `${sql} FLUSH PRIVILEGES;`);
  res.json({ ok: true });
});

router.delete('/mysql/users', async (req, res) => {
  const user = String(req.body?.user || '');
  if (!user || user === 'root' || user === 'mysql' || user === 'mariadb.sys') throw new HttpError(400, 'Refusing to drop this user');
  ident(user, 'user name');
  const host = hostValue(req.body?.host);
  await mysql(req.params.id, `DROP USER ${sqlString(user)}@${sqlString(host)};`);
  res.json({ ok: true });
});

router.post('/mysql/query', async (req, res) => {
  const db = req.body?.database ? ident(req.body.database, 'database name') : null;
  const sql = String(req.body?.sql || '').trim();
  if (!sql) throw new HttpError(400, 'Enter a SQL query');
  const out = await mysql(req.params.id, sql, db);
  const result = parseBatch(out);
  const limit = 1000;
  res.json({ ...result, rows: result.rows.slice(0, limit), totalRows: result.rows.length, truncated: result.rows.length > limit });
});

router.get('/mysql/databases/:name/export', async (req, res) => {
  const name = ident(req.params.name, 'database name');
  const stream = await ssh.execStream(
    req.params.id,
    `set -o pipefail; mysqldump --single-transaction --routines --triggers --events ${q(name)} | gzip`,
    { sudo: true },
  );
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${stamp}.sql.gz"`);
  stream.pipe(res);
  res.on('close', () => stream.close());
});

router.post('/mysql/databases/:name/import', upload.single('file'), async (req, res) => {
  const name = ident(req.params.name, 'database name');
  if (!req.file) throw new HttpError(400, 'Choose a .sql or .sql.gz file');
  const tmp = `/tmp/.serverboy-import-${crypto.randomBytes(6).toString('hex')}`;
  const s = await ssh.sftp(req.params.id);
  await new Promise((resolve, reject) => s.writeFile(tmp, req.file.buffer, { mode: 0o600 }, (e) => (e ? reject(e) : resolve())));
  res.json(
    jobs.create(req.params.id, `Import into ${name}`, [
      { label: `Importing ${req.file.originalname} into ${name}`, cmd: `set -o pipefail; zcat -f ${q(tmp)} | mysql ${q(name)}; rc=$?; rm -f ${q(tmp)}; exit $rc`, sudo: true },
    ]),
  );
});

// ======================= MongoDB =======================

const DEFAULT_MONGO_URI = 'mongodb://127.0.0.1:27017';
const MARK = '__SERVERBOY__';

function mongoName(name, what) {
  if (!MONGO_NAME_RE.test(String(name || ''))) throw new HttpError(400, `Invalid ${what}`);
  return String(name);
}

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

router.get('/mongo/status', async (req, res) => {
  const r = await ssh.exec(
    req.params.id,
    `command -v mongod >/dev/null && echo installed
systemctl is-active mongod 2>/dev/null
grep -Eq '^\\s*authorization:\\s*enabled' /etc/mongod.conf 2>/dev/null && echo auth`,
  );
  const server = store.getServer(req.params.id);
  res.json({
    installed: r.stdout.includes('installed'),
    running: /^active$/m.test(r.stdout),
    authEnabled: r.stdout.includes('auth'),
    hasCredentials: Boolean(server.mongoUri),
  });
});

router.get('/mongo/databases', async (req, res) => {
  const result = await mongosh(req.params.id, 'out(db.adminCommand({ listDatabases: 1 }).databases);');
  res.json(result.map((d) => ({ name: d.name, size: d.sizeOnDisk, system: ['admin', 'local', 'config'].includes(d.name) })));
});

router.delete('/mongo/databases/:db', async (req, res) => {
  const dbName = mongoName(req.params.db, 'database name');
  if (['admin', 'local', 'config'].includes(dbName)) throw new HttpError(400, 'Refusing to drop a system database');
  await mongosh(req.params.id, `out(db.getSiblingDB(${JSON.stringify(dbName)}).dropDatabase());`);
  res.json({ ok: true });
});

router.get('/mongo/databases/:db/collections', async (req, res) => {
  const dbName = mongoName(req.params.db, 'database name');
  const result = await mongosh(
    req.params.id,
    `const d = db.getSiblingDB(${JSON.stringify(dbName)});
out(d.getCollectionInfos({}, { nameOnly: true }).map((c) => {
  let count = null;
  try { count = d.getCollection(c.name).estimatedDocumentCount(); } catch (e) {}
  return { name: c.name, type: c.type, count };
}));`,
  );
  res.json(result);
});

router.post('/mongo/databases/:db/collections', async (req, res) => {
  const dbName = mongoName(req.params.db, 'database name');
  const col = mongoName(req.body?.name, 'collection name');
  await mongosh(req.params.id, `out(db.getSiblingDB(${JSON.stringify(dbName)}).createCollection(${JSON.stringify(col)}));`);
  res.json({ ok: true });
});

router.delete('/mongo/databases/:db/collections/:col', async (req, res) => {
  const dbName = mongoName(req.params.db, 'database name');
  const col = mongoName(req.params.col, 'collection name');
  await mongosh(req.params.id, `out(db.getSiblingDB(${JSON.stringify(dbName)}).getCollection(${JSON.stringify(col)}).drop());`);
  res.json({ ok: true });
});

function collectionRef(body) {
  const dbName = mongoName(body?.db, 'database name');
  const col = mongoName(body?.collection, 'collection name');
  return `db.getSiblingDB(${JSON.stringify(dbName)}).getCollection(${JSON.stringify(col)})`;
}

// JSON / Extended JSON text from the UI is parsed inside mongosh with EJSON.parse.
function ejson(text, fallback = '{}') {
  return `EJSON.parse(${JSON.stringify(String(text || '').trim() || fallback)})`;
}

router.post('/mongo/find', async (req, res) => {
  const coll = collectionRef(req.body);
  const limit = Math.min(Math.max(Number(req.body?.limit) || 20, 1), 500);
  const skip = Math.max(Number(req.body?.skip) || 0, 0);
  const result = await mongosh(
    req.params.id,
    `const c = ${coll};
const filter = ${ejson(req.body?.filter)};
out({ total: c.countDocuments(filter), docs: c.find(filter).sort(${ejson(req.body?.sort)}).skip(${skip}).limit(${limit}).toArray() });`,
  );
  res.json(result);
});

router.post('/mongo/insert', async (req, res) => {
  const coll = collectionRef(req.body);
  const result = await mongosh(req.params.id, `out(${coll}.insertOne(${ejson(req.body?.document)}));`);
  res.json(result);
});

router.post('/mongo/update', async (req, res) => {
  const coll = collectionRef(req.body);
  const result = await mongosh(
    req.params.id,
    `const doc = ${ejson(req.body?.document)};
out(${coll}.replaceOne({ _id: doc._id }, doc));`,
  );
  res.json(result);
});

router.post('/mongo/delete', async (req, res) => {
  const coll = collectionRef(req.body);
  const filterText = String(req.body?.filter || '').trim();
  if (!filterText || filterText === '{}') throw new HttpError(400, 'A filter is required to delete documents');
  const result = await mongosh(req.params.id, `out(${coll}.${req.body?.many ? 'deleteMany' : 'deleteOne'}(${ejson(filterText)}));`);
  res.json(result);
});

router.get('/mongo/users', async (req, res) => {
  const result = await mongosh(req.params.id, 'out(db.adminCommand({ usersInfo: { forAllDBs: true } }).users);');
  res.json(result.map((u) => ({ user: u.user, db: u.db, roles: u.roles.map((r) => `${r.role}@${r.db}`) })));
});

router.post('/mongo/users', async (req, res) => {
  const dbName = mongoName(req.body?.db, 'database name');
  const user = mongoName(req.body?.user, 'user name');
  const password = String(req.body?.password || '');
  const role = String(req.body?.role || 'readWrite');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (!['read', 'readWrite', 'dbAdmin', 'dbOwner'].includes(role)) throw new HttpError(400, 'Invalid role');
  await mongosh(
    req.params.id,
    `out(db.getSiblingDB(${JSON.stringify(dbName)}).createUser({ user: ${JSON.stringify(user)}, pwd: ${JSON.stringify(password)}, roles: [{ role: ${JSON.stringify(role)}, db: ${JSON.stringify(dbName)} }] }));`,
  );
  const encUser = encodeURIComponent(user);
  const encPass = encodeURIComponent(password);
  res.json({ ok: true, connectionString: `mongodb://${encUser}:${encPass}@127.0.0.1:27017/${dbName}?authSource=${dbName}` });
});

router.delete('/mongo/users', async (req, res) => {
  const dbName = mongoName(req.body?.db, 'database name');
  const user = mongoName(req.body?.user, 'user name');
  await mongosh(req.params.id, `out(db.getSiblingDB(${JSON.stringify(dbName)}).dropUser(${JSON.stringify(user)}));`);
  res.json({ ok: true });
});

// Turn on MongoDB authentication: create an admin user, enable auth, restart, and remember the credentials.
router.post('/mongo/secure', async (req, res) => {
  const serverId = req.params.id;
  const user = mongoName(req.body?.user || 'admin', 'user name');
  const password = String(req.body?.password || '');
  if (password.length < 12) throw new HttpError(400, 'Use an admin password of at least 12 characters');
  const uri = `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:27017/?authSource=admin`;
  res.json(
    jobs.create(serverId, 'Secure MongoDB (enable authentication)', [
      {
        label: `Creating admin user "${user}"`,
        fn: async (log) => {
          await mongosh(
            serverId,
            `out(db.getSiblingDB('admin').createUser({ user: ${JSON.stringify(user)}, pwd: ${JSON.stringify(password)}, roles: [{ role: 'root', db: 'admin' }] }));`,
          );
          log('Admin user created.\n');
        },
      },
      {
        label: 'Enabling authorization in /etc/mongod.conf',
        sudo: true,
        cmd: `set -e
cp /etc/mongod.conf /etc/mongod.conf.bak-serverboy
if grep -Eq '^\\s*authorization:' /etc/mongod.conf; then
  sed -i -E 's/^(\\s*)authorization:.*/\\1authorization: enabled/' /etc/mongod.conf
elif grep -Eq '^security:' /etc/mongod.conf; then
  sed -i -E 's/^security:.*/security:\\n  authorization: enabled/' /etc/mongod.conf
else
  sed -i -E 's/^#\\s*security:\\s*$//' /etc/mongod.conf
  printf '\\nsecurity:\\n  authorization: enabled\\n' >> /etc/mongod.conf
fi
grep -A1 '^security:' /etc/mongod.conf`,
      },
      { label: 'Restarting mongod', cmd: 'systemctl restart mongod && sleep 3 && systemctl is-active mongod', sudo: true },
      {
        label: 'Verifying login with the new admin user',
        fn: async (log) => {
          await mongosh(serverId, "out(db.adminCommand({ connectionStatus: 1 }).authInfo);", uri);
          store.updateServer(serverId, { mongoUri: uri });
          log('Authentication works. Serverboy will use these credentials from now on.\n');
        },
      },
    ]),
  );
});

// Save (or clear) the MongoDB login Serverboy uses for this server. Given a user + password it
// builds the connection string itself (so special characters are encoded) and checks it works.
router.post('/mongo/credentials', async (req, res) => {
  let uri = String(req.body?.uri ?? '').trim();
  const user = String(req.body?.user ?? '').trim();
  if (!uri && user) {
    const authDb = mongoName(req.body?.authDb || 'admin', 'authentication database');
    uri = `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(String(req.body?.password ?? ''))}@127.0.0.1:27017/?authSource=${authDb}`;
  }
  if (uri && !/^mongodb(\+srv)?:\/\//.test(uri)) throw new HttpError(400, 'Must start with mongodb://');
  if (uri) {
    try {
      await mongosh(req.params.id, 'out(db.adminCommand({ listDatabases: 1, nameOnly: true }).ok);', uri);
    } catch (err) {
      throw new HttpError(400, `These credentials did not work, nothing was saved:\n${err.message}`);
    }
  }
  store.updateServer(req.params.id, { mongoUri: uri });
  res.json({ ok: true });
});

module.exports = router;
