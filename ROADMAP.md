# Serverboy: what it needs to be production-proof

Checklist of everything between today's Serverboy (v1.3.0) and a panel you can trust with
client servers. Tick items off as they ship.

- **P0**: do before anyone else relies on it. Losing data or being broken into is possible today.
- **P1**: needed to be dependable day to day.
- **P2**: polish and growth.

Each item says what "done" means, so it can be tested.

---

## 1. Data safety (backups and recovery)

Shipped in v1.4.0 (Backups page). Not done yet: Serverboy's own data, restore drills, snapshots before changes.

- [x] **P0 Scheduled MongoDB backups.** Done when: `mongodump` runs nightly per database, gzip, kept 7 daily + 4 weekly, size and result shown in a Backups page.
- [x] **P0 Off-server copies.** Done when: backups upload to Azure Blob / S3 / Backblaze. A backup kept only on the same disk is lost with the VM.
- [x] **P0 One-click restore.** Done when: you can restore a database, or a single collection, to the same or a new name. Tested on a real dump.
- [x] **P0 Website and app files backup.** Done when: `/var/www/*`, Nginx site configs and PM2 app settings are in the same schedule.
- [ ] **P1 Backup of Serverboy itself.** Done when: `data/` (servers, encrypted secrets, sessions, settings) can be exported and imported, with a clear warning that it holds secrets.
- [x] **P1 Backup alerts.** Done when: a failed or missing backup shows on the dashboard and sends an alert (see section 3).
- [ ] **P1 Restore drill.** Done when: a monthly test-restore runs automatically into a scratch database and reports the result.
- [ ] **P2 Before-change snapshots.** Done when: deleting a database or collection, or "Update engine", takes an automatic dump first. Engine updates already keep a `.bak-v2` config.

## 2. Security

### Login and accounts
- [ ] **P0 Two-factor login (TOTP).** Done when: owner and team can enable an authenticator app, the owner can require it for everyone, and recovery codes exist.
- [ ] **P0 Per-account lockout.** Done when: failed logins are limited per username as well as per IP. Today the limit is per IP and in memory only, so it resets on restart.
- [ ] **P1 Password rules.** Done when: there is a minimum length plus a check against common or leaked passwords, and the owner can force a reset.
- [ ] **P1 Session list.** Done when: "Where you are logged in" shows device, IP and last use, with "Log out everywhere". The owner sees everyone's sessions.
- [ ] **P1 Re-confirm for dangerous actions.** Done when: deleting a site or database, revealing keys, or Log in as asks for the password or 2FA code again.
- [ ] **P2 Login with Google / Microsoft (SSO)** for teams.

### Secrets
- [ ] **P0 Separate the encryption key from the data.** Done when: the installer generates `SERVERBOY_SECRET` into the systemd unit or an env file with mode 600, not stored next to the data it protects. Today `config.secret` lives in `data/config.json` beside the encrypted secrets.
- [ ] **P1 Key rotation.** Done when: one command re-encrypts all stored secrets with a new key.
- [ ] **P1 Prefer SSH keys over passwords.** Done when: Add server offers to generate a key pair and install it, then forget the password.

### Web hardening
- [ ] **P0 Security headers everywhere.** Done when: CSP, HSTS (when HTTPS), X-Frame-Options/frame-ancestors, Referrer-Policy and nosniff are verified on every response by an automated test.
- [ ] **P0 Path and command-injection review.** Done when: every place that builds a shell command (`ssh.exec`, `q()`) or a file path is reviewed and has tests with hostile input (`;`, `$()`, `../`, newlines, unicode).
- [ ] **P1 Request limits.** Done when: rate limits apply to the API in general, not only to login. The 20 MB JSON limit is reviewed per route, and upload size limits apply per user.
- [ ] **P1 Dependency audit in CI.** Done when: `npm audit` and GitHub Dependabot run on every push. Updates to vendored assets (Swagger UI, xterm, Inter) are tracked.
- [ ] **P1 Outside review.** Done when: someone other than the author has run a pentest or security review, and there is a short `SECURITY.md` with how to report issues.
- [ ] **P2 Panel behind an allowlist.** Done when: there is an optional IP allowlist or Cloudflare Access / Tailscale mode for the portal itself.

### Data API (the public part)
- [ ] **P0 Abuse limits per key and per IP.** Done when: the defaults are reviewed and a test proves a flood gets HTTP 429.
- [ ] **P1 Key scopes and expiry.** Done when: keys can expire, be limited to IPs or origins, and show last-used time.
- [ ] **P1 Query safety.** Done when: caller filters cannot use `$where`, `$function` or heavy regex, page sizes are capped, and there is a timeout per query. Test with hostile queries.
- [ ] **P2 Request log per API.** Done when: you can see the last N calls (status, time, key) and a daily count.

## 3. Monitoring and alerts

- [ ] **P0 Alerts.** Done when: health problems (site down, disk > 90%, PM2 app crashed, Mongo down, SSL expiring in under 14 days, backup failed) are sent by email and Telegram or Slack, with a "fixed" message after.
- [ ] **P1 Uptime checks from outside.** Done when: an external probe checks each live site every minute, so the alert still arrives when the whole VM is down.
- [ ] **P1 History.** Done when: CPU, memory, disk and requests are kept for 30 days with charts, not only the live 3 minutes.
- [ ] **P1 Log viewer.** Done when: Nginx access and error logs and PM2 logs can be searched with a time filter in the UI.
- [ ] **P2 Status page.** Done when: there is an optional public page listing site uptime for clients.

## 4. Deploys and apps

- [ ] **P1 Push-to-deploy.** Done when: a GitHub/GitLab webhook per Node app runs pull, install, build and restart, the log shows in Tasks, and a failed build keeps the old version running.
- [ ] **P1 Rollback.** Done when: the last 5 releases are kept and rollback is one click.
- [ ] **P1 Environment variables UI.** Done when: per-app variables can be edited with secrets masked, and the app restarts on save.
- [ ] **P2 Zero-downtime reload.** Done when: PM2 cluster mode with `pm2 reload` is available for apps that support it.
- [ ] **P2 Static site deploys.** Done when: a static site deploys from a Git repo with a build command (Vite, Next export).

## 5. Reliability of Serverboy itself

- [ ] **P0 Automated tests.** Done when: there are unit tests for `lib/` (auth, scope, permissions, nginx config writer, import parser, openapi) and API tests for every route's permission checks, and they run on every push. Today there is no test suite.
- [ ] **P0 CI pipeline.** Done when: GitHub Actions runs lint, tests and a smoke test that installs into a fresh Ubuntu container.
- [ ] **P0 Releases instead of a branch.** Done when: installs and updates pull a tagged version (`v1.4.0`), not a development branch. The install script has a `--version` flag, and a bad release can be rolled back.
- [ ] **P1 Safe self-update.** Done when: Update in the UI downloads the new version, runs a health check, and switches back automatically if Serverboy doesn't start.
- [ ] **P1 Failure handling.** Done when: SSH drops, Mongo down, a full disk and a sudo password prompt each show a clear message and never hang a request. Each case has a test.
- [ ] **P1 Job safety.** Done when: long jobs (installs, imports, certbot) survive a browser refresh. A Serverboy restart marks running jobs as interrupted.
- [ ] **P2 Multi-server scale.** Done when: 20+ servers and 50+ team members work without slow pages (paging, caching of health data).

## 6. Team and access

Already done: roles, per-site and per-database scope, activity log, Log in as, messages, update notices.

- [ ] **P1 Export the activity log** to CSV, kept 1 year (configurable).
- [ ] **P1 Invite by email.** Done when: the owner sends an invite link and the member sets their own password. Today the owner creates the password and shares it.
- [ ] **P2 Approval flow.** Done when: risky actions (delete database, make site live) by members can require owner approval.
- [ ] **P2 Client accounts.** Done when: a read-only "client" role can only see their sites' uptime and the preview link.

## 7. Product and usability

- [ ] **P1 Documentation site.** Done when: install, update, backup/restore, Data API and troubleshooting guides exist, and each page in the app links to its guide (the ? button).
- [ ] **P1 First-run setup wizard.** Done when: there are guided steps for the first server, firewall, MongoDB auth, backups and alerts.
- [ ] **P1 Accessibility pass.** Done when: everything can be done by keyboard, labels are present, and both themes pass contrast checks.
- [ ] **P2 Mobile-first quick actions.** Done when: restart an app, see alerts and Make live work comfortably on a phone.
- [ ] **P2 Translations.**

## 8. Out of scope (on purpose)

Leave these to dedicated tools; they would add risk without strengthening Serverboy's niche:

- Email hosting (use Zoho, Google Workspace, Migadu, or HestiaCP on a separate server).
- DNS hosting (use Cloudflare or the registrar).
- A Docker orchestrator (use Coolify if a project needs containers).

---

## Suggested order

1. Backups + off-server copies + restore (section 1, all P0).
2. 2FA, per-account lockout, encryption key moved out of `data/`.
3. Test suite + CI + tagged releases.
4. Alerts (email + Telegram).
5. Security review of shell/path handling and the Data API.
6. Push-to-deploy with rollback.
7. Everything P1, then P2.
