import { api, run, toast, esc, session } from '../ui.js';

const LABELS = {
  databases: 'Manage databases',
  sites: 'Manage websites',
  files: 'Edit website files (in /var/www)',
  services: 'View logs and restart services',
  nodeapps: 'Deploy and manage Node.js apps',
  terminal: 'Use the server terminal',
  system: 'Install software, firewall, updates, reboot',
};

export async function render(el) {
  const u = session.user;
  el.innerHTML = `
    <div class="page-head"><div><h1>My account</h1><div class="sub">Your login and what you are allowed to do.</div></div></div>
    <div class="grid grid-2" style="align-items:start">
      <div class="card">
        <h2>Profile</h2>
        <table><tbody>
          <tr><td class="muted">Username</td><td><b>${esc(u.username)}</b></td></tr>
          <tr><td class="muted">Email</td><td>${
            u.isOwner
              ? `<form id="email-form" class="row"><input name="email" type="email" value="${esc(u.email)}" placeholder="you@example.com" style="width:auto;flex:1"><button class="btn-sm">Save</button></form>
                 <div class="small muted">Optional. Lets you log in with your email instead of "admin".</div>`
              : u.email
                ? `${esc(u.email)} <div class="small muted">You can log in with this or your username.</div>`
                : '<span class="muted">none (ask the owner to add one)</span>'
          }</td></tr>
          ${u.name ? `<tr><td class="muted">Name</td><td>${esc(u.name)}</td></tr>` : ''}
          <tr><td class="muted">Role</td><td><span class="badge accent">${esc(u.role)}</span></td></tr>
          <tr><td class="muted">You can</td><td>${
            u.isOwner
              ? 'Everything, including administration'
              : `<ul style="margin:0;padding-left:18px"><li>See dashboards, services and task logs</li>${u.permissions.map((p) => `<li>${esc(LABELS[p] || p)}</li>`).join('')}</ul>`
          }</td></tr>
        </tbody></table>
        ${u.isOwner ? '' : '<p class="small muted">Need more access? Ask the owner.</p>'}
      </div>
      <div class="card">
        <h2>Change your password</h2>
        <form id="pw">
          <label class="field"><span>Current password</span><input type="password" name="current" required autocomplete="current-password"></label>
          <label class="field"><span>New password</span><input type="password" name="next" required minlength="${u.isOwner ? 8 : 10}" autocomplete="new-password"></label>
          <label class="field"><span>Repeat new password</span><input type="password" name="repeat" required autocomplete="new-password"></label>
          <button class="btn-primary">Change password</button>
        </form>
      </div>
    </div>`;
  el.querySelector('#email-form')?.addEventListener('submit', async (e) => {
    const r = await run(e.target.querySelector('button'), () => api('/account/email', { method: 'POST', body: { email: e.target.email.value } }), 'Email saved');
    if (r) session.user.email = r.email;
  });
  el.querySelector('#pw').addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.next.value !== f.repeat.value) return toast('The new passwords do not match', 'error');
    const ok = await run(f.querySelector('button'), () => api('/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } }), 'Password changed');
    if (ok) f.reset();
  });
}
