// Alerts: tell people when something breaks, by email, Telegram, Slack, Discord or a webhook,
// and always in the Serverboy inbox. Used by the health monitor (lib/monitor.js) and by backups,
// test-restores and deploys.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { sendMail, addressOf } = require('./smtp');
const { HttpError } = require('./ssh');

const LOG_FILE = path.join(store.DATA_DIR, 'alerts-log.json');
const CHANNELS = ['email', 'telegram', 'slack', 'discord', 'webhook'];
const SECRET_FIELDS = { email: ['pass'], telegram: ['botToken'], slack: ['url'], discord: ['url'], webhook: ['url'] };
const EVENTS = {
  health: 'Something on a server stops working (website, service, app, disk full)',
  warnings: 'Warnings too (disk over 80%, app restarting often)',
  unreachable: 'A server cannot be reached',
  ssl: 'An HTTPS certificate expires in less than 14 days',
  backups: 'A backup or test-restore fails',
  deploys: 'A deploy fails',
};
const DEFAULTS = {
  enabled: true,
  every: 5, // minutes between health checks
  events: { health: true, warnings: false, unreachable: true, ssl: true, backups: true, deploys: true },
  muted: [], // server ids
  channels: {
    email: { enabled: false, host: '', port: 587, secure: false, user: '', from: '', to: '' },
    telegram: { enabled: false, chatId: '' },
    slack: { enabled: false },
    discord: { enabled: false },
    webhook: { enabled: false },
  },
};

// ---------------- settings ----------------

function settings() {
  const a = store.getAlerts() || {};
  const channels = {};
  for (const c of CHANNELS) channels[c] = { ...DEFAULTS.channels[c], ...(a.channels?.[c] || {}) };
  return { ...DEFAULTS, ...a, events: { ...DEFAULTS.events, ...(a.events || {}) }, channels, muted: a.muted || [], secrets: a.secrets || {} };
}

function publicSettings() {
  const s = settings();
  const secretSet = {};
  for (const c of CHANNELS) secretSet[c] = Boolean((SECRET_FIELDS[c] || []).every((f) => s.secrets[`${c}.${f}`]));
  return { enabled: s.enabled, every: s.every, events: s.events, eventLabels: EVENTS, muted: s.muted, channels: s.channels, secretSet, configured: Boolean(store.getAlerts()) };
}

const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);

function cleanChannel(c, input, current, secrets) {
  const out = { enabled: Boolean(input.enabled) };
  const setSecret = (field, value) => {
    if (value) secrets[`${c}.${field}`] = value;
  };
  if (c === 'email') {
    Object.assign(out, { host: str(input.host, 200), port: Math.min(65535, Math.max(1, Number(input.port) || 587)), secure: Boolean(input.secure), user: str(input.user, 200), from: str(input.from, 200), to: str(input.to, 1000) });
    if (out.host && !/^[A-Za-z0-9.-]+$/.test(out.host)) throw new HttpError(400, 'SMTP server: a host name like smtp.gmail.com');
    if (out.enabled) {
      if (!out.host) throw new HttpError(400, 'Email: enter the SMTP server');
      addressOf(out.from || out.user);
      for (const t of out.to.split(/[,;\s]+/).filter(Boolean)) addressOf(t);
      if (!out.to.trim()) throw new HttpError(400, 'Email: enter who gets the alerts');
    }
    setSecret('pass', str(input.pass, 500));
  } else if (c === 'telegram') {
    out.chatId = str(input.chatId, 40);
    if (out.chatId && !/^-?\d{3,20}$|^@[A-Za-z0-9_]{4,40}$/.test(out.chatId)) throw new HttpError(400, 'Telegram chat ID: a number (like 123456789 or -1001234567890) or @channelname');
    const token = str(input.botToken, 200);
    if (token && !/^\d{5,20}:[A-Za-z0-9_-]{20,80}$/.test(token)) throw new HttpError(400, 'Telegram bot token: it looks like 123456789:AAH… (from @BotFather)');
    setSecret('botToken', token);
    if (out.enabled && !out.chatId) throw new HttpError(400, 'Telegram: enter the chat ID');
  } else {
    const url = str(input.url, 600);
    if (url) {
      const ok = c === 'slack' ? /^https:\/\/hooks\.slack\.com\/[\w/-]+$/.test(url) : c === 'discord' ? /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/[\w/-]+$/.test(url) : /^https?:\/\/[^\s]+$/.test(url);
      if (!ok) throw new HttpError(400, c === 'slack' ? 'Slack: paste the Incoming Webhook URL (https://hooks.slack.com/…)' : c === 'discord' ? 'Discord: paste the webhook URL (https://discord.com/api/webhooks/…)' : 'Webhook: a URL starting with https://');
    }
    setSecret('url', url);
  }
  if (out.enabled && !(SECRET_FIELDS[c] || []).every((f) => secrets[`${c}.${f}`]) && !(c === 'email' && !out.user)) {
    throw new HttpError(400, `${c[0].toUpperCase()}${c.slice(1)}: ${c === 'email' ? 'enter the password' : c === 'telegram' ? 'enter the bot token' : 'paste the webhook URL'}`);
  }
  return out;
}

function saveSettings(body) {
  const cur = settings();
  const secrets = { ...cur.secrets };
  const channels = {};
  for (const c of CHANNELS) channels[c] = cleanChannel(c, body.channels?.[c] || cur.channels[c], cur.channels[c], secrets);
  const events = {};
  for (const e of Object.keys(EVENTS)) events[e] = body.events?.[e] === undefined ? cur.events[e] : Boolean(body.events[e]);
  store.setAlerts({
    enabled: body.enabled === undefined ? cur.enabled : Boolean(body.enabled),
    every: [5, 10, 15, 30].includes(Number(body.every)) ? Number(body.every) : 5,
    events,
    muted: Array.isArray(body.muted) ? body.muted.map(String).filter((id) => store.getServer(id)) : cur.muted,
    channels,
    secrets,
  });
  return publicSettings();
}

// ---------------- delivery ----------------

async function post(url, body, timeout = 15000) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'serverboy-alerts' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`answered ${res.status} ${(await res.text().catch(() => '')).slice(0, 150)}`);
}

const ICON = { problem: '🔴', warning: '🟠', fixed: '✅', info: 'ℹ️', test: '🔔' };

function format(a) {
  const head = `${ICON[a.kind] || '•'} ${a.server ? `${a.server}: ` : ''}${a.title}`;
  return { subject: `[Serverboy] ${head}`, text: `${head}\n\n${a.text || ''}${a.hint ? `\n\n${a.hint}` : ''}\n\n${new Date(a.at).toUTCString()}${a.link ? `\n${a.link}` : ''}` };
}

async function deliver(channel, cfg, secrets, alert) {
  const { subject, text } = format(alert);
  if (channel === 'email') {
    return sendMail({ host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, pass: secrets['email.pass'], from: cfg.from || cfg.user, to: cfg.to, subject, text });
  }
  if (channel === 'telegram') {
    const base = process.env.SERVERBOY_TELEGRAM_API || 'https://api.telegram.org';
    const res = await fetch(`${base}/bot${secrets['telegram.botToken']}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.description || `answered ${res.status}`);
    return;
  }
  if (channel === 'slack') return post(secrets['slack.url'], { text });
  if (channel === 'discord') return post(secrets['discord.url'], { content: text.slice(0, 1900) });
  return post(secrets['webhook.url'], { source: 'serverboy', kind: alert.kind, level: alert.level, server: alert.server || null, title: alert.title, text: alert.text || '', hint: alert.hint || '', category: alert.category, at: alert.at });
}

// Recent alerts (kept on disk, newest first).
let log = [];
try {
  log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
} catch {
  log = [];
}
function remember(entry) {
  log = [entry, ...log].slice(0, 100);
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(log), { mode: 0o600 });
  } catch {
    /* not critical */
  }
}

async function inbox(alert) {
  const team = require('./team');
  if (!team.isConfigured()) return false;
  try {
    const db = await team.getDb();
    const now = new Date();
    const { subject, text } = format(alert);
    await db.collection('messages').insertOne({ fromId: 'serverboy', fromName: 'Serverboy', to: ['owner'], subject: subject.replace(/^\[Serverboy\] /, ''), body: text, level: alert.kind === 'fixed' ? 'normal' : 'important', createdAt: now, lastAt: now, readBy: [], replies: [] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Send an alert to every enabled channel (and the inbox).
 * alert: { category: health|warnings|unreachable|ssl|backups|deploys, kind: problem|warning|fixed|info, title, text, hint, server }
 */
async function notify(alert, { force = false } = {}) {
  const s = settings();
  const a = { at: new Date().toISOString(), ...alert };
  const results = [];
  const allowed = force || (s.enabled && (s.events[a.category] ?? true));
  if (allowed) {
    for (const c of CHANNELS) {
      if (!s.channels[c].enabled) continue;
      try {
        await deliver(c, s.channels[c], s.secrets, a);
        results.push({ channel: c, ok: true });
      } catch (err) {
        results.push({ channel: c, ok: false, error: err.message });
      }
    }
  }
  const inInbox = a.category !== 'test' && (allowed || ['backups', 'deploys'].includes(a.category)) ? await inbox(a) : false;
  if (inInbox) results.push({ channel: 'inbox', ok: true });
  // And to the owner's phones and computers (Serverboy app / browser notifications).
  if (a.category !== 'test' && (allowed || ['backups', 'deploys'].includes(a.category))) {
    const { subject, text } = format(a);
    require('./push')
      .notifyUser('owner', { title: subject.replace(/^\[Serverboy\] /, ''), body: text.split('\n').filter(Boolean).slice(0, 3).join('\n').slice(0, 240), url: '/#/messages', tag: `alert:${a.category}:${a.server || ''}:${a.title}`.slice(0, 120) }, { kind: 'alerts', urgency: a.kind === 'problem' ? 'high' : 'normal' })
      .catch(() => {});
  }
  if (a.category !== 'test') remember({ at: a.at, kind: a.kind, category: a.category, server: a.server || null, title: a.title, text: a.text, results });
  return results;
}

// "Send a test" for one channel, with the form's settings (secrets left empty keep the saved ones).
async function test(channel, input) {
  if (!CHANNELS.includes(channel)) throw new HttpError(400, 'Unknown channel');
  const cur = settings();
  const secrets = { ...cur.secrets };
  const cfg = cleanChannel(channel, { ...(input || cur.channels[channel]), enabled: true }, cur.channels[channel], secrets);
  try {
    await deliver(channel, cfg, secrets, { kind: 'test', title: 'Test alert', text: 'Alerts from Serverboy reach you here. You can close this.', at: new Date().toISOString() });
  } catch (err) {
    throw new HttpError(502, `${channel[0].toUpperCase()}${channel.slice(1)} did not work: ${err.message}`);
  }
  return { ok: true };
}

module.exports = { settings, publicSettings, saveSettings, notify, test, recent: () => log, CHANNELS, EVENTS };
