// Shared by the Administration pages: team database status and first-time setup.
import { api, esc, toast, run, formDialog, onAction, loadingHtml, errorHtml } from '../ui.js';

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

export function adminHead(title, sub, actions = '') {
  return `<div class="page-head"><div><h1>${esc(title)}</h1><div class="sub">${sub}</div></div><div class="row">${actions}</div></div>`;
}

// Renders a setup / error card into `el` unless the team database is connected.
// Resolves to the /team info when ready, or null when the page should stop here.
export async function requireTeamDb(el, servers, onReady) {
  el.innerHTML = loadingHtml();
  let info;
  try {
    info = await api('/team');
  } catch (err) {
    el.innerHTML = errorHtml(err);
    return null;
  }
  if (info.status.connected) return info;
  el.innerHTML = info.status.configured ? notReachableCard(info, servers) : setupCard(servers);
  bindSetup(el, onReady);
  return null;
}

function setupCard(servers) {
  const local = servers.filter((x) => LOCAL_HOSTS.includes(x.host));
  return `
    <div class="card" style="max-width:780px">
      <h2>Set up team accounts (one time)</h2>
      <p class="muted">Users, roles and the activity log are kept in a <b>serverboy</b> database in your MongoDB.
      Your own <b>admin</b> login stays separate, so you can always get in even if MongoDB is down.</p>
      <ol class="muted" style="padding-left:18px">
        <li>Open a server → Databases → MongoDB → <b>Connection settings</b> and save your MongoDB admin login.</li>
        <li>Come back here and click the button below.</li>
      </ol>
      ${
        local.length
          ? `<div class="row" style="margin-bottom:10px">
              <select id="auto-server" style="width:auto">${local.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
              <button class="btn-primary" data-action="auto">Create the serverboy database</button>
            </div>
            <p class="small muted">Creates a database <span class="mono">serverboy</span> and a MongoDB user <span class="mono">serverboy_app</span> that can only access it.</p>`
          : '<p class="small muted">Automatic setup needs a server added with host 127.0.0.1 (Serverboy running on that server).</p>'
      }
      <button data-action="uri">Use a connection string instead</button>
    </div>`;
}

function notReachableCard(info, servers) {
  return `<div class="notice bad"><b>The team database cannot be reached.</b> Team members cannot log in until this is fixed (you can, as admin).<br>
    <span class="small" style="white-space:pre-wrap">${esc(info.status.error || '')}</span>
    <div class="row" style="margin-top:8px"><button class="btn-sm" data-action="retry">Retry</button><button class="btn-sm" data-action="uri">Change connection</button>
    ${servers[0] ? `<a class="btn btn-sm" href="#/s/${servers[0].id}/services">Check the mongod service</a>` : ''}</div></div>`;
}

export function bindSetup(el, onReady) {
  onAction(el, {
    auto: async (_d, btn) => {
      const serverId = el.querySelector('#auto-server').value;
      const ok = await run(btn, () => api('/team/storage', { method: 'POST', body: { serverId } }), 'Team database ready');
      if (ok) onReady();
    },
    uri: () => changeConnection(onReady),
    retry: onReady,
  });
}

export async function changeConnection(onDone) {
  const v = await formDialog({
    title: 'Team database connection',
    intro: 'A MongoDB connection string for a database Serverboy may read and write, e.g. <span class="mono">mongodb://user:pass@127.0.0.1:27017/serverboy?authSource=serverboy</span>. It is tested before saving and stored encrypted.',
    fields: [{ name: 'uri', label: 'Connection string', placeholder: 'mongodb://…' }],
    submitLabel: 'Test & save',
    submit: (x) => api('/team/storage', { method: 'POST', body: x }),
  });
  if (v) {
    toast('Team database connected', 'ok');
    onDone();
  }
}

export function permissionBadges(permissions, info) {
  const byId = Object.fromEntries(info.permissions.map((p) => [p.id, p]));
  if (!permissions.length) return '<span class="muted small">view only</span>';
  return permissions.map((p) => `<span class="badge ${byId[p]?.fullAccess ? 'warn' : ''}" style="margin:1px">${esc(byId[p]?.label || p)}</span>`).join(' ');
}
