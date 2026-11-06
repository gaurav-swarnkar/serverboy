// Databases and collections that belong to MongoDB / MySQL themselves or to Serverboy. They are
// shown under "System & internal" in Databases and are read-only there: no dropping, importing,
// inserting, editing or deleting, so nobody breaks the database server or Serverboy by accident.
const store = require('./store');
const { HttpError } = require('./ssh');

const MONGO_SYSTEM = {
  admin: 'MongoDB itself: database users and roles. Changing it can lock every app out.',
  local: 'MongoDB itself: replication data and the startup log.',
  config: 'MongoDB itself: internal settings and sessions.',
};
const MYSQL_SYSTEM = {
  mysql: 'MySQL itself: database users, passwords and privileges.',
  information_schema: 'MySQL itself: a read-only view describing all databases.',
  performance_schema: 'MySQL itself: performance counters.',
  sys: 'MySQL itself: helper views for administrators.',
};
const TEST_RESTORE = /^sbtest_/;

// The team database name (Serverboy logins, roles, messages, activity log).
function teamDbName() {
  const uri = store.getTeamDbUri();
  if (!uri) return null;
  try {
    return decodeURIComponent(new URL(uri).pathname.replace(/^\//, '')) || 'serverboy';
  } catch {
    return 'serverboy';
  }
}

// { kind: 'system' | 'serverboy', label, reason } for a protected database, else null.
function classify(engine, name) {
  const n = String(name || '');
  const sys = engine === 'mysql' ? MYSQL_SYSTEM : MONGO_SYSTEM;
  if (Object.prototype.hasOwnProperty.call(sys, n)) return { kind: 'system', label: engine === 'mysql' ? 'MySQL system' : 'MongoDB system', reason: sys[n] };
  if (engine === 'mongo' && n === teamDbName()) return { kind: 'serverboy', label: 'Serverboy', reason: 'Serverboy itself: team logins, roles, messages and the activity log. Changing it can lock everyone out of Serverboy. Manage it under Administration.' };
  if (TEST_RESTORE.test(n)) return { kind: 'serverboy', label: 'Serverboy (temporary)', reason: 'A temporary copy made by a backup test-restore. Serverboy deletes it automatically.' };
  return null;
}

// MongoDB's own collections inside any database (views list, profiler, JavaScript functions).
function collectionReason(name) {
  return /^system\./.test(String(name || '')) ? 'A MongoDB system collection (it stores views, profiling or settings for this database).' : null;
}

// Throw when a change would touch something protected.
function assertWritable(engine, db, collection) {
  const p = classify(engine, db);
  if (p) throw new HttpError(403, `"${db}" is protected (${p.label}), so it cannot be changed from Databases. ${p.reason}`);
  const c = collection && engine === 'mongo' ? collectionReason(collection) : null;
  if (c) throw new HttpError(403, `"${collection}" is protected. ${c}`);
}

module.exports = { classify, collectionReason, assertWritable, teamDbName };
