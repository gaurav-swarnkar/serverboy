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
  // Node apps (API servers among them, named after their databases) only for people who manage
  // Node apps; backup warnings only for the owner, who handles backups.
  if (!req.user.isOwner) {
    const keep = (p) => (p.area !== 'app' || can(req.user, 'nodeapps')) && p.area !== 'backup';
    if (!can(req.user, 'nodeapps')) result.apps = [];
    result.problems = result.problems.filter(keep);
    result.ignored = (result.ignored || []).filter(keep);
    result.status = result.problems.some((p) => p.level === 'bad') ? 'bad' : result.problems.length ? 'warn' : 'ok';
  }
  if (!scope.isAll(req.user, 'sites')) {
    // Only show the websites this person has access to.
    result.sites = result.sites.filter((s) => scope.canSeeSite(req.user, req.params.id, s.domain) || scope.canSeeSite(req.user, req.params.id, s.file));
    result.problems = result.problems.filter((p) => p.area !== 'site' || p.target === 'nginx' || result.sites.some((s) => s.domain === p.target));
    result.ignored = (result.ignored || []).filter((p) => p.area !== 'site' || p.target === 'nginx' || result.sites.some((s) => s.domain === p.target));
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

// Ignore a warning (7 or 30 days, or always), or bring it back.
router.post('/health/ignore', (req, res) => {
  const days = [0, 7, 30].includes(Number(req.body?.days)) ? Number(req.body.days) : 7;
  const r = require('../lib/health-ignore').ignore(req.params.id, req.body?.key, { days, by: req.user.username, text: req.body?.text });
  team.audit({ user: req.user.username, ip: req.ip, action: `Ignored a health warning${days ? ` for ${days} days` : ''}: ${String(req.body?.text || req.body?.key).slice(0, 120)}` });
  res.json(r);
});

router.delete('/health/ignore', (req, res) => {
  const ok = require('../lib/health-ignore').unignore(req.params.id, String(req.body?.key || ''));
  if (!ok) throw new HttpError(404, 'Not ignored');
  team.audit({ user: req.user.username, ip: req.ip, action: `Stopped ignoring a health warning: ${String(req.body?.key).slice(0, 120)}` });
  res.json({ ok: true });
});

module.exports = router;
