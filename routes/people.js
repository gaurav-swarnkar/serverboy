// Team directory, profiles and messages. Every logged-in person can see the team and their own
// messages; the owner can message one person, several or everyone, and see everyone's details.
const express = require('express');
const store = require('../lib/store');
const team = require('../lib/team');
const { HttpError } = require('../lib/ssh');

const router = express.Router();
const OWNER_ID = 'owner';
const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6', '#64748b'];
const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

const idOf = (user) => (user.isOwner ? OWNER_ID : String(user.id));
const str = (v, max) => String(v ?? '').trim().slice(0, max);

function cleanProfile(body, current = {}) {
  const p = { ...current };
  for (const [k, max] of [['title', 80], ['phone', 40], ['bio', 1000], ['location', 80], ['timezone', 60]]) if (body[k] !== undefined) p[k] = str(body[k], max);
  if (body.name !== undefined) p.name = str(body.name, 80);
  if (body.color !== undefined) p.color = COLORS.includes(body.color) ? body.color : COLORS[0];
  if (body.avatar !== undefined) {
    if (body.avatar === '' || body.avatar === null) p.avatar = '';
    else if (typeof body.avatar === 'string' && AVATAR_RE.test(body.avatar) && body.avatar.length <= 200 * 1024) p.avatar = body.avatar;
    else throw new HttpError(400, 'The photo must be a PNG, JPG or WebP image under 150 KB');
  }
  return p;
}

function ownerPerson() {
  const p = store.getOwnerProfile();
  return { id: OWNER_ID, username: 'admin', name: p.name || 'Owner', email: store.getOwnerEmail(), role: 'Owner', isOwner: true, profile: p, disabled: false, lastLoginAt: null, createdAt: null };
}

function teamPerson(u) {
  return { id: u.id, username: u.username, name: u.name || u.username, email: u.email, role: u.roleName || 'Custom', isOwner: false, profile: u.profile || {}, disabled: u.disabled, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, permissions: u.permissions, scope: u.scope };
}

async function everyone() {
  const list = [ownerPerson()];
  if (team.isConfigured()) list.push(...(await team.listUsers().catch(() => [])).map(teamPerson));
  return list;
}

// What others may see of a person. The owner (and the person) see everything.
function view(person, viewer) {
  const full = viewer.isOwner || idOf(viewer) === person.id;
  const { permissions, scope, ...basic } = person;
  return full ? person : basic;
}

router.get('/people', async (req, res) => {
  const list = (await everyone()).filter((p) => req.user.isOwner || !p.disabled);
  res.json({ people: list.map((p) => view(p, req.user)), me: idOf(req.user), colors: COLORS, teamDb: team.isConfigured() });
});

router.get('/people/:id', async (req, res) => {
  const id = req.params.id === 'me' ? idOf(req.user) : req.params.id;
  const person = (await everyone()).find((p) => p.id === id);
  if (!person || (person.disabled && !req.user.isOwner)) throw new HttpError(404, 'Not found');
  const out = view(person, req.user);
  if ((req.user.isOwner || idOf(req.user) === id) && team.isConfigured()) {
    out.activity = await team.listAudit({ limit: 80, user: person.username }).catch(() => []);
  }
  res.json(out);
});

// Edit a profile: your own, or anyone's for the owner.
router.put('/people/:id', async (req, res) => {
  const id = req.params.id === 'me' ? idOf(req.user) : req.params.id;
  if (id !== idOf(req.user) && !req.user.isOwner) throw new HttpError(403, 'You can only change your own profile.');
  const person = (await everyone()).find((p) => p.id === id);
  if (!person) throw new HttpError(404, 'Not found');
  const profile = cleanProfile(req.body || {}, person.profile);
  if (id === OWNER_ID) store.setOwnerProfile(profile);
  else await team.setProfile(id, profile);
  team.audit({ user: req.user.username, ip: req.ip, action: id === idOf(req.user) ? 'Updated own profile' : `Updated the profile of ${person.username}` });
  res.json({ ok: true });
});

// ---------- messages ----------

async function messages() {
  if (!team.isConfigured()) throw new HttpError(400, 'Messages need the team database. The owner can connect it under Administration → Settings.');
  return (await team.getDb()).collection('messages');
}

const canSee = (m, user) => user.isOwner || m.fromId === idOf(user) || m.to === 'all' || (Array.isArray(m.to) && m.to.includes(idOf(user)));
const isUnread = (m, user) => !(m.readBy || []).includes(idOf(user));

function shape(m, user, names) {
  return {
    id: String(m._id),
    from: { id: m.fromId, name: m.fromName },
    to: m.to === 'all' ? 'all' : m.to.map((id) => ({ id, name: names.get(id) || id })),
    subject: m.subject,
    body: m.body,
    level: m.level,
    createdAt: m.createdAt,
    lastAt: m.lastAt,
    replies: m.replies || [],
    unread: isUnread(m, user),
    readCount: (m.readBy || []).filter((x) => x !== m.fromId).length,
  };
}

async function nameMap() {
  return new Map((await everyone()).map((p) => [p.id, p.name || p.username]));
}

// Unread messages for the top bar (also sent with /api/version).
async function unreadCount(user) {
  if (!team.isConfigured()) return 0;
  try {
    const col = await messages();
    const me = idOf(user);
    const filter = user.isOwner ? { readBy: { $ne: me } } : { readBy: { $ne: me }, $or: [{ to: 'all' }, { to: me }, { fromId: me }] };
    return await col.countDocuments(filter);
  } catch {
    return 0;
  }
}

router.get('/messages', async (req, res) => {
  const col = await messages();
  const me = idOf(req.user);
  const filter = req.user.isOwner ? {} : { $or: [{ to: 'all' }, { to: me }, { fromId: me }] };
  const docs = await col.find(filter).sort({ lastAt: -1 }).limit(200).toArray();
  const names = await nameMap();
  res.json(docs.map((m) => shape(m, req.user, names)));
});

// The owner writes to one person, several or everyone; others can write to the owner.
router.post('/messages', async (req, res) => {
  const col = await messages();
  const subject = str(req.body?.subject, 150);
  const body = str(req.body?.body, 10000);
  if (!subject || !body) throw new HttpError(400, 'Write a subject and a message');
  let to;
  if (!req.user.isOwner) to = [OWNER_ID];
  else if (req.body?.to === 'all') to = 'all';
  else {
    const ids = new Set((await everyone()).map((p) => p.id));
    to = [...new Set((Array.isArray(req.body?.to) ? req.body.to : []).map(String))].filter((id) => ids.has(id) && id !== OWNER_ID);
    if (!to.length) throw new HttpError(400, 'Choose who gets the message');
  }
  const now = new Date();
  const me = idOf(req.user);
  const r = await col.insertOne({
    fromId: me,
    fromName: req.user.isOwner ? store.getOwnerProfile().name || 'Owner' : req.user.name || req.user.username,
    to,
    subject,
    body,
    level: req.body?.level === 'important' ? 'important' : 'normal',
    createdAt: now,
    lastAt: now,
    readBy: [me],
    replies: [],
  });
  team.audit({ user: req.user.username, ip: req.ip, action: `Sent a message "${subject.slice(0, 60)}" to ${to === 'all' ? 'everyone' : `${to.length} person(s)`}` });
  res.json({ id: String(r.insertedId) });
});

async function findMessage(req) {
  const col = await messages();
  const m = await col.findOne({ _id: team.objectId(req.params.msgId, 'Message') });
  if (!m || !canSee(m, req.user)) throw new HttpError(404, 'Message not found');
  return { col, m };
}

router.post('/messages/:msgId/read', async (req, res) => {
  const { col, m } = await findMessage(req);
  await col.updateOne({ _id: m._id }, { $addToSet: { readBy: idOf(req.user) } });
  res.json({ ok: true });
});

// A reply marks the conversation unread for everyone else in it.
router.post('/messages/:msgId/reply', async (req, res) => {
  const { col, m } = await findMessage(req);
  const body = str(req.body?.body, 10000);
  if (!body) throw new HttpError(400, 'Write a reply');
  const me = idOf(req.user);
  const reply = { fromId: me, fromName: req.user.isOwner ? store.getOwnerProfile().name || 'Owner' : req.user.name || req.user.username, body, at: new Date() };
  await col.updateOne({ _id: m._id }, { $push: { replies: reply }, $set: { lastAt: reply.at, readBy: [me] } });
  res.json({ ok: true });
});

router.delete('/messages/:msgId', async (req, res) => {
  if (!req.user.isOwner) throw new HttpError(403, 'Only the owner can delete messages.');
  const { col, m } = await findMessage(req);
  await col.deleteOne({ _id: m._id });
  res.json({ ok: true });
});

module.exports = router;
module.exports.unreadCount = unreadCount;
