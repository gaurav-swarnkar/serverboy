// Browser terminal: a WebSocket bridged to an interactive SSH shell (xterm.js on the client).
const { WebSocketServer } = require('ws');
const ssh = require('./ssh');
const auth = require('./auth');

function attach(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    const sameOrigin = !origin || new URL(origin).host === req.headers.host;
    if (url.pathname !== '/ws/terminal' || !auth.sessionFromRequest(req) || !sameOrigin) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handle(ws, url.searchParams));
  });
}

async function handle(ws, params) {
  const serverId = params.get('server');
  const cols = Number(params.get('cols')) || 100;
  const rows = Number(params.get('rows')) || 30;
  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

  let entry;
  try {
    entry = await ssh.connect(serverId);
  } catch (err) {
    send({ type: 'error', message: err.message });
    return ws.close();
  }

  entry.client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
    if (err) {
      send({ type: 'error', message: err.message });
      return ws.close();
    }
    stream.on('data', (d) => send({ type: 'data', data: d.toString('utf8') }));
    stream.stderr.on('data', (d) => send({ type: 'data', data: d.toString('utf8') }));
    stream.on('close', () => {
      send({ type: 'exit' });
      ws.close();
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'data' && typeof msg.data === 'string') stream.write(msg.data);
      if (msg.type === 'resize') stream.setWindow(Number(msg.rows) || rows, Number(msg.cols) || cols, 0, 0);
    });
    ws.on('close', () => stream.close());
  });
}

module.exports = { attach };
