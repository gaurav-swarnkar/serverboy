import { api, esc, toast, run, modal, confirmDialog, onAction, randomPassword, fmtDate, session } from '../ui.js';
import { adminHead, requireTeamDb, permissionBadges } from './admin-common.js';
import { accessPicker, scopeSummary } from './admin-access.js';

export async function render(el, { servers }) {
  el.innerHTML = `${adminHead('Users', 'Logins for your team. Each user gets a role, which decides what they can do.', '<button class="btn-primary" data-action="add" disabled>+ Add user</button>')}<div id="body"></div>`;
  const body = el.querySelector('#body');
  let info;
  let users = [];
  let roles = [];

  async function load() {
    info = await requireTeamDb(body, servers, load);
    if (!info) return;
    el.querySelector('[data-action=add]').disabled = false;
    [users, roles] = await Promise.all([api('/team/users'), api('/team/roles')]);
    body.innerHTML = `
      <div class="card flush">
        <div class="table-wrap"><table>
          <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Can do</th><th>Access</th><th>Status</th><th>Last login</th><th></th></tr></thead>
          <tbody>
            <tr><td><b>admin</b><div class="small muted">You</div></td><td class="small">${esc(session.user.email || '')}</td><td><span class="badge accent">Owner</span></td><td><span class="small">Everything</span></td><td class="small">All</td><td><span class="badge ok">active</span></td><td></td><td></td></tr>
            ${users
              .map(
                (u, i) => `<tr>
              <td><b>${esc(u.username)}</b><div class="small muted">${esc(u.name)}</div></td>
              <td class="small">${u.email ? esc(u.email) : '<span class="muted">none</span>'}</td>
              <td>${u.roleName ? `<span class="badge">${esc(u.roleName)}</span>` : '<span class="badge">Custom</span>'}</td>
              <td>${permissionBadges(u.permissions, info)}</td>
              <td class="small">${esc(scopeSummary(u.scope))}</td>
              <td>${u.disabled ? '<span class="badge bad">disabled</span>' : '<span class="badge ok">active</span>'}</td>
              <td class="small">${u.lastLoginAt ? fmtDate(Date.parse(u.lastLoginAt)) : '<span class="muted">never</span>'}</td>
              <td class="actions">
                <button class="btn-sm" data-action="edit" data-i="${i}">Edit</button>
                <button class="btn-sm" data-action="reset" data-i="${i}">Reset password</button>
                <button class="btn-sm" data-action="toggle" data-i="${i}">${u.disabled ? 'Enable' : 'Disable'}</button>
                <button class="btn-sm btn-danger" data-action="remove" data-i="${i}">Delete</button>
              </td></tr>`,
              )
              .join('')}
            ${users.length ? '' : '<tr><td colspan="8" class="empty">No team members yet. Click <b>+ Add user</b>.</td></tr>'}
          </tbody>
        </table></div>
      </div>
      <p class="small muted">Changes apply immediately. Disabling, deleting or resetting a password logs that person out. Manage what each role can do under <a href="#/admin/roles">Roles &amp; permissions</a>.</p>`;
  }

  // Add / edit dialog: pick a role, or "Custom" to tick permissions for just this person.
  function userDialog(existing) {
    return new Promise((resolve) => {
      const isNew = !existing;
      const developer = roles.find((r) => r.name === 'Developer');
      const selected = existing ? existing.roleId || 'custom' : developer?.id || roles[0]?.id || 'custom';
      const custom = new Set(existing ? existing.customPermissions : []);
      const box = document.createElement('div');
      box.innerHTML = `
        <form>
          ${
            isNew
              ? `<div class="form-grid">
                  <label class="field"><span>Username</span><input name="username" placeholder="ravi" autocomplete="off" required><small>They log in with this.</small></label>
                  <label class="field"><span>Full name (optional)</span><input name="name" placeholder="Ravi Kumar"></label>
                </div>
                <label class="field"><span>Email (optional)</span><input name="email" type="email" placeholder="ravi@company.com" autocomplete="off"><small>They can log in with this instead of the username.</small></label>
                <label class="field"><span>Password</span><input name="password" value="${randomPassword(16)}" autocomplete="off"><small>A strong one is generated. You'll see it again to share; they can change it in My account.</small></label>`
              : `<div class="form-grid">
                  <label class="field"><span>Full name</span><input name="name" value="${esc(existing.name)}"></label>
                  <label class="field"><span>Email</span><input name="email" type="email" value="${esc(existing.email)}" placeholder="optional"><small>Used to log in. Leave empty to remove.</small></label>
                </div>`
          }
          <label class="field"><span>Role</span>
            <select name="role">
              ${roles.map((r) => `<option value="${r.id}" ${r.id === selected ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
              <option value="custom" ${selected === 'custom' ? 'selected' : ''}>Custom (choose permissions for this person)</option>
            </select>
          </label>
          <div id="role-perms"></div>
          <h3 style="margin:18px 0 8px">Access</h3>
          <div id="user-access"></div>
        </form>`;
      const permsEl = box.querySelector('#role-perms');
      const drawPerms = () => {
        const value = box.querySelector('select[name=role]').value;
        if (value !== 'custom') {
          const role = roles.find((r) => r.id === value);
          permsEl.innerHTML = `<div class="notice" style="margin:0"><b>${esc(role.name)}</b> can: ${permissionBadges(role.permissions, info)}
            <div class="small muted" style="margin-top:4px">${esc(role.description)}</div></div>`;
          return;
        }
        permsEl.innerHTML = info.permissions
          .map(
            (p) => `<label class="check" style="align-items:flex-start">
              <input type="checkbox" name="perm" value="${p.id}" ${custom.has(p.id) ? 'checked' : ''} style="margin-top:4px">
              <span><b>${esc(p.label)}</b> ${p.fullAccess ? '<span class="badge warn">full server access</span>' : ''}<br><span class="small muted">${esc(p.description)}</span></span>
            </label>`,
          )
          .join('');
        permsEl.querySelectorAll('input[name=perm]').forEach((c) => c.addEventListener('change', () => (c.checked ? custom.add(c.value) : custom.delete(c.value))));
      };
      box.querySelector('select[name=role]').addEventListener('change', drawPerms);
      drawPerms();
      const readScope = accessPicker(box.querySelector('#user-access'), servers, existing?.scope);

      let done = false;
      modal({
        title: isNew ? 'Add user' : `Edit ${existing.username}`,
        wide: true,
        body: box,
        onClose: () => !done && resolve(null),
        actions: [
          { label: 'Cancel' },
          {
            label: isNew ? 'Create user' : 'Save',
            className: 'btn-primary',
            onClick: async () => {
              const f = box.querySelector('form');
              const roleId = f.role.value === 'custom' ? null : f.role.value;
              const effective = roleId ? roles.find((r) => r.id === roleId).permissions : [...custom];
              const full = info.permissions.filter((p) => p.fullAccess && effective.includes(p.id));
              if (full.length && !(await confirmDialog(`${full.map((p) => p.label).join(' and ')} give this person effective full control of the server. Continue?`, { confirmLabel: 'Yes, continue' }))) {
                return false;
              }
              const payload = { name: f.name.value, email: f.email.value, roleId, permissions: [...custom], scope: readScope() };
              const result = isNew
                ? await api('/team/users', { method: 'POST', body: { ...payload, username: f.username.value, password: f.password.value } })
                : await api(`/team/users/${existing.id}`, { method: 'PUT', body: payload });
              done = true;
              resolve({ user: result, password: isNew ? f.password.value : null });
            },
          },
        ],
      });
    });
  }

  function showCredentials(username, password, email = '') {
    modal({
      title: 'Share these login details',
      body: `<p>Send these to <b>${esc(username)}</b> privately (not in a group chat):</p>
        <pre class="log">Link:     ${esc(location.origin)}
Username: ${esc(username)}${email ? `\nEmail:    ${esc(email)}  (either one works)` : ''}
Password: ${esc(password)}</pre>
        <p class="small muted">This password is not shown again. You can always reset it.</p>`,
      actions: [{ label: 'Done', className: 'btn-primary' }],
    });
  }

  onAction(el, {
    add: async () => {
      if (!info) return;
      const r = await userDialog(null);
      if (r) {
        showCredentials(r.user.username, r.password, r.user.email);
        load();
      }
    },
    edit: async ({ i }) => {
      const r = await userDialog(users[i]);
      if (r) {
        toast('Saved. Changes apply immediately.', 'ok');
        load();
      }
    },
    reset: async ({ i }) => {
      const u = users[i];
      if (!(await confirmDialog(`Set a new password for ${u.username}? They will be logged out everywhere.`, { confirmLabel: 'Reset password' }))) return;
      const password = randomPassword(16);
      const ok = await run(null, () => api(`/team/users/${u.id}/password`, { method: 'POST', body: { password } }));
      if (ok) showCredentials(u.username, password, u.email);
    },
    toggle: async ({ i }, btn) => {
      const u = users[i];
      await run(btn, () => api(`/team/users/${u.id}`, { method: 'PUT', body: { disabled: !u.disabled } }), u.disabled ? 'Enabled' : 'Disabled and logged out');
      load();
    },
    remove: async ({ i }) => {
      const u = users[i];
      if (!(await confirmDialog(`Delete ${u.username}? They are logged out immediately. Their activity log entries are kept.`, { danger: true, confirmLabel: 'Delete' }))) return;
      await run(null, () => api(`/team/users/${u.id}`, { method: 'DELETE' }), 'Deleted');
      load();
    },
  });

  load();
}
