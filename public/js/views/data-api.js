// "API" and "Connect" tabs of a MongoDB collection: manage the collection's REST API (a Data API
// service deployed on the server) and show how to use the database from code and web pages.
import { api, esc, toast, run, modal, confirmDialog, formDialog, showJob, onAction, loadingHtml, errorHtml } from '../ui.js';

const ENDPOINTS = [
  ['list', 'GET', '', 'List documents (filter, sort, pages)'],
  ['count', 'GET', '/count', 'Count documents'],
  ['get', 'GET', '/:id', 'Get one document'],
  ['create', 'POST', '', 'Create a document'],
  ['update', 'PATCH', '/:id', 'Update some fields'],
  ['replace', 'PUT', '/:id', 'Replace a whole document'],
  ['delete', 'DELETE', '/:id', 'Delete a document'],
];
const PRESETS = {
  recommended: { label: 'Public read, key for writes', modes: { list: 'public', count: 'public', get: 'public', create: 'key', update: 'key', replace: 'key', delete: 'key' } },
  private: { label: 'Everything needs a key', modes: { list: 'key', count: 'key', get: 'key', create: 'key', update: 'key', replace: 'key', delete: 'key' } },
  readonly: { label: 'Read-only (public)', modes: { list: 'public', count: 'public', get: 'public', create: 'off', update: 'off', replace: 'off', delete: 'off' } },
};
const MODE_LABEL = { off: 'Off', public: 'Public (anyone)', key: 'API key needed' };

const pretty = (v) => esc(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function suggestedDomain(name) {
  return location.hostname.endsWith('.sslip.io') ? `${name}.${location.hostname}` : '';
}

// ======================= API tab =======================

export function mountCollectionApi(el, server, dbName, col) {
  const base = `/servers/${server.id}/mongo/apis`;
  let info = null; // API details
  let sampleFields = [];

  async function load() {
    el.innerHTML = loadingHtml();
    try {
      const apis = await api(base);
      const found = apis.find((a) => a.database === dbName && !a.broken);
      if (!found) return drawCreate();
      info = await api(`${base}/${found.name}`);
      const sample = await api(`/servers/${server.id}/mongo/find`, { method: 'POST', body: { db: dbName, collection: col, limit: 5 } }).catch(() => ({ docs: [] }));
      sampleFields = [...new Set(sample.docs.flatMap((d) => Object.keys(d)))].filter((f) => f !== '_id');
      draw();
    } catch (err) {
      el.innerHTML = errorHtml(err);
    }
  }

  function drawCreate() {
    const name = `${dbName}-api`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
    el.innerHTML = `
      <div class="notice" style="margin-bottom:12px">
        <b>No API for the ${esc(dbName)} database yet.</b><br>
        An API lets your web pages and apps read and change this data over HTTPS, without a database password.
        Serverboy installs a small API service on the server; you then choose exactly which collections and actions are open.
      </div>
      <form id="da-create" style="max-width:620px">
        <label class="field"><span>API name</span><input name="name" value="${esc(name)}"><small>Also the folder name: /var/www/&lt;name&gt;</small></label>
        <label class="field"><span>Public address (optional)</span><input name="domain" value="${esc(suggestedDomain(name))}" placeholder="api.example.com">
          <small>Where your pages will call the API. ${location.hostname.endsWith('.sslip.io') ? 'This free sslip.io address works without buying a domain.' : 'Point the domain\'s DNS to this server first.'} Leave empty to keep it private to the server.</small></label>
        <label class="check"><input type="checkbox" name="https" checked> Get a free HTTPS certificate (ports 80 and 443 must be open in Azure)</label>
        <button class="btn-primary">Create API service</button>
      </form>`;
    el.querySelector('#da-create').addEventListener('submit', async (e) => {
      const f = e.target;
      const btn = f.querySelector('button');
      const job = await run(btn, () => api(base, { method: 'POST', body: { name: f.name.value, database: dbName, domain: f.domain.value.trim(), https: f.https.checked } }));
      if (job) showJob(server.id, job, { onDone: load });
    });
  }

  function draw() {
    const c = info.collections?.[col];
    const online = info.status === 'online';
    el.innerHTML = `
      <div class="card" style="padding:12px;margin-bottom:12px">
        <div class="row">
          <b>${esc(info.name)}</b>
          <span class="badge ${online ? 'ok' : 'bad'}">${esc(info.status)}</span>
          <span class="mono small">${info.url ? `<a href="${esc(info.url)}/health" target="_blank" rel="noopener">${esc(info.url)}</a>` : info.port ? `private: 127.0.0.1:${info.port} on the server` : 'not set up yet'}</span>
          <span class="grow"></span>
          ${info.url || !info.port ? '' : '<button class="btn-sm btn-primary" data-action="da-publish">Publish on a domain</button>'}
          <button class="btn-sm" data-action="da-settings">Settings</button>
          <button class="btn-sm" data-action="da-upgrade">Update engine</button>
          <button class="btn-sm btn-danger" data-action="da-delete">Delete API</button>
        </div>
        ${
          online
            ? ''
            : info.status === 'not running'
              ? `<div class="notice warn" style="margin:10px 0 0">The setup of this API did not finish (for example Node.js or PM2 was missing).
                  <div class="row" style="margin-top:8px"><button class="btn-primary btn-sm" data-action="da-finish">Finish setup</button><span class="small muted">Installs anything missing and starts the API. Collections and keys are kept.</span></div></div>`
              : `<p class="small" style="color:var(--bad);margin:8px 0 0">The API service is ${esc(info.status)}. Open <a href="#/s/${server.id}/nodeapps">Node Apps</a> → ${esc(info.name)} → Logs to see why.</p>`
        }
      </div>
      ${c ? collectionEditor(c) : exposeCard()}
      ${keysSection()}`;
    if (c) bindEditor();
  }

  function exposeCard() {
    return `<div class="card" style="margin-bottom:12px">
      <h3>Open "${esc(col)}" through the API</h3>
      <p class="muted small" style="margin-top:0">Choose a starting point; you can change every endpoint afterwards.</p>
      <div class="row">${Object.entries(PRESETS)
        .map(([id, p]) => `<button class="${id === 'recommended' ? 'btn-primary' : ''}" data-action="da-expose" data-preset="${id}">${esc(p.label)}</button>`)
        .join('')}</div>
    </div>`;
  }

  function collectionEditor(c) {
    const url = info.url || 'https://YOUR-API-ADDRESS';
    return `
      <div class="card flush" style="margin-bottom:12px">
        <div class="card-head"><h3 style="margin:0">Endpoints for ${esc(col)}</h3>
          <div class="row">${Object.entries(PRESETS).map(([id, p]) => `<button class="btn-sm" data-action="da-preset" data-preset="${id}">${esc(p.label)}</button>`).join('')}</div></div>
        <table><tbody>${ENDPOINTS.map(
          ([id, method, suffix, desc]) => `<tr>
            <td style="width:80px"><span class="badge method-${method.toLowerCase()}">${method}</span></td>
            <td class="mono small">/api/${esc(col)}${suffix}</td>
            <td class="small muted">${desc}</td>
            <td style="width:190px"><select data-endpoint="${id}">${Object.entries(MODE_LABEL).map(([m, l]) => `<option value="${m}" ${c.endpoints[id] === m ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
          </tr>`,
        ).join('')}</tbody></table>
        <div style="padding:12px 16px">
          ${sampleFields.length ? `<p class="small muted" style="margin-top:0">Fields seen in this collection: ${sampleFields.map((f) => `<span class="mono">${esc(f)}</span>`).join(', ')}</p>` : ''}
          <div class="form-grid">
            <label class="field"><span>Hidden fields</span><input id="da-hidden" value="${esc((c.hidden || []).join(', '))}" placeholder="password, internalNotes"><small>Never returned, and cannot be filtered on.</small></label>
            <label class="field"><span>Read-only fields</span><input id="da-readonly" value="${esc((c.readonly || []).join(', '))}" placeholder="ownerId, sku"><small>Ignored when someone creates or updates.</small></label>
            <label class="field"><span>Required fields</span><input id="da-required" value="${esc((c.required || []).join(', '))}" placeholder="name, email"><small>Creating fails without them.</small></label>
            <label class="check" style="margin-top:22px"><input type="checkbox" id="da-timestamps" ${c.timestamps ? 'checked' : ''}> Add createdAt / updatedAt automatically</label>
          </div>
          <div class="row"><button class="btn-primary" data-action="da-save">Save</button><span class="small muted">Applies in about 2 seconds, no restart.</span><span class="grow"></span><button class="btn-sm btn-danger" data-action="da-unexpose">Stop exposing ${esc(col)}</button></div>
        </div>
      </div>

      <div class="card" style="margin-bottom:12px">
        <h3>Try it</h3>
        <div class="form-grid">
          <label class="field"><span>Endpoint</span><select id="da-try-ep">${ENDPOINTS.filter(([id]) => c.endpoints[id] !== 'off').map(([id, m, s, d]) => `<option value="${id}">${m} /api/${esc(col)}${s} · ${d}</option>`).join('') || '<option value="">(all endpoints are off)</option>'}</select></label>
          <label class="field"><span>Send as</span><select id="da-try-auth"><option value="none">The public (no key)</option><option value="console">Serverboy test key (full access)</option></select></label>
          <label class="field" id="da-try-id-f"><span>Document id</span><input id="da-try-id" class="mono" placeholder="paste an _id"></label>
          <label class="field" id="da-try-q-f"><span>Query</span><input id="da-try-q" class="mono" placeholder="limit=5&amp;sort=-createdAt"></label>
        </div>
        <label class="field" id="da-try-body-f"><span>Body (JSON)</span><textarea id="da-try-body" rows="4">{\n  "name": "Example"\n}</textarea></label>
        <div class="row"><button class="btn-primary" data-action="da-send">Send</button><span id="da-try-status"></span></div>
        <pre class="log hidden" id="da-try-out" style="margin-top:10px;max-height:320px"></pre>
      </div>

      ${docsHtml(c, url)}`;
  }

  function docsHtml(c, url) {
    const on = (id) => c.endpoints[id] !== 'off';
    const needsKey = (id) => c.endpoints[id] === 'key';
    const keyHdr = `"x-api-key": "YOUR_API_KEY"`;
    const lines = [];
    if (on('list')) {
      lines.push(`// List (newest first, 20 per page)
const res = await fetch("${url}/api/${col}?sort=-createdAt&limit=20&page=1"${needsKey('list') ? `, {\n  headers: { ${keyHdr} },\n}` : ''});
const { data, total } = await res.json();`);
    }
    if (on('get')) lines.push(`// Get one
const item = await (await fetch(\`${url}/api/${col}/\${id}\`${needsKey('get') ? `, { headers: { ${keyHdr} } }` : ''})).json();`);
    if (on('create')) {
      lines.push(`// Create
await fetch("${url}/api/${col}", {
  method: "POST",
  headers: { "content-type": "application/json"${needsKey('create') ? `, ${keyHdr}` : ''} },
  body: JSON.stringify({ name: "New item" }),
});`);
    }
    if (on('update')) {
      lines.push(`// Update some fields
await fetch(\`${url}/api/${col}/\${id}\`, {
  method: "PATCH",
  headers: { "content-type": "application/json"${needsKey('update') ? `, ${keyHdr}` : ''} },
  body: JSON.stringify({ price: 25 }),
});`);
    }
    if (on('delete')) lines.push(`// Delete
await fetch(\`${url}/api/${col}/\${id}\`, { method: "DELETE"${needsKey('delete') ? `, headers: { ${keyHdr} }` : ''} });`);
    return `
      <div class="card">
        <h3>How to call it</h3>
        <table><tbody>${ENDPOINTS.filter(([id]) => on(id))
          .map(([id, m, s, d]) => `<tr><td style="width:80px"><span class="badge method-${m.toLowerCase()}">${m}</span></td><td class="mono small">${esc(url)}/api/${esc(col)}${s}</td><td class="small">${d}</td><td class="small">${needsKey(id) ? '🔑 key' : '🌐 public'}</td></tr>`)
          .join('') || '<tr><td class="muted">All endpoints are off.</td></tr>'}</tbody></table>
        ${on('list') ? `<h4>Listing options</h4>
        <table class="small"><tbody>
          <tr><td class="mono">?status=active</td><td>Only documents where a field equals a value (text match).</td></tr>
          <tr><td class="mono">?filter={"price":{"$gte":20}}</td><td>Any MongoDB filter as JSON (URL-encode it). JavaScript operators like $where are blocked.</td></tr>
          <tr><td class="mono">?sort=-createdAt,name</td><td>Sort; a leading minus means newest / largest first.</td></tr>
          <tr><td class="mono">?limit=20&amp;page=2</td><td>Paging (max ${info.maxLimit} per page). Or use skip=40.</td></tr>
          <tr><td class="mono">?fields=name,price</td><td>Only return these fields.</td></tr>
        </tbody></table>` : ''}
        ${lines.length ? `<h4>JavaScript (works in web pages, React, Node.js)</h4><pre class="log">${esc(lines.join('\n\n'))}</pre>` : ''}
        ${on('list') ? `<h4>curl</h4><pre class="log">${esc(`curl "${url}/api/${col}?limit=5"${needsKey('list') ? ' -H "x-api-key: YOUR_API_KEY"' : ''}`)}</pre>` : ''}
        <p class="small muted">Responses: lists return <span class="mono">{ data, total, limit, skip }</span>; errors return <span class="mono">{ error }</span> with a 4xx status. ${
          ENDPOINTS.some(([id]) => needsKey(id)) ? '<b>Never put a key with write access into web page code</b>: anyone can read it. Call those endpoints from your backend.' : ''
        }</p>
      </div>`;
  }

  function keysSection() {
    const keys = info.keys || [];
    return `<div class="card flush" style="margin-top:12px">
      <div class="card-head"><h3 style="margin:0">API keys (${esc(info.name)})</h3><button class="btn-sm btn-primary" data-action="da-newkey">+ New key</button></div>
      <table><tbody>${keys
        .map(
          (k) => `<tr><td><b>${esc(k.label)}</b><div class="small muted mono">${esc(k.prefix)}…</div></td>
            <td class="small">${Object.entries(k.access).map(([cName, ops]) => `${cName === '*' ? 'all collections' : esc(cName)}: ${ops.map(esc).join(', ')}`).join('<br>')}</td>
            <td class="small muted">${new Date(k.createdAt).toLocaleDateString()}${k.createdBy ? ` by ${esc(k.createdBy)}` : ''}</td>
            <td class="actions"><button class="btn-sm btn-danger" data-action="da-revoke" data-id="${esc(k.id)}">Revoke</button></td></tr>`,
        )
        .join('') || '<tr><td class="empty">No keys yet. Endpoints set to "API key needed" only work with a key.</td></tr>'}</tbody></table>
    </div>`;
  }

  function currentEndpoints() {
    return Object.fromEntries([...el.querySelectorAll('select[data-endpoint]')].map((s) => [s.dataset.endpoint, s.value]));
  }

  function bindEditor() {
    const ep = el.querySelector('#da-try-ep');
    const sync = () => {
      const id = ep.value;
      el.querySelector('#da-try-id-f').classList.toggle('hidden', !['get', 'update', 'replace', 'delete'].includes(id));
      el.querySelector('#da-try-q-f').classList.toggle('hidden', !['list', 'count'].includes(id));
      el.querySelector('#da-try-body-f').classList.toggle('hidden', !['create', 'update', 'replace'].includes(id));
    };
    ep?.addEventListener('change', sync);
    if (ep) sync();
  }

  async function saveCollection(endpoints) {
    const body = {
      endpoints,
      hidden: el.querySelector('#da-hidden')?.value ?? '',
      readonly: el.querySelector('#da-readonly')?.value ?? '',
      required: el.querySelector('#da-required')?.value ?? '',
      timestamps: el.querySelector('#da-timestamps') ? el.querySelector('#da-timestamps').checked : true,
    };
    const cfg = await api(`${base}/${info.name}/collections/${encodeURIComponent(col)}`, { method: 'PUT', body });
    info = { ...info, ...cfg };
    return true;
  }

  onAction(el, {
    'da-expose': async ({ preset }, btn) => {
      const ok = await run(btn, () => saveCollection(PRESETS[preset].modes), `${col} is now available through the API`);
      if (ok) draw();
    },
    'da-preset': ({ preset }) => {
      for (const s of el.querySelectorAll('select[data-endpoint]')) s.value = PRESETS[preset].modes[s.dataset.endpoint];
      toast('Preset applied. Click Save to use it.');
    },
    'da-save': async (_d, btn) => {
      const ok = await run(btn, () => saveCollection(currentEndpoints()), 'Saved. Live in about 2 seconds.');
      if (ok) draw();
    },
    'da-unexpose': async () => {
      if (!(await confirmDialog(`Stop exposing ${col}? Its endpoints stop working. The data itself is not touched.`, { danger: true, confirmLabel: 'Stop exposing' }))) return;
      await run(null, () => api(`${base}/${info.name}/collections/${encodeURIComponent(col)}`, { method: 'DELETE' }), 'Done');
      load();
    },
    'da-send': async (_d, btn) => {
      const id = el.querySelector('#da-try-ep').value;
      if (!id) return;
      const [, method, suffix] = ENDPOINTS.find((x) => x[0] === id);
      const docId = el.querySelector('#da-try-id').value.trim();
      if (suffix === '/:id' && !docId) return toast('Paste a document id first (from the Documents tab).', 'error');
      const query = el.querySelector('#da-try-q').value.trim().replace(/^\?/, '');
      let reqPath = `/api/${encodeURIComponent(col)}${suffix.replace(':id', encodeURIComponent(docId))}`;
      if (query && ['list', 'count'].includes(id)) reqPath += `?${query}`;
      const body = ['create', 'update', 'replace'].includes(id) ? el.querySelector('#da-try-body').value : '';
      if (body) {
        try {
          JSON.parse(body);
        } catch {
          return toast('The body is not valid JSON', 'error');
        }
      }
      const out = el.querySelector('#da-try-out');
      const status = el.querySelector('#da-try-status');
      status.innerHTML = '<span class="spinner"></span>';
      const r = await run(btn, () => api(`${base}/${info.name}/test`, { method: 'POST', body: { method, path: reqPath, body, auth: el.querySelector('#da-try-auth').value } }));
      if (!r) return (status.innerHTML = '');
      status.innerHTML = `<span class="badge ${r.status < 300 ? 'ok' : r.status < 500 ? 'warn' : 'bad'}">${r.status || 'no answer'}</span> <span class="small muted">${r.ms} ms · ${esc(method)} ${esc(reqPath)}</span>`;
      out.classList.remove('hidden');
      out.textContent = typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2);
    },
    'da-newkey': async () => {
      const exposed = Object.keys(info.collections || {});
      const box = document.createElement('div');
      box.innerHTML = `
        <label class="field"><span>Name</span><input name="label" placeholder="website backend" autocomplete="off"><small>So you remember where it is used.</small></label>
        <label class="field"><span>Access</span><select name="mode">
          <option value="read">Read only, all collections</option>
          <option value="full">Read and write, all collections</option>
          ${exposed.length ? '<option value="custom">Choose per collection…</option>' : ''}
        </select></label>
        <div id="da-custom" class="hidden"><table class="small"><thead><tr><th>Collection</th><th>read</th><th>create</th><th>update</th><th>delete</th></tr></thead><tbody>${exposed
          .map((cName) => `<tr><td class="mono">${esc(cName)}</td>${['read', 'create', 'update', 'delete'].map((op) => `<td><input type="checkbox" data-c="${esc(cName)}" data-op="${op}" ${cName === col && op === 'read' ? 'checked' : ''}></td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`;
      box.querySelector('select[name=mode]').addEventListener('change', (e) => box.querySelector('#da-custom').classList.toggle('hidden', e.target.value !== 'custom'));
      modal({
        title: `New API key for ${info.name}`,
        body: box,
        actions: [
          { label: 'Cancel' },
          {
            label: 'Create key',
            className: 'btn-primary',
            onClick: async () => {
              const mode = box.querySelector('select[name=mode]').value;
              let access;
              if (mode === 'read') access = { '*': ['read'] };
              else if (mode === 'full') access = { '*': ['read', 'create', 'update', 'delete'] };
              else {
                access = {};
                for (const c of box.querySelectorAll('input[data-op]:checked')) (access[c.dataset.c] ||= []).push(c.dataset.op);
              }
              const k = await api(`${base}/${info.name}/keys`, { method: 'POST', body: { label: box.querySelector('input[name=label]').value, access } });
              modal({
                title: 'Copy your API key now',
                body: `<p>This key is shown <b>only once</b>. Store it in your app's environment variables (e.g. <span class="mono">DATA_API_KEY</span>).</p>
                  <pre class="log">${esc(k.key)}</pre>
                  <p class="small muted">Send it in the <span class="mono">x-api-key</span> header. ${access['*']?.includes('create') || Object.values(access).some((o) => o.some((x) => x !== 'read')) ? 'It can change data: use it only from a backend, never in web page code.' : ''}</p>`,
                actions: [{ label: 'I have copied it', className: 'btn-primary' }],
              });
              load();
            },
          },
        ],
      });
    },
    'da-revoke': async ({ id }) => {
      const k = info.keys.find((x) => x.id === id);
      if (!(await confirmDialog(`Revoke the key "${k.label}"? Anything using it stops working within 2 seconds.`, { danger: true, confirmLabel: 'Revoke' }))) return;
      await run(null, () => api(`${base}/${info.name}/keys/${id}`, { method: 'DELETE' }), 'Key revoked');
      load();
    },
    'da-finish': async () => {
      const v = await formDialog({
        title: `Finish setting up ${info.name}`,
        fields: [
          { name: 'domain', label: 'Public address (optional)', value: info.domain || suggestedDomain(info.name), placeholder: 'api.example.com' },
          { name: 'https', label: 'Get a free HTTPS certificate', type: 'checkbox', value: true },
        ],
        submitLabel: 'Finish setup',
        submit: (x) => api(base, { method: 'POST', body: { name: info.name, database: dbName, domain: x.domain.trim(), https: x.https } }),
      });
      if (v?.id) showJob(server.id, v, { onDone: load });
    },
    'da-publish': async () => {
      const job = await formDialog({
        title: `Publish ${info.name}`,
        intro: 'Gives the API a public web address so pages and apps can call it. The domain must point to this server, and ports 80 / 443 must be open in Azure.',
        fields: [
          { name: 'domain', label: 'Domain', value: suggestedDomain(info.name), placeholder: 'api.example.com' },
          { name: 'https', label: 'Get a free HTTPS certificate', type: 'checkbox', value: true },
        ],
        submitLabel: 'Publish',
        submit: (x) => api(`${base}/${info.name}/publish`, { method: 'POST', body: x }),
      });
      if (job?.id) showJob(server.id, job, { onDone: load });
    },
    'da-settings': async () => {
      const v = await formDialog({
        title: `${info.name} settings`,
        fields: [
          {
            name: 'cors',
            label: 'Websites allowed to call this API from the browser (CORS)',
            type: 'textarea',
            rows: 3,
            value: (info.cors || []).join('\n'),
            help: 'One per line, like https://myshop.com. Use * to allow any website.',
          },
          { name: 'rateLimitPerMinute', label: 'Requests per minute per visitor / key (0 = no limit)', type: 'number', value: info.rateLimitPerMinute },
          { name: 'maxLimit', label: 'Most documents per page', type: 'number', value: info.maxLimit },
        ],
        submit: (x) => api(`${base}/${info.name}/settings`, { method: 'PUT', body: x }),
      });
      if (v) {
        toast('Settings saved', 'ok');
        load();
      }
    },
    'da-upgrade': async () => {
      if (!(await confirmDialog(`Update ${info.name} to the API engine that ships with this Serverboy version? It restarts for a second.`, { confirmLabel: 'Update' }))) return;
      const job = await run(null, () => api(`${base}/${info.name}/upgrade`, { method: 'POST' }));
      if (job) showJob(server.id, job, { onDone: load });
    },
    'da-delete': async () => {
      if (!(await confirmDialog(`Delete the API service ${info.name}? Every app using it stops working, and all its keys are deleted. The data in ${dbName} is NOT touched.`, { danger: true, confirmLabel: 'Delete API' }))) return;
      await run(null, () => api(`${base}/${info.name}`, { method: 'DELETE' }), 'API deleted');
      load();
    },
  });

  load();
}

// ======================= Connect tab =======================

export function mountConnectGuide(el, server, dbName, col) {
  const model = col.charAt(0).toUpperCase() + col.slice(1).replace(/s$/, '');
  el.innerHTML = `
    <div class="notice"><b>There are two ways to use <span class="mono">${esc(dbName)}</span> from your project.</b> Most SaaS apps use both: the backend talks to MongoDB directly, and web pages talk to the backend or to the Data API.</div>
    <div class="grid grid-2" style="align-items:start;margin-bottom:16px">
      <div class="card">
        <h3>1. From your backend (Node.js, Express, Next.js)</h3>
        <p class="small muted" style="margin-top:0">Fastest and most flexible. Your server code connects with a username and password; browsers never see them.</p>
        <ol class="small" style="padding-left:18px">
          <li>Click <b>Users</b> (top of the MongoDB page) → <b>+ New app user</b> with database <span class="mono">${esc(dbName)}</span>. Copy the <span class="mono">MONGODB_URI</span> it shows.</li>
          <li>Put it in your app's environment variables (Node Apps → Env).</li>
          <li>Use it in code:</li>
        </ol>
        <pre class="log">${esc(`// npm install mongodb
const { MongoClient, ObjectId } = require("mongodb");
const client = new MongoClient(process.env.MONGODB_URI);
const db = client.db("${dbName}");

// find, create, update, delete
const items = await db.collection("${col}").find({ status: "active" }).limit(20).toArray();
const { insertedId } = await db.collection("${col}").insertOne({ name: "New", createdAt: new Date() });
await db.collection("${col}").updateOne({ _id: new ObjectId(id) }, { $set: { name: "Renamed" } });
await db.collection("${col}").deleteOne({ _id: new ObjectId(id) });`)}</pre>
        <details><summary class="small"><b>Using Mongoose instead</b></summary><pre class="log">${esc(`// npm install mongoose
const mongoose = require("mongoose");
await mongoose.connect(process.env.MONGODB_URI);

const ${model} = mongoose.model("${model}", new mongoose.Schema({
  name: { type: String, required: true },
}, { timestamps: true }), "${col}");

const items = await ${model}.find().sort({ createdAt: -1 }).limit(20);`)}</pre></details>
      </div>
      <div class="card">
        <h3>2. From web pages (HTML, React, mobile apps)</h3>
        <p class="small muted" style="margin-top:0">Browsers cannot connect to MongoDB directly (and must never get the password). Use the <b>API</b> tab: it gives this collection a web address with exactly the actions you allow.</p>
        <ol class="small" style="padding-left:18px">
          <li>Open the <b>API</b> tab → create the API service (one per database) → open <span class="mono">${esc(col)}</span>.</li>
          <li>Make reading <b>Public</b> if anyone may see the data; keep writing behind an <b>API key</b>.</li>
          <li>Call it from your page:</li>
        </ol>
        <pre class="log">${esc(`<ul id="list"></ul>
<script>
  fetch("https://YOUR-API-ADDRESS/api/${col}?limit=20")
    .then((r) => r.json())
    .then(({ data }) => {
      document.getElementById("list").innerHTML =
        data.map((item) => "<li>" + item.name + "</li>").join("");
    });
</script>`)}</pre>
        <p class="small muted">Saving data from a page (forms, sign-ups): send it to <b>your backend</b>, which checks it and then writes using the database or an API key. A key inside page code can be copied by anyone.</p>
      </div>
    </div>
    <div class="card">
      <h3>Which should I use?</h3>
      <table class="small"><thead><tr><th></th><th>Direct connection (1)</th><th>Data API (2)</th></tr></thead><tbody>
        <tr><td>Where it runs</td><td>Your server code only</td><td>Anywhere: browsers, mobile apps, other servers</td></tr>
        <tr><td>What you can do</td><td>Everything MongoDB can (aggregations, transactions…)</td><td>List / filter / get / create / update / delete</td></tr>
        <tr><td>Security</td><td>Password stays on the server</td><td>You choose per action: off, public, or key</td></tr>
        <tr><td>Good for</td><td>Your SaaS backend, business logic, logins</td><td>Public catalogs, dashboards, quick prototypes, other apps</td></tr>
      </tbody></table>
      <h4>Checklist before going live</h4>
      <ul class="small" style="padding-left:18px;margin:0">
        <li>MongoDB authentication is on (<b>Secure MongoDB</b>) and each app has its own database user.</li>
        <li>Passwords, connection strings and keys are in environment variables, never in Git.</li>
        <li>Hide fields like passwords or internal notes in the API tab, and allow only the websites that should call it (Settings → CORS).</li>
        <li>Back up the database regularly (Command book → MongoDB → Back up a database).</li>
      </ul>
    </div>`;
}
