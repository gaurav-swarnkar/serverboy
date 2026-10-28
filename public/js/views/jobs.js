import { api, esc, showJob, statusBadge, onAction, fmtDate } from '../ui.js';

export async function render(el, { server }) {
  const jobs = await api(`/servers/${server.id}/jobs`);
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Tasks</h1><div class="sub">Installs, deployments and other background tasks since Serverboy was started.</div></div>
    </div>
    <div class="card flush"><table>
      <thead><tr><th>Task</th><th>Status</th><th>Started</th><th>Finished</th><th></th></tr></thead>
      <tbody>${jobs
        .map(
          (j) => `<tr><td>${esc(j.title)}</td><td>${statusBadge(j.status)}</td><td class="small">${fmtDate(Date.parse(j.startedAt))}</td><td class="small">${j.endedAt ? fmtDate(Date.parse(j.endedAt)) : ''}</td>
          <td class="actions"><button class="btn-sm" data-action="view" data-id="${j.id}">View log</button></td></tr>`,
        )
        .join('')}
      ${jobs.length ? '' : '<tr><td colspan="5" class="empty">No tasks yet</td></tr>'}
      </tbody></table></div>`;
  onAction(el, {
    view: ({ id }) => showJob(server.id, jobs.find((j) => j.id === id), { onDone: () => render(el, { server }) }),
  });
}
