import { api, esc, toast, confirmDialog, showJob, onAction, loadingHtml, errorHtml } from '../ui.js';

const STACKS = [
  { name: 'Node.js SaaS (MongoDB)', apps: ['git', 'nginx', 'nodejs', 'pm2', 'mongodb', 'certbot', 'ufw', 'fail2ban'] },
  { name: 'PHP website (MariaDB)', apps: ['git', 'nginx', 'php', 'mariadb', 'certbot', 'ufw', 'fail2ban'] },
];

export async function render(el, { server }) {
  const base = `/servers/${server.id}`;
  let apps = [];

  el.innerHTML = `
    <div class="page-head">
      <div><h1>App Store</h1><div class="sub">One-click installs for Ubuntu / Debian. Installs run in the background, with a live log.</div></div>
      <button data-action="refresh">↻ Refresh</button>
    </div>
    <div class="card" style="margin-bottom:16px">
      <h2>Quick stacks</h2>
      <div class="row" id="stacks"></div>
    </div>
    <div id="catalog">${loadingHtml('Checking what is installed…')}</div>
    <div class="card" style="margin-top:20px">
      <h2>Any other package</h2>
      <form class="row" id="pkg-form"><input name="q" placeholder="Search apt packages, e.g. ffmpeg, imagemagick, python3-pip" class="grow" style="width:auto"><button>Search</button></form>
      <div id="pkg-results" style="margin-top:12px"></div>
    </div>`;

  const catalogEl = el.querySelector('#catalog');

  async function load() {
    catalogEl.innerHTML = loadingHtml('Checking what is installed…');
    try {
      apps = await api(`${base}/apps`);
      draw();
    } catch (err) {
      catalogEl.innerHTML = errorHtml(err);
    }
  }

  function draw() {
    el.querySelector('#stacks').innerHTML = STACKS.map((s, i) => {
      const missing = s.apps.filter((id) => !apps.find((a) => a.id === id)?.installed);
      return `<button data-action="stack" data-i="${i}" ${missing.length ? '' : 'disabled'}>${esc(s.name)} ${missing.length ? `<span class="badge accent">${missing.length} to install</span>` : '<span class="badge ok">ready</span>'}</button>`;
    }).join('');
    const categories = [...new Set(apps.map((a) => a.category))];
    catalogEl.innerHTML = categories
      .map(
        (cat) => `
      <h2 style="margin-top:8px">${esc(cat)}</h2>
      <div class="grid grid-3" style="margin-bottom:20px">
        ${apps
          .filter((a) => a.category === cat)
          .map(
            (a) => `
          <div class="card app-card">
            <div class="top"><h3 style="margin:0">${esc(a.name)}</h3>${a.installed ? '<span class="badge ok">installed</span>' : '<span class="badge">not installed</span>'}</div>
            <div class="desc">${esc(a.description)}</div>
            ${a.version ? `<div class="mono small muted">${esc(a.version)}</div>` : ''}
            <div class="row">
              ${a.installed
                ? `${a.service ? `<a class="btn btn-sm" href="#/s/${server.id}/services">Manage service</a>` : ''}
                   <button class="btn-sm" data-action="install" data-id="${a.id}">Reinstall / update</button>
                   ${a.canUninstall ? `<button class="btn-sm btn-danger" data-action="uninstall" data-id="${a.id}">Uninstall</button>` : ''}`
                : `<button class="btn-primary btn-sm" data-action="install" data-id="${a.id}">Install</button>`}
            </div>
          </div>`,
          )
          .join('')}
      </div>`,
      )
      .join('');
  }

  async function startJob(path, title) {
    try {
      const job = await api(path, { method: 'POST' });
      showJob(server.id, job, { onDone: load });
    } catch (err) {
      toast(`${title}: ${err.message}`, 'error');
    }
  }

  el.querySelector('#pkg-form').addEventListener('submit', async (e) => {
    const term = e.target.q.value.trim();
    const out = el.querySelector('#pkg-results');
    out.innerHTML = loadingHtml();
    try {
      const pkgs = await api(`${base}/packages/search?q=${encodeURIComponent(term)}`);
      out.innerHTML = pkgs.length
        ? `<div class="table-wrap" style="max-height:400px"><table><tbody>${pkgs
            .map(
              (p) => `<tr><td class="mono">${esc(p.name)}</td><td class="small muted">${esc(p.description)}</td><td class="actions">${
                p.installed
                  ? `<span class="badge ok">installed</span> <button class="btn-sm btn-danger" data-action="pkg" data-op="remove" data-name="${esc(p.name)}">Remove</button>`
                  : `<button class="btn-sm" data-action="pkg" data-op="install" data-name="${esc(p.name)}">Install</button>`
              }</td></tr>`,
            )
            .join('')}</tbody></table></div>`
        : '<div class="empty">No packages found</div>';
    } catch (err) {
      out.innerHTML = errorHtml(err);
    }
  });

  onAction(el, {
    refresh: load,
    install: ({ id }) => {
      const a = apps.find((x) => x.id === id);
      startJob(`${base}/apps/${id}/install`, a.name);
    },
    uninstall: async ({ id }) => {
      const a = apps.find((x) => x.id === id);
      if (!(await confirmDialog(`Uninstall ${a.name}? Data directories (like databases) are usually kept, but the service will stop.`, { danger: true, confirmLabel: 'Uninstall' }))) return;
      startJob(`${base}/apps/${id}/uninstall`, a.name);
    },
    stack: async ({ i }) => {
      const stack = STACKS[i];
      const missing = stack.apps.filter((id) => !apps.find((a) => a.id === id)?.installed);
      const names = missing.map((id) => apps.find((a) => a.id === id).name);
      if (!(await confirmDialog(`Install ${names.join(', ')}?\n\nThey will be installed one after another.`, { confirmLabel: 'Install all' }))) return;
      // Install sequentially: apt can only run one install at a time.
      for (const id of missing) {
        const job = await api(`${base}/apps/${id}/install`, { method: 'POST' }).catch((e) => toast(e.message, 'error'));
        if (!job) return;
        const result = await new Promise((resolve) => {
          const m = showJob(server.id, job, {
            onDone: (j) => {
              if (j.status === 'success') setTimeout(m.close, 800);
              resolve(j);
            },
          });
        });
        if (result.status !== 'success') return load();
      }
      load();
    },
    pkg: async ({ op, name }) => {
      if (op === 'remove' && !(await confirmDialog(`Remove package ${name}?`, { danger: true, confirmLabel: 'Remove' }))) return;
      try {
        const job = await api(`${base}/packages/${op}`, { method: 'POST', body: { name } });
        showJob(server.id, job);
      } catch (err) {
        toast(err.message, 'error');
      }
    },
  });

  load();
}
