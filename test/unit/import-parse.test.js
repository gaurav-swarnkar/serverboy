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
