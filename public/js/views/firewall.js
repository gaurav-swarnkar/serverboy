import { api, esc, run, confirmDialog, onAction, loadingHtml, errorHtml } from '../ui.js';

const PRESETS = [
  ['OpenSSH', 'SSH'],
  ['80', 'HTTP'],
  ['443', 'HTTPS'],
];

export async function render(el, { server }) {
  const base = `/servers/${server.id}/firewall`;

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Firewall</h1><div class="sub">Control which ports are reachable on the server (UFW).</div></div>
      <button data-action="refresh">↻</button>
    </div>
    <div class="notice warn">Azure has its own firewall too: the VM's <b>Network Security Group</b>. A port must be open in <b>both</b> places (Azure Portal → VM → Networking → Add inbound port rule) to be reachable from the internet.</div>
    <div id="fw">${loadingHtml()}</div>`;

  const fw = el.querySelector('#fw');

  async function load() {
    try {
      const s = await api(base);
      if (!s.installed) {
        fw.innerHTML = `<div class="card empty">UFW is not installed. <a href="#/s/${server.id}/apps">Install it from the App Store</a>.</div>`;
        return;
      }
      fw.innerHTML = `
        <div class="card" style="margin-bottom:16px"><div class="row">
          <span>Status: ${s.active ? '<span class="badge ok">active</span>' : '<span class="badge warn">inactive</span>'}</span>
          <span class="grow"></span>
          ${s.active ? '<button class="btn-danger" data-action="state" data-state="disable">Turn off</button>' : '<button class="btn-primary" data-action="state" data-state="enable">Turn on</button>'}
        </div>
        ${s.active ? '' : `<p class="small muted" style="margin:8px 0 0">Turning on blocks every incoming port except the rules below. Your SSH port (${server.port}) is always allowed first so you cannot lock yourself out.</p>`}
        </div>
        <div class="grid grid-2" style="align-items:start">
          <div class="card flush">
            <div class="card-head"><h2>Rules</h2></div>
            <table><thead><tr><th>#</th><th>Port / app</th><th>Action</th><th>From</th><th></th></tr></thead><tbody>
              ${s.rules.map((r) => `<tr><td>${r.num}</td><td class="mono">${esc(r.to)}</td><td><span class="badge ${r.action === 'ALLOW' ? 'ok' : 'bad'}">${esc(r.action)} ${esc(r.direction)}</span></td><td class="mono small">${esc(r.from)}</td>
                <td class="actions"><button class="btn-sm btn-danger" data-action="del" data-num="${r.num}" data-to="${esc(r.to)}">Delete</button></td></tr>`).join('')}
              ${s.rules.length ? '' : `<tr><td colspan="5" class="empty">${s.active ? 'No rules' : 'Rules appear here once the firewall is on'}</td></tr>`}
            </tbody></table>
          </div>
          <div class="card">
            <h2>Add rule</h2>
            <div class="row" style="margin-bottom:12px">${PRESETS.map(([port, label]) => `<button class="btn-sm" data-action="preset" data-port="${port}">Allow ${label}</button>`).join('')}</div>
            <form id="rule-form">
              <div class="form-grid">
                <label class="field"><span>Port</span><input name="port" placeholder="3000 or 8000:8100" required></label>
                <label class="field"><span>Protocol</span><select name="proto"><option>tcp</option><option>udp</option><option value="any">tcp + udp</option></select></label>
                <label class="field"><span>Action</span><select name="action"><option value="allow">Allow</option><option value="deny">Deny</option><option value="limit">Limit (rate-limit, for SSH)</option></select></label>
                <label class="field"><span>Only from IP (optional)</span><input name="from" placeholder="203.0.113.5"></label>
              </div>
              <button class="btn-primary">Add rule</button>
            </form>
          </div>
        </div>`;
      fw.querySelector('#rule-form').addEventListener('submit', async (e) => {
        const f = e.target;
        const body = { port: f.port.value.trim(), proto: f.proto.value, action: f.action.value, from: f.from.value.trim() };
        await run(f.querySelector('button'), () => api(`${base}/rule`, { method: 'POST', body }), 'Rule added');
        load();
      });
    } catch (err) {
      fw.innerHTML = errorHtml(err);
    }
  }

  onAction(el, {
    refresh: load,
    state: async ({ state }, btn) => {
      if (state === 'disable' && !(await confirmDialog('Turn off the firewall? All ports will be reachable (subject to the Azure NSG).', { danger: true, confirmLabel: 'Turn off' }))) return;
      await run(btn, () => api(`${base}/${state}`, { method: 'POST' }), `Firewall ${state}d`);
      load();
    },
    preset: async ({ port }, btn) => {
      await run(btn, () => api(`${base}/rule`, { method: 'POST', body: { port, proto: 'tcp', action: 'allow' } }), 'Rule added');
      load();
    },
    del: async ({ num, to }, btn) => {
      if (!(await confirmDialog(`Delete rule #${num} (${to})?`, { danger: true, confirmLabel: 'Delete' }))) return;
      await run(btn, () => api(`${base}/rule/${num}`, { method: 'DELETE' }), 'Rule deleted');
      load();
    },
  });

  load();
}
