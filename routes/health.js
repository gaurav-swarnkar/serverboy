// Dashboard health check, diagnosis and one-click fixes.
const express = require('express');
const health = require('../lib/health');
const team = require('../lib/team');
const { can } = require('../lib/permissions');
const { HttpError } = require('../lib/ssh');

const router = express.Router({ mergeParams: true });

router.get('/health', async (req, res) => {
  res.json(await health.check(req.params.id));
});

router.get('/health/diagnose/:unit', async (req, res) => {
  res.json(await health.diagnose(req.params.id, req.params.unit));
});

// Each fix needs its own permission (restarting is "services", system changes are "system").
router.post('/health/fix', async (req, res) => {
  const { fix, unit } = req.body || {};
  const def = health.FIXES[fix];
  if (!def) throw new HttpError(400, 'Unknown fix');
  if (!can(req.user, def.permission)) throw new HttpError(403, `This fix needs the "${def.permission}" permission.`);
  const result = await health.applyFix(req.params.id, fix, unit);
  team.audit({ user: req.user.username, ip: req.ip, action: `Health fix: ${def.label}${unit ? ` (${unit})` : ''}`, status: result.ok ? 200 : 500 });
  res.json(result);
});

module.exports = router;
