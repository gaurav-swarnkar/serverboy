import { api, esc, toast, run, formDialog, confirmDialog, onAction, modal, can, session } from '../ui.js';
import { icon } from '../icons.js';

const SERVER_FIELDS = (s = {}) => [
  { name: 'name', label: 'Display name', value: s.name, placeholder: 'My Azure server' },
  { name: 'host', label: 'IP address or hostname', value: s.host, placeholder: '20.115.10.42', required: true },
  { name: 'port', label: 'SSH port', type: 'number', value: s.port ?? 22 },
  { name: 'username', label: 'Username', value: s.username, placeholder: 'azureuser', help: 'The admin user you created with the Azure VM (Azure disables direct root login).' },
  {
    name: 'password',
    label: 'Password',
    type: 'password',
    placeholder: s.id ? '(unchanged)' : '',
    help: 'Used for SSH login and for sudo. With key login, still enter it if sudo asks for a password.',
  },
  {
    name: 'privateKey',
    label: 'Private key (optional)',
    type: 'textarea',
    rows: 4,
    placeholder: s.id ? '(unchanged; paste a new key to replace it)' : '-----BEGIN OPENSSH PRIVATE KEY-----\n…',
    help: 'Paste the contents of the .pem file Azure gave you, if you use SSH keys.',
  },
  { name: 'passphrase', label: 'Key passphrase (if any)', type: 'password', placeholder: s.id ? '(unchanged)' : '' },
];

function cleanInput(values, editing) {
  const out = { ...values, port: Number(values.port) || 22 };
  // When editing, empty secret fields mean "keep the existing value".
  if (editing) for (const k of ['password', 'privateKey', 'passphrase']) if (!out[k]) delete out[k];
  return out;
}

// Home: the landing page. A greeting, one live card per server (health, usage, backups),
// unread messages, and the owner's shortcuts. Server cards fill in as each server answers.
const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};
const pct = (used, total) => (total ? Math.round((used / total) * 100) : 0);
const meter = (label, value) => `<div class="home-meter"><span>${label}</span><div class="bar"><i style="width:${Math.min(100, value)}%" class="${value >= 90 ? 'bad' : value >= 80 ? 'warn' : ''}"></i></div><b>${value}%</b></div>`;

export async function render(el, { navigate, refreshServers }) {
  const servers = await refreshServers();
  const me = session.user;
  const first = String(me.name || me.username || '').split(/[\s(]/)[0];

  el.innerHTML = `
    <div class="page-head">
      <div><h1>${greeting()}${first ? `, ${esc(first)}` : ''}</h1><div class="sub">${servers.length ? `${servers.length} server${servers.length === 1 ? '' : 's'} · here is how everything is doing.` : 'Add a server to get started.'}</div></div>
      ${can('owner') ? '<button class="btn-primary" data-action="add">+ Add server</button>' : ''}
    </div>
    <div id="home-msgs"></div>
    ${
      servers.length
        ? `<div class="grid home-servers">${servers
            .map(
              (s) => `
          <div class="card home-server" data-server="${s.id}">
            <div class="row" style="gap:10px"><span class="chip-ico">${icon('server', 20)}</span><div class="grow" style="min-width:0"><h2 style="margin:0">${esc(s.name)}</h2><div class="mono small muted" style="overflow:hidden;text-overflow:ellipsis">${esc(s.username)}@${esc(s.host)}:${s.port}</div></div><span class="home-status badge">checking…</span></div>
            <div class="home-live small muted" style="margin:12px 0">Connecting…</div>
            <div class="row" style="flex-wrap:wrap">
              <a class="btn btn-primary" href="#/s/${s.id}/dashboard">Open</a>
              ${can('owner') ? `<button class="btn-sm btn-ghost" data-action="test" data-id="${s.id}">Test</button>
              <button class="btn-sm btn-ghost" data-action="edit" data-id="${s.id}">Edit</button>
              <button class="btn-sm btn-ghost btn-danger" data-action="remove" data-id="${s.id}">Remove</button>` : ''}
            </div>
          </div>`,
            )
            .join('')}</div>`
        : `<div class="card empty">
            <h2>Add your first server</h2>
            <p>You need the server's public IP and the username + password (or key) you chose when creating the Azure VM.</p>
            ${can('owner') ? '<button class="btn-primary" data-action="add">+ Add server</button>' : '<p class="muted">Ask the owner to add a server.</p>'}
          </div>`
    }
    ${can('owner') ? `<div class="grid grid-2" style="margin-top:20px">
    <div class="card">
      <h3>Your team</h3>
      <p class="muted" style="margin-top:0">Give developers their own logins with only the access they need.</p>
      <div class="row"><a class="btn" href="#/admin/users">Users</a><a class="btn" href="#/admin/roles">Roles &amp; permissions</a><a class="btn" href="#/admin/activity">Activity log</a></div>
    </div>
    <div class="card">
      <h3>Azure checklist</h3>
      <ul class="muted" style="margin:0;padding-left:18px">
        <li>In the Azure Portal, open your VM → <b>Networking</b> and make sure inbound port <b>22 (SSH)</b> is allowed. Later add <b>80</b> and <b>443</b> for websites.</li>
        <li>Use the VM's <b>Public IP address</b> from its Overview page.</li>
        <li>Ubuntu 22.04 or 24.04 LTS is recommended; every installer here is written for Ubuntu/Debian.</li>
      </ul>
    </div>
    </div>` : ''}`;

  for (const s of servers) fillServer(el, s);
  fillMessages(el);

  onAction(el, {
    add: async () => {
      const created = await formDialog({
        title: 'Add server',
        fields: SERVER_FIELDS(),
        submitLabel: 'Save & test',
        submit: (v) => api('/servers', { method: 'POST', body: cleanInput(v, false) }),
      });
      if (!created) return;
      toast('Server saved. Testing connection…');
      const ok = await testServer(created.id);
      await refreshServers();
      if (ok) navigate(`#/s/${created.id}/dashboard`);
      else render(el, { navigate, refreshServers });
    },
    edit: async ({ id }) => {
      const s = servers.find((x) => x.id === id);
      const fields = SERVER_FIELDS(s);
      fields.push({ name: 'resetFingerprint', label: 'Reset saved host key (only if you rebuilt/reinstalled the server)', type: 'checkbox' });
      const saved = await formDialog({
        title: `Edit ${s.name}`,
        fields,
        submit: (v) => api(`/servers/${id}`, { method: 'PUT', body: cleanInput(v, true) }),
      });
      if (saved) {
        toast('Saved', 'ok');
        render(el, { navigate, refreshServers });
      }
    },
    test: async (_d, btn) => {
      await run(btn, () => testServer(btn.dataset.id));
      render(el, { navigate, refreshServers });
    },
    remove: async ({ id }) => {
      const s = servers.find((x) => x.id === id);
      if (!(await confirmDialog(`Remove ${s.name} from Serverboy? Nothing on the server itself is changed.`, { danger: true, confirmLabel: 'Remove' }))) return;
      await api(`/servers/${id}`, { method: 'DELETE' });
      render(el, { navigate, refreshServers });
    },
  });
}

async function fillServer(root, s) {
  const card = root.querySelector(`[data-server="${s.id}"]`);
  if (!card) return;
  const status = card.querySelector('.home-status');
  const live = card.querySelector('.home-live');
  const [health, stats, backup] = await Promise.allSettled([
    api(`/servers/${s.id}/health`),
    api(`/servers/${s.id}/stats`),
    can('owner') ? api(`/servers/${s.id}/backups`) : Promise.resolve(null),
  ]);
  if (!card.isConnected) return;
  if (stats.status === 'rejected') {
    status.className = 'home-status badge bad';
    status.textContent = 'unreachable';
    live.innerHTML = `<span style="color:var(--bad)">${esc(stats.reason.message)}</span>`;
    return;
  }
  const st = stats.value;
  const h = health.status === 'fulfilled' ? health.value : null;
  const problems = h ? h.problems.filter((p) => p.level === 'bad').length : 0;
  const warnings = h ? h.problems.filter((p) => p.level === 'warn').length : 0;
  status.className = `home-status badge ${problems ? 'bad' : warnings ? 'warn' : 'ok'}`;
  status.textContent = !h ? 'online' : problems ? `${problems} problem${problems === 1 ? '' : 's'}` : warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : 'all good';
  const root0 = (st.disks || []).find((d) => d.mount === '/') || (st.disks || [])[0];
  const b = backup.status === 'fulfilled' && backup.value ? backup.value : null;
  const last = b?.state?.last;
  live.innerHTML = `
    ${meter('CPU', Math.round(st.cpuPercent ?? 0))}
    ${meter('Memory', pct(st.memory.total - st.memory.available, st.memory.total))}
    ${root0 ? meter('Disk', pct(root0.used, root0.size)) : ''}
    <div class="home-facts">
      <span>${esc(st.os || '')}</span>
      <span>up ${Math.floor((st.uptimeSeconds || 0) / 86400)} d</span>
      ${b ? `<span>Backup: ${last ? `${last.status === 'success' ? '✔' : last.status === 'partial' ? '⚠' : '✘'} ${new Date(last.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : b.configured ? 'none yet' : '<a href="#/s/' + s.id + '/backups">not set up</a>'}</span>` : ''}
    </div>
    ${h && (problems || warnings) ? `<div class="home-problem">${esc(h.problems.find((p) => p.level === 'bad')?.text || h.problems[0].text)}</div>` : ''}`;
}

async function fillMessages(root) {
  const box = root.querySelector('#home-msgs');
  try {
    const list = (await api('/messages')).filter((m) => m.unread).slice(0, 3);
    if (!list.length || !box.isConnected) return;
    box.innerHTML = `<div class="card home-msgs"><div class="row"><b class="grow">${icon('mail', 16)} ${list.length} unread message${list.length === 1 ? '' : 's'}</b><a href="#/messages">Open messages</a></div>
      ${list.map((m) => `<a class="home-msg" href="#/messages/${m.id}"><b>${esc(m.subject)}</b><span class="muted small">from ${esc(m.from.name)}${m.level === 'important' ? ' · important' : ''}</span></a>`).join('')}</div>`;
  } catch {
    /* messages need the team database; nothing to show */
  }
}

async function testServer(id) {
  try {
    const r = await api(`/servers/${id}/test`, { method: 'POST' });
    const sudoText = {
      root: 'Logged in as root.',
      nopass: 'sudo works without a password.',
      pass: 'sudo will use the saved password.',
      none: 'Warning: no sudo access (no password saved and passwordless sudo is off). Installing software will fail.',
    }[r.sudoMode];
    modal({
      title: 'Connected ✔',
      body: `<p><b>${esc(r.hostname)}</b> — ${esc(r.os)}</p><p>${esc(sudoText)}</p><p class="small muted">Host key fingerprint (saved and checked on every connection):<br><span class="mono">${esc(r.fingerprint)}</span></p>`,
      actions: [{ label: 'OK', className: 'btn-primary' }],
    });
    return r.sudoMode !== 'none';
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}
