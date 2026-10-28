// SSH connection pool + helpers for running commands (optionally with sudo) and SFTP.
const crypto = require('crypto');
const { Client } = require('ssh2');
const store = require('./store');

const pool = new Map(); // serverId -> entry
const MAX_OUTPUT = 20 * 1024 * 1024;
const ENV_PREFIX = 'export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a; ';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Quote a string for safe use as a single shell argument.
function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function friendlyError(err, entry) {
  if (entry?.hostKeyMismatch) {
    return new HttpError(
      502,
      'The server\'s SSH host key changed since it was first saved. If you rebuilt the server, use "Reset host key" in the server settings; otherwise this may be an attack.',
    );
  }
  const msg = err?.message || String(err);
  if (err?.level === 'client-authentication' || /authentication methods failed/i.test(msg)) {
    return new HttpError(502, 'SSH login failed: wrong username, password or key.');
  }
  if (err?.code === 'ECONNREFUSED') return new HttpError(502, 'Connection refused: is SSH running and the port open?');
  if (err?.code === 'ETIMEDOUT' || /timed out/i.test(msg)) {
    return new HttpError(502, 'Connection timed out. Check the IP, and that port 22 is allowed in the Azure Network Security Group.');
  }
  if (err?.code === 'ENOTFOUND') return new HttpError(502, 'Host not found. Check the IP / hostname.');
  return new HttpError(502, `SSH error: ${msg}`);
}

function buildConfig(server, entry) {
  const cfg = {
    host: server.host,
    port: server.port,
    username: server.username,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
    tryKeyboard: Boolean(server.password),
    // Trust-on-first-use host key pinning.
    hostVerifier: (keyBuf) => {
      const fp = `SHA256:${crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '')}`;
      if (!server.hostFingerprint) {
        store.setFingerprint(server.id, fp);
        return true;
      }
      if (fp !== server.hostFingerprint) {
        entry.hostKeyMismatch = true;
        return false;
      }
      return true;
    },
  };
  if (server.privateKey) {
    cfg.privateKey = server.privateKey;
    if (server.passphrase) cfg.passphrase = server.passphrase;
  }
  if (server.password) cfg.password = server.password;
  return cfg;
}

function connect(serverId) {
  const existing = pool.get(serverId);
  if (existing) return existing.ready;

  const server = store.getServer(serverId);
  if (!server) return Promise.reject(new HttpError(404, 'Server not found'));

  const client = new Client();
  const entry = { client, server, sudoMode: null, sftp: null };
  entry.ready = new Promise((resolve, reject) => {
    let settled = false;
    client.on('ready', async () => {
      try {
        entry.sudoMode = await detectSudo(entry);
        settled = true;
        resolve(entry);
      } catch (err) {
        settled = true;
        reject(err);
      }
    });
    client.on('error', (err) => {
      if (pool.get(serverId) === entry) pool.delete(serverId);
      if (!settled) {
        settled = true;
        reject(friendlyError(err, entry));
      }
    });
    client.on('close', () => {
      if (pool.get(serverId) === entry) pool.delete(serverId);
    });
    client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
      finish(prompts.map(() => server.password || ''));
    });
    client.connect(buildConfig(server, entry));
  });
  pool.set(serverId, entry);
  return entry.ready;
}

function disconnect(serverId) {
  const entry = pool.get(serverId);
  if (entry) {
    pool.delete(serverId);
    entry.client.end();
  }
}

// Run a command on an open connection. Resolves with { code, stdout, stderr }.
function rawExec(entry, command, { stdin, onData, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    entry.client.exec(command, (err, stream) => {
      if (err) return reject(friendlyError(err));
      let stdout = '';
      let stderr = '';
      let timer = null;
      if (timeout) {
        timer = setTimeout(() => {
          stream.close();
          reject(new HttpError(504, `Command timed out after ${Math.round(timeout / 1000)}s`));
        }, timeout);
      }
      stream.on('data', (d) => {
        const s = d.toString('utf8');
        if (stdout.length < MAX_OUTPUT) stdout += s;
        onData?.(s);
      });
      stream.stderr.on('data', (d) => {
        const s = d.toString('utf8');
        if (stderr.length < MAX_OUTPUT) stderr += s;
        onData?.(s);
      });
      stream.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      stream.end(stdin ?? undefined);
    });
  });
}

async function detectSudo(entry) {
  if (entry.server.username === 'root') return 'root';
  const r = await rawExec(entry, 'sudo -n true 2>/dev/null && echo SUDO_OK', { timeout: 15000 });
  if (r.stdout.includes('SUDO_OK')) return 'nopass';
  return entry.server.password ? 'pass' : 'none';
}

function wrapCommand(entry, command, sudo) {
  const script = ENV_PREFIX + command;
  if (!sudo || entry.sudoMode === 'root') return { cmd: `bash -c ${q(script)}` };
  if (entry.sudoMode === 'nopass') return { cmd: `sudo -n bash -c ${q(script)}` };
  if (entry.sudoMode === 'pass') {
    return { cmd: `sudo -S -p '' bash -c ${q(script)}`, stdin: `${entry.server.password}\n` };
  }
  throw new HttpError(
    403,
    'This action needs administrator (sudo) rights, but the SSH user has no password stored and passwordless sudo is not enabled.',
  );
}

/**
 * Run a shell command on a server.
 * opts.sudo   run as root
 * opts.onData streaming callback for live output
 * opts.check  throw if the exit code is non-zero
 */
async function exec(serverId, command, opts = {}) {
  const entry = await connect(serverId);
  const { cmd, stdin } = wrapCommand(entry, command, opts.sudo);
  const result = await rawExec(entry, cmd, { stdin, onData: opts.onData, timeout: opts.timeout });
  if (opts.check && result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-15).join('\n');
    throw new HttpError(500, detail || `Command failed with exit code ${result.code}`);
  }
  return result;
}

const PERMISSION_RE = /permission denied|operation not permitted|access denied|must be root|are you root/i;

// Try without sudo first; retry with sudo on a permission error.
// opts.allowSudo === false disables the retry (used for team members).
async function execMaybeSudo(serverId, command, opts = {}) {
  const first = await exec(serverId, command, { ...opts, check: false });
  if (first.code === 0 || !PERMISSION_RE.test(first.stderr + first.stdout) || opts.allowSudo === false) {
    if (opts.check && first.code !== 0) {
      throw new HttpError(500, (first.stderr || first.stdout).trim() || `Command failed with exit code ${first.code}`);
    }
    return first;
  }
  return exec(serverId, command, { ...opts, sudo: true });
}

// Open a channel and hand back the raw stream (for downloads). Caller must consume it.
async function execStream(serverId, command, { sudo } = {}) {
  const entry = await connect(serverId);
  const { cmd, stdin } = wrapCommand(entry, command, sudo);
  return new Promise((resolve, reject) => {
    entry.client.exec(cmd, (err, stream) => {
      if (err) return reject(friendlyError(err));
      stream.end(stdin ?? undefined);
      resolve(stream);
    });
  });
}

async function sftp(serverId) {
  const entry = await connect(serverId);
  if (!entry.sftp) {
    entry.sftp = new Promise((resolve, reject) => {
      entry.client.sftp((err, s) => {
        if (err) {
          entry.sftp = null;
          return reject(friendlyError(err));
        }
        s.on('close', () => {
          entry.sftp = null;
        });
        resolve(s);
      });
    });
  }
  return entry.sftp;
}

function sftpWrite(s, remotePath, data, mode) {
  return new Promise((resolve, reject) => {
    s.writeFile(remotePath, data, mode ? { mode } : {}, (err) => (err ? reject(err) : resolve()));
  });
}

// Write a file; if the SSH user lacks permission, stage it in /tmp and copy it into place with sudo.
async function writeFile(serverId, remotePath, data, { sudo = 'auto' } = {}) {
  const s = await sftp(serverId);
  if (sudo !== true) {
    try {
      await sftpWrite(s, remotePath, data);
      return;
    } catch (err) {
      if (sudo === false || err.code !== 3) throw new HttpError(500, `Could not write ${remotePath}: ${err.message}`);
    }
  }
  const tmp = `/tmp/.serverboy-${crypto.randomBytes(6).toString('hex')}`;
  await sftpWrite(s, tmp, data, 0o600);
  // cp onto an existing file keeps its owner and mode; new files get 644.
  const dest = q(remotePath);
  await exec(
    serverId,
    `if [ -e ${dest} ]; then cp ${q(tmp)} ${dest}; else install -m 644 ${q(tmp)} ${dest}; fi; rc=$?; rm -f ${q(tmp)}; exit $rc`,
    { sudo: true, check: true },
  );
}

async function readFile(serverId, remotePath, { maxBytes = 5 * 1024 * 1024, allowSudo = true } = {}) {
  const r = await execMaybeSudo(serverId, `set -o pipefail; head -c ${maxBytes + 1} -- ${q(remotePath)} | base64 -w0`, { check: true, allowSudo });
  const buf = Buffer.from(r.stdout.trim(), 'base64');
  if (buf.length > maxBytes) throw new HttpError(413, 'File is too large to open in the editor. Download it instead.');
  return buf;
}

async function sudoInfo(serverId) {
  const entry = await connect(serverId);
  return entry.sudoMode;
}

module.exports = {
  HttpError,
  q,
  connect,
  disconnect,
  exec,
  execMaybeSudo,
  execStream,
  sftp,
  writeFile,
  readFile,
  sudoInfo,
  pool,
};
