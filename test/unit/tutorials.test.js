'use strict';
// Every button in the tutorials must open a page that exists, and every chapter must be complete.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const text = fs.readFileSync(path.join(root, 'public/js/tutorials.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const views = new Set([...app.matchAll(/^ {2}'?([a-z-]+)'?: \(\) => import\(/gm)].map((m) => m[1]));
const chapters = [...text.matchAll(/^ {4}id: '([a-z-]+)',/gm)].map((m) => m[1]);

test('tutorial buttons open pages that exist', () => {
  const targets = [...text.matchAll(/\[\[([a-z:-]+)\|/g), ...text.matchAll(/link: '([a-z:-]+)\|/g)].map((m) => m[1]);
  assert.ok(targets.length > 10);
  for (const t of targets) {
    if (t.startsWith('learn:')) assert.ok(chapters.includes(t.slice(6)), `unknown chapter ${t}`);
    else assert.ok(views.has(t), `unknown page ${t}`);
  }
});

test('chapters have unique ids and the main three are step by step', () => {
  assert.equal(new Set(chapters).size, chapters.length);
  assert.ok(chapters.length >= 12);
  for (const id of ['websites', 'databases', 'apis']) assert.match(text, new RegExp(`id: '${id}',[\\s\\S]*?detailed: true`));
  assert.ok(views.has('learn'));
});
