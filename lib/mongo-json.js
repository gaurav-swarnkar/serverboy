// Read the "JSON" that MongoDB tools print and turn it into Extended JSON documents:
//   - mongosh / Compass / Robo 3T output: { _id: ObjectId('…'), at: ISODate('…'), n: NumberLong(5) }
//     (unquoted keys, single quotes, comments, trailing commas, regex literals, undefined)
//   - mongoexport --pretty and printjson: documents one after another, over many lines
//   - a wrapper object: { "documents": [ … ] } (also data, items, results, records, rows, docs)
// Shell types become Extended JSON ({"$oid"}, {"$date"}, {"$numberLong"} …), which the import
// turns back into real MongoDB types with EJSON.parse.

class MongoJsonError extends Error {}

const WRAPPERS = ['documents', 'docs', 'data', 'items', 'results', 'records', 'rows'];

function hexToBase64(hex, what) {
  const h = String(hex).replace(/-/g, '');
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new MongoJsonError(`${what} needs hex digits`);
  return Buffer.from(h, 'hex').toString('base64');
}

function subTypeHex(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0 || v > 255) throw new MongoJsonError('BinData sub type must be 0-255');
  return v.toString(16).padStart(2, '0');
}

function dateValue(args, name) {
  if (!args.length) return { $date: new Date().toISOString() };
  const a = args[0];
  if (typeof a === 'number') return { $date: { $numberLong: String(Math.trunc(a)) } };
  if (a && typeof a === 'object' && a.$numberLong) return { $date: { $numberLong: a.$numberLong } };
  const d = new Date(String(a));
  if (Number.isNaN(d.getTime())) throw new MongoJsonError(`${name}("${a}") is not a valid date`);
  return { $date: d.toISOString() };
}

// MongoDB keeps only these regex flags (g and y mean nothing to a stored pattern).
const regexOptions = (f) => [...new Set(String(f || '').split('').filter((c) => 'ilmsux'.includes(c)))].sort().join('');

const numStr = (v, name) => {
  const s = typeof v === 'object' && v ? Object.values(v)[0] : v;
  if (!/^[-+]?\d+$/.test(String(s).trim())) throw new MongoJsonError(`${name} needs a whole number`);
  return String(s).trim().replace(/^\+/, '');
};

// The shell helpers MongoDB tools print, as Extended JSON.
const CALLS = {
  ObjectId: (a) => {
    if (!/^[0-9a-fA-F]{24}$/.test(String(a[0] ?? ''))) throw new MongoJsonError(`ObjectId needs 24 hex digits, got "${a[0] ?? ''}"`);
    return { $oid: String(a[0]).toLowerCase() };
  },
  ISODate: (a) => dateValue(a, 'ISODate'),
  Date: (a) => dateValue(a, 'Date'),
  NumberLong: (a) => ({ $numberLong: numStr(a[0], 'NumberLong') }),
  NumberInt: (a) => ({ $numberInt: String(Number(numStr(a[0], 'NumberInt')) | 0) }),
  NumberDecimal: (a) => ({ $numberDecimal: String(a[0]) }),
  Double: (a) => Number(a[0]),
  Timestamp: (a) => {
    const [t, i] = a[0] && typeof a[0] === 'object' ? [a[0].t, a[0].i] : [a[0], a[1]];
    return { $timestamp: { t: Number(t) || 0, i: Number(i) || 0 } };
  },
  BinData: (a) => ({ $binary: { base64: String(a[1] ?? ''), subType: subTypeHex(a[0]) } }),
  HexData: (a) => ({ $binary: { base64: hexToBase64(a[1] ?? '', 'HexData'), subType: subTypeHex(a[0]) } }),
  UUID: (a) => ({ $binary: { base64: hexToBase64(a[0] ?? '', 'UUID'), subType: '04' } }),
  MD5: (a) => ({ $binary: { base64: hexToBase64(a[0] ?? '', 'MD5'), subType: '05' } }),
  MinKey: () => ({ $minKey: 1 }),
  MaxKey: () => ({ $maxKey: 1 }),
  DBRef: (a) => ({ $ref: String(a[0]), $id: a[1], ...(a[2] ? { $db: String(a[2]) } : {}) }),
  RegExp: (a) => ({ $regularExpression: { pattern: String(a[0] ?? ''), options: regexOptions(a[1]) } }),
  Code: (a) => ({ $code: String(a[0] ?? '') }),
  Symbol: (a) => ({ $symbol: String(a[0] ?? '') }),
};
CALLS.ObjectID = CALLS.ObjectId;
CALLS.Long = CALLS.NumberLong;
CALLS.Int32 = CALLS.NumberInt;
CALLS.Decimal128 = CALLS.NumberDecimal;
CALLS.BSONRegExp = CALLS.RegExp;
CALLS.Binary = (a) => (typeof a[0] === 'string' ? CALLS.BinData([a[1] ?? 0, a[0]]) : CALLS.BinData(a));

function parse(text) {
  let i = 0;
  const n = text.length;

  function where(at = i) {
    const before = text.slice(0, at);
    const line = before.split('\n').length;
    const col = at - before.lastIndexOf('\n');
    return `line ${line}, column ${col}`;
  }
  const fail = (msg, at = i) => {
    throw new MongoJsonError(`${msg} at ${where(at)}`);
  };

  function skip() {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\uFEFF' || c === '\u00A0') i++;
      else if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) fail('A /* comment is never closed');
        i = end + 2;
      } else return;
    }
  }

  function string() {
    const q = text[i++];
    let out = '';
    for (;;) {
      if (i >= n) fail('A text value is never closed (missing quote)');
      const c = text[i++];
      if (c === q) return out;
      if (c === '\\') {
        const e = text[i++];
        if (e === 'u') {
          const h = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('Bad \\u escape', i - 2);
          out += String.fromCharCode(parseInt(h, 16));
          i += 4;
        } else if (e === 'x') {
          out += String.fromCharCode(parseInt(text.slice(i, i + 2), 16));
          i += 2;
        } else out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '' }[e] ?? e;
      } else out += c;
    }
  }

  function ident() {
    const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 200));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  }

  function number() {
    const m = /^[-+]?(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?|Infinity|NaN)/.exec(text.slice(i, i + 400));
    if (!m) fail('Expected a value');
    i += m[0].length;
    const s = m[0];
    if (/Infinity|NaN/.test(s)) return { $numberDouble: s.replace(/^\+/, '') };
    const v = /0[xX]/.test(s) ? (s.startsWith('-') ? -1 : 1) * parseInt(s.replace(/^[-+]/, ''), 16) : Number(s);
    // Whole numbers too big for a JavaScript number keep every digit.
    if (/^[-+]?\d+$/.test(s) && !Number.isSafeInteger(v)) {
      const b = BigInt(s);
      if (b >= -(2n ** 63n) && b < 2n ** 63n) return { $numberLong: b.toString() };
    }
    return v;
  }

  function regex() {
    const start = i++;
    let pattern = '';
    let inClass = false;
    for (;;) {
      if (i >= n || text[i] === '\n') fail('A /regex/ is never closed', start);
      const c = text[i++];
      if (c === '\\') {
        pattern += c + text[i++];
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      pattern += c;
    }
    const flags = /^[a-z]*/.exec(text.slice(i))[0];
    i += flags.length;
    return { $regularExpression: { pattern, options: regexOptions(flags) } };
  }

  function args() {
    skip();
    if (text[i] !== '(') return [];
    i++;
    const out = [];
    skip();
    while (text[i] !== ')') {
      out.push(value());
      skip();
      if (text[i] === ',') {
        i++;
        skip();
      } else if (text[i] !== ')') fail('Expected , or )');
    }
    i++;
    return out;
  }

  function object() {
    i++;
    const o = {};
    skip();
    while (text[i] !== '}') {
      if (i >= n) fail('A { is never closed');
      let key;
      const at = i;
      if (text[i] === '"' || text[i] === "'") key = string();
      else if (/[-\d]/.test(text[i])) key = String(number());
      else key = ident();
      if (key === null) fail('Expected a field name');
      skip();
      if (text[i] !== ':') fail(`Expected : after "${key}"`, at);
      i++;
      o[key] = value();
      skip();
      if (text[i] === ',') {
        i++;
        skip();
      } else if (text[i] !== '}') fail('Expected , or }');
    }
    i++;
    return o;
  }

  function array() {
    i++;
    const a = [];
    skip();
    while (text[i] !== ']') {
      if (i >= n) fail('A [ is never closed');
      a.push(value());
      skip();
      if (text[i] === ',') {
        i++;
        skip();
      } else if (text[i] !== ']') fail('Expected , or ]');
    }
    i++;
    return a;
  }

  function value() {
    skip();
    const c = text[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"' || c === "'") return string();
    if (c === '/') return regex();
    if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) return number();
    const at = i;
    let name = ident();
    if (name === null) fail(i >= n ? 'The file ends too early' : `Unexpected "${c}"`);
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null' || name === 'undefined') return null;
    if (name === 'Infinity' || name === 'NaN') return { $numberDouble: name };
    if (name === 'new') {
      skip();
      name = ident();
      if (name === null) fail('Expected a name after "new"');
    }
    const fn = CALLS[name];
    if (!fn) fail(`Unknown value "${name}"`, at);
    try {
      return fn(args());
    } catch (err) {
      if (err instanceof MongoJsonError && !/ at line /.test(err.message)) fail(err.message, at);
      throw err;
    }
  }

  // Top level: documents one after another, optionally separated by commas, or one array.
  const out = [];
  skip();
  while (i < n) {
    // mongosh prints this between pages of results.
    if (/^Type "it" for more/.test(text.slice(i, i + 20))) {
      while (i < n && text[i] !== '\n') i++;
    } else out.push(value());
    skip();
    if (text[i] === ',' || text[i] === ';') {
      i++;
      skip();
    }
  }
  return out;
}

// Documents from the parsed values: an array, a wrapper object, or documents one after another.
function toDocs(values) {
  let docs = values.length === 1 && Array.isArray(values[0]) ? values[0] : values.flatMap((v) => (Array.isArray(v) ? v : [v]));
  if (docs.length === 1) docs = unwrap(docs[0]) || docs;
  docs.forEach((d, k) => {
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new MongoJsonError(`Item ${k + 1} is not a document ({ ... })`);
  });
  return docs;
}

// { "documents": [ {...}, {...} ] } and the like: the documents inside.
function unwrap(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const keys = Object.keys(o);
  const list = keys.filter((k) => WRAPPERS.includes(k.toLowerCase()) && Array.isArray(o[k]));
  if (list.length !== 1) return null;
  const arr = o[list[0]];
  if (!arr.length || !arr.every((d) => d && typeof d === 'object' && !Array.isArray(d))) return null;
  // Only a wrapper: the other fields are counts, page numbers and the like, not data.
  const others = keys.filter((k) => k !== list[0]);
  if (!others.every((k) => o[k] === null || typeof o[k] !== 'object' || ['meta', 'pagination', 'page'].includes(k.toLowerCase()))) return null;
  return arr;
}

const parseMongoJson = (text) => toDocs(parse(text));

module.exports = { parseMongoJson, unwrap, MongoJsonError };
