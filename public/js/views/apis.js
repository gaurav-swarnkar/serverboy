// APIs: a full page for the Data API services (one per MongoDB database).
//   #/s/<id>/apis                                   all API services, and databases without one
//   #/s/<id>/apis/<db>                              that database's API (or the form to create it)
//   #/s/<id>/apis/<db>/collections/<col>/<sub>      a collection: endpoints | try | docs
//   #/s/<id>/apis/<db>/keys | /settings             API keys, settings and maintenance
import { api, esc, toast, run, modal, confirmDialog, formDialog, showJob, onAction, loadingHtml, errorHtml, hasAll, can } from '../ui.js';
import { ENDPOINTS, PRESETS, MODE_LABEL, suggestedDomain, docsHtml } from './data-api.js';

const SYSTEM_DBS = new Set(['admin', 'local', 'config', 'serverboy']);
const SUBS = [
  ['endpoints', 'Endpoints & rules'],
  ['try', 'Try it'],
  ['docs', 'Docs'],
];

export async function render(el, { server, rest }) {
  const [db, section, col, sub] = rest.map((x) => decodeURIComponent(x));
  if (!db) return renderList(el, server);
  return renderWorkspace(el, server, { db, section: section || 'collections', col, sub: sub || 'endpoints' });
}

async function databases(server) {
  const list = await api(`/servers/${server.id}/mongo/databases`).catch(() => []);
  return list.filter((d) => !SYSTEM_DBS.has(d.name));
}

// ======================= all APIs =======================

async function renderList(el, server) {
  const link = (db) => `#/s/${server.id}/apis/${encodeURIComponent(db)}`;
  el.innerHTML = `
    <div class="page-head">
      <div><h1>APIs</h1><div class="sub">REST APIs for your MongoDB databases: web pages and apps read and change data over HTTPS, without a database password.</div></div>
    </div>
    <div id="apis-body">${loadingHtml()}</div>`;
  const body = el.querySelector('#apis-body');
  try {
    const [apis, dbs] = await Promise.all([api(`/servers/${server.id}/mongo/apis`), databases(server)]);
    const withApi = new Set(apis.map((a) => a.database));
    const without = dbs.filter((d) => !withApi.has(d.name));
    body.innerHTML = `
      <div class="card flush" style="margin-bottom:16px">
        <div class="card-head"><h2 style="margin:0">API services</h2></div>
        <div class="table-wrap"><table>
          <thead><tr><th>API</th><th>Database</th><th>Status</th><th>Address</th><th>Collections</th><th>Keys</th><th></th></tr></thead>
          <tbody>${
            apis
              .map((a) =>
                a.broken
                  ? `<tr><td><b>${esc(a.name)}</b></td><td colspan="6" class="small" style="color:var(--bad)">api.config.json in /var/www/${esc(a.name)} cannot be read. Fix or remove it in the File Manager.</td></tr>`
                  : `<tr>
                    <td><a href="${link(a.database)}" data-api="${esc(a.name)}"><b>${esc(a.name)}</b></a></td>
                    <td class="mono small">${esc(a.database)}</td>
                    <td><span class="badge ${a.status === 'online' ? 'ok' : 'bad'}">${esc(a.status)}</span></td>
                    <td class="mono small">${a.domain ? esc(a.domain) : a.port ? `private :${a.port}` : '-'}</td>
                    <td class="small">${a.collections.length ? a.collections.map(esc).join(', ') : '<span class="muted">none yet</span>'}</td>
                    <td class="small">${a.keys}</td>
                    <td class="actions"><a class="btn btn-sm btn-primary" href="${link(a.database)}" data-api="${esc(a.name)}">Open</a></td>
                  </tr>`,
              )
              .join('') || '<tr><td colspan="7" class="empty">No API services yet. Create one for a database below.</td></tr>'
          }</tbody>
        </table></div>
      </div>
      <div class="card flush">
        <div class="card-head"><h2 style="margin:0">Databases without an API</h2></div>
        <table><tbody>${
          without
            .map(
              (d) => `<tr><td class="mono">${esc(d.name)}</td>
                <td class="actions">${d.access === 'edit' || hasAll('databases') ? `<a class="btn btn-sm" href="${link(d.name)}">Create API</a>` : '<span class="small muted">view only</span>'}</td></tr>`,
            )
            .join('') || '<tr><td class="empty">Every database you can see has an API.</td></tr>'
        }</tbody></table>
      </div>`;
    body.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-api]');
      if (a) rememberApi(server, a.getAttribute('href').split('/').pop(), a.dataset.api);
    });
  } catch (err) {
    body.innerHTML = errorHtml(err);
  }
}

// A database can have more than one API; remember which one was last opened.
const pickKey = (server, db) => `sb-api-${server.id}-${db}`;
function rememberApi(server, db, name) {
  try {
    sessionStorage.setItem(pickKey(server, decodeURIComponent(db)), name);
  } catch {
    /* private mode */
  }
}
function rememberedApi(server, db) {
  try {
    return sessionStorage.getItem(pickKey(server, db));
  } catch {
    return null;
  }
}

// ======================= one database's API =======================

async function renderWorkspace(el, server, nav) {
  const base = `/servers/${server.id}/mongo/apis`;
  const dbName = nav.db;
  const home = `#/s/${server.id}/apis/${encodeURIComponent(dbName)}`;
  let info = null; // API details
  let siblings = []; // all APIs of this database
  let collections = []; // [{name, count}] in the database
  let canEdit = false;
  let sampleFields = [];
  const history = []; // Try it requests in this visit

  // Keep the address bar in step without re-rendering the page.
  function syncHash() {
    const parts = [nav.section];
    if (nav.section === 'collections' && nav.col) parts.push(encodeURIComponent(nav.col), nav.sub);
    window.history.replaceState(null, '', `${home}/${parts.join('/')}`);
  }

  el.innerHTML = loadingHtml();

  async function load() {
    try {
      const [apis, dbs, cols] = await Promise.all([
        api(base),
        databases(server),
        api(`/servers/${server.id}/mongo/databases/${encodeURIComponent(dbName)}/collections`).catch(() => []),
      ]);
      const dbInfo = dbs.find((d) => d.name === dbName);
      if (!dbInfo && !hasAll('databases')) {
        el.innerHTML = errorHtml(new Error(`You don't have access to the ${dbName} database.`));
        return;
      }
      canEdit = hasAll('databases') || dbInfo?.access === 'edit';
      collections = cols.filter((c) => !c.name.startsWith('system.'));
      siblings = apis.filter((a) => a.database === dbName && !a.broken);
      const found = siblings.find((a) => a.name === rememberedApi(server, dbName)) || siblings[0];
      if (!found) return drawCreate();
      info = await api(`${base}/${found.name}`);
      if (nav.section === 'collections' && !nav.col) nav.col = Object.keys(info.collections || {})[0] || collections[0]?.name;
      await loadSample();
      draw();
    } catch (err) {
      el.innerHTML = errorHtml(err);
    }
  }

  async function loadSample() {
    sampleFields = [];
    if (!nav.col) return;
    const sample = await api(`/servers/${server.id}/mongo/find`, { method: 'POST', body: { db: dbName, collection: nav.col, limit: 5 } }).catch(() => ({ docs: [] }));
    sampleFields = [...new Set(sample.docs.flatMap((d) => Object.keys(d)))].filter((f) => f !== '_id');
  }

  function head(title, sub, buttons = '') {
    return `
      <div class="small" style="margin-bottom:6px"><a href="#/s/${server.id}/apis">← All APIs</a></div>
      <div class="page-head">
        <div><h1>${title}</h1><div class="sub">${sub}</div></div>
        <div class="row">${buttons}</div>
      </div>`;
  }

  // ---------- create ----------

  function drawCreate() {
    const name = `${dbName}-api`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
    el.innerHTML = `${head(`API for ${esc(dbName)}`, 'This database has no API yet.', `<a class="btn" href="#/s/${server.id}/databases">Open in Databases</a>`)}
      ${
        canEdit
          ? `<div class="card" style="max-width:720px">
        <p style="margin-top:0">An API lets your web pages and apps read and change this data over HTTPS, without a database password.
        Serverboy installs a small API service on the server; you then choose exactly which collections and actions are open.</p>
        <form id="da-create">
          <label class="field"><span>API name</span><input name="name" value="${esc(name)}"><small>Also the folder name: /var/www/&lt;name&gt;</small></label>
          <label class="field"><span>Public address (optional)</span><input name="domain" value="${esc(suggestedDomain(name))}" placeholder="api.example.com">
            <small>Where your pages will call the API. ${location.hostname.endsWith('.sslip.io') ? 'This free sslip.io address works without buying a domain.' : "Point the domain's DNS to this server first."} Leave empty to keep it private to the server.</small></label>
          <label class="check"><input type="checkbox" name="https" checked> Get a free HTTPS certificate (ports 80 and 443 must be open in Azure)</label>
          <button class="btn-primary">Create API service</button>
        </form></div>`
          : `<div class="notice">You have view access only to ${esc(dbName)}; ask someone with edit access to create its API.</div>`
      }`;
    el.querySelector('#da-create')?.addEventListener('submit', async (e) => {
      const f = e.target;
      const job = await run(f.querySelector('button'), () => api(base, { method: 'POST', body: { name: f.name.value, database: dbName, domain: f.domain.value.trim(), https: f.https.checked } }));
      if (job) showJob(server.id, job, { onDone: load });
    });
  }

  // ---------- page ----------

  function draw() {
    const online = info.status === 'online';
    const tabs = [
      ['collections', `Collections <span class="muted">${Object.keys(info.collections || {}).length}/${collections.length}</span>`],
      ['keys', `API keys <span class="muted">${(info.keys || []).length}</span>`],
      ['settings', 'Settings'],
    ];
    el.innerHTML = `${head(
      `${esc(info.name)} <span class="badge ${online ? 'ok' : 'bad'}" style="vertical-align:middle">${esc(info.status)}</span>`,
      `Database <span class="mono">${esc(dbName)}</span> · ${
        info.url ? `<a class="mono" href="${esc(info.url)}/health" target="_blank" rel="noopener">${esc(info.url)}</a>` : info.port ? `<span class="mono">private: 127.0.0.1:${info.port} on the server</span>` : 'not set up yet'
      }`,
      `${siblings.length > 1 ? `<select id="ws-api" title="This database has ${siblings.length} APIs">${siblings.map((a) => `<option value="${esc(a.name)}" ${a.name === info.name ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : ''}
       ${canEdit && !info.url && info.port ? '<button class="btn-primary" data-action="da-publish">Publish on a domain</button>' : ''}
       <a class="btn" href="#/s/${server.id}/databases">Open in Databases</a>`,
    )}
      ${statusNotice()}
      ${canEdit ? '' : '<div class="notice" style="margin-bottom:12px">You have <b>view</b> access to this database: you can read the API setup and docs, but not change it.</div>'}
      <div class="tabs">${tabs.map(([id, label]) => `<button class="${nav.section === id ? 'active' : ''}" data-action="section" data-section="${id}">${label}</button>`).join('')}</div>
      <div id="ws-body"></div>`;
    el.querySelector('#ws-api')?.addEventListener('change', (e) => {
      rememberApi(server, dbName, e.target.value);
      el.innerHTML = loadingHtml();
      load();
    });
    drawSection();
  }

  function statusNotice() {
    if (info.status === 'online') return '';
    if (info.status === 'not running') {
      return `<div class="notice warn" style="margin-bottom:12px">The setup of this API did not finish (for example Node.js or PM2 was missing).
        ${canEdit ? '<div class="row" style="margin-top:8px"><button class="btn-primary btn-sm" data-action="da-finish">Finish setup</button><span class="small muted">Installs anything missing and starts the API. Collections and keys are kept.</span></div>' : ''}</div>`;
    }
    return `<div class="notice warn" style="margin-bottom:12px">The API service is ${esc(info.status)}. ${
      can('nodeapps') ? `Open <a href="#/s/${server.id}/nodeapps">Node Apps</a> → ${esc(info.name)} → Logs to see why.` : 'Ask the owner to check its logs in Node Apps.'
    }</div>`;
  }

  function drawSection() {
    const body = el.querySelector('#ws-body');
    if (nav.section === 'keys') body.innerHTML = keysSection();
    else if (nav.section === 'settings') body.innerHTML = settingsSection();
    else body.innerHTML = collectionsSection();
    if (nav.section === 'collections') bindTry();
    if (!canEdit) lockDown(body);
    syncHash();
  }

  // View access: keep everything readable, remove anything that changes the API.
  function lockDown(root) {
    root.querySelectorAll('[data-edit]').forEach((b) => b.remove());
    root.querySelectorAll('select[data-endpoint], #da-hidden, #da-readonly, #da-required, #da-timestamps, #da-settings input, #da-settings textarea').forEach((x) => (x.disabled = true));
    root.querySelector('#da-try-auth option[value=console]')?.remove();
  }

  // ---------- collections ----------

  function collectionsSection() {
    const exposed = info.collections || {};
    const names = [...new Set([...Object.keys(exposed), ...collections.map((c) => c.name)])].sort();
    const count = (n) => collections.find((c) => c.name === n)?.count;
    const summary = (c) => {
      const modes = Object.values(c.endpoints || {});
      const pub = modes.filter((m) => m === 'public').length;
      const key = modes.filter((m) => m === 'key').length;
      return `${pub ? `🌐 ${pub}` : ''} ${key ? `🔑 ${key}` : ''}`.trim() || 'all off';
    };
    return `
      <div class="grid api-ws">
        <div class="card flush">
          <div class="card-head"><h3 style="margin:0">Collections</h3></div>
          <div class="api-cols">${
            names
              .map(
                (n) => `<a href="#" class="api-col ${n === nav.col ? 'active' : ''}" data-action="pick" data-col="${esc(n)}">
                  <span class="grow mono">${esc(n)}</span>
                  ${exposed[n] ? `<span class="small">${summary(exposed[n])}</span>` : '<span class="small muted">not exposed</span>'}
                  ${count(n) != null ? `<span class="small muted" style="margin-left:6px" title="documents">${count(n)} docs</span>` : ''}
                </a>`,
              )
              .join('') || '<p class="muted small" style="padding:0 16px">This database has no collections yet. Create one in Databases.</p>'
          }</div>
          <p class="small muted" style="padding:0 16px">🌐 public endpoints · 🔑 endpoints that need a key</p>
        </div>
        <div>${nav.col ? collectionPanel(nav.col) : '<div class="card empty">Pick a collection on the left.</div>'}</div>
      </div>`;
  }

  function collectionPanel(col) {
    const c = info.collections?.[col];
    if (!c) {
      return `<div class="card">
        <h2 style="margin-top:0">${esc(col)}</h2>
        <p class="muted">This collection is not available through the API.</p>
        ${
          canEdit
            ? `<p class="small muted">Choose a starting point; you can change every endpoint afterwards.</p>
          <div class="row">${Object.entries(PRESETS)
            .map(([id, p]) => `<button class="${id === 'recommended' ? 'btn-primary' : ''}" data-edit data-action="da-expose" data-preset="${id}">${esc(p.label)}</button>`)
            .join('')}</div>`
            : ''
        }
      </div>`;
    }
    return `
      <div class="row" style="margin-bottom:6px"><h2 class="grow mono" style="margin:0">/api/${esc(col)}</h2>
        <a class="btn btn-sm" href="#/s/${server.id}/databases">Documents</a></div>
      <div class="tabs">${SUBS.map(([id, label]) => `<button class="${nav.sub === id ? 'active' : ''}" data-action="sub" data-sub="${id}">${label}</button>`).join('')}</div>
      ${nav.sub === 'try' ? tryPanel(col, c) : nav.sub === 'docs' ? docsHtml(info, col, c) : endpointsPanel(col, c)}`;
  }

  function endpointsPanel(col, c) {
    return `
      <div class="card flush" style="margin-bottom:12px">
        <div class="card-head"><h3 style="margin:0">Endpoints</h3>
          <div class="row">${Object.entries(PRESETS).map(([id, p]) => `<button class="btn-sm" data-edit data-action="da-preset" data-preset="${id}">${esc(p.label)}</button>`).join('')}</div></div>
        <div class="table-wrap"><table><tbody>${ENDPOINTS.map(
          ([id, method, suffix, desc]) => `<tr>
            <td style="width:80px"><span class="badge method-${method.toLowerCase()}">${method}</span></td>
            <td class="mono small">/api/${esc(col)}${suffix}</td>
            <td class="small muted ep-desc">${desc}</td>
            <td class="ep-mode"><select data-endpoint="${id}">${Object.entries(MODE_LABEL).map(([m, l]) => `<option value="${m}" ${c.endpoints[id] === m ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
          </tr>`,
        ).join('')}</tbody></table></div>
      </div>
      <div class="card">
        <h3 style="margin-top:0">Field rules</h3>
        ${sampleFields.length ? `<p class="small muted" style="margin-top:0">Fields seen in this collection: ${sampleFields.map((f) => `<span class="mono">${esc(f)}</span>`).join(', ')}</p>` : ''}
        <div class="form-grid">
          <label class="field"><span>Hidden fields</span><input id="da-hidden" value="${esc((c.hidden || []).join(', '))}" placeholder="password, internalNotes"><small>Never returned, and cannot be filtered on.</small></label>
          <label class="field"><span>Read-only fields</span><input id="da-readonly" value="${esc((c.readonly || []).join(', '))}" placeholder="ownerId, sku"><small>Ignored when someone creates or updates.</small></label>
          <label class="field"><span>Required fields</span><input id="da-required" value="${esc((c.required || []).join(', '))}" placeholder="name, email"><small>Creating fails without them.</small></label>
          <label class="check" style="margin-top:22px"><input type="checkbox" id="da-timestamps" ${c.timestamps ? 'checked' : ''}> Add createdAt / updatedAt automatically</label>
        </div>
        <div class="row"><button class="btn-primary" data-edit data-action="da-save">Save endpoints and rules</button><span class="small muted">Applies in about 2 seconds, no restart.</span>
          <span class="grow"></span><button class="btn-sm btn-danger" data-edit data-action="da-unexpose">Stop exposing ${esc(col)}</button></div>
      </div>`;
  }

  function tryPanel(col, c) {
    const eps = ENDPOINTS.filter(([id]) => c.endpoints[id] !== 'off');
    return `
      <div class="card" style="margin-bottom:12px">
        <div class="form-grid">
          <label class="field"><span>Endpoint</span><select id="da-try-ep">${eps.map(([id, m, s, d]) => `<option value="${id}">${m} /api/${esc(col)}${s} · ${d}</option>`).join('') || '<option value="">(all endpoints are off)</option>'}</select></label>
          <label class="field"><span>Send as</span><select id="da-try-auth"><option value="none">The public (no key)</option><option value="console">Serverboy test key (full access)</option></select>
            <small>"The public" shows exactly what anyone on the internet gets.</small></label>
          <label class="field" id="da-try-id-f"><span>Document id</span><input id="da-try-id" class="mono" placeholder="paste an _id"></label>
          <label class="field" id="da-try-q-f"><span>Query</span><input id="da-try-q" class="mono" placeholder="limit=5&amp;sort=-createdAt"></label>
        </div>
        <label class="field" id="da-try-body-f"><span>Body (JSON)</span><textarea id="da-try-body" class="mono" rows="8">${esc(sampleBody())}</textarea></label>
        <div class="row"><button class="btn-primary" data-action="da-send">Send</button><span id="da-try-status"></span><span class="grow"></span><button class="btn-sm hidden" id="da-try-copy" data-action="da-copy">Copy as curl</button></div>
        <pre class="log hidden" id="da-try-out" style="margin-top:10px;max-height:60vh"></pre>
      </div>
      <div class="card flush">
        <div class="card-head"><h3 style="margin:0">Recent requests</h3><span class="small muted">this visit only</span></div>
        <table class="small"><tbody id="da-history">${historyRows()}</tbody></table>
      </div>`;
  }

  function sampleBody() {
    const fields = sampleFields.filter((f) => !['createdAt', 'updatedAt'].includes(f)).slice(0, 4);
    if (!fields.length) return '{\n  "name": "Example"\n}';
    return JSON.stringify(Object.fromEntries(fields.map((f) => [f, ''])), null, 2);
  }

  function historyRows() {
    return (
      history
        .map(
          (h, i) => `<tr><td style="width:70px"><span class="badge ${h.status < 300 ? 'ok' : h.status < 500 ? 'warn' : 'bad'}">${h.status || '-'}</span></td>
            <td class="mono"><a href="#" data-action="da-show" data-i="${i}">${esc(h.method)} ${esc(h.path)}</a></td>
            <td class="muted">${h.auth === 'console' ? 'test key' : 'public'}</td><td class="muted">${h.ms} ms</td></tr>`,
        )
        .join('') || '<tr><td class="empty">Nothing sent yet.</td></tr>'
    );
  }

  function bindTry() {
    const ep = el.querySelector('#da-try-ep');
    if (!ep) return;
    const sync = () => {
      const id = ep.value;
      el.querySelector('#da-try-id-f').classList.toggle('hidden', !['get', 'update', 'replace', 'delete'].includes(id));
      el.querySelector('#da-try-q-f').classList.toggle('hidden', !['list', 'count'].includes(id));
      el.querySelector('#da-try-body-f').classList.toggle('hidden', !['create', 'update', 'replace'].includes(id));
    };
    ep.addEventListener('change', sync);
    sync();
  }

  function showResult(h) {
    const out = el.querySelector('#da-try-out');
    el.querySelector('#da-try-status').innerHTML = `<span class="badge ${h.status < 300 ? 'ok' : h.status < 500 ? 'warn' : 'bad'}">${h.status || 'no answer'}</span> <span class="small muted">${h.ms} ms · ${esc(h.method)} ${esc(h.path)}</span>`;
    out.classList.remove('hidden');
    out.textContent = typeof h.response === 'string' ? h.response : JSON.stringify(h.response, null, 2);
    el.querySelector('#da-try-copy').classList.toggle('hidden', !info.url);
    el.querySelector('#da-try-copy').dataset.i = String(history.indexOf(h));
  }

  async function saveCollection(col, endpoints) {
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

  // ---------- keys ----------

  function keysSection() {
    const keys = info.keys || [];
    return `
      <div class="card flush" style="margin-bottom:12px">
        <div class="card-head"><h3 style="margin:0">API keys</h3><button class="btn-sm btn-primary" data-edit data-action="da-newkey">+ New key</button></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Access</th><th>Created</th><th></th></tr></thead>
          <tbody>${
            keys
              .map(
                (k) => `<tr><td><b>${esc(k.label)}</b><div class="small muted mono">${esc(k.prefix)}…</div></td>
                  <td class="small">${Object.entries(k.access).map(([cName, ops]) => `${cName === '*' ? 'all collections' : `<span class="mono">${esc(cName)}</span>`}: ${ops.map(esc).join(', ')}`).join('<br>')}</td>
                  <td class="small muted">${new Date(k.createdAt).toLocaleDateString()}${k.createdBy ? ` by ${esc(k.createdBy)}` : ''}</td>
                  <td class="actions"><button class="btn-sm btn-danger" data-edit data-action="da-revoke" data-id="${esc(k.id)}">Revoke</button></td></tr>`,
              )
              .join('') || '<tr><td colspan="4" class="empty">No keys yet. Endpoints set to "API key needed" only work with a key.</td></tr>'
          }</tbody>
        </table></div>
      </div>
      <div class="card">
        <h3 style="margin-top:0">Using a key</h3>
        <p class="small">Send it in the <span class="mono">x-api-key</span> header (or <span class="mono">Authorization: Bearer …</span>). Keep it in your app's environment variables, e.g. <span class="mono">DATA_API_KEY</span>.</p>
        <pre class="log">${esc(`const res = await fetch("${info.url || 'https://YOUR-API-ADDRESS'}/api/COLLECTION", {
  headers: { "x-api-key": process.env.DATA_API_KEY },
});`)}</pre>
        <p class="small muted" style="margin-bottom:0">Keys are stored only as a fingerprint: a lost key cannot be shown again, create a new one and revoke the old one. <b>Never put a key with write access into web page code.</b></p>
      </div>`;
  }

  // ---------- settings ----------

  function settingsSection() {
    return `
      <div class="grid grid-2" style="align-items:start">
        <div class="card">
          <h3 style="margin-top:0">Access from browsers and limits</h3>
          <form id="da-settings">
            <label class="field"><span>Websites allowed to call this API from the browser (CORS)</span>
              <textarea name="cors" rows="4" placeholder="https://myshop.com">${esc((info.cors || []).join('\n'))}</textarea>
              <small>One per line, like https://myshop.com. Use * to allow any website.</small></label>
            <label class="field"><span>Requests per minute per visitor / key</span><input name="rateLimitPerMinute" type="number" min="0" value="${esc(info.rateLimitPerMinute)}"><small>0 = no limit.</small></label>
            <label class="field"><span>Most documents per page</span><input name="maxLimit" type="number" min="1" value="${esc(info.maxLimit)}"></label>
            <button class="btn-primary" data-edit>Save settings</button>
          </form>
        </div>
        <div>
          <div class="card" style="margin-bottom:12px">
            <h3 style="margin-top:0">Address</h3>
            <table class="small"><tbody>
              <tr><td class="muted" style="width:140px">Public address</td><td class="mono">${info.url ? `<a href="${esc(info.url)}/health" target="_blank" rel="noopener">${esc(info.url)}</a>` : 'none (private to the server)'}</td></tr>
              <tr><td class="muted">On the server</td><td class="mono">http://127.0.0.1:${esc(info.port)}</td></tr>
              <tr><td class="muted">Folder</td><td class="mono">/var/www/${esc(info.name)}</td></tr>
              <tr><td class="muted">Process (PM2)</td><td><span class="mono">${esc(info.name)}</span> <span class="badge ${info.status === 'online' ? 'ok' : 'bad'}">${esc(info.status)}</span></td></tr>
            </tbody></table>
            ${!info.url && info.port ? '<button class="btn-primary" data-edit data-action="da-publish" style="margin-top:10px">Publish on a domain</button>' : ''}
          </div>
          <div class="card" style="margin-bottom:12px">
            <h3 style="margin-top:0">Maintenance</h3>
            <div class="row">
              <button data-edit data-action="da-upgrade">Update engine</button>
              ${info.status !== 'online' ? '<button data-edit data-action="da-finish">Finish setup / restart</button>' : ''}
              ${can('nodeapps') ? `<a class="btn" href="#/s/${server.id}/nodeapps">Logs in Node Apps</a>` : ''}
            </div>
            <p class="small muted" style="margin-bottom:0">Update engine installs the API code that ships with this Serverboy version. Collections, keys and settings are kept.</p>
          </div>
          <div class="card" data-edit style="border-color:var(--bad)">
            <h3 style="margin-top:0;color:var(--bad)">Danger zone</h3>
            <p class="small">Deleting the API stops every app that uses it and deletes all its keys. The data in <span class="mono">${esc(dbName)}</span> is not touched.</p>
            <button class="btn-danger" data-action="da-delete">Delete API</button>
          </div>
        </div>
      </div>`;
  }

  // ---------- actions ----------

  el.addEventListener('submit', async (e) => {
    if (e.target.id !== 'da-settings') return;
    const f = e.target;
    const ok = await run(f.querySelector('button'), () =>
      api(`${base}/${info.name}/settings`, { method: 'PUT', body: { cors: f.cors.value, rateLimitPerMinute: f.rateLimitPerMinute.value, maxLimit: f.maxLimit.value } }),
    );
    if (ok) {
      Object.assign(info, ok);
      toast('Settings saved. Live in about 2 seconds.', 'ok');
    }
  });

  onAction(el, {
    section: ({ section }) => {
      nav.section = section;
      if (section === 'collections' && !nav.col) nav.col = Object.keys(info.collections || {})[0] || collections[0]?.name;
      draw();
    },
    pick: async ({ col }) => {
      nav.col = col;
      el.querySelector('#ws-body').innerHTML = loadingHtml();
      await loadSample();
      drawSection();
    },
    sub: ({ sub }) => {
      nav.sub = sub;
      drawSection();
    },
    'da-expose': async ({ preset }, btn) => {
      const ok = await run(btn, () => saveCollection(nav.col, PRESETS[preset].modes), `${nav.col} is now available through the API`);
      if (ok) {
        nav.sub = 'endpoints';
        draw();
      }
    },
    'da-preset': ({ preset }) => {
      for (const s of el.querySelectorAll('select[data-endpoint]')) s.value = PRESETS[preset].modes[s.dataset.endpoint];
      toast('Preset applied. Click Save to use it.');
    },
    'da-save': async (_d, btn) => {
      const endpoints = Object.fromEntries([...el.querySelectorAll('select[data-endpoint]')].map((s) => [s.dataset.endpoint, s.value]));
      const ok = await run(btn, () => saveCollection(nav.col, endpoints), 'Saved. Live in about 2 seconds.');
      if (ok) draw();
    },
    'da-unexpose': async () => {
      if (!(await confirmDialog(`Stop exposing ${nav.col}? Its endpoints stop working. The data itself is not touched.`, { danger: true, confirmLabel: 'Stop exposing' }))) return;
      const ok = await run(null, () => api(`${base}/${info.name}/collections/${encodeURIComponent(nav.col)}`, { method: 'DELETE' }), 'Done');
      if (ok) load();
    },
    'da-send': async (_d, btn) => {
      const col = nav.col;
      const id = el.querySelector('#da-try-ep').value;
      if (!id) return;
      const [, method, suffix] = ENDPOINTS.find((x) => x[0] === id);
      const docId = el.querySelector('#da-try-id').value.trim();
      if (suffix === '/:id' && !docId) return toast('Paste a document id first (list the collection to find one).', 'error');
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
      const auth = el.querySelector('#da-try-auth').value;
      el.querySelector('#da-try-status').innerHTML = '<span class="spinner"></span>';
      const r = await run(btn, () => api(`${base}/${info.name}/test`, { method: 'POST', body: { method, path: reqPath, body, auth } }));
      if (!r) return (el.querySelector('#da-try-status').innerHTML = '');
      const h = { method, path: reqPath, body, auth, status: r.status, ms: r.ms, response: r.body };
      history.unshift(h);
      history.splice(10);
      el.querySelector('#da-history').innerHTML = historyRows();
      showResult(h);
    },
    'da-show': ({ i }) => showResult(history[i]),
    'da-copy': async ({ i }) => {
      const h = history[i];
      if (!h || !info.url) return;
      const parts = [`curl -X ${h.method} "${info.url}${h.path}"`];
      if (h.auth === 'console') parts.push('-H "x-api-key: YOUR_API_KEY"');
      if (h.body) parts.push(`-H "content-type: application/json" -d '${h.body.replace(/\s*\n\s*/g, ' ').replace(/'/g, "'\\''")}'`);
      try {
        await navigator.clipboard.writeText(parts.join(' \\\n  '));
        toast('Copied', 'ok');
      } catch {
        modal({ title: 'curl', body: `<pre class="log">${esc(parts.join(' \\\n  '))}</pre>`, actions: [{ label: 'Close' }] });
      }
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
          .map((cName) => `<tr><td class="mono">${esc(cName)}</td>${['read', 'create', 'update', 'delete'].map((op) => `<td><input type="checkbox" data-c="${esc(cName)}" data-op="${op}" ${cName === nav.col && op === 'read' ? 'checked' : ''}></td>`).join('')}</tr>`)
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
                  <p class="small muted">Send it in the <span class="mono">x-api-key</span> header. ${Object.values(access).some((o) => o.some((x) => x !== 'read')) ? 'It can change data: use it only from a backend, never in web page code.' : ''}</p>`,
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
      const ok = await run(null, () => api(`${base}/${info.name}/keys/${id}`, { method: 'DELETE' }), 'Key revoked');
      if (ok) load();
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
    'da-upgrade': async () => {
      if (!(await confirmDialog(`Update ${info.name} to the API engine that ships with this Serverboy version? It restarts for a second.`, { confirmLabel: 'Update' }))) return;
      const job = await run(null, () => api(`${base}/${info.name}/upgrade`, { method: 'POST' }));
      if (job) showJob(server.id, job, { onDone: load });
    },
    'da-delete': async () => {
      if (!(await confirmDialog(`Delete the API service ${info.name}? Every app using it stops working, and all its keys are deleted. The data in ${dbName} is NOT touched.`, { danger: true, confirmLabel: 'Delete API' }))) return;
      const ok = await run(null, () => api(`${base}/${info.name}`, { method: 'DELETE' }), 'API deleted');
      if (ok) {
        rememberApi(server, dbName, '');
        location.hash = `#/s/${server.id}/apis`;
      }
    },
  });

  load();
}
