import { api, esc, toast, run, confirmDialog, formDialog, onAction } from '../ui.js';
import { adminHead, requireTeamDb } from './admin-common.js';

export async function render(el, { servers }) {
  el.innerHTML = `${adminHead('Roles & permissions', 'Tick what each role can do. Everyone with that role gets the change straight away.', '<button class="btn-primary" data-action="add" disabled>+ New role</button>')}<div id="body"></div>`;
  const body = el.querySelector('#body');
  let info;
  let roles = [];

  async function load() {
    info = await requireTeamDb(body, servers, load);
    if (!info) return;
    el.querySelector('[data-action=add]').disabled = false;
    roles = await api('/team/roles');
    const perms = info.permissions;
    body.innerHTML = `
      <div class="card flush">
        <div class="table-wrap"><table class="matrix">
          <thead><tr><th>Role</th>${perms.map((p) => `<th class="perm" title="${esc(p.description)}">${esc(p.label)}${p.fullAccess ? ' ⚠' : ''}</th>`).join('')}<th>Users</th><th></th></tr></thead>
          <tbody>
            <tr><td><b>Owner</b><div class="small muted">You (admin). Always everything.</div></td>${perms.map(() => '<td class="perm"><input type="checkbox" checked disabled></td>').join('')}<td>1</td><td></td></tr>
            ${roles
              .map(
                (r, i) => `<tr data-row="${i}">
              <td><b>${esc(r.name)}</b><div class="small muted">${esc(r.description)}</div></td>
              ${perms.map((p) => `<td class="perm"><input type="checkbox" data-role="${i}" value="${p.id}" ${r.permissions.includes(p.id) ? 'checked' : ''} aria-label="${esc(`${r.name}: ${p.label}`)}"></td>`).join('')}
              <td>${r.users}</td>
              <td class="actions">
                <button class="btn-sm btn-primary hidden" data-action="save" data-i="${i}">Save</button>
                <button class="btn-sm" data-action="rename" data-i="${i}">Rename</button>
                <button class="btn-sm btn-danger" data-action="remove" data-i="${i}" ${r.users ? `disabled title="${r.users} user(s) have this role"` : ''}>Delete</button>
              </td></tr>`,
              )
              .join('')}
          </tbody>
        </table></div>
      </div>
      <div class="card" style="margin-top:16px">
        <h3>What each permission allows</h3>
        <table><tbody>${perms
          .map((p) => `<tr><td style="width:160px"><b>${esc(p.label)}</b></td><td class="small">${esc(p.description)}${p.fullAccess ? ' <span class="badge warn">full server access</span>' : ''}</td></tr>`)
          .join('')}
          <tr><td><b>Everyone</b></td><td class="small">Can see the dashboard, the service list and task logs, and change their own password.</td></tr>
          <tr><td><b>Owner only</b></td><td class="small">Adding servers, administration (users, roles, activity log, settings), raw Nginx config and MongoDB admin credentials.</td></tr>
        </tbody></table>
      </div>`;
    // Ticking a box marks the row as changed and shows its Save button.
    body.querySelectorAll('input[data-role]').forEach((c) =>
      c.addEventListener('change', () => {
        const i = c.dataset.role;
        body.querySelector(`tr[data-row="${i}"]`).classList.add('dirty');
        body.querySelector(`[data-action=save][data-i="${i}"]`).classList.remove('hidden');
      }),
    );
  }

  const rowPermissions = (i) => [...body.querySelectorAll(`input[data-role="${i}"]:checked`)].map((c) => c.value);

  onAction(el, {
    save: async ({ i }, btn) => {
      const r = roles[i];
      const permissions = rowPermissions(i);
      const added = info.permissions.filter((p) => p.fullAccess && permissions.includes(p.id) && !r.permissions.includes(p.id));
      if (added.length && !(await confirmDialog(`${added.map((p) => p.label).join(' and ')} give everyone with the ${r.name} role (${r.users} user(s)) effective full control of the server. Continue?`, { confirmLabel: 'Yes, save' }))) return;
      const ok = await run(btn, () => api(`/team/roles/${r.id}`, { method: 'PUT', body: { name: r.name, description: r.description, permissions } }), `${r.name} saved`);
      if (ok) load();
    },
    add: async () => {
      if (!info) return;
      const v = await formDialog({
        title: 'New role',
        fields: [
          { name: 'name', label: 'Name', placeholder: 'Database admin', required: true },
          { name: 'description', label: 'Description (optional)', placeholder: 'Manages databases only' },
          { name: 'copy', label: 'Start with the permissions of', type: 'select', options: [['', 'Nothing (view only)'], ...roles.map((r) => [r.id, r.name])] },
        ],
        submitLabel: 'Create role',
        submit: (x) => {
          const from = roles.find((r) => r.id === x.copy);
          return api('/team/roles', { method: 'POST', body: { name: x.name, description: x.description, permissions: from ? from.permissions : [] } });
        },
      });
      if (v) {
        toast('Role created. Tick its permissions and click Save.', 'ok');
        load();
      }
    },
    rename: async ({ i }) => {
      const r = roles[i];
      const v = await formDialog({
        title: `Rename ${r.name}`,
        fields: [
          { name: 'name', label: 'Name', value: r.name },
          { name: 'description', label: 'Description', value: r.description },
        ],
        submit: (x) => api(`/team/roles/${r.id}`, { method: 'PUT', body: { ...x, permissions: r.permissions } }),
      });
      if (v) load();
    },
    remove: async ({ i }) => {
      const r = roles[i];
      if (!(await confirmDialog(`Delete the ${r.name} role?`, { danger: true, confirmLabel: 'Delete' }))) return;
      await run(null, () => api(`/team/roles/${r.id}`, { method: 'DELETE' }), 'Role deleted');
      load();
    },
  });

  load();
}
