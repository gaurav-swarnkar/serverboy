// Time-based one-time codes (RFC 6238, the codes of Google Authenticator, Authy, 1Password…):
// HMAC-SHA1 of a 30-second counter, 6 digits. Secrets are 20 random bytes, shown as base32.
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

// The code for one 30-second step (digits 6 by default).
function codeAt(secret, step, digits = 6) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}

const stepOf = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);

// The step a code belongs to, allowing one step of clock drift either way; null when wrong.
function check(secret, code, { now = Date.now(), window = 1 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const s = stepOf(now);
  for (let d = -window; d <= window; d++) {
    const expected = codeAt(secret, s + d);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return s + d;
  }
  return null;
}

// What authenticator apps read from the QR code.
function uri({ secret, account, issuer = 'Serverboy' }) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
}

module.exports = { base32Encode, base32Decode, newSecret, codeAt, check, stepOf, uri, STEP };
