// Websites: Nginx virtual hosts + free SSL with certbot.
const path = require('path').posix;
const express = require('express');
const ssh = require('../lib/ssh');
const nginx = require('../lib/nginx');
const jobs = require('../lib/jobs');
const scope = require('../lib/scope');

const { q, HttpError } = ssh;
const router = express.Router({ mergeParams: true });

router.get('/sites', async (req, res) => {
  const r = await nginx.listSites(req.params.id);
  // Users limited to specific websites only see those, with their access level.
  r.sites = r.sites
    .filter((site) => scope.canSeeSite(req.user, req.params.id, site.name))
    .map((site) => ({ ...site, access: scope.siteLevel(req.user, req.params.id, site.name) }));
  r.canCreate = scope.isAll(req.user, 'sites');
  res.json(r);
});

router.post('/sites', async (req, res) => {
  scope.requireSite(req, null, 'all');
  const body = req.body || {};
  const aliases = String(body.aliases || '')
    .split(/[\s,]+/)
    .filter(Boolean);
  res.json(await nginx.createSite(req.params.id, { ...body, aliases, restrictRoot: !req.user.isOwner }));
});

router.get('/sites/:name/config', async (req, res) => {
  scope.requireSite(req, req.params.name, 'view');
  const file = nginx.siteFile(req.params.name);
  const buf = await ssh.readFile(req.params.id, file);
  res.json({ content: buf.toString('utf8') });
});

router.put('/sites/:name/config', async (req, res) => {
  const file = nginx.siteFile(req.params.name);
  const serverId = req.params.id;
  const backup = `${file}.serverboy-bak`;
  await ssh.exec(serverId, `cp ${q(file)} ${q(backup)}`, { sudo: true, check: true });
  await ssh.writeFile(serverId, file, String(req.body?.content || ''), { sudo: true });
  const result = await nginx.testAndReload(serverId);
  if (!result.ok) {
    await ssh.exec(serverId, `mv ${q(backup)} ${q(file)}`, { sudo: true });
    throw new HttpError(400, `Nginx rejected the configuration, your change was rolled back:\n${result.output}`);
  }
  await ssh.exec(serverId, `rm -f ${q(backup)}`, { sudo: true });
  res.json({ ok: true });
});

router.post('/sites/:name/toggle', async (req, res) => {
  scope.requireSite(req, req.params.name, 'edit');
  const file = nginx.siteFile(req.params.name);
  const link = path.join(nginx.ENABLED, path.basename(file));
  const cmd = req.body?.enabled ? `ln -sf ${q(file)} ${q(link)}` : `rm -f ${q(link)}`;
  await ssh.exec(req.params.id, cmd, { sudo: true, check: true });
  const result = await nginx.testAndReload(req.params.id);
  if (!result.ok) throw new HttpError(400, result.output);
  res.json({ ok: true });
});

router.delete('/sites/:name', async (req, res) => {
  scope.requireSite(req, req.params.name, 'all');
  const file = nginx.siteFile(req.params.name);
  const name = path.basename(file);
  const serverId = req.params.id;
  let removeRoot = '';
  if (req.body?.deleteFiles) {
    const r = await ssh.exec(serverId, `grep -m1 -E '^\\s*root\\s' ${q(file)} | sed -E 's/^\\s*root\\s+//; s/;.*//'`, { sudo: true });
    const root = r.stdout.trim();
    // Only remove web roots that live under /var/www/<site>.
    if (root.startsWith(`/var/www/${name}`)) removeRoot = ` && rm -rf -- ${q(`/var/www/${name}`)}`;
  }
  await ssh.exec(serverId, `rm -f ${q(path.join(nginx.ENABLED, name))} ${q(file)}${removeRoot}`, { sudo: true, check: true });
  await nginx.testAndReload(serverId);
  res.json({ ok: true });
});

router.post('/sites/:name/ssl', async (req, res) => {
  scope.requireSite(req, req.params.name, 'edit');
  const file = nginx.siteFile(req.params.name);
  const email = String(req.body?.email || '').trim();
  if (!/^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/.test(email)) throw new HttpError(400, "Enter a valid email (Let's Encrypt sends expiry notices to it)");
  const r = await ssh.exec(req.params.id, `grep -m1 -E '^\\s*server_name' ${q(file)} | sed -E 's/^\\s*server_name\\s+//; s/;.*//'`, { check: true });
  const domains = r.stdout.trim().split(/\s+/).filter((d) => d && d !== '_').map(nginx.validDomain);
  if (!domains.length) throw new HttpError(400, 'This site has no domain names');
  res.json(
    jobs.create(req.params.id, `SSL certificate for ${domains[0]}`, [
      {
        label: 'Checking certbot',
        cmd: 'command -v certbot >/dev/null || { apt-get update -y && apt-get install -y certbot python3-certbot-nginx; }',
        sudo: true,
      },
      {
        label: `Requesting certificate for ${domains.join(', ')} (the domain's DNS must already point to this server, and port 80/443 must be open in Azure)`,
        cmd: `certbot --nginx --non-interactive --agree-tos --redirect -m ${q(email)} ${domains.map((d) => `-d ${q(d)}`).join(' ')}`,
        sudo: true,
      },
    ]),
  );
});

module.exports = router;
