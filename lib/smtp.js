// A small SMTP client for alert emails (no extra dependency). Supports implicit TLS (port 465)
// and STARTTLS (587/25), AUTH PLAIN or LOGIN, UTF-8 subjects and a base64 text body. It refuses to
// send a password over an unencrypted connection.
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

function addressOf(text) {
  const m = String(text || '').match(/<([^>]+)>\s*$/);
  const a = (m ? m[1] : String(text || '')).trim();
  if (!EMAIL_RE.test(a)) throw new Error(`"${text}" is not a valid email address`);
  return a;
}

const noNewlines = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ');
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const wrap76 = (b64) => b64.replace(/.{1,76}/g, '$&\r\n');

// Read SMTP replies (multi-line: "250-..." continues, "250 ..." ends).
function replies(socket) {
  let buf = '';
  let lines = [];
  const waiting = [];
  const queue = [];
  const onData = (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), text: lines.map((l) => l.slice(4)).join('\n') };
        lines = [];
        if (waiting.length) waiting.shift().resolve(reply);
        else queue.push(reply);
      }
    }
  };
  socket.on('data', onData);
  return {
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => waiting.push({ resolve, reject }))),
    fail: (err) => waiting.splice(0).forEach((w) => w.reject(err)),
    detach: () => socket.removeListener('data', onData),
  };
}

/**
 * sendMail({ host, port, secure, user, pass, from, to: [..] | 'a@b, c@d', subject, text })
 * secure: true = TLS from the start (465); otherwise STARTTLS is used when offered (required with a password).
 */
async function sendMail(opts) {
  const host = String(opts.host || '').trim();
  const port = Number(opts.port) || (opts.secure ? 465 : 587);
  if (!host) throw new Error('SMTP server is missing');
  const from = addressOf(opts.from);
  const to = (Array.isArray(opts.to) ? opts.to : String(opts.to || '').split(/[,;\s]+/)).filter(Boolean).map(addressOf);
  if (!to.length) throw new Error('Add at least one recipient');
  const timeout = opts.timeout || 20000;
  const local = /^(localhost|127\.|::1$)/.test(host);

  let socket = await new Promise((resolve, reject) => {
    const s = opts.secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    s.setTimeout(timeout, () => s.destroy(new Error(`No answer from ${host}:${port} (timed out)`)));
    s.once(opts.secure ? 'secureConnect' : 'connect', () => resolve(s));
    s.once('error', (e) => reject(new Error(`Could not connect to ${host}:${port}: ${e.message}`)));
  });
  let r = replies(socket);
  socket.on('error', (e) => r.fail(e));
  const send = (line) => socket.write(`${line}\r\n`);
  const expect = async (codes, what) => {
    const rep = await r.next();
    if (!codes.includes(rep.code)) throw new Error(`${what}: the mail server said ${rep.code} ${rep.text.split('\n').pop()}`);
    return rep;
  };

  try {
    await expect([220], 'Greeting');
    send('EHLO serverboy');
    let ehlo = await expect([250], 'EHLO');
    let encrypted = Boolean(opts.secure);
    if (!encrypted && /STARTTLS/i.test(ehlo.text)) {
      send('STARTTLS');
      await expect([220], 'STARTTLS');
      r.detach();
      socket = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket, servername: host }, () => resolve(s));
        s.once('error', (e) => reject(new Error(`TLS failed: ${e.message}`)));
      });
      socket.setTimeout(timeout, () => socket.destroy(new Error('Timed out')));
      r = replies(socket);
      socket.on('error', (e) => r.fail(e));
      encrypted = true;
      send('EHLO serverboy');
      ehlo = await expect([250], 'EHLO');
    }
    if (opts.user) {
      if (!encrypted && !local) throw new Error('This mail server does not offer encryption, so Serverboy will not send the password. Use port 465 (TLS) or 587 (STARTTLS).');
      if (/AUTH[^\n]*PLAIN/i.test(ehlo.text) || !/AUTH[^\n]*LOGIN/i.test(ehlo.text)) {
        send(`AUTH PLAIN ${Buffer.from(`\0${opts.user}\0${opts.pass || ''}`).toString('base64')}`);
        await expect([235], 'Login');
      } else {
        send('AUTH LOGIN');
        await expect([334], 'Login');
        send(Buffer.from(String(opts.user)).toString('base64'));
        await expect([334], 'Login');
        send(Buffer.from(String(opts.pass || '')).toString('base64'));
        await expect([235], 'Login');
      }
    }
    send(`MAIL FROM:<${from}>`);
    await expect([250], 'Sender');
    for (const t of to) {
      send(`RCPT TO:<${t}>`);
      await expect([250, 251], `Recipient ${t}`);
    }
    send('DATA');
    await expect([354], 'DATA');
    const fromHeader = noNewlines(opts.from).includes('<') ? noNewlines(opts.from) : `Serverboy <${from}>`;
    const message = [
      `From: ${fromHeader.replace(/^([^<]*)</, (m, name) => `${encodeHeader(name.trim())} <`)}`,
      `To: ${to.join(', ')}`,
      `Subject: ${encodeHeader(noNewlines(opts.subject))}`,
      `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: <${crypto.randomBytes(12).toString('hex')}@serverboy>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(Buffer.from(String(opts.text || ''), 'utf8').toString('base64')),
      '.',
    ].join('\r\n');
    socket.write(`${message}\r\n`);
    await expect([250], 'Sending');
    send('QUIT');
  } finally {
    setTimeout(() => socket.destroy(), 500).unref?.();
  }
}

module.exports = { sendMail, addressOf };
