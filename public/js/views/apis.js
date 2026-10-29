// APIs: a full page for the Data API services (one per MongoDB database).
//   #/s/<id>/apis                                   all API services, and databases without one
//   #/s/<id>/apis/<db>                              that database's API (or the form to create it)
//   #/s/<id>/apis/<db>/portal/<endpoint>            API portal: every endpoint, reference, .txt export
//   #/s/<id>/apis/<db>/collections/<col>/<sub>      a collection: endpoints | custom | try | docs
//   #/s/<id>/apis/<db>/keys | /settings             API keys, settings and maintenance
import { api, esc, toast, run, modal, confirmDialog, formDialog, showJob, onAction, loadingHtml, errorHtml, hasAll, can } from '../ui.js';
import { ENDPOINTS, PRESETS, MODE_LABEL, suggestedDomain } from './data-api.js';
import { catalog, inferFields, endpointHtml, modelHtml, docsText, downloadText, KIND_LABEL, STANDARD_GROUP } from './api-docs.js';

const SYSTEM_DBS = new Set(['admin', 'local', 'config', 'serverboy']);
const SUBS = [
  ['endpoints', 'Endpoints & rules'],
  ['custom', 'Custom endpoints'],
  ['try', 'Try it'],
  ['docs', 'Docs'],
];

export async function render(el, { server, rest }) {
  const [db, section, col, sub] = rest.map((x) => decodeURIComponent(x));
  if (!db) return renderList(el, server);
  return renderWorkspace(el, server, { db, section: section || 'portal', col: section === 'portal' ? undefined : col, focus: section === 'portal' ? col : undefined, sub: sub || 'endpoints' });
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
  const samples = {}; // collection -> sample documents (for field types in the docs)
  const history = []; // Try it requests in this visit
  const portal = { selected: null, search: '', showOff: false }; // selected: Set of endpoint keys

  // Keep the address bar in step without re-rendering the page.
  function syncHash() {
    const parts = [nav.section];
    if (nav.section === 'collections' && nav.col) parts.push(encodeURIComponent(nav.col), nav.sub);
    if (nav.section === 'portal' && nav.focus) parts.push(encodeURIComponent(nav.focus));
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

  async function samplesFor(col) {
    if (!samples[col]) {
      const r = await api(`/servers/${server.id}/mongo/find`, { method: 'POST', body: { db: dbName, collection: col, limit: 20 } }).catch(() => ({ docs: [] }));
      samples[col] = r.docs || [];
    }
    return samples[col];
  }

  async function loadSample() {
    sampleFields = [];
    if (nav.section === 'portal') await Promise.all(Object.keys(info.collections || {}).map(samplesFor));
    if (!nav.col) return;
    sampleFields = [...new Set((await samplesFor(nav.col)).flatMap((d) => Object.keys(d)))].filter((f) => f !== '_id');
  }

  const fieldsOf = (col) => inferFields(samples[col] || [], info.collections?.[col]);

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
    const all = catalog(info);
    const tabs = [
      ['portal', `API portal <span class="muted">${all.filter((e) => e.mode !== 'off').length}</span>`],
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
    const usesCustom = Object.values(info.collections || {}).some((c) => (c.custom || []).length);
    const oldEngine = info.engine && info.latestEngine && info.engine < info.latestEngine;
    if (info.status === 'online') {
      return oldEngine
        ? `<div class="notice ${usesCustom ? 'warn' : ''}" style="margin-bottom:12px">This API runs engine v${info.engine}; v${info.latestEngine} adds <b>custom endpoints</b>.${usesCustom ? ' Your custom endpoints answer 404 until you update.' : ''}
          ${canEdit ? '<button class="btn-sm btn-primary" data-action="da-upgrade" style="margin-left:8px">Update engine</button>' : ''}</div>`
        : '';
    }
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
    if (nav.section === 'portal') {
      body.innerHTML = portalSection();
      bindPortal();
    } else if (nav.section === 'keys') body.innerHTML = keysSection();
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
      const modes = [...Object.values(c.endpoints || {}), ...(c.custom || []).map((x) => x.mode)];
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
      <div class="tabs">${SUBS.map(([id, label]) => `<button class="${nav.sub === id ? 'active' : ''}" data-action="sub" data-sub="${id}">${label}${id === 'custom' && (c.custom || []).length ? ` <span class="muted">${c.custom.length}</span>` : ''}</button>`).join('')}</div>
      ${nav.sub === 'try' ? tryPanel(col, c) : nav.sub === 'docs' ? collectionDocs(col) : nav.sub === 'custom' ? customPanel(col, c) : endpointsPanel(col, c)}`;
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
    const eps = ENDPOINTS.filter(([id]) => c.endpoints[id] !== 'off').map(([id, m, s, d]) => [id, m, s, d]);
    for (const x of c.custom || []) if (x.mode !== 'off') eps.push([`v:${x.id}`, x.kind === 'create' ? 'POST' : 'GET', `/views/${x.id}`, x.title || x.id]);
    return `
      <div class="card" style="margin-bottom:12px">
        <div class="form-grid">
          <label class="field"><span>Endpoint</span><select id="da-try-ep">${eps.map(([id, m, s, d]) => `<option value="${id}">${m} /api/${esc(col)}${s} · ${d}</option>`).join('') || '<option value="">(all endpoints are off)</option>'}</select></label>
          <label class="field"><span>Send as</span><select id="da-try-auth"><option value="none">The public (no key)</option><option value="console">Serverboy test key (full access)</option></select>
            <small>"The public" shows exactly what anyone on the internet gets.</small></label>
          <label class="field" id="da-try-id-f"><span>Document id</span><input id="da-try-id" class="mono" placeholder="paste an _id"></label>
          <label class="field" id="da-try-q-f"><span>Query</span><input id="da-try-q" class="mono" placeholder="limit=5&amp;sort=-createdAt"><small id="da-try-q-help"></small></label>
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
      const custom = customOf(id);
      el.querySelector('#da-try-id-f').classList.toggle('hidden', !['get', 'update', 'replace', 'delete'].includes(id));
      el.querySelector('#da-try-q-f').classList.toggle('hidden', !(['list', 'count'].includes(id) || (custom && custom.kind !== 'create')));
      el.querySelector('#da-try-body-f').classList.toggle('hidden', !(['create', 'update', 'replace'].includes(id) || custom?.kind === 'create'));
      const params = custom?.params || [];
      const q = el.querySelector('#da-try-q');
      q.placeholder = custom ? params.map((x) => `${x.name}=…`).join('&') || 'page=1' : 'limit=5&sort=-createdAt';
      el.querySelector('#da-try-q-help').textContent = custom && params.length ? `Parameters: ${params.map((x) => `${x.name} (${x.type}${x.required ? ', required' : ''})`).join(', ')}` : '';
    };
    ep.addEventListener('change', sync);
    sync();
  }

  const customOf = (tryId) => (String(tryId).startsWith('v:') ? (info.collections?.[nav.col]?.custom || []).find((x) => x.id === tryId.slice(2)) : null);

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

  // ---------- custom endpoints ----------

  function customPanel(col, c) {
    const list = c.custom || [];
    const groups = [...new Set(list.map((x) => x.group || 'Custom'))];
    return `
      <div class="card flush" style="margin-bottom:12px">
        <div class="card-head"><h3 style="margin:0">Custom endpoints for ${esc(col)}</h3><button class="btn-sm btn-primary" data-edit data-action="cu-edit">+ New endpoint</button></div>
        ${
          list.length
            ? groups
                .map(
                  (g) => `<div class="pt-group" style="padding:8px 16px 0">${esc(g)}</div>
              <div class="table-wrap"><table><tbody>${list
                .filter((x) => (x.group || 'Custom') === g)
                .map(
                  (x) => `<tr>
                    <td style="width:80px"><span class="badge method-${x.kind === 'create' ? 'post' : 'get'}">${x.kind === 'create' ? 'POST' : 'GET'}</span></td>
                    <td><b>${esc(x.title || x.id)}</b><div class="mono small muted">/api/${esc(col)}/views/${esc(x.id)}${(x.params || []).length ? `?${x.params.map((p) => esc(p.name)).join('&amp;')}` : ''}</div></td>
                    <td class="small muted ep-desc">${esc(KIND_LABEL[x.kind] || x.kind)}</td>
                    <td class="small">${x.mode === 'key' ? '🔑 key' : x.mode === 'public' ? '🌐 public' : 'off'}</td>
                    <td class="actions"><button class="btn-sm" data-action="cu-try" data-id="${esc(x.id)}">Try</button><button class="btn-sm" data-edit data-action="cu-edit" data-id="${esc(x.id)}">Edit</button><button class="btn-sm btn-danger" data-edit data-action="cu-delete" data-id="${esc(x.id)}">Delete</button></td>
                  </tr>`,
                )
                .join('')}</tbody></table></div>`,
                )
                .join('')
            : `<div class="empty">No custom endpoints yet.</div>`
        }
      </div>
      <div class="card">
        <h3 style="margin-top:0">What are custom endpoints?</h3>
        <p class="small" style="margin-top:0">Extra APIs on top of the standard seven, each with its own address, access and group. A collection can have as many as you need, for example:</p>
        <ul class="small" style="padding-left:18px">
          <li><b>Saved queries</b>: <span class="mono">GET /api/${esc(col)}/views/published?author=ravi</span> returns only published items by that author, newest first, with only the fields you choose.</li>
          <li><b>Counters and lookups</b>: how many items match, or the first match (e.g. a product by its slug).</li>
          <li><b>Forms</b>: <span class="mono">POST /api/${esc(col)}/views/signup</span> accepts only the fields you list and adds fixed values, so a public form cannot write anything else.</li>
        </ul>
        <p class="small muted" style="margin-bottom:0">Group them (e.g. "Website", "Mobile app", "Admin") to keep the API portal and the downloaded docs tidy.</p>
      </div>`;
  }

  const QUICK = {
    blank: { title: '', id: '', kind: 'list', mode: 'public', filter: {}, sort: '-createdAt', params: [] },
    byField: { title: 'Find by a field', id: 'by-field', kind: 'list', mode: 'public', filter: { status: '{{status}}' }, sort: '-createdAt', params: [{ name: 'status', type: 'string', required: true, description: 'Value to match' }] },
    latest: { title: 'Latest items', id: 'latest', kind: 'list', mode: 'public', filter: {}, sort: '-createdAt', limit: 10, params: [] },
    lookup: { title: 'Look up one by slug', id: 'by-slug', kind: 'one', mode: 'public', filter: { slug: '{{slug}}' }, params: [{ name: 'slug', type: 'string', required: true, description: 'The slug, e.g. blue-shirt' }] },
    form: { title: 'Public form', id: 'submit', kind: 'create', mode: 'public', fields: 'name,email,message', required: ['name', 'email'], set: { status: 'new' } },
  };

  function customEditor(col, existing) {
    const groups = [...new Set(Object.values(info.collections || {}).flatMap((c) => (c.custom || []).map((x) => x.group)).filter(Boolean))];
    const box = document.createElement('div');
    const drawForm = (x) => {
      box.innerHTML = `
        ${existing ? '' : `<div class="row small" style="margin-bottom:10px"><span class="muted">Start from:</span>${Object.entries({ blank: 'Blank', byField: 'Find by a field', latest: 'Latest items', lookup: 'Look up one', form: 'Public form' })
          .map(([k, l]) => `<button type="button" class="btn-sm" data-quick="${k}">${l}</button>`)
          .join('')}</div>`}
        <div class="form-grid">
          <label class="field"><span>Title</span><input name="title" value="${esc(x.title || '')}" placeholder="Published posts"></label>
          <label class="field"><span>Path name</span><input name="id" class="mono" value="${esc(x.id || '')}" placeholder="published"><small>/api/${esc(col)}/views/<b>name</b></small></label>
          <label class="field"><span>Group</span><input name="group" value="${esc(x.group || '')}" list="cu-groups" placeholder="Website"><datalist id="cu-groups">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist></label>
          <label class="field"><span>Access</span><select name="mode">${Object.entries(MODE_LABEL).map(([m, l]) => `<option value="${m}" ${x.mode === m ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="field"><span>What it does</span><select name="kind">${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}" ${x.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="field cu-read cu-many"><span>Most documents per page</span><input name="limit" type="number" min="1" value="${esc(x.limit || 20)}"></label>
        </div>
        <label class="field"><span>Description</span><textarea name="description" rows="2" placeholder="What this endpoint is for. Shown in the portal and the downloaded docs.">${esc(x.description || '')}</textarea></label>
        <div class="cu-read">
          <label class="field"><span>Filter (MongoDB JSON)</span><textarea name="filter" class="mono" rows="4">${esc(JSON.stringify(x.filter || {}, null, 2))}</textarea>
            <small>Which documents it returns. Put <span class="mono">"{{name}}"</span> where a caller's value goes, e.g. <span class="mono">{ "status": "published", "author": "{{author}}" }</span> or <span class="mono">{ "price": { "$lte": "{{max}}" } }</span>. Empty <span class="mono">{}</span> = all.</small></label>
          <div class="row" style="margin-bottom:6px"><b class="small">Parameters</b><span class="grow"></span><button type="button" class="btn-sm" data-cu="detect">Add the ones used in the filter</button><button type="button" class="btn-sm" data-cu="addparam">+ Parameter</button></div>
          <table class="small cu-params"><thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Default</th><th>Description</th><th></th></tr></thead><tbody>${(x.params || []).map(paramRow).join('')}</tbody></table>
          <div class="form-grid" style="margin-top:10px">
            <label class="field cu-sorted"><span>Sort</span><input name="sort" class="mono" value="${esc(x.sort || '')}" placeholder="-createdAt"><small>Field names, - for newest / largest first.</small></label>
            <label class="field"><span>Return only these fields</span><input name="fields" class="mono" value="${esc(x.kind === 'create' ? '' : x.fields || '')}" placeholder="title,slug,price"><small>Empty = all (hidden fields are never returned).</small></label>
          </div>
        </div>
        <div class="cu-create">
          <label class="field"><span>Accepted fields</span><input name="cfields" class="mono" value="${esc(x.kind === 'create' ? x.fields || '' : '')}" placeholder="name,email,message"><small>Anything else sent is ignored. Empty = any field (read-only rules still apply).</small></label>
          <label class="field"><span>Required fields</span><input name="required" class="mono" value="${esc((x.required || []).join(','))}" placeholder="name,email"><small>On top of the collection's required fields.</small></label>
          <label class="field"><span>Fixed values (JSON)</span><textarea name="set" class="mono" rows="3">${esc(JSON.stringify(x.set || {}, null, 2))}</textarea><small>Always saved, whatever is sent, e.g. <span class="mono">{ "status": "new", "source": "website" }</span>.</small></label>
        </div>`;
      sync();
    };
    function paramRow(p = {}) {
      return `<tr>
        <td><input data-p="name" class="mono" value="${esc(p.name || '')}" placeholder="author"></td>
        <td><select data-p="type">${['string', 'number', 'boolean', 'date', 'objectId'].map((t) => `<option ${p.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
        <td style="text-align:center"><input type="checkbox" data-p="required" ${p.required ? 'checked' : ''}></td>
        <td><input data-p="default" value="${esc(p.default ?? '')}"></td>
        <td><input data-p="description" value="${esc(p.description || '')}"></td>
        <td><button type="button" class="btn-sm btn-ghost" data-cu="rmparam">✕</button></td></tr>`;
    }
    function sync() {
      const kind = box.querySelector('[name=kind]').value;
      box.querySelectorAll('.cu-read').forEach((n) => n.classList.toggle('hidden', kind === 'create'));
      box.querySelectorAll('.cu-create').forEach((n) => n.classList.toggle('hidden', kind !== 'create'));
      box.querySelectorAll('.cu-many').forEach((n) => n.classList.toggle('hidden', kind !== 'list'));
      box.querySelectorAll('.cu-sorted').forEach((n) => n.classList.toggle('hidden', kind === 'count'));
    }
    box.addEventListener('change', (e) => e.target.name === 'kind' && sync());
    box.addEventListener('input', (e) => {
      // Suggest a path name from the title while the path is still untouched.
      if (e.target.name === 'title' && !existing) {
        const id = box.querySelector('[name=id]');
        if (!id.dataset.touched) id.value = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      }
      if (e.target.name === 'id') e.target.dataset.touched = '1';
    });
    box.addEventListener('click', (e) => {
      const q = e.target.closest('[data-quick]');
      if (q) return drawForm({ ...QUICK[q.dataset.quick], group: box.querySelector('[name=group]').value });
      const a = e.target.closest('[data-cu]')?.dataset.cu;
      const tbody = box.querySelector('.cu-params tbody');
      if (a === 'addparam') tbody.insertAdjacentHTML('beforeend', paramRow({ type: 'string', required: true }));
      if (a === 'rmparam') e.target.closest('tr').remove();
      if (a === 'detect') {
        const have = new Set([...tbody.querySelectorAll('[data-p=name]')].map((i) => i.value.trim()));
        const used = [...box.querySelector('[name=filter]').value.matchAll(/"\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}"/g)].map((m) => m[1]);
        const added = [...new Set(used)].filter((u) => !have.has(u));
        for (const u of added) tbody.insertAdjacentHTML('beforeend', paramRow({ name: u, type: 'string', required: true }));
        toast(added.length ? `Added ${added.join(', ')}` : 'No new {{parameters}} in the filter');
      }
    });
    drawForm(existing || QUICK.blank);
    const read = () => {
      const v = (n) => box.querySelector(`[name=${n}]`).value;
      const kind = v('kind');
      const parseJson = (text, label) => {
        try {
          return text.trim() ? JSON.parse(text) : {};
        } catch {
          throw new Error(`${label} is not valid JSON`);
        }
      };
      return {
        title: v('title'),
        id: v('id'),
        group: v('group'),
        mode: v('mode'),
        kind,
        description: v('description'),
        limit: v('limit'),
        filter: kind === 'create' ? {} : parseJson(v('filter'), 'The filter'),
        sort: v('sort'),
        fields: kind === 'create' ? v('cfields') : v('fields'),
        required: v('required'),
        set: kind === 'create' ? parseJson(v('set'), 'Fixed values') : {},
        params: [...box.querySelectorAll('.cu-params tbody tr')]
          .map((tr) => ({
            name: tr.querySelector('[data-p=name]').value.trim(),
            type: tr.querySelector('[data-p=type]').value,
            required: tr.querySelector('[data-p=required]').checked,
            default: tr.querySelector('[data-p=default]').value,
            description: tr.querySelector('[data-p=description]').value,
          }))
          .filter((p) => p.name),
      };
    };
    modal({
      title: existing ? `Edit ${col}/views/${existing.id}` : `New endpoint for ${col}`,
      wide: true,
      body: box,
      actions: [
        { label: 'Cancel' },
        {
          label: existing ? 'Save' : 'Create endpoint',
          className: 'btn-primary',
          onClick: async () => {
            const body = read();
            const cfg = await api(`${base}/${info.name}/collections/${encodeURIComponent(col)}/custom/${encodeURIComponent(existing?.id || body.id || 'new')}`, { method: 'PUT', body });
            info = { ...info, ...cfg };
            toast('Saved. Live in about 2 seconds.', 'ok');
            draw();
          },
        },
      ],
    });
  }

  // ---------- docs (one collection) ----------

  function collectionDocs(col) {
    const entries = catalog(info).filter((e) => e.col === col && e.mode !== 'off');
    const fields = fieldsOf(col);
    return `
      <div class="card" style="margin-bottom:12px">
        <div class="row"><h3 class="grow" style="margin:0">Data model: ${esc(col)}</h3>
          <button class="btn-sm btn-primary" data-action="pt-download" data-scope="col">Download ${esc(col)} docs (.txt)</button></div>
        <p class="small muted">From ${samples[col]?.length || 0} sample document(s); hidden fields are left out.</p>
        ${modelHtml(col, fields)}
      </div>
      ${entries.map((e) => endpointHtml(info, e, fields)).join('') || '<div class="card empty">All endpoints of this collection are off.</div>'}`;
  }

  // ---------- API portal ----------

  function portalEntries() {
    return catalog(info).filter((e) => portal.showOff || e.mode !== 'off');
  }

  function portalSection() {
    const entries = catalog(info);
    // Endpoints that are on start selected, including ones added since the portal was opened.
    portal.selected ||= new Set();
    portal.known ||= new Set();
    for (const e of entries) {
      if (!portal.known.has(e.key) && e.mode !== 'off') portal.selected.add(e.key);
      portal.known.add(e.key);
    }
    return `
      <div class="grid api-ws portal">
        <div class="card flush">
          <div style="padding:12px 12px 6px"><input id="pt-search" placeholder="Search endpoints…" value="${esc(portal.search)}"></div>
          <div class="row small" style="padding:0 16px 6px">
            <label class="check" style="margin:0"><input type="checkbox" id="pt-all"> Select all</label><span class="grow"></span>
            <label class="check" style="margin:0"><input type="checkbox" id="pt-off" ${portal.showOff ? 'checked' : ''}> Show turned-off</label>
          </div>
          <div id="pt-tree" class="pt-tree"></div>
        </div>
        <div>
          <div class="card pt-toolbar" style="margin-bottom:12px">
            <div class="row">
              <b id="pt-count"></b><span class="grow"></span>
              <button class="btn-primary" data-action="pt-download">⬇ Download .txt</button>
              <button data-action="pt-copy">Copy text</button>
              <button data-action="pt-preview">Preview</button>
            </div>
            <p class="small muted" style="margin:6px 0 0">Plain-text reference of the selected endpoints, with base URL, auth, data model, parameters, responses and curl examples. Paste it into an AI assistant (ChatGPT, Claude…), a README or a ticket.</p>
          </div>
          <div id="pt-main"></div>
        </div>
      </div>`;
  }

  function drawTree() {
    const tree = el.querySelector('#pt-tree');
    if (!tree) return;
    const qtext = portal.search.trim().toLowerCase();
    const list = portalEntries().filter((e) => !qtext || `${e.title} ${e.path} ${e.col} ${e.group} ${e.method} ${e.desc}`.toLowerCase().includes(qtext));
    const cols = [...new Set(list.map((e) => e.col))];
    tree.innerHTML =
      cols
        .map((col) => {
          const inCol = list.filter((e) => e.col === col);
          const groups = [...new Set(inCol.map((e) => e.group))].sort((a, b) => (a === STANDARD_GROUP ? 1 : b === STANDARD_GROUP ? -1 : a.localeCompare(b)));
          return `<div class="pt-col">
            <label class="check pt-colhead"><input type="checkbox" data-selcol="${esc(col)}" ${inCol.every((e) => portal.selected.has(e.key)) ? 'checked' : ''}> <span class="mono">${esc(col)}</span></label>
            ${groups
              .map(
                (g) => `<div class="pt-group">${esc(g)}</div>${inCol
                  .filter((e) => e.group === g)
                  .map(
                    (e) => `<div class="pt-ep ${nav.focus === e.key ? 'active' : ''} ${e.mode === 'off' ? 'off' : ''}">
                      <input type="checkbox" data-sel="${esc(e.key)}" ${portal.selected.has(e.key) ? 'checked' : ''}>
                      <a href="#" data-action="pt-focus" data-key="${esc(e.key)}"><span class="badge method-${e.method.toLowerCase()}">${e.method}</span> ${esc(e.title)}</a>
                      <span class="small">${e.mode === 'key' ? '🔑' : e.mode === 'public' ? '🌐' : ''}</span>
                    </div>`,
                  )
                  .join('')}`,
              )
              .join('')}
          </div>`;
        })
        .join('') || `<p class="small muted" style="padding:0 16px">${catalog(info).length ? 'Nothing matches.' : 'No collection is exposed yet. Open the Collections tab to expose one.'}</p>`;
    const visible = list.map((e) => e.key);
    const all = el.querySelector('#pt-all');
    all.checked = visible.length > 0 && visible.every((k) => portal.selected.has(k));
    countSelected();
  }

  function countSelected() {
    const n = selectedEntries().length;
    const c = el.querySelector('#pt-count');
    if (c) c.textContent = `${n} endpoint${n === 1 ? '' : 's'} selected`;
  }

  const selectedEntries = () => catalog(info).filter((e) => portal.selected?.has(e.key));

  function drawMain() {
    const main = el.querySelector('#pt-main');
    if (!main) return;
    const e = catalog(info).find((x) => x.key === nav.focus);
    if (e) {
      main.innerHTML = `<div class="row small" style="margin-bottom:8px"><a href="#" data-action="pt-focus" data-key="">← Overview</a><span class="grow"></span>
          <button class="btn-sm" data-action="pt-download" data-scope="one">Download this endpoint (.txt)</button>
          <button class="btn-sm" data-action="pt-try" data-key="${esc(e.key)}">Try it</button></div>
        ${endpointHtml(info, e, fieldsOf(e.col))}`;
      return;
    }
    const entries = catalog(info).filter((x) => x.mode !== 'off');
    const groups = {};
    for (const x of entries) (groups[`${x.col} · ${x.group}`] ||= []).push(x);
    main.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <h3 style="margin-top:0">${esc(info.name)}</h3>
        <table class="small"><tbody>
          <tr><td class="muted" style="width:140px">Base URL</td><td class="mono">${esc(info.url || 'not published yet (private to the server)')}</td></tr>
          <tr><td class="muted">Database</td><td class="mono">${esc(info.database)}</td></tr>
          <tr><td class="muted">Endpoints</td><td>${entries.length} on: ${entries.filter((x) => x.mode === 'public').length} public, ${entries.filter((x) => x.mode === 'key').length} need a key${catalog(info).length - entries.length ? `, ${catalog(info).length - entries.length} off` : ''}</td></tr>
          <tr><td class="muted">Authentication</td><td>Header <span class="mono">x-api-key: YOUR_API_KEY</span> (or <span class="mono">Authorization: Bearer …</span>) for 🔑 endpoints. Keys: API keys tab.</td></tr>
          <tr><td class="muted">Limits</td><td>${Number(info.rateLimitPerMinute) ? `${info.rateLimitPerMinute} requests per minute per visitor / key` : 'no rate limit'} · max ${info.maxLimit} documents per page</td></tr>
          <tr><td class="muted">Errors</td><td><span class="mono">{ "error": "…" }</span> with 400 / 401 / 403 / 404 / 409 / 429</td></tr>
        </tbody></table>
      </div>
      <div class="card flush" style="margin-bottom:12px">
        <div class="card-head"><h3 style="margin:0">Endpoints by group</h3></div>
        ${Object.entries(groups)
          .map(
            ([g, xs]) => `<div class="pt-group" style="padding:8px 16px 0">${esc(g)}</div><table class="small"><tbody>${xs
              .map((x) => `<tr><td style="width:80px"><span class="badge method-${x.method.toLowerCase()}">${x.method}</span></td><td><a href="#" data-action="pt-focus" data-key="${esc(x.key)}">${esc(x.title)}</a><div class="mono muted">${esc(x.path)}</div></td><td style="width:90px">${x.mode === 'key' ? '🔑 key' : '🌐 public'}</td></tr>`)
              .join('')}</tbody></table>`,
          )
          .join('') || '<div class="empty">No endpoints are on yet.</div>'}
      </div>
      ${Object.keys(info.collections || {})
        .map((col) => `<div class="card" style="margin-bottom:12px"><h3 style="margin-top:0">Data model: <span class="mono">${esc(col)}</span></h3>${modelHtml(col, fieldsOf(col))}</div>`)
        .join('')}`;
  }

  function bindPortal() {
    drawTree();
    drawMain();
    el.querySelector('#pt-search').addEventListener('input', (e) => {
      portal.search = e.target.value;
      drawTree();
    });
    el.querySelector('#pt-off').addEventListener('change', (e) => {
      portal.showOff = e.target.checked;
      drawTree();
    });
    el.querySelector('#pt-all').addEventListener('change', (e) => {
      const qtext = portal.search.trim().toLowerCase();
      for (const x of portalEntries()) {
        if (qtext && !`${x.title} ${x.path} ${x.col} ${x.group} ${x.method} ${x.desc}`.toLowerCase().includes(qtext)) continue;
        if (e.target.checked) portal.selected.add(x.key);
        else portal.selected.delete(x.key);
      }
      drawTree();
    });
    el.querySelector('#pt-tree').addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.sel) {
        if (t.checked) portal.selected.add(t.dataset.sel);
        else portal.selected.delete(t.dataset.sel);
      }
      if (t.dataset.selcol) for (const x of portalEntries().filter((y) => y.col === t.dataset.selcol)) t.checked ? portal.selected.add(x.key) : portal.selected.delete(x.key);
      drawTree();
    });
  }

  function exportEntries(scope) {
    if (scope === 'one') return catalog(info).filter((e) => e.key === nav.focus);
    if (scope === 'col') return catalog(info).filter((e) => e.col === nav.col && e.mode !== 'off');
    return selectedEntries();
  }

  async function exportText(scope) {
    const entries = exportEntries(scope);
    if (!entries.length) throw new Error('Select at least one endpoint first.');
    await Promise.all([...new Set(entries.map((e) => e.col))].map(samplesFor));
    const fieldsByCol = Object.fromEntries([...new Set(entries.map((e) => e.col))].map((col) => [col, fieldsOf(col)]));
    return { entries, text: docsText({ ...info, database: dbName }, entries, fieldsByCol) };
  }

  function exportName(scope, entries) {
    if (scope === 'one') return `${info.name}-${entries[0].col}-${entries[0].id}.txt`;
    if (scope === 'col') return `${info.name}-${nav.col}-api.txt`;
    const cols = [...new Set(entries.map((e) => e.col))];
    return `${info.name}${cols.length === 1 ? `-${cols[0]}` : ''}-api.txt`;
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
    section: async ({ section }) => {
      nav.section = section;
      if (section === 'collections' && !nav.col) nav.col = Object.keys(info.collections || {})[0] || collections[0]?.name;
      if (section === 'portal') {
        el.querySelector('#ws-body').innerHTML = loadingHtml();
        await loadSample();
      }
      draw();
    },
    'pt-focus': ({ key }) => {
      nav.focus = key || undefined;
      drawTree();
      drawMain();
      syncHash();
      el.querySelector('#pt-main')?.scrollIntoView({ block: 'nearest' });
    },
    'pt-try': async ({ key }) => {
      const e = catalog(info).find((x) => x.key === key);
      if (!e) return;
      Object.assign(nav, { section: 'collections', col: e.col, sub: 'try' });
      await loadSample();
      draw();
      const sel = el.querySelector('#da-try-ep');
      if (sel) {
        sel.value = e.custom ? `v:${e.id}` : e.id;
        sel.dispatchEvent(new Event('change'));
      }
    },
    'pt-download': async ({ scope }, btn) => {
      const r = await run(btn, () => exportText(scope));
      if (r) downloadText(exportName(scope, r.entries), r.text);
    },
    'pt-copy': async (_d, btn) => {
      const r = await run(btn, () => exportText());
      if (!r) return;
      try {
        await navigator.clipboard.writeText(r.text);
        toast(`Copied docs for ${r.entries.length} endpoint(s)`, 'ok');
      } catch {
        modal({ title: 'API docs', wide: true, body: `<pre class="log" style="max-height:60vh">${esc(r.text)}</pre>`, actions: [{ label: 'Close' }] });
      }
    },
    'pt-preview': async (_d, btn) => {
      const r = await run(btn, () => exportText());
      if (!r) return;
      modal({
        title: `${exportName(undefined, r.entries)} (${r.text.split('\n').length} lines)`,
        wide: true,
        body: `<pre class="log" style="max-height:62vh;white-space:pre-wrap">${esc(r.text)}</pre>`,
        actions: [{ label: 'Close' }, { label: 'Download .txt', className: 'btn-primary', onClick: () => downloadText(exportName(undefined, r.entries), r.text) }],
      });
    },
    'cu-edit': ({ id }) => customEditor(nav.col, id ? info.collections[nav.col].custom.find((x) => x.id === id) : null),
    'cu-delete': async ({ id }) => {
      if (!(await confirmDialog(`Delete the endpoint ${nav.col}/views/${id}? Apps that call it get 404. The data is not touched.`, { danger: true, confirmLabel: 'Delete' }))) return;
      const cfg = await run(null, () => api(`${base}/${info.name}/collections/${encodeURIComponent(nav.col)}/custom/${encodeURIComponent(id)}`, { method: 'DELETE' }), 'Endpoint deleted');
      if (cfg) {
        info = { ...info, ...cfg };
        draw();
      }
    },
    'cu-try': ({ id }) => {
      nav.sub = 'try';
      drawSection();
      const sel = el.querySelector('#da-try-ep');
      if ([...sel.options].some((o) => o.value === `v:${id}`)) {
        sel.value = `v:${id}`;
        sel.dispatchEvent(new Event('change'));
      } else toast('This endpoint is off; turn it on to try it.', 'error');
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
      const custom = customOf(id);
      const [, method, suffix] = custom ? [id, custom.kind === 'create' ? 'POST' : 'GET', `/views/${custom.id}`] : ENDPOINTS.find((x) => x[0] === id);
      const docId = el.querySelector('#da-try-id').value.trim();
      if (suffix === '/:id' && !docId) return toast('Paste a document id first (list the collection to find one).', 'error');
      const query = el.querySelector('#da-try-q').value.trim().replace(/^\?/, '');
      let reqPath = `/api/${encodeURIComponent(col)}${suffix.replace(':id', encodeURIComponent(docId))}`;
      if (query && (['list', 'count'].includes(id) || (custom && custom.kind !== 'create'))) reqPath += `?${query}`;
      const body = ['create', 'update', 'replace'].includes(id) || custom?.kind === 'create' ? el.querySelector('#da-try-body').value : '';
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
