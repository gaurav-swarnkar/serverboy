// Browser-based file manager. For the owner it uses the SSH user's permissions and falls back to
// sudo when denied. Team members never get sudo and are limited to website folders in /var/www.
const path = require('path').posix;
const express = require('express');
const multer = require('multer');
const ssh = require('../lib/ssh');
const { can } = require('../lib/permissions');

const { q, HttpError } = ssh;
const router = express.Router({ mergeParams: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024, files: 50 } });

const TEAM_ROOT = '/var/www';

function cleanPath(p) {
  const s = String(p || '').trim();
  if (!s.startsWith('/')) throw new HttpError(400, 'Path must be absolute');
  if (s.includes('\0')) throw new HttpError(400, 'Invalid path');
  return path.normalize(s);
}

function guardDangerous(p) {
  const critical = ['/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/proc', '/root', '/sbin', '/sys', '/usr', '/var', TEAM_ROOT];
  if (critical.includes(p)) throw new HttpError(400, `Refusing to modify ${p}: it is a critical system directory`);
}

// Check (and resolve) a path for the current user. The owner may use any path. Team members may
// only use real paths inside /var/www: symlinks are resolved on the server first, so a link cannot
// point outside it. Node app folders run code as the server user, so they need "nodeapps".
async function allowed(req, p) {
  const clean = cleanPath(p);
  if (req.user.isOwner) return clean;
  const r = await ssh.exec(req.params.id, `realpath -m -- ${q(clean)}`, { check: true });
  const real = r.stdout.trim();
  if (real !== TEAM_ROOT && !real.startsWith(`${TEAM_ROOT}/`)) {
    throw new HttpError(403, `Team members can only use files inside ${TEAM_ROOT}.`);
  }
  if (!can(req.user, 'nodeapps') && real !== TEAM_ROOT) {
    const appDir = real.split('/').slice(0, 4).join('/');
    const c = await ssh.exec(req.params.id, `[ -f ${q(`${appDir}/.serverboy-app.json`)} ] && echo APP`);
    if (c.stdout.includes('APP')) throw new HttpError(403, `${appDir} is a Node app; changing it needs the "nodeapps" permission.`);
  }
  return real;
}

const sudoOk = (req) => req.user.isOwner;
const run = (req, cmd, opts = {}) => ssh.execMaybeSudo(req.params.id, cmd, { check: true, allowSudo: sudoOk(req), ...opts });

router.get('/files/home', async (req, res) => {
  if (!req.user.isOwner) return res.json({ path: TEAM_ROOT });
  const r = await ssh.exec(req.params.id, 'echo "$HOME"', { check: true });
  res.json({ path: r.stdout.trim() || '/' });
});

router.get('/files/list', async (req, res) => {
  const dir = await allowed(req, req.query.path || (req.user.isOwner ? '/' : TEAM_ROOT));
  const r = await run(
    req,
    `set -o pipefail; find ${q(dir)} -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\t%Y\\t%s\\t%m\\t%u\\t%g\\t%T@\\t%l\\n' | LC_ALL=C sort -f`,
  );
  const entries = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, type, targetType, size, mode, owner, group, mtime, link] = line.split('\t');
      const isLink = type === 'l';
      return {
        name,
        type: isLink ? (targetType === 'd' ? 'dir' : 'file') : type === 'd' ? 'dir' : 'file',
        link: isLink ? link : null,
        size: Number(size),
        mode,
        owner,
        group,
        mtime: Math.round(Number(mtime) * 1000),
      };
    })
    .sort((a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1));
  res.json({ path: dir, entries, root: req.user.isOwner ? '/' : TEAM_ROOT });
});

router.get('/files/read', async (req, res) => {
  const file = await allowed(req, req.query.path);
  const buf = await ssh.readFile(req.params.id, file, { allowSudo: sudoOk(req) });
  if (buf.includes(0)) throw new HttpError(415, 'This looks like a binary file. Download it instead.');
  res.json({ path: file, content: buf.toString('utf8') });
});

router.post('/files/write', async (req, res) => {
  const file = await allowed(req, req.body?.path);
  const content = String(req.body?.content ?? '');
  await ssh.writeFile(req.params.id, file, Buffer.from(content, 'utf8'), { sudo: sudoOk(req) ? 'auto' : false });
  res.json({ ok: true });
});

router.post('/files/upload', upload.array('files'), async (req, res) => {
  const dir = await allowed(req, req.body?.path);
  for (const f of req.files || []) {
    // Browsers send folder-relative names for directory uploads; keep just the base name.
    const name = path.basename(Buffer.from(f.originalname, 'latin1').toString('utf8'));
    if (!name || name === '.' || name === '..') continue;
    const target = await allowed(req, path.join(dir, name));
    await ssh.writeFile(req.params.id, target, f.buffer, { sudo: sudoOk(req) ? 'auto' : false });
  }
  res.json({ ok: true, count: req.files?.length || 0 });
});

router.get('/files/download', async (req, res) => {
  const target = await allowed(req, req.query.path);
  const serverId = req.params.id;
  const check = await ssh.exec(serverId, `[ -d ${q(target)} ] && echo dir; [ -r ${q(target)} ] && echo readable`);
  const isDir = check.stdout.includes('dir');
  const sudo = !check.stdout.includes('readable');
  if (sudo && !sudoOk(req)) throw new HttpError(403, 'Permission denied: this file is not readable without admin rights.');
  const name = path.basename(target) || 'root';
  const cmd = isDir ? `tar -czf - -C ${q(path.dirname(target))} ${q(name)}` : `cat -- ${q(target)}`;
  const stream = await ssh.execStream(serverId, cmd, { sudo });
  const filename = isDir ? `${name}.tar.gz` : name;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  stream.pipe(res);
  res.on('close', () => stream.close());
});

router.post('/files/mkdir', async (req, res) => {
  const dir = await allowed(req, req.body?.path);
  await run(req, `mkdir -p -- ${q(dir)}`);
  res.json({ ok: true });
});

router.post('/files/touch', async (req, res) => {
  const file = await allowed(req, req.body?.path);
  await run(req, `[ -e ${q(file)} ] && { echo "File already exists" >&2; exit 1; }; touch -- ${q(file)}`);
  res.json({ ok: true });
});

router.post('/files/rename', async (req, res) => {
  const from = await allowed(req, req.body?.from);
  const to = await allowed(req, req.body?.to);
  guardDangerous(from);
  await run(req, `mv -n -- ${q(from)} ${q(to)}`);
  res.json({ ok: true });
});

router.post('/files/copy', async (req, res) => {
  const from = await allowed(req, req.body?.from);
  const to = await allowed(req, req.body?.to);
  await run(req, `cp -a -n -- ${q(from)} ${q(to)}`);
  res.json({ ok: true });
});

router.post('/files/delete', async (req, res) => {
  const paths = [];
  for (const p of req.body?.paths || []) paths.push(await allowed(req, p));
  if (!paths.length) throw new HttpError(400, 'Nothing to delete');
  paths.forEach(guardDangerous);
  await run(req, `rm -rf -- ${paths.map(q).join(' ')}`);
  res.json({ ok: true });
});

router.post('/files/chmod', async (req, res) => {
  const target = await allowed(req, req.body?.path);
  const mode = String(req.body?.mode || '');
  if (!/^[0-7]{3,4}$/.test(mode)) throw new HttpError(400, 'Mode must be octal, like 644 or 755');
  guardDangerous(target);
  const recursive = req.body?.recursive ? '-R ' : '';
  await run(req, `chmod ${recursive}${mode} -- ${q(target)}`);
  res.json({ ok: true });
});

// Owner only (enforced in lib/permissions.js).
router.post('/files/chown', async (req, res) => {
  const target = cleanPath(req.body?.path);
  const owner = String(req.body?.owner || '');
  if (!/^[a-z_][a-z0-9_-]*(:[a-z_][a-z0-9_-]*)?$/i.test(owner)) throw new HttpError(400, 'Owner must look like user or user:group');
  guardDangerous(target);
  const recursive = req.body?.recursive ? '-R ' : '';
  await ssh.exec(req.params.id, `chown ${recursive}${q(owner)} -- ${q(target)}`, { sudo: true, check: true });
  res.json({ ok: true });
});

// Extract an uploaded archive in place (zip, tar, tar.gz, tgz, tar.bz2, tar.xz).
router.post('/files/extract', async (req, res) => {
  const file = await allowed(req, req.body?.path);
  const dest = path.dirname(file);
  let cmd;
  if (/\.zip$/i.test(file)) {
    cmd = sudoOk(req)
      ? `command -v unzip >/dev/null || { echo "unzip is not installed (install it from App Store > Git & build tools)" >&2; exit 1; }; unzip -o -q ${q(file)} -d ${q(dest)}`
      : // Python's zipfile never creates symlinks and strips "../", so a zip cannot escape the folder.
        `python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' ${q(file)} ${q(dest)}`;
  } else if (/\.(tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i.test(file)) {
    cmd = `tar -xf ${q(file)} -C ${q(dest)}${sudoOk(req) ? '' : ' --no-same-owner --no-same-permissions'}`;
  } else throw new HttpError(400, 'Unsupported archive type');
  await run(req, cmd, { timeout: 10 * 60 * 1000 });
  res.json({ ok: true });
});

router.post('/files/compress', async (req, res) => {
  const target = await allowed(req, req.body?.path);
  const name = path.basename(target);
  const out = `${target}.tar.gz`;
  await run(req, `tar -czf ${q(out)} -C ${q(path.dirname(target))} ${q(name)}`, { timeout: 10 * 60 * 1000 });
  res.json({ ok: true, path: out });
});

module.exports = router;
