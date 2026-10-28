import { api, esc, toast, loadingHtml, errorHtml } from './ui.js';

const views = {
  servers: () => import('./views/servers.js'),
  dashboard: () => import('./views/dashboard.js'),
  terminal: () => import('./views/terminal.js'),
  files: () => import('./views/files.js'),
  services: () => import('./views/services.js'),
  apps: () => import('./views/apps.js'),
  databases: () => import('./views/databases.js'),
  sites: () => import('./views/sites.js'),
  nodeapps: () => import('./views/nodeapps.js'),
  firewall: () => import('./views/firewall.js'),
  jobs: () => import('./views/jobs.js'),
  settings: () => import('./views/settings.js'),
};

const NAV = [
  ['Overview', [['dashboard', '◉', 'Dashboard'], ['terminal', '›_', 'Terminal'], ['files', '▤', 'File Manager']]],
  ['Software', [['apps', '⬇', 'App Store'], ['services', '⚙', 'Services']]],
  ['Hosting', [['sites', '◎', 'Websites'], ['nodeapps', '⬢', 'Node Apps'], ['databases', '⛁', 'Databases']]],
  ['Security', [['firewall', '⛨', 'Firewall'], ['jobs', '☰', 'Tasks']]],
];

const state = { servers: [], cleanup: null };
const app = document.getElementById('app');

document.addEventListener('submit', (e) => e.preventDefault());
window.addEventListener('sb:logout', () => showLogin());
window.addEventListener('hashchange', route);

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 's' && parts[1]) return { serverId: parts[1], view: parts[2] || 'dashboard', rest: parts.slice(3) };
  return { serverId: null, view: parts[0] || 'servers', rest: parts.slice(1) };
}

export function navigate(hash) {
  location.hash = hash;
}

export async function refreshServers() {
  state.servers = await api('/servers');
  return state.servers;
}

function showLogin() {
  state.cleanup?.();
  state.cleanup = null;
  app.innerHTML = `
    <div class="login-wrap">
      <form class="card login">
        <div class="brand"><span class="brand-logo">▣</span> Serverboy</div>
        <label class="field"><span>Admin password</span><input type="password" name="password" autofocus required></label>
        <button class="btn-primary" style="width:100%;justify-content:center">Log in</button>
        <p class="muted small" style="margin-bottom:0">The first-run password is printed in the terminal where you started Serverboy.</p>
      </form>
    </div>`;
  const form = app.querySelector('form');
  form.addEventListener('submit', async () => {
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api('/login', { method: 'POST', body: { password: form.password.value } });
      await start();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
}

function renderShell(current) {
  const server = state.servers.find((s) => s.id === current.serverId);
  const nav = NAV.map(
    ([section, items]) => `
      <div class="nav-section">${section}</div>
      ${items
        .map(([view, ico, label]) => `<a href="#/s/${server?.id}/${view}" class="${current.view === view ? 'active' : ''}"><span class="ico">${ico}</span>${label}</a>`)
        .join('')}`,
  ).join('');
  app.innerHTML = `
    <div class="layout">
      <header class="mobile-bar">
        <button id="menu-toggle" class="btn-ghost" aria-label="Menu">☰</button>
        <span class="brand-logo">▣</span>
        <span class="mobile-title">${esc(server ? server.name : 'Serverboy')}</span>
      </header>
      <aside class="sidebar">
        <div class="brand"><span class="brand-logo">▣</span> Serverboy</div>
        ${
          state.servers.length
            ? `<div class="server-picker"><select id="server-select">
                ${server ? '' : '<option value="" selected disabled>Select a server…</option>'}
                ${state.servers.map((s) => `<option value="${s.id}" ${s.id === server?.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
                <option value="">⚙ Manage servers…</option>
              </select></div>`
            : ''
        }
        <nav class="nav">
          ${server ? nav : ''}
          <div class="nav-section">Portal</div>
          <a href="#/servers" class="${current.view === 'servers' ? 'active' : ''}"><span class="ico">▣</span>Servers</a>
          <a href="#/settings" class="${current.view === 'settings' ? 'active' : ''}"><span class="ico">✎</span>Settings</a>
          <a href="#" id="logout"><span class="ico">⏻</span>Log out</a>
        </nav>
      </aside>
      <main class="main" id="view"></main>
    </div>`;
  // On phones the sidebar is a slide-down menu; close it whenever a link is chosen.
  const layout = app.querySelector('.layout');
  app.querySelector('#menu-toggle').addEventListener('click', () => layout.classList.toggle('menu-open'));
  app.querySelector('.nav').addEventListener('click', (e) => {
    if (e.target.closest('a')) layout.classList.remove('menu-open');
  });
  app.querySelector('#server-select')?.addEventListener('change', (e) => {
    const id = e.target.value;
    if (!id) return navigate('#/servers');
    const view = parseHash().view;
    navigate(`#/s/${id}/${views[view] && view !== 'servers' && view !== 'settings' ? view : 'dashboard'}`);
  });
  app.querySelector('#logout').addEventListener('click', async (e) => {
    e.preventDefault();
    await api('/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });
  return server;
}

async function route() {
  const current = parseHash();
  if (current.serverId && !state.servers.find((s) => s.id === current.serverId)) {
    await refreshServers().catch(() => {});
    if (!state.servers.find((s) => s.id === current.serverId)) return navigate('#/servers');
  }
  if (!views[current.view]) return navigate('#/servers');

  state.cleanup?.();
  state.cleanup = null;
  const server = renderShell(current);
  const container = document.getElementById('view');
  container.innerHTML = loadingHtml();
  try {
    const mod = await views[current.view]();
    const cleanup = await mod.render(container, { server, rest: current.rest, navigate, refreshServers, servers: state.servers });
    if (typeof cleanup === 'function') state.cleanup = cleanup;
  } catch (err) {
    container.innerHTML = errorHtml(err);
  }
}

async function start() {
  const me = await api('/me');
  if (!me.loggedIn) return showLogin();
  await refreshServers();
  if (!location.hash || location.hash === '#/' || location.hash === '#') {
    if (state.servers.length) return navigate(`#/s/${state.servers[0].id}/dashboard`);
    return navigate('#/servers');
  }
  route();
}

start().catch((err) => {
  app.innerHTML = errorHtml(err);
});
