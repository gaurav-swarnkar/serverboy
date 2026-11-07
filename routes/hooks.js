// Public webhook endpoint for push-to-deploy (no login: GitHub / GitLab call it). Every delivery
// must carry the hook's secret (GitHub signs the body with it; GitLab sends it as a token), and
// the hook id itself is a random 128-bit value. Mounted before the JSON parser: the signature is
// computed over the exact bytes received.
const express = require('express');
const deploy = require('../lib/deploy');
const { loadAppConfig } = require('./nodeapps');

const router = express.Router();
const recent = new Map(); // ip -> timestamps, a small flood guard

router.post('/deploy/:hookId', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const now = Date.now();
  const hits = (recent.get(req.ip) || []).filter((t) => now - t < 60000);
  hits.push(now);
  recent.set(req.ip, hits);
  if (hits.length > 60) return res.status(429).json({ error: 'Too many requests' });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  try {
    const { status, body } = await deploy.handleHook(req.params.hookId, req.headers, raw, loadAppConfig);
    res.status(status).json(body);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.all('*rest', (req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = router;
