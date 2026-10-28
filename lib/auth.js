// Portal login: a single admin password, in-memory session tokens in an HttpOnly cookie.
const crypto = require('crypto');
const express = require('express');
const store = require('./store');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'sb_session';
const sessions = new Map(); // token -> expiresAt

const failedLogins = new Map(); // ip -> { count, until }

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
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function cookieOptions(req) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

function requireAuth(req, res, next) {
  if (!sessionFromRequest(req)) return res.status(401).json({ error: 'Not logged in' });
  // CSRF guard: state-changing requests must come from our own frontend (custom header).
  if (req.method !== 'GET' && req.headers['x-serverboy'] !== '1') {
    return res.status(403).json({ error: 'Missing request header' });
  }
  next();
}

const router = express.Router();

router.post('/login', (req, res) => {
  const ip = req.ip;
  const entry = failedLogins.get(ip);
  if (entry && entry.until > Date.now()) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  if (!store.verifyAdminPassword(req.body?.password)) {
    const count = (entry?.count || 0) + 1;
    failedLogins.set(ip, { count, until: count >= 5 ? Date.now() + 5 * 60 * 1000 : 0 });
    return res.status(401).json({ error: 'Wrong password' });
  }
  failedLogins.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieOptions(req)}; Max-Age=${SESSION_TTL_MS / 1000}`);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieOptions(req)}; Max-Age=0`);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ loggedIn: Boolean(sessionFromRequest(req)) });
});

router.post('/password', requireAuth, (req, res) => {
  const { current, next: nextPassword } = req.body || {};
  if (!store.verifyAdminPassword(current)) return res.status(400).json({ error: 'Current password is wrong' });
  if (typeof nextPassword !== 'string' || nextPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  store.setAdminPassword(nextPassword);
  res.json({ ok: true });
});

module.exports = { router, requireAuth, sessionFromRequest };
