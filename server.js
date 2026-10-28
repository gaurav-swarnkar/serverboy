const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const store = require('./lib/store');
const auth = require('./lib/auth');
const terminal = require('./lib/terminal');
const team = require('./lib/team');
const { requiredForServerRoute, can } = require('./lib/permissions');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;

store.initAdminPassword();

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'",
  );
  next();
});

app.use(express.json({ limit: '20mb' }));

const vendor = (pkg) => path.dirname(require.resolve(`${pkg}/package.json`));
app.use('/vendor/xterm', express.static(vendor('@xterm/xterm')));
app.use('/vendor/xterm-addon-fit', express.static(vendor('@xterm/addon-fit')));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', auth.router);

const api = express.Router();
api.use(auth.requireAuth);
api.use(auditLog);
api.use(require('./routes/servers'));
api.use(require('./routes/team'));

const perServer = express.Router({ mergeParams: true });
perServer.use((req, res, next) => {
  if (!store.getServer(req.params.id)) return res.status(404).json({ error: 'Server not found' });
  const needed = requiredForServerRoute(req.method, req.path);
  if (!can(req.user, needed)) return res.status(403).json({ error: auth.deniedMessage(needed) });
  next();
});
perServer.use(require('./routes/system'));
perServer.use(require('./routes/files'));
perServer.use(require('./routes/databases'));
perServer.use(require('./routes/sites'));
perServer.use(require('./routes/nodeapps'));
api.use('/servers/:id', perServer);
app.use('/api', api);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500 && !err.status) console.error(err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: err.message || 'Something went wrong' });
});

// Record every change (and every download) in the team activity log. Request bodies are never
// logged because they can contain passwords.
function auditLog(req, res, next) {
  const isDownload = /\/(files\/download|export)$/.test(req.path);
  // Team routes write their own, more readable entries ("Created user ravi").
  if ((req.method === 'GET' && !isDownload) || req.path.startsWith('/team')) return next();
  res.on('finish', () => {
    let path = req.originalUrl.split('?')[0];
    let serverName;
    const m = path.match(/^\/api\/servers\/([^/]+)/);
    if (m) {
      serverName = store.listServers().find((s) => s.id === m[1])?.name;
      path = path.replace(m[0], '') || '/';
    }
    team.audit({
      user: req.user.username,
      ip: req.ip,
      action: `${req.method} ${path.replace(/^\/api/, '')}`,
      target: req.query?.path ? String(req.query.path) : undefined,
      server: serverName,
      status: res.statusCode,
    });
  });
  next();
}

const server = http.createServer(app);
terminal.attach(server);

server.listen(PORT, HOST, () => {
  console.log(`Serverboy is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    // List this machine's network addresses so phones on the same Wi-Fi know what to open.
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => `http://${i.address}:${PORT}`);
    if (lan.length) console.log(`On your phone (same Wi-Fi), open: ${lan.join('  or  ')}`);
    console.log('Warning: listening on a network interface. Put it behind HTTPS (see README) before using it over the internet.');
  }
});
