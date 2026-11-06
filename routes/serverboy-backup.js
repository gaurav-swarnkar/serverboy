// Backup and restore of Serverboy itself (owner only). Mounted under /api.
//   GET  /serverboy-backup              settings, last automatic copy, storages to choose from
//   PUT  /serverboy-backup/settings     { enabled, passphrase?, storageFrom, keep }
//   POST /serverboy-backup/file         { passphrase } → the encrypted .sbbackup file
//   POST /serverboy-backup/run          make a cloud copy now
//   GET  /serverboy-backup/cloud        copies in cloud storage
//   POST /serverboy-backup/preview      file upload or { cloud }, + passphrase → what is inside
//   POST /serverboy-backup/restore      same → replace Serverboy's data and restart
const express = require('express');
const multer = require('multer');
const selfBackup = require('../lib/self-backup');
const team = require('../lib/team');
const { HttpError } = require('../lib/ssh');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

router.use('/serverboy-backup', (req, res, next) => {
  if (!req.user.isOwner || req.user.viewAs) throw new HttpError(403, 'Only the owner (super admin) can do this.');
  next();
});

router.get('/serverboy-backup', (req, res) => res.json(selfBackup.publicSettings()));

router.put('/serverboy-backup/settings', (req, res) => {
  const out = selfBackup.saveSettings(req.body || {});
  team.audit({ user: req.user.username, ip: req.ip, action: `Changed Serverboy backup settings (automatic: ${out.enabled ? 'on' : 'off'})` });
  res.json(out);
});

router.post('/serverboy-backup/file', async (req, res) => {
  const { name, data } = await selfBackup.createFile(req.body?.passphrase);
  team.audit({ user: req.user.username, ip: req.ip, action: 'Downloaded a Serverboy backup' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(data);
});

router.post('/serverboy-backup/run', async (req, res) => res.json(await selfBackup.runScheduled({ force: true })));

router.get('/serverboy-backup/cloud', async (req, res) => res.json(await selfBackup.listCloud()));

async function source(req) {
  if (req.file) return req.file.buffer;
  if (req.body?.cloud) return selfBackup.readCloud(req.body.cloud);
  throw new HttpError(400, 'Choose a .sbbackup file');
}

router.post('/serverboy-backup/preview', upload.single('file'), async (req, res) => {
  res.json(selfBackup.preview(await source(req), req.body?.passphrase || ''));
});

router.post('/serverboy-backup/restore', upload.single('file'), async (req, res) => {
  const lines = [];
  const out = await selfBackup.restore(await source(req), req.body?.passphrase || '', { log: (l) => lines.push(l) });
  team.audit({ user: req.user.username, ip: req.ip, action: 'Restored Serverboy from a backup' });
  res.json({ ...out, log: lines });
  // Restart so every module loads the restored data (systemd starts Serverboy again).
  setTimeout(() => process.exit(0), 1500);
});

module.exports = router;
