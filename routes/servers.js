const express = require('express');
const store = require('../lib/store');
const ssh = require('../lib/ssh');
const auth = require('../lib/auth');

const ownerOnly = auth.requirePermission('owner');

const router = express.Router();

router.get('/servers', (req, res) => {
  res.json(store.listServers());
});

router.post('/servers', ownerOnly, (req, res) => {
  res.json(store.addServer(req.body || {}));
});

router.put('/servers/:id', ownerOnly, (req, res) => {
  const updated = store.updateServer(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Server not found' });
  ssh.disconnect(req.params.id);
  res.json(updated);
});

router.delete('/servers/:id', ownerOnly, (req, res) => {
  ssh.disconnect(req.params.id);
  if (!store.removeServer(req.params.id)) return res.status(404).json({ error: 'Server not found' });
  res.json({ ok: true });
});

// Fresh connection test: reports login result, sudo capability and OS.
router.post('/servers/:id/test', ownerOnly, async (req, res) => {
  ssh.disconnect(req.params.id);
  const sudoMode = await ssh.sudoInfo(req.params.id);
  const r = await ssh.exec(req.params.id, '. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"; hostname');
  const [os, hostname] = r.stdout.trim().split('\n');
  const server = store.listServers().find((s) => s.id === req.params.id);
  res.json({ ok: true, sudoMode, os, hostname, fingerprint: server?.hostFingerprint });
});

module.exports = router;
