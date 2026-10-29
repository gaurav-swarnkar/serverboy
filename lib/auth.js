// Portal login. The owner logs in as "admin" with the password from data/config.json (always
// available, even when MongoDB is down). Team members are stored in MongoDB (lib/team.js).
// Sessions are in-memory tokens in an HttpOnly cookie.
const crypto = require('crypto');
const express = require('express');
const store = require('./store');
const team = require('./team');
const { PERMISSION_IDS, can } = require('./permissions');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'sb_session';
const OWNER_USERNAME = 'admin';
const sessions = new Map(); // token -> { expiresAt, userId }  (userId 'owner' for the owner)

const failedLogins = new Map(); // ip -> { count, until }

const OWNER_USER = Object.freeze({
  id: 'owner',
  username: OWNER_USERNAME,
  name: 'Owner',
  isOwner: true,
  permissions: PERMISSION_IDS,
});

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sessionFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { token, ...session };
}

// Resolve the logged-in user, or null. Team members are re-checked (cached briefly) so that
// disabling a user or changing permissions takes effect right away.
async function userFromRequest(req) {
  const session = sessionFromRequest(req);
  if (!session) return null;
  if (session.userId === 'owner') return OWNER_USER;
  const user = await team.getUser(session.userId);
  if (!user || user.disabled) {
    sessions.delete(session.token);
    return null;
  }
  return { ...user, isOwner: false };
}

function dropSessionsFor(userId) {
  for (const [token, s] of sessions) if (s.userId === String(userId)) sessions.delete(token);
}

function cookieOptions(req) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

async function requireAuth(req, res, next) {
  const user = await userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  // CSRF guard: state-changing requests must come from our own frontend (custom header).
  if (req.method !== 'GET' && req.headers['x-serverboy'] !== '1') {
    return res.status(403).json({ error: 'Missing request header' });
  }
  req.user = user;
  next();
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (can(req.user, permission)) return next();
    res.status(403).json({ error: deniedMessage(permission) });
  };
}

function deniedMessage(permission) {
  return permission === 'owner'
    ? 'Only the owner (super admin) can do this.'
    : `You don't have the "${permission}" permission. Ask the owner to grant it.`;
}

function publicMe(user) {
  return {
    username: user.username,
    name: user.name,
    isOwner: user.isOwner,
    role: user.isOwner ? 'Owner' : user.roleName || 'Custom',
    permissions: user.permissions,
  };
}

const router = express.Router();

router.post('/login', async (req, res) => {
  const ip = req.ip;
  const entry = failedLogins.get(ip);
  if (entry && entry.until > Date.now()) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  const username = String(req.body?.username || '').trim().toLowerCase() || OWNER_USERNAME;
  const password = req.body?.password;

  let user = null;
  if (username === OWNER_USERNAME) {
    if (store.verifyAdminPassword(password)) user = OWNER_USER;
  } else if (team.isConfigured()) {
    try {
      const found = await team.verifyLogin(username, password);
      if (found) user = { ...found, isOwner: false };
    } catch (err) {
      return res.status(503).json({ error: `Team logins are unavailable right now (${err.message}). The owner can still log in as "admin".` });
    }
  }

  if (!user) {
    const count = (entry?.count || 0) + 1;
    failedLogins.set(ip, { count, until: count >= 5 ? Date.now() + 5 * 60 * 1000 : 0 });
    team.audit({ user: username, ip, action: 'Login failed' });
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  failedLogins.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, userId: user.id });
  team.audit({ user: user.username, ip, action: 'Logged in' });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieOptions(req)}; Max-Age=${SESSION_TTL_MS / 1000}`);
  res.json({ ok: true, user: publicMe(user) });
});

router.post('/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieOptions(req)}; Max-Age=0`);
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  const user = await userFromRequest(req).catch(() => null);
  res.json({ loggedIn: Boolean(user), user: user ? publicMe(user) : null });
});

// Change your own password (owner or team member).
router.post('/password', requireAuth, async (req, res) => {
  const { current, next: nextPassword } = req.body || {};
  const user = req.user;
  const currentOk = user.isOwner ? store.verifyAdminPassword(current) : await team.verifyPassword(user.id, current);
  if (!currentOk) return res.status(400).json({ error: 'Current password is wrong' });
  if (typeof nextPassword !== 'string' || nextPassword.length < (user.isOwner ? 8 : 10)) {
    return res.status(400).json({ error: `New password must be at least ${user.isOwner ? 8 : 10} characters` });
  }
  if (user.isOwner) store.setAdminPassword(nextPassword);
  else await team.setPassword(user.id, nextPassword);
  team.audit({ user: user.username, ip: req.ip, action: 'Changed own password' });
  res.json({ ok: true });
});

module.exports = { router, requireAuth, requirePermission, deniedMessage, userFromRequest, dropSessionsFor, OWNER_USERNAME };
