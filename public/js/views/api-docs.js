// API reference for a Data API: one catalog of every endpoint (the standard ones and the
// custom ones), rendered as HTML for the portal and as plain text to download, e.g. to give
// to an AI assistant or paste into a wiki.
import { esc } from '../ui.js';

export const STANDARD_GROUP = 'Standard';
export const KIND_LABEL = { list: 'List (many documents)', count: 'Count', one: 'Get the first match', create: 'Create (form)' };

const AUTH_TEXT = { public: 'none (public)', key: 'API key', off: 'off' };

// ---------- catalog ----------

export function catalog(info) {
  const out = [];
  for (const [col, c] of Object.entries(info.collections || {})) {
    const add = (o) => out.push({ col, group: STANDARD_GROUP, custom: false, ...o });
    const m = c.endpoints || {};
    add({ id: 'list', key: `${col}:list`, method: 'GET', path: `/api/${col}`, title: `List ${col}`, desc: `Returns documents from ${col}, with filtering, sorting and paging.`, mode: m.list || 'off', kind: 'list' });
    add({ id: 'count', key: `${col}:count`, method: 'GET', path: `/api/${col}/count`, title: `Count ${col}`, desc: `Counts documents in ${col}, optionally filtered.`, mode: m.count || 'off', kind: 'count' });
    add({ id: 'get', key: `${col}:get`, method: 'GET', path: `/api/${col}/:id`, title: `Get one from ${col}`, desc: `Returns one document by its _id.`, mode: m.get || 'off', kind: 'get' });
    add({ id: 'create', key: `${col}:create`, method: 'POST', path: `/api/${col}`, title: `Create in ${col}`, desc: `Adds a new document to ${col}.`, mode: m.create || 'off', kind: 'create' });
    add({ id: 'update', key: `${col}:update`, method: 'PATCH', path: `/api/${col}/:id`, title: `Update in ${col}`, desc: `Changes only the fields you send; other fields stay as they are.`, mode: m.update || 'off', kind: 'update' });
    add({ id: 'replace', key: `${col}:replace`, method: 'PUT', path: `/api/${col}/:id`, title: `Replace in ${col}`, desc: `Replaces the whole document with the one you send (read-only fields and createdAt are kept).`, mode: m.replace || 'off', kind: 'replace' });
    add({ id: 'delete', key: `${col}:delete`, method: 'DELETE', path: `/api/${col}/:id`, title: `Delete from ${col}`, desc: `Deletes one document by its _id.`, mode: m.delete || 'off', kind: 'delete' });
    for (const ep of c.custom || []) {
      out.push({
        col,
        group: ep.group || 'Custom',
        custom: true,
        ep,
        id: ep.id,
        key: `${col}:v:${ep.id}`,
        method: ep.kind === 'create' ? 'POST' : 'GET',
        path: `/api/${col}/views/${ep.id}`,
        title: ep.title || ep.id,
        desc: ep.description || '',
        mode: ep.mode || 'off',
        kind: ep.kind,
      });
    }
  }
  return out;
}

// ---------- data model ----------

function typeOf(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') {
    if (v.$oid) return 'objectId';
    if (v.$date) return 'date';
    if (v.$numberDecimal || v.$numberLong || v.$numberInt || v.$numberDouble) return 'number';
    return 'object';
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return 'date';
  return typeof v;
}

function exampleOf(v) {
  const t = typeOf(v);
  if (t === 'objectId') return v.$oid;
  if (t === 'date') return typeof v === 'string' ? v : typeof v.$date === 'string' ? v.$date : new Date(Number(v.$date.$numberLong || v.$date)).toISOString();
  if (t === 'number' && typeof v === 'object') return Number(Object.values(v)[0]);
  if (t === 'object' || t === 'array') return null;
  if (typeof v === 'string' && v.length > 60) return `${v.slice(0, 57)}...`;
  return v;
}

// Fields seen in sample documents, with their type(s) and an example value.
export function inferFields(docs, c = {}) {
  const hidden = new Set(c.hidden || []);
  const map = new Map();
  for (const d of docs || []) {
    for (const [k, v] of Object.entries(d)) {
      if (hidden.has(k)) continue;
      const f = map.get(k) || { name: k, types: new Set(), example: undefined, seen: 0 };
      f.types.add(typeOf(v));
      f.seen++;
      if (f.example === undefined || f.example === null) f.example = exampleOf(v);
      map.set(k, f);
    }
  }
  const total = (docs || []).length;
  const fields = [...map.values()].map((f) => ({
    name: f.name,
    type: [...f.types].filter((t) => t !== 'null').join(' | ') || 'null',
    example: f.example,
    always: f.seen === total,
    required: (c.required || []).includes(f.name),
    readonly: f.name === '_id' || (c.readonly || []).includes(f.name) || (c.timestamps && ['createdAt', 'updatedAt'].includes(f.name)),
  }));
  if (!fields.some((f) => f.name === '_id')) fields.unshift({ name: '_id', type: 'objectId', example: null, always: true, readonly: true });
  for (const r of c.required || []) if (!fields.some((f) => f.name === r)) fields.push({ name: r, type: 'string', example: null, required: true });
  if (c.timestamps) for (const t of ['createdAt', 'updatedAt']) if (!fields.some((f) => f.name === t)) fields.push({ name: t, type: 'date', example: null, readonly: true });
  fields.sort((a, b) => (a.name === '_id' ? -1 : b.name === '_id' ? 1 : 0));
  return fields;
}

function exampleDoc(fields, { writable = false, only = null } = {}) {
  const o = {};
  for (const f of fields) {
    if (writable && f.readonly) continue;
    if (only && !only.includes(f.name)) continue;
    o[f.name] = f.example ?? (f.type.startsWith('number') ? 0 : f.type.startsWith('boolean') ? true : f.type.startsWith('date') ? '2025-01-31T10:00:00.000Z' : f.type === 'array' ? [] : f.type === 'object' ? {} : f.name === '_id' ? '665f1c2ab4e3d2a1f0c9b123' : 'text');
  }
  return o;
}

// ---------- what each endpoint takes and returns ----------

function details(info, e, fields) {
  const c = info.collections?.[e.col] || {};
  const max = Number(info.maxLimit) || 100;
  const d = { pathParams: [], query: [], body: null, bodyFields: [], response: null, status: 200, notes: [] };
  if (e.path.includes('/:id')) d.pathParams.push({ name: 'id', type: 'string', required: true, description: 'The document _id (24-character hex string)' });
  const docText = `<${e.col} document>`;
  if (!e.custom) {
    if (e.kind === 'list' || e.kind === 'count') {
      if (e.kind === 'list') {
        d.query.push({ name: 'limit', type: 'number', description: `Documents per page, default 20, max ${max}` });
        d.query.push({ name: 'page', type: 'number', description: 'Page number, starting at 1' });
        d.query.push({ name: 'skip', type: 'number', description: 'Alternative to page: documents to skip' });
        d.query.push({ name: 'sort', type: 'string', description: 'Comma-separated fields; prefix with - for descending, e.g. -createdAt,name. Default: newest _id first' });
        d.query.push({ name: 'fields', type: 'string', description: 'Comma-separated fields to return, e.g. title,price' });
      }
      d.query.push({ name: 'filter', type: 'JSON', description: 'A MongoDB filter as URL-encoded JSON, e.g. {"price":{"$gte":20}}. $where/$function are blocked' });
      d.query.push({ name: '<field>', type: 'string', description: 'Shortcut for an exact text match, e.g. ?status=active' });
      d.response = e.kind === 'list' ? `{ "data": [ ${docText}, ... ], "total": 42, "limit": 20, "skip": 0 }` : '{ "count": 42 }';
    } else if (e.kind === 'get') {
      d.query.push({ name: 'fields', type: 'string', description: 'Comma-separated fields to return' });
      d.response = docText;
      d.notes.push('404 if no document has this _id.');
    } else if (e.kind === 'create' || e.kind === 'update' || e.kind === 'replace') {
      d.bodyFields = fields.filter((f) => !f.readonly);
      d.body = exampleDoc(fields, { writable: true });
      if (e.kind === 'update') {
        d.body = Object.fromEntries(Object.entries(d.body).slice(0, 2));
        d.bodyFields = d.bodyFields.map((f) => ({ ...f, required: false }));
      }
      d.status = e.kind === 'create' ? 201 : 200;
      d.response = `${docText} (as saved, including _id)`;
      if (e.kind !== 'update' && (c.required || []).length) d.notes.push(`Required fields: ${c.required.join(', ')}.`);
      const ro = fields.filter((f) => f.readonly).map((f) => f.name);
      if (ro.length) d.notes.push(`Ignored if sent (read-only or automatic): ${ro.join(', ')}.`);
      if (e.kind === 'update') d.notes.push('Send only the fields to change.');
    } else if (e.kind === 'delete') {
      d.response = '{ "deleted": true }';
      d.notes.push('404 if no document has this _id.');
    }
  } else {
    const ep = e.ep;
    if (ep.kind === 'create') {
      const allowed = String(ep.fields || '').split(',').map((x) => x.trim()).filter(Boolean);
      d.bodyFields = fields.filter((f) => !f.readonly && (!allowed.length || allowed.includes(f.name)));
      for (const a of allowed) if (!d.bodyFields.some((f) => f.name === a)) d.bodyFields.push({ name: a, type: 'string' });
      d.body = exampleDoc(d.bodyFields, { writable: true });
      d.status = 201;
      d.response = `${docText} (as saved, including _id)`;
      if (allowed.length) d.notes.push(`Only these fields are accepted; anything else is ignored: ${allowed.join(', ')}.`);
      const req = [...new Set([...(c.required || []), ...(ep.required || [])])];
      if (req.length) d.notes.push(`Required fields: ${req.join(', ')}.`);
      if (Object.keys(ep.set || {}).length) d.notes.push(`Set automatically (cannot be overridden): ${JSON.stringify(ep.set)}.`);
    } else {
      for (const p of ep.params || []) d.query.push({ name: p.name, type: p.type, required: p.required, description: [p.description, p.default !== '' ? `default ${p.default}` : ''].filter(Boolean).join('; ') });
      if (ep.kind === 'list') {
        d.query.push({ name: 'limit', type: 'number', description: `Documents per page, max ${Math.min(Number(ep.limit) || max, max)}` });
        d.query.push({ name: 'page', type: 'number', description: 'Page number, starting at 1' });
        d.response = `{ "data": [ ${docText}, ... ], "total": 42, "limit": ${Math.min(Number(ep.limit) || max, max)}, "skip": 0 }`;
      } else if (ep.kind === 'count') d.response = '{ "count": 42 }';
      else {
        d.response = docText;
        d.notes.push('404 if nothing matches.');
      }
      if (Object.keys(ep.filter || {}).length) d.notes.push(`Matches documents where: ${JSON.stringify(ep.filter)}${(ep.params || []).length ? ' ({{name}} is replaced by that query parameter; a missing optional parameter removes its condition)' : ''}.`);
      else d.notes.push('Matches all documents in the collection.');
      if (ep.sort && ep.kind !== 'count') d.notes.push(`Sorted by: ${ep.sort}.`);
      if (ep.fields) d.notes.push(`Returns only: ${ep.fields}.`);
    }
  }
  if (e.mode === 'key') d.notes.push(`Needs an API key with "${e.kind === 'create' ? 'create' : ['update', 'replace'].includes(e.kind) ? 'update' : e.kind === 'delete' ? 'delete' : 'read'}" access to ${e.col}.`);
  return d;
}

function exampleUrl(info, e, d) {
  const base = info.url || 'https://YOUR-API-ADDRESS';
  let path = e.path.replace(':id', '665f1c2ab4e3d2a1f0c9b123');
  if (e.custom && e.ep.kind !== 'create') {
    const qs = (e.ep.params || []).filter((p) => p.required).map((p) => `${p.name}=${encodeURIComponent(p.type === 'number' ? '10' : p.type === 'boolean' ? 'true' : p.type === 'date' ? '2025-01-31' : p.type === 'objectId' ? '665f1c2ab4e3d2a1f0c9b123' : 'value')}`);
    if (qs.length) path += `?${qs.join('&')}`;
  } else if (!e.custom && e.kind === 'list') path += '?limit=10&sort=-createdAt';
  return `${base}${path}`;
}

export function curlFor(info, e, d) {
  const parts = [`curl${e.method === 'GET' ? '' : ` -X ${e.method}`} "${exampleUrl(info, e, d)}"`];
  if (e.mode === 'key') parts.push('-H "x-api-key: YOUR_API_KEY"');
  if (d.body) parts.push(`-H "content-type: application/json" -d '${JSON.stringify(d.body).replace(/'/g, "'\\''")}'`);
  return parts.join(' \\\n  ');
}

export function fetchFor(info, e, d) {
  const opts = [];
  if (e.method !== 'GET') opts.push(`method: "${e.method}"`);
  const headers = [];
  if (d.body) headers.push('"content-type": "application/json"');
  if (e.mode === 'key') headers.push('"x-api-key": process.env.DATA_API_KEY');
  if (headers.length) opts.push(`headers: { ${headers.join(', ')} }`);
  if (d.body) opts.push(`body: JSON.stringify(${JSON.stringify(d.body)})`);
  return `const res = await fetch("${exampleUrl(info, e, d)}"${opts.length ? `, {\n  ${opts.join(',\n  ')},\n}` : ''});
if (!res.ok) throw new Error((await res.json()).error);
const result = await res.json();`;
}

// ---------- HTML ----------

const authBadge = (mode) => (mode === 'key' ? '<span class="badge warn">🔑 API key</span>' : mode === 'public' ? '<span class="badge ok">🌐 public</span>' : '<span class="badge">off</span>');

function paramTable(title, rows) {
  if (!rows.length) return '';
  return `<h4>${title}</h4><table class="small"><tbody>${rows
    .map((p) => `<tr><td class="mono" style="width:160px">${esc(p.name)}${p.required ? ' <span style="color:var(--bad)">*</span>' : ''}</td><td class="muted" style="width:90px">${esc(p.type || '')}</td><td>${esc(p.description || '')}</td></tr>`)
    .join('')}</tbody></table>`;
}

export function endpointHtml(info, e, fields) {
  const d = details(info, e, fields);
  return `<div class="card api-ref" id="ref-${esc(e.key)}">
    <div class="row" style="margin-bottom:6px">
      <span class="badge method-${e.method.toLowerCase()}">${e.method}</span>
      <h3 class="grow" style="margin:0">${esc(e.title)}</h3>
      ${authBadge(e.mode)}
    </div>
    <div class="mono small" style="margin-bottom:8px;word-break:break-all">${esc(info.url || 'https://YOUR-API-ADDRESS')}${esc(e.path)}</div>
    <div class="small muted" style="margin-bottom:8px">${esc(e.col)} · ${esc(e.group)}${e.custom ? ` · ${esc(KIND_LABEL[e.kind] || e.kind)}` : ''}</div>
    ${e.desc ? `<p style="margin-top:0">${esc(e.desc)}</p>` : ''}
    ${e.mode === 'off' ? '<div class="notice warn small">This endpoint is turned off: it answers 404 until you enable it.</div>' : ''}
    ${paramTable('Path parameters', d.pathParams)}
    ${paramTable('Query parameters', d.query)}
    ${d.bodyFields.length ? paramTable('Body (JSON)', d.bodyFields.map((f) => ({ name: f.name, type: f.type, required: f.required, description: f.example != null ? `e.g. ${JSON.stringify(f.example)}` : '' }))) : ''}
    ${d.notes.length ? `<ul class="small" style="padding-left:18px">${d.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <h4>Response ${d.status}</h4><pre class="log">${esc(d.response || '')}</pre>
    <details><summary class="small"><b>Examples</b> (curl, JavaScript)</summary>
      <pre class="log">${esc(curlFor(info, e, d))}</pre>
      <pre class="log">${esc(fetchFor(info, e, d))}</pre>
    </details>
  </div>`;
}

export function modelHtml(col, fields) {
  return `<div class="table-wrap"><table class="small"><thead><tr><th>Field</th><th>Type</th><th>Example</th><th></th></tr></thead><tbody>${fields
    .map(
      (f) => `<tr><td class="mono">${esc(f.name)}</td><td class="muted">${esc(f.type)}</td><td class="mono small">${f.example != null ? esc(JSON.stringify(f.example)) : ''}</td>
      <td class="small muted">${[f.required ? 'required' : '', f.readonly ? 'read-only' : '', !f.always && !f.required && f.name !== '_id' ? 'optional' : ''].filter(Boolean).join(', ')}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

// ---------- plain text ----------

export function docsText(info, entries, fieldsByCol) {
  const base = info.url || 'https://YOUR-API-ADDRESS';
  const L = [];
  const cols = [...new Set(entries.map((e) => e.col))];
  L.push(`# ${info.name} - REST API reference`);
  L.push('');
  L.push(`Base URL: ${base}${info.url ? '' : '  (replace with the API address once it is published)'}`);
  L.push(`Database: ${info.database}`);
  L.push(`Collections covered: ${cols.join(', ')}`);
  L.push(`Endpoints: ${entries.length}`);
  L.push(`Generated by Serverboy on ${new Date().toISOString().slice(0, 10)}.`);
  L.push('');
  L.push('## Conventions');
  L.push('- Requests and responses are JSON. Send `content-type: application/json` with a body.');
  if (entries.some((e) => e.mode === 'key')) L.push('- Endpoints marked "Auth: API key" need the header `x-api-key: YOUR_API_KEY` (or `Authorization: Bearer YOUR_API_KEY`). Keep keys on a backend, never in browser code. Endpoints marked "Auth: none" are public.');
  else L.push('- All endpoints listed here are public: no key needed.');
  L.push('- Every document has `_id`, a 24-character hex string. Dates are ISO 8601 strings, e.g. 2025-01-31T10:00:00.000Z.');
  L.push(`- Errors return a 4xx/5xx status and \`{ "error": "message" }\`: 400 invalid input, 401 missing or invalid key, 403 key not allowed, 404 not found or endpoint off, 409 duplicate value${Number(info.rateLimitPerMinute) ? `, 429 more than ${info.rateLimitPerMinute} requests per minute` : ''}.`);
  L.push(`- Lists are paged: at most ${Number(info.maxLimit) || 100} documents per request.`);
  L.push('');
  for (const col of cols) {
    const fields = fieldsByCol[col] || [];
    L.push(`## Data model: ${col}`);
    L.push('Fields seen in the data (may be incomplete; extra fields are allowed):');
    for (const f of fields) {
      const flags = [f.required ? 'required on create' : '', f.readonly ? 'read-only' : '', !f.always && !f.required && f.name !== '_id' ? 'optional' : ''].filter(Boolean);
      L.push(`- ${f.name}: ${f.type}${flags.length ? ` (${flags.join(', ')})` : ''}${f.example != null ? `, e.g. ${JSON.stringify(f.example)}` : ''}`);
    }
    L.push('');
  }
  L.push('## Endpoints');
  for (const e of entries) {
    const d = details(info, e, fieldsByCol[e.col] || []);
    L.push('');
    L.push(`### ${e.title}`);
    L.push(`${e.method} ${base}${e.path}`);
    L.push(`Collection: ${e.col} | Group: ${e.group} | Auth: ${AUTH_TEXT[e.mode]}${e.mode === 'off' ? ' (currently turned off, answers 404)' : ''}`);
    if (e.desc) L.push(e.desc);
    const list = (title, rows) => {
      if (!rows.length) return;
      L.push(`${title}:`);
      for (const p of rows) L.push(`- ${p.name} (${p.type || 'string'}${p.required ? ', required' : ', optional'})${p.description ? `: ${p.description}` : ''}`);
    };
    list('Path parameters', d.pathParams);
    list('Query parameters', d.query);
    if (d.bodyFields.length) list('Body fields (JSON)', d.bodyFields.map((f) => ({ name: f.name, type: f.type, required: f.required })));
    for (const n of d.notes) L.push(`Note: ${n}`);
    L.push(`Response ${d.status}: ${d.response}`);
    L.push('Example:');
    L.push(curlFor(info, e, d));
  }
  L.push('');
  return L.join('\n');
}

export function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
