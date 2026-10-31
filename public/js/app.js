import { api, esc, toast, loadingHtml, errorHtml, session, can } from './ui.js';
import { startUpdateWatch } from './updates.js';

// Two areas:
//   Portal  (#/servers, #/account, #/admin/...) - pick a server, your account, administration
//   Server  (#/s/<id>/<tool>)                  - tools for one server
// The top bar (logo, server switcher, account menu) is the same everywhere; the sidebar shows
// only what belongs to the area you are in.

const views = {
  servers: () => import('./views/servers.js'),
  account: () => import('./views/account.js'),
  'admin-users': () => import('./views/admin-users.js'),
  'admin-roles': () => import('./views/admin-roles.js'),
  'admin-activity': () => import('./views/admin-activity.js'),
  'admin-settings': () => import('./views/admin-settings.js'),
  dashboard: () => import('./views/dashboard.js'),
  terminal: () => import('./views/terminal.js'),
  files: () => import('./views/files.js'),
  services: () => import('./views/services.js'),
  apps: () => import('./views/apps.js'),
  databases: () => import('./views/databases.js'),
  apis: () => import('./views/apis.js'),
  sites: () => import('./views/sites.js'),
  nodeapps: () => import('./views/nodeapps.js'),
  firewall: () => import('./views/firewall.js'),
  jobs: () => import('./views/jobs.js'),
};

// Permission each page needs (null = anyone logged in). The server enforces the same rules.
const VIEW_PERMISSION = {
  servers: null,
  account: null,
  'admin-users': 'owner',
  'admin-roles': 'owner',
  'admin-activity': 'owner',
  'admin-settings': 'owner',
  dashboard: null,
  terminal: 'terminal',
  files: 'files',
  apps: 'system',
  services: 'services',
  sites: 'sites',
  nodeapps: 'nodeapps',
  databases: 'databases',
  apis: 'databases',
  firewall: 'system',
  jobs: null,
};

const SERVER_NAV = [
  ['Overview', [['dashboard', '◉', 'Dashboard'], ['terminal', '›_', 'Terminal'], ['files', '▤', 'File Manager']]],
  ['Software', [['apps', '⬇', 'App Store'], ['services', '⚙', 'Services']]],
  ['Hosting', [['sites', '◎', 'Websites'], ['nodeapps', '⬢', 'Node Apps'], ['databases', '⛁', 'Databases'], ['apis', '⇄', 'APIs']]],
  ['Security', [['firewall', '⛨', 'Firewall'], ['jobs', '☰', 'Tasks']]],
];

const PORTAL_NAV = [
  ['', [['servers', '▣', 'All servers', '#/servers']]],
  [
    'Administration',
    [
      ['admin-users', '☺', 'Users', '#/admin/users'],
      ['admin-roles', '⚿', 'Roles & permissions', '#/admin/roles'],
      ['admin-activity', '☰', 'Activity log', '#/admin/activity'],
      ['admin-settings', '⚙', 'Settings', '#/admin/settings'],
    ],
  ],
  ['Account', [['account', '✎', 'My account', '#/account']]],
];

const TITLES = {
  servers: 'Servers',
  account: 'My account',
  'admin-users': 'Administration',
  'admin-roles': 'Administration',
  'admin-activity': 'Administration',
  'admin-settings': 'Administration',
};

const state = { servers: [], cleanup: null };
const app = document.getElementById('app');

document.addEventListener('submit', (e) => e.preventDefault());
window.addEventListener('sb:logout', () => showLogin());
window.addEventListener('hashchange', route);
// Close the account menu when clicking anywhere else.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.usermenu')) document.querySelector('.usermenu .menu')?.classList.add('hidden');
});

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 's' && parts[1]) return { serverId: parts[1], view: parts[2] || 'dashboard', rest: parts.slice(3) };
  if (parts[0] === 'admin') return { serverId: null, view: `admin-${parts[1] || 'users'}`, rest: parts.slice(2) };
  // Old links from earlier versions.
  if (parts[0] === 'settings') return { redirect: '#/account' };
  if (parts[0] === 'team') return { redirect: '#/admin/users' };
  return { serverId: null, view: parts[0] || 'servers', rest: parts.slice(1) };
}

export function navigate(hash) {
  location.hash = hash;
}

export async function refreshServers() {
  state.servers = await api('/servers');
  return state.servers;
}

function lastLogin() {
  try {
    return localStorage.getItem('sb-last-login') || 'admin';
  } catch {
    return 'admin';
  }
}

function showLogin() {
  session.user = null;
  state.cleanup?.();
  state.cleanup = null;
  app.innerHTML = `
    <div class="login-wrap">
      <form class="card login">
        <div class="brand"><span class="brand-logo">▣</span> Serverboy</div>
        <label class="field"><span>Username or email</span><input name="username" value="${esc(lastLogin())}" placeholder="admin" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" autofocus required></label>
        <button class="btn-primary" style="width:100%;justify-content:center">Log in</button>
        <p class="muted small" style="margin-bottom:0">Owner: log in as <b>admin</b>. Team members: your username or email.</p>
      </form>
    </div>`;
  const form = app.querySelector('form');
  form.addEventListener('submit', async () => {
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api('/login', { method: 'POST', body: { username: form.username.value, password: form.password.value } });
      try {
        localStorage.setItem('sb-last-login', form.username.value.trim());
      } catch {
        /* private mode */
      }
      await start();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
}

function navLinks(sections, current, hrefFor) {
  return sections
    .map(([title, items]) => {
      const visible = items.filter(([view]) => can(VIEW_PERMISSION[view]));
      if (!visible.length) return '';
      return `${title ? `<div class="nav-section">${title}</div>` : ''}${visible
        .map(([view, ico, label, href]) => `<a href="${href || hrefFor(view)}" class="${current.view === view ? 'active' : ''}"><span class="ico">${ico}</span>${label}</a>`)
        .join('')}`;
    })
    .join('');
}

function renderShell(current) {
  const server = state.servers.find((s) => s.id === current.serverId);
  const user = session.user;
  const initials = (user.isOwner ? user.username : user.name || user.username).split(/\s+/).map((w) => w[0]).join('').slice(0, 2);

  const crumb = server
    ? `<span class="sep">/</span>
       <select id="server-select" aria-label="Switch server">
         ${state.servers.map((s) => `<option value="${s.id}" ${s.id === server.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
         <option value="">All servers…</option>
       </select>`
    : `<span class="sep">/</span><span class="crumb-title">${esc(TITLES[current.view] || '')}</span>`;

  const sidebar = server
    ? `<div class="side-head">
         <a class="back" href="#/servers">← All servers</a>
         <div class="side-title">${esc(server.name)}</div>
         <div class="side-sub">${esc(server.username)}@${esc(server.host)}</div>
       </div>
       <nav class="nav">${navLinks(SERVER_NAV, current, (v) => `#/s/${server.id}/${v}`)}</nav>`
    : `<nav class="nav">${navLinks(PORTAL_NAV, current, (v) => `#/${v}`)}</nav>`;

  app.innerHTML = `
    <div class="layout">
      <header class="topbar">
        <button id="menu-toggle" class="btn-ghost" aria-label="Menu">☰</button>
        <a class="brand" href="#/servers"><span class="brand-logo">▣</span><span class="brand-name">Serverboy</span></a>
        <div class="crumb">${crumb}</div>
        <span class="grow"></span>
        <div class="usermenu">
          <button id="user-btn" class="row" aria-haspopup="true">
            <span class="avatar">${esc(initials)}</span>
            <span class="who"><span>${esc(user.username)}</span><small>${esc(user.role)}</small></span>
            <span>▾</span>
          </button>
          <div class="menu hidden">
            <div class="menu-head">Signed in as <b>${esc(user.username)}</b> · ${esc(user.role)}</div>
            <a href="#/account">✎ My account</a>
            ${user.isOwner ? '<a href="#/admin/users">☺ Administration</a>' : ''}
            <a href="#/servers">▣ All servers</a>
            <hr>
            <a href="#" id="logout">⏻ Log out</a>
          </div>
        </div>
      </header>
      <aside class="sidebar">${sidebar}</aside>
      <main class="main" id="view"></main>
    </div>`;

  // On phones the sidebar is a slide-down menu; close it whenever a link is chosen.
  const layout = app.querySelector('.layout');
  app.querySelector('#menu-toggle').addEventListener('click', () => layout.classList.toggle('menu-open'));
  app.querySelector('.sidebar').addEventListener('click', (e) => {
    if (e.target.closest('a')) layout.classList.remove('menu-open');
  });
  const menu = app.querySelector('.usermenu .menu');
  app.querySelector('#user-btn').addEventListener('click', () => menu.classList.toggle('hidden'));
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) menu.classList.add('hidden');
  });
  app.querySelector('#server-select')?.addEventListener('change', (e) => {
    const id = e.target.value;
    if (!id) return navigate('#/servers');
    // Stay on the same tool when switching servers.
    navigate(`#/s/${id}/${current.view}`);
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
  if (current.redirect) return navigate(current.redirect);
  if (current.serverId && !state.servers.find((s) => s.id === current.serverId)) {
    await refreshServers().catch(() => {});
    if (!state.servers.find((s) => s.id === current.serverId)) return navigate('#/servers');
  }
  const isServerTool = SERVER_NAV.some(([, items]) => items.some(([v]) => v === current.view));
  if (!views[current.view] || Boolean(current.serverId) !== isServerTool) {
    return navigate(current.serverId ? `#/s/${current.serverId}/dashboard` : '#/servers');
  }
  if (!can(VIEW_PERMISSION[current.view])) {
    toast("You don't have access to that page.", 'error');
    return navigate(current.serverId ? `#/s/${current.serverId}/dashboard` : '#/servers');
  }

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
  session.user = me.user;
  startUpdateWatch();
  await refreshServers();
  if (!location.hash || location.hash === '#/' || location.hash === '#') {
    // One server: go straight to it. Several: let the user pick.
    if (state.servers.length === 1) return navigate(`#/s/${state.servers[0].id}/dashboard`);
    return navigate('#/servers');
  }
  route();
}

start().catch((err) => {
  app.innerHTML = errorHtml(err);
});
