// What each API does, in plain words and as a reference: used by the API pages, the playground
// and the plain-text docs download (to give to an AI assistant, a README or a teammate).
import { esc } from '../ui.js';

// The six things an API can allow, in the order people think about them.
export const OPS = [
  { op: 'list', method: 'GET', suffix: '', verb: 'See the list', short: 'see the list', key: 'read' },
  { op: 'get', method: 'GET', suffix: '/:id', verb: 'See one item', short: 'see single items', key: 'read' },
  { op: 'count', method: 'GET', suffix: '/count', verb: 'Count items', short: 'count items', key: 'read' },
  { op: 'create', method: 'POST', suffix: '', verb: 'Add new items', short: 'add', key: 'create' },
  { op: 'update', method: 'PATCH', suffix: '/:id', verb: 'Change items', short: 'change', key: 'update' },
  { op: 'delete', method: 'DELETE', suffix: '/:id', verb: 'Delete items', short: 'delete', key: 'delete' },
];
export const WHO = { off: 'Nobody', public: 'Anyone', key: 'Apps with a key' };

const join = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// "Anyone can see the list and see single items. Apps with a key can add, change and delete."
export function summary(api) {
  const by = (mode) => OPS.filter((o) => api.ops?.[o.op] === mode).map((o) => o.short);
  const parts = [];
  if (by('public').length) parts.push(`Anyone can ${join(by('public'))}.`);
  if (by('key').length) parts.push(`Apps with a key can ${join(by('key'))}.`);
  if (!parts.length) return 'Nothing is switched on yet: nobody can use this API.';
  return parts.join(' ');
}

export function baseUrl(info) {
  return info.url || 'https://YOUR-API-ADDRESS';
}

// One entry per switched-on operation of the given APIs (all of them by default).
export function catalog(info, slugs = null) {
  const out = [];
  for (const [slug, api] of Object.entries(info.apis || {})) {
    if (slugs && !slugs.includes(slug)) continue;
    for (const o of OPS) {
      const mode = api.ops?.[o.op] || 'off';
      if (mode === 'off') continue;
      out.push({ key: `${slug}:${o.op}`, slug, api, ...o, path: `/api/${slug}${o.suffix}`, title: `${api.title}: ${o.verb.toLowerCase()}`, mode });
    }
  }
  return out;
}

// ---------- data model (from sample documents) ----------

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

// Fields seen in sample documents, as this API shows and accepts them.
export function inferFields(docs, api = {}) {
  const hidden = new Set(api.hidden || []);
  const shown = String(api.fields || '').split(',').map((x) => x.trim()).filter(Boolean);
  const map = new Map();
  for (const d of docs || []) {
    for (const [k, v] of Object.entries(d)) {
      const f = map.get(k) || { name: k, types: new Set(), example: undefined, seen: 0 };
      f.types.add(typeOf(v));
      f.seen++;
      if (f.example === undefined || f.example === null) f.example = exampleOf(v);
      map.set(k, f);
    }
  }
  const total = (docs || []).length;
  let fields = [...map.values()].map((f) => ({
    name: f.name,
    type: [...f.types].filter((t) => t !== 'null').join(' | ') || 'null',
    example: f.example,
    always: f.seen === total,
  }));
  if (!fields.some((f) => f.name === '_id')) fields.unshift({ name: '_id', type: 'objectId', example: null, always: true });
  for (const r of api.required || []) if (!fields.some((f) => f.name === r)) fields.push({ name: r, type: 'string', example: null });
  for (const w of api.writable || []) if (!fields.some((f) => f.name === w)) fields.push({ name: w, type: 'string', example: null });
  if (api.timestamps) for (const t of ['createdAt', 'updatedAt']) if (!fields.some((f) => f.name === t)) fields.push({ name: t, type: 'date', example: null });
  const writable = api.writable || [];
  fields = fields.map((f) => ({
    ...f,
    hidden: hidden.has(f.name) || (shown.length > 0 && f.name !== '_id' && !shown.includes(f.name)),
    required: (api.required || []).includes(f.name),
    readonly: f.name === '_id' || (api.readonly || []).includes(f.name) || (api.timestamps && ['createdAt', 'updatedAt'].includes(f.name)) || (writable.length > 0 && !writable.includes(f.name)) || f.name in (api.set || {}),
    fixed: api.set && f.name in api.set ? api.set[f.name] : undefined,
  }));
  fields.sort((a, b) => (a.name === '_id' ? -1 : b.name === '_id' ? 1 : 0));
  return fields;
}

function exampleDoc(fields) {
  const o = {};
  for (const f of fields) {
    if (f.readonly || f.hidden) continue;
    o[f.name] = f.example ?? (f.type.startsWith('number') ? 0 : f.type.startsWith('boolean') ? true : f.type.startsWith('date') ? '2025-01-31T10:00:00.000Z' : f.type === 'array' ? [] : f.type === 'object' ? {} : 'text');
  }
  return o;
}

// ---------- what each endpoint takes and returns ----------

export function details(info, e, fields) {
  const api = e.api;
  const max = Math.min(Number(api.limit) || Number(info.maxLimit) || 100, Number(info.maxLimit) || 100);
  const d = { pathParams: [], query: [], body: null, bodyFields: [], response: null, status: 200, notes: [] };
  const doc = `<${api.title} item>`;
  if (e.suffix === '/:id') d.pathParams.push({ name: 'id', type: 'string', required: true, description: 'The item _id (24-character hex string)' });
  for (const p of api.params || []) d.query.push({ name: p.name, type: p.type, required: p.required, description: [p.description, p.default !== '' ? `default ${p.default}` : ''].filter(Boolean).join('; ') });
  if (e.op === 'list') {
    d.query.push({ name: 'limit', type: 'number', description: `Items per page, default ${Math.min(20, max)}, max ${max}` });
    d.query.push({ name: 'page', type: 'number', description: 'Page number, starting at 1' });
    if (api.callerSort !== false) d.query.push({ name: 'sort', type: 'string', description: `Fields, - for descending, e.g. -createdAt. Default: ${api.sort || 'newest first'}` });
    d.query.push({ name: 'fields', type: 'string', description: 'Comma-separated fields to return' });
  }
  if ((e.op === 'list' || e.op === 'count') && api.callerFilters !== false) {
    d.query.push({ name: '<field>', type: 'string', description: 'Only items where the field equals this text, e.g. ?status=active' });
    d.query.push({ name: 'filter', type: 'JSON', description: 'A MongoDB filter as URL-encoded JSON, e.g. {"price":{"$gte":20}}' });
  }
  if (e.op === 'list') d.response = `{ "data": [ ${doc}, ... ], "total": 42, "limit": ${Math.min(20, max)}, "skip": 0 }`;
  if (e.op === 'count') d.response = '{ "count": 42 }';
  if (e.op === 'get') {
    d.response = doc;
    d.notes.push('404 if there is no such item (or this API does not show it).');
  }
  if (e.op === 'create' || e.op === 'update') {
    d.bodyFields = fields.filter((f) => !f.readonly).map((f) => ({ ...f, required: e.op === 'create' && f.required }));
    d.body = exampleDoc(fields);
    if (e.op === 'update') d.body = Object.fromEntries(Object.entries(d.body).slice(0, 2));
    d.status = e.op === 'create' ? 201 : 200;
    d.response = `${doc} (as saved, including _id)`;
    if (e.op === 'create' && (api.required || []).length) d.notes.push(`Required: ${api.required.join(', ')}.`);
    if ((api.writable || []).length) d.notes.push(`Only these fields are accepted; others are ignored: ${api.writable.join(', ')}.`);
    const ro = fields.filter((f) => f.readonly && !(api.writable || []).length).map((f) => f.name);
    if (ro.length) d.notes.push(`Ignored if sent (read-only or automatic): ${ro.join(', ')}.`);
    if (Object.keys(api.set || {}).length) d.notes.push(`Always saved with: ${JSON.stringify(api.set)}.`);
    if (e.op === 'update') d.notes.push('Send only the fields to change (PATCH). PUT with the same address replaces the whole item.');
  }
  if (e.op === 'delete') {
    d.response = '{ "deleted": true }';
    d.notes.push('404 if there is no such item (or this API does not show it).');
  }
  if (Object.keys(api.filter || {}).length) {
    d.notes.push(`Only items where: ${JSON.stringify(api.filter)}${(api.params || []).length ? ' ({{name}} is replaced by that value from the link; a missing optional value removes its condition)' : ''}.`);
  }
  if (e.op === 'list' && api.sort) d.notes.push(`Order: ${api.sort}.`);
  const hidden = fields.filter((f) => f.hidden).map((f) => f.name);
  if (hidden.length && ['list', 'get', 'create', 'update'].includes(e.op)) d.notes.push(`Never returned: ${hidden.join(', ')}.`);
  if (e.mode === 'key') d.notes.push(`Needs an API key with "${e.key}" access to ${e.slug}.`);
  return d;
}

function exampleUrl(info, e) {
  let path = e.path.replace(':id', '665f1c2ab4e3d2a1f0c9b123');
  const qs = (e.api.params || []).filter((p) => p.required).map((p) => `${p.name}=${encodeURIComponent(p.type === 'number' ? '10' : p.type === 'boolean' ? 'true' : p.type === 'date' ? '2025-01-31' : p.type === 'objectId' ? '665f1c2ab4e3d2a1f0c9b123' : 'value')}`);
  if (e.op === 'list') qs.push('limit=10');
  if (qs.length) path += `?${qs.join('&')}`;
  return `${baseUrl(info)}${path}`;
}

export function curlFor(info, e, d) {
  const parts = [`curl${e.method === 'GET' ? '' : ` -X ${e.method}`} "${exampleUrl(info, e)}"`];
  if (e.mode === 'key') parts.push('-H "x-api-key: YOUR_API_KEY"');
  if (d.body) parts.push(`-H "content-type: application/json" -d '${JSON.stringify(d.body).replace(/'/g, "'\\''")}'`);
  return parts.join(' \\\n  ');
}

export function fetchFor(info, e, d, { node = false } = {}) {
  const opts = [];
  if (e.method !== 'GET') opts.push(`method: "${e.method}"`);
  const headers = [];
  if (d.body) headers.push('"content-type": "application/json"');
  if (e.mode === 'key') headers.push(node ? '"x-api-key": process.env.DATA_API_KEY' : '"x-api-key": "YOUR_API_KEY"');
  if (headers.length) opts.push(`headers: { ${headers.join(', ')} }`);
  if (d.body) opts.push(`body: JSON.stringify(${JSON.stringify(d.body)})`);
  return `const res = await fetch("${exampleUrl(info, e)}"${opts.length ? `, {\n  ${opts.join(',\n  ')},\n}` : ''});
if (!res.ok) throw new Error((await res.json()).error);
const result = await res.json();`;
}

// ---------- HTML reference ----------

const authBadge = (mode) => (mode === 'key' ? '<span class="badge warn">🔑 key</span>' : mode === 'public' ? '<span class="badge ok">🌐 anyone</span>' : '<span class="badge">off</span>');

function paramTable(title, rows) {
  if (!rows.length) return '';
  return `<h4>${title}</h4><div class="table-wrap"><table class="small"><tbody>${rows
    .map((p) => `<tr><td class="mono" style="width:150px">${esc(p.name)}${p.required ? ' <span style="color:var(--bad)">*</span>' : ''}</td><td class="muted" style="width:90px">${esc(p.type || '')}</td><td>${esc(p.description || '')}</td></tr>`)
    .join('')}</tbody></table></div>`;
}

export function endpointHtml(info, e, fields) {
  const d = details(info, e, fields);
  return `<div class="card api-ref">
    <div class="row" style="margin-bottom:6px"><span class="badge method-${e.method.toLowerCase()}">${e.method}</span><h3 class="grow" style="margin:0">${esc(e.verb)}</h3>${authBadge(e.mode)}</div>
    <div class="mono small" style="margin-bottom:8px;word-break:break-all">${esc(baseUrl(info))}${esc(e.path)}</div>
    ${paramTable('In the address', d.pathParams)}
    ${paramTable('Options in the link (?name=value)', d.query)}
    ${d.bodyFields.length ? paramTable('What to send (JSON body)', d.bodyFields.map((f) => ({ name: f.name, type: f.type, required: f.required, description: f.example != null ? `e.g. ${JSON.stringify(f.example)}` : '' }))) : ''}
    ${d.notes.length ? `<ul class="small" style="padding-left:18px">${d.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <h4>Answer (${d.status})</h4><pre class="log">${esc(d.response || '')}</pre>
    <details><summary class="small"><b>Code</b> (JavaScript, curl)</summary><pre class="log">${esc(fetchFor(info, e, d))}</pre><pre class="log">${esc(curlFor(info, e, d))}</pre></details>
  </div>`;
}

export function modelHtml(fields) {
  return `<div class="table-wrap"><table class="small"><thead><tr><th>Field</th><th>Type</th><th>Example</th><th></th></tr></thead><tbody>${fields
    .filter((f) => !f.hidden)
    .map(
      (f) => `<tr><td class="mono">${esc(f.name)}</td><td class="muted">${esc(f.type)}</td><td class="mono small">${f.example != null ? esc(JSON.stringify(f.example)) : ''}</td>
      <td class="small muted">${[f.required ? 'required' : '', f.fixed !== undefined ? `always ${JSON.stringify(f.fixed)}` : f.readonly ? 'read-only' : '', !f.always && !f.required && f.name !== '_id' ? 'optional' : ''].filter(Boolean).join(', ')}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

// ---------- plain text ----------

const AUTH_TEXT = { public: 'none (anyone)', key: 'API key', off: 'off' };

// fieldsBySlug: slug -> inferFields(...) for that API.
export function docsText(info, entries, fieldsBySlug) {
  const base = baseUrl(info);
  const L = [];
  const slugs = [...new Set(entries.map((e) => e.slug))];
  L.push(slugs.length === 1 ? `# ${info.apis[slugs[0]].title} API - reference` : `# ${info.name} - REST API reference`);
  L.push('');
  L.push(`Base URL: ${base}${info.url ? '' : '  (replace with the API address once it is published)'}`);
  L.push(`APIs: ${slugs.map((s) => `/api/${s}`).join(', ')}`);
  L.push(`Generated by Serverboy on ${new Date().toISOString().slice(0, 10)}.`);
  L.push('');
  L.push('## Conventions');
  L.push('- Requests and responses are JSON. Send `content-type: application/json` with a body.');
  if (entries.some((e) => e.mode === 'key')) L.push('- Endpoints marked "Auth: API key" need the header `x-api-key: YOUR_API_KEY` (or `Authorization: Bearer YOUR_API_KEY`). Keep keys on a backend, never in browser code. "Auth: none" endpoints are public.');
  else L.push('- All endpoints listed here are public: no key needed.');
  L.push('- Every item has `_id`, a 24-character hex string. Dates are ISO 8601 strings, e.g. 2025-01-31T10:00:00.000Z.');
  L.push(`- Errors return a 4xx/5xx status and \`{ "error": "message" }\`: 400 invalid input, 401 missing or invalid key, 403 key not allowed, 404 not found or not allowed, 409 duplicate value${Number(info.rateLimitPerMinute) ? `, 429 more than ${info.rateLimitPerMinute} requests per minute` : ''}.`);
  L.push('');
  for (const slug of slugs) {
    const api = info.apis[slug];
    const fields = fieldsBySlug[slug] || [];
    L.push(`## API: ${api.title} (/api/${slug})`);
    if (api.description) L.push(api.description);
    L.push(summary(api));
    L.push('Item fields (from the data; may be incomplete):');
    for (const f of fields.filter((x) => !x.hidden)) {
      const flags = [f.required ? 'required when adding' : '', f.fixed !== undefined ? `always ${JSON.stringify(f.fixed)}` : f.readonly ? 'read-only' : '', !f.always && !f.required && f.name !== '_id' ? 'optional' : ''].filter(Boolean);
      L.push(`- ${f.name}: ${f.type}${flags.length ? ` (${flags.join(', ')})` : ''}${f.example != null ? `, e.g. ${JSON.stringify(f.example)}` : ''}`);
    }
    for (const e of entries.filter((x) => x.slug === slug)) {
      const d = details(info, e, fields);
      L.push('');
      L.push(`### ${api.title}: ${e.verb}`);
      L.push(`${e.method} ${base}${e.path}`);
      L.push(`Auth: ${AUTH_TEXT[e.mode]}`);
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
  }
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
