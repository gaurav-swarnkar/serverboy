// AI access (MCP): tokens that let an AI assistant use Serverboy on behalf of one person.
//   - A token acts as the person who made it: the same role, the same websites / databases.
//   - "read" tokens can only look; "manage" tokens can also change things.
//   - Tokens are stored only as SHA-256 hashes (data/ai-access.json, mode 600).
// Two ways to get one:
//   - a personal token made in Serverboy (AI connector page), pasted into the AI tool, or
//   - OAuth: claude.ai and other apps send you to Serverboy to approve, and get a token back
//     (clients register themselves; codes need PKCE S256; access tokens last 1 hour and are
//     renewed with a refresh token).
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const store = require('./store');

const FILE = path.join(store.DATA_DIR, 'ai-access.json');
const ACCESS = ['read', 'manage'];
const OAUTH_TOKEN_MS = 3600e3;
const REFRESH_MS = 30 * 86400e3;
const CODE_MS = 5 * 60e3;
const MAX_CLIENTS = 200;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rand = (prefix) => `${prefix}${crypto.randomBytes(32).toString('base64url')}`;

let data = { tokens: [], clients: [], codes: [], refresh: [] };
try {
  data = { ...data, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch {
  /* first start */
}
let saveTimer = null;
function save(now = false) {
  const write = () => {
    saveTimer = null;
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  };
  if (now) return write();
  if (!saveTimer) saveTimer = setTimeout(write, 2000);
  saveTimer.unref?.();
}
process.once('exit', () => saveTimer && save(true));

function prune() {
  const t = Date.now();
  data.tokens = data.tokens.filter((x) => !x.expiresAt || x.expiresAt > t);
  data.codes = data.codes.filter((x) => x.expiresAt > t);
  data.refresh = data.refresh.filter((x) => x.expiresAt > t);
}

const publicToken = ({ hash, ...t }) => t;

// A personal token (shown once) or an OAuth access token.
function createToken({ userId, username, label, access, via = 'token', clientId = null, ttlMs = 0, grantId = null }) {
  if (!ACCESS.includes(access)) throw new Error('Access must be read or manage');
  prune();
  const token = rand('sbt_');
  const record = {
    id: crypto.randomBytes(6).toString('hex'),
    userId: String(userId),
    username,
    label: String(label || '').trim().slice(0, 60) || 'AI assistant',
    access,
    via,
    clientId,
    grantId,
    prefix: token.slice(0, 10),
    hash: sha(token),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    expiresAt: ttlMs ? Date.now() + ttlMs : null,
  };
  data.tokens.push(record);
  save(true);
  return { token, record: publicToken(record) };
}

function lookup(token) {
  if (!/^sbt_[A-Za-z0-9_-]{20,}$/.test(String(token || ''))) return null;
  const h = sha(token);
  const t = data.tokens.find((x) => x.hash === h);
  if (!t || (t.expiresAt && t.expiresAt < Date.now())) return null;
  // Remember when it was last used (at most once a minute, to keep writes low).
  if (!t.lastUsedAt || Date.now() - Date.parse(t.lastUsedAt) > 60e3) {
    t.lastUsedAt = new Date().toISOString();
    save();
  }
  return publicToken(t);
}

// Personal tokens and OAuth apps (one row per approval), newest first.
function list(userId = null) {
  prune();
  const rows = data.tokens.filter((t) => !userId || t.userId === String(userId));
  const out = [];
  const seen = new Set();
  for (const t of rows.slice().reverse()) {
    if (t.via === 'oauth') {
      if (seen.has(t.grantId)) continue;
      seen.add(t.grantId);
    }
    out.push({ ...publicToken(t), client: t.clientId ? data.clients.find((c) => c.client_id === t.clientId)?.client_name || 'App' : null });
  }
  // OAuth approvals whose access token expired but whose refresh token still works.
  for (const r of data.refresh.slice().reverse()) {
    if ((userId && r.userId !== String(userId)) || seen.has(r.grantId)) continue;
    seen.add(r.grantId);
    out.push({ id: `g-${r.grantId}`, grantId: r.grantId, userId: r.userId, username: r.username, label: r.label, access: r.access, via: 'oauth', client: data.clients.find((c) => c.client_id === r.clientId)?.client_name || 'App', createdAt: r.createdAt, lastUsedAt: null, expiresAt: null });
  }
  return out;
}

// Revoke a token, or everything an OAuth approval issued. userId limits it to the person's own.
function revoke(id, userId = null) {
  const mine = (x) => !userId || x.userId === String(userId);
  const t = data.tokens.find((x) => x.id === id && mine(x));
  const grantId = t?.grantId || (String(id).startsWith('g-') ? String(id).slice(2) : null);
  const before = data.tokens.length + data.refresh.length;
  if (grantId) {
    data.tokens = data.tokens.filter((x) => !(x.grantId === grantId && mine(x)));
    data.refresh = data.refresh.filter((x) => !(x.grantId === grantId && mine(x)));
  } else data.tokens = data.tokens.filter((x) => !(x.id === id && mine(x)));
  save(true);
  return data.tokens.length + data.refresh.length < before;
}

// A removed or disabled team member: their AI access ends too.
function revokeUser(userId) {
  data.tokens = data.tokens.filter((x) => x.userId !== String(userId));
  data.refresh = data.refresh.filter((x) => x.userId !== String(userId));
  save(true);
}

// ---------- OAuth ----------

function validRedirect(u) {
  try {
    const url = new URL(u);
    if (url.hash) return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
}

function registerClient({ client_name, redirect_uris }) {
  const uris = Array.isArray(redirect_uris) ? redirect_uris.map(String) : [];
  if (!uris.length || !uris.every(validRedirect)) throw Object.assign(new Error('redirect_uris must be https (or http://localhost) addresses'), { oauth: 'invalid_redirect_uri' });
  const client = { client_id: `sbc_${crypto.randomBytes(12).toString('hex')}`, client_name: String(client_name || 'AI app').slice(0, 80), redirect_uris: uris, client_id_issued_at: Math.floor(Date.now() / 1000) };
  data.clients.push(client);
  // Too many registrations: forget the oldest apps that are not connected.
  if (data.clients.length > MAX_CLIENTS) {
    const used = new Set([...data.tokens.map((t) => t.clientId), ...data.refresh.map((r) => r.clientId)]);
    const spare = data.clients.filter((c) => !used.has(c.client_id) && c !== client);
    const drop = new Set(spare.slice(0, data.clients.length - MAX_CLIENTS).map((c) => c.client_id));
    data.clients = data.clients.filter((c) => !drop.has(c.client_id));
  }
  save(true);
  return client;
}

const getClient = (id) => data.clients.find((c) => c.client_id === id) || null;

function createCode({ clientId, redirectUri, challenge, userId, username, access }) {
  prune();
  const code = rand('sbo_');
  data.codes.push({ hash: sha(code), clientId, redirectUri, challenge, userId: String(userId), username, access, expiresAt: Date.now() + CODE_MS });
  save(true);
  return code;
}

// Exchange a code (once) for tokens; checks the client, the redirect address and PKCE.
function redeemCode({ code, clientId, redirectUri, verifier }) {
  const h = sha(code);
  const c = data.codes.find((x) => x.hash === h);
  data.codes = data.codes.filter((x) => x.hash !== h);
  save(true);
  if (!c || c.expiresAt < Date.now() || c.clientId !== clientId || c.redirectUri !== redirectUri) return null;
  const expected = crypto.createHash('sha256').update(String(verifier || '')).digest('base64url');
  if (!verifier || expected !== c.challenge) return null;
  return issue({ clientId, userId: c.userId, username: c.username, access: c.access, grantId: crypto.randomBytes(8).toString('hex') });
}

function issue({ clientId, userId, username, access, grantId }) {
  const label = `${getClient(clientId)?.client_name || 'App'} (connected)`;
  const { token } = createToken({ userId, username, label, access, via: 'oauth', clientId, ttlMs: OAUTH_TOKEN_MS, grantId });
  const refresh = rand('sbr_');
  data.refresh.push({ hash: sha(refresh), clientId, userId: String(userId), username, access, grantId, label, createdAt: new Date().toISOString(), expiresAt: Date.now() + REFRESH_MS });
  save(true);
  return { access_token: token, token_type: 'Bearer', expires_in: OAUTH_TOKEN_MS / 1000, refresh_token: refresh, scope: access };
}

// A refresh token is used once: it returns a new access token and a new refresh token.
function refresh({ refreshToken, clientId }) {
  const h = sha(refreshToken);
  const r = data.refresh.find((x) => x.hash === h);
  if (!r || r.expiresAt < Date.now() || r.clientId !== clientId) return null;
  data.refresh = data.refresh.filter((x) => x.hash !== h);
  // The old access tokens of this approval end now.
  data.tokens = data.tokens.filter((x) => x.grantId !== r.grantId);
  return issue({ clientId, userId: r.userId, username: r.username, access: r.access, grantId: r.grantId });
}

module.exports = { ACCESS, createToken, lookup, list, revoke, revokeUser, registerClient, getClient, createCode, redeemCode, refresh, validRedirect, _data: () => data };
