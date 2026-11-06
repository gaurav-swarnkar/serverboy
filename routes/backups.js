// Backups of one server (owner only: a backup holds every database and file).
//   GET    /backups                  settings, last result, next run
//   PUT    /backups/settings         save settings (schedule, what, storage, keep)
//   GET    /backups/inventory        what can be backed up (databases, folders, free space)
//   POST   /backups/test-storage     check cloud storage with the given (or saved) settings
//   POST   /backups/run              back up now
//   POST   /backups/drill            test-restore the newest backup into temporary databases
//   GET    /backups/list             backups on the server and in cloud storage
//   POST   /backups/:bid/restore     restore chosen items
//   DELETE /backups/:bid             delete (?where=server|cloud|both)
//   GET    /backups/:bid/download/:file
const express = require('express');
const backups = require('../lib/backups');
const ssh = require('../lib/ssh');
const team = require('../lib/team');
const store = require('../lib/store');

const router = express.Router({ mergeParams: true });
const serverName = (req) => store.getServer(req.params.id)?.name || req.params.id;

router.get('/backups', (req, res) => res.json(backups.publicSettings(req.params.id)));

router.put('/backups/settings', (req, res) => {
  const out = backups.saveSettings(req.params.id, req.body || {});
  team.audit({ user: req.user.username, ip: req.ip, action: `Changed backup settings of ${serverName(req)} (${out.enabled ? `every ${out.schedule.every} at ${out.schedule.time}` : 'schedule off'}, storage: ${out.remoteLabel})` });
  res.json(out);
});

router.get('/backups/inventory', async (req, res) => res.json(await backups.inventory(req.params.id)));

router.post('/backups/test-storage', async (req, res) => res.json(await backups.testRemote(req.params.id, req.body?.remote)));

router.post('/backups/drill', (req, res) => res.json(backups.startDrill(req.params.id, { reason: 'manual', user: req.user.username, backupId: req.body?.backupId || null })));

router.post('/backups/run', (req, res) => res.json(backups.startBackup(req.params.id, { reason: 'manual', user: req.user.username })));

router.get('/backups/list', async (req, res) => res.json(await backups.listAll(req.params.id)));

router.post('/backups/:bid/restore', (req, res) => res.json(backups.startRestore(req.params.id, req.params.bid, req.body?.items, { user: req.user.username })));

router.delete('/backups/:bid', async (req, res) => {
  const where = ['server', 'cloud'].includes(req.query.where) ? req.query.where : 'both';
  await backups.deleteBackup(req.params.id, req.params.bid, where);
  team.audit({ user: req.user.username, ip: req.ip, action: `Deleted backup ${req.params.bid} of ${serverName(req)} (${where})` });
  res.json({ ok: true });
});

router.get('/backups/:bid/download/:file', async (req, res) => {
  const src = await backups.downloadSource(req.params.id, req.params.bid, req.params.file);
  if (src.url) return res.redirect(302, src.url);
  const stream = await ssh.execStream(req.params.id, `cat ${ssh.q(src.local)}`, { sudo: true });
  res.setHeader('Content-Type', req.params.file.endsWith('.json') ? 'application/json' : 'application/gzip');
  res.setHeader('Content-Length', String(src.size));
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.bid}-${req.params.file}"`);
  stream.pipe(res);
  res.on('close', () => stream.close());
});

module.exports = router;
