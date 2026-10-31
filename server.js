const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const store = require('./lib/store');
const auth = require('./lib/auth');
const terminal = require('./lib/terminal');
const team = require('./lib/team');
const { requiredForServerRoute, can } = require('./lib/permissions');
const version = require('./lib/version');

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
  // Lets open browser tabs notice that Serverboy was updated (public/js/updates.js).
  res.setHeader('X-Serverboy-Build', version.build);
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
app.use('/vendor/swagger-ui', express.static(vendor('swagger-ui-dist')));
app.use('/vendor/inter', express.static(path.join(vendor('@fontsource-variable/inter'), 'files')));
// Always revalidate (cheap, ETag) so a refresh after an update never runs stale code.
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

app.use('/api', auth.router);

const api = express.Router();
api.use(auth.requireAuth);
api.use(auditLog);
// Which Serverboy version each person's browser runs (for "who still has to refresh").
const clients = new Map();
api.use((req, res, next) => {
  const b = req.get('x-serverboy-client');
  if (b && /^[0-9a-f]{12}$/.test(b)) clients.set(req.user.username, { username: req.user.username, name: req.user.name || req.user.username, build: b, at: Date.now() });
  next();
});
api.get('/team/clients', auth.requirePermission('owner'), (req, res) => {
  const since = Date.now() - 24 * 3600 * 1000;
  res.json({ build: version.build, clients: [...clients.values()].filter((c) => c.at > since).sort((a, b) => b.at - a.at) });
});
const people = require('./routes/people');
api.get('/version', async (req, res) => {
  res.json({ version: version.version, build: version.build, startedAt: version.startedAt, changelog: version.changelog, announcement: store.getAnnouncement(), unread: await people.unreadCount(req.user) });
});
api.use(people);
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
perServer.use(require('./routes/health'));
perServer.use(require('./routes/storage'));
perServer.use(require('./routes/files'));
perServer.use(require('./routes/databases'));
perServer.use(require('./routes/dataapi'));
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
