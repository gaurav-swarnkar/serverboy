// Team management (owner only): where team accounts are stored, the accounts themselves, and
// the activity log.
const crypto = require('crypto');
const express = require('express');
const store = require('../lib/store');
const team = require('../lib/team');
const auth = require('../lib/auth');
const { mongosh } = require('../lib/mongosh');
const { PERMISSIONS, PRESETS, OWNER } = require('../lib/permissions');

const router = express.Router();
router.use('/team', auth.requirePermission(OWNER));

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

router.get('/team', async (req, res) => {
  res.json({ status: await team.status(), permissions: PERMISSIONS, presets: PRESETS, auditDays: team.AUDIT_DAYS });
});

// Connect team storage. Either { uri } for any MongoDB, or { serverId } to create a dedicated
// "serverboy" database and user on that server's MongoDB (Serverboy must run on that server).
router.post('/team/storage', async (req, res) => {
  let uri = String(req.body?.uri || '').trim();
  if (!uri && req.body?.serverId) {
    const server = store.getServer(req.body.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (!LOCAL_HOSTS.has(server.host)) {
      return res.status(400).json({
        error: 'Automatic setup only works when Serverboy runs on that server (added with host 127.0.0.1). Paste a connection string instead.',
      });
    }
    const password = crypto.randomBytes(24).toString('base64url');
    await mongosh(
      server.id,
      `const d = db.getSiblingDB('serverboy');
const roles = [{ role: 'readWrite', db: 'serverboy' }];
if (d.getUser('serverboy_app')) d.updateUser('serverboy_app', { pwd: ${JSON.stringify(password)}, roles });
else d.createUser({ user: 'serverboy_app', pwd: ${JSON.stringify(password)}, roles });
out({ ok: 1 });`,
    );
    uri = `mongodb://serverboy_app:${password}@127.0.0.1:27017/serverboy?authSource=serverboy`;
  }
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) return res.status(400).json({ error: 'Enter a connection string starting with mongodb://' });
  const result = await team.testUri(uri);
  await team.disconnect();
  store.setTeamDbUri(uri);
  team.audit({ user: req.user.username, ip: req.ip, action: `Connected team database "${result.database}"` });
  res.json({ ok: true, ...result });
});

router.delete('/team/storage', async (req, res) => {
  await team.audit({ user: req.user.username, ip: req.ip, action: 'Disconnected team database' });
  await team.disconnect();
  store.setTeamDbUri('');
  res.json({ ok: true });
});

router.get('/team/users', async (req, res) => {
  res.json(await team.listUsers());
});

router.post('/team/users', async (req, res) => {
  const user = await team.createUser(req.body || {}, req.user.username);
  team.audit({ user: req.user.username, ip: req.ip, action: `Created user ${user.username}${user.roleName ? ` (${user.roleName})` : ''}`, permissions: user.permissions });
  res.json(user);
});

router.put('/team/users/:userId', async (req, res) => {
  const { name, email, roleId, permissions, scope, disabled } = req.body || {};
  const user = await team.updateUser(req.params.userId, { name, email, roleId, permissions, scope, disabled });
  if (user.disabled) auth.dropSessionsFor(user.id);
  team.audit({
    user: req.user.username,
    ip: req.ip,
    action: `Updated user ${user.username}${user.roleName ? ` (${user.roleName})` : ''}${user.disabled ? ' (disabled)' : ''}`,
    permissions: user.permissions,
  });
  res.json(user);
});

router.post('/team/users/:userId/password', async (req, res) => {
  await team.setPassword(req.params.userId, req.body?.password);
  auth.dropSessionsFor(req.params.userId);
  const user = await team.getUser(req.params.userId);
  team.audit({ user: req.user.username, ip: req.ip, action: `Reset password for ${user?.username || req.params.userId}` });
  res.json({ ok: true });
});

router.delete('/team/users/:userId', async (req, res) => {
  const user = await team.getUser(req.params.userId);
  await team.deleteUser(req.params.userId);
  auth.dropSessionsFor(req.params.userId);
  team.audit({ user: req.user.username, ip: req.ip, action: `Deleted user ${user?.username || req.params.userId}` });
  res.json({ ok: true });
});

router.get('/team/roles', async (req, res) => {
  res.json(await team.listRoles());
});

router.post('/team/roles', async (req, res) => {
  const role = await team.saveRole(null, req.body || {});
  team.audit({ user: req.user.username, ip: req.ip, action: `Created role ${role.name}`, permissions: role.permissions });
  res.json(role);
});

router.put('/team/roles/:roleId', async (req, res) => {
  const role = await team.saveRole(req.params.roleId, req.body || {});
  team.audit({ user: req.user.username, ip: req.ip, action: `Updated role ${role.name}`, permissions: role.permissions });
  res.json(role);
});

router.delete('/team/roles/:roleId', async (req, res) => {
  const role = (await team.listRoles()).find((r) => r.id === req.params.roleId);
  await team.deleteRole(req.params.roleId);
  team.audit({ user: req.user.username, ip: req.ip, action: `Deleted role ${role?.name || req.params.roleId}` });
  res.json({ ok: true });
});

router.get('/team/audit', async (req, res) => {
  res.json(await team.listAudit({ limit: req.query.limit, user: req.query.user }));
});

module.exports = router;
