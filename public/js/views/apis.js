// APIs: let websites and apps use MongoDB data over HTTPS, in plain words.
//   #/s/<id>/apis                         all APIs, by database and collection
//   #/s/<id>/apis/docs/<server>/<slug|all> Swagger docs
//   #/s/<id>/apis/new[/<db>/<collection>] make a new API
//   #/s/<id>/apis/a/<server>/<slug>/<tab> one API: play | setup | code | keys
//   #/s/<id>/apis/s/<server>/<tab>        one API server: apis | keys | settings
// An "API server" is the small service (one per database) that answers the requests; most
// people never need to look at it.
import { api, esc, toast, run, modal, confirmDialog, formDialog, showJob, onAction, loadingHtml, errorHtml, hasAll, can } from '../ui.js';
import { mountSwagger } from './swagger.js';
import { OPS, WHO, summary, baseUrl, catalog, inferFields, endpointHtml, modelHtml, docsText, downloadText, details, fetchFor, curlFor } from './api-docs.js';

const SYSTEM_DBS = new Set(['admin', 'local', 'config', 'serverboy']);

// Starting points for a new API, in the words people use.
const TEMPLATES = {
  website: { label: 'Show it on a website', desc: 'Anyone can see the list and single items. Nobody can change anything.', ops: { list: 'public', get: 'public', count: 'public', create: 'off', update: 'off', delete: 'off' } },
  managed: { label: 'Website + my admin app', desc: 'Anyone can see. Apps with a key can add, change and delete.', ops: { list: 'public', get: 'public', count: 'public', create: 'key', update: 'key', delete: 'key' }, recommended: true },
  private: { label: 'Private, for my own app', desc: 'Everything needs a key. Nothing is public.', ops: { list: 'key', get: 'key', count: 'key', create: 'key', update: 'key', delete: 'key' } },
  form: { label: 'A form (contact, sign-up, orders)', desc: 'Anyone can add items. Nobody can see them through the API.', ops: { list: 'off', get: 'off', count: 'off', create: 'public', update: 'off', delete: 'off' } },
  custom: { label: "I'll choose myself", desc: 'Everything starts switched off.', ops: { list: 'off', get: 'off', count: 'off', create: 'off', update: 'off', delete: 'off' } },
};

const COND_OPS = [
  ['eq', 'is'],
  ['ne', 'is not'],
  ['gt', 'is more than'],
  ['gte', 'is at least'],
  ['lt', 'is less than'],
  ['lte', 'is at most'],
  ['contains', 'contains (text)'],
];

const KEY_RIGHTS = [
  ['read', 'See items'],
  ['create', 'Add'],
  ['update', 'Change'],
  ['delete', 'Delete'],
];

const slugify = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const suggestedDomain = (name) => (location.hostname.endsWith('.sslip.io') ? `${name}.${location.hostname}` : '');
const escapeRegex = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function copy(text) {
  navigator.clipboard?.writeText(text).then(() => toast('Copied', 'ok')).catch(() => modal({ title: 'Copy', body: `<pre class="log">${esc(text)}</pre>`, actions: [{ label: 'Close' }] }));
}

export async function render(el, { server, rest }) {
  const parts = rest.map((x) => decodeURIComponent(x));
  const ctx = makeCtx(server);
  if (parts[0] === 'new') return renderNew(el, ctx, { db: parts[1], collection: parts[2] === '-' ? '' : parts[2], service: parts[3] });
  if (parts[0] === 'a' && parts[1] && parts[2]) return renderApi(el, ctx, parts[1], parts[2], parts[3] || 'play');
  if (parts[0] === 's' && parts[1]) return renderService(el, ctx, parts[1], parts[2] || 'apis');
  if (parts[0] === 'docs') return renderDocs(el, ctx, parts[1], parts[2] || 'all');
  return renderHome(el, ctx);
}

function makeCtx(server) {
  const base = `/servers/${server.id}/mongo/apis`;
  const sampleCache = {};
  return {
    server,
    base,
    home: `#/s/${server.id}/apis`,
    apiUrl: (svc, slug, tab = 'play') => `#/s/${server.id}/apis/a/${encodeURIComponent(svc)}/${encodeURIComponent(slug)}/${tab}`,
    docsUrl: (svc, slug = 'all') => `#/s/${server.id}/apis/docs/${encodeURIComponent(svc)}/${encodeURIComponent(slug)}`,
    newUrl: (db, col) => `#/s/${server.id}/apis/new/${encodeURIComponent(db)}/${encodeURIComponent(col || '-')}`,
    svcUrl: (svc, tab = 'apis') => `#/s/${server.id}/apis/s/${encodeURIComponent(svc)}/${tab}`,
    services: () => api(base),
    info: (svc) => api(`${base}/${svc}`),
    databases: async () => (await api(`/servers/${server.id}/mongo/databases`).catch(() => [])).filter((d) => !SYSTEM_DBS.has(d.name)),
    collections: (db) => api(`/servers/${server.id}/mongo/databases/${encodeURIComponent(db)}/collections`).catch(() => []),
    async samples(db, col) {
      const k = `${db}/${col}`;
      if (!sampleCache[k]) {
        const r = await api(`/servers/${server.id}/mongo/find`, { method: 'POST', body: { db, collection: col, limit: 20 } }).catch(() => ({ docs: [] }));
        sampleCache[k] = r.docs || [];
      }
      return sampleCache[k];
    },
    test: (svc, body) => api(`${base}/${svc}/test`, { method: 'POST', body }),
  };
}

function upgradeNotice(svc) {
  return `<div class="notice warn" style="margin-bottom:12px"><b>${esc(svc.name)}</b> runs an older API engine. Update it to add more APIs and change settings; your current APIs and keys are kept and their addresses keep working.
    <button class="btn-sm btn-primary" data-action="upgrade" data-svc="${esc(svc.name)}" style="margin-left:8px">Update engine</button></div>`;
}

async function upgrade(ctx, name, onDone) {
  if (!(await confirmDialog(`Update the API engine of ${name}? It restarts for a second. Your APIs, keys and addresses are kept.`, { confirmLabel: 'Update' }))) return;
  const job = await run(null, () => api(`${ctx.base}/${name}/upgrade`, { method: 'POST' }));
  if (job) showJob(ctx.server.id, job, { onDone });
}

async function textFor(ctx, info, slugs) {
  const fieldsBySlug = {};
  for (const slug of slugs) fieldsBySlug[slug] = inferFields(await ctx.samples(info.database, info.apis[slug].collection), info.apis[slug]);
  return docsText(info, catalog(info, slugs), fieldsBySlug);
}

function showNewKey(k, writes) {
  modal({
    title: 'Copy your API key now',
    body: `<p>This key is shown <b>only once</b>. Store it in your app's environment variables (e.g. <span class="mono">DATA_API_KEY</span>).</p>
      <pre class="log">${esc(k.key)}</pre>
      <p class="small muted">Apps send it in the <span class="mono">x-api-key</span> header.${writes ? ' It can change data: use it only from a backend, never in web page code.' : ''}</p>`,
    actions: [
      {
        label: 'Copy',
        onClick: () => {
          copy(k.key);
          return false;
        },
      },
      { label: 'I have saved it', className: 'btn-primary' },
    ],
  });
}

// ======================= all APIs =======================

// Databases → collections → the APIs that use each collection.
async function renderHome(el, ctx) {
  el.innerHTML = `
    <div class="page-head">
      <div><h1>APIs</h1><div class="sub">Let your websites and apps read and change your data over the internet, safely. Every collection can have several APIs, each with its own rules.</div></div>
      <div class="row"><button data-action="swagger">📖 API docs (Swagger)</button><button data-action="docs">⬇ Docs for AI (.txt)</button><a class="btn btn-primary" href="${ctx.home}/new">+ New API</a></div>
    </div>
    <div id="apis-body">${loadingHtml()}</div>`;
  const body = el.querySelector('#apis-body');
  let services = [];
  let dbs = [];
  try {
    [services, dbs] = await Promise.all([ctx.services(), ctx.databases()]);
    services = services.filter((s) => !s.broken);
  } catch (err) {
    body.innerHTML = errorHtml(err);
    return;
  }
  const colsByDb = Object.fromEntries(await Promise.all(dbs.map(async (d) => [d.name, (await ctx.collections(d.name)).filter((c) => !c.name.startsWith('system.'))])));
  const canEditDb = (name) => hasAll('databases') || dbs.find((d) => d.name === name)?.access === 'edit';
  const apiRow = (a, svc) => `<div class="api-row">
      <div class="grow"><a href="${ctx.apiUrl(svc.name, a.slug)}"><b>${esc(a.title)}</b></a> <span class="mono small muted">/api/${esc(a.slug)}</span>${a.group ? ` <span class="badge">${esc(a.group)}</span>` : ''}
        <div class="small muted">${esc(summary(a))}</div></div>
      <div class="row" style="gap:6px"><a class="btn btn-sm" href="${ctx.apiUrl(svc.name, a.slug, 'play')}">▶ Try</a><a class="btn btn-sm" href="${ctx.docsUrl(svc.name, a.slug)}">📖 Docs</a><a class="btn btn-sm" href="${ctx.apiUrl(svc.name, a.slug, 'setup')}">⚙</a></div>
    </div>`;
  body.innerHTML = `
    ${services.filter((s) => s.needsUpgrade).map(upgradeNotice).join('')}
    ${
      dbs.length
        ? dbs
            .map((d) => {
              const svcs = services.filter((s) => s.database === d.name);
              const cols = colsByDb[d.name] || [];
              const colNames = [...new Set([...cols.map((c) => c.name), ...svcs.flatMap((s) => s.apis.map((a) => a.collection))])];
              const withApis = colNames.filter((c) => svcs.some((s) => s.apis.some((a) => a.collection === c)));
              const without = colNames.filter((c) => !withApis.includes(c));
              return `<div class="card flush api-db">
                <div class="card-head"><div><h2 style="margin:0">⛁ ${esc(d.name)}</h2>
                  <div class="small muted">${svcs.length ? svcs.map((s) => `API server <a href="${ctx.svcUrl(s.name, 'settings')}">${esc(s.name)}</a> <span class="badge ${s.status === 'online' ? 'ok' : 'bad'}">${esc(s.status)}</span> ${s.domain ? `<span class="mono">${esc(s.domain)}</span>` : 'not published yet'}`).join(' · ') : 'No APIs yet'}</div></div>
                  <div class="row">${svcs.filter((s) => s.apis.length).map((s, _i, all) => `<a class="btn btn-sm" href="${ctx.docsUrl(s.name)}">📖 Docs${all.length > 1 ? ` (${esc(s.name)})` : ''}</a>`).join('')}<a class="btn btn-sm" href="#/s/${ctx.server.id}/databases/mongo">Open in Databases</a></div></div>
                ${withApis
                  .map((c) => {
                    const count = cols.find((x) => x.name === c)?.count;
                    return `<div class="api-col-block">
                      <div class="row api-col-head"><b class="mono grow">▤ ${esc(c)}</b>${count != null ? `<span class="small muted">${count} items</span>` : ''}${canEditDb(d.name) ? `<a class="btn btn-sm" href="${ctx.newUrl(d.name, c)}">+ New API for ${esc(c)}</a>` : ''}</div>
                      ${svcs.flatMap((s) => s.apis.filter((a) => a.collection === c).map((a) => apiRow(a, s))).join('')}
                    </div>`;
                  })
                  .join('')}
                ${
                  without.length
                    ? `<div class="api-col-block muted-block"><div class="small muted" style="margin-bottom:6px">${withApis.length ? 'Collections without an API' : 'Collections (no API yet)'}</div><div class="row" style="gap:6px">${without
                        .map((c) => (canEditDb(d.name) ? `<a class="btn btn-sm" href="${ctx.newUrl(d.name, c)}" title="Make an API for ${esc(c)}">▤ ${esc(c)} <span class="muted">+ API</span></a>` : `<span class="badge">${esc(c)}</span>`))
                        .join('')}</div></div>`
                    : ''
                }
              </div>`;
            })
            .join('')
        : `<div class="card api-empty"><h2>No MongoDB database yet</h2><p>Create a database in <a href="#/s/${ctx.server.id}/databases">Databases</a>, then come back to make an API for it.</p></div>`
    }`;
  onAction(el, {
    upgrade: ({ svc }) => upgrade(ctx, svc, () => renderHome(el, ctx)),
    docs: () => docsDialog(ctx, services),
    swagger: () => {
      const s = services.find((x) => x.apis.length);
      if (!s) return toast('Make an API first.', 'error');
      location.hash = ctx.docsUrl(s.name);
    },
  });
}

// ======================= Swagger docs =======================

async function renderDocs(el, ctx, svcName, slug) {
  el.innerHTML = loadingHtml();
  let services;
  try {
    services = (await ctx.services()).filter((s) => !s.broken && s.apis.length);
  } catch (err) {
    el.innerHTML = errorHtml(err);
    return;
  }
  const svc = services.find((s) => s.name === svcName) || services[0];
  if (!svc) {
    el.innerHTML = `<div class="small" style="margin-bottom:6px"><a href="${ctx.home}">← All APIs</a></div><div class="card">There are no APIs yet. <a href="${ctx.home}/new">Make one</a>.</div>`;
    return;
  }
  const one = slug !== 'all' && svc.apis.some((a) => a.slug === slug) ? slug : null;
  const specUrl = `/api${ctx.base}/${svc.name}/openapi.json${one ? `?api=${encodeURIComponent(one)}` : ''}`;
  el.innerHTML = `
    <div class="small" style="margin-bottom:6px"><a href="${ctx.home}">← All APIs</a></div>
    <div class="page-head">
      <div><h1>API docs</h1><div class="sub">Every API with its addresses, options and fields (OpenAPI / Swagger). Click an action, then <b>Try it out</b>. For actions with a lock, click <b>Authorize</b> and paste an API key.</div></div>
      <div class="row">
        ${services.length > 1 ? `<select id="docs-svc">${services.map((s) => `<option value="${esc(s.name)}" ${s.name === svc.name ? 'selected' : ''}>${esc(s.database)} (${esc(s.name)})</option>`).join('')}</select>` : ''}
        <select id="docs-api"><option value="all">All APIs (${svc.apis.length})</option>${svc.apis.map((a) => `<option value="${esc(a.slug)}" ${a.slug === one ? 'selected' : ''}>${esc(a.title)} · /api/${esc(a.slug)}</option>`).join('')}</select>
        <a class="btn" href="${specUrl}${one ? '&' : '?'}download=1" download>⬇ openapi.json</a>
        <button data-action="txt">⬇ .txt for AI</button>
      </div>
    </div>
    <div class="notice small" style="margin-bottom:12px">Try it out runs <b>through Serverboy</b>, so it works even before the API is published, and answers exactly like the internet would (keys and rules apply). Websites and apps use the public address; pick it under <b>Servers</b> to test that too. The downloaded openapi.json lists the public address first.</div>
    <div class="swagger-wrap" id="swagger">${loadingHtml('Loading the docs…')}</div>`;
  const go = (s, a) => (location.hash = ctx.docsUrl(s, a));
  el.querySelector('#docs-svc')?.addEventListener('change', (e) => go(e.target.value, 'all'));
  el.querySelector('#docs-api').addEventListener('change', (e) => go(svc.name, e.target.value));
  onAction(el, {
    txt: async () => {
      const info = await ctx.info(svc.name);
      const slugs = one ? [one] : Object.keys(info.apis);
      downloadText(`${one || svc.name}-api.txt`, await textFor(ctx, info, slugs));
    },
  });
  try {
    await mountSwagger(el.querySelector('#swagger'), specUrl);
  } catch (err) {
    el.querySelector('#swagger').innerHTML = errorHtml(err);
  }
}

// Choose APIs (from any API server) and download their reference as plain text.
async function docsDialog(ctx, services) {
  const usable = services.filter((s) => s.apis.length);
  if (!usable.length) return toast('Make an API first.', 'error');
  const box = document.createElement('div');
  box.innerHTML = `<p class="small" style="margin-top:0">A plain-text reference of the APIs you tick: address, what each one allows, the fields, and examples. Paste it into ChatGPT / Claude ("build me a page that uses this API"), a README or a message to a developer.</p>
    ${usable
      .map(
        (s) => `<div class="small muted" style="margin:8px 0 4px">${esc(s.name)}</div>${s.apis
          .map((a) => `<label class="check" style="margin:2px 0"><input type="checkbox" data-svc="${esc(s.name)}" data-slug="${esc(a.slug)}" checked> <b>${esc(a.title)}</b> <span class="mono muted small">/api/${esc(a.slug)}</span></label>`)
          .join('')}`,
      )
      .join('')}`;
  const build = async () => {
    const picked = [...box.querySelectorAll('input:checked')].map((i) => ({ svc: i.dataset.svc, slug: i.dataset.slug }));
    if (!picked.length) throw new Error('Tick at least one API');
    const texts = [];
    for (const svcName of [...new Set(picked.map((p) => p.svc))]) {
      const info = await ctx.info(svcName);
      texts.push(await textFor(ctx, info, picked.filter((p) => p.svc === svcName).map((p) => p.slug)));
    }
    return { text: texts.join('\n\n'), name: picked.length === 1 ? `${picked[0].slug}-api.txt` : 'api-docs.txt' };
  };
  modal({
    title: 'Docs for AI and developers',
    body: box,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Copy text',
        onClick: async () => {
          copy((await build()).text);
          return false;
        },
      },
      {
        label: '⬇ Download .txt',
        className: 'btn-primary',
        onClick: async () => {
          const r = await build();
          downloadText(r.name, r.text);
        },
      },
    ],
  });
}

// ======================= new API =======================

async function renderNew(el, ctx, pre) {
  el.innerHTML = `<div class="small" style="margin-bottom:6px"><a href="${ctx.home}">← All APIs</a></div>
    <div class="page-head"><div><h1>New API</h1><div class="sub">Three questions, then you can try it out.</div></div></div>
    <div id="new-body">${loadingHtml()}</div>`;
  const body = el.querySelector('#new-body');
  let services;
  let dbs;
  try {
    [services, dbs] = await Promise.all([ctx.services(), ctx.databases()]);
  } catch (err) {
    body.innerHTML = errorHtml(err);
    return;
  }
  services = services.filter((s) => !s.broken);
  dbs = dbs.filter((d) => hasAll('databases') || d.access === 'edit');
  if (!dbs.length) {
    body.innerHTML = `<div class="card"><p>There is no MongoDB database you can change yet. Create one in <a href="#/s/${ctx.server.id}/databases">Databases</a> first.</p></div>`;
    return;
  }
  const state = { db: pre.db && dbs.some((d) => d.name === pre.db) ? pre.db : dbs[0].name, collection: pre.collection || '', template: 'managed' };

  body.innerHTML = `
    <form id="new-api" class="new-api">
      <div class="card step"><div class="step-n">1</div><div class="grow">
        <h3>Which data?</h3>
        <div class="form-grid">
          <label class="field"><span>Database</span><select name="db">${dbs.map((d) => `<option ${d.name === state.db ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
          <label class="field"><span>Collection</span><select name="collection"></select></label>
          <label class="field hidden" id="new-col-f"><span>New collection name</span><input name="newCollection" class="mono" placeholder="products"></label>
        </div>
        <div id="new-fields" class="small muted"></div>
      </div></div>
      <div class="card step"><div class="step-n">2</div><div class="grow">
        <h3>What is it for?</h3>
        <div class="tpl-grid">${Object.entries(TEMPLATES)
          .map(
            ([id, t]) => `<label class="tpl ${id === state.template ? 'on' : ''}"><input type="radio" name="template" value="${id}" ${id === state.template ? 'checked' : ''}>
              <b>${esc(t.label)}${t.recommended ? ' <span class="badge ok">popular</span>' : ''}</b><span class="small muted">${esc(t.desc)}</span></label>`,
          )
          .join('')}</div>
        <p class="small muted" style="margin-bottom:0">You can change every detail afterwards: who may do what, which items and which fields.</p>
      </div></div>
      <div class="card step"><div class="step-n">3</div><div class="grow">
        <h3>Name and address</h3>
        <div class="form-grid">
          <label class="field"><span>Name</span><input name="title" placeholder="Products"></label>
          <label class="field"><span>Address</span><div class="row" style="flex-wrap:nowrap;gap:4px"><span class="mono muted">/api/</span><input name="slug" class="mono" placeholder="products"></div><small id="new-url"></small></label>
          <label class="field"><span>Folder (optional)</span><input name="group" placeholder="Website, Mobile app…" list="new-groups"><datalist id="new-groups">${[...new Set(services.flatMap((s) => s.apis.map((a) => a.group)).filter(Boolean))].map((g) => `<option value="${esc(g)}">`).join('')}</datalist></label>
        </div>
        <div id="new-server"></div>
      </div></div>
      <div class="row"><button class="btn-primary">Create API</button><a class="btn" href="${ctx.home}">Cancel</a></div>
    </form>`;
  const f = body.querySelector('#new-api');
  const serversFor = (db) => services.filter((s) => s.database === db);
  const pickedService = () => {
    const svcs = serversFor(state.db);
    return svcs.find((s) => s.name === f.service?.value) || svcs.find((s) => s.name === pre.service) || svcs[0];
  };

  async function loadCols() {
    const sel = f.collection;
    sel.innerHTML = '<option>Loading…</option>';
    const cols = (await ctx.collections(state.db)).filter((c) => !c.name.startsWith('system.'));
    sel.innerHTML = `${cols.map((c) => `<option value="${esc(c.name)}" ${c.name === state.collection ? 'selected' : ''}>${esc(c.name)}${c.count != null ? ` (${c.count} items)` : ''}</option>`).join('')}<option value="__new">+ New collection…</option>`;
    if (!cols.length) sel.value = '__new';
    colChanged();
  }
  async function colChanged() {
    state.collection = f.collection.value;
    body.querySelector('#new-col-f').classList.toggle('hidden', state.collection !== '__new');
    const info = body.querySelector('#new-fields');
    if (state.collection === '__new') info.textContent = 'The collection is created when the first item is added.';
    else {
      const asked = state.collection;
      const docs = await ctx.samples(state.db, asked);
      if (asked !== state.collection) return; // the user picked another collection meanwhile
      const fields = [...new Set(docs.flatMap((d) => Object.keys(d)))].filter((x) => x !== '_id');
      info.innerHTML = fields.length ? `Fields in this data: ${fields.map((x) => `<span class="mono">${esc(x)}</span>`).join(', ')}` : 'This collection is empty.';
    }
    if (!f.title.value || f.title.dataset.auto) {
      const c = state.collection === '__new' ? f.newCollection.value : state.collection;
      f.title.value = c ? c.charAt(0).toUpperCase() + c.slice(1) : '';
      f.title.dataset.auto = '1';
      titleChanged();
    }
    drawServer();
  }
  function titleChanged() {
    if (!f.slug.dataset.touched) f.slug.value = slugify(f.title.value);
    urlChanged();
  }
  function urlChanged() {
    const svc = pickedService();
    const host = svc?.domain ? `https://${svc.domain}` : f.domain?.value ? `https://${f.domain.value}` : 'https://YOUR-API-ADDRESS';
    const out = body.querySelector('#new-url');
    out.textContent = `${host}/api/${f.slug.value || '…'}`;
    if (svc && svc.apis.some((a) => a.slug === f.slug.value)) out.innerHTML += ' <b style="color:var(--bad)">already used: pick another address</b>';
  }
  function drawServer() {
    const svcs = serversFor(state.db);
    const box = body.querySelector('#new-server');
    if (!svcs.length) {
      const name = `${state.db}-api`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
      box.innerHTML = `<div class="notice" style="margin-top:8px">This is the first API for <b>${esc(state.db)}</b>, so Serverboy also sets up its API server (about a minute).</div>
        <div class="form-grid">
          <label class="field"><span>Public address of the API server (optional)</span><input name="domain" value="${esc(suggestedDomain(name))}" placeholder="api.example.com">
            <small>${location.hostname.endsWith('.sslip.io') ? 'This free sslip.io address works without buying a domain.' : "Point the domain's DNS to this server first."} Leave empty to keep it private to the server for now.</small></label>
          <label class="check" style="margin-top:22px"><input type="checkbox" name="https" checked> Free HTTPS certificate (ports 80 and 443 must be open)</label>
        </div><input type="hidden" name="newService" value="${esc(name)}">`;
      box.querySelector('[name=domain]').addEventListener('input', urlChanged);
    } else if (svcs.length > 1) {
      box.innerHTML = `<label class="field"><span>Served by</span><select name="service">${svcs.map((s) => `<option ${s.name === pre.service ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>`;
      box.querySelector('select').addEventListener('change', urlChanged);
    } else {
      box.innerHTML = svcs[0].needsUpgrade ? upgradeNotice(svcs[0]) : `<p class="small muted">Served by the API server <b>${esc(svcs[0].name)}</b>${svcs[0].domain ? ` at ${esc(svcs[0].domain)}` : ' (not published yet: private to the server)'}.</p>`;
    }
    urlChanged();
  }

  f.db.addEventListener('change', () => {
    state.db = f.db.value;
    state.collection = '';
    loadCols();
  });
  f.collection.addEventListener('change', colChanged);
  f.newCollection.addEventListener('input', () => {
    if (f.title.dataset.auto) {
      f.title.value = f.newCollection.value ? f.newCollection.value.charAt(0).toUpperCase() + f.newCollection.value.slice(1) : '';
      titleChanged();
    }
  });
  f.title.addEventListener('input', () => {
    delete f.title.dataset.auto;
    titleChanged();
  });
  f.slug.addEventListener('input', () => {
    f.slug.dataset.touched = '1';
    urlChanged();
  });
  f.addEventListener('change', (e) => {
    if (e.target.name === 'template') {
      state.template = e.target.value;
      f.querySelectorAll('.tpl').forEach((t) => t.classList.toggle('on', t.querySelector('input').checked));
    }
  });
  onAction(el, { upgrade: ({ svc }) => upgrade(ctx, svc, () => renderNew(el, ctx, pre)) });

  f.addEventListener('submit', async () => {
    const btn = f.querySelector('button.btn-primary');
    const collection = state.collection === '__new' ? f.newCollection.value.trim() : state.collection;
    if (!collection) return toast('Choose or name a collection', 'error');
    if (!f.title.value.trim()) return toast('Give the API a name', 'error');
    const slug = f.slug.value.trim() || slugify(f.title.value);
    const tpl = TEMPLATES[state.template];
    const apiBody = { slug, title: f.title.value.trim(), group: f.group.value.trim(), collection, ops: tpl.ops, timestamps: true, callerFilters: state.template !== 'form' };
    const save = async (svcName) => {
      const ok = await run(btn, () => api(`${ctx.base}/${svcName}/resources/new`, { method: 'PUT', body: apiBody }));
      if (ok) {
        toast('API created. Try it out!', 'ok');
        location.hash = ctx.apiUrl(svcName, slug, 'play');
      }
    };
    const svc = pickedService();
    if (!svc) {
      const name = f.newService.value;
      const job = await run(btn, () => api(ctx.base, { method: 'POST', body: { name, database: state.db, domain: f.domain.value.trim(), https: f.https.checked } }));
      if (job) showJob(ctx.server.id, job, { onDone: (j) => (j?.status === 'failed' ? null : save(name)) });
      return;
    }
    if (svc.needsUpgrade) return toast('Update the engine of this API server first (button above).', 'error');
    save(svc.name);
  });
  loadCols();
}

// ======================= one API =======================

const TABS = [
  ['play', '▶ Playground'],
  ['setup', '⚙ What it can do'],
  ['code', '&lt;/&gt; Code & docs'],
  ['keys', '🔑 Keys'],
];

async function renderApi(el, ctx, svcName, slug, tab) {
  el.innerHTML = loadingHtml();
  let info;
  let dbAccess;
  try {
    [info, dbAccess] = await Promise.all([ctx.info(svcName), ctx.databases()]);
  } catch (err) {
    el.innerHTML = errorHtml(err);
    return;
  }
  const a = info.apis?.[slug];
  if (!a) {
    el.innerHTML = `<div class="small" style="margin-bottom:6px"><a href="${ctx.home}">← All APIs</a></div><div class="card">There is no API at /api/${esc(slug)} on ${esc(svcName)} (it may have been renamed or deleted).</div>`;
    return;
  }
  const canEdit = (hasAll('databases') || dbAccess.find((d) => d.name === info.database)?.access === 'edit') && !info.needsUpgrade;
  const page = { tab, role: 'public', listPage: 1, search: '', lastItems: [], history: [], fields: inferFields(await ctx.samples(info.database, a.collection), a) };
  const url = `${baseUrl(info)}/api/${slug}`;

  el.innerHTML = `
    <div class="small" style="margin-bottom:6px"><a href="${ctx.home}">← All APIs</a></div>
    <div class="page-head">
      <div>
        <h1>${esc(a.title)}</h1>
        <div class="sub"><span class="mono">${esc(url)}</span> <button class="btn-sm btn-ghost" data-action="copyUrl" title="Copy the address">⧉ Copy</button> <a class="btn btn-sm" href="${ctx.docsUrl(svcName, slug)}">📖 Swagger docs</a></div>
        <div class="sub small">Data: ${esc(info.database)} → ${esc(a.collection)}${a.group ? ` · Folder: ${esc(a.group)}` : ''} · <a href="${ctx.svcUrl(svcName, 'settings')}">API server ${esc(svcName)}</a></div>
      </div>
    </div>
    ${info.needsUpgrade ? upgradeNotice(info) : ''}
    ${info.status === 'online' ? '' : `<div class="notice warn" style="margin-bottom:12px">The API server is <b>${esc(info.status)}</b>, so the API does not answer right now. <a href="${ctx.svcUrl(svcName, 'settings')}">Open its settings</a> to start or fix it.</div>`}
    ${info.url ? '' : `<div class="notice" style="margin-bottom:12px">Not on the internet yet: only this server can reach it. <a href="${ctx.svcUrl(svcName, 'settings')}">Publish it on an address</a> so websites and apps can use it. The playground works already.</div>`}
    <div class="api-summary">${esc(summary(a))}</div>
    ${canEdit || info.needsUpgrade ? '' : '<div class="notice" style="margin-bottom:12px">You can look and test, but not change this API (view access).</div>'}
    <div class="tabs">${TABS.map(([id, label]) => `<button class="${tab === id ? 'active' : ''}" data-action="tab" data-tab="${id}">${label}</button>`).join('')}</div>
    <div id="api-body"></div>`;

  const bodyEl = el.querySelector('#api-body');
  const setTab = (t) => {
    page.tab = t;
    el.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    window.history.replaceState(null, '', ctx.apiUrl(svcName, slug, t));
    if (t === 'setup') drawSetup();
    else if (t === 'code') drawCode();
    else if (t === 'keys') drawKeys();
    else drawPlay();
  };

  // ---------- playground ----------

  const why = (op) => (a.ops[op] === 'off' ? 'Switched off for everyone (see "What it can do")' : '');
  const idOf = (it) => encodeURIComponent(it._id?.$oid || it._id);

  function drawPlay() {
    bodyEl.innerHTML = `
      <div class="card pg-bar">
        <div class="row">
          <span class="small"><b>Try as</b></span>
          <div class="seg">${[['public', '🌐 Anyone on the internet'], ...(canEdit ? [['key', '🔑 An app with a key']] : [])].map(([r, l]) => `<button class="${page.role === r ? 'on' : ''}" data-action="role" data-role="${r}">${l}</button>`).join('')}</div>
          <span class="grow"></span>
          <input id="pg-search" placeholder="Find: field=value" value="${esc(page.search)}" style="width:200px">
          <button data-action="reload" title="Load again">↻</button>
          <button class="btn-primary" data-action="add" ${a.ops.create === 'off' ? `disabled title="${esc(why('create'))}"` : ''}>+ Add item</button>
        </div>
        <p class="small muted" style="margin:6px 0 0">${page.role === 'public' ? 'You see exactly what any visitor of a website would get.' : "Requests carry Serverboy's test key, like an app with a key that may do everything this API allows."} Everything here is real: changes are saved in ${esc(info.database)} → ${esc(a.collection)}.</p>
      </div>
      <div class="card flush" id="pg-list">${loadingHtml()}</div>
      <div class="card" id="pg-result"><p class="muted small" style="margin:0">What you do appears here, in plain words, with the request behind it.</p></div>
      <details class="card"><summary><b>Advanced:</b> send any request</summary>
        <div class="form-grid" style="margin-top:10px">
          <label class="field"><span>Method</span><select id="pg-m">${['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].map((m) => `<option>${m}</option>`).join('')}</select></label>
          <label class="field"><span>Path</span><input id="pg-p" class="mono" value="/api/${esc(slug)}?limit=5"></label>
        </div>
        <label class="field"><span>Body (JSON)</span><textarea id="pg-b" class="mono" rows="4"></textarea></label>
        <button data-action="raw">Send</button>
      </details>`;
    bodyEl.querySelector('#pg-search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        page.search = e.target.value.trim();
        page.listPage = 1;
        loadList();
      }
    });
    loadList();
  }

  async function send(op, method, path, reqBody, label) {
    const r = await ctx.test(svcName, { method, path, body: reqBody ? JSON.stringify(reqBody) : '', auth: page.role === 'key' ? 'console' : 'none' }).catch((err) => ({ status: 0, ms: 0, body: { error: err.message } }));
    const h = { op, method, path, reqBody, label, role: page.role, ...r };
    page.history.unshift(h);
    page.history.splice(8);
    return h;
  }

  async function loadList() {
    const box = bodyEl.querySelector('#pg-list');
    if (!box) return;
    if (a.ops.list === 'off') {
      box.innerHTML = `<div class="empty">This API does not let anyone see the list.${a.ops.create !== 'off' ? ' You can still add items.' : ''}</div>`;
      return;
    }
    box.innerHTML = loadingHtml();
    const q = new URLSearchParams({ limit: '10', page: String(page.listPage) });
    if (page.search.includes('=')) {
      const [k, ...v] = page.search.split('=');
      q.set(k.trim(), v.join('=').trim());
    }
    const h = await send('list', 'GET', `/api/${slug}?${q}`, null, 'See the list');
    if (h.status !== 200 || !Array.isArray(h.body?.data)) {
      box.innerHTML = `<div class="empty">${esc(plain(h).text)}</div>`;
      showResult(h);
      return;
    }
    page.lastItems = h.body.data;
    const cols = page.fields.filter((x) => !x.hidden && x.name !== '_id').slice(0, 5).map((x) => x.name);
    const extra = [...new Set(page.lastItems.flatMap((d) => Object.keys(d)))].filter((k) => k !== '_id' && !cols.includes(k)).slice(0, Math.max(0, 5 - cols.length));
    const names = [...cols, ...extra];
    const cell = (v) => {
      if (v === undefined) return '<span class="muted">-</span>';
      if (v && typeof v === 'object') return `<span class="mono small">${esc(String(v.$date || v.$oid || JSON.stringify(v)).slice(0, 60))}</span>`;
      return esc(String(v).slice(0, 80));
    };
    const { total, skip, limit } = h.body;
    box.innerHTML = `
      <div class="card-head"><h3 style="margin:0">${total} item${total === 1 ? '' : 's'}${page.search ? ` where ${esc(page.search)}` : ''}</h3>
        <div class="row small"><span class="muted">${total ? `${skip + 1}–${Math.min(skip + limit, total)}` : ''}</span>
          <button class="btn-sm" data-action="pageNav" data-dir="-1" ${page.listPage <= 1 ? 'disabled' : ''}>‹</button><button class="btn-sm" data-action="pageNav" data-dir="1" ${skip + limit >= total ? 'disabled' : ''}>›</button></div></div>
      ${
        page.lastItems.length
          ? `<div class="table-wrap"><table class="pg-table"><thead><tr>${names.map((n) => `<th>${esc(n)}</th>`).join('')}<th></th></tr></thead><tbody>${page.lastItems
              .map(
                (d, i) => `<tr>${names.map((n) => `<td>${cell(d[n])}</td>`).join('')}
                <td class="actions">
                  <button class="btn-sm" data-action="view" data-i="${i}" ${a.ops.get === 'off' ? `disabled title="${esc(why('get'))}"` : ''}>View</button>
                  <button class="btn-sm" data-action="edit" data-i="${i}" ${a.ops.update === 'off' ? `disabled title="${esc(why('update'))}"` : ''}>Edit</button>
                  <button class="btn-sm btn-danger" data-action="del" data-i="${i}" ${a.ops.delete === 'off' ? `disabled title="${esc(why('delete'))}"` : ''}>Delete</button>
                </td></tr>`,
              )
              .join('')}</tbody></table></div>`
          : `<div class="empty">No items yet.${a.ops.create !== 'off' ? ' Click <b>+ Add item</b> to add the first one.' : ''}</div>`
      }`;
  }

  // What the API answered, in plain words.
  function plain(h) {
    const err = h.body && typeof h.body === 'object' ? h.body.error : '';
    if (!h.status) return { level: 'bad', text: `The API did not answer${err ? ` (${err})` : ''}. Is the API server running?` };
    if (h.status === 401) return { level: 'warn', text: `This needs an API key. Apps send it in the x-api-key header.${h.role === 'public' ? ' Switch "Try as" to "An app with a key" to try it.' : ''}` };
    if (h.status === 403) return { level: 'warn', text: `The key is not allowed to do this. ${err}` };
    if (h.status === 404) return { level: 'warn', text: err && /turned off|does not allow/.test(err) ? 'This API does not allow that: it is switched off in "What it can do".' : `Not found. ${err || ''}` };
    if (h.status === 429) return { level: 'warn', text: 'Too many requests in a minute (the rate limit in the API server settings).' };
    if (h.status >= 400) return { level: 'bad', text: `The API refused it: ${err || h.status}` };
    const b = h.body || {};
    if (h.op === 'list' && Array.isArray(b.data)) return { level: 'ok', text: `It returned ${b.data.length} of ${b.total} item(s).` };
    if (h.op === 'create') return { level: 'ok', text: `Added. The new item's id is ${b._id?.$oid || b._id}.` };
    if (h.op === 'update') return { level: 'ok', text: 'Changed. The answer shows the item as it is now.' };
    if (h.op === 'delete') return { level: 'ok', text: 'Deleted.' };
    if (h.op === 'count') return { level: 'ok', text: `There are ${b.count} item(s).` };
    if (h.op === 'get') return { level: 'ok', text: 'Here is the item, exactly as the API returns it.' };
    return { level: 'ok', text: 'Done.' };
  }

  function showResult(h) {
    const box = bodyEl.querySelector('#pg-result');
    if (!box) return;
    const p = plain(h);
    const curl = [`curl${h.method === 'GET' ? '' : ` -X ${h.method}`} "${baseUrl(info)}${h.path}"`];
    if (h.role === 'key') curl.push('-H "x-api-key: YOUR_API_KEY"');
    if (h.reqBody) curl.push(`-H "content-type: application/json" -d '${JSON.stringify(h.reqBody).replace(/'/g, "'\\''")}'`);
    box.innerHTML = `
      <div class="pg-answer ${p.level}"><b>${esc(h.label)}</b> → <span class="badge ${h.status && h.status < 300 ? 'ok' : h.status && h.status < 500 ? 'warn' : 'bad'}">${h.status || 'no answer'}</span> <span class="small muted">${h.ms ?? ''} ms · as ${h.role === 'key' ? 'an app with a key' : 'anyone'}</span>
        <div style="margin-top:6px">${esc(p.text)}</div></div>
      <details style="margin-top:8px" ${h.op === 'get' ? 'open' : ''}><summary class="small"><b>Show the request and answer</b> (for developers)</summary>
        <div class="mono small" style="margin:8px 0;word-break:break-all">${esc(h.method)} ${esc(baseUrl(info))}${esc(h.path)}${h.role === 'key' ? '<br>x-api-key: (Serverboy test key)' : ''}</div>
        ${h.reqBody ? `<div class="small muted">Sent:</div><pre class="log">${esc(JSON.stringify(h.reqBody, null, 2))}</pre>` : ''}
        <div class="small muted">Answer:</div><pre class="log" style="max-height:340px">${esc(typeof h.body === 'string' ? h.body : JSON.stringify(h.body, null, 2))}</pre>
        <div class="small muted">The same request in a terminal:</div><pre class="log">${esc(curl.join(' \\\n  '))}</pre>
      </details>
      ${page.history.length > 1 ? `<div class="small muted" style="margin-top:10px">Earlier: ${page.history.slice(1).map((x) => `${esc(x.label)} <span class="badge ${x.status && x.status < 300 ? 'ok' : 'warn'}">${x.status || '-'}</span>`).join(' · ')}</div>` : ''}`;
  }

  // A simple form for an item, built from the fields this API accepts.
  function itemForm({ title, item, onSubmit }) {
    const fields = page.fields.filter((x) => !x.readonly && !x.hidden && x.name !== '_id');
    const known = new Set(page.fields.map((x) => x.name));
    const extra = item && !(a.writable || []).length ? Object.keys(item).filter((k) => !known.has(k) && k !== '_id') : [];
    const box = document.createElement('div');
    const val = (name) => {
      const v = item?.[name];
      if (v && typeof v === 'object') return v.$date || v.$oid || JSON.stringify(v);
      return v ?? '';
    };
    const kind = (f) => (f.type.startsWith('number') ? 'number' : f.type.startsWith('boolean') ? 'bool' : f.type === 'array' || f.type === 'object' ? 'json' : 'text');
    const row = (name, k, required) => `<label class="field"><span>${esc(name)}${required ? ' <span style="color:var(--bad)">*</span>' : ''} <span class="muted small">${k === 'json' ? '(JSON)' : k === 'number' ? '(number)' : ''}</span></span>${
      k === 'bool'
        ? `<select data-name="${esc(name)}" data-kind="bool"><option value="">(leave out)</option><option value="true" ${val(name) === true ? 'selected' : ''}>Yes (true)</option><option value="false" ${val(name) === false ? 'selected' : ''}>No (false)</option></select>`
        : k === 'json'
          ? `<textarea data-name="${esc(name)}" data-kind="json" class="mono" rows="2">${esc(val(name))}</textarea>`
          : `<input data-name="${esc(name)}" data-kind="${k}" value="${esc(val(name))}" ${k === 'number' ? 'inputmode="decimal"' : ''}>`
    }</label>`;
    box.innerHTML = `
      ${fields.length || extra.length ? '' : '<p class="small muted">No fields are known yet. Add your own below.</p>'}
      <div class="form-grid">${fields.map((x) => row(x.name, kind(x), x.required && !item)).join('')}${extra.map((n) => row(n, 'text', false)).join('')}</div>
      ${(a.writable || []).length ? '' : '<div id="if-extra"></div><div class="row" style="margin-top:6px"><input id="if-name" class="mono" placeholder="another field" style="width:180px"><button type="button" class="btn-sm" data-if="add">+ Add field</button></div>'}
      ${Object.keys(a.set || {}).length ? `<p class="small muted">Always saved with ${esc(JSON.stringify(a.set))} (set by this API).</p>` : ''}
      <p class="small muted">Empty boxes are left out.${item ? ' Only the fields you change are sent.' : ''}</p>`;
    box.addEventListener('click', (e) => {
      if (e.target.dataset.if !== 'add') return;
      const n = box.querySelector('#if-name').value.trim();
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(n)) return toast('Field names: letters, numbers, _ . -', 'error');
      box.querySelector('#if-extra').insertAdjacentHTML('beforeend', `<div class="form-grid">${row(n, 'text', false)}</div>`);
      box.querySelector('#if-name').value = '';
    });
    modal({
      title,
      wide: true,
      body: box,
      actions: [
        { label: 'Cancel' },
        {
          label: item ? 'Save changes' : 'Add item',
          className: 'btn-primary',
          onClick: async () => {
            const out = {};
            for (const input of box.querySelectorAll('[data-name]')) {
              const n = input.dataset.name;
              const raw = input.value;
              if (raw === '') continue;
              let v = raw;
              if (input.dataset.kind === 'number') {
                if (!Number.isFinite(Number(raw))) throw new Error(`${n} must be a number`);
                v = Number(raw);
              } else if (input.dataset.kind === 'bool') v = raw === 'true';
              else if (input.dataset.kind === 'json') {
                try {
                  v = JSON.parse(raw);
                } catch {
                  throw new Error(`${n} is not valid JSON`);
                }
              }
              if (item && String(raw) === String(val(n))) continue;
              out[n] = v;
            }
            await onSubmit(out);
          },
        },
      ],
    });
  }

  async function act(op, method, path, reqBody, label) {
    const h = await send(op, method, path, reqBody, label);
    showResult(h);
    if (h.status && h.status < 300 && op !== 'get') {
      if (op === 'create' && h.body && typeof h.body === 'object') page.fields = inferFields([...(await ctx.samples(info.database, a.collection)), h.body], a);
      loadList();
    }
    return h;
  }

  // ---------- what it can do (settings) ----------

  // Simple filters show as rows ("status is published"); anything else is edited as JSON.
  function conditionsFrom(filter, params) {
    const rows = [];
    for (const [field, v] of Object.entries(filter || {})) {
      if (field.startsWith('$')) return null;
      let opName = 'eq';
      let value = v;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const keys = Object.keys(v);
        if (keys.length === 1 && ['$ne', '$gt', '$gte', '$lt', '$lte'].includes(keys[0])) {
          opName = keys[0].slice(1);
          value = v[keys[0]];
        } else if (keys.includes('$regex') && keys.every((k) => k === '$regex' || k === '$options')) {
          opName = 'contains';
          value = String(v.$regex).replace(/\\(.)/g, '$1');
        } else return null;
      }
      if (value && typeof value === 'object') return null;
      const m = typeof value === 'string' && value.match(/^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$/);
      const p = m && (params || []).find((x) => x.name === m[1]);
      rows.push({ field, op: opName, source: m ? 'link' : 'fixed', value: m ? m[1] : String(value), type: p ? p.type : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string', required: p ? p.required : true });
    }
    return rows;
  }

  function drawSetup() {
    const conds = conditionsFrom(a.filter, a.params);
    const hasFilter = Object.keys(a.filter || {}).length > 0;
    const knownFields = [...new Set([...page.fields.map((x) => x.name), ...(a.hidden || []), ...(a.readonly || []), ...(a.required || []), ...(a.writable || []), ...Object.keys(a.set || {})])].filter((n) => n !== '_id');
    const shownList = String(a.fields || '').split(',').map((x) => x.trim()).filter(Boolean);
    const isShown = (n) => !(a.hidden || []).includes(n) && (!shownList.length || shownList.includes(n));
    const whitelist = (a.writable || []).length > 0;
    const canFill = (n) => (whitelist ? a.writable.includes(n) : !(a.readonly || []).includes(n));
    const fieldRow = (n) => `<tr data-field="${esc(n)}">
        <td class="mono">${esc(n)}</td>
        <td class="c"><input type="checkbox" data-f="show" ${isShown(n) ? 'checked' : ''}></td>
        <td class="c"><input type="checkbox" data-f="fill" ${canFill(n) ? 'checked' : ''}></td>
        <td class="c"><input type="checkbox" data-f="req" ${(a.required || []).includes(n) ? 'checked' : ''}></td>
        <td><input data-f="fixed" class="mono" value="${esc(a.set && n in a.set ? (typeof a.set[n] === 'string' ? a.set[n] : JSON.stringify(a.set[n])) : '')}" placeholder="(not fixed)"></td>
      </tr>`;
    const condRow = (c = { field: '', op: 'eq', source: 'fixed', value: '', type: 'string', required: true }) => `<div class="cond-row">
        <input data-c="field" class="mono" value="${esc(c.field)}" placeholder="field" list="setup-fields">
        <select data-c="op">${COND_OPS.map(([v, l]) => `<option value="${v}" ${c.op === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select data-c="source"><option value="fixed" ${c.source === 'fixed' ? 'selected' : ''}>this value</option><option value="link" ${c.source === 'link' ? 'selected' : ''}>a value from the link</option></select>
        <input data-c="value" value="${esc(c.value)}">
        <select data-c="type">${[['string', 'text'], ['number', 'number'], ['boolean', 'yes/no'], ['date', 'date'], ['objectId', 'id']].map(([v, l]) => `<option value="${v}" ${c.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label class="check small cond-req" style="margin:0" title="Callers must give this value"><input type="checkbox" data-c="required" ${c.required ? 'checked' : ''}> must be given</label>
        <button type="button" class="btn-sm btn-ghost" data-s="rmcond">✕</button>
      </div>`;
    bodyEl.innerHTML = `
      <form id="setup">
      <div class="card">
        <h3 style="margin-top:0">Who can do what</h3>
        <div class="row small" style="margin-bottom:8px"><span class="muted">Quick choices:</span>${Object.entries(TEMPLATES).filter(([id]) => id !== 'custom').map(([id, t]) => `<button type="button" class="btn-sm" data-s="tpl" data-tpl="${id}">${esc(t.label)}</button>`).join('')}</div>
        <div class="table-wrap"><table class="who"><tbody>${OPS.map(
          (o) => `<tr><td><b>${o.verb}</b><div class="small muted mono">${o.method} /api/${esc(slug)}${o.suffix}</div></td>
            <td><div class="seg">${Object.entries(WHO).map(([m, l]) => `<label class="${a.ops[o.op] === m ? 'on' : ''}"><input type="radio" name="op-${o.op}" value="${m}" ${a.ops[o.op] === m ? 'checked' : ''}>${m === 'public' ? '🌐 ' : m === 'key' ? '🔑 ' : ''}${l}</label>`).join('')}</div></td></tr>`,
        ).join('')}</tbody></table></div>
        <p class="small muted" style="margin-bottom:0">"Apps with a key": make keys in the 🔑 Keys tab. Never put a key that can change data into web page code.</p>
      </div>

      <div class="card">
        <h3 style="margin-top:0">Which items</h3>
        <label class="check"><input type="radio" name="scope" value="all" ${hasFilter ? '' : 'checked'}> All items in <b>${esc(a.collection)}</b></label>
        <label class="check"><input type="radio" name="scope" value="some" ${hasFilter ? 'checked' : ''}> Only items where…</label>
        <div id="scope-some" class="${hasFilter ? '' : 'hidden'}" style="margin-left:24px">
          <div id="conds" class="${conds ? '' : 'hidden'}">${(conds && conds.length ? conds : [undefined]).map(condRow).join('')}</div>
          <datalist id="setup-fields">${knownFields.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
          <div class="row small" style="margin-top:6px"><button type="button" class="btn-sm ${conds ? '' : 'hidden'}" data-s="addcond">+ and also…</button><span class="grow"></span><a href="#" data-s="json">${conds ? 'Edit as JSON (advanced)' : 'Use the simple editor'}</a></div>
          <div id="filter-json" class="${conds ? 'hidden' : ''}">
            <label class="field"><span>MongoDB filter (JSON)</span><textarea name="filterJson" class="mono" rows="4">${esc(JSON.stringify(a.filter || {}, null, 2))}</textarea><small>Use "{{name}}" for a value from the link, e.g. { "author": "{{author}}" }, and list it below.</small></label>
            <label class="field"><span>Values from the link (JSON list)</span><textarea name="paramsJson" class="mono" rows="3">${esc(JSON.stringify(a.params || [], null, 2))}</textarea><small>e.g. [ { "name": "author", "type": "string", "required": true } ]</small></label>
          </div>
          <p class="small muted">A value from the link: callers add it to the address, e.g. <span class="mono">/api/${esc(slug)}?author=ravi</span>. It is only ever used as a value, never as a command.</p>
        </div>
        <label class="check"><input type="checkbox" name="callerFilters" ${a.callerFilters !== false ? 'checked' : ''}> Callers may narrow the list further (e.g. <span class="mono">?status=active</span>)</label>
      </div>

      <div class="card">
        <h3 style="margin-top:0">Fields</h3>
        <div class="table-wrap"><table class="small fields-table"><thead><tr><th>Field</th><th>Show to callers</th><th>Can be filled in</th><th>Required when adding</th><th>Always set to</th></tr></thead>
          <tbody>${knownFields.map(fieldRow).join('')}</tbody></table></div>
        <div class="row" style="margin-top:8px"><input id="new-field" class="mono" placeholder="another field" style="width:200px"><button type="button" class="btn-sm" data-s="addfield">+ Add field</button></div>
        <label class="check" style="margin-top:10px"><input type="checkbox" name="whitelist" ${whitelist ? 'checked' : ''}> Ignore any field that is not ticked "Can be filled in" (safest for public forms)</label>
        <label class="check"><input type="checkbox" name="timestamps" ${a.timestamps !== false ? 'checked' : ''}> Save when items are added and changed (createdAt / updatedAt)</label>
        <p class="small muted" style="margin-bottom:0">Not ticked "Show": never sent back, e.g. passwords or internal notes. "Always set to": saved on every new or changed item, whatever callers send (e.g. status = new).</p>
      </div>

      <div class="card">
        <h3 style="margin-top:0">Order and page size</h3>
        <div class="form-grid">
          <label class="field"><span>Order</span><select name="sortField"><option value="">Newest first</option>${knownFields.map((n) => `<option value="${esc(n)}" ${(a.sort || '').replace(/^-/, '') === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
          <label class="field"><span>Direction</span><select name="sortDir"><option value="asc" ${!(a.sort || '').startsWith('-') ? 'selected' : ''}>A → Z, small → large, old → new</option><option value="desc" ${(a.sort || '').startsWith('-') ? 'selected' : ''}>Z → A, large → small, new → old</option></select></label>
          <label class="field"><span>Most items per page</span><input name="limit" type="number" min="1" max="1000" value="${esc(a.limit || info.maxLimit || 100)}"></label>
          <label class="check" style="margin-top:22px"><input type="checkbox" name="callerSort" ${a.callerSort !== false ? 'checked' : ''}> Callers may choose another order (<span class="mono">?sort=</span>)</label>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-top:0">Name and address</h3>
        <div class="form-grid">
          <label class="field"><span>Name</span><input name="title" value="${esc(a.title)}"></label>
          <label class="field"><span>Address</span><div class="row" style="flex-wrap:nowrap;gap:4px"><span class="mono muted">/api/</span><input name="slug" class="mono" value="${esc(slug)}"></div><small>Changing it breaks apps that use the old address.</small></label>
          <label class="field"><span>Folder</span><input name="group" value="${esc(a.group || '')}" placeholder="Website, Mobile app…"></label>
          <label class="field"><span>Data (collection in ${esc(info.database)})</span><input name="collection" class="mono" value="${esc(a.collection)}" list="setup-cols"><datalist id="setup-cols"></datalist></label>
        </div>
        <label class="field"><span>Description (shown in the docs)</span><textarea name="description" rows="2" placeholder="What this API is for">${esc(a.description || '')}</textarea></label>
      </div>

      <div class="save-bar"><button class="btn-primary">Save changes</button><span class="small muted">Live in about 2 seconds.</span><span class="grow"></span><button type="button" class="btn-danger" data-s="delete">Delete this API</button></div>
      </form>`;
    const form = bodyEl.querySelector('#setup');
    ctx.collections(info.database).then((cols) => {
      const dl = bodyEl.querySelector('#setup-cols');
      if (dl) dl.innerHTML = cols.map((c) => `<option value="${esc(c.name)}">`).join('');
    });
    if (!canEdit) {
      form.querySelectorAll('input, select, textarea, button').forEach((x) => (x.disabled = true));
      form.querySelector('.save-bar').remove();
    }
    const syncCond = (rowEl) => {
      const link = rowEl.querySelector('[data-c=source]').value === 'link';
      rowEl.querySelector('.cond-req').classList.toggle('hidden', !link);
      rowEl.querySelector('[data-c=value]').placeholder = link ? 'name in the link, e.g. author' : 'value';
      const opSel = rowEl.querySelector('[data-c=op]');
      opSel.querySelector('option[value=contains]').disabled = link;
      if (link && opSel.value === 'contains') opSel.value = 'eq';
    };
    form.querySelectorAll('.cond-row').forEach(syncCond);
    form.addEventListener('change', (e) => {
      const t = e.target;
      if (t.name === 'scope') form.querySelector('#scope-some').classList.toggle('hidden', t.value !== 'some');
      if (t.name?.startsWith('op-')) t.closest('.seg').querySelectorAll('label').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
      if (t.dataset.c === 'source') syncCond(t.closest('.cond-row'));
    });
    form.addEventListener('click', async (e) => {
      const s = e.target.closest('[data-s]')?.dataset.s;
      if (!s) return;
      e.preventDefault();
      if (s === 'tpl') {
        const t = TEMPLATES[e.target.dataset.tpl];
        for (const o of OPS) {
          const input = form.querySelector(`input[name=op-${o.op}][value=${t.ops[o.op]}]`);
          input.checked = true;
          input.closest('.seg').querySelectorAll('label').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
        }
        toast(`"${t.label}" applied. Save to use it.`);
      }
      if (s === 'addcond') {
        form.querySelector('#conds').insertAdjacentHTML('beforeend', condRow());
        syncCond(form.querySelector('#conds .cond-row:last-child'));
      }
      if (s === 'rmcond') e.target.closest('.cond-row').remove();
      if (s === 'addfield') {
        const n = form.querySelector('#new-field').value.trim();
        if (!/^[A-Za-z0-9_.-]{1,100}$/.test(n)) return toast('Field names: letters, numbers, _ . -', 'error');
        form.querySelector('.fields-table tbody').insertAdjacentHTML('beforeend', fieldRow(n));
        form.querySelector('#new-field').value = '';
      }
      if (s === 'json') {
        const toJson = !form.querySelector('#conds').classList.contains('hidden');
        try {
          if (toJson) {
            const built = buildFilter(form);
            form.filterJson.value = JSON.stringify(built.filter, null, 2);
            form.paramsJson.value = JSON.stringify(built.params, null, 2);
          } else {
            const rows = conditionsFrom(JSON.parse(form.filterJson.value || '{}'), JSON.parse(form.paramsJson.value || '[]'));
            if (!rows) return toast('This filter is too advanced for the simple editor; keep editing the JSON.', 'error');
            form.querySelector('#conds').innerHTML = (rows.length ? rows : [undefined]).map(condRow).join('');
            form.querySelectorAll('.cond-row').forEach(syncCond);
          }
        } catch (err) {
          return toast(err.message, 'error');
        }
        form.querySelector('#conds').classList.toggle('hidden', toJson);
        form.querySelector('[data-s=addcond]').classList.toggle('hidden', toJson);
        form.querySelector('#filter-json').classList.toggle('hidden', !toJson);
        e.target.textContent = toJson ? 'Use the simple editor' : 'Edit as JSON (advanced)';
      }
      if (s === 'delete') {
        if (!(await confirmDialog(`Delete the API "${a.title}" (/api/${slug})? Apps using it stop working. The data in ${a.collection} is not touched.`, { danger: true, confirmLabel: 'Delete API' }))) return;
        const ok = await run(null, () => api(`${ctx.base}/${svcName}/resources/${encodeURIComponent(slug)}`, { method: 'DELETE' }), 'API deleted');
        if (ok) location.hash = ctx.home;
      }
    });
    form.addEventListener('submit', async () => {
      let body;
      try {
        body = readSetup(form);
      } catch (err) {
        return toast(err.message, 'error');
      }
      const cfg = await run(form.querySelector('.save-bar .btn-primary'), () => api(`${ctx.base}/${svcName}/resources/${encodeURIComponent(slug)}`, { method: 'PUT', body }), 'Saved. Live in about 2 seconds.');
      if (cfg) {
        if (body.slug !== slug) location.hash = ctx.apiUrl(svcName, body.slug, 'setup');
        else renderApi(el, ctx, svcName, slug, 'setup');
      }
    });
  }

  function buildFilter(form) {
    const filter = {};
    const params = [];
    for (const r of form.querySelectorAll('#conds .cond-row')) {
      const field = r.querySelector('[data-c=field]').value.trim();
      const op = r.querySelector('[data-c=op]').value;
      const source = r.querySelector('[data-c=source]').value;
      const raw = r.querySelector('[data-c=value]').value.trim();
      const type = r.querySelector('[data-c=type]').value;
      if (!field) continue;
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(field)) throw new Error(`"${field}" is not a field name`);
      let value;
      if (source === 'link') {
        const name = raw || field.replace(/[^A-Za-z0-9_]/g, '_');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}": names in the link use letters, numbers and _`);
        if (!params.some((p) => p.name === name)) params.push({ name, type, required: r.querySelector('[data-c=required]').checked, default: '', description: `Value of ${field}` });
        value = `{{${name}}}`;
      } else if (type === 'number') {
        if (!Number.isFinite(Number(raw))) throw new Error(`${field}: "${raw}" is not a number`);
        value = Number(raw);
      } else if (type === 'boolean') value = ['true', 'yes', '1'].includes(raw.toLowerCase());
      else if (type === 'date') {
        if (Number.isNaN(new Date(raw).getTime())) throw new Error(`${field}: "${raw}" is not a date`);
        value = { $date: new Date(raw).toISOString() };
      } else if (type === 'objectId') value = { $oid: raw };
      else value = raw;
      const cond = op === 'eq' ? value : op === 'contains' ? { $regex: escapeRegex(String(raw)), $options: 'i' } : { [`$${op}`]: value };
      if (field in filter && op !== 'eq' && filter[field] && typeof filter[field] === 'object' && !Array.isArray(filter[field]) && !('$date' in filter[field]) && !('$oid' in filter[field])) Object.assign(filter[field], cond);
      else filter[field] = cond;
    }
    return { filter, params };
  }

  function readSetup(form) {
    const ops = Object.fromEntries(OPS.map((o) => [o.op, form.querySelector(`input[name=op-${o.op}]:checked`).value]));
    let filter = {};
    let params = [];
    if (form.querySelector('input[name=scope]:checked').value === 'some') {
      if (!form.querySelector('#conds').classList.contains('hidden')) ({ filter, params } = buildFilter(form));
      else {
        try {
          filter = JSON.parse(form.filterJson.value || '{}');
          params = JSON.parse(form.paramsJson.value || '[]');
        } catch {
          throw new Error('The filter or the values from the link are not valid JSON');
        }
      }
    }
    const rows = [...form.querySelectorAll('.fields-table tbody tr')];
    const whitelist = form.whitelist.checked;
    const set = {};
    for (const r of rows) {
      const fixed = r.querySelector('[data-f=fixed]').value.trim();
      if (!fixed) continue;
      let v = fixed;
      if (/^-?\d+(\.\d+)?$/.test(fixed)) v = Number(fixed);
      else if (fixed === 'true' || fixed === 'false') v = fixed === 'true';
      else if (/^[[{]/.test(fixed)) {
        try {
          v = JSON.parse(fixed);
        } catch {
          /* keep as text */
        }
      }
      set[r.dataset.field] = v;
    }
    const sortField = form.sortField.value;
    return {
      slug: form.slug.value.trim(),
      title: form.title.value.trim(),
      group: form.group.value.trim(),
      description: form.description.value.trim(),
      collection: form.collection.value.trim(),
      ops,
      filter,
      params,
      callerFilters: form.callerFilters.checked,
      callerSort: form.callerSort.checked,
      hidden: rows.filter((r) => !r.querySelector('[data-f=show]').checked).map((r) => r.dataset.field),
      fields: '',
      readonly: whitelist ? [] : rows.filter((r) => !r.querySelector('[data-f=fill]').checked).map((r) => r.dataset.field),
      writable: whitelist ? rows.filter((r) => r.querySelector('[data-f=fill]').checked).map((r) => r.dataset.field) : [],
      required: rows.filter((r) => r.querySelector('[data-f=req]').checked).map((r) => r.dataset.field),
      set,
      timestamps: form.timestamps.checked,
      sort: sortField ? `${form.sortDir.value === 'desc' ? '-' : ''}${sortField}` : '',
      limit: Number(form.limit.value) || 0,
    };
  }

  // ---------- code & docs ----------

  function drawCode() {
    const entries = catalog(info, [slug]);
    const plainSteps = {
      list: 'Get the items, e.g. to show them on a page.',
      get: 'Get one item by its id, e.g. for a detail page.',
      count: 'Get how many items there are.',
      create: 'Add a new item, e.g. from a form.',
      update: 'Change some fields of an item.',
      delete: 'Delete an item.',
    };
    const listE = entries.find((e) => e.op === 'list' && e.mode === 'public');
    const show = page.fields.filter((x) => !x.hidden && x.name !== '_id').slice(0, 3).map((x) => x.name);
    const prop = (n) => (/^[A-Za-z_$][\w$]*$/.test(n) ? `item.${n}` : `item["${n}"]`);
    bodyEl.innerHTML = `
      <div class="card">
        <div class="row"><h3 class="grow" style="margin:0">Docs for AI and developers</h3>
          <a class="btn" href="${ctx.docsUrl(svcName, slug)}">📖 Swagger docs</a><button data-action="copyDocs">Copy text</button><button data-action="previewDocs">Preview</button><button class="btn-primary" data-action="downloadDocs">⬇ Download .txt</button></div>
        <p class="small muted" style="margin-bottom:0">Everything about this API as plain text: address, what it allows, the fields and examples. Paste it into ChatGPT / Claude ("build me a page that shows these items"), a README or a message to a developer.</p>
      </div>
      ${
        entries.length
          ? entries
              .map((e) => {
                const d = details(info, e, page.fields);
                return `<div class="card code-step">
                  <div class="row"><span class="badge method-${e.method.toLowerCase()}">${e.method}</span><h3 class="grow" style="margin:0">${e.verb}</h3>${e.mode === 'key' ? '<span class="badge warn">🔑 needs a key</span>' : '<span class="badge ok">🌐 anyone</span>'}</div>
                  <p class="small" style="margin:6px 0">${plainSteps[e.op]}${e.mode === 'key' ? ' Do this from your server (backend), where the key stays secret.' : ''}</p>
                  <div class="seg code-tabs" data-k="${e.op}"><button class="on" data-action="codeTab" data-k="${e.op}" data-lang="js">JavaScript</button><button data-action="codeTab" data-k="${e.op}" data-lang="curl">curl</button></div>
                  <pre class="log" data-code="${e.op}-js">${esc(fetchFor(info, e, d, { node: e.mode === 'key' }))}</pre>
                  <pre class="log hidden" data-code="${e.op}-curl">${esc(curlFor(info, e, d))}</pre>
                </div>`;
              })
              .join('')
          : '<div class="card empty">Nothing is switched on yet. Open "What it can do".</div>'
      }
      ${
        listE
          ? `<div class="card"><h3 style="margin-top:0">A ready web page</h3><p class="small muted" style="margin-top:0">Save it as <span class="mono">index.html</span> on any website. It lists the items.</p>
          <pre class="log">${esc(`<!doctype html>
<html>
<body>
  <h1>${a.title}</h1>
  <ul id="items">Loading…</ul>
  <script>
    fetch("${url}?limit=20")
      .then((r) => r.json())
      .then(({ data }) => {
        document.getElementById("items").innerHTML = data
          .map((item) => "<li>" + ${show.length ? show.map((n) => `(${prop(n)} ?? "")`).join(' + " · " + ') : 'JSON.stringify(item)'} + "</li>")
          .join("");
      });
  </script>
</body>
</html>`)}</pre>${info.cors && !info.cors.includes('*') ? '<p class="small muted">The website\'s address must be in the API server\'s allowed websites (CORS).</p>' : ''}</div>`
          : ''
      }
      <details class="card"><summary><b>Full reference</b> (every option, for developers)</summary>
        <h4>Item fields</h4>${modelHtml(page.fields)}
        ${entries.map((e) => endpointHtml(info, e, page.fields)).join('')}
      </details>`;
  }

  // ---------- keys ----------

  function drawKeys() {
    const keys = (info.keys || []).filter((k) => k.access?.['*'] || k.access?.[slug]);
    const others = (info.keys || []).length - keys.length;
    bodyEl.innerHTML = `
      <div class="card flush">
        <div class="card-head"><h3 style="margin:0">Keys that can use ${esc(a.title)}</h3>${canEdit ? '<button class="btn-sm btn-primary" data-action="newKey">+ New key</button>' : ''}</div>
        <div class="table-wrap"><table><tbody>${
          keys
            .map((k) => {
              const ops = k.access[slug] || k.access['*'];
              return `<tr><td><b>${esc(k.label)}</b><div class="small muted mono">${esc(k.prefix)}…</div></td>
                <td class="small">Can: ${KEY_RIGHTS.filter(([op]) => ops.includes(op)).map(([, l]) => l.toLowerCase()).join(', ')}${k.access['*'] ? ' <span class="muted">(on every API of this server)</span>' : ''}</td>
                <td class="small muted">${new Date(k.createdAt).toLocaleDateString()}${k.createdBy ? ` by ${esc(k.createdBy)}` : ''}</td>
                <td class="actions">${canEdit ? `<button class="btn-sm btn-danger" data-action="revoke" data-id="${esc(k.id)}">Revoke</button>` : ''}</td></tr>`;
            })
            .join('') || '<tr><td class="empty">No key can use this API yet.</td></tr>'
        }</tbody></table></div>
      </div>
      <div class="card">
        <h3 style="margin-top:0">How keys work</h3>
        <p class="small" style="margin-top:0">A key is a long password for an app. Things set to "Apps with a key" only work when the app sends its key in the <span class="mono">x-api-key</span> header. Each key has its own rights, and you can revoke it at any time.</p>
        <p class="small muted" style="margin-bottom:0">Keep keys on your server (in environment variables, e.g. <span class="mono">DATA_API_KEY</span>), never in web page code.${others ? ` This API server has ${others} other key(s) for other APIs: <a href="${ctx.svcUrl(svcName, 'keys')}">all keys</a>.` : ''}</p>
      </div>`;
  }

  function newKey() {
    const box = document.createElement('div');
    box.innerHTML = `
      <label class="field"><span>Name</span><input name="label" placeholder="website backend" autocomplete="off"><small>So you remember where it is used.</small></label>
      <div class="field"><span>This key can, on ${esc(a.title)}:</span>${KEY_RIGHTS.map(([op, l]) => `<label class="check"><input type="checkbox" data-op="${op}" ${op === 'read' ? 'checked' : ''}> ${l}</label>`).join('')}</div>`;
    modal({
      title: `New key for ${a.title}`,
      body: box,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Create key',
          className: 'btn-primary',
          onClick: async () => {
            const ops = [...box.querySelectorAll('input[data-op]:checked')].map((i) => i.dataset.op);
            const k = await api(`${ctx.base}/${svcName}/keys`, { method: 'POST', body: { label: box.querySelector('input[name=label]').value, access: { [slug]: ops } } });
            showNewKey(k, ops.some((o) => o !== 'read'));
            info = await ctx.info(svcName);
            drawKeys();
          },
        },
      ],
    });
  }

  onAction(el, {
    tab: ({ tab: t }) => setTab(t),
    copyUrl: () => copy(url),
    upgrade: ({ svc }) => upgrade(ctx, svc, () => renderApi(el, ctx, svcName, slug, page.tab)),
    role: ({ role }) => {
      page.role = role;
      drawPlay();
    },
    reload: () => {
      page.search = bodyEl.querySelector('#pg-search').value.trim();
      loadList();
    },
    pageNav: ({ dir }) => {
      page.listPage = Math.max(1, page.listPage + Number(dir));
      loadList();
    },
    add: () =>
      itemForm({
        title: `Add an item to ${a.title}`,
        onSubmit: (data) => act('create', 'POST', `/api/${slug}`, data, 'Add an item'),
      }),
    view: async ({ i }) => {
      await act('get', 'GET', `/api/${slug}/${idOf(page.lastItems[i])}`, null, 'See one item');
      bodyEl.querySelector('#pg-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
    edit: ({ i }) => {
      const it = page.lastItems[i];
      itemForm({
        title: 'Change this item',
        item: it,
        onSubmit: (data) => {
          if (!Object.keys(data).length) throw new Error('Nothing changed');
          return act('update', 'PATCH', `/api/${slug}/${idOf(it)}`, data, 'Change an item');
        },
      });
    },
    del: async ({ i }) => {
      if (!(await confirmDialog('Delete this item? It is really deleted from the database.', { danger: true, confirmLabel: 'Delete' }))) return;
      await act('delete', 'DELETE', `/api/${slug}/${idOf(page.lastItems[i])}`, null, 'Delete an item');
    },
    raw: async () => {
      const m = bodyEl.querySelector('#pg-m').value;
      const p = bodyEl.querySelector('#pg-p').value.trim();
      const b = bodyEl.querySelector('#pg-b').value.trim();
      let parsed = null;
      if (b) {
        try {
          parsed = JSON.parse(b);
        } catch {
          return toast('The body is not valid JSON', 'error');
        }
      }
      const path = p.startsWith('/') ? p : `/${p}`;
      const op = m === 'POST' ? 'create' : m === 'DELETE' ? 'delete' : m !== 'GET' ? 'update' : /\/count(\?|$)/.test(path) ? 'count' : /^\/api\/[^/?]+\/[^/?]+/.test(path) ? 'get' : 'list';
      await act(op, m, path, parsed, `${m} ${path}`);
    },
    codeTab: ({ k, lang }) => {
      bodyEl.querySelectorAll(`[data-code^="${k}-"]`).forEach((x) => x.classList.toggle('hidden', x.dataset.code !== `${k}-${lang}`));
      bodyEl.querySelectorAll(`.code-tabs[data-k="${k}"] button`).forEach((x) => x.classList.toggle('on', x.dataset.lang === lang));
    },
    copyDocs: async () => copy(await textFor(ctx, info, [slug])),
    downloadDocs: async () => downloadText(`${slug}-api.txt`, await textFor(ctx, info, [slug])),
    previewDocs: async () => {
      const text = await textFor(ctx, info, [slug]);
      modal({ title: `${slug}-api.txt`, wide: true, body: `<pre class="log" style="max-height:62vh;white-space:pre-wrap">${esc(text)}</pre>`, actions: [{ label: 'Close' }, { label: '⬇ Download .txt', className: 'btn-primary', onClick: () => downloadText(`${slug}-api.txt`, text) }] });
    },
    newKey,
    revoke: async ({ id }) => {
      const k = info.keys.find((x) => x.id === id);
      if (!(await confirmDialog(`Revoke the key "${k.label}"? Apps using it stop working within 2 seconds.`, { danger: true, confirmLabel: 'Revoke' }))) return;
      const ok = await run(null, () => api(`${ctx.base}/${svcName}/keys/${id}`, { method: 'DELETE' }), 'Key revoked');
      if (ok) {
        info = await ctx.info(svcName);
        drawKeys();
      }
    },
  });

  setTab(tab);
}

// ======================= one API server =======================

async function renderService(el, ctx, svcName, startTab) {
  el.innerHTML = loadingHtml();
  let info;
  let dbs;
  try {
    [info, dbs] = await Promise.all([ctx.info(svcName), ctx.databases()]);
  } catch (err) {
    el.innerHTML = errorHtml(err);
    return;
  }
  const canEdit = hasAll('databases') || dbs.find((d) => d.name === info.database)?.access === 'edit';
  const online = info.status === 'online';
  const tabs = [
    ['apis', `APIs <span class="muted">${Object.keys(info.apis || {}).length}</span>`],
    ['keys', `Keys <span class="muted">${(info.keys || []).length}</span>`],
    ['settings', 'Settings'],
  ];
  el.innerHTML = `
    <div class="small" style="margin-bottom:6px"><a href="${ctx.home}">← All APIs</a></div>
    <div class="page-head"><div><h1>API server: ${esc(info.name)} <span class="badge ${online ? 'ok' : 'bad'}" style="vertical-align:middle">${esc(info.status)}</span></h1>
      <div class="sub">Answers the APIs for the database <b>${esc(info.database)}</b> · ${info.url ? `<a class="mono" href="${esc(info.url)}/health" target="_blank" rel="noopener">${esc(info.url)}</a>` : 'not published yet (private to the server)'}</div></div></div>
    ${info.needsUpgrade ? upgradeNotice(info) : ''}
    ${
      online
        ? ''
        : info.status === 'not running'
          ? `<div class="notice warn" style="margin-bottom:12px">The setup of this API server did not finish (for example Node.js or PM2 was missing).${canEdit ? ' <button class="btn-sm btn-primary" data-action="finish">Finish setup</button>' : ''}</div>`
          : `<div class="notice warn" style="margin-bottom:12px">The API server is ${esc(info.status)}. ${can('nodeapps') ? `See <a href="#/s/${ctx.server.id}/nodeapps">Node Apps</a> → ${esc(info.name)} → Logs.` : 'Ask the owner to check its logs.'}</div>`
    }
    <div class="tabs">${tabs.map(([id, l]) => `<button class="${startTab === id ? 'active' : ''}" data-action="stab" data-tab="${id}">${l}</button>`).join('')}</div>
    <div id="svc-body"></div>`;
  const body = el.querySelector('#svc-body');
  let tab = startTab;

  function draw(t) {
    tab = t;
    el.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    window.history.replaceState(null, '', ctx.svcUrl(svcName, t));
    const apis = Object.entries(info.apis || {});
    if (t === 'apis') {
      body.innerHTML = `<div class="api-cards">${apis
        .map(([slug, a]) => `<a class="card api-card" href="${ctx.apiUrl(svcName, slug)}"><b>${esc(a.title)}</b><div class="mono small muted">/api/${esc(slug)}</div><p class="small" style="margin:8px 0 0">${esc(summary(a))}</p><div class="small muted">Data: ${esc(a.collection)}</div></a>`)
        .join('')}<a class="card api-card add" href="${ctx.home}/new/${encodeURIComponent(info.database)}/-/${encodeURIComponent(svcName)}">+ New API</a></div>`;
    } else if (t === 'keys') {
      body.innerHTML = `<div class="card flush"><div class="card-head"><h3 style="margin:0">Keys</h3>${canEdit && !info.needsUpgrade ? '<button class="btn-sm btn-primary" data-action="newKey">+ New key</button>' : ''}</div>
        <div class="table-wrap"><table><tbody>${
          (info.keys || [])
            .map(
              (k) => `<tr><td><b>${esc(k.label)}</b><div class="small muted mono">${esc(k.prefix)}…</div></td>
              <td class="small">${Object.entries(k.access).map(([target, ops]) => `${target === '*' ? 'every API' : esc(info.apis?.[target]?.title || target)}: ${ops.map(esc).join(', ')}`).join('<br>')}</td>
              <td class="small muted">${new Date(k.createdAt).toLocaleDateString()}${k.createdBy ? ` by ${esc(k.createdBy)}` : ''}</td>
              <td class="actions">${canEdit ? `<button class="btn-sm btn-danger" data-action="revoke" data-id="${esc(k.id)}">Revoke</button>` : ''}</td></tr>`,
            )
            .join('') || '<tr><td class="empty">No keys yet.</td></tr>'
        }</tbody></table></div></div>`;
    } else {
      body.innerHTML = `
        <div class="grid grid-2" style="align-items:start">
          <div class="card">
            <h3 style="margin-top:0">Websites allowed to use it from the browser</h3>
            <form id="svc-settings">
              <label class="field"><span>Allowed websites (CORS)</span><textarea name="cors" rows="4" placeholder="https://myshop.com">${esc((info.cors || []).join('\n'))}</textarea><small>One per line, like https://myshop.com. * = any website.</small></label>
              <label class="field"><span>Requests per minute per visitor / key</span><input name="rateLimitPerMinute" type="number" min="0" value="${esc(info.rateLimitPerMinute)}"><small>0 = no limit.</small></label>
              <label class="field"><span>Most items per page (any API)</span><input name="maxLimit" type="number" min="1" value="${esc(info.maxLimit)}"></label>
              ${canEdit ? '<button class="btn-primary">Save</button>' : ''}
            </form>
          </div>
          <div>
            <div class="card" style="margin-bottom:12px">
              <h3 style="margin-top:0">Address</h3>
              <table class="small"><tbody>
                <tr><td class="muted" style="width:130px">On the internet</td><td class="mono">${info.url ? `<a href="${esc(info.url)}/health" target="_blank" rel="noopener">${esc(info.url)}</a>` : 'not yet'}</td></tr>
                <tr><td class="muted">On the server</td><td class="mono">http://127.0.0.1:${esc(info.port)}</td></tr>
                <tr><td class="muted">Folder</td><td class="mono">/var/www/${esc(info.name)}</td></tr>
                <tr><td class="muted">Engine</td><td>v${esc(info.engine || '?')}${info.latestEngine && info.engine && info.engine < info.latestEngine ? ` (v${info.latestEngine} available)` : ''}</td></tr>
              </tbody></table>
              ${canEdit && !info.url && info.port ? '<button class="btn-primary" data-action="publish" style="margin-top:10px">Publish on an address</button>' : ''}
            </div>
            ${
              canEdit
                ? `<div class="card" style="margin-bottom:12px"><h3 style="margin-top:0">Maintenance</h3><div class="row"><button data-action="upgrade">Update engine</button>${online ? '' : '<button data-action="finish">Finish setup / start</button>'}${can('nodeapps') ? `<a class="btn" href="#/s/${ctx.server.id}/nodeapps">Logs in Node Apps</a>` : ''}</div></div>
              <div class="card" style="border-color:var(--bad)"><h3 style="margin-top:0;color:var(--bad)">Danger zone</h3><p class="small">Deleting the API server deletes all ${apis.length} of its APIs and keys. The data in ${esc(info.database)} is not touched.</p><button class="btn-danger" data-action="deleteSvc">Delete API server</button></div>`
                : ''
            }
          </div>
        </div>`;
      body.querySelector('#svc-settings').addEventListener('submit', async (e) => {
        const f = e.target;
        const ok = await run(f.querySelector('button'), () => api(`${ctx.base}/${svcName}/settings`, { method: 'PUT', body: { cors: f.cors.value, rateLimitPerMinute: f.rateLimitPerMinute.value, maxLimit: f.maxLimit.value } }), 'Saved. Live in about 2 seconds.');
        if (ok) Object.assign(info, ok);
      });
      if (!canEdit) body.querySelectorAll('#svc-settings input, #svc-settings textarea').forEach((x) => (x.disabled = true));
    }
  }

  const reload = () => renderService(el, ctx, svcName, tab);
  onAction(el, {
    stab: ({ tab: t }) => draw(t),
    upgrade: () => upgrade(ctx, svcName, reload),
    newKey: () => {
      const apis = Object.entries(info.apis || {});
      const box = document.createElement('div');
      box.innerHTML = `<label class="field"><span>Name</span><input name="label" placeholder="website backend" autocomplete="off"></label>
        <div class="table-wrap"><table class="small"><thead><tr><th>API</th>${KEY_RIGHTS.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>
          <tr><td><b>Every API</b> <span class="muted">(also future ones)</span></td>${KEY_RIGHTS.map(([op]) => `<td><input type="checkbox" data-t="*" data-op="${op}"></td>`).join('')}</tr>
          ${apis.map(([slug, a]) => `<tr><td>${esc(a.title)} <span class="mono muted">/api/${esc(slug)}</span></td>${KEY_RIGHTS.map(([op]) => `<td><input type="checkbox" data-t="${esc(slug)}" data-op="${op}" ${op === 'read' ? 'checked' : ''}></td>`).join('')}</tr>`).join('')}
        </tbody></table></div>`;
      modal({
        title: `New key for ${info.name}`,
        wide: true,
        body: box,
        actions: [
          { label: 'Cancel' },
          {
            label: 'Create key',
            className: 'btn-primary',
            onClick: async () => {
              const access = {};
              for (const c of box.querySelectorAll('input[data-op]:checked')) (access[c.dataset.t] ||= []).push(c.dataset.op);
              const k = await api(`${ctx.base}/${svcName}/keys`, { method: 'POST', body: { label: box.querySelector('input[name=label]').value, access } });
              showNewKey(k, Object.values(access).some((o) => o.some((x) => x !== 'read')));
              info = await ctx.info(svcName);
              draw('keys');
            },
          },
        ],
      });
    },
    revoke: async ({ id }) => {
      const k = info.keys.find((x) => x.id === id);
      if (!(await confirmDialog(`Revoke the key "${k.label}"? Apps using it stop working within 2 seconds.`, { danger: true, confirmLabel: 'Revoke' }))) return;
      const ok = await run(null, () => api(`${ctx.base}/${svcName}/keys/${id}`, { method: 'DELETE' }), 'Key revoked');
      if (ok) {
        info = await ctx.info(svcName);
        draw('keys');
      }
    },
    publish: async () => {
      const job = await formDialog({
        title: `Publish ${info.name}`,
        intro: 'Gives the API server a web address so websites and apps can use its APIs. The domain must point to this server, and ports 80 / 443 must be open in Azure.',
        fields: [
          { name: 'domain', label: 'Domain', value: suggestedDomain(info.name), placeholder: 'api.example.com' },
          { name: 'https', label: 'Get a free HTTPS certificate', type: 'checkbox', value: true },
        ],
        submitLabel: 'Publish',
        submit: (x) => api(`${ctx.base}/${svcName}/publish`, { method: 'POST', body: x }),
      });
      if (job?.id) showJob(ctx.server.id, job, { onDone: reload });
    },
    finish: async () => {
      const v = await formDialog({
        title: `Finish setting up ${info.name}`,
        fields: [
          { name: 'domain', label: 'Public address (optional)', value: info.domain || suggestedDomain(info.name), placeholder: 'api.example.com' },
          { name: 'https', label: 'Get a free HTTPS certificate', type: 'checkbox', value: true },
        ],
        submitLabel: 'Finish setup',
        submit: (x) => api(ctx.base, { method: 'POST', body: { name: info.name, database: info.database, domain: x.domain.trim(), https: x.https } }),
      });
      if (v?.id) showJob(ctx.server.id, v, { onDone: reload });
    },
    deleteSvc: async () => {
      if (!(await confirmDialog(`Delete the API server ${info.name} and all its APIs and keys? Apps using them stop working. The data in ${info.database} is NOT touched.`, { danger: true, confirmLabel: 'Delete' }))) return;
      const ok = await run(null, () => api(`${ctx.base}/${svcName}`, { method: 'DELETE' }), 'API server deleted');
      if (ok) location.hash = ctx.home;
    },
  });
  draw(startTab);
}
