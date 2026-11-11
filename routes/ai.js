// AI connector (MCP): the tokens of the logged-in person. The owner also sees and can revoke
// everyone's. AI tokens themselves can never call these routes (lib/auth.js).
const express = require('express');
const ai = require('../lib/ai-access');
const team = require('../lib/team');
const { HttpError } = require('../lib/ssh');

const router = express.Router();

router.get('/ai-tokens', (req, res) => {
  const all = req.user.isOwner && req.query.all === '1';
  res.json({ tokens: ai.list(all ? null : req.user.id), all, allowed: ai.allowed(req.user) });
});

const notAllowed = () => new HttpError(403, 'The Serverboy owner has turned off the AI connector for your account. Ask them to turn it on.');

router.post('/ai-tokens', (req, res) => {
  if (!ai.allowed(req.user)) throw notAllowed();
  const access = String(req.body?.access || 'read');
  if (!ai.ACCESS.includes(access)) throw new HttpError(400, 'Access must be "read" or "manage"');
  const days = Number(req.body?.days) || 0;
  if (days < 0 || days > 3650) throw new HttpError(400, 'Days must be between 0 (never expires) and 3650');
  const { token, record } = ai.createToken({ userId: req.user.id, username: req.user.username, label: req.body?.label, access, ttlMs: days ? days * 86400e3 : 0 });
  team.audit({ user: req.user.username, ip: req.ip, action: `Created an AI access token "${record.label}" (${access})` });
  res.json({ token, record });
});

// Switch between "only look" and "look and manage" without making a new token.
router.patch('/ai-tokens/:id', (req, res) => {
  const access = String(req.body?.access || '');
  if (!ai.ACCESS.includes(access)) throw new HttpError(400, 'Access must be "read" or "manage"');
  if (!ai.allowed(req.user)) throw notAllowed();
  if (!ai.setAccess(req.params.id, access, req.user.isOwner ? null : req.user.id)) throw new HttpError(404, 'Token not found');
  team.audit({ user: req.user.username, ip: req.ip, action: `Changed an AI connection to ${access === 'manage' ? 'look and manage' : 'only look'}` });
  res.json({ ok: true, access });
});

router.delete('/ai-tokens/:id', (req, res) => {
  const ok = ai.revoke(req.params.id, req.user.isOwner ? null : req.user.id);
  if (!ok) throw new HttpError(404, 'Token not found');
  team.audit({ user: req.user.username, ip: req.ip, action: 'Revoked AI access' });
  res.json({ ok: true });
});

// Who may use the AI connector (only the owner decides): on for the whole team by default,
// and on or off per person. Turning it off keeps their tokens but refuses them.
const ownerOnly = (req) => {
  if (!req.user.isOwner) throw new HttpError(403, 'Only the owner can change who may use the AI connector');
};

router.get('/ai-settings', (req, res) => {
  ownerOnly(req);
  res.json(ai.settings());
});

router.put('/ai-settings', (req, res) => {
  ownerOnly(req);
  if (typeof req.body?.team !== 'boolean') throw new HttpError(400, 'team must be true or false');
  ai.setTeamAllowed(req.body.team);
  team.audit({ user: req.user.username, ip: req.ip, action: req.body.team ? 'Allowed the team to use the AI connector' : 'Turned off the AI connector for team members' });
  res.json(ai.settings());
});

router.put('/ai-settings/users/:userId', async (req, res) => {
  ownerOnly(req);
  if (typeof req.body?.allowed !== 'boolean') throw new HttpError(400, 'allowed must be true or false');
  const u = await team.getUser(req.params.userId);
  if (!u) throw new HttpError(404, 'User not found');
  ai.setUserAllowed(u.id, req.body.allowed);
  team.audit({ user: req.user.username, ip: req.ip, action: `${req.body.allowed ? 'Allowed' : 'Turned off'} the AI connector for ${u.username}` });
  res.json(ai.settings());
});

module.exports = router;
