import { api, esc, onAction, fmtDate, loadingHtml, errorHtml } from '../ui.js';
import { adminHead, requireTeamDb } from './admin-common.js';

export async function render(el, { servers }) {
  el.innerHTML = `${adminHead('Activity log', 'Who did what, when, and from where. Passwords and file contents are never logged.', '<button data-action="refresh">↻ Refresh</button>')}<div id="body"></div>`;
  const body = el.querySelector('#body');
  let rows = [];
  let info;

  async function load() {
    info = await requireTeamDb(body, servers, load);
    if (!info) return;
    const users = await api('/team/users');
    body.innerHTML = `
      <div class="card flush">
        <div class="card-head">
          <div class="row grow">
            <select id="f-user" style="width:auto"><option value="">Everyone</option><option>admin</option>${users.map((u) => `<option>${esc(u.username)}</option>`).join('')}</select>
            <select id="f-result" style="width:auto"><option value="">All results</option><option value="denied">Denied only</option><option value="error">Errors only</option></select>
            <input id="f-text" placeholder="Search: user, action, server, file…" class="grow" style="width:auto;min-width:200px">
          </div>
        </div>
        <div id="rows">${loadingHtml()}</div>
      </div>
      <p class="small muted">Entries are kept for ${info.auditDays} days. Showing the latest 1000.</p>`;
    body.querySelector('#f-user').addEventListener('change', fetchRows);
    body.querySelector('#f-result').addEventListener('change', draw);
    body.querySelector('#f-text').addEventListener('input', draw);
    fetchRows();
  }

  async function fetchRows() {
    const user = body.querySelector('#f-user').value;
    try {
      rows = await api(`/team/audit?limit=1000${user ? `&user=${encodeURIComponent(user)}` : ''}`);
      draw();
    } catch (err) {
      body.querySelector('#rows').innerHTML = errorHtml(err);
    }
  }

  function draw() {
    const text = body.querySelector('#f-text').value.toLowerCase();
    const result = body.querySelector('#f-result').value;
    const shown = rows.filter((r) => {
      if (result === 'denied' && !(r.status === 403 || /failed/i.test(r.action))) return false;
      if (result === 'error' && !(r.status >= 400)) return false;
      return !text || `${r.user} ${r.action} ${r.server || ''} ${r.target || ''} ${r.ip || ''}`.toLowerCase().includes(text);
    });
    body.querySelector('#rows').innerHTML = `<div class="table-wrap" style="max-height:65vh"><table>
      <thead><tr><th>When</th><th>Who</th><th>What</th><th>Server</th><th>Result</th></tr></thead>
      <tbody>${shown
        .map(
          (r) => `<tr><td class="small">${fmtDate(Date.parse(r.at))}</td><td><b>${esc(r.user)}</b><div class="small muted mono">${esc(r.ip || '')}</div></td>
          <td class="mono small">${esc(r.action)}${r.target ? `<div class="muted">${esc(r.target)}</div>` : ''}</td>
          <td class="small">${esc(r.server || '')}</td>
          <td>${
            r.status
              ? `<span class="badge ${r.status < 400 ? 'ok' : 'bad'}">${r.status < 400 ? 'ok' : r.status === 403 ? 'denied' : 'error'}</span>`
              : /failed/i.test(r.action)
                ? '<span class="badge bad">failed</span>'
                : ''
          }</td></tr>`,
        )
        .join('') || '<tr><td colspan="5" class="empty">Nothing matches</td></tr>'}</tbody></table></div>`;
  }

  onAction(el, { refresh: () => (info ? fetchRows() : load()) });
  load();
}
