// The endpoints of one API as a compact table, each with a Test button that sends a real
// request and shows the answer underneath. Used on the API page and in Databases → APIs.
import { api, esc, toast, confirmDialog } from '../ui.js';
import { OPS, baseUrl, details, fetchFor, curlFor } from './api-docs.js';

const WHO_SHORT = { public: '🌐 Anyone', key: '🔑 Key' };

// A plain JSON body from the API's fields (what callers may send).
function sampleBody(fields) {
  const o = {};
  for (const f of fields) {
    if (f.readonly || f.hidden || f.name === '_id') continue;
    o[f.name] = f.example ?? (f.type.startsWith('number') ? 0 : f.type.startsWith('boolean') ? true : f.type === 'array' ? [] : f.type === 'object' ? {} : '');
  }
  return o;
}

/**
 * endpointTable(el, { serverId, svc, info, slug, fields, sampleId, canKey })
 *   info      the API server's details (GET /mongo/apis/:svc)
 *   fields    inferFields(...) for this API
 *   sampleId  an _id to prefill for get / update / delete
 *   canKey    may send requests with Serverboy's test key (edit access)
 */
export function endpointTable(el, { serverId, svc, info, slug, fields, sampleId = '', canKey = true }) {
  const a = info.apis[slug];
  const on = OPS.filter((o) => (a.ops?.[o.op] || 'off') !== 'off');
  const entry = (o) => ({ ...o, slug, api: a, mode: a.ops[o.op], path: `/api/${slug}${o.suffix}` });
  const required = (a.params || []).filter((p) => p.required).map((p) => `${p.name}=`);
  el.innerHTML = on.length
    ? `<div class="table-wrap"><table class="ep-table"><tbody>${on
        .map(
          (o) => `<tr class="ep-row" data-op="${o.op}">
            <td style="width:76px"><span class="badge method-${o.method.toLowerCase()}">${o.method}</span></td>
            <td class="mono small">/api/${esc(slug)}${o.suffix.replace(':id', '{id}')}</td>
            <td class="small muted ep-desc">${o.verb}</td>
            <td class="small" style="white-space:nowrap">${WHO_SHORT[a.ops[o.op]]}</td>
            <td class="actions"><button class="btn-sm btn-primary" data-ep="test" data-op="${o.op}">Test</button><button class="btn-sm" data-ep="code" data-op="${o.op}">Code</button></td>
          </tr>
          <tr class="ep-panel hidden" data-panel="${o.op}"><td colspan="5"></td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : '<div class="empty">Nothing is switched on. Open Settings.</div>';

  const panel = (op) => el.querySelector(`[data-panel="${op}"]`);
  const toggle = (op, html) => {
    const p = panel(op);
    const open = !p.classList.contains('hidden') && p.dataset.kind === html.kind;
    el.querySelectorAll('.ep-panel').forEach((x) => x.classList.add('hidden'));
    if (open) return null;
    p.dataset.kind = html.kind;
    p.querySelector('td').innerHTML = html.body;
    p.classList.remove('hidden');
    return p;
  };

  function testForm(o) {
    const needsId = o.suffix === '/:id';
    const hasQuery = o.op === 'list' || o.op === 'count' || (a.params || []).length;
    const hasBody = o.op === 'create' || o.op === 'update';
    const query = [...required, ...(o.op === 'list' ? ['limit=5'] : [])].join('&');
    const body = hasBody ? sampleBody(fields) : null;
    if (o.op === 'update' && body) for (const k of Object.keys(body).slice(1)) delete body[k];
    const as = a.ops[o.op] === 'key' && canKey ? 'key' : 'public';
    return `<div class="ep-test">
      <div class="row">
        ${needsId ? `<label class="small">id <input data-t="id" class="mono" value="${esc(sampleId)}" placeholder="item _id" style="width:230px"></label>` : ''}
        ${hasQuery ? `<label class="small grow">? <input data-t="q" class="mono" value="${esc(query)}" placeholder="field=value&limit=5" style="width:100%;max-width:340px"></label>` : ''}
        <label class="small">as <select data-t="as"><option value="public" ${as === 'public' ? 'selected' : ''}>anyone</option>${canKey ? `<option value="key" ${as === 'key' ? 'selected' : ''}>with key</option>` : ''}</select></label>
        <button class="btn-sm btn-primary" data-ep="send" data-op="${o.op}">Send</button>
      </div>
      ${hasBody ? `<textarea data-t="body" class="mono" rows="${Math.min(8, Object.keys(body).length + 2)}">${esc(JSON.stringify(body, null, 2))}</textarea>` : ''}
      <div data-t="out"></div>
    </div>`;
  }

  async function send(o, p) {
    const id = p.querySelector('[data-t=id]')?.value.trim();
    if (o.suffix === '/:id' && !id) return toast('Enter an item id', 'error');
    const q = (p.querySelector('[data-t=q]')?.value || '').trim().replace(/^\?/, '');
    const bodyText = p.querySelector('[data-t=body]')?.value || '';
    if (bodyText) {
      try {
        JSON.parse(bodyText);
      } catch {
        return toast('The body is not valid JSON', 'error');
      }
    }
    if (o.op === 'delete' && !(await confirmDialog('This really deletes the item from the database. Send?', { danger: true, confirmLabel: 'Delete it' }))) return;
    const path = `/api/${slug}${o.suffix.replace(':id', encodeURIComponent(id || ''))}${q ? `?${q}` : ''}`;
    const out = p.querySelector('[data-t=out]');
    out.innerHTML = '<span class="spinner"></span>';
    const as = p.querySelector('[data-t=as]').value;
    let r;
    try {
      r = await api(`/servers/${serverId}/mongo/apis/${svc}/test`, { method: 'POST', body: { method: o.method, path, body: o.op === 'create' || o.op === 'update' ? bodyText : '', auth: as === 'key' ? 'console' : 'none' } });
    } catch (err) {
      out.innerHTML = `<div class="ep-result bad">${esc(err.message)}</div>`;
      return;
    }
    const ok = r.status >= 200 && r.status < 300;
    const hint = r.status === 401 && as === 'public' ? ' · needs a key: switch to "with key"' : '';
    out.innerHTML = `<div class="ep-result ${ok ? 'ok' : r.status && r.status < 500 ? 'warn' : 'bad'}">
        <b>${r.status || 'no answer'}</b> <span class="muted small">${r.ms} ms · ${esc(o.method)} ${esc(path)}${hint}</span></div>
      <pre class="log" style="max-height:320px;margin-top:6px">${esc(typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2))}</pre>`;
    // Remember a real id for the next get / update / delete test.
    const first = r.body?._id || r.body?.data?.[0]?._id;
    if (first && !sampleId) sampleId = first.$oid || first;
  }

  el.onclick = (e) => {
    const b = e.target.closest('[data-ep]');
    if (!b) return;
    const o = on.find((x) => x.op === b.dataset.op);
    if (b.dataset.ep === 'test') toggle(o.op, { kind: 'test', body: testForm(o) });
    if (b.dataset.ep === 'code') {
      const en = entry(o);
      const d = details(info, en, fields);
      toggle(o.op, { kind: 'code', body: `<div class="ep-test"><pre class="log">${esc(fetchFor(info, en, d, { node: en.mode === 'key' }))}</pre><pre class="log">${esc(curlFor(info, en, d))}</pre></div>` });
    }
    if (b.dataset.ep === 'send') send(o, panel(o.op));
  };
  return { url: `${baseUrl(info)}/api/${slug}` };
}
