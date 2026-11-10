// Two-step login and notifications for the logged-in person: used on My account and on the
// "set up two-step login first" screen when the owner requires it.
import { api, esc, toast, run, modal, confirmDialog, session } from './ui.js';
import * as device from './device.js';

let qrLoaded = null;
function loadQr() {
  qrLoaded ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/qrcode/qrcode.js';
    s.onload = () => resolve(window.qrcode);
    s.onerror = () => reject(new Error('QR code library missing'));
    document.head.append(s);
  });
  return qrLoaded;
}

async function qrSvg(text) {
  try {
    const qrcode = await loadQr();
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
  } catch {
    return '';
  }
}

function downloadText(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// The recovery codes, shown once.
function showCodes(box, codes, onDone) {
  const text = `Serverboy recovery codes for ${session.user.username} (${location.host})\nEach code works once, if you lose your phone.\n\n${codes.join('\n')}\n`;
  box.innerHTML = `<div class="notice" style="margin-bottom:10px"><b>Two-step login is on.</b> Save these recovery codes somewhere safe (a password manager, or printed). Each works once if you lose your phone. They are shown only now.</div>
    <div class="sec-codes mono">${codes.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
    <div class="row" style="margin-top:12px"><button class="btn-sm" data-c="copy">Copy</button><button class="btn-sm" data-c="dl">Download .txt</button><span class="grow"></span><button class="btn-primary" data-c="done">I saved them</button></div>`;
  box.querySelector('[data-c=copy]').onclick = () => navigator.clipboard?.writeText(text).then(() => toast('Copied', 'ok'));
  box.querySelector('[data-c=dl]').onclick = () => downloadText('serverboy-recovery-codes.txt', text);
  box.querySelector('[data-c=done]').onclick = () => onDone?.();
}

// The steps to turn it on, in a box. onDone runs after the codes are saved.
export async function setupFlow(box, { onDone } = {}) {
  box.innerHTML = '<p class="muted">Preparing…</p>';
  let s;
  try {
    s = await api('/2fa/setup', { method: 'POST' });
  } catch (err) {
    box.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
    return;
  }
  const svg = await qrSvg(s.uri);
  box.innerHTML = `
    <ol class="sec-steps">
      <li><b>Get an authenticator app</b> on your phone if you have none: Google Authenticator, Microsoft Authenticator, Authy or 1Password.</li>
      <li><b>Scan this code</b> with the app (Add → Scan a QR code).
        <div class="sec-qr">${svg || ''}</div>
        <details class="small"><summary>Can't scan? Type this key instead</summary><div class="mono sec-key">${esc(s.secret.replace(/(.{4})/g, '$1 ').trim())}</div></details></li>
      <li><b>Type the 6-digit code</b> the app shows:
        <form class="row sec-confirm" style="margin-top:6px"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456" class="mono" style="width:140px;font-size:18px;letter-spacing:2px"><button class="btn-primary">Turn on</button></form></li>
    </ol>`;
  const f = box.querySelector('.sec-confirm');
  f.code.focus();
  f.addEventListener('submit', async () => {
    const r = await run(f.querySelector('button'), () => api('/2fa/confirm', { method: 'POST', body: { code: f.code.value } }));
    if (!r) return;
    session.user.twoFactor = { ...(session.user.twoFactor || {}), enabled: true, mustSetUp: false };
    showCodes(box, r.recoveryCodes, onDone);
  });
}

// My account: the "Two-step login" card.
export async function twoFactorCard(el) {
  const draw = async () => {
    let st;
    try {
      st = await api('/2fa/status');
    } catch (err) {
      el.innerHTML = `<h2>Two-step login</h2><div class="notice bad">${esc(err.message)}</div>`;
      return;
    }
    el.innerHTML = `<h2>Two-step login</h2>
      ${
        st.enabled
          ? `<p><span class="badge ok">On</span> since ${new Date(st.enabledAt).toLocaleDateString()}. After your password, Serverboy asks for a code from your authenticator app${st.devices ? ', or you approve the login on a device where notifications are on' : ''}.</p>
             <p class="small muted">${st.recoveryLeft} of 10 recovery codes left.${st.recoveryLeft <= 3 ? ' <b>Make new ones soon.</b>' : ''}</p>
             <div class="row"><button class="btn-sm" data-t="recovery">New recovery codes</button>${st.required ? '<span class="small muted">Required by the owner.</span>' : '<button class="btn-sm btn-danger" data-t="off">Turn off</button>'}</div>`
          : `<p><span class="badge warn">Off</span> Someone who learns your password can log in. With two-step login they also need your phone.</p>
             <button class="btn-primary" data-t="on">Turn on two-step login</button>`
      }`;
    el.querySelector('[data-t=on]')?.addEventListener('click', () => {
      const box = document.createElement('div');
      const m = modal({ title: 'Turn on two-step login', body: box, wide: true, onClose: draw });
      setupFlow(box, { onDone: () => m.close() });
    });
    const askCode = async (title, path, done) => {
      const box = document.createElement('div');
      box.innerHTML = '<label class="field"><span>A current code from your app (or a recovery code)</span><input name="code" inputmode="numeric" autocomplete="one-time-code" class="mono"></label>';
      modal({
        title,
        body: box,
        actions: [
          { label: 'Cancel' },
          {
            label: 'Continue',
            className: 'btn-primary',
            onClick: async () => {
              const r = await api(path, { method: 'POST', body: { code: box.querySelector('input').value } });
              await done(r);
            },
          },
        ],
      });
    };
    el.querySelector('[data-t=recovery]')?.addEventListener('click', () =>
      askCode('New recovery codes', '/2fa/recovery', (r) => {
        const box = document.createElement('div');
        const m = modal({ title: 'Your new recovery codes', body: box, wide: true, onClose: draw });
        showCodes(box, r.recoveryCodes, () => m.close());
      }),
    );
    el.querySelector('[data-t=off]')?.addEventListener('click', async () => {
      if (!(await confirmDialog('Turn off two-step login? Your password alone will be enough to log in again.', { danger: true, confirmLabel: 'Continue' }))) return;
      askCode('Turn off two-step login', '/2fa/disable', () => {
        toast('Two-step login is off', 'ok');
        session.user.twoFactor = { ...(session.user.twoFactor || {}), enabled: false };
        draw();
      });
    });
  };
  draw();
}

// My account: notifications on this device, the person's devices, and what they get.
export async function notificationsCard(el) {
  const draw = async () => {
    let info;
    try {
      info = await api('/push/devices');
    } catch (err) {
      el.innerHTML = `<h2>Notifications</h2><div class="notice bad">${esc(err.message)}</div>`;
      return;
    }
    const sub = await device.currentSubscription().catch(() => null);
    const here = sub && info.devices.some((d) => d.service === new URL(sub.endpoint).host);
    const blocked = device.pushBlocker();
    el.innerHTML = `<h2>Notifications</h2>
      <p class="small muted" style="margin-top:0">Get ${session.user.isOwner ? 'alerts, ' : ''}messages and login approvals on your phone or computer, even when Serverboy is closed.</p>
      <div class="sec-device">
        <div><b>This device</b><div class="small muted">${here ? 'Notifications are on.' : blocked ? esc(blocked) : 'Notifications are off.'}</div></div>
        ${here ? '<button class="btn-sm" data-n="test">Send a test</button><button class="btn-sm" data-n="off">Turn off</button>' : blocked ? '' : '<button class="btn-primary" data-n="on">Turn on</button>'}
      </div>
      <div class="row" style="gap:14px;margin:10px 0">${session.user.isOwner ? `<label class="check"><input type="checkbox" data-p="alerts" ${info.prefs.alerts ? 'checked' : ''}> Alerts</label>` : ''}<label class="check"><input type="checkbox" data-p="messages" ${info.prefs.messages ? 'checked' : ''}> Messages</label><span class="small muted">Login approvals always come.</span></div>
      ${
        info.devices.length
          ? `<div class="small muted" style="margin-bottom:4px">Your devices</div><table class="small"><tbody>${info.devices
              .map((d) => `<tr><td><b>${esc(d.device)}</b>${sub && d.service === new URL(sub.endpoint).host && here ? ' <span class="badge ok">this one</span>' : ''}</td><td class="muted">since ${new Date(d.createdAt).toLocaleDateString()}${d.lastOk ? `, last sent ${new Date(d.lastOk).toLocaleDateString()}` : ''}</td><td class="actions"><button class="btn-sm" data-n="remove" data-id="${esc(d.id)}">Remove</button></td></tr>`)
              .join('')}</tbody></table>`
          : ''
      }`;
    el.querySelector('[data-n=on]')?.addEventListener('click', async (e) => {
      if (await run(e.target, () => device.enablePush(), 'Notifications are on for this device')) draw();
    });
    el.querySelector('[data-n=off]')?.addEventListener('click', async () => {
      await device.disablePush();
      toast('Notifications are off for this device', 'ok');
      draw();
    });
    el.querySelector('[data-n=test]')?.addEventListener('click', (e) => run(e.target, () => api('/push/test', { method: 'POST' }), 'Sent. It should appear in a few seconds.'));
    el.querySelectorAll('[data-n=remove]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (await run(b, () => api('/push/unsubscribe', { method: 'POST', body: { id: b.dataset.id } }), 'Removed')) draw();
      }),
    );
    el.querySelectorAll('[data-p]').forEach((c) =>
      c.addEventListener('change', () => {
        const p = { ...info.prefs };
        el.querySelectorAll('[data-p]').forEach((x) => (p[x.dataset.p] = x.checked));
        run(null, () => api('/push/prefs', { method: 'PUT', body: p }), 'Saved');
      }),
    );
  };
  draw();
}

// My account: install Serverboy as an app.
export function installCard(el) {
  const draw = () => {
    if (device.isStandalone()) {
      el.innerHTML = '<h2>The Serverboy app</h2><p><span class="badge ok">Installed</span> You are using Serverboy as an app on this device.</p>';
      return;
    }
    el.innerHTML = `<h2>The Serverboy app</h2>
      <p class="small muted" style="margin-top:0">Put Serverboy on your home screen: it opens like an app, and notifications work on iPhone too.</p>
      ${
        device.canInstall()
          ? '<button class="btn-primary" data-i="go">Install the app</button>'
          : device.isIOS()
            ? '<ol class="sec-steps small"><li>Open Serverboy in <b>Safari</b>.</li><li>Tap <b>Share</b> (the square with an arrow).</li><li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open Serverboy from the Home Screen and turn on notifications below.</li></ol>'
            : '<p class="small">In Chrome or Edge: the install icon in the address bar, or the menu → <b>Install Serverboy</b> / <b>Add to Home screen</b>.</p>'
      }`;
    el.querySelector('[data-i=go]')?.addEventListener('click', async () => {
      if (await device.install()) toast('Installed', 'ok');
      draw();
    });
  };
  window.addEventListener('sb:installable', draw);
  draw();
}
