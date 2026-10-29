import { esc, toast, confirmDialog, formDialog, onAction } from '../ui.js';
import { COMMAND_BOOK, placeholders, fill } from '../commandbook.js';

const BOOK_OPEN_KEY = 'sb-cmdbook-open';
const MY_COMMANDS_KEY = 'sb-my-commands';

// localStorage can be unavailable (private mode); the page must work without it.
function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function showCommand(cmd) {
  return esc(cmd).replace(/\{\{([^}|]+)(?:\|([^}]*))?\}\}/g, (_, name, def) => `<mark title="${def ? `default: ${def}` : 'you will be asked'}">${name}</mark>`);
}

export async function render(el, { server }) {
  let bookOpen = load(BOOK_OPEN_KEY, true);
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Terminal</h1><div class="sub">A live shell on ${esc(server.host)}, same as connecting with PuTTY or ssh.</div></div>
      <div class="row">
        <span class="badge" id="term-status">connecting…</span>
        <button id="reconnect">Reconnect</button>
        <button id="toggle-book">📖 Command book</button>
      </div>
    </div>
    <div class="term-layout ${bookOpen ? 'with-book' : ''}">
      <div class="terminal-box"><div id="term" style="height:100%"></div></div>
      <aside class="cmdbook card flush">
        <div class="card-head"><b>📖 Command book</b><button class="btn-sm btn-ghost" id="close-book" aria-label="Close">✕</button></div>
        <div class="cb-search"><input id="cb-q" placeholder="Search: disk, nginx, logs, backup…" autocomplete="off"></div>
        <div class="cb-list" id="cb-list"></div>
        <div class="cb-foot small muted">Insert types the command for you to check, then press Enter. Run sends it straight away.</div>
      </aside>
    </div>`;

  // ---------- terminal ----------
  const term = new window.Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13.5,
    theme: { background: '#0b0e19' },
    scrollback: 5000,
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el.querySelector('#term'));
  fit.fit();
  term.focus();

  const statusEl = el.querySelector('#term-status');
  let ws = null;

  function connect() {
    ws?.close();
    statusEl.className = 'badge';
    statusEl.textContent = 'connecting…';
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/terminal?server=${server.id}&cols=${term.cols}&rows=${term.rows}`);
    ws.onopen = () => {
      statusEl.className = 'badge ok';
      statusEl.textContent = 'connected';
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'data') term.write(msg.data);
      if (msg.type === 'error') term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
    };
    ws.onclose = () => {
      statusEl.className = 'badge warn';
      statusEl.textContent = 'disconnected';
    };
  }

  const send = (data) => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'data', data }));
  const dataSub = term.onData(send);
  const resizeSub = term.onResize(({ cols, rows }) => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'resize', cols, rows })));
  const onWindowResize = () => fit.fit();
  window.addEventListener('resize', onWindowResize);
  el.querySelector('#reconnect').onclick = connect;
  connect();

  // ---------- command book ----------
  const layout = el.querySelector('.term-layout');
  const listEl = el.querySelector('#cb-list');
  const searchEl = el.querySelector('#cb-q');
  let myCommands = load(MY_COMMANDS_KEY, []);
  let items = []; // flat list, indexes used by the buttons

  const setBook = (open) => {
    bookOpen = open;
    save(BOOK_OPEN_KEY, open);
    layout.classList.toggle('with-book', open);
    // Let the layout settle, then resize the terminal to its new width.
    requestAnimationFrame(() => fit.fit());
    if (open) searchEl.focus();
  };
  el.querySelector('#toggle-book').onclick = () => setBook(!bookOpen);
  el.querySelector('#close-book').onclick = () => setBook(false);

  function itemHtml(c, i, mine) {
    return `<div class="cb-item">
      <div class="cb-title">${esc(c.t)} ${c.danger ? '<span class="badge bad">careful</span>' : ''}</div>
      ${c.cmd ? `<code class="cb-cmd">${showCommand(c.cmd)}</code>` : ''}
      ${c.d ? `<div class="cb-desc">${esc(c.d)}</div>` : ''}
      ${
        c.cmd
          ? `<div class="row cb-actions">
              <button class="btn-sm" data-action="insert" data-i="${i}">Insert</button>
              <button class="btn-sm ${c.danger ? 'btn-danger' : 'btn-primary'}" data-action="run" data-i="${i}">Run</button>
              <button class="btn-sm btn-ghost" data-action="copy" data-i="${i}">Copy</button>
              ${mine ? `<button class="btn-sm btn-ghost btn-danger" data-action="forget" data-i="${i}">Remove</button>` : ''}
            </div>`
          : ''
      }
    </div>`;
  }

  function draw() {
    const q = searchEl.value.trim().toLowerCase();
    const sections = [{ id: 'mine', title: 'My commands', icon: '★', commands: myCommands, mine: true }, ...COMMAND_BOOK];
    items = [];
    let html = '';
    for (const s of sections) {
      const matches = s.commands.filter((c) => !q || `${c.t} ${c.cmd} ${c.d} ${s.title}`.toLowerCase().includes(q));
      if (q && !matches.length) continue;
      const body = matches
        .map((c) => {
          items.push({ ...c, mine: s.mine });
          return itemHtml(c, items.length - 1, s.mine);
        })
        .join('');
      const extra = s.mine ? `<div class="cb-item"><button class="btn-sm" data-action="add-mine">+ Save a command of your own</button><div class="cb-desc">Saved in this browser. Use {{name}} for values to fill in.</div></div>` : '';
      html += `<details class="cb-section" ${q || s.mine ? 'open' : ''}>
        <summary><span class="cb-ico">${s.icon}</span>${esc(s.title)} <span class="muted small">${s.mine && !q ? myCommands.length : matches.length}</span></summary>
        ${body}${q ? '' : extra}
      </details>`;
    }
    listEl.innerHTML = html || '<div class="empty">No commands match.</div>';
  }
  searchEl.addEventListener('input', draw);
  draw();

  // Ask for {{values}}, then return the final command (or null if cancelled).
  async function prepare(c) {
    const fields = placeholders(c.cmd);
    if (!fields.length) return c.cmd;
    const values = await formDialog({
      title: c.t,
      intro: `<code class="mono">${showCommand(c.cmd)}</code>`,
      fields: fields.map((f) => ({ name: f.name, label: f.name, value: f.value, required: !f.value })),
      submitLabel: 'Continue',
    });
    if (!values) return null;
    const missing = fields.find((f) => !String(values[f.name] || '').trim());
    if (missing) {
      toast(`Fill in "${missing.name}"`, 'error');
      return null;
    }
    return fill(c.cmd, values);
  }

  function ensureConnected() {
    if (ws?.readyState === 1) return true;
    toast('The terminal is not connected. Click Reconnect.', 'error');
    return false;
  }

  onAction(el.querySelector('.cmdbook'), {
    insert: async ({ i }) => {
      if (!ensureConnected()) return;
      const cmd = await prepare(items[i]);
      if (!cmd) return;
      send(cmd);
      term.focus();
    },
    run: async ({ i }) => {
      if (!ensureConnected()) return;
      const c = items[i];
      const cmd = await prepare(c);
      if (!cmd) return;
      if (c.danger && !(await confirmDialog(`${c.d || 'This command can cause damage.'}\n\n${cmd}`, { title: `Run "${c.t}"?`, danger: true, confirmLabel: 'Run it' }))) return;
      send(`${cmd}\r`);
      term.focus();
    },
    copy: async ({ i }) => {
      try {
        await navigator.clipboard.writeText(items[i].cmd);
        toast('Copied', 'ok', 1500);
      } catch {
        toast('Copy is not allowed here; use Insert instead.', 'error');
      }
    },
    'add-mine': async () => {
      const v = await formDialog({
        title: 'Save a command',
        fields: [
          { name: 't', label: 'Name', placeholder: 'Restart my API', required: true },
          { name: 'cmd', label: 'Command', placeholder: 'pm2 restart {{app|api}}', required: true },
          { name: 'd', label: 'Note (optional)' },
          { name: 'danger', label: 'Ask before running (risky command)', type: 'checkbox' },
        ],
      });
      if (!v?.t || !v?.cmd) return;
      myCommands = [...myCommands, { t: v.t.trim(), cmd: v.cmd.trim(), d: v.d.trim(), danger: v.danger }];
      save(MY_COMMANDS_KEY, myCommands);
      draw();
    },
    forget: ({ i }) => {
      const c = items[i];
      myCommands = myCommands.filter((m) => !(m.t === c.t && m.cmd === c.cmd));
      save(MY_COMMANDS_KEY, myCommands);
      draw();
    },
  });

  return () => {
    window.removeEventListener('resize', onWindowResize);
    dataSub.dispose();
    resizeSub.dispose();
    ws?.close();
    term.dispose();
  };
}
