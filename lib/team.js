// Team members and the activity log, stored in MongoDB (database "serverboy" by default).
// The owner account is NOT stored here: it lives in data/config.json so the owner can always
// log in, even when MongoDB is down.
const { MongoClient, ObjectId } = require('mongodb');
const store = require('./store');
const { cleanPermissions } = require('./permissions');

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const RESERVED = new Set(['admin', 'owner', 'root', 'serverboy']);
const AUDIT_DAYS = 90;
const USER_CACHE_MS = 10 * 1000;

let state = { uri: null, client: null, db: null, connecting: null };
let lastError = null;
const userCache = new Map(); // id -> { user, at }

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function dbNameFromUri(uri) {
  try {
    return decodeURIComponent(new URL(uri).pathname.replace(/^\//, '')) || 'serverboy';
  } catch {
    return 'serverboy';
  }
}

async function openDb(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 4000, connectTimeoutMS: 4000, appName: 'serverboy' });
  await client.connect();
  const db = client.db(dbNameFromUri(uri));
  return { client, db };
}

async function prepare(db) {
  await db.collection('users').createIndex({ username: 1 }, { unique: true });
  await db.collection('audit').createIndex({ at: 1 }, { expireAfterSeconds: AUDIT_DAYS * 24 * 3600 });
}

function isConfigured() {
  return Boolean(store.getTeamDbUri());
}

async function getDb() {
  const uri = store.getTeamDbUri();
  if (!uri) throw httpError(503, 'Team accounts are not set up yet.');
  if (state.db && state.uri === uri) return state.db;
  if (!state.connecting) {
    state.connecting = (async () => {
      const old = state.client;
      const { client, db } = await openDb(uri);
      await prepare(db);
      state = { uri, client, db, connecting: null };
      lastError = null;
      old?.close().catch(() => {});
      return db;
    })().catch((err) => {
      state.connecting = null;
      lastError = err.message;
      throw httpError(503, `The Serverboy team database cannot be reached: ${err.message}`);
    });
  }
  return state.connecting;
}

// Check a connection string before saving it: login, read and write must all work.
async function testUri(uri) {
  let client;
  try {
    ({ client } = await openDb(uri));
    const db = client.db(dbNameFromUri(uri));
    await prepare(db);
    await db.collection('users').findOne({});
    await db.collection('audit').insertOne({ at: new Date(), user: 'serverboy', action: 'Connected team database' });
    return { database: db.databaseName };
  } catch (err) {
    throw httpError(400, `Could not use this MongoDB connection: ${err.message}`);
  } finally {
    await client?.close().catch(() => {});
  }
}

async function status() {
  if (!isConfigured()) return { configured: false };
  try {
    const db = await getDb();
    return { configured: true, connected: true, database: db.databaseName, users: await db.collection('users').countDocuments() };
  } catch (err) {
    return { configured: true, connected: false, error: lastError || err.message };
  }
}

async function disconnect() {
  const old = state.client;
  state = { uri: null, client: null, db: null, connecting: null };
  userCache.clear();
  await old?.close().catch(() => {});
}

// ---------- users ----------

function publicUser(doc) {
  return {
    id: String(doc._id),
    username: doc.username,
    name: doc.name || '',
    permissions: doc.permissions || [],
    disabled: Boolean(doc.disabled),
    createdAt: doc.createdAt,
    createdBy: doc.createdBy,
    lastLoginAt: doc.lastLoginAt || null,
  };
}

function cleanUsername(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(u)) throw httpError(400, 'Username: 3-32 characters, letters, numbers, dot, dash or underscore');
  if (RESERVED.has(u)) throw httpError(400, `"${u}" is reserved; pick another username`);
  return u;
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 10) throw httpError(400, 'Password must be at least 10 characters');
  return password;
}

function objectId(id) {
  try {
    return new ObjectId(String(id));
  } catch {
    throw httpError(404, 'User not found');
  }
}

async function listUsers() {
  const db = await getDb();
  const docs = await db.collection('users').find({}).sort({ username: 1 }).toArray();
  return docs.map(publicUser);
}

async function createUser({ username, name, password, permissions }, createdBy) {
  const db = await getDb();
  const doc = {
    username: cleanUsername(username),
    name: String(name || '').trim().slice(0, 80),
    passwordHash: store.hashPassword(checkPassword(password)),
    permissions: cleanPermissions(permissions),
    disabled: false,
    createdAt: new Date(),
    createdBy,
  };
  try {
    const r = await db.collection('users').insertOne(doc);
    return publicUser({ ...doc, _id: r.insertedId });
  } catch (err) {
    if (err.code === 11000) throw httpError(409, `User "${doc.username}" already exists`);
    throw err;
  }
}

async function updateUser(id, { name, permissions, disabled }) {
  const db = await getDb();
  const set = { updatedAt: new Date() };
  if (name !== undefined) set.name = String(name).trim().slice(0, 80);
  if (permissions !== undefined) set.permissions = cleanPermissions(permissions);
  if (disabled !== undefined) set.disabled = Boolean(disabled);
  const r = await db.collection('users').findOneAndUpdate({ _id: objectId(id) }, { $set: set }, { returnDocument: 'after' });
  if (!r) throw httpError(404, 'User not found');
  userCache.delete(String(id));
  return publicUser(r);
}

async function setPassword(id, password) {
  const db = await getDb();
  const r = await db
    .collection('users')
    .updateOne({ _id: objectId(id) }, { $set: { passwordHash: store.hashPassword(checkPassword(password)), updatedAt: new Date() } });
  if (!r.matchedCount) throw httpError(404, 'User not found');
  userCache.delete(String(id));
}

async function deleteUser(id) {
  const db = await getDb();
  const r = await db.collection('users').deleteOne({ _id: objectId(id) });
  if (!r.deletedCount) throw httpError(404, 'User not found');
  userCache.delete(String(id));
}

// Returns the public user if the password matches, otherwise null.
async function verifyLogin(username, password) {
  const db = await getDb();
  const doc = await db.collection('users').findOne({ username: String(username || '').trim().toLowerCase() });
  // Hash anyway when the user does not exist, so response time does not reveal valid usernames.
  const ok = store.verifyHash(String(password || ''), doc?.passwordHash || DUMMY_HASH);
  if (!doc || !ok || doc.disabled) return null;
  await db.collection('users').updateOne({ _id: doc._id }, { $set: { lastLoginAt: new Date() } });
  return publicUser(doc);
}

const DUMMY_HASH = store.hashPassword('serverboy-dummy-password');

async function verifyPassword(id, password) {
  const db = await getDb();
  const doc = await db.collection('users').findOne({ _id: objectId(id) });
  return Boolean(doc) && store.verifyHash(String(password || ''), doc.passwordHash);
}

// Cached lookup used on every request; changes made through this module clear the cache.
async function getUser(id) {
  const hit = userCache.get(String(id));
  if (hit && Date.now() - hit.at < USER_CACHE_MS) return hit.user;
  const db = await getDb();
  const doc = await db.collection('users').findOne({ _id: objectId(id) });
  const user = doc ? publicUser(doc) : null;
  userCache.set(String(id), { user, at: Date.now() });
  return user;
}

// ---------- activity log ----------

async function audit(entry) {
  if (!isConfigured()) return;
  try {
    const db = await getDb();
    await db.collection('audit').insertOne({ at: new Date(), ...entry });
  } catch {
    // Logging must never break the action itself.
  }
}

async function listAudit({ limit = 200, user } = {}) {
  const db = await getDb();
  const filter = user ? { user: String(user) } : {};
  const docs = await db.collection('audit').find(filter).sort({ at: -1 }).limit(Math.min(Number(limit) || 200, 1000)).toArray();
  return docs.map(({ _id, ...rest }) => ({ id: String(_id), ...rest }));
}

module.exports = {
  isConfigured,
  testUri,
  status,
  disconnect,
  listUsers,
  createUser,
  updateUser,
  setPassword,
  deleteUser,
  verifyLogin,
  verifyPassword,
  getUser,
  audit,
  listAudit,
  AUDIT_DAYS,
};
