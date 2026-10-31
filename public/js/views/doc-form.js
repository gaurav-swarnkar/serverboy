// Form for creating / editing a MongoDB document: one row per field with a name, a type and a
// value, so nobody has to write Extended JSON by hand. A JSON tab shows the same document
// as text. Values are produced as relaxed Extended JSON, which the server parses with EJSON.
import { esc, modal, toast } from '../ui.js';

const TYPES = [
  ['string', 'Text'],
  ['number', 'Number'],
  ['bool', 'Yes / No'],
  ['date', 'Date & time'],
  ['objectId', 'ObjectId'],
  ['array', 'List (JSON)'],
  ['object', 'Object (JSON)'],
  ['long', 'Big integer (Long)'],
  ['decimal', 'Decimal (exact)'],
  ['null', 'Empty (null)'],
];

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function typeOf(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (isPlain(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1) {
      if (keys[0] === '$oid') return 'objectId';
      if (keys[0] === '$date') return 'date';
      if (keys[0] === '$numberLong') return 'long';
      if (keys[0] === '$numberDecimal') return 'decimal';
      if (keys[0] === '$numberInt' || keys[0] === '$numberDouble') return 'number';
    }
    return 'object';
  }
  return 'string';
}

function dateText(v) {
  const d = v.$date;
  if (typeof d === 'string') return d;
  if (d && d.$numberLong) return new Date(Number(d.$numberLong)).toISOString();
  return new Date(d).toISOString();
}

// Value as shown in the input.
function display(v, type) {
  switch (type) {
    case 'objectId':
      return v.$oid;
    case 'date':
      return dateText(v);
    case 'long':
      return v.$numberLong;
    case 'decimal':
      return v.$numberDecimal;
    case 'number':
      return isPlain(v) ? Object.values(v)[0] : String(v);
    case 'array':
    case 'object':
      return JSON.stringify(v, null, 2);
    case 'bool':
      return v ? 'true' : 'false';
    case 'null':
      return '';
    default:
      return String(v ?? '');
  }
}

// An empty value of a type (new fields, and fields suggested from other documents).
function blank(type) {
  return { number: '', bool: 'true', date: new Date().toISOString(), array: '[]', object: '{}' }[type] ?? '';
}

function parseValue(name, type, text) {
  const t = String(text ?? '');
  const fail = (msg) => {
    throw new Error(`Field "${name}": ${msg}`);
  };
  switch (type) {
    case 'string':
      return t;
    case 'number': {
      if (t.trim() === '' || !Number.isFinite(Number(t))) fail('enter a number, e.g. 42 or 9.99');
      return Number(t);
    }
    case 'long':
      if (!/^-?\d+$/.test(t.trim())) fail('enter a whole number');
      return { $numberLong: t.trim() };
    case 'decimal':
      if (!/^-?\d+(\.\d+)?$/.test(t.trim())) fail('enter a number like 19.99');
      return { $numberDecimal: t.trim() };
    case 'bool':
      return t === 'true';
    case 'date': {
      const d = new Date(t.trim());
      if (!t.trim() || Number.isNaN(d.getTime())) fail('enter a date like 2025-01-31 or 2025-01-31T10:00:00Z');
      return { $date: d.toISOString() };
    }
    case 'objectId':
      if (!/^[0-9a-fA-F]{24}$/.test(t.trim())) fail('an ObjectId is 24 characters of 0-9 and a-f');
      return { $oid: t.trim().toLowerCase() };
    case 'array':
    case 'object': {
      let v;
      try {
        v = JSON.parse(t || (type === 'array' ? '[]' : '{}'));
      } catch {
        fail(`not valid JSON, e.g. ${type === 'array' ? '["red", "blue"]' : '{ "city": "Pune" }'}`);
      }
      if (type === 'array' && !Array.isArray(v)) fail('a list must start with [');
      if (type === 'object' && !isPlain(v)) fail('an object must start with {');
      return v;
    }
    default:
      return null;
  }
}

// Fields used by other documents of the collection, with their most common type.
export function suggestedFields(docs) {
  const seen = new Map();
  for (const d of docs || []) {
    for (const [k, v] of Object.entries(d)) {
      if (k === '_id') continue;
      const t = typeOf(v);
      const counts = seen.get(k) || {};
      counts[t] = (counts[t] || 0) + 1;
      seen.set(k, counts);
    }
  }
  return [...seen.entries()].map(([name, counts]) => {
    const type = Object.entries(counts).filter(([t]) => t !== 'null').sort((a, b) => b[1] - a[1])[0]?.[0] || 'string';
    return { name, type };
  });
}

/**
 * docForm({ title, doc, samples, onSave })
 *   doc      existing document (relaxed EJSON) to edit, or null for a new one
 *   samples  other documents of the collection, to suggest fields for a new document
 *   onSave   async (jsonText) => …   throw to keep the dialog open
 */
export function docForm({ title, doc = null, samples = [], onSave }) {
  const editing = Boolean(doc);
  const box = document.createElement('div');
  let mode = 'form';
  let rows = editing
    ? Object.entries(doc).map(([name, v]) => ({ name, type: typeOf(v), value: display(v, typeOf(v)) }))
    : suggestedFields(samples).map((f) => ({ ...f, value: f.type === 'date' ? '' : blank(f.type), suggested: true }));
  if (!editing && !rows.length) rows = [{ name: '', type: 'string', value: '' }];

  const rowHtml = (r, i) => {
    const isId = r.name === '_id' && editing;
    const input =
      r.type === 'bool'
        ? `<select data-r="value"><option value="true" ${r.value === 'true' ? 'selected' : ''}>Yes (true)</option><option value="false" ${r.value === 'false' ? 'selected' : ''}>No (false)</option></select>`
        : r.type === 'null'
          ? '<input disabled placeholder="null">'
          : r.type === 'array' || r.type === 'object'
            ? `<textarea data-r="value" class="mono" rows="${Math.min(8, Math.max(2, String(r.value).split('\n').length))}">${esc(r.value)}</textarea>`
            : `<div class="row" style="gap:4px;flex-wrap:nowrap"><input data-r="value" class="${['objectId', 'date', 'long', 'decimal', 'number'].includes(r.type) ? 'mono' : ''}" value="${esc(r.value)}" ${isId ? 'readonly' : ''}
                ${r.type === 'number' || r.type === 'decimal' ? 'inputmode="decimal"' : ''} placeholder="${r.type === 'date' ? '2025-01-31T10:00:00Z' : r.type === 'objectId' ? '24 hex characters' : ''}">${
                r.type === 'date' ? '<button type="button" class="btn-sm" data-f="now" title="Set to now">Now</button>' : ''
              }</div>`;
    return `<div class="df-row ${r.suggested ? 'suggested' : ''}" data-i="${i}">
      <input data-r="name" class="mono" value="${esc(r.name)}" placeholder="field name" ${isId ? 'readonly' : ''}>
      <select data-r="type" ${isId ? 'disabled' : ''}>${TYPES.map(([t, l]) => `<option value="${t}" ${r.type === t ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <div class="df-value">${input}</div>
      ${isId ? '<span></span>' : `<button type="button" class="btn-sm btn-ghost" data-f="remove" title="Remove field">✕</button>`}
    </div>`;
  };

  function readRows() {
    // Keep what was typed when re-drawing (type change, add / remove).
    box.querySelectorAll('.df-row').forEach((el) => {
      const r = rows[Number(el.dataset.i)];
      r.name = el.querySelector('[data-r=name]').value;
      r.type = el.querySelector('[data-r=type]').value;
      const v = el.querySelector('[data-r=value]');
      if (v) r.value = v.value;
    });
  }

  function toDoc() {
    readRows();
    const out = {};
    for (const r of rows) {
      const name = r.name.trim();
      if (!name) continue;
      if (r.suggested) continue; // a field suggested from other documents that was left alone
      if (name.startsWith('$')) throw new Error(`Field names cannot start with $ ("${name}")`);
      if (name in out) throw new Error(`The field "${name}" is there twice`);
      out[name] = parseValue(name, r.type, r.value);
    }
    return out;
  }

  function draw() {
    box.innerHTML = `
      <div class="row" style="margin-bottom:10px">
        <div class="tabs" style="margin:0;border:0">
          <button type="button" class="${mode === 'form' ? 'active' : ''}" data-f="mode" data-m="form">Form</button>
          <button type="button" class="${mode === 'json' ? 'active' : ''}" data-f="mode" data-m="json">JSON</button>
        </div>
        <span class="grow"></span>
        ${mode === 'form' && !editing ? '<span class="small muted">_id is added automatically</span>' : ''}
      </div>
      ${
        mode === 'form'
          ? `${!editing && rows.some((r) => r.suggested) ? '<p class="small muted" style="margin-top:0">Fields used by other documents in this collection are listed. Only the ones you fill in or change are saved.</p>' : ''}
            <div class="df-head"><span>Field</span><span>Type</span><span>Value</span><span></span></div>
            <div class="df-rows">${rows.map(rowHtml).join('')}</div>
            <button type="button" class="btn-sm" data-f="add" style="margin-top:8px">+ Add field</button>`
          : `<textarea spellcheck="false" class="mono" id="df-json" style="width:100%;height:50vh"></textarea>
            <p class="small muted">JSON / Extended JSON, e.g. {"$oid": "…"} for ObjectIds or {"$date": "2025-01-01T00:00:00Z"} for dates.</p>`
      }`;
    if (mode === 'json') box.querySelector('#df-json').value = jsonText;
  }

  let jsonText = '';
  function toJson() {
    jsonText = JSON.stringify(toDoc(), null, 2);
  }
  function fromJson() {
    const text = box.querySelector('#df-json').value;
    let v;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Error('The JSON is not valid; fix it or keep using the JSON tab');
    }
    if (!isPlain(v)) throw new Error('A document must be a JSON object { … }');
    jsonText = text;
    rows = Object.entries(v).map(([name, x]) => ({ name, type: typeOf(x), value: display(x, typeOf(x)) }));
  }

  box.addEventListener('change', (e) => {
    if (e.target.dataset.r === 'type') {
      readRows();
      const r = rows[Number(e.target.closest('.df-row').dataset.i)];
      // Keep the value when it still makes sense for the new type.
      try {
        parseValue('x', r.type, r.value);
      } catch {
        r.value = blank(r.type);
      }
      draw();
    }
  });
  box.addEventListener('input', (e) => {
    const row = e.target.closest('.df-row');
    if (row) rows[Number(row.dataset.i)].suggested = false;
  });
  box.addEventListener('click', (e) => {
    const f = e.target.closest('[data-f]')?.dataset.f;
    if (!f) return;
    try {
      if (f === 'add') {
        readRows();
        rows.push({ name: '', type: 'string', value: '' });
        draw();
        box.querySelector('.df-row:last-child [data-r=name]').focus();
      }
      if (f === 'remove') {
        readRows();
        rows.splice(Number(e.target.closest('.df-row').dataset.i), 1);
        draw();
      }
      if (f === 'now') {
        const input = e.target.closest('.df-row').querySelector('[data-r=value]');
        input.value = new Date().toISOString();
        rows[Number(e.target.closest('.df-row').dataset.i)].suggested = false;
      }
      if (f === 'mode') {
        const m = e.target.closest('[data-m]').dataset.m;
        if (m === mode) return;
        if (m === 'json') toJson();
        else fromJson();
        mode = m;
        draw();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  draw();
  modal({
    title,
    wide: true,
    body: box,
    actions: [
      { label: 'Cancel' },
      {
        label: editing ? 'Save' : 'Insert document',
        className: 'btn-primary',
        onClick: async () => {
          const text = mode === 'json' ? box.querySelector('#df-json').value : JSON.stringify(toDoc());
          if (mode === 'json') {
            try {
              JSON.parse(text);
            } catch {
              throw new Error('The JSON is not valid');
            }
          }
          await onSave(text);
        },
      },
    ],
  });
}
