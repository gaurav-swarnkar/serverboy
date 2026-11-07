// Safe deploys of Node apps from git, push-to-deploy webhooks, releases and rollback.
//
// A deploy never touches the running app until the new version is built:
//   1. fetch the branch into a staging folder (/var/www/.serverboy-builds/<app>-<id>)
//   2. install and build there (a failure here changes nothing)
//   3. swap: the live folder becomes a release (/var/www/.serverboy-releases/<app>/<id>),
//      the staging folder becomes /var/www/<app>; .env and the "keep" paths move along
//   4. restart under PM2 and check health; if the app does not come up, swap back
// The newest few releases are kept (with node_modules), so a rollback is a swap and a restart.
const crypto = require('crypto');
const ssh = require('./ssh');
const store = require('./store');
const jobs = require('./jobs');
const pm2 = require('./pm2');

const { q, HttpError } = ssh;
const BUILDS = '/var/www/.serverboy-builds';
const RELEASES = '/var/www/.serverboy-releases';
const RELEASE_FILE = '.serverboy-release.json';
const ALWAYS_KEEP = ['.env', '.serverboy-app.json', '.serverboy-pm2.json'];
const ID_RE = /^[0-9]{8}-[0-9]{6}$|^before-[0-9]{8}-[0-9]{6}$/;
const deploying = new Map(); // `${serverId}:${app}` -> { jobId, pending }

const newId = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const appDir = (name) => `/var/www/${name}`;
const keyFile = (name) => `~/.ssh/serverboy-deploy-${name}`;

// Paths inside the app folder that survive deploys (uploads, SQLite files, …).
function cleanKeep(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : String(list || '').split(/[\n,]+/)) {
    const p = String(raw).trim().replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!p) continue;
    if (!/^[A-Za-z0-9._@+-][A-Za-z0-9._@+/-]*$/.test(p) || p.split('/').some((s) => s === '..' || s === '.') || /^\.git(\/|$)/.test(p) || p === 'node_modules') {
      throw new HttpError(400, `"${p}" cannot be kept between deploys (use a path inside the app folder, like uploads or data/app.db).`);
    }
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > 20) throw new HttpError(400, 'Keep at most 20 paths');
  return out;
}

// git over SSH: accept the host key once, never prompt, and use the app's deploy key if it has one.
const gitEnv = (name) => `export GIT_TERMINAL_PROMPT=0
K=${keyFile(name)}
GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes"
[ -f "$K" ] && GIT_SSH_COMMAND="$GIT_SSH_COMMAND -i $K -o IdentitiesOnly=yes"
export GIT_SSH_COMMAND`;

function installCmd(cfg) {
  return cfg.installCmd || 'if [ -f package-lock.json ]; then npm ci --include=dev; elif [ -f yarn.lock ]; then npx --yes yarn install --frozen-lockfile; elif [ -f pnpm-lock.yaml ]; then npx --yes pnpm install --frozen-lockfile; else npm install --include=dev; fi';
}

// Move the kept paths from one app folder to another (used by deploy, switch-back and rollback).
function moveKeptScript(from, to, keep) {
  return keep
    .map((p) => `if [ -e ${q(`${from}/${p}`)} ]; then mkdir -p "$(dirname ${q(`${to}/${p}`)})"; rm -rf ${q(`${to}/${p}`)}; mv ${q(`${from}/${p}`)} ${q(`${to}/${p}`)}; fi`)
    .join('\n');
}

async function readRelease(serverId, dir) {
  const r = await ssh.exec(serverId, `cat ${q(`${dir}/${RELEASE_FILE}`)} 2>/dev/null`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// Wait until PM2 says online and (if the app has a port) something answers on it.
async function healthy(serverId, cfg, log) {
  const r = await ssh.exec(
    serverId,
    `ok=0; bad=0
for i in $(seq 1 10); do
  sleep 2
  st=$(pm2 jlist 2>/dev/null | tail -1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).find(x=>x.name===process.argv[1]);console.log(p?p.pm2_env.status+" "+p.pm2_env.restart_time:"missing")}catch{console.log("unknown")}})' ${q(cfg.name)})
  ${cfg.port ? `code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:${Number(cfg.port)}/ || true)` : 'code=skip'}
  echo "  check $i: pm2 $st, port ${cfg.port || '-'}: $code"
  case "$st" in
    online*) bad=0; if [ "$code" != "000" ]; then ok=$((ok+1)); [ $ok -ge 2 ] && exit 0; fi;;
    errored*|stopped*|missing*) ok=0; bad=$((bad+1)); [ $bad -ge 3 ] && { echo "  the app keeps crashing"; exit 1; };;
    *) ok=0;;
  esac
done
exit 1`,
    { onData: log, timeout: 60000 },
  );
  return r.code === 0;
}

const pm2Restart = (name) => `cd ${q(appDir(name))} && pm2 delete ${q(name)} >/dev/null 2>&1; pm2 start .serverboy-pm2.json >/dev/null && pm2 save >/dev/null && echo "Restarted ${name}"`;

/**
 * A safe deploy of an app that has a git repository. Returns the job summary.
 * opts.by: who started it (shown in releases and the activity log); opts.reason: manual | push
 */
function startDeploy(serverId, cfg, { by = 'serverboy', reason = 'manual', note = '' } = {}) {
  if (!cfg.repo) throw new HttpError(400, 'This app has no git repository; use Redeploy.');
  const key = `${serverId}:${cfg.name}`;
  const busy = deploying.get(key);
  if (busy) {
    busy.pending = { by, reason, note };
    return { queued: true, job: busy.jobId };
  }
  const server = store.getServer(serverId);
  const id = newId();
  const live = appDir(cfg.name);
  const stage = `${BUILDS}/${cfg.name}-${id}`;
  const rel = `${RELEASES}/${cfg.name}`;
  const keep = [...ALWAYS_KEEP, ...cleanKeep(cfg.keep || [])];
  const ctx = { commit: null, oldId: null, swapped: false, healthy: false };

  const steps = [
    {
      label: 'Checking Node.js, npm, PM2 and git',
      cmd: `for t in node npm pm2 git; do command -v $t >/dev/null || { echo "$t is not installed. Install it from the App Store."; exit 1; }; done
echo "node $(node --version), npm $(npm --version), pm2 $(pm2 --version | tail -1)"`,
    },
    {
      label: 'Preparing a separate build folder (the running app is not touched)',
      fn: async (log) => {
        const user = (await ssh.connect(serverId)).server.username;
        await ssh.exec(serverId, `mkdir -p ${BUILDS} ${q(rel)} && chown ${q(user)}: ${BUILDS} && chmod 755 ${BUILDS} && rm -rf ${q(stage)} && mkdir ${q(stage)} && chown ${q(user)}: ${q(stage)}`, { sudo: true, check: true });
        log(`${stage}\n`);
      },
    },
    {
      label: `Fetching ${cfg.repo} (${cfg.branch})`,
      fn: async (log) => {
        const r = await ssh.exec(
          serverId,
          `set -e
${gitEnv(cfg.name)}
cd ${q(stage)}
git init -q
git remote add origin ${q(cfg.repo)}
git fetch -q --depth 1 origin ${q(cfg.branch)}
git checkout -q FETCH_HEAD
git log -1 --format='%H%n%h%n%s%n%an'`,
          { timeout: 10 * 60 * 1000 },
        );
        if (r.code !== 0) throw new Error(`git fetch failed:\n${(r.stdout + r.stderr).trim().slice(-800)}${/Permission denied|publickey|could not read Username/.test(r.stderr) ? '\n\nIs the repository private? Create a deploy key for this app (Deploys → Deploy key) and add it to the repository.' : ''}`);
        const [full, short, subject, author] = r.stdout.trim().split('\n');
        ctx.commit = { full, short, subject, author };
        log(`Commit ${short}: ${subject} (${author})\n`);
        // The build may need the environment (e.g. Next.js reads .env at build time).
        await ssh.exec(serverId, `[ -f ${q(`${live}/.env`)} ] && cp -p ${q(`${live}/.env`)} ${q(`${stage}/.env`)}; true`);
      },
    },
    { label: 'Installing dependencies', cmd: `cd ${q(stage)} && ${installCmd(cfg)}`, timeout: 30 * 60 * 1000 },
  ];
  if (cfg.buildCmd) steps.push({ label: `Building: ${cfg.buildCmd}`, cmd: `cd ${q(stage)} && ${cfg.buildCmd}`, timeout: 30 * 60 * 1000 });
  steps.push(
    {
      label: 'Switching to the new version',
      fn: async (log) => {
        const old = await readRelease(serverId, live);
        ctx.oldId = old?.id && ID_RE.test(old.id) ? old.id : `before-${id}`;
        const release = { id, commit: ctx.commit?.full, short: ctx.commit?.short, message: ctx.commit?.subject, author: ctx.commit?.author, branch: cfg.branch, deployedAt: new Date().toISOString(), by, reason };
        await ssh.writeFile(serverId, `${stage}/${RELEASE_FILE}`, JSON.stringify(release, null, 2), { sudo: false });
        const r = await ssh.exec(
          serverId,
          `set -e
[ -e ${q(`${rel}/${ctx.oldId}`)} ] && rm -rf ${q(`${rel}/${ctx.oldId}`)}
# Settings files are copied first so the app's settings are readable at every moment.
for f in ${ALWAYS_KEEP.map(q).join(' ')}; do [ -e ${q(live)}/"$f" ] && cp -p ${q(live)}/"$f" ${q(stage)}/"$f"; done
${moveKeptScript(live, stage, keep.filter((k) => !ALWAYS_KEEP.includes(k)))}
[ -d ${q(live)} ] && mv ${q(live)} ${q(`${rel}/${ctx.oldId}`)}
mv ${q(stage)} ${q(live)}
echo "Live: ${id}, previous version kept as ${ctx.oldId}"`,
          { sudo: true },
        );
        log(r.stdout);
        if (r.code !== 0) throw new Error(`Switching failed: ${r.stderr.trim()}`);
        ctx.swapped = true;
      },
    },
    { label: 'Checking PM2', fn: async (log) => log(`${await pm2.ensureDaemon(serverId)}\n`) },
    {
      label: 'Starting the new version and checking it',
      fn: async (log) => {
        const r = await ssh.exec(serverId, pm2Restart(cfg.name));
        log(r.stdout + r.stderr);
        ctx.healthy = r.code === 0 && (await healthy(serverId, cfg, log));
        if (ctx.healthy) return log('The new version is running.\n');
        // Not healthy: put the previous version back.
        log('\nThe new version did not start properly. Switching back to the previous version…\n');
        const back = await ssh.exec(
          serverId,
          `set -e
if [ -d ${q(`${rel}/${ctx.oldId}`)} ]; then
  ${moveKeptScript(live, `${rel}/${ctx.oldId}`, keep).replace(/\n/g, '\n  ')}
  mv ${q(live)} ${q(`${rel}/failed-${id}`)}
  mv ${q(`${rel}/${ctx.oldId}`)} ${q(live)}
  echo "Previous version is live again."
fi`,
          { sudo: true },
        );
        log(back.stdout + back.stderr);
        const again = await ssh.exec(serverId, pm2Restart(cfg.name));
        log(again.stdout);
        const logs = await ssh.exec(serverId, `tail -n 40 ~/.pm2/logs/${q(cfg.name)}-error.log 2>/dev/null`);
        if (logs.stdout.trim()) log(`\nLast errors from the new version:\n${logs.stdout}\n`);
        throw new Error('The new version did not start, so the previous version was put back. See the errors above.');
      },
    },
    {
      label: 'Cleaning up old releases',
      allowFail: true,
      fn: async (log) => {
        const n = Math.min(Math.max(Number(cfg.keepReleases) || 3, 1), 10);
        const r = await ssh.exec(
          serverId,
          `cd ${q(rel)} 2>/dev/null || exit 0
ls -1t | grep -E '^(before-)?[0-9]{8}-[0-9]{6}$' | tail -n +${n + 1} | while read d; do rm -rf -- "$d"; echo "removed $d"; done
find . -maxdepth 1 -name 'failed-*' -mtime +7 -exec rm -rf {} +
true`,
          { sudo: true },
        );
        log(r.stdout || `Keeping the last ${n} release(s).\n`);
      },
    },
  );

  const job = jobs.create(serverId, `Deploy ${cfg.name}${reason === 'push' ? ' (git push)' : ''}`, steps, {
    onDone: async (status, error) => {
      if (!ctx.swapped) await ssh.exec(serverId, `rm -rf ${q(stage)}`, { sudo: true }).catch(() => {});
      const pending = deploying.get(key)?.pending;
      deploying.delete(key);
      const team = require('./team');
      team.audit({ user: by, action: `Deploy of ${cfg.name} on ${server.name} ${status === 'success' ? 'succeeded' : 'failed'}${ctx.commit ? ` (commit ${ctx.commit.short})` : ''}${reason === 'push' ? ' after a git push' : ''}` });
      if (status !== 'success' && reason === 'push') {
        require('./backups').notifyOwner(`Deploy of ${cfg.name} failed`, `A git push to ${cfg.branch} started a deploy of ${cfg.name} on ${server.name}, and it failed.\n\n${error || ''}\n\n${ctx.swapped ? 'The previous version was put back.' : 'The running app was not changed.'} Open Node Apps → ${cfg.name} → Deploys to see the log.`, 'deploys');
      }
      // A push arrived during this deploy: deploy once more with the newest code.
      if (pending) setTimeout(() => {
        try {
          startDeploy(serverId, cfg, pending);
        } catch (err) {
          console.error(`Queued deploy of ${cfg.name}: ${err.message}`);
        }
      }, 1000).unref?.();
    },
  });
  deploying.set(key, { jobId: job.id, pending: null });
  return job;
}

// Releases kept for an app, newest first, plus the live one.
async function listReleases(serverId, name) {
  const r = await ssh.exec(
    serverId,
    `for d in ${q(appDir(name))} ${q(`${RELEASES}/${name}`)}/*/; do [ -d "$d" ] || continue; n=$(basename "$d"); echo "##$n|$(du -sb "$d" 2>/dev/null | cut -f1)"; cat "$d/${RELEASE_FILE}" 2>/dev/null; echo; done`,
    { sudo: true, timeout: 60000 },
  );
  const out = [];
  for (const chunk of r.stdout.split('##').slice(1)) {
    const nl = chunk.indexOf('\n');
    const [dirName, size] = chunk.slice(0, nl).split('|');
    let info = null;
    try {
      info = JSON.parse(chunk.slice(nl + 1).trim());
    } catch {
      /* deployed before releases existed */
    }
    const isLive = dirName === name;
    if (!isLive && !ID_RE.test(dirName) && !dirName.startsWith('failed-')) continue;
    out.push({ dir: isLive ? 'live' : dirName, live: isLive, failed: dirName.startsWith('failed-'), size: Number(size) || 0, ...(info || { id: dirName }) });
  }
  return out.sort((a, b) => (a.live ? -1 : b.live ? 1 : a.dir < b.dir ? 1 : -1));
}

// Put an earlier release back (the current one becomes a release in turn).
function startRollback(serverId, cfg, releaseDir, { by = 'serverboy' } = {}) {
  if (!ID_RE.test(String(releaseDir))) throw new HttpError(400, 'Choose a kept release');
  const key = `${serverId}:${cfg.name}`;
  if (deploying.has(key)) throw new HttpError(409, 'A deploy of this app is running. Wait for it to finish.');
  const live = appDir(cfg.name);
  const rel = `${RELEASES}/${cfg.name}`;
  const keep = [...ALWAYS_KEEP, ...cleanKeep(cfg.keep || [])];
  const steps = [
    {
      label: `Switching back to ${releaseDir}`,
      fn: async (log) => {
        const cur = await readRelease(serverId, live);
        const curId = cur?.id && ID_RE.test(cur.id) ? cur.id : `before-${newId()}`;
        const r = await ssh.exec(
          serverId,
          `set -e
[ -d ${q(`${rel}/${releaseDir}`)} ] || { echo "Release ${releaseDir} is no longer kept"; exit 1; }
${moveKeptScript(live, `${rel}/${releaseDir}`, keep)}
rm -rf ${q(`${rel}/${curId}`)}
mv ${q(live)} ${q(`${rel}/${curId}`)}
mv ${q(`${rel}/${releaseDir}`)} ${q(live)}
echo "Live: ${releaseDir}; the version that was live is kept as ${curId}"`,
          { sudo: true },
        );
        log(r.stdout + r.stderr);
        if (r.code !== 0) throw new Error('Rollback failed');
      },
    },
    { label: 'Checking PM2', fn: async (log) => log(`${await pm2.ensureDaemon(serverId)}\n`) },
    {
      label: 'Restarting and checking',
      fn: async (log) => {
        const r = await ssh.exec(serverId, pm2Restart(cfg.name));
        log(r.stdout + r.stderr);
        if (!(await healthy(serverId, cfg, log))) throw new Error('The app did not come up after the rollback. Check its logs in Node Apps.');
        log('Running.\n');
      },
    },
  ];
  const server = store.getServer(serverId);
  const job = jobs.create(serverId, `Roll back ${cfg.name} to ${releaseDir}`, steps, {
    onDone: async (status) => {
      deploying.delete(key);
      require('./team').audit({ user: by, action: `Rolled back ${cfg.name} on ${server.name} to ${releaseDir}: ${status}` });
    },
  });
  deploying.set(key, { jobId: job.id, pending: null });
  return job;
}

// ---------------- deploy key (private repositories) ----------------

async function deployKey(serverId, name, { create = false } = {}) {
  const r = await ssh.exec(
    serverId,
    `K=${keyFile(name)}
${create ? `mkdir -p ~/.ssh && chmod 700 ~/.ssh
[ -f "$K" ] || ssh-keygen -q -t ed25519 -N '' -C "serverboy-deploy-${name}@$(hostname)" -f "$K"` : ''}
[ -f "$K.pub" ] && cat "$K.pub"; true`,
    { check: true },
  );
  return r.stdout.trim() || null;
}

// ---------------- webhooks ----------------

function hookFor(serverId, name) {
  const h = store.findDeployHook(serverId, name);
  if (!h) return null;
  // Show how each triggered deploy ended (while Serverboy still has the task in memory).
  const deliveries = (h.deliveries || []).map((d) => {
    const j = d.job && /^(deploying|queued)/.test(d.result) ? jobs.get(d.job) : null;
    if (!j || j.status === 'running') return d;
    return { ...d, result: j.status === 'success' ? (d.result.startsWith('queued') ? 'deployed (after waiting)' : 'deployed') : 'deploy failed' };
  });
  return { id: h.id, path: `/hooks/deploy/${h.id}`, secret: h.secret, createdAt: h.createdAt, deliveries };
}

function enableHook(serverId, name) {
  const existing = store.findDeployHook(serverId, name);
  if (existing) return hookFor(serverId, name);
  const id = crypto.randomBytes(16).toString('hex');
  store.setDeployHook(id, { serverId, app: name, secret: crypto.randomBytes(24).toString('base64url'), createdAt: new Date().toISOString(), deliveries: [] });
  return hookFor(serverId, name);
}

function disableHook(serverId, name) {
  const h = store.findDeployHook(serverId, name);
  if (h) store.setDeployHook(h.id, null);
}

function record(id, entry) {
  const h = store.getDeployHook(id);
  if (!h) return;
  store.setDeployHook(id, { deliveries: [{ at: new Date().toISOString(), ...entry }, ...(h.deliveries || [])].slice(0, 15) });
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Handle a webhook delivery. Returns { status, body } for the HTTP answer.
 * GitHub: X-Hub-Signature-256 = sha256=HMAC(secret, raw body); GitLab: X-Gitlab-Token = secret.
 */
async function handleHook(id, headers, raw, loadConfig) {
  if (!/^[a-f0-9]{32}$/.test(String(id))) return { status: 404, body: { error: 'Unknown hook' } };
  const hook = store.getDeployHook(id);
  if (!hook) return { status: 404, body: { error: 'Unknown hook' } };
  const sig = headers['x-hub-signature-256'];
  const gitlab = headers['x-gitlab-token'];
  let provider;
  if (sig) {
    const want = `sha256=${crypto.createHmac('sha256', hook.secret).update(raw).digest('hex')}`;
    if (!safeEqual(sig, want)) return { status: 401, body: { error: 'Bad signature' } };
    provider = 'github';
  } else if (gitlab) {
    if (!safeEqual(gitlab, hook.secret)) return { status: 401, body: { error: 'Bad token' } };
    provider = 'gitlab';
  } else return { status: 401, body: { error: 'Missing signature (set the secret in the webhook settings)' } };

  const event = headers['x-github-event'] || headers['x-gitlab-event'] || '';
  if (event === 'ping') {
    record(id, { provider, event: 'ping', result: 'ok' });
    return { status: 200, body: { ok: true, message: 'Serverboy received the test delivery' } };
  }
  let payload;
  try {
    let text = raw.toString('utf8');
    if (text.startsWith('payload=')) text = decodeURIComponent(text.slice(8).replace(/\+/g, ' '));
    payload = JSON.parse(text);
  } catch {
    return { status: 400, body: { error: 'Send the payload as JSON (content type application/json)' } };
  }
  const isPush = provider === 'github' ? event === 'push' : payload.object_kind === 'push';
  if (!isPush) {
    record(id, { provider, event: event || payload.object_kind, result: 'ignored (not a push)' });
    return { status: 202, body: { ignored: 'not a push event' } };
  }
  if (payload.deleted || /^0+$/.test(String(payload.after || ''))) {
    record(id, { provider, event: 'push', result: 'ignored (branch deleted)' });
    return { status: 202, body: { ignored: 'branch deleted' } };
  }
  let cfg;
  try {
    cfg = await loadConfig(hook.serverId, hook.app);
  } catch (err) {
    record(id, { provider, event: 'push', result: `error: ${err.message}` });
    return { status: 502, body: { error: `Could not read the app settings: ${err.message}` } };
  }
  const branch = String(payload.ref || '').replace(/^refs\/heads\//, '');
  const commit = String(payload.after || payload.checkout_sha || '').slice(0, 7);
  const message = (payload.head_commit?.message || payload.commits?.[payload.commits.length - 1]?.message || '').split('\n')[0].slice(0, 120);
  const pusher = payload.pusher?.name || payload.user_username || payload.user_name || provider;
  if (branch !== cfg.branch) {
    record(id, { provider, event: 'push', branch, commit, result: `ignored (app deploys ${cfg.branch})` });
    return { status: 202, body: { ignored: `push to ${branch}; this app deploys ${cfg.branch}` } };
  }
  const job = startDeploy(hook.serverId, cfg, { by: `${pusher} (git push)`, reason: 'push', note: message });
  record(id, { provider, event: 'push', branch, commit, message, pusher, result: job.queued ? 'queued after the running deploy' : 'deploying', job: job.queued ? job.job : job.id });
  return { status: 202, body: { deploying: !job.queued, queued: Boolean(job.queued), job: job.queued ? job.job : job.id } };
}

module.exports = { startDeploy, startRollback, listReleases, deployKey, hookFor, enableHook, disableHook, handleHook, cleanKeep, isDeploying: (serverId, name) => deploying.has(`${serverId}:${name}`) };
