import { api, esc, toast, loadingHtml, errorHtml, session, can } from './ui.js';
import { startUpdateWatch, paintUnread } from './updates.js';
import { icon, logo } from './icons.js';
import { getTheme, setTheme, shownTheme } from './theme.js';

// Two areas:
//   Portal  (#/servers, #/account, #/admin/...) - pick a server, your account, administration
//   Server  (#/s/<id>/<tool>)                  - tools for one server
// The top bar (logo, server switcher, account menu) is the same everywhere; the sidebar shows
// only what belongs to the area you are in.

const views = {
  servers: () => import('./views/servers.js'),
  account: () => import('./views/account.js'),
  people: () => import('./views/people.js'),
  messages: () => import('./views/messages.js'),
  'admin-users': () => import('./views/admin-users.js'),
  'admin-roles': () => import('./views/admin-roles.js'),
  'admin-activity': () => import('./views/admin-activity.js'),
  'admin-settings': () => import('./views/admin-settings.js'),
  dashboard: () => import('./views/dashboard.js'),
  terminal: () => import('./views/terminal.js'),
  files: () => import('./views/files.js'),
  services: () => import('./views/services.js'),
  apps: () => import('./views/apps.js'),
  storage: () => import('./views/storage.js'),
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
  people: null,
  messages: null,
  'admin-users': 'owner',
  'admin-roles': 'owner',
  'admin-activity': 'owner',
  'admin-settings': 'owner',
  dashboard: null,
  terminal: 'terminal',
  files: 'files',
  apps: 'system',
  storage: 'system',
  services: 'services',
  sites: 'sites',
  nodeapps: 'nodeapps',
  databases: 'databases',
  apis: 'databases',
  firewall: 'system',
  jobs: null,
};

const SERVER_NAV = [
  ['Main menu', [['dashboard', 'home', 'Dashboard'], ['terminal', 'terminal', 'Terminal'], ['files', 'folder', 'File Manager']]],
  ['Hosting', [['sites', 'globe', 'Websites'], ['nodeapps', 'hexagon', 'Node Apps'], ['databases', 'database', 'Databases'], ['apis', 'plug', 'APIs']]],
  ['Software', [['apps', 'package', 'App Store'], ['services', 'sliders', 'Services'], ['storage', 'drive', 'Disk & cleanup']]],
  ['Security', [['firewall', 'shield', 'Firewall'], ['jobs', 'list', 'Tasks']]],
];

const PORTAL_NAV = [
  ['Main menu', [['servers', 'server', 'All servers', '#/servers'], ['people', 'users', 'Team', '#/people'], ['messages', 'mail', 'Messages', '#/messages']]],
  [
    'Administration',
    [
      ['admin-users', 'user', 'Users', '#/admin/users'],
      ['admin-roles', 'key', 'Roles & permissions', '#/admin/roles'],
      ['admin-activity', 'activity', 'Activity log', '#/admin/activity'],
      ['admin-settings', 'settings', 'Settings', '#/admin/settings'],
    ],
  ],
  ['Preference', [['account', 'user', 'My account', '#/account']]],
];

// Title and one-line tagline in the top bar.
const PAGE_INFO = {
  dashboard: ['Dashboard', 'Your server at a glance: health, resources and what needs attention.'],
  terminal: ['Terminal', 'Run commands on the server, with a command book that explains them.'],
  files: ['File Manager', 'Browse, upload and edit files, like an FTP client.'],
  apps: ['App Store', 'Install the software your projects need in one click.'],
  services: ['Services', 'Start, stop and check the programs running on your server.'],
  storage: ['Disk & cleanup', 'See what fills the disk and clean up safely.'],
  sites: ['Websites', 'Host domains, preview in test mode, go live with free HTTPS.'],
  nodeapps: ['Node Apps', 'Deploy and run Node.js apps with PM2.'],
  databases: ['Databases', 'Manage MongoDB and MariaDB, like phpMyAdmin.'],
  apis: ['APIs', 'Let websites and apps use your data, safely.'],
  firewall: ['Firewall', 'Choose which ports the internet can reach.'],
  jobs: ['Tasks', 'Live logs of installs and deployments.'],
  servers: ['Servers', 'All the servers you manage with Serverboy.'],
  people: ['Team', 'Everyone who works on these servers.'],
  messages: ['Messages', 'Talk to your team.'],
  account: ['My account', 'Your login and password.'],
  'admin-users': ['Administration', 'Users, roles, activity and settings.'],
  'admin-roles': ['Administration', 'Users, roles, activity and settings.'],
  'admin-activity': ['Administration', 'Users, roles, activity and settings.'],
  'admin-settings': ['Administration', 'Users, roles, activity and settings.'],
};

const state = { servers: [], cleanup: null };
const app = document.getElementById('app');

document.addEventListener('submit', (e) => e.preventDefault());
window.addEventListener('sb:logout', () => showLogin());
window.addEventListener('hashchange', route);
// Close the account menu when clicking anywhere else.
document.addEventListener('click', (e) => {
  for (const wrap of document.querySelectorAll('.usermenu, .side-switch')) {
    if (!wrap.contains(e.target)) wrap.querySelector('.menu')?.classList.add('hidden');
  }
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
        <div class="login-brand">${logo(44)}<div><div class="login-name">Serverboy</div><div class="small muted">Your server, made simple.</div></div></div>
        <h1 class="login-title">Welcome back</h1>
        <label class="field"><span>Username or email</span><input name="username" value="${esc(lastLogin())}" placeholder="admin" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" autofocus required></label>
        <button class="btn-primary btn-lg" style="width:100%;justify-content:center">Log in ${icon('arrow', 16)}</button>
        <p class="muted small" style="margin-bottom:0;text-align:center">Owner: log in as <b>admin</b>. Team members: your username or email.</p>
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
        .map(([view, ico, label, href]) => `<a href="${href || hrefFor(view)}" class="${current.view === view ? 'active' : ''}">${icon(ico)}<span>${label}</span></a>`)
        .join('')}`;
    })
    .join('');
}

function avatarOf(user, size = 36) {
  const initials = (user.isOwner ? user.username : user.name || user.username).split(/\s+/).map((w) => w[0]).join('').slice(0, 2);
  return `<span class="avatar" style="width:${size}px;height:${size}px;${user.color ? `background:${esc(user.color)}` : ''}">${user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : esc(initials)}</span>`;
}

function renderShell(current) {
  const server = state.servers.find((s) => s.id === current.serverId);
  const user = session.user;
  const [title, tagline] = PAGE_INFO[current.view] || ['Serverboy', ''];

  // The card under the logo: the server you work on (switch here), or you.
  const switcher = server
    ? `<div class="side-switch">
        <button class="side-card" id="server-switch" aria-haspopup="true">
          <span class="side-chip">${icon('server', 18)}</span>
          <span class="side-card-text"><b>${esc(server.name)}</b><small class="mono">${esc(server.username)}@${esc(server.host)}</small></span>
          ${icon('chevron', 16, 'side-chev')}
        </button>
        <div class="menu side-menu hidden" id="server-menu">
          <div class="menu-head">Switch server</div>
          ${state.servers.map((s) => `<a href="#/s/${s.id}/${current.view}" class="${s.id === server.id ? 'on' : ''}">${icon('server', 16)} ${esc(s.name)}</a>`).join('')}
          <hr><a href="#/servers">${icon('grid', 16)} All servers</a>
        </div>
      </div>`
    : `<a class="side-card" href="#/people/me">${avatarOf(user, 34)}<span class="side-card-text"><b>${esc(user.name || user.username)}</b><small>${esc(user.role)}</small></span></a>`;

  // A helpful card at the bottom of the sidebar.
  const helper = server && can('terminal')
    ? `<div class="side-help">${icon('book', 26)}<b>New to servers?</b><p>The command book explains 140 everyday commands in plain English.</p><a class="btn btn-primary" href="#/s/${server.id}/terminal">Open command book ${icon('arrow', 14)}</a></div>`
    : user.isOwner && !server
      ? `<div class="side-help">${icon('users', 26)}<b>Work as a team</b><p>Give developers their own login, with only the access they need.</p><a class="btn btn-primary" href="#/admin/users">Invite your team ${icon('arrow', 14)}</a></div>`
      : `<div class="side-help">${icon('mail', 26)}<b>Questions?</b><p>Write to the owner any time.</p><a class="btn btn-primary" href="#/messages/new">Send a message ${icon('arrow', 14)}</a></div>`;

  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <a class="brand" href="#/servers">${logo(30)}<span class="brand-name">Serverboy</span></a>
        ${switcher}
        <nav class="nav">${server ? navLinks(SERVER_NAV, current, (v) => `#/s/${server.id}/${v}`) : navLinks(PORTAL_NAV, current, (v) => `#/${v}`)}</nav>
        <div class="grow"></div>
        ${helper}
      </aside>
      <header class="topbar">
        <button id="menu-toggle" class="icon-btn" aria-label="Menu">${icon('menu', 20)}</button>
        <div class="top-title"><b id="top-title">${esc(title)}</b><span id="top-tagline">${esc(tagline)}</span></div>
        <div class="top-search">
          ${icon('search', 17)}<input id="top-search" placeholder="Search anything" autocomplete="off" aria-label="Search pages and servers"><kbd>⌘</kbd><kbd>K</kbd>
          <div class="menu search-menu hidden" id="search-menu"></div>
        </div>
        <div class="usermenu theme-menu">
          <button class="icon-btn" id="theme-btn" title="Theme" aria-haspopup="true">${icon(shownTheme() === 'dark' ? 'moon' : 'sun', 20)}</button>
          <div class="menu hidden" id="theme-list">
            <div class="menu-head">Theme</div>
            ${[['light', 'sun', 'Light'], ['dark', 'moon', 'Dark'], ['auto', 'monitor', 'Auto (like this computer)']].map(([t, i, l]) => `<a href="#" data-theme-pick="${t}" class="${getTheme() === t ? 'on' : ''}">${icon(i, 16)} ${l}</a>`).join('')}
          </div>
        </div>
        <a class="icon-btn" href="${user.isOwner ? '#/admin/settings' : '#/account'}" title="Settings">${icon('settings', 20)}</a>
        <a class="icon-btn" href="https://github.com/gaurav-swarnkar/serverboy#readme" target="_blank" rel="noopener" title="Help">${icon('help', 20)}</a>
        <a class="icon-btn topbar-bell" href="#/messages" title="Messages">${icon('mail', 20)}<span id="msg-count" class="bell-count hidden"></span></a>
        <div class="usermenu">
          <button id="user-btn" class="user-btn" aria-haspopup="true">${avatarOf(user, 38)}</button>
          <div class="menu hidden">
            <div class="menu-head"><b>${esc(user.name || user.username)}</b><br>${esc(user.role)}</div>
            <a href="#/people/me">${icon('user', 16)} My profile</a>
            <a href="#/account">${icon('key', 16)} Password & login</a>
            <a href="#/messages">${icon('mail', 16)} Messages</a>
            ${user.isOwner ? `<a href="#/admin/users">${icon('settings', 16)} Administration</a>` : ''}
            <a href="#/servers">${icon('grid', 16)} All servers</a>
            <hr>
            <a href="#" id="logout">${icon('logout', 16)} Log out</a>
          </div>
        </div>
      </header>
      <main class="main" id="view"></main>
    </div>`;

  // On phones the sidebar is a slide-in menu; close it whenever a link is chosen.
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
  const themeList = app.querySelector('#theme-list');
  app.querySelector('#theme-btn').addEventListener('click', () => themeList.classList.toggle('hidden'));
  themeList.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-theme-pick]');
    if (!pick) return;
    e.preventDefault();
    setTheme(pick.dataset.themePick);
    themeList.classList.add('hidden');
    themeList.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a === pick));
    app.querySelector('#theme-btn').innerHTML = icon(shownTheme() === 'dark' ? 'moon' : 'sun', 20);
    window.dispatchEvent(new Event('sb:theme'));
  });
  const serverMenu = app.querySelector('#server-menu');
  app.querySelector('#server-switch')?.addEventListener('click', () => serverMenu.classList.toggle('hidden'));
  app.querySelector('#logout').addEventListener('click', async (e) => {
    e.preventDefault();
    await api('/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });
  setupSearch(server, current);
  return server;
}

// "Search anything": jump to any page of this server, the portal pages, or another server.
function setupSearch(server, current) {
  const input = app.querySelector('#top-search');
  const box = app.querySelector('#search-menu');
  const items = [];
  const add = (sections, hrefFor, where) => {
    for (const [, list] of sections) for (const [view, ico, label, href] of list) if (can(VIEW_PERMISSION[view])) items.push({ label, ico, href: href || hrefFor(view), where, tagline: PAGE_INFO[view]?.[1] || '' });
  };
  if (server) add(SERVER_NAV, (v) => `#/s/${server.id}/${v}`, server.name);
  add(PORTAL_NAV, (v) => `#/${v}`, 'Serverboy');
  for (const s of state.servers) items.push({ label: s.name, ico: 'server', href: `#/s/${s.id}/dashboard`, where: `${s.username}@${s.host}`, tagline: '' });
  let shown = [];
  let pick = 0;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = items.filter((i) => !q || `${i.label} ${i.tagline} ${i.where}`.toLowerCase().includes(q)).slice(0, 8);
    pick = Math.min(pick, Math.max(0, shown.length - 1));
    box.innerHTML = shown.length
      ? shown.map((i, n) => `<a href="${i.href}" class="${n === pick ? 'on' : ''}">${icon(i.ico, 16)}<span class="grow">${esc(i.label)}<small class="muted"> · ${esc(i.where)}</small></span></a>`).join('')
      : '<div class="menu-head">Nothing found</div>';
    box.classList.remove('hidden');
  };
  input.addEventListener('focus', draw);
  input.addEventListener('input', () => {
    pick = 0;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') pick = Math.min(pick + 1, shown.length - 1);
    else if (e.key === 'ArrowUp') pick = Math.max(pick - 1, 0);
    else if (e.key === 'Enter' && shown[pick]) {
      location.hash = shown[pick].href;
      input.blur();
    } else if (e.key === 'Escape') input.blur();
    else return;
    e.preventDefault();
    draw();
  });
  input.addEventListener('blur', () => setTimeout(() => box.classList.add('hidden'), 150));
  void current;
}

// When a page's own heading repeats the top-bar title, show it only once (its subtitle becomes
// the tagline) and keep the page's buttons.
function syncPageHead() {
  const view = document.getElementById('view');
  const head = view?.querySelector(':scope > .page-head');
  const top = document.getElementById('top-title');
  if (!head || !top) return;
  const h1 = head.querySelector('h1');
  if (h1 && h1.textContent.trim().toLowerCase().startsWith(top.textContent.trim().toLowerCase())) {
    if (!head.classList.contains('dup')) head.classList.add('dup');
    const sub = head.querySelector('.sub')?.textContent.trim();
    const tag = document.getElementById('top-tagline');
    // Only write when it differs: writing triggers the observer again.
    if (sub && tag.textContent !== sub) tag.textContent = sub;
  }
}
new MutationObserver(() => syncPageHead()).observe(document.getElementById('app'), { childList: true, subtree: true });

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    const input = document.getElementById('top-search');
    if (input) {
      e.preventDefault();
      input.focus();
    }
  }
});

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
  paintUnread();
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
