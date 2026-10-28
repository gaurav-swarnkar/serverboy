import { api, esc, run, modal, onAction, loadingHtml, errorHtml } from '../ui.js';

export async function render(el, { server }) {
  const base = `/servers/${server.id}`;
  let services = [];
  let filter = '';
  let showAll = false;

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Services</h1><div class="sub">Background programs managed by systemd (web server, databases, etc.).</div></div>
      <div class="row">
        <label class="check" style="margin:0"><input type="checkbox" id="all"> Show inactive</label>
        <input id="filter" placeholder="Search services…" style="width:220px">
        <button data-action="refresh">↻</button>
      </div>
    </div>
    <div class="card flush"><div id="list">${loadingHtml()}</div></div>`;

  const list = el.querySelector('#list');

  async function load() {
    try {
      services = await api(`${base}/services`);
      draw();
    } catch (err) {
      list.innerHTML = errorHtml(err);
    }
  }

  function draw() {
    const rows = services.filter(
      (s) => (showAll || s.active === 'active' || s.active === 'failed') && (!filter || `${s.unit} ${s.description}`.toLowerCase().includes(filter)),
    );
    list.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Service</th><th>Status</th><th>Start on boot</th><th>Description</th><th></th></tr></thead>
      <tbody>${rows
        .map((s) => {
          const name = s.unit.replace(/\.service$/, '');
          const cls = s.active === 'active' ? 'ok' : s.active === 'failed' ? 'bad' : '';
          return `<tr>
            <td class="mono">${esc(name)}</td>
            <td><span class="badge ${cls}">${esc(s.active)} · ${esc(s.sub)}</span></td>
            <td>${s.enabled === 'enabled' ? '<span class="badge ok">yes</span>' : `<span class="badge">${esc(s.enabled || 'n/a')}</span>`}</td>
            <td class="small muted">${esc(s.description)}</td>
            <td class="actions">
              ${s.active === 'active'
                ? `<button class="btn-sm" data-action="svc" data-op="restart" data-name="${esc(s.unit)}">Restart</button>
                   <button class="btn-sm btn-danger" data-action="svc" data-op="stop" data-name="${esc(s.unit)}">Stop</button>`
                : `<button class="btn-sm" data-action="svc" data-op="start" data-name="${esc(s.unit)}">Start</button>`}
              ${s.enabled === 'enabled'
                ? `<button class="btn-sm" data-action="svc" data-op="disable" data-name="${esc(s.unit)}">Disable</button>`
                : s.enabled === 'disabled'
                  ? `<button class="btn-sm" data-action="svc" data-op="enable" data-name="${esc(s.unit)}">Enable</button>`
                  : ''}
              <button class="btn-sm" data-action="logs" data-name="${esc(s.unit)}">Logs</button>
            </td>
          </tr>`;
        })
        .join('')}
      ${rows.length ? '' : '<tr><td colspan="5" class="empty">No matching services</td></tr>'}
      </tbody></table></div>`;
  }

  el.querySelector('#filter').addEventListener('input', (e) => {
    filter = e.target.value.toLowerCase();
    draw();
  });
  el.querySelector('#all').addEventListener('change', (e) => {
    showAll = e.target.checked;
    draw();
  });

  onAction(el, {
    refresh: load,
    svc: async ({ op, name }, btn) => {
      await run(btn, () => api(`${base}/services/${encodeURIComponent(name)}/${op}`, { method: 'POST' }), `${name}: ${op} done`);
      load();
    },
    logs: async ({ name }) => {
      const m = modal({ title: `${name} — status & logs`, wide: true, body: loadingHtml() });
      try {
        const r = await api(`${base}/services/${encodeURIComponent(name)}/logs?lines=300`);
        m.body.innerHTML = `<pre class="log">${esc(r.log)}</pre>`;
        const pre = m.body.querySelector('pre');
        pre.scrollTop = pre.scrollHeight;
      } catch (err) {
        m.body.innerHTML = errorHtml(err);
      }
    },
  });

  load();
}
