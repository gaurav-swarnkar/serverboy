// AI connector (MCP): the tokens of the logged-in person. The owner also sees and can revoke
// everyone's. AI tokens themselves can never call these routes (lib/auth.js).
const express = require('express');
const ai = require('../lib/ai-access');
const team = require('../lib/team');
const { HttpError } = require('../lib/ssh');

const router = express.Router();

router.get('/ai-tokens', (req, res) => {
  const all = req.user.isOwner && req.query.all === '1';
  res.json({ tokens: ai.list(all ? null : req.user.id), all });
});

router.post('/ai-tokens', (req, res) => {
  const access = String(req.body?.access || 'read');
  if (!ai.ACCESS.includes(access)) throw new HttpError(400, 'Access must be "read" or "manage"');
  const days = Number(req.body?.days) || 0;
  if (days < 0 || days > 3650) throw new HttpError(400, 'Days must be between 0 (never expires) and 3650');
  const { token, record } = ai.createToken({ userId: req.user.id, username: req.user.username, label: req.body?.label, access, ttlMs: days ? days * 86400e3 : 0 });
  team.audit({ user: req.user.username, ip: req.ip, action: `Created an AI access token "${record.label}" (${access})` });
  res.json({ token, record });
});

router.delete('/ai-tokens/:id', (req, res) => {
  const ok = ai.revoke(req.params.id, req.user.isOwner ? null : req.user.id);
  if (!ok) throw new HttpError(404, 'Token not found');
  team.audit({ user: req.user.username, ip: req.ip, action: 'Revoked AI access' });
  res.json({ ok: true });
});

module.exports = router;
