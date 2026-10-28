import { api, esc, toast, run, modal, confirmDialog, formDialog, showJob, onAction, loadingHtml, errorHtml, can } from '../ui.js';

export async function render(el, { server }) {
  const base = `/servers/${server.id}`;
  let sites = [];

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Websites</h1><div class="sub">Host domains with Nginx: static sites, PHP sites, or a proxy to a Node app. Free SSL included.</div></div>
      <button class="btn-primary" data-action="add">+ Add website</button>
    </div>
    <div class="notice">Before adding a domain, create an <b>A record</b> at your domain registrar pointing to <span class="mono">${esc(server.host)}</span>, and allow ports <b>80</b> and <b>443</b> in the Azure VM's Networking settings.</div>
    <div class="card flush"><div id="list">${loadingHtml()}</div></div>`;

  const list = el.querySelector('#list');

  async function load() {
    try {
      const r = await api(`${base}/sites`);
      if (!r.installed) {
        list.innerHTML = `<div class="empty">Nginx is not installed yet. <a href="#/s/${server.id}/apps">Install it from the App Store</a>.</div>`;
        return;
      }
      sites = r.sites;
      list.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>Site</th><th>Serves</th><th>Status</th><th>SSL</th><th></th></tr></thead>
        <tbody>${sites
          .map(
            (s, i) => `<tr>
            <td><b>${esc(s.name)}</b><div class="small muted">${s.serverNames.map(esc).join(', ')}</div></td>
            <td class="mono small">${s.proxy ? `→ ${esc(s.proxy)}` : esc(s.root || '')}</td>
            <td>${s.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge">disabled</span>'}</td>
            <td>${s.ssl ? '<span class="badge ok">https</span>' : `<button class="btn-sm" data-action="ssl" data-i="${i}">Enable SSL</button>`}</td>
            <td class="actions">
              ${s.serverNames[0] && s.serverNames[0] !== '_' ? `<a class="btn btn-sm" href="${s.ssl ? 'https' : 'http'}://${esc(s.serverNames[0])}" target="_blank" rel="noopener">Visit</a>` : ''}
              ${s.root ? `<button class="btn-sm" data-action="files" data-root="${esc(s.root)}">Files</button>` : ''}
              <button class="btn-sm" data-action="config" data-i="${i}">Config</button>
              <button class="btn-sm" data-action="toggle" data-i="${i}">${s.enabled ? 'Disable' : 'Enable'}</button>
              <button class="btn-sm btn-danger" data-action="remove" data-i="${i}">Delete</button>
            </td></tr>`,
          )
          .join('')}
        ${sites.length ? '' : '<tr><td colspan="5" class="empty">No websites yet</td></tr>'}
        </tbody></table></div>`;
    } catch (err) {
      list.innerHTML = errorHtml(err);
    }
  }

  onAction(el, {
    add: async () => {
      const created = await formDialog({
        title: 'Add website',
        fields: [
          { name: 'domain', label: 'Domain', placeholder: 'example.com', required: true },
          { name: 'www', label: 'Also serve www.<domain>', type: 'checkbox', value: true },
          {
            name: 'type',
            label: 'Type',
            type: 'select',
            value: 'static',
            options: [
              ['static', 'Static website (HTML/CSS/JS files)'],
              ['spa', 'Single-page app (React/Vue/Angular build)'],
              ['php', 'PHP website (WordPress, Laravel…)'],
              ['proxy', 'Reverse proxy to an app port (Node.js, Python…)'],
            ],
          },
          { name: 'port', label: 'App port (reverse proxy only)', type: 'number', placeholder: '3000' },
          { name: 'root', label: 'Document root (optional)', placeholder: '/var/www/<domain>/public_html' },
          { name: 'aliases', label: 'Extra domains (optional)', placeholder: 'app.example.com other.com' },
        ],
        submitLabel: 'Create website',
        submit: (v) => api(`${base}/sites`, { method: 'POST', body: v }),
      });
      if (created) {
        toast(`Website ${created.domain} created`, 'ok');
        load();
      }
    },
    files: ({ root }) => {
      sessionStorage.setItem(`sb-files-${server.id}`, root);
      location.hash = `#/s/${server.id}/files`;
    },
    ssl: async ({ i }) => {
      const s = sites[i];
      const v = await formDialog({
        title: `Free SSL for ${s.name}`,
        intro: `The domain's DNS must already point to <span class="mono">${esc(server.host)}</span>. Certificates renew automatically.`,
        fields: [{ name: 'email', label: 'Your email (for renewal notices)', type: 'email', required: true }],
        submitLabel: 'Get certificate',
        submit: (values) => api(`${base}/sites/${encodeURIComponent(s.name)}/ssl`, { method: 'POST', body: values }),
      });
      if (v?.id) showJob(server.id, v, { onDone: load });
    },
    config: async ({ i }) => {
      const s = sites[i];
      let content;
      try {
        content = (await api(`${base}/sites/${encodeURIComponent(s.name)}/config`)).content;
      } catch (err) {
        return toast(err.message, 'error');
      }
      const body = document.createElement('div');
      body.innerHTML = `<textarea spellcheck="false" style="width:100%;height:60vh;white-space:pre" ${can('owner') ? '' : 'readonly'}></textarea><p class="small muted">${
        can('owner')
          ? 'Saved changes are tested with <span class="mono">nginx -t</span> and rolled back automatically if invalid.'
          : 'Read-only: only the owner can edit raw Nginx configuration.'
      }</p>`;
      body.querySelector('textarea').value = content;
      modal({
        title: `Nginx config: ${s.name}`,
        wide: true,
        body,
        actions: can('owner') ? [
          { label: 'Cancel' },
          {
            label: 'Save & reload',
            className: 'btn-primary',
            onClick: async () => {
              await api(`${base}/sites/${encodeURIComponent(s.name)}/config`, { method: 'PUT', body: { content: body.querySelector('textarea').value } });
              toast('Config saved and Nginx reloaded', 'ok');
              load();
            },
          },
        ] : [{ label: 'Close' }],
      });
    },
    toggle: async ({ i }, btn) => {
      const s = sites[i];
      await run(btn, () => api(`${base}/sites/${encodeURIComponent(s.name)}/toggle`, { method: 'POST', body: { enabled: !s.enabled } }));
      load();
    },
    remove: async ({ i }) => {
      const s = sites[i];
      const v = await formDialog({
        title: `Delete ${s.name}?`,
        intro: 'The Nginx configuration is removed and the site goes offline.',
        fields: [{ name: 'deleteFiles', label: `Also delete website files in /var/www/${s.name}`, type: 'checkbox' }],
        submitLabel: 'Delete website',
      });
      if (!v) return;
      if (v.deleteFiles && !(await confirmDialog(`Permanently delete all files in /var/www/${s.name}?`, { danger: true, confirmLabel: 'Delete files' }))) return;
      await run(null, () => api(`${base}/sites/${encodeURIComponent(s.name)}`, { method: 'DELETE', body: v }), 'Website deleted');
      load();
    },
  });

  load();
}
