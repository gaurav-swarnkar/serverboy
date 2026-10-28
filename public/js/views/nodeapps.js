import { api, esc, toast, run, modal, confirmDialog, formDialog, showJob, fmtBytes, fmtDuration, onAction, loadingHtml, errorHtml } from '../ui.js';

const DEPLOY_FIELDS = [
  { name: 'name', label: 'App name', placeholder: 'my-saas', required: true, help: 'Files go to /var/www/&lt;name&gt;. Letters, numbers, - and _.' },
  {
    name: 'repo',
    label: 'Git repository URL',
    placeholder: 'https://github.com/you/my-saas.git',
    help: 'Private GitHub repo? Use https://&lt;token&gt;@github.com/you/repo.git with a fine-grained read-only token. Leave empty to deploy files you uploaded with the File Manager.',
  },
  { name: 'branch', label: 'Branch', value: 'main' },
  { name: 'port', label: 'Port the app listens on', type: 'number', placeholder: '3000', help: 'Passed to the app as the PORT environment variable.' },
  { name: 'buildCmd', label: 'Build command (optional)', placeholder: 'npm run build' },
  { name: 'startCmd', label: 'Start command', value: 'npm start' },
  { name: 'installCmd', label: 'Install command (optional)', placeholder: 'auto: npm ci / yarn / pnpm' },
  {
    name: 'env',
    label: 'Environment variables (.env)',
    type: 'textarea',
    rows: 6,
    placeholder: 'MONGODB_URI=mongodb://user:pass@127.0.0.1:27017/mydb?authSource=mydb\nJWT_SECRET=change-me',
    help: 'One KEY=value per line. Saved to /var/www/&lt;name&gt;/.env and loaded into the app.',
  },
  { name: 'domain', label: 'Domain (optional)', placeholder: 'app.example.com', help: 'Creates an Nginx site that forwards the domain to the app port.' },
  { name: 'www', label: 'Also serve www.<domain>', type: 'checkbox' },
];

export async function render(el, { server }) {
  const base = `/servers/${server.id}`;
  let apps = [];

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Node Apps</h1><div class="sub">Deploy Node.js apps from Git, keep them running with PM2, and publish them on a domain.</div></div>
      <div class="row"><button data-action="refresh">↻</button><button class="btn-primary" data-action="deploy">+ Deploy app</button></div>
    </div>
    <div class="card flush"><div id="list">${loadingHtml()}</div></div>
    <div class="card" style="margin-top:16px">
      <h3>Deploying a SaaS with MongoDB, step by step</h3>
      <ol class="muted" style="margin:0;padding-left:18px">
        <li>App Store → install the <b>Node.js SaaS (MongoDB)</b> quick stack.</li>
        <li>Databases → MongoDB → <b>Secure MongoDB</b>, then create a database user for your app and copy its connection string.</li>
        <li>Here → <b>Deploy app</b> with your repo, port, and <span class="mono">MONGODB_URI=…</span> in the environment variables, plus your domain.</li>
        <li>Websites → <b>Enable SSL</b> on the domain. Push new code and click <b>Redeploy</b>.</li>
      </ol>
    </div>`;

  const list = el.querySelector('#list');

  async function load() {
    try {
      const r = await api(`${base}/node-apps`);
      if (!r.installed) {
        list.innerHTML = `<div class="empty">PM2 is not installed yet. <a href="#/s/${server.id}/apps">Install Node.js and PM2 from the App Store</a>.</div>`;
        return;
      }
      apps = r.apps;
      list.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>App</th><th>Status</th><th>CPU</th><th>Memory</th><th>Uptime</th><th>Restarts</th><th></th></tr></thead>
        <tbody>${apps
          .map((a, i) => {
            const cls = a.status === 'online' ? 'ok' : a.status === 'errored' ? 'bad' : 'warn';
            return `<tr>
              <td><b>${esc(a.name)}</b><div class="small muted mono">${esc(a.config?.repo || a.cwd || '')}${a.config?.port ? ` · port ${a.config.port}` : ''}${a.config?.domain ? ` · <a href="http://${esc(a.config.domain)}" target="_blank" rel="noopener">${esc(a.config.domain)}</a>` : ''}</div></td>
              <td><span class="badge ${cls}">${esc(a.status)}</span></td>
              <td>${a.cpu}%</td>
              <td>${fmtBytes(a.memory)}</td>
              <td>${a.status === 'online' && a.uptime ? fmtDuration((Date.now() - a.uptime) / 1000) : '–'}</td>
              <td>${a.restarts}</td>
              <td class="actions">
                ${a.config ? `<button class="btn-sm btn-primary" data-action="redeploy" data-i="${i}">Redeploy</button><button class="btn-sm" data-action="env" data-i="${i}">Env</button>` : ''}
                <button class="btn-sm" data-action="logs" data-i="${i}">Logs</button>
                ${a.status === 'online'
                  ? `<button class="btn-sm" data-action="op" data-op="restart" data-i="${i}">Restart</button><button class="btn-sm" data-action="op" data-op="stop" data-i="${i}">Stop</button>`
                  : `<button class="btn-sm" data-action="op" data-op="${a.config ? 'start' : 'restart'}" data-i="${i}">Start</button>`}
                <button class="btn-sm btn-danger" data-action="remove" data-i="${i}">Delete</button>
              </td></tr>`;
          })
          .join('')}
        ${apps.length ? '' : '<tr><td colspan="7" class="empty">No apps running yet. Click "Deploy app".</td></tr>'}
        </tbody></table></div>`;
    } catch (err) {
      list.innerHTML = errorHtml(err);
    }
  }

  onAction(el, {
    refresh: load,
    deploy: async () => {
      const job = await formDialog({
        title: 'Deploy a Node.js app',
        wide: true,
        fields: DEPLOY_FIELDS,
        submitLabel: 'Deploy',
        submit: (v) => api(`${base}/node-apps`, { method: 'POST', body: v }),
      });
      if (job?.id) showJob(server.id, job, { onDone: load });
    },
    redeploy: async ({ i }) => {
      const a = apps[i];
      if (!(await confirmDialog(`Pull the latest code for ${a.name}, reinstall, rebuild and restart it?`, { confirmLabel: 'Redeploy' }))) return;
      try {
        showJob(server.id, await api(`${base}/node-apps/${a.name}/redeploy`, { method: 'POST' }), { onDone: load });
      } catch (err) {
        toast(err.message, 'error');
      }
    },
    env: async ({ i }) => {
      const a = apps[i];
      let env;
      try {
        env = (await api(`${base}/node-apps/${a.name}/env`)).env;
      } catch (err) {
        return toast(err.message, 'error');
      }
      const job = await formDialog({
        title: `Environment variables: ${a.name}`,
        wide: true,
        fields: [{ name: 'env', label: '.env', type: 'textarea', rows: 14, value: env }],
        submitLabel: 'Save & restart',
        submit: (v) => api(`${base}/node-apps/${a.name}/env`, { method: 'PUT', body: v }),
      });
      if (job?.id) showJob(server.id, job, { onDone: load });
    },
    logs: async ({ i }) => {
      const a = apps[i];
      const m = modal({ title: `Logs: ${a.name}`, wide: true, body: loadingHtml() });
      try {
        const r = await api(`${base}/node-apps/${a.name}/logs?lines=300`);
        m.body.innerHTML = `<pre class="log">${esc(r.log || '(no output yet)')}</pre>`;
        const pre = m.body.querySelector('pre');
        pre.scrollTop = pre.scrollHeight;
      } catch (err) {
        m.body.innerHTML = errorHtml(err);
      }
    },
    op: async ({ i, op }, btn) => {
      const a = apps[i];
      await run(btn, () => api(`${base}/node-apps/${a.name}/${op}`, { method: 'POST', body: {} }), `${a.name}: ${op} done`);
      load();
    },
    remove: async ({ i }) => {
      const a = apps[i];
      const v = await formDialog({
        title: `Delete ${a.name}?`,
        intro: 'The app is stopped and removed from PM2. Any website pointing to it stays (delete it under Websites).',
        fields: [{ name: 'deleteFiles', label: `Also delete the app folder /var/www/${a.name}`, type: 'checkbox' }],
        submitLabel: 'Delete app',
      });
      if (!v) return;
      await run(null, () => api(`${base}/node-apps/${a.name}/delete`, { method: 'POST', body: v }), 'App deleted');
      load();
    },
  });

  load();
}
