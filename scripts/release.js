// Prepare a release: checks, version bump, commit and tag. Pushing the tag starts the release
// workflow (.github/workflows/release.yml), which tests again and publishes it on GitHub.
// Usage: npm run release -- 1.6.0        (add --push to push the branch and tag too)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim();
const fail = (msg) => {
  console.error(`\n✘ ${msg}`);
  process.exit(1);
};
const semver = (v) => v.split('.').map(Number);
const newer = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

const version = String(process.argv[2] || '').replace(/^v/, '');
const push = process.argv.includes('--push');
if (!/^\d+\.\d+\.\d+$/.test(version)) fail('Give the new version, like: npm run release -- 1.6.0');
const pkgFile = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
if (pkg.version !== version && !newer(version, pkg.version)) fail(`${version} is not newer than ${pkg.version}`);
if (out('git', ['status', '--porcelain'])) fail('Commit or stash your changes first (git status is not clean).');
if (out('git', ['tag', '-l', `v${version}`])) fail(`Tag v${version} already exists`);
delete require.cache[require.resolve('../lib/changelog')];
const top = require('../lib/changelog')[0];
if (top?.version !== version) fail(`Add a "${version}" entry at the top of lib/changelog.js first (what changed, in plain words).`);

console.log(`\n▶ Releasing v${version}`);
if (pkg.version !== version) {
  pkg.version = version;
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  const lockFile = path.join(ROOT, 'package-lock.json');
  if (fs.existsSync(lockFile)) {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    lock.version = version;
    if (lock.packages?.['']) lock.packages[''].version = version;
    fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  }
}
console.log('\n▶ Checks');
run('npm', ['run', 'check']);
run('npm', ['test']);
run('git', ['add', 'package.json', 'package-lock.json']);
if (out('git', ['diff', '--cached', '--name-only'])) run('git', ['commit', '-m', `Release v${version}`]);
run('git', ['tag', '-a', `v${version}`, '-m', `Serverboy v${version}`]);
const branch = out('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (push) {
  run('git', ['push', 'origin', branch]);
  run('git', ['push', 'origin', `v${version}`]);
  console.log(`\n✔ Pushed v${version}. GitHub Actions now tests it again and publishes the release.`);
} else {
  console.log(`\n✔ Tagged v${version}. To publish it:\n    git push origin ${branch} && git push origin v${version}`);
}
