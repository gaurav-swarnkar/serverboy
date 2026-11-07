// Administration → Alerts: where alerts go (email, Telegram, Slack, Discord, webhook), what
// triggers them, which servers are watched, what is being tracked now, and recent alerts.
import { api, esc, toast, run, loadingHtml, errorHtml } from '../ui.js';
import { adminHead } from './admin-common.js';

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const ago = (iso) => {
  if (!iso) return 'not yet';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
const KIND = { problem: ['bad', 'problem'], warning: ['warn', 'warning'], fixed: ['ok', 'fixed'], info: ['', 'info'] };

const CH = {
  email: {
    name: 'Email',
    help: 'Any mail account works. Gmail: smtp.gmail.com, port 465 with TLS, your address, and an <b>app password</b> (Google Account → Security → App passwords). Outlook: smtp.office365.com, port 587.',
    fields: (c, set) => `
      <div class="grid grid-2">
        <label class="field"><span>SMTP server</span><input name="host" value="${esc(c.host)}" placeholder="smtp.gmail.com"></label>
        <div class="al-port"><label class="field"><span>Port</span><input name="port" type="number" value="${esc(c.port)}"></label>
          <label class="check"><input type="checkbox" name="secure" ${c.secure ? 'checked' : ''}> TLS (port 465)</label></div>
        <label class="field"><span>Username</span><input name="user" value="${esc(c.user)}" placeholder="you@gmail.com" autocomplete="off"></label>
        <label class="field"><span>Password</span><input name="pass" type="password" autocomplete="new-password" placeholder="${set ? 'saved (leave empty to keep)' : 'app password'}"></label>
        <label class="field"><span>From (optional)</span><input name="from" value="${esc(c.from)}" placeholder="Serverboy &lt;you@gmail.com&gt;"></label>
        <label class="field"><span>Send alerts to</span><input name="to" value="${esc(c.to)}" placeholder="you@example.com, teammate@example.com"></label>
      </div>`,
  },
  telegram: {
    name: 'Telegram',
    help: 'In Telegram, talk to <b>@BotFather</b> → /newbot → copy the token. Then send any message to your new bot and open <span class="mono">https://api.telegram.org/bot&lt;token&gt;/getUpdates</span>: the chat "id" there is your chat ID. For a group, add the bot to the group (the ID starts with -100).',
    fields: (c, set) => `<div class="grid grid-2">
        <label class="field"><span>Bot token</span><input name="botToken" type="password" autocomplete="off" placeholder="${set ? 'saved (leave empty to keep)' : '123456789:AAH…'}"></label>
        <label class="field"><span>Chat ID</span><input name="chatId" value="${esc(c.chatId)}" placeholder="123456789"></label></div>`,
  },
  slack: {
    name: 'Slack',
    help: 'Slack → <b>Apps</b> → Incoming Webhooks → Add to a channel → copy the Webhook URL.',
    fields: (c, set) => `<label class="field"><span>Webhook URL</span><input name="url" type="password" autocomplete="off" placeholder="${set ? 'saved (leave empty to keep)' : 'https://hooks.slack.com/services/…'}"></label>`,
  },
  discord: {
    name: 'Discord',
    help: 'Channel settings → <b>Integrations</b> → Webhooks → New Webhook → Copy Webhook URL.',
    fields: (c, set) => `<label class="field"><span>Webhook URL</span><input name="url" type="password" autocomplete="off" placeholder="${set ? 'saved (leave empty to keep)' : 'https://discord.com/api/webhooks/…'}"></label>`,
  },
  webhook: {
    name: 'Webhook',
    help: 'For other tools (n8n, Zapier, PagerDuty, your own app): Serverboy POSTs JSON with kind, level, server, title, text and time.',
    fields: (c, set) => `<label class="field"><span>URL</span><input name="url" type="password" autocomplete="off" placeholder="${set ? 'saved (leave empty to keep)' : 'https://…'}"></label>`,
  },
};

export async function render(el, { servers }) {
  el.innerHTML = `${adminHead('Alerts', 'Hear about problems when they happen, wherever you are.', '<button class="btn" data-act="checkNow">Check all servers now</button>')}<div id="al-body">${loadingHtml()}</div>`;
  const body = el.querySelector('#al-body');
  let info;

  async function load() {
    try {
      info = await api('/alerts');
    } catch (err) {
      body.innerHTML = errorHtml(err);
      return;
    }
    draw();
  }

  function draw() {
    const on = Object.entries(info.channels).filter(([, c]) => c.enabled).map(([k]) => CH[k].name);
    body.innerHTML = `
      ${on.length ? '' : `<div class="notice warn" style="margin-bottom:14px"><b>Alerts only go to your Serverboy inbox.</b> Add email or Telegram below so they reach you even when Serverboy is closed.</div>`}
      <form id="al-form">
        <div class="card" style="margin-bottom:14px">
          <div class="row" style="gap:16px;flex-wrap:wrap">
            <label class="check"><input type="checkbox" name="enabled" ${info.enabled ? 'checked' : ''}> <b>Watch my servers and send alerts</b></label>
            <label class="row" style="gap:6px">Check every <select name="every" style="width:auto">${[5, 10, 15, 30].map((m) => `<option value="${m}" ${info.every === m ? 'selected' : ''}>${m} minutes</option>`).join('')}</select></label>
          </div>
          <p class="small muted" style="margin:8px 0 0">A problem has to show up on two checks in a row before you hear about it (no alerts for a 30-second blip). You get a <b>Fixed</b> message when it is gone, and a reminder once a day while it lasts. Alerts also land in your Serverboy inbox${on.length ? ` and go to ${on.join(', ')}` : ''}.</p>
        </div>

        <h3>Where alerts go</h3>
        <div class="al-channels">${Object.keys(CH)
          .map(
            (k) => `<div class="card al-ch ${info.channels[k].enabled ? 'on' : ''}" data-ch="${k}">
              <div class="row"><label class="check grow"><input type="checkbox" name="${k}.enabled" ${info.channels[k].enabled ? 'checked' : ''}> <b>${CH[k].name}</b></label>
                <button type="button" class="btn-sm" data-act="test" data-ch="${k}">Send test</button></div>
              <div class="al-ch-body">
                <p class="small muted" style="margin:6px 0 10px">${CH[k].help}</p>
                ${CH[k].fields(info.channels[k], info.secretSet[k])}
              </div>
            </div>`,
          )
          .join('')}</div>

        <div class="grid grid-2" style="align-items:start;margin-top:14px">
          <div class="card">
            <h3 style="margin-top:0">What to alert about</h3>
            ${Object.entries(info.eventLabels).map(([k, label]) => `<label class="check"><input type="checkbox" name="ev.${k}" ${info.events[k] ? 'checked' : ''}> ${esc(label)}</label>`).join('')}
          </div>
          <div class="card">
            <h3 style="margin-top:0">Servers to watch</h3>
            ${servers.map((s) => `<label class="check"><input type="checkbox" name="watch" value="${esc(s.id)}" ${info.muted.includes(s.id) ? '' : 'checked'}> ${esc(s.name)}</label>`).join('') || '<p class="muted small">No servers yet.</p>'}
            <p class="small muted" style="margin-bottom:0">Serverboy checks from where it runs. If Serverboy runs on the same server, nobody can tell you when that whole server is off: for that, add an outside check such as Uptime Kuma (1-click apps) on another machine, or a free service like UptimeRobot.</p>
          </div>
        </div>
        <div class="row" style="margin:14px 0 20px"><button class="btn-primary" type="submit">Save</button></div>
      </form>

      <div class="grid grid-2" style="align-items:start">
        <div class="card">
          <h3 style="margin-top:0">Watching now</h3>
          ${info.status
            .map(
              (s) => `<div class="al-srv"><div class="row"><b class="grow">${esc(s.name)}</b><span class="small muted">checked ${ago(s.lastCheck)}</span></div>
              ${
                info.muted.includes(s.id)
                  ? '<div class="small muted">Not watched.</div>'
                  : s.problems.length
                    ? s.problems.map((p) => `<div class="small al-p"><span class="badge ${p.level === 'bad' ? 'bad' : 'warn'}">${p.alerted ? 'alerted' : `seen ${p.checks}×`}</span> ${esc(p.text)}</div>`).join('')
                    : `<div class="small" style="color:var(--ok)">${s.lastCheck ? 'All good.' : 'Waiting for the first check.'}</div>`
              }</div>`,
            )
            .join('') || '<p class="muted small">No servers.</p>'}
        </div>
        <div class="card flush">
          <div class="card-head"><h3 style="margin:0">Recent alerts</h3></div>
          <div class="table-wrap"><table class="small"><tbody>${
            info.recent
              .map(
                (a) => `<tr><td style="white-space:nowrap">${when(a.at)}</td><td><span class="badge ${KIND[a.kind]?.[0] || ''}">${KIND[a.kind]?.[1] || esc(a.kind)}</span></td>
                <td>${a.server ? `<b>${esc(a.server)}</b>: ` : ''}${esc(a.title)}</td>
                <td class="muted">${a.results.map((r) => `<span title="${esc(r.error || 'sent')}" style="color:var(--${r.ok ? 'ok' : 'bad'})">${esc(r.channel)}${r.ok ? '' : ' ✘'}</span>`).join(' ')}</td></tr>`,
              )
              .join('') || '<tr><td class="empty">No alerts yet.</td></tr>'
          }</tbody></table></div>
        </div>
      </div>`;
  }

  // The form's values for one channel (empty secret fields keep the saved ones).
  function channelValues(form, k) {
    const card = form.querySelector(`[data-ch="${k}"]`);
    const v = { enabled: form[`${k}.enabled`].checked };
    card.querySelectorAll('.al-ch-body input').forEach((i) => (v[i.name] = i.type === 'checkbox' ? i.checked : i.value));
    return v;
  }

  body.addEventListener('change', (e) => {
    const m = e.target.name?.match(/^(\w+)\.enabled$/);
    if (m) e.target.closest('.al-ch')?.classList.toggle('on', e.target.checked);
  });

  body.addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.id !== 'al-form') return;
    const channels = {};
    for (const k of Object.keys(CH)) channels[k] = channelValues(f, k);
    const events = {};
    for (const k of Object.keys(info.eventLabels)) events[k] = f[`ev.${k}`].checked;
    const watched = [...f.querySelectorAll('[name=watch]:checked')].map((i) => i.value);
    const out = await run(f.querySelector('[type=submit]'), () => api('/alerts/settings', { method: 'PUT', body: { enabled: f.enabled.checked, every: Number(f.every.value), events, channels, muted: servers.map((s) => s.id).filter((id) => !watched.includes(id)) } }), 'Alert settings saved');
    if (out) load();
  });

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'test') {
      const form = body.querySelector('#al-form');
      const k = b.dataset.ch;
      const r = await run(b, () => api('/alerts/test', { method: 'POST', body: { channel: k, settings: channelValues(form, k) } }));
      if (r) toast(`Test sent with ${CH[k].name}. Did it arrive? Then tick it and Save.`, 'ok', 8000);
    } else if (b.dataset.act === 'checkNow') {
      const r = await run(b, () => api('/alerts/check-now', { method: 'POST' }));
      if (r) {
        info.status = r.status;
        info.recent = r.recent;
        draw();
        toast('Checked', 'ok');
      }
    }
  });

  load();
}
