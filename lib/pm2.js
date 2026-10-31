// PM2 runs as the SSH user and, on boot, is started by systemd (pm2-<user>.service, created
// by "pm2 startup"). Two PM2 quirks cause "Job for pm2-<user>.service failed because the
// service did not take the steps required by its unit configuration":
//   - any pm2 command (even "pm2 jlist") starts a new daemon when none is running;
//   - systemd refuses to take over a daemon it did not start itself.
// So read-only checks only talk to PM2 when it is already running, and before PM2 is used to
// start something we make sure the daemon is the one systemd started.
const ssh = require('./ssh');

const { q } = ssh;
const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/i;

// True (exit 0) when the current user's PM2 daemon is running.
const DAEMON_UP = `pgrep -u "$(id -u)" -f '[P]M2 v[0-9.]*: God Daemon' >/dev/null 2>&1`;

// Run cmd only if PM2 is already running; otherwise run `otherwise` (default: an empty list).
function whenRunning(cmd, otherwise = 'echo "[]"') {
  return `if ${DAEMON_UP}; then ${cmd}; else ${otherwise}; fi`;
}

// Root script: save the running apps (never replacing a saved list with an empty one),
// (re)create the boot service for the right pm2 / node paths, stop any daemon systemd did not
// start, and let systemd start PM2 (which brings the saved apps back).
function adoptScript(user) {
  if (!USER_RE.test(user)) throw new ssh.HttpError(400, 'Invalid user name');
  const unit = `pm2-${user}`;
  return `u=${q(user)}; h=$(getent passwd "$u" | cut -d: -f6); pm2=$(command -v pm2 || echo /usr/local/bin/pm2)
[ -n "$h" ] || { echo "User $u not found"; exit 1; }
[ -x "$pm2" ] || { echo "PM2 is not installed"; exit 1; }
run() { sudo -u "$u" env HOME="$h" PM2_HOME="$h/.pm2" PATH="$PATH:$(dirname "$pm2")" "$pm2" "$@"; }
if pgrep -u "$u" -f '[P]M2 v[0-9.]*: God Daemon' >/dev/null 2>&1 && ! systemctl is-active --quiet ${q(unit)}; then
  [ -f "$h/.pm2/dump.pm2" ] && cp -p "$h/.pm2/dump.pm2" "$h/.pm2/dump.pm2.bak-serverboy"
  if [ "$(run jlist 2>/dev/null | tail -1 | grep -o '"pm_id"' | wc -l)" -gt 0 ]; then run save --force; else echo "PM2 has no running apps; keeping the saved app list."; fi
  stray=1
fi
env PATH="$PATH:$(dirname "$(command -v node 2>/dev/null || echo /usr/bin/node)")" "$pm2" startup systemd -u "$u" --hp "$h" >/dev/null
[ -n "$stray" ] && run kill >/dev/null
systemctl daemon-reload; systemctl reset-failed ${q(unit)} 2>/dev/null
systemctl start ${q(unit)} && sleep 2 && systemctl is-active ${q(unit)} && echo "PM2 is now run by systemd (${unit})."`;
}

// Before PM2 starts or restarts an app: make sure the daemon is the one systemd runs.
// setupBoot also creates the boot service when there is none yet (first deploy).
// Never throws; returns a line for the task log.
async function ensureDaemon(serverId, { setupBoot = false } = {}) {
  try {
    const entry = await ssh.connect(serverId);
    const user = entry.server.username;
    const unit = `pm2-${user}`;
    const r = await ssh.exec(
      serverId,
      `command -v pm2 >/dev/null || echo NO_PM2; ${DAEMON_UP} && echo UP; systemctl cat ${q(unit)}.service >/dev/null 2>&1 && echo UNIT; systemctl is-active --quiet ${q(unit)} && echo ACTIVE`,
    );
    const has = (flag) => r.stdout.split('\n').includes(flag);
    if (has('NO_PM2')) return 'PM2 is not installed.';
    if (has('ACTIVE') && has('UP')) return `PM2 is running under systemd (${unit}).`;
    if (!has('UNIT') && !setupBoot) return 'PM2 has no boot service yet; it will be set up on the next deploy.';
    const a = await ssh.exec(serverId, adoptScript(user), { sudo: true, timeout: 120000 });
    return a.code === 0 ? `PM2 is now run by systemd (${unit}), so it also starts on boot.` : `Could not start ${unit}: ${(a.stdout + a.stderr).trim().slice(-600)}`;
  } catch (err) {
    return `Skipped the PM2 boot check: ${err.message}`;
  }
}

module.exports = { DAEMON_UP, whenRunning, adoptScript, ensureDaemon };
