// Per-user access to specific websites and databases ("scope"), on top of role permissions.
// A scope is either 'all' or a list of items, each with a level: 'view' or 'edit'.
//   sites:     [{ s: serverId, n: siteName, l: 'view' | 'edit' }]
//   databases: [{ s: serverId, e: 'mongo' | 'mysql', n: dbName, l: 'view' | 'edit' }]
const { HttpError } = require('./ssh');

const LEVELS = { view: 1, edit: 2 };
const NAME_RE = /^[A-Za-z0-9._-]{1,253}$/;
const SERVER_RE = /^[A-Za-z0-9-]{1,64}$/;

function scopeOf(user, kind) {
  if (!user || user.isOwner) return 'all';
  const s = user.scope?.[kind];
  return Array.isArray(s) ? s : 'all';
}

function isAll(user, kind) {
  return scopeOf(user, kind) === 'all';
}

function siteLevel(user, serverId, name) {
  const s = scopeOf(user, 'sites');
  if (s === 'all') return 'edit';
  return s.find((x) => x.s === serverId && x.n === name)?.l || null;
}

function dbLevel(user, serverId, engine, name) {
  const s = scopeOf(user, 'databases');
  if (s === 'all') return 'edit';
  return s.find((x) => x.s === serverId && x.e === engine && x.n === name)?.l || null;
}

function enough(have, need) {
  return Boolean(have) && LEVELS[have] >= LEVELS[need];
}

// need: 'view' | 'edit' | 'all' ('all' = only users who can access every site / database)
function requireSite(req, name, need) {
  if (need === 'all') {
    if (!isAll(req.user, 'sites')) throw new HttpError(403, 'You only have access to specific websites; ask the owner to do this.');
    return;
  }
  const have = siteLevel(req.user, req.params.id, name);
  if (!have) throw new HttpError(403, `You don't have access to the website ${name}.`);
  if (!enough(have, need)) throw new HttpError(403, `You can only view ${name}, not change it.`);
}

function requireDb(req, engine, name, need) {
  if (need === 'all') {
    if (!isAll(req.user, 'databases')) throw new HttpError(403, 'You only have access to specific databases; ask the owner to do this.');
    return;
  }
  const have = dbLevel(req.user, req.params.id, engine, name);
  if (!have) throw new HttpError(403, `You don't have access to the database ${name}.`);
  if (!enough(have, need)) throw new HttpError(403, `You can only view the database ${name}, not change it.`);
}

function canSeeSite(user, serverId, name) {
  return Boolean(siteLevel(user, serverId, name));
}

function canSeeDb(user, serverId, engine, name) {
  return Boolean(dbLevel(user, serverId, engine, name));
}

// Validate a scope sent by the owner.
function cleanScope(input) {
  const out = { sites: 'all', databases: 'all' };
  if (!input || typeof input !== 'object') return out;
  if (Array.isArray(input.sites)) {
    out.sites = input.sites
      .filter((x) => x && SERVER_RE.test(String(x.s)) && NAME_RE.test(String(x.n)) && LEVELS[x.l])
      .map((x) => ({ s: String(x.s), n: String(x.n), l: x.l }));
  }
  if (Array.isArray(input.databases)) {
    out.databases = input.databases
      .filter((x) => x && SERVER_RE.test(String(x.s)) && ['mongo', 'mysql'].includes(x.e) && NAME_RE.test(String(x.n)) && LEVELS[x.l])
      .map((x) => ({ s: String(x.s), e: x.e, n: String(x.n), l: x.l }));
  }
  return out;
}

module.exports = { scopeOf, isAll, siteLevel, dbLevel, requireSite, requireDb, canSeeSite, canSeeDb, cleanScope };
