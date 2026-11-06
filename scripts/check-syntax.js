// Syntax check for every JavaScript file, run in CI and by `npm run check`.
// Browser code (public/js) is parsed as ES modules, everything else as CommonJS. `node --check`
// is not used because it silently accepts broken ES modules.
// Run with: node --experimental-vm-modules scripts/check-syntax.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'data', 'vendor']);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(c|m)?js$/.test(e.name)) yield p;
  }
}

let failed = 0;
let count = 0;
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, 'utf8').replace(/^#!.*/, '');
  count++;
  try {
    if (rel.startsWith(`public${path.sep}js`) || file.endsWith('.mjs')) {
      new vm.SourceTextModule(src, { identifier: rel });
    } else {
      // Same wrapper Node uses for CommonJS modules.
      new vm.Script(`(function (exports, require, module, __filename, __dirname) {${src}\n})`, { filename: rel });
    }
  } catch (err) {
    failed++;
    console.error(`✘ ${rel}: ${err.message}`);
  }
}
console.log(failed ? `${failed} of ${count} files have syntax errors` : `✔ ${count} files parse cleanly`);
process.exit(failed ? 1 : 0);
