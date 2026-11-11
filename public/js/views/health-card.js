// Dashboard health card: essential services, websites, Node apps, with diagnosis and fixes.
import { api, esc, toast, modal, confirmDialog, loadingHtml, errorHtml, can, onAction } from '../ui.js';

const DOT = { ok: '<i class="dot ok"></i>', warn: '<i class="dot warn"></i>', bad: '<i class="dot bad"></i>', off: '<i class="dot"></i>' };
const REFRESH_MS = 60 * 1000;

function since(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// onData(report) is called after each check (the dashboard's score card uses it).
export function mountHealth(el, server, { onData } = {}) {
  const base = `/servers/${server.id}`;
  let timer = null;
  let stopped = false;
  let data = null;

  el.innerHTML = `<div class="card health-card">${loadingHtml('Checking services and websites…')}</div>`;
  const card = el.querySelector('.health-card');

  async function load() {
    clearTimeout(timer);
    try {
      data = await api(`${base}/health`);
      if (!stopped) draw();
      if (!stopped) onData?.(data);
    } catch (err) {
      if (!stopped) card.innerHTML = `<h2>Health</h2>${errorHtml(err)}`;
    }
    if (!stopped) timer = setTimeout(load, REFRESH_MS);
  }

  function draw() {
    const d = data;
    const bad = d.problems.filter((p) => p.level === 'bad').length;
    const warn = d.problems.length - bad;
    const headline =
      d.status === 'ok'
        ? '<span class="badge ok">All systems OK</span>'
        : `<span class="badge ${bad ? 'bad' : 'warn'}">${bad ? `${bad} problem${bad > 1 ? 's' : ''}` : ''}${bad && warn ? ' · ' : ''}${warn ? `${warn} warning${warn > 1 ? 's' : ''}` : ''}</span>`;
    card.innerHTML = `
      <div class="row" style="margin-bottom:10px">
        <h2 style="margin:0">Health</h2>${headline}
        <span class="grow"></span>
        <span class="small muted">checked ${new Date(d.checkedAt).toLocaleTimeString()}</span>
        <button class="btn-sm" data-action="hc-refresh">↻ Check now</button>
      </div>
      ${
        d.problems.length
          ? `<div class="hc-problems">${d.problems
              .map(
                (p) => `<div class="hc-problem ${p.level}">
                  <span>${DOT[p.level]}</span>
                  <div class="grow"><b>${esc(p.text)}</b>${p.hint ? `<div class="small muted">${esc(p.hint)}</div>` : ''}</div>
                  ${problemAction(p)}
                  ${can('services') ? `<button class="btn-sm btn-ghost" data-action="hc-ignore" data-key="${esc(p.key)}" data-text="${esc(p.text)}" data-level="${p.level}" title="Stop showing this warning">Ignore</button>` : ''}
                </div>`,
              )
              .join('')}</div>`
          : ''
      }
      ${
        (d.ignored || []).length
          ? `<details class="hc-ignored"><summary class="small muted">${d.ignored.length} ignored warning${d.ignored.length > 1 ? 's' : ''}</summary>${d.ignored
              .map(
                (p) => `<div class="hc-problem ignored"><span>${DOT[p.level]}</span><div class="grow"><span>${esc(p.text)}</span><div class="small muted">Ignored ${p.until ? `until ${new Date(p.until).toLocaleDateString()}` : 'always'}${p.ignoredBy ? ` by ${esc(p.ignoredBy)}` : ''}</div></div>${can('services') ? `<button class="btn-sm" data-action="hc-unignore" data-key="${esc(p.key)}">Stop ignoring</button>` : ''}</div>`,
              )
              .join('')}</details>`
          : ''
      }
      <div class="hc-grid">
        ${d.services
          .map(
            (s) => `<div class="hc-tile ${s.state}" title="${esc(s.why)}">
              <div class="row"><span>${DOT[s.state]}</span><b class="grow">${esc(s.name)}</b></div>
              <div class="small muted">${s.state === 'ok' ? `running · up ${since(s.since)}` : s.state === 'off' ? 'not used (off)' : esc(`${s.active} (${s.sub})`)}</div>
              <div class="row hc-actions">
                ${can('services') ? `<button class="btn-sm btn-ghost" data-action="hc-diagnose" data-unit="${esc(s.unit)}">Diagnose</button>` : ''}
                ${can('services') && s.state !== 'off' && s.unit !== 'serverboy' && s.unit !== 'ssh' ? `<button class="btn-sm btn-ghost" data-action="hc-fix" data-fix="${s.state === 'ok' ? 'restart' : 'start'}" data-unit="${esc(s.unit)}">${s.state === 'ok' ? 'Restart' : 'Start'}</button>` : ''}
              </div>
            </div>`,
          )
          .join('')}
      </div>
      ${
        d.sites.length
          ? `<h3 style="margin:16px 0 6px">Websites</h3>
            <div class="table-wrap" style="max-height:none"><table><tbody>${d.sites
              .map(
                (s) => `<tr>
                  <td style="width:28px">${s.ignored ? DOT.off || '⚪' : DOT[s.level]}</td>
                  <td><a href="${s.ssl ? 'https' : 'http'}://${esc(s.domain)}" target="_blank" rel="noopener">${esc(s.domain)}</a></td>
                  <td class="small">${s.code ? `HTTP ${s.code}` : 'no answer'}${s.ms ? ` · ${s.ms} ms` : ''}</td>
                  <td class="small">${s.ssl ? (s.certDays !== null ? `🔒 ${s.certDays} days left` : '🔒') : '<span class="muted">no SSL</span>'}</td>
                  <td class="small">${s.apiOnly ? '<span class="badge">API address</span> ' : ''}${esc(s.apiOnly ? 'no home page, which is fine' : s.text)}${s.ignored ? ' <span class="muted">(ignored)</span>' : ''}</td>
                </tr>`,
              )
              .join('')}</tbody></table></div>`
          : ''
      }
      ${
        d.apps.length
          ? `<h3 style="margin:16px 0 6px">Node apps</h3>
            <div class="row">${d.apps
              .map((a) => `<span class="badge ${a.status === 'online' ? (a.restarts > 10 ? 'warn' : 'ok') : 'bad'}">${esc(a.name)}: ${esc(a.status)}${a.restarts ? ` · ${a.restarts} restarts` : ''}</span>`)
              .join(' ')}
            ${can('nodeapps') ? `<a class="small" href="#/s/${server.id}/nodeapps">Manage →</a>` : ''}</div>`
          : ''
      }`;
  }

  function problemAction(p) {
    if (p.area === 'service' && can('services')) return `<button class="btn-sm" data-action="hc-diagnose" data-unit="${esc(p.target)}">Diagnose</button>`;
    if (p.area === 'site' && p.target === 'nginx' && can('services')) return '<button class="btn-sm" data-action="hc-diagnose" data-unit="nginx">Diagnose</button>';
    if (p.area === 'site' && can('sites')) return `<a class="btn btn-sm" href="#/s/${server.id}/sites">Websites</a>`;
    if (p.area === 'backup' && can('owner')) return `${p.dismiss === 'local-only' ? '<button class="btn-sm btn-ghost" data-action="hc-local-ok" title="Keep backups on this server only and stop showing this warning">Don\'t warn me</button>' : ''}<a class="btn btn-sm" href="#/s/${server.id}/backups">Backups</a>`;
    if (p.area === 'app' && can('nodeapps')) return `<a class="btn btn-sm" href="#/s/${server.id}/nodeapps">Node Apps</a>`;
    if (p.fix && can('system')) return `<button class="btn-sm" data-action="hc-fix" data-fix="${p.fix}">${p.fix === 'cleanup' ? 'Free space' : 'Add swap'}</button>`;
    return '';
  }

  async function applyFix(fix, unit, label) {
    const r = await api(`${base}/health/fix`, { method: 'POST', body: { fix, unit } });
    if (unit) toast(`${label || fix}: ${unit} is now ${r.active}`, r.active === 'active' ? 'ok' : 'error');
    else toast(r.ok ? `${label || fix}: done` : `${label || fix} failed`, r.ok ? 'ok' : 'error');
    load();
    return r;
  }

  async function diagnose(unit) {
    const m = modal({ title: `Diagnose: ${unit}`, wide: true, body: loadingHtml('Reading status and logs…'), actions: [{ label: 'Close' }] });
    let d;
    try {
      d = await api(`${base}/health/diagnose/${encodeURIComponent(unit)}`);
    } catch (err) {
      m.body.innerHTML = errorHtml(err);
      return;
    }
    const out = d.output;
    m.body.innerHTML = `
      <div class="row" style="margin-bottom:12px"><span>Status:</span><span class="badge ${d.active === 'active' ? 'ok' : 'bad'}">${esc(d.active)}</span></div>
      ${
        d.findings.length
          ? `<h3>What we found</h3>${d.findings
              .map(
                (f) => `<div class="notice ${d.active === 'active' ? '' : 'warn'}" style="margin-bottom:10px">
                  <b>${esc(f.title)}</b><div class="small" style="margin-top:4px">${esc(f.detail)}</div>
                  ${
                    f.fix
                      ? can(f.fixPermission)
                        ? `<button class="btn-primary btn-sm" style="margin-top:8px" data-fix="${f.fix}" data-label="${esc(f.fixLabel)}">${esc(f.fixLabel)}</button>`
                        : `<div class="small muted" style="margin-top:6px">Fix: ${esc(f.fixLabel)} (needs the "${esc(f.fixPermission)}" permission; ask the owner).</div>`
                      : ''
                  }
                </div>`,
              )
              .join('')}`
          : '<div class="notice">No known problems found. The service looks healthy.</div>'
      }
      ${out.nginxTest ? `<h3>nginx -t</h3><pre class="log">${esc(out.nginxTest)}</pre>` : ''}
      ${out.mongoLog ? `<h3>MongoDB errors</h3><pre class="log">${esc(out.mongoLog)}</pre>` : ''}
      <details open><summary><b>Recent logs</b></summary><pre class="log" style="max-height:300px">${esc(out.logs || '(no logs)')}</pre></details>
      <details><summary><b>systemctl status</b></summary><pre class="log">${esc(out.status)}</pre></details>
      <details><summary><b>Listening ports</b></summary><pre class="log">${esc(out.ports)}</pre></details>
      <details><summary><b>Disk & memory</b></summary><pre class="log">${esc(out.resources)}</pre></details>`;
    const pre = m.body.querySelector('details[open] pre');
    if (pre) pre.scrollTop = pre.scrollHeight;
    m.body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-fix]');
      if (!b) return;
      if (!(await confirmDialog(`${b.dataset.label}?`, { confirmLabel: 'Yes, do it' }))) return;
      b.disabled = true;
      b.textContent = 'Working…';
      try {
        const r = await applyFix(b.dataset.fix, unit, b.dataset.label);
        m.close();
        if (unit && r.active !== 'active') diagnose(unit);
      } catch (err) {
        toast(err.message, 'error');
        b.disabled = false;
        b.textContent = b.dataset.label;
      }
    });
  }

  onAction(card, {
    'hc-refresh': (_d, btn) => {
      btn.disabled = true;
      load();
    },
    'hc-diagnose': ({ unit }) => diagnose(unit),
    'hc-local-ok': async (_d, btn) => {
      if (!(await confirmDialog('Keep backups only on this server and stop warning about it? If the server is deleted or its disk fails, its backups are lost too. You can add cloud storage later in Backups → Settings, which also brings the warning back.', { confirmLabel: "Don't warn me" }))) return;
      btn.disabled = true;
      try {
        await api(`/servers/${server.id}/backups/local-only`, { method: 'POST', body: { ok: true } });
        toast('OK. Backups stay on this server; the warning is hidden.', 'ok');
        load();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    },
    'hc-ignore': async ({ key, text, level }) => {
      const box = document.createElement('div');
      box.innerHTML = `<p style="margin-top:0">${esc(text)}</p>
        ${level === 'bad' ? '<div class="notice warn" style="margin-bottom:10px">This is a problem, not just a warning. Ignoring it also stops its alerts.</div>' : ''}
        <label class="field"><span>Ignore it</span><select name="days"><option value="7">for 7 days</option><option value="30">for 30 days</option><option value="0">always</option></select></label>
        <p class="small muted" style="margin-bottom:0">It leaves the dashboard and alerts. Bring it back any time under "ignored warnings".</p>`;
      modal({
        title: 'Ignore this warning?',
        body: box,
        actions: [
          { label: 'Cancel' },
          {
            label: 'Ignore',
            className: 'btn-primary',
            onClick: async () => {
              await api(`${base}/health/ignore`, { method: 'POST', body: { key, text, days: Number(box.querySelector('select').value) } });
              toast('Ignored', 'ok');
              load();
            },
          },
        ],
      });
    },
    'hc-unignore': async ({ key }, btn) => {
      btn.disabled = true;
      try {
        await api(`${base}/health/ignore`, { method: 'DELETE', body: { key } });
        toast('Shown again', 'ok');
        load();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    },
    'hc-fix': async ({ fix, unit }, btn) => {
      const label = { restart: 'Restart', start: 'Start', cleanup: 'Free disk space', 'add-swap': 'Add 2 GB swap' }[fix] || fix;
      if (!(await confirmDialog(`${label}${unit ? ` ${unit}` : ''}?`, { confirmLabel: label }))) return;
      btn.disabled = true;
      try {
        await applyFix(fix, unit, label);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    },
  });

  load();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
