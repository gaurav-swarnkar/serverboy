import { api, esc, fmtBytes, fmtDuration, run, confirmDialog, showJob, onAction, errorHtml, toast, can } from '../ui.js';
import { mountHealth } from './health-card.js';

function pct(used, total) {
  return total ? Math.round((used / total) * 100) : 0;
}

function bar(p) {
  return `<div class="bar ${p > 90 ? 'bad' : p > 75 ? 'warn' : ''}"><span style="width:${p}%"></span></div>`;
}

export async function render(el, { server }) {
  const base = `/servers/${server.id}`;
  el.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(server.name)}</h1><div class="sub mono">${esc(server.username)}@${esc(server.host)}</div></div>
      <div class="row">
        ${can('system') ? `<button data-action="update">Update all packages</button>
        <button class="btn-danger" data-action="reboot">Reboot</button>` : ''}
      </div>
    </div>
    <div id="health"></div>
    <div id="stats"><div class="loading"><span class="spinner"></span>Connecting to ${esc(server.host)}…</div></div>`;
  const stopHealth = mountHealth(el.querySelector('#health'), server);

  const statsEl = el.querySelector('#stats');
  let timer = null;
  let stopped = false;
  // Once per visit: how much can be freed and what looks unused (Disk & cleanup page).
  let diskHint = '';
  if (can('system')) {
    api(`${base}/storage`)
      .then((r) => {
        const free = r.cleanups.filter((c) => !['pm2-logs', 'docker'].includes(c.id)).reduce((t, c) => t + c.bytes, 0);
        const unused = r.apps.filter((a) => a.state === 'unused');
        const bits = [free > 50 * 1024 * 1024 ? `about <b>${fmtBytes(free)}</b> can be freed safely` : '', unused.length ? `<b>${unused.length}</b> installed app(s) look unused (${unused.map((a) => esc(a.name)).join(', ')})` : ''].filter(Boolean);
        diskHint = `${bits.length ? `${bits.join(' · ')} · ` : 'Nothing to clean up. '}<a href="#/s/${server.id}/storage">Disk & cleanup →</a>`;
        const h = el.querySelector('#disk-hint');
        if (h) h.innerHTML = diskHint;
      })
      .catch(() => {});
  }

  async function load() {
    try {
      const s = await api(`${base}/stats`);
      if (stopped) return;
      const memP = pct(s.memory.used, s.memory.total);
      const swapP = pct(s.swap.used, s.swap.total);
      const root = s.disks.find((d) => d.mount === '/') || s.disks[0];
      const rootP = root ? pct(root.used, root.size) : 0;
      statsEl.innerHTML = `
        ${s.rebootRequired ? '<div class="notice warn">Updates were installed that need a reboot to take effect.</div>' : ''}
        <div class="grid grid-4">
          <div class="card stat"><div class="label">CPU</div><div class="value">${s.cpuPercent}%</div>${bar(s.cpuPercent)}<div class="small muted" style="margin-top:6px">${s.cpus} cores · load ${s.load.map((l) => l.toFixed(2)).join(' ')}</div></div>
          <div class="card stat"><div class="label">Memory</div><div class="value">${memP}%</div>${bar(memP)}<div class="small muted" style="margin-top:6px">${fmtBytes(s.memory.used)} of ${fmtBytes(s.memory.total)}${s.swap.total ? ` · swap ${swapP}%` : ' · no swap'}</div></div>
          <div class="card stat"><div class="label">Disk (/)</div><div class="value">${rootP}%</div>${bar(rootP)}<div class="small muted" style="margin-top:6px">${root ? `${fmtBytes(root.used)} of ${fmtBytes(root.size)}` : ''}</div></div>
          <div class="card stat"><div class="label">Uptime</div><div class="value">${fmtDuration(s.uptimeSeconds)}</div><div class="small muted">${esc(s.hostname)}</div></div>
        </div>
        <div class="grid grid-2" style="margin-top:16px">
          <div class="card">
            <h2>System</h2>
            <table><tbody>
              <tr><td class="muted">OS</td><td>${esc(s.os)}</td></tr>
              <tr><td class="muted">Kernel</td><td class="mono">${esc(s.kernel)}</td></tr>
              <tr><td class="muted">CPU</td><td>${esc(s.cpuModel)}</td></tr>
              <tr><td class="muted">IP addresses</td><td class="mono">${s.ips.map(esc).join('<br>')}<br><span class="muted">public: ${esc(server.host)}</span></td></tr>
            </tbody></table>
            <h3 style="margin-top:16px">Disks</h3>
            <table><tbody>
              ${s.disks.map((d) => `<tr><td class="mono">${esc(d.mount)}</td><td style="width:45%">${bar(pct(d.used, d.size))}</td><td class="small muted">${fmtBytes(d.used)} / ${fmtBytes(d.size)}</td></tr>`).join('')}
            </tbody></table>
            ${can('system') ? `<div id="disk-hint" class="small" style="margin-top:8px">${diskHint || '<a href="#/s/' + server.id + '/storage">What is using the space? →</a>'}</div>` : ''}
          </div>
          <div class="card flush">
            <div class="card-head"><h2>Top processes</h2><span class="small muted">refreshes every 5s</span></div>
            <div class="table-wrap"><table>
              <thead><tr><th>PID</th><th>User</th><th>CPU</th><th>Mem</th><th>Command</th><th></th></tr></thead>
              <tbody>${s.processes
                .map(
                  (p) => `<tr><td class="mono">${p.pid}</td><td>${esc(p.user)}</td><td>${p.cpu}%</td><td>${fmtBytes(p.rss)}</td><td class="mono">${esc(p.command)}</td>
                  <td class="actions">${can('system') ? `<button class="btn-sm btn-danger" data-action="kill" data-pid="${p.pid}" data-name="${esc(p.command)}">Kill</button>` : ''}</td></tr>`,
                )
                .join('')}</tbody>
            </table></div>
          </div>
        </div>`;
    } catch (err) {
      if (!stopped) statsEl.innerHTML = errorHtml(err);
    }
    if (!stopped) timer = setTimeout(load, 5000);
  }
  load();

  onAction(el, {
    update: async () => {
      if (!(await confirmDialog('Download and install all available package updates? This can take a few minutes.'))) return;
      const job = await api(`${base}/system-update`, { method: 'POST' }).catch((e) => toast(e.message, 'error'));
      if (job) showJob(server.id, job);
    },
    reboot: async (_d, btn) => {
      if (!(await confirmDialog('Reboot the server now? Websites and apps will be offline for a minute or two.', { danger: true, confirmLabel: 'Reboot' }))) return;
      await run(btn, () => api(`${base}/reboot`, { method: 'POST' }), 'Rebooting… the dashboard reconnects automatically.');
    },
    kill: async ({ pid, name }, btn) => {
      if (!(await confirmDialog(`Stop process ${pid} (${name})?`, { danger: true, confirmLabel: 'Kill' }))) return;
      await run(btn, () => api(`${base}/processes/${pid}/kill`, { method: 'POST', body: {} }), 'Signal sent');
    },
  });

  return () => {
    stopped = true;
    clearTimeout(timer);
    stopHealth();
  };
}
