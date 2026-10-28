import { api, esc, toast, run, modal, confirmDialog, formDialog, onAction, loadingHtml, errorHtml, randomPassword, fmtDate } from '../ui.js';

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

export async function render(el, { servers }) {
  let info;
  let users = [];

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Team</h1><div class="sub">Give your developers their own logins, with only the permissions they need. Every change they make is logged.</div></div>
    </div>
    <div id="storage"></div>
    <div id="team-body"></div>`;

  const storageEl = el.querySelector('#storage');
  const bodyEl = el.querySelector('#team-body');

  async function load() {
    storageEl.innerHTML = loadingHtml();
    bodyEl.innerHTML = '';
    try {
      info = await api('/team');
    } catch (err) {
      storageEl.innerHTML = errorHtml(err);
      return;
    }
    drawStorage();
    if (info.status.connected) {
      bodyEl.innerHTML = loadingHtml();
      await loadUsers();
    }
  }

  function drawStorage() {
    const s = info.status;
    if (!s.configured) {
      const local = servers.filter((x) => LOCAL_HOSTS.includes(x.host));
      storageEl.innerHTML = `
        <div class="card" style="max-width:760px">
          <h2>Step 1: choose where team accounts are stored</h2>
          <p class="muted">Team members, their permissions and the activity log are kept in a <b>serverboy</b> database in MongoDB.
          Your own <b>admin</b> login stays separate, so you can always get in even if MongoDB is down.</p>
          ${
            local.length
              ? `<div class="row" style="margin-bottom:10px">
                  <select id="auto-server" style="width:auto">${local.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
                  <button class="btn-primary" data-action="auto">Create the serverboy database for me</button>
                </div>
                <p class="small muted">Creates a database <span class="mono">serverboy</span> and a user <span class="mono">serverboy_app</span> that can only access it, using the MongoDB login saved under Databases → MongoDB → Connection settings.</p>`
              : '<p class="small muted">Automatic setup needs a server added with host 127.0.0.1 (Serverboy running on that server).</p>'
          }
          <button data-action="uri">Use a connection string instead</button>
        </div>`;
      return;
    }
    storageEl.innerHTML = s.connected
      ? `<div class="card" style="margin-bottom:16px"><div class="row">
          <span>Team database: <span class="badge ok">connected</span> <span class="mono">${esc(s.database)}</span> · ${s.users} member(s)</span>
          <span class="grow"></span>
          <button class="btn-sm" data-action="uri">Change connection</button>
          <button class="btn-sm btn-danger" data-action="disconnect">Disconnect</button>
        </div></div>`
      : `<div class="notice bad"><b>The team database cannot be reached.</b> Team members cannot log in until this is fixed (you can, as admin).<br>
          <span class="small" style="white-space:pre-wrap">${esc(s.error || '')}</span>
          <div class="row" style="margin-top:8px"><button class="btn-sm" data-action="retry">Retry</button><button class="btn-sm" data-action="uri">Change connection</button>
          <a class="btn btn-sm" href="#/s/${servers[0]?.id}/services">Check the mongod service</a></div></div>`;
  }

  async function loadUsers() {
    try {
      users = await api('/team/users');
    } catch (err) {
      bodyEl.innerHTML = errorHtml(err);
      return;
    }
    const permLabel = Object.fromEntries(info.permissions.map((p) => [p.id, p]));
    bodyEl.innerHTML = `
      <div class="card flush" style="margin-bottom:16px">
        <div class="card-head"><h2>Team members</h2><button class="btn-primary btn-sm" data-action="add">+ Add team member</button></div>
        <div class="table-wrap"><table>
          <thead><tr><th>User</th><th>Permissions</th><th>Status</th><th>Last login</th><th></th></tr></thead>
          <tbody>
            <tr><td><b>admin</b><div class="small muted">You (owner)</div></td><td><span class="badge accent">everything</span></td><td><span class="badge ok">active</span></td><td></td><td></td></tr>
            ${users
              .map(
                (u, i) => `<tr>
              <td><b>${esc(u.username)}</b><div class="small muted">${esc(u.name)}</div></td>
              <td>${u.permissions.length ? u.permissions.map((p) => `<span class="badge ${permLabel[p]?.fullAccess ? 'warn' : ''}" style="margin:1px">${esc(permLabel[p]?.label || p)}</span>`).join(' ') : '<span class="muted small">view only</span>'}</td>
              <td>${u.disabled ? '<span class="badge bad">disabled</span>' : '<span class="badge ok">active</span>'}</td>
              <td class="small">${u.lastLoginAt ? fmtDate(Date.parse(u.lastLoginAt)) : '<span class="muted">never</span>'}</td>
              <td class="actions">
                <button class="btn-sm" data-action="edit" data-i="${i}">Permissions</button>
                <button class="btn-sm" data-action="reset" data-i="${i}">Reset password</button>
                <button class="btn-sm" data-action="toggle" data-i="${i}">${u.disabled ? 'Enable' : 'Disable'}</button>
                <button class="btn-sm btn-danger" data-action="remove" data-i="${i}">Delete</button>
              </td></tr>`,
              )
              .join('')}
          </tbody>
        </table></div>
      </div>
      <div class="card flush">
        <div class="card-head"><h2>Activity log</h2>
          <div class="row"><select id="audit-user" style="width:auto"><option value="">Everyone</option><option>admin</option>${users.map((u) => `<option>${esc(u.username)}</option>`).join('')}</select>
          <button class="btn-sm" data-action="audit">↻</button></div></div>
        <div id="audit">${loadingHtml()}</div>
        <p class="small muted" style="padding:0 16px">Entries are kept for ${info.auditDays} days. Passwords and file contents are never logged.</p>
      </div>`;
    el.querySelector('#audit-user').addEventListener('change', loadAudit);
    loadAudit();
  }

  async function loadAudit() {
    const box = el.querySelector('#audit');
    const user = el.querySelector('#audit-user').value;
    try {
      const rows = await api(`/team/audit?limit=300${user ? `&user=${encodeURIComponent(user)}` : ''}`);
      box.innerHTML = `<div class="table-wrap" style="max-height:480px"><table>
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Server</th><th>Result</th></tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr><td class="small">${fmtDate(Date.parse(r.at))}</td><td><b>${esc(r.user)}</b><div class="small muted mono">${esc(r.ip || '')}</div></td>
            <td class="mono small">${esc(r.action)}${r.target ? `<div class="muted">${esc(r.target)}</div>` : ''}</td>
            <td class="small">${esc(r.server || '')}</td>
            <td>${r.status ? `<span class="badge ${r.status < 400 ? 'ok' : 'bad'}">${r.status < 400 ? 'ok' : r.status === 403 ? 'denied' : 'error'}</span>` : ''}</td></tr>`,
          )
          .join('') || '<tr><td colspan="5" class="empty">Nothing yet</td></tr>'}</tbody></table></div>`;
    } catch (err) {
      box.innerHTML = errorHtml(err);
    }
  }

  // Add / edit dialog with permission checkboxes and presets.
  function memberDialog(existing) {
    return new Promise((resolve) => {
      const isNew = !existing;
      const current = new Set(existing ? existing.permissions : info.presets.developer);
      const body = document.createElement('div');
      body.innerHTML = `
        <form>
          ${
            isNew
              ? `<div class="form-grid">
                  <label class="field"><span>Username</span><input name="username" placeholder="ravi" autocomplete="off" required><small>They log in with this.</small></label>
                  <label class="field"><span>Full name (optional)</span><input name="name" placeholder="Ravi Kumar"></label>
                </div>
                <label class="field"><span>Password</span><input name="password" value="${randomPassword(16)}" autocomplete="off"><small>A strong one is generated; you'll see it once more to share. They can change it under Settings.</small></label>`
              : `<label class="field"><span>Full name</span><input name="name" value="${esc(existing.name)}"></label>`
          }
          <div class="row" style="margin-bottom:8px"><b class="grow">Permissions</b>
            <button type="button" class="btn-sm" data-preset="developer">Developer</button>
            <button type="button" class="btn-sm" data-preset="viewer">View only</button></div>
          ${info.permissions
            .map(
              (p) => `<label class="check" style="align-items:flex-start">
                <input type="checkbox" name="perm" value="${p.id}" ${current.has(p.id) ? 'checked' : ''} style="margin-top:4px">
                <span><b>${esc(p.label)}</b> ${p.fullAccess ? '<span class="badge warn">full server access</span>' : ''}<br><span class="small muted">${esc(p.description)}</span></span>
              </label>`,
            )
            .join('')}
          <p class="small muted">Everyone can see the dashboard, service list and task logs. Adding servers, the Team page and Serverboy's own settings are always owner-only.</p>
        </form>`;
      body.addEventListener('click', (e) => {
        const preset = e.target.closest('[data-preset]')?.dataset.preset;
        if (!preset) return;
        const set = new Set(info.presets[preset]);
        body.querySelectorAll('input[name=perm]').forEach((c) => (c.checked = set.has(c.value)));
      });
      let done = false;
      modal({
        title: isNew ? 'Add team member' : `Permissions for ${existing.username}`,
        wide: true,
        body,
        onClose: () => !done && resolve(null),
        actions: [
          { label: 'Cancel' },
          {
            label: isNew ? 'Create' : 'Save',
            className: 'btn-primary',
            onClick: async () => {
              const f = body.querySelector('form');
              const permissions = [...f.querySelectorAll('input[name=perm]:checked')].map((c) => c.value);
              const full = info.permissions.filter((p) => p.fullAccess && permissions.includes(p.id));
              if (full.length && !(await confirmDialog(`${full.map((p) => p.label).join(' and ')} give this person effective full control of the server. Continue?`, { confirmLabel: 'Yes, grant' }))) {
                return false;
              }
              const result = isNew
                ? await api('/team/users', { method: 'POST', body: { username: f.username.value, name: f.name.value, password: f.password.value, permissions } })
                : await api(`/team/users/${existing.id}`, { method: 'PUT', body: { name: f.name.value, permissions } });
              done = true;
              resolve({ user: result, password: isNew ? f.password.value : null });
            },
          },
        ],
      });
    });
  }

  function showCredentials(username, password) {
    modal({
      title: 'Share these login details',
      body: `<p>Send these to <b>${esc(username)}</b> privately (not in a group chat):</p>
        <pre class="log">Link:     ${esc(location.origin)}
Username: ${esc(username)}
Password: ${esc(password)}</pre>
        <p class="small muted">This password is not shown again. You can always reset it.</p>`,
      actions: [{ label: 'Done', className: 'btn-primary' }],
    });
  }

  onAction(el, {
    auto: async (_d, btn) => {
      const serverId = el.querySelector('#auto-server').value;
      const ok = await run(btn, () => api('/team/storage', { method: 'POST', body: { serverId } }), 'Team database created');
      if (ok) load();
    },
    uri: async () => {
      const v = await formDialog({
        title: 'Team database connection',
        intro: 'A MongoDB connection string for a database Serverboy may read and write, e.g. <span class="mono">mongodb://user:pass@127.0.0.1:27017/serverboy?authSource=serverboy</span>. It is tested before saving and stored encrypted.',
        fields: [{ name: 'uri', label: 'Connection string', placeholder: 'mongodb://…' }],
        submitLabel: 'Test & save',
        submit: (x) => api('/team/storage', { method: 'POST', body: x }),
      });
      if (v) {
        toast('Team database connected', 'ok');
        load();
      }
    },
    retry: load,
    disconnect: async () => {
      if (!(await confirmDialog('Disconnect the team database? Team members will not be able to log in. Their accounts stay in MongoDB and come back when you reconnect.', { danger: true, confirmLabel: 'Disconnect' }))) return;
      await run(null, () => api('/team/storage', { method: 'DELETE' }), 'Disconnected');
      load();
    },
    add: async () => {
      const r = await memberDialog(null);
      if (r) {
        showCredentials(r.user.username, r.password);
        load();
      }
    },
    edit: async ({ i }) => {
      const r = await memberDialog(users[i]);
      if (r) {
        toast('Permissions saved. They apply immediately.', 'ok');
        loadUsers();
      }
    },
    reset: async ({ i }) => {
      const u = users[i];
      const password = randomPassword(16);
      if (!(await confirmDialog(`Set a new password for ${u.username}? They will be logged out everywhere.`, { confirmLabel: 'Reset password' }))) return;
      const ok = await run(null, () => api(`/team/users/${u.id}/password`, { method: 'POST', body: { password } }));
      if (ok) showCredentials(u.username, password);
    },
    toggle: async ({ i }, btn) => {
      const u = users[i];
      await run(btn, () => api(`/team/users/${u.id}`, { method: 'PUT', body: { disabled: !u.disabled } }), u.disabled ? 'Enabled' : 'Disabled and logged out');
      loadUsers();
    },
    remove: async ({ i }) => {
      const u = users[i];
      if (!(await confirmDialog(`Delete ${u.username}? They are logged out immediately. Their activity log entries are kept.`, { danger: true, confirmLabel: 'Delete' }))) return;
      await run(null, () => api(`/team/users/${u.id}`, { method: 'DELETE' }), 'Deleted');
      load();
    },
    audit: loadAudit,
  });

  load();
}
