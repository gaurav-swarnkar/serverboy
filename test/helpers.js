// Shared test helpers. Every test file runs in its own process (node --test), so setting
// DATA_DIR before requiring lib/store keeps each file's data separate and temporary.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

function tempDir(prefix = 'sb-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Point lib/store at a fresh temporary folder; call before requiring anything from lib/.
function useTempData() {
  const dir = tempDir('sb-data-');
  process.env.DATA_DIR = dir;
  delete process.env.SERVERBOY_SECRET;
  delete process.env.SERVERBOY_MONGO_URI;
  return dir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Start a program and wait until it answers HTTP on `port`.
async function startProcess(args, { env = {}, port, readyPath = '/', cwd = ROOT } = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Process exited early:\n${output}`);
    try {
      await fetch(`http://127.0.0.1:${port}${readyPath}`);
      break;
    } catch {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error(`Process did not start:\n${output}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return { child, output: () => output, stop: () => new Promise((r) => (child.exitCode !== null ? r() : (child.once('exit', r), child.kill()))) };
}

module.exports = { ROOT, tempDir, useTempData, freePort, startProcess };
