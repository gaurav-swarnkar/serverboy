// Alerts settings, test messages, status and history (owner only). Mounted under /api.
const express = require('express');
const alerts = require('../lib/alerts');
const monitor = require('../lib/monitor');
const team = require('../lib/team');
const { HttpError } = require('../lib/ssh');

const router = express.Router();

router.use('/alerts', (req, res, next) => {
  if (!req.user.isOwner || req.user.viewAs) throw new HttpError(403, 'Only the owner (super admin) can do this.');
  next();
});

router.get('/alerts', (req, res) => res.json({ ...alerts.publicSettings(), status: monitor.status(), recent: alerts.recent().slice(0, 50) }));

router.put('/alerts/settings', (req, res) => {
  const out = alerts.saveSettings(req.body || {});
  team.audit({ user: req.user.username, ip: req.ip, action: `Changed alert settings (${alerts.CHANNELS.filter((c) => out.channels[c].enabled).join(', ') || 'inbox only'})` });
  res.json(out);
});

router.post('/alerts/test', async (req, res) => res.json(await alerts.test(String(req.body?.channel || ''), req.body?.settings)));

router.post('/alerts/check-now', async (req, res) => {
  const ids = req.body?.server ? [String(req.body.server)] : require('../lib/store').listServers().map((s) => s.id);
  await Promise.all(ids.map((id) => monitor.checkServer(id).catch(() => {})));
  res.json({ status: monitor.status(), recent: alerts.recent().slice(0, 50) });
});

module.exports = router;
