// Tells people when Serverboy was updated while they had it open, and shows the owner's
// message to the team. Only tabs running an older version get the update notice; the
// owner's message goes to everyone or only to those tabs, as the owner chose.
import { api, esc, modal, clientInfo } from './ui.js';

const state = { loaded: null, latest: null, info: null, timer: null };
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

function box() {
  let el = document.getElementById('sb-notices');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sb-notices';
    document.body.append(el);
  }
  return el;
}

const outdated = () => Boolean(state.loaded && state.info && state.info.build !== state.loaded.build);

function whatsNew() {
  const { changelog = [] } = state.info || {};
  const from = state.loaded?.version;
  // Entries newer than the version this tab runs; at least the latest one.
  let entries = changelog.filter((e) => from && e.version !== from && newer(e.version, from));
  if (!entries.length) entries = changelog.slice(0, 1);
  return entries;
}

function newer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

function showWhatsNew() {
  modal({
    title: `What's new in Serverboy ${state.info.version}`,
    body: whatsNew()
      .map((e) => `<h3 style="margin:8px 0 4px">${esc(e.version)} <span class="small muted">${esc(e.date || '')}</span></h3><ul class="small" style="padding-left:18px;margin-top:0">${e.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`)
      .join(''),
    actions: [{ label: 'Later' }, { label: 'Refresh now', className: 'btn-primary', onClick: () => location.reload() }],
  });
}

function draw() {
  const el = box();
  const a = state.info?.announcement;
  const parts = [];
  const snoozed = store.get('sb-update-later') === state.info?.build;
  if (outdated() && !snoozed) {
    const from = state.loaded.version;
    const to = state.info.version;
    parts.push(`<div class="sb-notice update" role="status">
      <div class="grow"><b>Serverboy was updated${to !== from ? ` to ${esc(to)}` : ''}.</b> Refresh to get the latest version.
        <a href="#" data-n="whatsnew">What's new</a></div>
      <button class="btn-sm" data-n="later">Later</button>
      <button class="btn-sm btn-primary" data-n="reload">Refresh now</button>
    </div>`);
  }
  const showMsg = a && store.get('sb-msg-dismissed') !== a.id && (a.audience === 'everyone' || outdated());
  if (showMsg) {
    parts.push(`<div class="sb-notice ${a.level === 'warn' ? 'warn' : ''}" role="status">
      <div class="grow"><b>Message from ${esc(a.by || 'the admin')}:</b> ${esc(a.text)}</div>
      ${a.askRefresh && !outdated() ? '<button class="btn-sm btn-primary" data-n="reload">Refresh now</button>' : ''}
      <button class="btn-sm btn-ghost" data-n="dismiss" title="Dismiss">✕</button>
    </div>`);
  }
  el.innerHTML = parts.join('');
  el.onclick = (e) => {
    const n = e.target.closest('[data-n]')?.dataset.n;
    if (!n) return;
    e.preventDefault();
    if (n === 'reload') location.reload();
    if (n === 'whatsnew') showWhatsNew();
    if (n === 'later') {
      store.set('sb-update-later', state.info.build);
      draw();
    }
    if (n === 'dismiss') {
      store.set('sb-msg-dismissed', a.id);
      draw();
    }
  };
}

export async function check() {
  try {
    state.info = await api('/version');
    if (!state.loaded) {
      state.loaded = { version: state.info.version, build: state.info.build };
      clientInfo.build = state.info.build;
    }
    draw();
  } catch {
    /* offline or logged out: try again later */
  }
}

export function startUpdateWatch() {
  if (state.timer) return;
  check();
  state.timer = setInterval(check, 2 * 60 * 1000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
  // Every API response carries the server's build; react at once when it changes.
  window.addEventListener('sb:build', (e) => {
    if (state.info && e.detail && e.detail !== state.info.build) check();
  });
}
