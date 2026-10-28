// Node.js apps: deploy from git (or uploaded files), run under PM2, optionally publish on a domain.
// Each app lives in /var/www/<name>, owned by the SSH user. Its deploy settings are kept on the
// server in .serverboy-app.json so redeploys work from any Serverboy install.
const express = require('express');
const ssh = require('../lib/ssh');
const jobs = require('../lib/jobs');
const nginx = require('../lib/nginx');

const { q, HttpError } = ssh;
const router = express.Router({ mergeParams: true });

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i;
const APP_FILE = '.serverboy-app.json';
const PM2_FILE = '.serverboy-pm2.json';

function appName(name) {
  if (!NAME_RE.test(String(name || ''))) throw new HttpError(400, 'App name: letters, numbers, - and _ only');
  return String(name);
}

function appDir(name) {
  return `/var/www/${name}`;
}

function parseEnv(text) {
  const env = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

async function readRemote(serverId, file) {
  const r = await ssh.exec(serverId, `cat -- ${q(file)} 2>/dev/null`);
  return r.code === 0 ? r.stdout : null;
}

async function loadAppConfig(serverId, name) {
  const text = await readRemote(serverId, `${appDir(name)}/${APP_FILE}`);
  if (!text) throw new HttpError(404, `No Serverboy deploy settings found for ${name}`);
  return JSON.parse(text);
}

function validateConfig(body) {
  const cfg = {
    name: appName(body.name),
    repo: String(body.repo || '').trim(),
    branch: String(body.branch || 'main').trim(),
    port: body.port ? Number(body.port) : null,
    installCmd: String(body.installCmd || '').trim(),
    buildCmd: String(body.buildCmd || '').trim(),
    startCmd: String(body.startCmd || 'npm start').trim(),
    domain: body.domain ? nginx.validDomain(body.domain) : null,
  };
  if (cfg.repo && !/^(https:\/\/|git@|ssh:\/\/)[^\s'"]+$/.test(cfg.repo)) throw new HttpError(400, 'Repository must be an https:// or git@ URL');
  if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(cfg.branch)) throw new HttpError(400, 'Invalid branch name');
  if (cfg.port !== null && (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535)) throw new HttpError(400, 'Invalid port');
  if (cfg.domain && !cfg.port) throw new HttpError(400, 'A port is required to put the app on a domain');
  if (!cfg.startCmd) throw new HttpError(400, 'Start command is required');
  return cfg;
}

// Steps shared by deploy and redeploy: fetch code, install, build, (re)start under PM2.
function buildSteps(serverId, cfg, { envText, fresh }) {
  const dir = appDir(cfg.name);
  const steps = [];

  if (fresh) {
    steps.push({
      label: `Preparing ${dir}`,
      fn: async (log) => {
        const entry = await ssh.connect(serverId);
        const user = entry.server.username;
        await ssh.exec(serverId, `mkdir -p ${q(dir)} && chown ${q(user)}: ${q(dir)}`, { sudo: true, check: true });
        log(`Created ${dir} owned by ${user}\n`);
      },
    });
  }

  steps.push({
    label: 'Checking Node.js, npm and PM2',
    cmd: `command -v node >/dev/null || { echo "Node.js is not installed. Install it from the App Store."; exit 1; }
command -v pm2 >/dev/null || { echo "PM2 is not installed. Install it from the App Store."; exit 1; }
${cfg.repo ? 'command -v git >/dev/null || { echo "git is not installed. Install Git & build tools from the App Store."; exit 1; }' : ''}
echo "node $(node --version), npm $(npm --version), pm2 $(pm2 --version | tail -1)"`,
  });

  if (cfg.repo) {
    steps.push({
      label: `Fetching ${cfg.repo} (${cfg.branch})`,
      cmd: `set -e
export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes"
cd ${q(dir)}
if [ ! -d .git ]; then
  [ -z "$(ls -A | grep -v -e '^.serverboy' -e '^.env$')" ] || { echo "${dir} is not empty and is not a git checkout"; exit 1; }
  git init -q
  git remote add origin ${q(cfg.repo)}
fi
git remote set-url origin ${q(cfg.repo)}
git fetch origin ${q(cfg.branch)}
git checkout -q -f -B ${q(cfg.branch)} FETCH_HEAD
git log -1 --format='Deployed commit %h: %s (%an, %ar)'`,
    });
  } else {
    steps.push({
      label: 'No repository set: using files already in the app folder',
      cmd: `cd ${q(dir)} && [ -f package.json ] || { echo "No package.json in ${dir}. Upload your app with the File Manager first."; exit 1; }`,
    });
  }

  steps.push({
    label: 'Writing settings and environment variables',
    fn: async (log) => {
      let env = envText;
      if (env === undefined || env === null) env = (await readRemote(serverId, `${dir}/.env`)) || '';
      else await ssh.writeFile(serverId, `${dir}/.env`, env, { sudo: false });
      const vars = parseEnv(env);
      if (cfg.port && !vars.PORT) vars.PORT = String(cfg.port);
      if (!vars.NODE_ENV) vars.NODE_ENV = 'production';
      const pm2 = {
        apps: [
          {
            name: cfg.name,
            cwd: dir,
            script: 'bash',
            args: ['-c', `exec ${cfg.startCmd}`],
            interpreter: 'none',
            env: vars,
            autorestart: true,
            max_restarts: 20,
            time: true,
          },
        ],
      };
      await ssh.writeFile(serverId, `${dir}/${PM2_FILE}`, JSON.stringify(pm2, null, 2), { sudo: false });
      await ssh.writeFile(serverId, `${dir}/${APP_FILE}`, JSON.stringify(cfg, null, 2), { sudo: false });
      log(`Environment variables: ${Object.keys(vars).join(', ') || '(none)'}\n`);
    },
  });

  steps.push({
    label: 'Installing dependencies',
    cmd: `cd ${q(dir)} && ${cfg.installCmd || 'if [ -f package-lock.json ]; then npm ci --include=dev; elif [ -f yarn.lock ]; then npx --yes yarn install --frozen-lockfile; elif [ -f pnpm-lock.yaml ]; then npx --yes pnpm install --frozen-lockfile; else npm install --include=dev; fi'}`,
  });

  if (cfg.buildCmd) steps.push({ label: `Building: ${cfg.buildCmd}`, cmd: `cd ${q(dir)} && ${cfg.buildCmd}` });

  steps.push({
    label: 'Starting with PM2',
    cmd: `cd ${q(dir)} && pm2 delete ${q(cfg.name)} >/dev/null 2>&1; pm2 start ${PM2_FILE} && pm2 save
sleep 3; pm2 describe ${q(cfg.name)} | grep -E 'status|restarts' | head -3`,
  });

  if (fresh) {
    steps.push({
      label: 'Making PM2 start on boot',
      allowFail: true,
      fn: async (log) => {
        const entry = await ssh.connect(serverId);
        const user = entry.server.username;
        const r = await ssh.exec(
          serverId,
          `PM2=$(command -v pm2); HOME_DIR=$(getent passwd ${q(user)} | cut -d: -f6); env PATH="$PATH:/usr/bin:/usr/local/bin" "$PM2" startup systemd -u ${q(user)} --hp "$HOME_DIR" | tail -2`,
          { sudo: true },
        );
        log(r.stdout + r.stderr);
      },
    });
  }

  return steps;
}

router.get('/node-apps', async (req, res) => {
  const r = await ssh.exec(
    req.params.id,
    `command -v pm2 >/dev/null || { echo NO_PM2; exit 0; }
pm2 jlist 2>/dev/null | tail -1
echo "##configs"
for f in /var/www/*/${APP_FILE}; do [ -f "$f" ] && { cat "$f"; echo; echo "##sep"; }; done`,
  );
  if (r.stdout.includes('NO_PM2')) return res.json({ installed: false, apps: [] });
  const [jlist, configsRaw] = r.stdout.split('##configs');
  let processes = [];
  try {
    processes = JSON.parse(jlist.trim() || '[]');
  } catch {
    processes = [];
  }
  const configs = {};
  for (const chunk of (configsRaw || '').split('##sep')) {
    try {
      const c = JSON.parse(chunk.trim());
      configs[c.name] = c;
    } catch {
      /* skip */
    }
  }
  const apps = processes.map((p) => ({
    name: p.name,
    pmId: p.pm_id,
    status: p.pm2_env?.status,
    cpu: p.monit?.cpu ?? 0,
    memory: p.monit?.memory ?? 0,
    uptime: p.pm2_env?.pm_uptime || null,
    restarts: p.pm2_env?.restart_time ?? 0,
    cwd: p.pm2_env?.pm_cwd,
    config: configs[p.name] || null,
  }));
  // Apps that were deployed but are not in PM2 right now (e.g. deleted from PM2).
  for (const [name, config] of Object.entries(configs)) {
    if (!apps.find((a) => a.name === name)) apps.push({ name, status: 'not running', cpu: 0, memory: 0, restarts: 0, config });
  }
  res.json({ installed: true, apps });
});

router.post('/node-apps', (req, res) => {
  const cfg = validateConfig(req.body || {});
  const serverId = req.params.id;
  const steps = buildSteps(serverId, cfg, { envText: String(req.body?.env ?? ''), fresh: true });
  if (cfg.domain) {
    steps.push({
      label: `Publishing on http://${cfg.domain}`,
      fn: async (log) => {
        await nginx.createSite(serverId, { domain: cfg.domain, type: 'proxy', port: cfg.port, www: Boolean(req.body?.www) });
        log(`Nginx now forwards ${cfg.domain} to port ${cfg.port}. Use Websites > Enable SSL for https.\n`);
      },
    });
  }
  res.json(jobs.create(serverId, `Deploy ${cfg.name}`, steps));
});

router.post('/node-apps/:name/redeploy', async (req, res) => {
  const name = appName(req.params.name);
  const cfg = await loadAppConfig(req.params.id, name);
  res.json(jobs.create(req.params.id, `Redeploy ${name}`, buildSteps(req.params.id, cfg, { envText: null, fresh: false })));
});

router.get('/node-apps/:name/env', async (req, res) => {
  const name = appName(req.params.name);
  res.json({ env: (await readRemote(req.params.id, `${appDir(name)}/.env`)) || '' });
});

// Save environment variables and restart the app with them.
router.put('/node-apps/:name/env', async (req, res) => {
  const name = appName(req.params.name);
  const cfg = await loadAppConfig(req.params.id, name);
  const steps = buildSteps(req.params.id, cfg, { envText: String(req.body?.env ?? ''), fresh: false }).filter(
    (s) => s.label.startsWith('Writing') || s.label.startsWith('Starting'),
  );
  res.json(jobs.create(req.params.id, `Update env for ${name}`, steps));
});

router.post('/node-apps/:name/:action', async (req, res) => {
  const name = appName(req.params.name);
  const { action } = req.params;
  if (!['restart', 'stop', 'start', 'delete'].includes(action)) throw new HttpError(400, 'Invalid action');
  let cmd = `pm2 ${action} ${q(name)} && pm2 save`;
  if (action === 'start') cmd = `cd ${q(appDir(name))} && pm2 start ${PM2_FILE} && pm2 save`;
  if (action === 'delete') cmd = `pm2 delete ${q(name)} >/dev/null 2>&1; pm2 save`;
  await ssh.exec(req.params.id, cmd, { check: true });
  // /var/www itself is root-owned, so removing the app folder needs sudo.
  if (action === 'delete' && req.body?.deleteFiles) {
    await ssh.exec(req.params.id, `rm -rf -- ${q(appDir(name))}`, { sudo: true, check: true });
  }
  res.json({ ok: true });
});

router.get('/node-apps/:name/logs', async (req, res) => {
  const name = appName(req.params.name);
  const lines = Math.min(Number(req.query.lines) || 200, 2000);
  const r = await ssh.exec(req.params.id, `pm2 logs ${q(name)} --lines ${lines} --nostream --raw 2>&1`);
  res.json({ log: r.stdout });
});

module.exports = router;
