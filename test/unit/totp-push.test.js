'use strict';
// Two-step codes (RFC 6238) and push encryption (RFC 8291) against the standards' own examples.
const { useTempData } = require('../helpers');
useTempData();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const totp = require('../../lib/totp');
const push = require('../../lib/push');

test('TOTP matches the RFC 6238 test vectors and allows one step of drift', () => {
  const key = Buffer.from('12345678901234567890');
  assert.equal(totp.codeAt(key, Math.floor(59 / 30), 8), '94287082');
  assert.equal(totp.codeAt(key, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(totp.codeAt(key, Math.floor(2000000000 / 30), 8), '69279037');
  const secret = totp.newSecret();
  const now = Date.now();
  assert.notEqual(totp.check(secret, totp.codeAt(secret, totp.stepOf(now) - 1), { now }), null);
  assert.equal(totp.check(secret, totp.codeAt(secret, totp.stepOf(now) - 3), { now }), null);
  assert.equal(totp.check(secret, 'abcdef'), null);
  assert.match(totp.uri({ secret, account: 'admin@x' }), /^otpauth:\/\/totp\/Serverboy:admin%40x\?secret=/);
});

test('push encryption matches the RFC 8291 example byte for byte', () => {
  const out = push.encrypt('When I grow up, I want to be a watermelon', 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', { salt: 'DGv6ra1nlYgDCS1FRnbzlw', asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw' });
  assert.equal(out.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('the VAPID key is a P-256 public key and push endpoints must be https', () => {
  const raw = Buffer.from(push.publicKey(), 'base64url');
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 4);
  const k = { p256dh: crypto.createECDH('prime256v1').generateKeys().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  assert.throws(() => push.subscribe('owner', { endpoint: 'http://evil.example/push', keys: k }), /https/);
  const d = push.subscribe('owner', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: k }, 'Mozilla/5.0 (Linux; Android 14) Chrome/130');
  assert.equal(d.device, 'Chrome on Android');
  assert.ok(!('p256dh' in d) && !('auth' in d), 'keys are never listed');
  assert.ok(push.unsubscribe('owner', d.id));
});
