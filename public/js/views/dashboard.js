import { api, esc, fmtBytes, fmtDuration, run, confirmDialog, showJob, onAction, errorHtml, toast, can } from '../ui.js';
import { mountHealth } from './health-card.js';
import { icon } from '../icons.js';

const HISTORY = 36; // samples kept for the live chart (one every 5 s)

const pct = (used, total) => (total ? Math.round((used / total) * 100) : 0);

// Mirrored bars like a cash-flow chart: CPU above the line, memory below. Drawn at the card's
// real pixel width (never stretched), with faint placeholders for slots not filled yet.
function usageChart(samples, width) {
  const W = Math.max(300, Math.round(width || 640));
  const H = 240;
  const left = 40;
  const top = 10;
  const mid = 108;
  const half = mid - top - 4;
  const n = Math.max(10, Math.min(HISTORY, Math.floor((W - left) / 34)));
  const shown = samples.slice(-n);
  const slot = (W - left) / n;
  const bw = Math.max(8, Math.min(26, slot * 0.56));
  const rx = Math.min(7, bw / 2);
  const yUp = (v) => mid - 3 - (v / 100) * half;
  const yDown = (v) => mid + 3 + (v / 100) * half;
  const grid = [
    [100, yUp(100)],
    [50, yUp(50)],
    [0, mid],
    [50, yDown(50)],
    [100, yDown(100)],
  ]
    .map(([v, y]) => `<line x1="${left}" x2="${W}" y1="${y}" y2="${y}" class="ch-grid"/><text x="${left - 8}" y="${y + 4}" text-anchor="end" class="ch-label">${v}%</text>`)
    .join('');
  let cols = '';
  for (let i = 0; i < n; i++) {
    const x = left + i * slot + (slot - bw) / 2;
    const smp = shown[i - (n - shown.length)];
    if (!smp) {
      cols += `<rect x="${x}" y="${yUp(100)}" width="${bw}" height="${half}" rx="${rx}" class="ch-track"/><rect x="${x}" y="${mid + 3}" width="${bw}" height="${half}" rx="${rx}" class="ch-track"/>`;
      continue;
    }
    const c = Math.max(3, (smp.cpu / 100) * half);
    const m = Math.max(3, (smp.mem / 100) * half);
    const label = new Date(smp.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const showTime = (n - 1 - i) % Math.max(1, Math.round(n / 6)) === 0;
    cols += `<g class="ch-col"><title>${label}\nCPU ${smp.cpu}%\nMemory ${smp.mem}%</title>
      <rect x="${x - (slot - bw) / 2}" y="${top}" width="${slot}" height="${H - top - 22}" class="ch-hit"/>
      <rect x="${x}" y="${mid - 3 - c}" width="${bw}" height="${c}" rx="${rx}" class="ch-a"/>
      <rect x="${x}" y="${mid + 3}" width="${bw}" height="${m}" rx="${rx}" class="ch-b"/>
      ${showTime ? `<text x="${Math.min(x + bw / 2, W - 2)}" y="${H - 4}" text-anchor="${x + bw / 2 > W - 36 ? 'end' : 'middle'}" class="ch-label">${label.replace(/:\d\d(?=\s*[AP]M|$)/i, '')}</text>` : ''}</g>`;
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="chart">${grid}${cols}</svg>`;
}

// Donut of the main disk: used vs free.
function donut(used, size) {
  const p = size ? used / size : 0;
  const r = 52;
  const c = 2 * Math.PI * r;
  // Round ends only look right on a longer arc.
  return `<svg viewBox="0 0 140 140" class="donut"><circle cx="70" cy="70" r="${r}" class="dn-free"/><circle cx="70" cy="70" r="${r}" class="dn-used" stroke-linecap="${p > 0.08 ? 'round' : 'butt'}" stroke-dasharray="${Math.max(c * p, 2)} ${c}" transform="rotate(-90 70 70)"/></svg>`;
}

function scoreOf(report) {
  const bad = report.problems.filter((p) => p.level === 'bad').length;
  const warn = report.problems.length - bad;
  const score = Math.max(0, Math.min(100, 100 - bad * 25 - warn * 8));
  const word = score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 50 ? 'Fair' : 'Needs attention';
  return { score, word, bad, warn };
}

export async function render(el, { server }) {
  const base = `/servers/${server.id}`;
  const samples = [];
  el.innerHTML = `
    <div class="page-head"><div><h1>Dashboard</h1><div class="sub">${esc(server.name)} · <span class="mono">${esc(server.username)}@${esc(server.host)}</span></div></div></div>
    <div class="dash">
      <div class="dash-row r1">
        <div class="card hero">
          <div class="row"><span class="small muted grow">Server status</span><a class="hero-plus" href="#/s/${server.id}/jobs" title="Tasks">${icon('list', 18)}</a></div>
          <div class="hero-value" id="d-status">Checking…</div>
          <div class="small muted" id="d-status-sub">${esc(server.name)}</div>
          <div class="row hero-actions">
            ${can('terminal') ? `<a class="btn" href="#/s/${server.id}/terminal">${icon('terminal', 16)} Terminal</a>` : ''}
            ${can('sites') ? `<a class="btn btn-primary" href="#/s/${server.id}/sites">Websites ${icon('arrow', 15)}</a>` : `<a class="btn btn-primary" href="#/s/${server.id}/jobs">Tasks ${icon('arrow', 15)}</a>`}
          </div>
        </div>
        <div class="card">
          <div class="row" style="margin-bottom:12px"><h3 class="grow" style="margin:0">Resources</h3><span class="badge"><span class="live-dot"></span> live · every 5 s</span></div>
          <div class="mini-grid" id="d-res">${['CPU', 'Memory', 'Disk'].map((l) => `<div class="mini"><div class="row"><span class="chip-ico">${icon(l === 'CPU' ? 'cpu' : l === 'Memory' ? 'memory' : 'drive', 18)}</span><span class="small muted">${l}</span></div><div class="mini-value">–</div><div class="small muted mini-sub">&nbsp;</div></div>`).join('')}</div>
        </div>
        <div class="card score-card">
          <div class="row" style="margin-bottom:6px"><h3 class="grow" style="margin:0">Server health</h3>${can('services') ? `<a class="icon-btn sm" href="#/s/${server.id}/services" title="Services">${icon('sliders', 16)}</a>` : ''}</div>
          <div class="small muted">Health score</div>
          <div class="row score-line"><b id="d-word">…</b><span class="grow"></span><b id="d-score"></b></div>
          <div class="score-bar"><span id="d-score-bar" style="width:0%"></span><span class="rest"></span></div>
          <div class="small muted" id="d-score-sub" style="margin-top:8px">Checking services and websites…</div>
        </div>
      </div>
      <div class="dash-row r2">
        <div class="card">
          <div class="row"><h3 class="grow" style="margin:0">Live usage</h3><span class="legend"><i class="lg-a"></i>CPU <i class="lg-b"></i>Memory</span></div>
          <div class="small muted" style="margin-top:8px">Load average</div>
          <div class="big-value" id="d-load">–</div>
          <div id="d-chart" class="chart-box"></div>
        </div>
        <div class="card">
          <div class="row" style="margin-bottom:8px"><h3 class="grow" style="margin:0">Disks</h3>${can('system') ? `<a class="btn btn-sm" href="#/s/${server.id}/storage">Clean up</a>` : ''}</div>
          <div id="d-disks"></div>
        </div>
      </div>
      <div id="health"></div>
      <div class="dash-row r3">
        <div class="card flush">
          <div class="card-head"><h3>Top processes</h3><span class="small muted">by CPU</span></div>
          <div id="d-procs"></div>
        </div>
        <div class="card">
          <div class="row" style="margin-bottom:8px"><h3 class="grow" style="margin:0">System</h3></div>
          <div id="d-system"></div>
        </div>
      </div>
    </div>`;
  const $ = (id) => el.querySelector(`#${id}`);
  const drawChart = () => {
    const box = $('d-chart');
    if (box) box.innerHTML = usageChart(samples, box.clientWidth);
  };
  const resize = new ResizeObserver(() => drawChart());
  resize.observe($('d-chart'));

  const stopHealth = mountHealth($('health'), server, {
    onData: (report) => {
      const s = scoreOf(report);
      $('d-word').textContent = s.word;
      $('d-score').textContent = `${s.score}%`;
      $('d-score-bar').style.width = `${s.score}%`;
      $('d-score-sub').textContent = s.bad || s.warn ? `${s.bad ? `${s.bad} problem${s.bad > 1 ? 's' : ''}` : ''}${s.bad && s.warn ? ' · ' : ''}${s.warn ? `${s.warn} warning${s.warn > 1 ? 's' : ''}` : ''} · see Health below` : 'All services and websites answer.';
      $('d-status').textContent = s.bad ? `${s.bad} problem${s.bad > 1 ? 's' : ''}` : s.warn ? 'Running, with warnings' : 'All good';
    },
  });

  let timer = null;
  let stopped = false;
  let diskHint = '';
  if (can('system')) {
    api(`${base}/storage`)
      .then((r) => {
        const free = r.cleanups.filter((c) => !['pm2-logs', 'docker'].includes(c.id)).reduce((t, c) => t + c.bytes, 0);
        const unused = r.apps.filter((a) => a.state === 'unused');
        const bits = [free > 50 * 1024 * 1024 ? `<b>${fmtBytes(free)}</b> can be freed` : '', unused.length ? `<b>${unused.length}</b> app(s) look unused` : ''].filter(Boolean);
        diskHint = bits.length ? `${bits.join(' · ')} · <a href="#/s/${server.id}/storage">Review</a>` : 'Nothing to clean up.';
        const h = $('disk-hint');
        if (h) h.innerHTML = diskHint;
      })
      .catch(() => {});
  }

  function draw(s) {
    const memP = pct(s.memory.used, s.memory.total);
    const root = s.disks.find((d) => d.mount === '/') || s.disks[0];
    const rootP = root ? pct(root.used, root.size) : 0;
    samples.push({ at: Date.now(), cpu: s.cpuPercent, mem: memP });
    if (samples.length > HISTORY) samples.shift();

    $('d-status-sub').textContent = `${s.hostname} · up ${fmtDuration(s.uptimeSeconds)}${s.rebootRequired ? ' · reboot needed' : ''}`;
    const tone = (p) => (p > 90 ? 'bad' : p > 75 ? 'warn' : '');
    const minis = [
      [`${s.cpuPercent}%`, `${s.cpus} cores`, tone(s.cpuPercent)],
      [`${memP}%`, `${fmtBytes(s.memory.used)} of ${fmtBytes(s.memory.total)}`, tone(memP)],
      [`${rootP}%`, root ? `${fmtBytes(root.used)} of ${fmtBytes(root.size)}` : '', tone(rootP)],
    ];
    el.querySelectorAll('#d-res .mini').forEach((m, i) => {
      m.querySelector('.mini-value').innerHTML = `${minis[i][0]} ${minis[i][2] ? `<span class="delta ${minis[i][2]}">${minis[i][2] === 'bad' ? 'high' : 'busy'}</span>` : ''}`;
      m.querySelector('.mini-sub').textContent = minis[i][1];
    });
    $('d-load').innerHTML = `${s.load[0].toFixed(2)} <span class="small muted">· 5 min ${s.load[1].toFixed(2)} · 15 min ${s.load[2].toFixed(2)}</span>`;
    drawChart();

    $('d-procs').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Process</th><th>PID</th><th>CPU</th><th>Memory</th><th></th></tr></thead>
      <tbody>${s.processes
        .slice(0, 8)
        .map(
          (p) => `<tr><td><b class="mono">${esc(p.command.split(/\s+/)[0].split('/').pop())}</b><div class="small muted">${esc(p.user)}</div></td>
            <td class="mono small">${p.pid}</td>
            <td><span class="badge ${p.cpu > 50 ? 'bad' : p.cpu > 15 ? 'warn' : 'ok'}">${p.cpu}%</span></td>
            <td class="small">${fmtBytes(p.rss)}</td>
            <td class="actions">${can('system') ? `<button class="btn-sm btn-danger" data-action="kill" data-pid="${p.pid}" data-name="${esc(p.command)}">Stop</button>` : ''}</td></tr>`,
        )
        .join('')}</tbody></table></div>`;

    $('d-disks').innerHTML = root
      ? `<div class="donut-wrap">${donut(root.used, root.size)}<div class="donut-center"><span class="small muted">Used on /</span><b>${fmtBytes(root.used)}</b><span class="small muted">of ${fmtBytes(root.size)}</span></div></div>
        <div class="disk-list">${s.disks
          .map((d) => `<div class="row"><span class="pct-chip ${d === root ? 'dark' : ''}">${pct(d.used, d.size)}%</span><span class="mono grow">${esc(d.mount)}</span><span class="small">${fmtBytes(d.used)}</span></div>`)
          .join('')}</div>
        ${can('system') ? `<div id="disk-hint" class="small muted" style="margin-top:8px">${diskHint}</div>` : ''}`
      : '';

    $('d-system').innerHTML = `<div class="sys-box">
        <div class="row"><span class="small muted grow">OS</span><span class="small">${esc(s.os)}</span></div>
        <div class="row"><span class="small muted grow">Kernel</span><span class="mono small">${esc(s.kernel)}</span></div>
        <div class="row"><span class="small muted grow">CPU</span><span class="small" style="text-align:right">${esc(s.cpuModel)}</span></div>
        <div class="row"><span class="small muted grow">IP</span><span class="mono small" style="text-align:right">${s.ips.map(esc).join('<br>')}</span></div>
        <div class="row"><span class="small muted grow">Swap</span><span class="small">${s.swap.total ? `${pct(s.swap.used, s.swap.total)}% of ${fmtBytes(s.swap.total)}` : 'none'}</span></div>
      </div>
      ${s.rebootRequired ? '<div class="notice warn small" style="margin:10px 0 0">Updates need a reboot to take effect.</div>' : ''}
      ${can('system') ? `<button class="btn-accent btn-block" data-action="update">${icon('refresh', 16)} Update all packages</button><button class="btn-danger btn-block" data-action="reboot">${icon('power', 16)} Reboot</button>` : ''}`;
  }

  async function load() {
    try {
      const s = await api(`${base}/stats`);
      if (!stopped) draw(s);
    } catch (err) {
      if (!stopped) $('d-procs').innerHTML = errorHtml(err);
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
      if (!(await confirmDialog(`Stop process ${pid} (${name})?`, { danger: true, confirmLabel: 'Stop' }))) return;
      await run(btn, () => api(`${base}/processes/${pid}/kill`, { method: 'POST', body: {} }), 'Signal sent');
    },
  });

  return () => {
    stopped = true;
    resize.disconnect();
    clearTimeout(timer);
    stopHealth();
  };
}
