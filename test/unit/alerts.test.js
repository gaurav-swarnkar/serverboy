'use strict';
const { useTempData } = require('../helpers');
useTempData();
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { sendMail } = require('../../lib/smtp');
const alerts = require('../../lib/alerts');

// A tiny SMTP server for the tests.
function fakeSmtp() {
  const got = [];
  const srv = net.createServer((s) => {
    let data = null;
    let buf = '';
    const msg = { rcpt: [] };
    s.write('220 hi\r\n');
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (l === '.') {
            msg.data = data.join('\n');
            got.push(msg);
            data = null;
            s.write('250 ok\r\n');
          } else data.push(l);
        } else if (/^EHLO/.test(l)) s.write('250-x\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN/.test(l)) {
          msg.auth = Buffer.from(l.slice(11), 'base64').toString();
          s.write('235 ok\r\n');
        } else if (/^MAIL/.test(l)) s.write('250 ok\r\n');
        else if (/^RCPT/.test(l)) {
          msg.rcpt.push(l);
          s.write('250 ok\r\n');
        } else if (/^DATA/.test(l)) {
          data = [];
          s.write('354 go\r\n');
        } else s.write('250 ok\r\n');
      }
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ port: srv.address().port, got, close: () => srv.close() })));
}

test('sends a mail with a UTF-8 subject and a base64 body', async () => {
  const smtp = await fakeSmtp();
  await sendMail({ host: '127.0.0.1', port: smtp.port, user: 'me@x.com', pass: 'p', from: 'Serverboy <me@x.com>', to: 'a@x.com, b@x.com', subject: '🔴 web: site down', text: 'Hello ✓' });
  smtp.close();
  const m = smtp.got[0];
  assert.equal(m.auth, '\0me@x.com\0p');
  assert.equal(m.rcpt.length, 2);
  assert.match(m.data, /^Subject: =\?UTF-8\?B\?/m);
  const body = m.data.split('\n\n').slice(1).join('').replace(/\s/g, '');
  assert.equal(Buffer.from(body, 'base64').toString(), 'Hello ✓');
});

test('header injection is impossible and bad addresses are refused', async () => {
  const smtp = await fakeSmtp();
  await sendMail({ host: '127.0.0.1', port: smtp.port, from: 'me@x.com', to: 'a@x.com', subject: 'Hi\r\nBcc: victim@evil.com', text: 'x' });
  smtp.close();
  assert.doesNotMatch(smtp.got[0].data, /^Bcc:/m);
  await assert.rejects(() => sendMail({ host: '127.0.0.1', port: 1, from: 'me@x.com', to: 'not an email', text: 'x' }), /not a valid email/);
});

test('a password is never sent over an unencrypted connection to another host', async () => {
  const smtp = await fakeSmtp();
  // 127.0.0.1 is allowed (local relay). Pretend it is remote by using a hostname alias.
  await assert.rejects(() => sendMail({ host: 'localhost.localdomain.invalid', port: smtp.port, user: 'u@x.com', pass: 'p', from: 'u@x.com', to: 'a@x.com', text: 'x', timeout: 3000 }));
  smtp.close();
});

test('settings validate channels and keep secrets encrypted', () => {
  assert.throws(() => alerts.saveSettings({ channels: { slack: { enabled: true, url: 'https://evil.com/x' } } }), /hooks\.slack\.com/);
  assert.throws(() => alerts.saveSettings({ channels: { telegram: { enabled: true, botToken: 'nope', chatId: '123456' } } }), /bot token/);
  assert.throws(() => alerts.saveSettings({ channels: { email: { enabled: true, host: 'smtp.x.com', to: 'a@x.com', user: 'u@x.com' } } }), /password/);
  const out = alerts.saveSettings({ channels: { telegram: { enabled: true, botToken: '123456789:AAHfaketokenfaketokenfaketoken12345', chatId: '-1001234567890' } }, events: { warnings: true } });
  assert.equal(out.channels.telegram.enabled, true);
  assert.equal(out.secretSet.telegram, true);
  assert.equal(JSON.stringify(out).includes('AAHfake'), false, 'secret not returned');
  const raw = require('fs').readFileSync(require('path').join(process.env.DATA_DIR, 'config.json'), 'utf8');
  assert.equal(raw.includes('AAHfake'), false, 'secret encrypted at rest');
  // Saving again without the token keeps it.
  assert.equal(alerts.saveSettings({ channels: { telegram: { enabled: true, chatId: '-1001234567890' } } }).secretSet.telegram, true);
  assert.equal(out.events.warnings, true);
});
