'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const nginx = require('../../lib/nginx');

test('validDomain accepts real names and rejects injection attempts', () => {
  assert.equal(nginx.validDomain(' Shop.Example.COM '), 'shop.example.com');
  assert.equal(nginx.validDomain('20-1-2-3.sslip.io'), '20-1-2-3.sslip.io');
  for (const bad of ['', 'a b.com', 'evil.com; rm -rf /', '../etc', '-x.com', 'a.com\nserver_name x', 'a'.repeat(64) + '.com']) {
    assert.throws(() => nginx.validDomain(bad), /Invalid domain/, JSON.stringify(bad));
  }
});

test('siteFile refuses path tricks', () => {
  assert.equal(nginx.siteFile('a.com'), '/etc/nginx/sites-available/a.com');
  assert.equal(nginx.siteFile('default'), '/etc/nginx/sites-available/default');
  assert.throws(() => nginx.siteFile('../../etc/passwd'));
});

test('proxy and static site configs', () => {
  const proxy = nginx._test.siteConfig({ domain: 'api.a.com', serverNames: ['api.a.com'], type: 'proxy', port: 4100 });
  assert.match(proxy, /server_name api\.a\.com;/);
  assert.match(proxy, /proxy_pass http:\/\/127\.0\.0\.1:4100;/);
  assert.match(proxy, /include \/etc\/nginx\/serverboy\/test-mode\/api\.a\.com\.con\[f\];/);
  const stat = nginx._test.siteConfig({ domain: 'a.com', serverNames: ['a.com', 'www.a.com'], type: 'static', root: '/var/www/a.com/public_html' });
  assert.match(stat, /root \/var\/www\/a\.com\/public_html;/);
  assert.match(stat, /server_name a\.com www\.a\.com;/);
});

test('test mode lets the preview link, certificates and the test page through', () => {
  const s = nginx._test.testSnippet('abc123');
  assert.match(s, /\$cookie_sb_preview = "abc123"/);
  assert.match(s, /acme-challenge/);
  assert.match(s, /return 503/);
  assert.match(s, /\$arg_t != "abc123"/);
});
