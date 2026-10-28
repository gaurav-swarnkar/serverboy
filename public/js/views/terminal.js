import { esc } from '../ui.js';

export async function render(el, { server }) {
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Terminal</h1><div class="sub">A live shell on ${esc(server.host)}, same as connecting with PuTTY or ssh.</div></div>
      <div class="row"><span class="badge" id="term-status">connecting…</span><button id="reconnect">Reconnect</button></div>
    </div>
    <div class="terminal-box"><div id="term" style="height:100%"></div></div>`;

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

  const dataSub = term.onData((data) => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'data', data })));
  const resizeSub = term.onResize(({ cols, rows }) => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'resize', cols, rows })));
  const onWindowResize = () => fit.fit();
  window.addEventListener('resize', onWindowResize);
  el.querySelector('#reconnect').onclick = connect;
  connect();

  return () => {
    window.removeEventListener('resize', onWindowResize);
    dataSub.dispose();
    resizeSub.dispose();
    ws?.close();
    term.dispose();
  };
}
