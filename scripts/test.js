// Runs every test/**/*.test.js file with Node's built-in test runner. Works on Node 20 and 22
// (Node 20 does not expand globs itself). Usage: npm test [-- filter]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'test');
const filter = process.argv[2] || '';
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.test.js') && p.includes(filter)) files.push(p);
  }
})(dir);
files.sort();
if (!files.length) {
  console.error('No test files found');
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
