// Two-step login and push notifications for the logged-in person (My account), plus the owner's
// "require two-step login for everyone" switch and resetting a member's two-step login.
const express = require('express');
const twofactor = require('../lib/twofactor');
const push = require('../lib/push');
const team = require('../lib/team');
const { HttpError } = require('../lib/ssh');

const router = express.Router();
const uid = (req) => String(req.user.id);
function notAsSomeoneElse(req) {
  if (req.user.viewAs) throw new HttpError(403, 'Not available while you are logged in as someone else.');
}

// ---------- two-step login ----------

router.get('/2fa/status', (req, res) => res.json({ ...twofactor.status(uid(req)), devices: push.devices(uid(req)).length }));

router.post('/2fa/setup', (req, res) => {
  notAsSomeoneElse(req);
  if (twofactor.enabled(uid(req))) throw new HttpError(409, 'Two-step login is already on.');
  const host = String(req.get('host') || 'serverboy').replace(/:\d+$/, '');
  res.json(twofactor.begin(uid(req), `${req.user.username}@${host}`));
});

router.post('/2fa/confirm', (req, res) => {
  notAsSomeoneElse(req);
  const codes = twofactor.confirm(uid(req), req.body?.code);
  if (!codes) throw new HttpError(400, 'That code is not right (or setting up took longer than 15 minutes). Check the time on your phone and try the newest code.');
  team.audit({ user: req.user.username, ip: req.ip, action: 'Turned on two-step login' });
  res.json({ recoveryCodes: codes });
});

router.post('/2fa/disable', (req, res) => {
  notAsSomeoneElse(req);
  if (twofactor.required()) throw new HttpError(403, 'The owner requires two-step login for everyone, so it cannot be turned off.');
  if (!twofactor.verify(uid(req), req.body?.code)) throw new HttpError(400, 'Enter a current code from your app (or a recovery code) to turn it off.');
  twofactor.disable(uid(req));
  team.audit({ user: req.user.username, ip: req.ip, action: 'Turned off two-step login' });
  res.json({ ok: true });
});

router.post('/2fa/recovery', (req, res) => {
  notAsSomeoneElse(req);
  if (!twofactor.verify(uid(req), req.body?.code)) throw new HttpError(400, 'Enter a current code from your app to make new recovery codes.');
  team.audit({ user: req.user.username, ip: req.ip, action: 'Made new two-step recovery codes' });
  res.json({ recoveryCodes: twofactor.regenerateRecovery(uid(req)) });
});

// Owner: require it for everyone, and reset a member who lost their phone and recovery codes.
router.put('/2fa/settings', (req, res) => {
  if (!req.user.isOwner) throw new HttpError(403, 'Only the owner (super admin) can do this.');
  if (req.body?.required && !twofactor.enabled('owner')) throw new HttpError(400, 'Turn on two-step login for yourself first (My account), then require it for everyone.');
  twofactor.setRequired(Boolean(req.body?.required));
  team.audit({ user: req.user.username, ip: req.ip, action: req.body?.required ? 'Required two-step login for everyone' : 'Stopped requiring two-step login' });
  res.json({ required: twofactor.required() });
});

router.post('/2fa/reset/:userId', async (req, res) => {
  if (!req.user.isOwner) throw new HttpError(403, 'Only the owner (super admin) can do this.');
  if (req.params.userId === 'owner') throw new HttpError(400, 'Use your recovery codes, or the reset command on the server (README).');
  const user = await team.getUser(req.params.userId).catch(() => null);
  if (!user) throw new HttpError(404, 'User not found');
  twofactor.disable(req.params.userId);
  team.audit({ user: req.user.username, ip: req.ip, action: `Reset two-step login of ${user.username}` });
  res.json({ ok: true });
});

router.get('/2fa/users', (req, res) => {
  if (!req.user.isOwner) throw new HttpError(403, 'Only the owner (super admin) can do this.');
  res.json(Object.keys(twofactor._data().users));
});

// ---------- push notifications ----------

router.get('/push/key', (req, res) => res.json({ publicKey: push.publicKey() }));

router.get('/push/devices', (req, res) => res.json({ devices: push.devices(uid(req)), prefs: push.prefs(uid(req)) }));

router.post('/push/subscribe', (req, res) => {
  notAsSomeoneElse(req);
  try {
    res.json(push.subscribe(uid(req), req.body?.subscription || {}, req.get('user-agent')));
  } catch (err) {
    throw new HttpError(400, err.message);
  }
});

router.post('/push/unsubscribe', (req, res) => {
  push.unsubscribe(uid(req), String(req.body?.endpoint || req.body?.id || ''));
  res.json({ ok: true });
});

router.put('/push/prefs', (req, res) => res.json(push.setPrefs(uid(req), req.body || {})));

router.post('/push/test', async (req, res) => {
  const results = await push.notifyUser(uid(req), { title: 'Serverboy', body: 'Notifications work on this device.', url: '/#/account', tag: 'test' }, { kind: null });
  if (!results.length) throw new HttpError(400, 'No device has notifications on yet.');
  res.json({ sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok) });
});

module.exports = router;
