// Prints the release notes for one version from lib/changelog.js (used by the release workflow).
// Usage: node scripts/release-notes.js 1.6.0
'use strict';
const changelog = require('../lib/changelog');

const version = String(process.argv[2] || '').replace(/^v/, '');
const entry = changelog.find((e) => e.version === version);
if (!entry) {
  console.error(`No entry for ${version} in lib/changelog.js`);
  process.exit(1);
}
const repo = process.env.GITHUB_REPOSITORY || 'gaurav-swarnkar/serverboy';
console.log(`## What's new in ${version}\n`);
for (const item of entry.items) console.log(`- ${item}`);
console.log(`
## Install or update

\`\`\`
curl -fsSL https://raw.githubusercontent.com/${repo}/v${version}/scripts/install-on-server.sh | sudo bash
\`\`\`

To go back to an earlier version, put \`SERVERBOY_VERSION=vX.Y.Z\` before \`bash\`:
\`curl -fsSL … | sudo SERVERBOY_VERSION=v1.5.0 bash\`. Your data is kept.`);
