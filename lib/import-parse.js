// Turn an uploaded file into MongoDB documents for "Import collection": a JSON array, one
// JSON document per line (mongoexport's default), a single JSON document, or CSV / TSV with a
// header row. Extended JSON ({"$oid": …}, {"$date": …}) is kept as is; mongosh parses it.

class ParseError extends Error {}

function detectFormat(name, text) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (ext === 'csv') return 'csv';
  if (ext === 'tsv' || ext === 'tab') return 'tsv';
  const start = text.trimStart()[0];
  if (start === '[') return 'json-array';
  if (start === '{') return 'ndjson';
  if (ext === 'json' || ext === 'ndjson' || ext === 'jsonl') return 'ndjson';
  return 'csv';
}

function parseJsonDocs(text, format) {
  if (format === 'json-array') {
    let v;
    try {
      v = JSON.parse(text);
    } catch (err) {
      throw new ParseError(`The file is not valid JSON: ${err.message}`);
    }
    if (!Array.isArray(v)) throw new ParseError('Expected a JSON array of documents: [ {...}, {...} ]');
    v.forEach((d, i) => {
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new ParseError(`Item ${i + 1} is not a document ({ ... })`);
    });
    return v;
  }
  // One document per line; or a single (possibly pretty-printed) document.
  const trimmed = text.trim();
  try {
    const one = JSON.parse(trimmed);
    if (Array.isArray(one)) return parseJsonDocs(trimmed, 'json-array');
    if (one && typeof one === 'object') return [one];
  } catch {
    /* not a single document: read it line by line */
  }
  const docs = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch (err) {
      throw new ParseError(`Line ${i + 1} is not valid JSON (${err.message}). Use a JSON array, or one document per line.`);
    }
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new ParseError(`Line ${i + 1} is not a document ({ ... })`);
    docs.push(d);
  }
  return docs;
}

// RFC 4180 CSV: quoted fields, "" escapes, newlines inside quotes.
function parseCsvRows(text, sep) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (quoted) throw new ParseError('A quoted value is never closed (missing ")');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x !== ''));
}

function typed(v) {
  const t = v.trim();
  if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  if (t === 'null') return null;
  return v;
}

function setPath(doc, key, value) {
  const parts = key.split('.');
  let o = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}

function parseCsvDocs(text, sep, { types = true } = {}) {
  const rows = parseCsvRows(text.replace(/^﻿/, ''), sep);
  if (rows.length < 2) throw new ParseError('A CSV file needs a header row with field names and at least one data row');
  const header = rows[0].map((h) => h.trim());
  header.forEach((h, i) => {
    if (!h) throw new ParseError(`Column ${i + 1} has no name in the header row`);
    if (h.startsWith('$')) throw new ParseError(`Field names cannot start with $ ("${h}")`);
  });
  if (new Set(header).size !== header.length) throw new ParseError('Two columns in the header row have the same name');
  return rows.slice(1).map((r) => {
    const d = {};
    header.forEach((h, i) => {
      const v = r[i] ?? '';
      if (v === '') return; // empty cell: leave the field out
      setPath(d, h, types ? typed(v) : v);
    });
    return d;
  });
}

function parseImport(buffer, filename, { types = true } = {}) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  if (!text.trim()) throw new ParseError('The file is empty');
  const format = detectFormat(filename, text);
  const docs = format === 'csv' || format === 'tsv' ? parseCsvDocs(text, format === 'tsv' ? '\t' : ',', { types }) : parseJsonDocs(text, format);
  if (!docs.length) throw new ParseError('No documents found in the file');
  const fields = [...new Set(docs.slice(0, 1000).flatMap((d) => Object.keys(d)))];
  return { format, docs, fields };
}

module.exports = { parseImport, ParseError };
