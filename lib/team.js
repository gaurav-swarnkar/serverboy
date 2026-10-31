// Team members and the activity log, stored in MongoDB (database "serverboy" by default).
// The owner account is NOT stored here: it lives in data/config.json so the owner can always
// log in, even when MongoDB is down.
const { MongoClient, ObjectId } = require('mongodb');
const store = require('./store');
const { cleanPermissions, PRESETS } = require('./permissions');
const { cleanScope } = require('./scope');

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
  await db.collection('users').createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
  await db.collection('roles').createIndex({ name: 1 }, { unique: true });
  await db.collection('audit').createIndex({ at: 1 }, { expireAfterSeconds: AUDIT_DAYS * 24 * 3600 });
  // Starter roles the first time; the owner can edit or delete them afterwards.
  if (!(await db.collection('roles').countDocuments())) {
    const now = new Date();
    await db.collection('roles').insertMany([
      { name: 'Developer', description: 'Databases, websites, website files and services.', permissions: PRESETS.developer, createdAt: now },
      { name: 'Viewer', description: 'Can look at dashboards and logs, cannot change anything.', permissions: PRESETS.viewer, createdAt: now },
    ]);
  }
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

// ---------- roles ----------
// A role is a named set of permissions. A user either has a role (and gets its permissions, so
// editing the role updates everyone in it) or no role and their own custom permissions.

function publicRole(doc, userCount = 0) {
  return {
    id: String(doc._id),
    name: doc.name,
    description: doc.description || '',
    permissions: doc.permissions || [],
    users: userCount,
  };
}

function cleanRoleName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (n.length < 2 || n.length > 40) throw httpError(400, 'Role name: 2-40 characters');
  if (/^(owner|admin)$/i.test(n)) throw httpError(400, `"${n}" is reserved for the owner`);
  return n;
}

async function rolesById(db) {
  const roles = await db.collection('roles').find({}).toArray();
  return new Map(roles.map((r) => [String(r._id), r]));
}

async function listRoles() {
  const db = await getDb();
  const roles = await db.collection('roles').find({}).sort({ name: 1 }).toArray();
  const counts = await db.collection('users').aggregate([{ $group: { _id: '$roleId', n: { $sum: 1 } } }]).toArray();
  const byRole = new Map(counts.map((c) => [String(c._id), c.n]));
  return roles.map((r) => publicRole(r, byRole.get(String(r._id)) || 0));
}

async function saveRole(id, { name, description, permissions }) {
  const db = await getDb();
  const doc = { name: cleanRoleName(name), description: String(description || '').trim().slice(0, 200), permissions: cleanPermissions(permissions) };
  try {
    if (!id) {
      const r = await db.collection('roles').insertOne({ ...doc, createdAt: new Date() });
      return publicRole({ ...doc, _id: r.insertedId });
    }
    const r = await db.collection('roles').findOneAndUpdate({ _id: objectId(id, 'Role') }, { $set: { ...doc, updatedAt: new Date() } }, { returnDocument: 'after' });
    if (!r) throw httpError(404, 'Role not found');
    userCache.clear(); // everyone with this role gets the new permissions right away
    return publicRole(r);
  } catch (err) {
    if (err.code === 11000) throw httpError(409, `A role named "${doc.name}" already exists`);
    throw err;
  }
}

async function deleteRole(id) {
  const db = await getDb();
  const inUse = await db.collection('users').countDocuments({ roleId: String(id) });
  if (inUse) throw httpError(409, `${inUse} user(s) still have this role. Give them another role first.`);
  const r = await db.collection('roles').deleteOne({ _id: objectId(id, 'Role') });
  if (!r.deletedCount) throw httpError(404, 'Role not found');
}

// ---------- users ----------

function publicUser(doc, roles) {
  const role = doc.roleId ? roles.get(String(doc.roleId)) : null;
  return {
    id: String(doc._id),
    username: doc.username,
    email: doc.email || '',
    name: doc.name || '',
    roleId: role ? String(role._id) : null,
    roleName: role ? role.name : null,
    // Effective permissions: the role's, or the user's own custom set.
    permissions: role ? role.permissions || [] : doc.permissions || [],
    customPermissions: doc.permissions || [],
    // Which websites / databases they may use (on top of their permissions).
    scope: cleanScope(doc.scope),
    disabled: Boolean(doc.disabled),
    createdAt: doc.createdAt,
    createdBy: doc.createdBy,
    lastLoginAt: doc.lastLoginAt || null,
    profile: doc.profile || {},
  };
}

function cleanUsername(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(u)) throw httpError(400, 'Username: 3-32 characters, letters, numbers, dot, dash or underscore');
  if (RESERVED.has(u)) throw httpError(400, `"${u}" is reserved; pick another username`);
  return u;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// '' or missing means "no email".
function cleanEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  if (!EMAIL_RE.test(e) || e.length > 200) throw httpError(400, `"${e}" is not a valid email address`);
  if (e === store.getOwnerEmail()) throw httpError(409, 'That email is used by the owner login');
  return e;
}

async function emailInUse(email) {
  if (!isConfigured()) return false;
  const db = await getDb();
  return Boolean(await db.collection('users').findOne({ email: String(email).toLowerCase() }));
}

function duplicateError(err, doc) {
  if (err.keyPattern?.email) return httpError(409, `Another user already has the email ${doc.email}`);
  return httpError(409, `User "${doc.username}" already exists`);
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 10) throw httpError(400, 'Password must be at least 10 characters');
  return password;
}

function objectId(id, what = 'User') {
  try {
    return new ObjectId(String(id));
  } catch {
    throw httpError(404, `${what} not found`);
  }
}

async function checkRole(db, roleId) {
  if (!roleId) return null;
  const role = await db.collection('roles').findOne({ _id: objectId(roleId, 'Role') });
  if (!role) throw httpError(400, 'That role does not exist any more');
  return String(role._id);
}

async function listUsers() {
  const db = await getDb();
  const roles = await rolesById(db);
  const docs = await db.collection('users').find({}).sort({ username: 1 }).toArray();
  return docs.map((d) => publicUser(d, roles));
}

async function createUser({ username, email, name, password, roleId, permissions, scope }, createdBy) {
  const db = await getDb();
  const doc = {
    username: cleanUsername(username),
    email: cleanEmail(email),
    name: String(name || '').trim().slice(0, 80),
    passwordHash: store.hashPassword(checkPassword(password)),
    roleId: await checkRole(db, roleId),
    permissions: cleanPermissions(permissions),
    scope: cleanScope(scope),
    disabled: false,
    createdAt: new Date(),
    createdBy,
  };
  try {
    if (!doc.email) delete doc.email; // keep the unique index sparse
    const r = await db.collection('users').insertOne(doc);
    return publicUser({ ...doc, _id: r.insertedId }, await rolesById(db));
  } catch (err) {
    if (err.code === 11000) throw duplicateError(err, doc);
    throw err;
  }
}

async function updateUser(id, { name, email, roleId, permissions, scope, disabled }) {
  const db = await getDb();
  const set = { updatedAt: new Date() };
  const unset = {};
  if (name !== undefined) set.name = String(name).trim().slice(0, 80);
  if (email !== undefined) {
    const e = cleanEmail(email);
    if (e) set.email = e;
    else unset.email = '';
  }
  if (roleId !== undefined) set.roleId = await checkRole(db, roleId);
  if (permissions !== undefined) set.permissions = cleanPermissions(permissions);
  if (scope !== undefined) set.scope = cleanScope(scope);
  if (disabled !== undefined) set.disabled = Boolean(disabled);
  let r;
  try {
    const update = Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set };
    r = await db.collection('users').findOneAndUpdate({ _id: objectId(id) }, update, { returnDocument: 'after' });
  } catch (err) {
    if (err.code === 11000) throw duplicateError(err, set);
    throw err;
  }
  if (!r) throw httpError(404, 'User not found');
  userCache.delete(String(id));
  return publicUser(r, await rolesById(db));
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

const DUMMY_HASH = store.hashPassword('serverboy-dummy-password');

// Log in with a username or an email address. Returns the public user if the password matches.
async function verifyLogin(identifier, password) {
  const db = await getDb();
  const id = String(identifier || '').trim().toLowerCase();
  const doc = await db.collection('users').findOne(id.includes('@') ? { email: id } : { username: id });
  // Hash anyway when the user does not exist, so response time does not reveal valid usernames.
  const ok = store.verifyHash(String(password || ''), doc?.passwordHash || DUMMY_HASH);
  if (!doc || !ok || doc.disabled) return null;
  await db.collection('users').updateOne({ _id: doc._id }, { $set: { lastLoginAt: new Date() } });
  return publicUser(doc, await rolesById(db));
}

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
  const user = doc ? publicUser(doc, await rolesById(db)) : null;
  userCache.set(String(id), { user, at: Date.now() });
  return user;
}

// A member's own profile (title, phone, about, photo…), see lib/people.js.
async function setProfile(id, profile) {
  const db = await getDb();
  const r = await db.collection('users').updateOne({ _id: objectId(id) }, { $set: { profile, ...(profile.name !== undefined ? { name: profile.name } : {}) } });
  if (!r.matchedCount) throw httpError(404, 'User not found');
  userCache.delete(String(id));
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
  emailInUse,
  listRoles,
  saveRole,
  deleteRole,
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
  getDb,
  objectId,
  setProfile,
  audit,
  listAudit,
  AUDIT_DAYS,
};
