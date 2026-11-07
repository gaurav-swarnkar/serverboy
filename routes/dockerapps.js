// 1-click apps (Docker Compose). Needs the System permission: containers run as root.
//   GET    /docker-apps                 catalog + installed apps with their status
//   POST   /docker-apps                 install { app, name, domain, https, fields }
//   POST   /docker-apps/:name/:action   start | stop | restart | update | delete { deleteData }
//   GET    /docker-apps/:name/logs
const express = require('express');
const apps = require('../lib/docker-apps');

const router = express.Router({ mergeParams: true });

router.get('/docker-apps', async (req, res) => res.json(await apps.list(req.params.id)));

router.post('/docker-apps', (req, res) => res.json(apps.install(req.params.id, req.body || {}, { user: req.user.username })));

router.get('/docker-apps/:name/logs', async (req, res) => res.json({ log: await apps.logs(req.params.id, req.params.name, req.query.lines) }));

router.post('/docker-apps/:name/:action', async (req, res) => {
  res.json(await apps.action(req.params.id, req.params.name, req.params.action, { deleteData: Boolean(req.body?.deleteData), user: req.user.username }));
});

module.exports = router;
