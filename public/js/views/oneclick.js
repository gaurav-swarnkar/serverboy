// 1-click apps: install ready-made apps (WordPress, n8n, Uptime Kuma) with Docker, each on its
// own address with HTTPS, included in backups.
import { api, esc, toast, run, modal, confirmDialog, formDialog, showJob, onAction, loadingHtml, errorHtml, fmtBytes, can } from '../ui.js';
import { icon } from '../icons.js';

const suggestedDomain = (name) => (location.hostname.endsWith('.sslip.io') ? `${name}.${location.hostname}` : '');
const STATUS = { running: 'ok', 'partly running': 'warn', restarting: 'warn', stopped: 'bad', unknown: 'bad' };

export async function render(el, { server }) {
  const base = `/servers/${server.id}/docker-apps`;
  el.innerHTML = `<div class="page-head"><div><h1>1-click apps</h1><div class="sub">Ready-made apps installed with Docker, each on its own address with HTTPS, and included in your backups.</div></div>
    <button data-action="refresh">↻</button></div><div id="oc-body">${loadingHtml()}</div>`;
  const body = el.querySelector('#oc-body');
  let data;

  async function load() {
    try {
      data = await api(base);
    } catch (err) {
      body.innerHTML = errorHtml(err);
      return;
    }
    const installed = data.apps;
    body.innerHTML = `
      ${
        data.docker
          ? ''
          : `<div class="notice warn" style="margin-bottom:16px"><b>Docker is not installed on ${esc(server.name)}.</b> 1-click apps run in Docker containers. ${can('system') ? `<a class="btn btn-sm btn-primary" href="#/s/${server.id}/apps">Install Docker from the App Store</a>` : 'Ask the owner to install Docker from the App Store.'}</div>`
      }
      ${
        installed.length
          ? `<div class="card flush" style="margin-bottom:18px"><div class="card-head"><h3 style="margin:0">Installed</h3></div><div class="table-wrap"><table><tbody>${installed
              .map(
                (a, i) => `<tr>
              <td><div class="row" style="gap:10px"><span class="chip-ico">${icon(a.icon || 'package', 18)}</span><div><b>${esc(a.name)}</b><div class="small muted">${esc(a.title || '')} · 127.0.0.1:${esc(a.hostPort || '?')} · data ${fmtBytes(a.size)}</div></div></div></td>
              <td>${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url)}</a>` : '<span class="muted small">no public address (reach it with an SSH tunnel)</span>'}</td>
              <td><span class="badge ${STATUS[a.status] || ''}">${esc(a.status)}</span></td>
              <td class="actions">
                ${a.url ? `<a class="btn btn-sm btn-primary" href="${esc(a.url)}" target="_blank" rel="noopener">Open</a>` : ''}
                ${a.status === 'running' ? `<button class="btn-sm" data-action="act" data-act="restart" data-i="${i}">Restart</button><button class="btn-sm" data-action="act" data-act="stop" data-i="${i}">Stop</button>` : `<button class="btn-sm" data-action="act" data-act="start" data-i="${i}">Start</button>`}
                <button class="btn-sm" data-action="update" data-i="${i}" title="Download the newest version of the app and restart it">Update</button>
                <button class="btn-sm" data-action="logs" data-i="${i}">Logs</button>
                <button class="btn-sm btn-danger" data-action="remove" data-i="${i}">Remove</button>
              </td></tr>`,
              )
              .join('')}</tbody></table></div></div>`
          : ''
      }
      <h3 style="margin:0 0 10px">Available apps</h3>
      <div class="oc-grid">${data.catalog
        .map(
          (c) => `<div class="card oc-card">
          <div class="row" style="gap:10px"><span class="chip-ico">${icon(c.icon, 20)}</span><div class="grow"><h3 style="margin:0">${esc(c.name)}</h3><div class="small muted">${esc(c.tagline)}</div></div></div>
          <p class="small" style="margin:10px 0">${esc(c.description)}</p>
          <div class="small muted" style="margin-bottom:10px">Needs about ${esc(c.ram)} of memory${installed.some((a) => a.app === c.id) ? ' · <b>installed</b>' : ''}</div>
          <button class="btn-primary" data-action="install" data-id="${esc(c.id)}" ${data.docker ? '' : 'disabled'}>Install</button>
        </div>`,
        )
        .join('')}</div>
      <p class="small muted" style="margin-top:14px">Apps listen only on the server itself (127.0.0.1), so Docker never opens a port past your firewall; visitors reach them through Nginx on the address you choose. Their data is in /opt/serverboy-apps and is part of your backups.</p>`;
  }

  onAction(el, {
    refresh: load,
    install: async ({ id }) => {
      const c = data.catalog.find((x) => x.id === id);
      const taken = new Set(data.apps.map((a) => a.name));
      let name = c.id;
      for (let n = 2; taken.has(name); n++) name = `${c.id}-${n}`;
      const job = await formDialog({
        title: `Install ${c.name}`,
        intro: c.description,
        fields: [
          { name: 'name', label: 'Name', value: name, help: 'Lowercase letters, numbers and dashes. Used for the folder and in backups.' },
          { name: 'domain', label: 'Address (domain)', value: suggestedDomain(name), placeholder: `${c.id}.example.com`, help: location.hostname.endsWith('.sslip.io') ? 'This free sslip.io address works without buying a domain.' : "Point the domain's DNS to this server first. Leave empty to keep the app private to the server." },
          { name: 'https', label: 'Get a free HTTPS certificate', type: 'checkbox', value: true },
          ...c.fields.map((f) => ({ name: `f_${f.name}`, label: f.label, value: f.name === 'timezone' ? Intl.DateTimeFormat().resolvedOptions().timeZone || f.default : f.default, placeholder: f.placeholder })),
        ],
        submitLabel: 'Install',
        submit: (v) => {
          const fields = {};
          for (const f of c.fields) fields[f.name] = v[`f_${f.name}`];
          return api(base, { method: 'POST', body: { app: c.id, name: v.name.trim(), domain: v.domain.trim(), https: v.https, fields } });
        },
      });
      if (job?.id) {
        showJob(server.id, job, {
          onDone: (j) => {
            load();
            if (j.status === 'success' && c.afterInstall) toast(`${c.name} is installed. ${c.afterInstall}`, 'ok', 10000);
          },
        });
      }
    },
    act: async ({ i, act }, btn) => {
      const a = data.apps[i];
      if (act === 'stop' && !(await confirmDialog(`Stop ${a.name}? Its address stops working until you start it again.`, { confirmLabel: 'Stop' }))) return;
      if (await run(btn, () => api(`${base}/${encodeURIComponent(a.name)}/${act}`, { method: 'POST' }), `${a.name}: ${act} done`)) load();
    },
    update: async ({ i }) => {
      const a = data.apps[i];
      if (!(await confirmDialog(`Download the newest version of ${a.name} and restart it? It is unavailable for a moment. A backup first is a good idea.`, { confirmLabel: 'Update' }))) return;
      const job = await run(null, () => api(`${base}/${encodeURIComponent(a.name)}/update`, { method: 'POST' }));
      if (job?.id) showJob(server.id, job, { onDone: load });
    },
    logs: async ({ i }) => {
      const a = data.apps[i];
      const m = modal({ title: `Logs: ${a.name}`, wide: true, body: loadingHtml(), actions: [{ label: 'Close' }] });
      try {
        const r = await api(`${base}/${encodeURIComponent(a.name)}/logs?lines=300`);
        m.body.innerHTML = `<pre class="log" style="max-height:60vh">${esc(r.log || '(empty)')}</pre>`;
        const pre = m.body.querySelector('pre');
        pre.scrollTop = pre.scrollHeight;
      } catch (err) {
        m.body.innerHTML = errorHtml(err);
      }
    },
    remove: async ({ i }) => {
      const a = data.apps[i];
      const box = document.createElement('div');
      box.innerHTML = `<p>Remove <b>${esc(a.name)}</b>? Its containers stop and are deleted${a.domain ? `, and ${esc(a.domain)} stops working` : ''}.</p>
        <label class="check"><input type="checkbox" name="del"> Also delete its data (${fmtBytes(a.size)}). Without this, the data is kept in ${esc('/opt/serverboy-apps')}/.removed-${esc(a.name)}-… on the server.</label>`;
      modal({
        title: `Remove ${a.name}`,
        body: box,
        actions: [
          { label: 'Cancel' },
          {
            label: 'Remove',
            className: 'btn-danger',
            onClick: async () => {
              const deleteData = box.querySelector('[name=del]').checked;
              if (deleteData && !(await confirmDialog(`Permanently delete all data of ${a.name}? Make sure you have a backup.`, { danger: true, confirmLabel: 'Delete data' }))) return false;
              await api(`${base}/${encodeURIComponent(a.name)}/delete`, { method: 'POST', body: { deleteData } });
              toast(`${a.name} removed`, 'ok');
              load();
            },
          },
        ],
      });
    },
  });

  load();
}
