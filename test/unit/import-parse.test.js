'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseImport } = require('../../lib/import-parse');

test('CSV with types, quotes and a BOM', () => {
  const csv = '﻿name,price,active,note\n"Tea, green",4.5,true,"say ""hi"""\nCoffee,3,false,\n';
  const r = parseImport(Buffer.from(csv), 'items.csv');
  assert.equal(r.format, 'csv');
  assert.equal(r.docs.length, 2);
  assert.equal(r.docs[0].name, 'Tea, green');
  assert.equal(r.docs[0].price, 4.5);
  assert.equal(r.docs[0].active, true);
  assert.equal(r.docs[0].note, 'say "hi"');
  assert.deepEqual(r.fields, ['name', 'price', 'active', 'note']);
});

test('JSON array and JSON lines', () => {
  assert.equal(parseImport(Buffer.from('[{"a":1},{"a":2}]'), 'x.json').docs.length, 2);
  assert.equal(parseImport(Buffer.from('{"a":1}\n{"a":2}\n{"a":3}\n'), 'x.jsonl').docs.length, 3);
});

test('empty and broken files give clear errors', () => {
  assert.throws(() => parseImport(Buffer.from('   '), 'x.json'), /empty/);
  assert.throws(() => parseImport(Buffer.from('[{"a":1},'), 'x.json'));
});

const { BSON } = require('mongodb');
const ejson = (d) => BSON.EJSON.parse(JSON.stringify(d), { relaxed: false });

test('mongosh / Compass shell output is converted to Extended JSON', () => {
  const text = `[
  {
    _id: ObjectId('65a1b2c3d4e5f6a7b8c9d0e1'),
    name: 'Tea', // a comment
    at: ISODate("2024-01-02T03:04:05.678Z"),
    n: NumberLong("9007199254740993"), i: NumberInt(4), d: NumberDecimal("1.10"),
    ts: Timestamp({ t: 1700000000, i: 1 }), bin: BinData(0, "AQID"), u: UUID("01234567-89ab-cdef-0123-456789abcdef"),
    re: /ab[/]c/gi, created: new Date(0), gone: undefined, tags: ['a', "b",],
  },
]`;
  const r = parseImport(Buffer.from(text), 'out.json');
  assert.equal(r.format, 'mongo');
  const d = r.docs[0];
  assert.deepEqual(d._id, { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' });
  assert.deepEqual(d.at, { $date: '2024-01-02T03:04:05.678Z' });
  assert.deepEqual(d.n, { $numberLong: '9007199254740993' });
  assert.deepEqual(d.re, { $regularExpression: { pattern: 'ab[/]c', options: 'i' } });
  assert.equal(d.gone, null);
  assert.deepEqual(d.tags, ['a', 'b']);
  const real = ejson(d);
  assert.equal(real._id.toHexString(), '65a1b2c3d4e5f6a7b8c9d0e1');
  assert.ok(real.at instanceof Date);
  assert.equal(real.n.toString(), '9007199254740993');
  assert.equal(real.u.toHexString().replace(/-/g, ''), '0123456789abcdef0123456789abcdef');
  assert.deepEqual(r.fields.slice(0, 3), ['_id', 'name', 'at']);
});

test('mongoexport --pretty: documents one after another over many lines', () => {
  const text = '{\n  "_id": {"$oid": "65a1b2c3d4e5f6a7b8c9d0e1"},\n  "a": 1\n}\n{\n  "_id": {"$oid": "65a1b2c3d4e5f6a7b8c9d0e2"},\n  "a": 2\n}\n';
  const r = parseImport(Buffer.from(text), 'x.json');
  assert.equal(r.docs.length, 2);
  assert.equal(r.docs[1].a, 2);
});

test('mongosh find() output without brackets, and a wrapper object', () => {
  assert.equal(parseImport(Buffer.from("{ a: 1 }\n{ a: 2 }\nType \"it\" for more\n"), 'x.txt').docs.length, 2);
  const w = parseImport(Buffer.from('{"documents":[{"a":1},{"a":2}],"count":2}'), 'x.json');
  assert.equal(w.format, 'json-wrapper');
  assert.equal(w.docs.length, 2);
  // A real document with a list inside stays one document.
  assert.equal(parseImport(Buffer.from('{"items":[{"a":1}],"owner":{"x":1}}'), 'x.json').docs.length, 1);
});

test('a mongodump .bson file', () => {
  const id = new BSON.ObjectId();
  const buf = Buffer.concat([BSON.serialize({ _id: id, n: BSON.Long.fromString('9007199254740993'), at: new Date(0) }), BSON.serialize({ x: 1.5 })]);
  const r = parseImport(buf, 'products.bson');
  assert.equal(r.format, 'bson');
  assert.equal(r.docs.length, 2);
  const real = ejson(r.docs[0]);
  assert.equal(real._id.toHexString(), id.toHexString());
  assert.equal(real.n.toString(), '9007199254740993');
  assert.throws(() => parseImport(buf.subarray(0, buf.length - 3), 'products.bson'), /damaged|ends/);
});

test('MongoDB JSON errors say where', () => {
  assert.throws(() => parseImport(Buffer.from('[{a: ObjectId("bad")}]'), 'x.json'), /24 hex digits.*line 1/);
  assert.throws(() => parseImport(Buffer.from('[{a: 1,\n b: }]'), 'x.json'), /line 2, column 5/);
});
