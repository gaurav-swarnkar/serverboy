// Dashboard health check, diagnosis and one-click fixes.
const express = require('express');
const health = require('../lib/health');
const team = require('../lib/team');
const { can } = require('../lib/permissions');
const scope = require('../lib/scope');
const { HttpError } = require('../lib/ssh');

const router = express.Router({ mergeParams: true });

router.get('/health', async (req, res) => {
  const result = await health.check(req.params.id);
  if (!scope.isAll(req.user, 'sites')) {
    // Only show the websites this person has access to.
    result.sites = result.sites.filter((s) => scope.canSeeSite(req.user, req.params.id, s.domain) || scope.canSeeSite(req.user, req.params.id, s.file));
    result.problems = result.problems.filter((p) => p.area !== 'site' || p.target === 'nginx' || result.sites.some((s) => s.domain === p.target));
    result.status = result.problems.some((p) => p.level === 'bad') ? 'bad' : result.problems.length ? 'warn' : 'ok';
  }
  res.json(result);
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
