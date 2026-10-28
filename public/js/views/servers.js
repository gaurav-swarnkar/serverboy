import { api, esc, toast, run, formDialog, confirmDialog, onAction, modal } from '../ui.js';

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

export async function render(el, { navigate, refreshServers }) {
  const servers = await refreshServers();

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Servers</h1><div class="sub">Connect Serverboy to your Linux servers over SSH.</div></div>
      <button class="btn-primary" data-action="add">+ Add server</button>
    </div>
    ${
      servers.length
        ? `<div class="grid grid-3">${servers
            .map(
              (s) => `
          <div class="card">
            <div class="row"><h2 class="grow" style="margin:0">${esc(s.name)}</h2><span class="badge">${s.authType === 'key' ? 'SSH key' : 'Password'}</span></div>
            <p class="mono muted" style="margin:8px 0">${esc(s.username)}@${esc(s.host)}:${s.port}</p>
            <p class="small muted" style="margin:0 0 12px">Host key: ${s.hostFingerprint ? `<span class="mono">${esc(s.hostFingerprint.slice(0, 26))}…</span>` : 'not verified yet'}</p>
            <div class="row">
              <a class="btn btn-primary" href="#/s/${s.id}/dashboard">Open</a>
              <button data-action="test" data-id="${s.id}">Test connection</button>
              <button data-action="edit" data-id="${s.id}">Edit</button>
              <button class="btn-danger" data-action="remove" data-id="${s.id}">Remove</button>
            </div>
          </div>`,
            )
            .join('')}</div>`
        : `<div class="card empty">
            <h2>Add your first server</h2>
            <p>You need the server's public IP and the username + password (or key) you chose when creating the Azure VM.</p>
            <button class="btn-primary" data-action="add">+ Add server</button>
          </div>`
    }
    <div class="card" style="margin-top:20px">
      <h3>Azure checklist</h3>
      <ul class="muted" style="margin:0;padding-left:18px">
        <li>In the Azure Portal, open your VM → <b>Networking</b> and make sure inbound port <b>22 (SSH)</b> is allowed. Later add <b>80</b> and <b>443</b> for websites.</li>
        <li>Use the VM's <b>Public IP address</b> from its Overview page.</li>
        <li>Ubuntu 22.04 or 24.04 LTS is recommended; every installer here is written for Ubuntu/Debian.</li>
      </ul>
    </div>`;

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
