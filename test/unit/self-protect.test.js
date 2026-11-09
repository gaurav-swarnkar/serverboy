'use strict';
// Serverboy must not be able to delete, stop or cut off itself on the machine it runs on.
const { useTempData } = require('../helpers');
useTempData();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const ssh = require('../../lib/ssh');

let localId = '';
try {
  localId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
} catch {
  localId = '';
}
const skip = !localId && 'no /etc/machine-id on this machine';

// Two simulated servers: "self" (same machine id, its Nginx site proxies to Serverboy) and "other".
let proc = { comm: 'node', cmd: 'node app.js' };
ssh.connect = async () => ({ server: { port: 22 } });
ssh.exec = async (serverId, cmd) => {
  if (cmd.includes('cat /etc/machine-id')) {
    return { code: 0, stdout: serverId === 'self' ? `${localId}\n__SITES__\n/etc/nginx/sites-available/panel.example.com|panel.example.com www.panel.example.com \n` : 'another-machine\n__SITES__\n', stderr: '' };
  }
  if (cmd.startsWith('realpath -m --')) return { code: 0, stdout: `${[...cmd.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('\n')}\n`, stderr: '' };
  if (cmd.startsWith('ps -o comm=')) return { code: 0, stdout: `${proc.comm}\n__CMD__\n${proc.cmd}`, stderr: '' };
  if (cmd.startsWith('apt-get -s remove')) return { code: 0, stdout: cmd.includes("'libnode") ? 'libnode109\nnodejs\n' : '', stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};
const protect = require('../../lib/self-protect');
const { ROOT } = protect._test;
const blocked = (p) => assert.rejects(p, (err) => err.status === 403);

test("Serverboy's own files cannot be deleted, moved or changed on its machine", { skip }, async () => {
  await blocked(protect.checkPaths('self', [`${ROOT}/server.js`], 'change'));
  await blocked(protect.checkPaths('self', [ROOT], 'remove'));
  await blocked(protect.checkPaths('self', ['/etc/systemd/system/serverboy.service'], 'remove'));
  await blocked(protect.checkPaths('self', ['/etc/nginx/sites-enabled/panel.example.com'], 'remove'));
  await blocked(protect.checkPaths('self', ['/etc/letsencrypt/live/panel.example.com/fullchain.pem'], 'change'));
  // A folder that contains Serverboy cannot be removed either.
  await blocked(protect.checkPaths('self', [require('path').dirname(ROOT)], 'remove'));
  // Other files are fine, and so is everything on other servers.
  await protect.checkPaths('self', ['/var/www/shop/index.html'], 'remove');
  await protect.checkPaths('self', ['/etc/nginx/sites-available/shop.example.com'], 'remove');
  await protect.checkPaths('other', [`${ROOT}/server.js`, ROOT], 'remove');
});

test("the website that serves Serverboy is protected, other sites are not", { skip }, async () => {
  await blocked(protect.checkSite('self', 'panel.example.com', 'deleted'));
  await blocked(protect.checkSite('self', 'www.panel.example.com', 'deleted'));
  await protect.checkSite('self', 'shop.example.com', 'deleted');
  await protect.checkSite('other', 'panel.example.com', 'deleted');
  assert.equal(await protect.isOwnSite('self', 'panel.example.com'), true);
});

test('services: SSH everywhere, Nginx and Serverboy on its machine', { skip }, async () => {
  await blocked(protect.checkService('other', 'ssh', 'stop'));
  await blocked(protect.checkService('other', 'sshd.service', 'disable'));
  await blocked(protect.checkService('self', 'nginx', 'stop'));
  await blocked(protect.checkService('self', 'serverboy', 'disable'));
  await protect.checkService('self', 'nginx', 'restart');
  await protect.checkService('other', 'nginx', 'stop');
  await protect.checkService('self', 'mongod', 'stop');
});

test('processes: the SSH server, Nginx and Serverboy cannot be killed', { skip }, async () => {
  proc = { comm: 'sshd', cmd: 'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups' };
  await blocked(protect.checkProcess('other', 100));
  proc = { comm: 'sshd', cmd: 'sshd: azureuser@pts/0' };
  await protect.checkProcess('other', 101);
  proc = { comm: 'nginx', cmd: 'nginx: master process /usr/sbin/nginx' };
  await blocked(protect.checkProcess('self', 102));
  await protect.checkProcess('other', 102);
  proc = { comm: 'node', cmd: `/usr/bin/node ${ROOT}/server.js` };
  await blocked(protect.checkProcess('self', 103));
  proc = { comm: 'node', cmd: 'node /var/www/shop/app.js' };
  await protect.checkProcess('self', 104);
});

test('software: Node.js, Nginx and certbot stay on its machine; SSH and sudo everywhere', { skip }, async () => {
  await blocked(protect.checkPackageRemoval('self', 'nodejs'));
  await blocked(protect.checkPackageRemoval('self', 'libnode109')); // apt would remove nodejs with it
  await blocked(protect.checkPackages('self', ['nginx-common']));
  await blocked(protect.checkAppUninstall('self', 'nginx'));
  await blocked(protect.checkPackages('other', ['openssh-server']));
  await protect.checkPackageRemoval('other', 'nodejs');
  await protect.checkAppUninstall('other', 'nginx');
  await protect.checkPackages('self', ['redis-server']);
});

test('firewall: never block or drop the last rule for SSH, or for 80/443 on its machine', { skip }, async () => {
  await blocked(protect.checkFirewallRule('other', { action: 'deny', port: '22' }));
  await blocked(protect.checkFirewallRule('self', { action: 'deny', port: '443/tcp' }));
  await protect.checkFirewallRule('other', { action: 'deny', port: '443' });
  await protect.checkFirewallRule('self', { action: 'deny', port: '22', from: '1.2.3.4' });
  const rules = [
    { num: 1, to: '22/tcp', action: 'ALLOW', from: 'Anywhere' },
    { num: 2, to: 'Nginx Full', action: 'ALLOW', from: 'Anywhere' },
    { num: 3, to: '443', action: 'ALLOW', from: 'Anywhere' },
    { num: 4, to: '22/tcp (v6)', action: 'ALLOW', from: 'Anywhere (v6)' },
  ];
  await blocked(protect.checkFirewallDelete('other', rules, 1));
  await blocked(protect.checkFirewallDelete('self', rules, 2)); // the only rule for port 80
  await protect.checkFirewallDelete('self', rules, 3); // 443 is still open through Nginx Full
  await protect.checkFirewallDelete('other', rules, 2);
  await protect.checkFirewallDelete('other', [...rules, { num: 5, to: 'OpenSSH', action: 'ALLOW', from: 'Anywhere' }], 1);
});
