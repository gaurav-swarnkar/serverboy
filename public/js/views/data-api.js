// Shared pieces of the Data API UI (the full page is views/apis.js), the small "API" summary
// shown in a MongoDB collection, and the "Connect" guide.
import { api, esc, loadingHtml, errorHtml } from '../ui.js';

export const ENDPOINTS = [
  ['list', 'GET', '', 'List documents (filter, sort, pages)'],
  ['count', 'GET', '/count', 'Count documents'],
  ['get', 'GET', '/:id', 'Get one document'],
  ['create', 'POST', '', 'Create a document'],
  ['update', 'PATCH', '/:id', 'Update some fields'],
  ['replace', 'PUT', '/:id', 'Replace a whole document'],
  ['delete', 'DELETE', '/:id', 'Delete a document'],
];
export const PRESETS = {
  recommended: { label: 'Public read, key for writes', modes: { list: 'public', count: 'public', get: 'public', create: 'key', update: 'key', replace: 'key', delete: 'key' } },
  private: { label: 'Everything needs a key', modes: { list: 'key', count: 'key', get: 'key', create: 'key', update: 'key', replace: 'key', delete: 'key' } },
  readonly: { label: 'Read-only (public)', modes: { list: 'public', count: 'public', get: 'public', create: 'off', update: 'off', replace: 'off', delete: 'off' } },
};
export const MODE_LABEL = { off: 'Off', public: 'Public (anyone)', key: 'API key needed' };

export function suggestedDomain(name) {
  return location.hostname.endsWith('.sslip.io') ? `${name}.${location.hostname}` : '';
}

// ======================= API tab (summary) =======================

// Where the collection stands, with a link to the full API page.
export function apiPageUrl(server, dbName, col) {
  return `#/s/${server.id}/apis/${encodeURIComponent(dbName)}${col ? `/collections/${encodeURIComponent(col)}/endpoints` : ''}`;
}

export async function mountApiSummary(el, server, dbName, col, canEdit = true) {
  const page = apiPageUrl(server, dbName, col);
  const open = (label, primary = true) =>
    `<a class="btn ${primary ? 'btn-primary' : ''}" href="${page}">${label}</a> <a class="btn" href="${page}" target="_blank" rel="noopener" title="Open in a new browser tab">↗ New tab</a>`;
  el.innerHTML = loadingHtml();
  try {
    const found = (await api(`/servers/${server.id}/mongo/apis`)).find((a) => a.database === dbName && !a.broken);
    if (!found) {
      el.innerHTML = `<div class="card">
        <h3 style="margin-top:0">No API for ${esc(dbName)} yet</h3>
        <p class="small">An API lets your web pages and apps read and change this data over HTTPS, without a database password. You choose exactly which collections and actions are open.</p>
        ${canEdit ? `<div class="row">${open('Set up an API')}</div>` : '<p class="small muted">You have view access only; ask someone with edit access to create one.</p>'}
      </div>`;
      return;
    }
    const info = await api(`/servers/${server.id}/mongo/apis/${found.name}`);
    const c = info.collections?.[col];
    el.innerHTML = `<div class="card">
      <div class="row" style="margin-bottom:8px"><b>${esc(info.name)}</b><span class="badge ${info.status === 'online' ? 'ok' : 'bad'}">${esc(info.status)}</span>
        <span class="mono small">${info.url ? esc(info.url) : info.port ? `private: 127.0.0.1:${info.port}` : ''}</span></div>
      ${
        c
          ? `<table class="small" style="margin-bottom:12px"><tbody>${ENDPOINTS.filter(([id]) => c.endpoints[id] !== 'off')
              .map(([id, m, s]) => `<tr><td style="width:80px"><span class="badge method-${m.toLowerCase()}">${m}</span></td><td class="mono">/api/${esc(col)}${s}</td><td>${c.endpoints[id] === 'key' ? '🔑 key' : '🌐 public'}</td></tr>`)
              .join('')}${(c.custom || []).filter((x) => x.mode !== 'off')
              .map((x) => `<tr><td><span class="badge method-${x.kind === 'create' ? 'post' : 'get'}">${x.kind === 'create' ? 'POST' : 'GET'}</span></td><td class="mono">/api/${esc(col)}/views/${esc(x.id)}</td><td>${x.mode === 'key' ? '🔑 key' : '🌐 public'}</td></tr>`)
              .join('')}</tbody></table>`
          : `<p class="small muted"><span class="mono">${esc(col)}</span> is not available through the API.</p>`
      }
      <div class="row">${open(c ? 'Open API page' : canEdit ? `Expose ${esc(col)} on the API page` : 'Open API page')}</div>
      <p class="small muted" style="margin-bottom:0">Endpoints, custom endpoints, Try it, the API portal (with .txt docs download), keys and settings are on the API page (also in the menu: Hosting → APIs).</p>
    </div>`;
  } catch (err) {
    el.innerHTML = errorHtml(err);
  }
}

export function docsHtml(info, col, c) {
  const url = info.url || 'https://YOUR-API-ADDRESS';
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
        <p class="small muted" style="margin-top:0">Browsers cannot connect to MongoDB directly (and must never get the password). Use the <b>API page</b> (Hosting → APIs): it gives this collection a web address with exactly the actions you allow.</p>
        <ol class="small" style="padding-left:18px">
          <li>Open <a href="${apiPageUrl(server, dbName, col)}">the API page</a> → create the API service (one per database) → open <span class="mono">${esc(col)}</span>.</li>
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
        <li>Hide fields like passwords or internal notes on the API page, and allow only the websites that should call it (Settings → CORS).</li>
        <li>Back up the database regularly (Command book → MongoDB → Back up a database).</li>
      </ul>
    </div>`;
}
