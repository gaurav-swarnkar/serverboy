#!/usr/bin/env node
// Lost your phone AND your recovery codes? Turn off two-step login for one account, on the server:
//   sudo -u serverboy DATA_DIR=/var/lib/serverboy node /opt/serverboy/scripts/reset-2fa.js admin
// (any team member by username works too). If it was the owner, "required for everyone" is
// switched off as well, so you can log in and set it up again. Restart Serverboy afterwards:
//   sudo systemctl restart serverboy
'use strict';
const fs = require('fs');
const path = require('path');

const who = String(process.argv[2] || '').trim().toLowerCase();
if (!who) {
  console.error('Usage: reset-2fa.js <admin | team member username | user id>');
  process.exit(1);
}
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const file = path.join(dataDir, 'twofactor.json');
let data;
try {
  data = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {
  console.log(`No two-step login is set up (${file} not found). Nothing to do.`);
  process.exit(0);
}
(async () => {
  let id = who === 'admin' || who === 'owner' ? 'owner' : who;
  if (id !== 'owner' && !data.users?.[id]) {
    // A username: look the id up in the team database.
    process.env.DATA_DIR = dataDir;
    const team = require('../lib/team');
    if (team.isConfigured()) {
      const u = (await team.listUsers().catch(() => [])).find((x) => x.username === who || x.email === who);
      if (u) id = String(u.id);
    }
  }
  if (!data.users?.[id]) {
    console.log(`"${who}" has no two-step login set up. Nothing to do.`);
    process.exit(0);
  }
  delete data.users[id];
  if (data.pending) delete data.pending[id];
  if (id === 'owner' && data.settings) data.settings.required = false;
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  console.log(`Two-step login turned off for ${who}.${id === 'owner' ? ' "Required for everyone" is off too.' : ''} Now restart Serverboy: sudo systemctl restart serverboy`);
  process.exit(0);
})();
