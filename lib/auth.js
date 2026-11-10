// Portal login. The owner logs in as "admin" with the password from data/config.json (always
// available, even when MongoDB is down). Team members are stored in MongoDB (lib/team.js).
// Sessions are random tokens in an HttpOnly cookie. They are kept in data/sessions.json (only a
// hash of each token) so that updating or restarting Serverboy does not log everyone out.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const store = require('./store');
const team = require('./team');
const twofactor = require('./twofactor');
const push = require('./push');
const { AsyncLocalStorage } = require('async_hooks');
const { PERMISSION_IDS, can } = require('./permissions');

// "Log in as": the owner opens a team member's account in a separate browser tab. That tab keeps
// its own session token (sent in the x-serverboy-session header, or ?sbs= on plain links and the
// terminal socket) so the owner's own login in other tabs is not touched.
const VIEW_AS_TTL_MS = 60 * 60 * 1000;
const VIEW_AS_MAX_MS = 8 * 60 * 60 * 1000;
const SESSION_HEADER = 'x-serverboy-session';
const viewAsCodes = new Map(); // one-time code -> { userId, expiresAt }
// Who is really acting during a request (read by team.audit to tag log entries).
const requestContext = new AsyncLocalStorage();

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'sb_session';
const OWNER_USERNAME = 'admin';
// token -> { expiresAt, userId } (userId 'owner' for the owner), saved to disk shortly after changes.
class SessionStore {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    this.timer = null;
    try {
      const now = Date.now();
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) if (v.expiresAt > now) this.map.set(k, v);
    } catch {
      /* no saved sessions yet */
    }
  }

  static key(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  get(token) {
    return this.map.get(SessionStore.key(token));
  }

  set(token, value) {
    this.map.set(SessionStore.key(token), value);
    this.save();
  }

  delete(token) {
    if (this.map.delete(SessionStore.key(token))) this.save();
  }

  deleteWhere(test) {
    for (const [k, v] of this.map) if (test(v)) this.map.delete(k);
    this.save();
  }

  // Sliding expiry changes on every request; write those changes at most every 30 seconds.
  touched() {
    this.save(30 * 1000);
  }

  save(delay = 500) {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), delay);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const now = Date.now();
    for (const [k, v] of this.map) if (v.expiresAt < now) this.map.delete(k);
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`Could not save sessions: ${err.message}`);
    }
  }
}
const sessions = new SessionStore(path.join(store.DATA_DIR, 'sessions.json'));
// Write pending changes when Serverboy stops (e.g. "systemctl restart serverboy" during an update).
process.once('exit', () => sessions.timer && sessions.flush());
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => process.exit(0));

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

// A "log in as" tab sends its own token; it wins over the cookie of the owner's normal login.
function tabToken(req) {
  const header = req.headers[SESSION_HEADER];
  if (header) return String(header);
  if (req.method === 'GET' || req.headers.upgrade) {
    try {
      return new URL(req.url, 'http://x').searchParams.get('sbs') || null;
    } catch {
      return null;
    }
  }
  return null;
}

function sessionFromRequest(req) {
  const tab = tabToken(req);
  const token = tab || parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  const now = Date.now();
  if (!session || session.expiresAt < now || (session.viewAs && session.viewAs.until < now)) {
    sessions.delete(token);
    return null;
  }
  // A view-as token only works from its own tab (never as a cookie).
  if (session.viewAs && !tab) return null;
  session.expiresAt = Math.min(now + (session.viewAs ? VIEW_AS_TTL_MS : SESSION_TTL_MS), session.viewAs ? session.viewAs.until : Infinity);
  sessions.touched();
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
  return session.viewAs ? { ...user, isOwner: false, viewAs: { by: session.viewAs.by, since: session.viewAs.since } } : { ...user, isOwner: false };
}

// Everyone logs out (used after restoring Serverboy from a backup).
function clearAllSessions() {
  sessions.deleteWhere(() => true);
  sessions.flush();
}

function dropSessionsFor(userId) {
  sessions.deleteWhere((s) => s.userId === String(userId));
  require('./ai-access').revokeUser(userId);
}

function cookieOptions(req) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

// An AI assistant's token (Authorization: Bearer sbt_…): it acts as the person who made it.
// Returns { user, token } or null. Disabled or removed team members get nothing.
async function userFromBearer(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(sbt_[A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const token = require('./ai-access').lookup(m[1]);
  if (!token) return null;
  if (token.userId === 'owner') return { user: OWNER_USER, token };
  const user = await team.getUser(token.userId);
  if (!user || user.disabled) return null;
  return { user: { ...user, isOwner: false }, token };
}

// What an AI token may never do, whatever its access: manage AI tokens, passwords or logins.
const AI_BLOCKED = /^\/(ai-tokens|password|account\/|view-as|team\/users\/[^/]+\/view-as|2fa|push)/;
// Read-only tokens may use these POST routes, because they only read.
const AI_READ_POST = /^\/servers\/[^/]+\/mongo\/find$/;

async function requireAuth(req, res, next) {
  if (req.headers.authorization) {
    const b = await userFromBearer(req);
    if (!b) return res.status(401).json({ error: 'The AI access token is not valid any more. Make a new one in Serverboy (AI connector).' });
    if (AI_BLOCKED.test(req.path)) return res.status(403).json({ error: 'AI assistants cannot do this. Do it in Serverboy yourself.' });
    if (b.token.access === 'read' && req.method !== 'GET' && !AI_READ_POST.test(req.path)) return res.status(403).json({ error: 'This AI access token can only look, not change things. Make a "manage" token to allow changes.' });
    // Bearer tokens are not sent by browsers on their own, so no CSRF check is needed.
    req.user = b.user;
    req.aiToken = b.token;
    // The activity log shows that an AI assistant did it.
    return requestContext.run({ viaAi: b.token.label }, next);
  }
  const user = await userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  // CSRF guard: state-changing requests must come from our own frontend (custom header).
  if (req.method !== 'GET' && req.headers['x-serverboy'] !== '1') {
    return res.status(403).json({ error: 'Missing request header' });
  }
  req.user = user;
  // Two-step login is required and this person has not set it up: only setting it up works.
  const s = sessionFromRequest(req);
  if (s?.enroll) {
    if (twofactor.enabled(user.id)) {
      const raw = sessions.get(s.token);
      if (raw) delete raw.enroll;
      sessions.touched();
    } else if (!/^\/(2fa\/(status|setup|confirm)|push\/|logout)/.test(req.path)) {
      return res.status(403).json({ error: 'Set up two-step login first (the owner requires it).', code: '2fa_setup' });
    }
  }
  if (user.viewAs) {
    // Changing the password or email of someone else's account is not part of "checking things".
    if (req.method !== 'GET' && /^\/(password|account\/)/.test(req.path)) return res.status(403).json({ error: 'Not available while you are logged in as someone else.' });
    return requestContext.run({ viewAsBy: user.viewAs.by }, next);
  }
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

function publicMe(user, { enroll = false } = {}) {
  return {
    twoFactor: { enabled: twofactor.enabled(user.id), required: twofactor.required(), mustSetUp: Boolean(enroll) },
    username: user.username,
    email: user.isOwner ? store.getOwnerEmail() : user.email || '',
    name: user.isOwner ? store.getOwnerProfile().name || 'Owner' : user.name,
    isOwner: user.isOwner,
    role: user.isOwner ? 'Owner' : user.roleName || 'Custom',
    permissions: user.permissions,
    scope: user.isOwner ? { sites: 'all', databases: 'all' } : user.scope,
    id: user.isOwner ? 'owner' : user.id,
    avatar: (user.isOwner ? store.getOwnerProfile() : user.profile || {}).avatar || '',
    color: (user.isOwner ? store.getOwnerProfile() : user.profile || {}).color || '',
    viewAs: user.viewAs || null,
  };
}

const router = express.Router();

router.post('/login', async (req, res) => {
  const ip = req.ip;
  const entry = failedLogins.get(ip);
  if (entry && entry.until > Date.now()) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  // "username" may also be an email address.
  const username = String(req.body?.username || '').trim().toLowerCase() || OWNER_USERNAME;
  const password = req.body?.password;
  const ownerEmail = store.getOwnerEmail();

  let user = null;
  if (username === OWNER_USERNAME || (ownerEmail && username === ownerEmail)) {
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
  // With two-step login, a right password does not clear the counter: only a finished login does.
  if (!twofactor.enabled(user.id)) failedLogins.delete(ip);
  // Two-step login: the password alone is not enough. The browser gets a ticket and proves the
  // second step with a code (or an approval on a phone) before it gets a session.
  if (twofactor.enabled(user.id)) {
    const ticket = crypto.randomBytes(24).toString('hex');
    loginTickets.set(ticket, { userId: String(user.id), username: user.username, ip, ua: String(req.headers['user-agent'] || ''), expiresAt: Date.now() + TICKET_MS, tries: 0, approval: null });
    pruneTickets();
    return res.json({ twoFactor: true, ticket, canApprove: push.hasDevices(user.id) });
  }
  startSession(req, res, user, { enroll: twofactor.required() });
});

const TICKET_MS = 5 * 60e3;
const loginTickets = new Map(); // ticket -> { userId, username, ip, ua, expiresAt, tries, approval }
const approvals = new Map(); // approval id (sent to the phone) -> ticket
function pruneTickets() {
  const now = Date.now();
  for (const [t, v] of loginTickets) if (v.expiresAt < now) loginTickets.delete(t);
  for (const [id, t] of approvals) if (!loginTickets.has(t)) approvals.delete(id);
}

async function ticketUser(t) {
  if (t.userId === 'owner') return OWNER_USER;
  const u = await team.getUser(t.userId).catch(() => null);
  return u && !u.disabled ? { ...u, isOwner: false } : null;
}

// enroll: two-step login is required but not set up yet; until it is, only setting it up works.
function startSession(req, res, user, { enroll = false, via = '' } = {}) {
  failedLogins.delete(req.ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, userId: user.id, ...(enroll && !twofactor.enabled(user.id) ? { enroll: true } : {}) });
  team.audit({ user: user.username, ip: req.ip, action: `Logged in${via ? ` (${via})` : ''}` });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieOptions(req)}; Max-Age=${SESSION_TTL_MS / 1000}`);
  res.json({ ok: true, user: publicMe(user, { enroll: enroll && !twofactor.enabled(user.id) }) });
}

// Second step with a code from the authenticator app, or a recovery code.
router.post('/login/2fa', async (req, res) => {
  const lock = failedLogins.get(req.ip);
  if (lock && lock.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const t = loginTickets.get(String(req.body?.ticket || ''));
  if (!t || t.expiresAt < Date.now()) return res.status(400).json({ error: 'This login has expired. Enter your password again.', expired: true });
  if (++t.tries > 5) {
    loginTickets.delete(String(req.body.ticket));
    return res.status(429).json({ error: 'Too many wrong codes. Enter your password again.', expired: true });
  }
  const how = twofactor.verify(t.userId, req.body?.code);
  if (!how) {
    // Wrong codes count like wrong passwords: 5 from one address lock it for 5 minutes, so new
    // login attempts cannot be used to keep guessing.
    const count = (failedLogins.get(req.ip)?.count || 0) + 1;
    failedLogins.set(req.ip, { count, until: count >= 5 ? Date.now() + 5 * 60 * 1000 : 0 });
    team.audit({ user: t.username, ip: req.ip, action: 'Login failed (wrong two-step code)' });
    return res.status(400).json({ error: 'That code is not right. Codes change every 30 seconds.' });
  }
  loginTickets.delete(String(req.body.ticket));
  const user = await ticketUser(t);
  if (!user) return res.status(403).json({ error: 'This account is not available.' });
  startSession(req, res, user, { via: how === 'recovery' ? `recovery code, ${twofactor.status(t.userId).recoveryLeft} left` : 'two-step code' });
});

// Ask for an approval on the person's phones (Serverboy app / browser with notifications on).
// The login page shows a number; the phone shows three and the right one must be picked.
router.post('/login/approve', async (req, res) => {
  const t = loginTickets.get(String(req.body?.ticket || ''));
  if (!t || t.expiresAt < Date.now()) return res.status(400).json({ error: 'This login has expired. Enter your password again.', expired: true });
  if (!push.hasDevices(t.userId)) return res.status(400).json({ error: 'No phone or computer has notifications on for this account. Use a code instead.' });
  if (!t.approval) {
    t.approval = { id: crypto.randomBytes(16).toString('hex'), number: 10 + crypto.randomInt(90), status: 'pending', sentAt: 0 };
    approvals.set(t.approval.id, String(req.body.ticket));
  }
  if (Date.now() - t.approval.sentAt > 20e3) {
    t.approval.sentAt = Date.now();
    const where = push.describe(t.ua);
    const results = await push.notifyUser(t.userId, { title: 'Is this you logging in?', body: `${t.username} on ${where}, from ${t.ip}. Tap to approve or deny.`, url: `/#/approve/${t.approval.id}`, tag: `login:${t.approval.id}` }, { kind: null, urgency: 'high', ttl: 300 });
    if (!results.some((r) => r.ok)) return res.status(502).json({ error: 'The approval could not be sent to your devices. Use a code instead.' });
  }
  res.json({ number: t.approval.number, expiresAt: t.expiresAt });
});

// The login page asks every few seconds; once approved on a phone it gets its session.
router.post('/login/approve-status', async (req, res) => {
  const ticket = String(req.body?.ticket || '');
  const t = loginTickets.get(ticket);
  if (!t || t.expiresAt < Date.now() || !t.approval) return res.json({ status: 'expired' });
  if (t.approval.status === 'denied') {
    loginTickets.delete(ticket);
    return res.json({ status: 'denied' });
  }
  if (t.approval.status !== 'approved') return res.json({ status: 'pending' });
  loginTickets.delete(ticket);
  const user = await ticketUser(t);
  if (!user) return res.json({ status: 'denied' });
  startSession(req, res, user, { via: 'approved on a phone' });
});

// On the phone (logged in): what is waiting for approval, and the decision.
router.get('/login-approvals/:id', requireAuth, (req, res) => {
  const t = loginTickets.get(approvals.get(req.params.id) || '');
  if (!t || t.expiresAt < Date.now() || t.userId !== String(req.user.id) || req.user.viewAs) return res.status(404).json({ error: 'This login request has expired or was already answered.' });
  const n = t.approval.number;
  const choices = new Set([n]);
  while (choices.size < 3) choices.add(10 + crypto.randomInt(90));
  res.json({ username: t.username, ip: t.ip, device: push.describe(t.ua), status: t.approval.status, expiresAt: t.expiresAt, choices: [...choices].sort(() => crypto.randomInt(3) - 1) });
});

router.post('/login-approvals/:id', requireAuth, (req, res) => {
  const t = loginTickets.get(approvals.get(req.params.id) || '');
  if (!t || t.expiresAt < Date.now() || t.userId !== String(req.user.id) || req.user.viewAs) return res.status(404).json({ error: 'This login request has expired or was already answered.' });
  if (t.approval.status !== 'pending') return res.json({ status: t.approval.status });
  const approve = req.body?.decision === 'approve' && Number(req.body?.number) === t.approval.number;
  t.approval.status = approve ? 'approved' : 'denied';
  team.audit({ user: t.username, ip: req.ip, action: approve ? `Approved a login from ${t.ip} on a phone` : `Denied a login from ${t.ip}${req.body?.decision === 'approve' ? ' (wrong number picked)' : ''}` });
  res.json({ status: t.approval.status });
});

router.post('/logout', (req, res) => {
  // Leaving a "log in as" tab ends only that tab's session; the owner stays logged in.
  const tab = req.headers[SESSION_HEADER];
  if (tab) {
    const s = sessions.get(tab);
    if (s?.viewAs) {
      sessions.delete(tab);
      team.audit({ user: 'admin', ip: req.ip, action: 'Stopped viewing as a team member' , viewAsOf: s.userId });
    }
    return res.json({ ok: true });
  }
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieOptions(req)}; Max-Age=0`);
  res.json({ ok: true });
});

// Owner: get a one-time code (valid 60 s) that opens a team member's account in a new tab.
router.post('/view-as/:userId', requireAuth, async (req, res) => {
  if (!req.user.isOwner || req.user.viewAs) return res.status(403).json({ error: 'Only the owner (super admin) can do this.' });
  const user = await team.getUser(String(req.params.userId)).catch(() => null);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.disabled) return res.status(400).json({ error: 'This user is disabled. Enable them first.' });
  const now = Date.now();
  for (const [c, v] of viewAsCodes) if (v.expiresAt < now) viewAsCodes.delete(c);
  const code = crypto.randomBytes(24).toString('hex');
  viewAsCodes.set(code, { userId: String(user.id), username: user.username, expiresAt: now + 60 * 1000 });
  res.json({ code });
});

// The new tab trades the code for its own session token (kept in that tab's sessionStorage).
router.post('/view-as-start', async (req, res) => {
  if (req.headers['x-serverboy'] !== '1') return res.status(403).json({ error: 'Missing request header' });
  // The code was issued to a logged-in owner; this browser must still be that owner.
  const owner = await userFromRequest({ ...req, headers: { cookie: req.headers.cookie }, method: 'POST', url: '/' }).catch(() => null);
  const entry = viewAsCodes.get(String(req.body?.code || ''));
  viewAsCodes.delete(String(req.body?.code || ''));
  if (!entry || entry.expiresAt < Date.now()) return res.status(400).json({ error: 'This link has expired. Click "Log in as" again.' });
  if (!owner?.isOwner) return res.status(403).json({ error: 'Log in as the owner in this browser first.' });
  const user = await team.getUser(entry.userId).catch(() => null);
  if (!user || user.disabled) return res.status(404).json({ error: 'User not found or disabled' });
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, { expiresAt: now + VIEW_AS_TTL_MS, userId: String(user.id), viewAs: { by: OWNER_USERNAME, since: now, until: now + VIEW_AS_MAX_MS } });
  team.audit({ user: OWNER_USERNAME, ip: req.ip, action: `Logged in as ${user.username} (view as)` });
  res.json({ token, user: publicMe({ ...user, isOwner: false, viewAs: { by: OWNER_USERNAME, since: now } }) });
});

router.get('/me', async (req, res) => {
  const user = await userFromRequest(req).catch(() => null);
  const s = user ? sessionFromRequest(req) : null;
  res.json({ loggedIn: Boolean(user), user: user ? publicMe(user, { enroll: Boolean(s?.enroll) && !twofactor.enabled(user.id) }) : null });
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

// The owner can set an email to log in with (team members' emails are set by the owner).
router.post('/account/email', requireAuth, async (req, res) => {
  if (!req.user.isOwner) return res.status(403).json({ error: 'Ask the owner to change your email.' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Not a valid email address' });
  if (email && (await team.emailInUse(email).catch(() => false))) return res.status(409).json({ error: 'A team member already uses that email' });
  store.setOwnerEmail(email);
  team.audit({ user: req.user.username, ip: req.ip, action: email ? 'Set owner email' : 'Removed owner email' });
  res.json({ ok: true, email });
});

module.exports = { userFromBearer, OWNER_USER, clearAllSessions, requestContext, router, requireAuth, requirePermission, deniedMessage, userFromRequest, dropSessionsFor, OWNER_USERNAME };
