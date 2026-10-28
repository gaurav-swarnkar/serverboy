const path = require('path');
const http = require('http');
const express = require('express');
const store = require('./lib/store');
const auth = require('./lib/auth');
const terminal = require('./lib/terminal');

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
app.use('/api', auth.requireAuth, require('./routes/servers'));

const perServer = express.Router({ mergeParams: true });
perServer.use((req, res, next) => {
  if (!store.getServer(req.params.id)) return res.status(404).json({ error: 'Server not found' });
  next();
});
perServer.use(require('./routes/system'));
perServer.use(require('./routes/files'));
perServer.use(require('./routes/databases'));
perServer.use(require('./routes/sites'));
perServer.use(require('./routes/nodeapps'));
app.use('/api/servers/:id', auth.requireAuth, perServer);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500 && !err.status) console.error(err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: err.message || 'Something went wrong' });
});

const server = http.createServer(app);
terminal.attach(server);

server.listen(PORT, HOST, () => {
  console.log(`Serverboy is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log('Warning: listening on a public interface. Put it behind HTTPS (see README) before using it over the internet.');
  }
});
