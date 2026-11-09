// What changed in each version, newest first. Shown to team members when Serverboy is updated
// while they have it open ("What's new").
module.exports = [
  {
    version: '1.11.0',
    date: '2026-11-09',
    items: [
      'APIs live inside your websites: each website has one API folder with a name you choose (for example shop.com/data-k3x9 instead of the easy-to-guess /api), and APIs from any of your databases can live in it.',
      'Groups are real sub-folders: Auth APIs at …/auth/login and …/auth/register, blog APIs at …/blog/posts. Serverboy refuses two APIs with the same address, also across databases.',
      'New API asks where it should live (a website\'s API folder, private for now, or its own address) and shows the full address as you type. API server → Settings → Address: put it in a website, move it, or take it out. The APIs page can rename a website\'s API folder in one go.',
      'The APIs page is organised by website → API folder → group, with the API servers that are not in a website yet and the collections without an API below.',
      'Fixed: a backup restored as a copy of an API server (for example smilo-quotes-restored-20261107-024723) showed up as a second, broken API server, and new APIs could be added to it. Copies are now marked, never get new APIs, and can be deleted or made separate in one click.',
      'Swagger, code examples, docs for AI and Diagnose use the website address; Diagnose checks that the website folder reaches the API and can write its routes again.',
    ],
  },
  {
    version: '1.10.0',
    date: '2026-11-09',
    items: [
      'Serverboy protects itself: on the server it runs on, actions that would take Serverboy offline are refused with a clear reason, so it can no longer be deleted or stopped by accident.',
      'Websites: the site that serves Serverboy is marked "🛡 Serverboy itself" and cannot be deleted, disabled, put in test mode or edited (Enable SSL still works). No other website, API or 1-click app can take over its address.',
      'File Manager: Serverboy\'s program, data, settings file, service, the Node.js it runs on, its Nginx site and HTTPS certificate cannot be deleted, moved or changed, and neither can a folder that contains them.',
      'Services, processes and software: Serverboy and Nginx cannot be stopped or killed (Restart works), and Node.js, Nginx and certbot cannot be uninstalled.',
      'Firewall: ports 80 and 443 stay open on Serverboy\'s server (turning the firewall on opens them too). On every server, SSH cannot be stopped, blocked or have its last firewall rule deleted, because Serverboy works over SSH.',
    ],
  },
  {
    version: '1.9.1',
    date: '2026-11-07',
    items: [
      'Fixed: a copied API server folder (for example "smilo-quotes-restore" copied from "smilo-quotes") kept the original\'s name, port, PM2 entry and address, so all its requests went to the original and its own APIs answered 404. Diagnose now spots a copy, and "Make it independent" gives it its own name, a free port, its own database login and PM2 entry, and files Serverboy can change. The original is not touched.',
      '"Move to a free port" now also works when the folder belongs to root, and an address used by another app is never taken over.',
      'Deleting an API server no longer removes a web address that another app also uses, and Restart refuses to restart a copy (it would restart the original).',
    ],
  },
  {
    version: '1.9.0',
    date: '2026-11-07',
    items: [
      'Alerts (Administration → Alerts): hear about problems by email, Telegram, Slack, Discord or a webhook, and in your Serverboy inbox. Each has a Send test button.',
      'Serverboy watches your servers every 5 minutes (or 10, 15, 30): websites or Nginx down, services or Node apps crashed, disk or memory full, a server that cannot be reached, and HTTPS certificates expiring within 14 days. Backup, test-restore and deploy failures alert too.',
      'No alert spam: a problem must show up twice in a row, you get a "Fixed" message when it is gone, a reminder once a day while it lasts, and many problems at once arrive as one message.',
      'Choose what to alert about (warnings are off by default) and which servers to watch. Passwords and tokens are stored encrypted.',
      'Fixed: a new API could answer "404 Not found" for its first seconds. Saving now waits until the API server has really loaded the change, and the new API engine (v4) picks changes up instantly.',
      'APIs → Diagnose: one click checks the API server step by step (settings, setup, process, database, engine, the API, its data, a real request and the public address), says what is wrong in plain words and offers the next step as a button: Finish setup, Restart, Logs, Update engine, Fix the address or Publish.',
      'Fixed: two API servers could end up on the same port, and then one API answered "404: There is no API called …" (and showed "not running"). New API servers now avoid every port another app uses, setup checks that the answer really comes from the new API server, and Diagnose spots a taken port and offers "Move to a free port" (APIs, keys and address are kept).',
      'The API page warns when its API server is not running, with a Diagnose and fix button.',
      'When a test answers with no answer, an error or "no such API", the result offers Diagnose. When creating an API fails, the form says at which step and why it usually happens, with Try again (continues where it stopped) and Diagnose.',
    ],
  },
  {
    version: '1.8.0',
    date: '2026-11-07',
    items: [
      '1-click apps (Hosting → 1-click apps): install WordPress, n8n or Uptime Kuma with Docker in one click, on its own address with a free HTTPS certificate. Start, stop, update, see logs and remove them from the same page.',
      'Safe by default: apps listen only on the server itself, so Docker never opens a port past your firewall; passwords are generated for you and stored privately.',
      'Backups include 1-click apps: the WordPress database is dumped and briefly paused for a consistent copy, restore puts the whole app back, and test-restores check them too.',
      'Docker from the App Store now limits container log sizes so logs cannot fill the disk.',
    ],
  },
  {
    version: '1.7.0',
    date: '2026-11-07',
    items: [
      'Push to deploy: Node Apps → Deploys gives a webhook URL and secret for GitHub or GitLab. Every push to the app\'s branch deploys it; pushes during a deploy wait their turn.',
      'Safer deploys: the new version is built in a separate folder, so a failed build never touches the running app. If the new version does not start, Serverboy puts the previous one back by itself and sends you a message.',
      'Releases and one-click rollback: the last 3 versions are kept with their packages, so going back takes seconds.',
      'Kept between deploys: .env always, plus folders you list (for example uploads), so files your app saves are not lost on a deploy.',
      'Deploy keys for private repositories: Serverboy creates a read-only SSH key for the app; add it to the repository once.',
      'Esc now closes only the top window (closing a task log no longer closes the panel behind it).',
    ],
  },
  {
    version: '1.6.0',
    date: '2026-11-06',
    items: [
      'A new Home page: after logging in you land on Home, with a greeting, a live card for every server (status, CPU, memory, disk, last backup and the main problem) and your unread messages.',
      'Databases: a menu to show Your databases or System & internal. System databases (MongoDB admin / local / config, MySQL mysql / sys / …), Serverboy\'s own team database and test-restore copies are read-only, so nothing critical can be dropped, imported into or edited by accident. Serverboy\'s own database is visible to the owner only.',
      'No cloud storage? Choose to keep backups on the server only ("Don\'t warn me" on the dashboard, or in Backups → Settings) and the warning about it goes away. "Warn me again" brings it back.',
      'Releases: installing or updating now uses the newest published release, and Administration → Settings shows when a new one is out. Go back to an earlier version any time with SERVERBOY_VERSION=v1.5.0.',
      'Fixed: behind Nginx, every visitor looked like the same address, so five wrong passwords from anyone locked everyone out for 5 minutes and the activity log showed 127.0.0.1. Each visitor now has their own lock and real address.',
      'Security: HTTPS is enforced in browsers (HSTS) when Serverboy is opened over HTTPS, and the upload and terminal libraries were updated to fix known denial-of-service issues.',
      'Behind the scenes: automatic tests and checks run on every change, including a full install on a fresh Ubuntu server.',
    ],
  },
  {
    version: '1.5.0',
    date: '2026-11-06',
    items: [
      'Test-restores: Serverboy now proves your backups work. Every week (or month) after a scheduled backup it restores the newest one into temporary databases, from the cloud copy when there is one, checks the data can be read, and deletes them again. Your live data is never touched. Also on demand: Backups → Test a restore.',
      'A failed test-restore turns the dashboard red, sends you a message, and the next scheduled backup is tested again straight away.',
      'Serverboy backup (Administration → Settings): your servers and their logins, all settings and the team in one file encrypted with your passphrase. Download it any time, or let Serverboy copy it to cloud storage every day.',
      'Restore Serverboy from that file (or a cloud copy) on a new install in a few clicks: everything comes back, including SSH logins and backup settings.',
      'Backups now say clearly when MySQL is installed but not running, instead of skipping it.',
    ],
  },
  {
    version: '1.4.0',
    date: '2026-11-06',
    items: [
      'Backups (server menu → Security → Backups, owner only): MongoDB and MySQL databases, website and app folders, and server settings (Nginx, SSL certificates, PM2 list, firewall, crontabs).',
      'Automatic schedule (every 6 h, 12 h, day or week, in your time zone), Back up now, and keep the newest N backups.',
      'Cloud copy to any S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO) or Azure Blob. Keys stay in Serverboy; the server uploads straight to the cloud with short-lived links.',
      'Restore in a few clicks: replace the current data or restore under a new name or folder. A safety copy of the current data is taken first, files are checked before restoring, and backups that are only in the cloud are downloaded first.',
      'Warnings on the dashboard and a message in your inbox when a scheduled backup fails or no backup has run.',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-11-05',
    items: [
      'Log in as (owner only): Administration → Users → Log in as opens a team member\'s account in a new browser tab, so you see exactly what they see. Your own login in your other tabs is not touched.',
      'That tab shows an orange bar on every page ("You are logged in as …") with an Exit button. It ends after 1 hour of no use, or 8 hours at most.',
      'Everything done in that tab is in the Activity log under the member\'s name, marked "done by admin via Log in as". Their password and email cannot be changed from there.',
    ],
  },
  {
    version: '1.2.2',
    date: '2026-10-31',
    items: ['Your photo in the top bar opens your account menu again: My profile, My account & password, Messages, Team, Administration and Settings (owner), All servers and Log out. Esc or a click elsewhere closes it.'],
  },
  {
    version: '1.2.1',
    date: '2026-10-31',
    items: [
      'APIs: if the public address gives 404 while Test works, the API page now says why (for example the domain was already a normal website) and offers Fix it, which points the address at the API. A website on the same domain keeps its pages and gets /api/ added.',
      'Publishing an API on a domain that already has a website now connects it to the API instead of leaving the old website in place.',
    ],
  },
  {
    version: '1.2.0',
    date: '2026-10-31',
    items: [
      'Light and dark theme for the whole app: use the sun/moon button in the top bar (Light, Dark, or Auto to follow your computer). Your choice is remembered.',
      'Dashboard live usage chart fixed: it now fits any screen width instead of stretching, and redraws when the window is resized.',
      'Polish: softer health alerts, cleaner page subtitles, better contrast in dark mode and a tidier sidebar on short screens.',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-10-31',
    items: [
      'A whole new look: light and airy, white rounded cards, forest green and lime, the Inter font and line icons, with a matching dark mode.',
      'New sidebar with a server switcher card, and a top bar with the page title, Search anything (Ctrl/⌘ K), settings, help, messages and your photo.',
      'New dashboard: server status, live resources, a health score, a live usage chart, disks donut, top processes and system details.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-10-31',
    items: [
      'Team and profiles: everyone has a profile with photo, title, contact details, time zone and recent activity. Edit yours under the account menu → My profile.',
      'Messages: the owner can write to one person, several or everyone (normal or important). You get a ✉ count in the top bar, can reply, and can write to the owner.',
      'Websites start in test mode: visitors see "Coming soon" and search engines stay away; share the preview link with your team or client. Only the owner can make a website live.',
    ],
  },
  {
    version: '0.9.1',
    date: '2026-10-31',
    items: [
      'APIs: a clean endpoint table again (method, address, what it does, who can use it), with a Test button on every row that shows the answer right there, and a Code button.',
      'The same endpoint table with Test is in Databases → a collection → APIs (click Endpoints).',
      'Less text on the API pages.',
    ],
  },
  {
    version: '0.9.0',
    date: '2026-10-31',
    items: [
      'Databases → a collection → APIs: the APIs that use this collection, with Try, Docs and + New API. The tree shows how many APIs each collection has.',
      'APIs are listed by database and collection again.',
      'API docs as Swagger (OpenAPI): every API with its options and fields, Try it out right in Serverboy (also before publishing), and openapi.json to download for Postman and other tools.',
    ],
  },
  {
    version: '0.8.0',
    date: '2026-10-31',
    items: [
      'New page: Software → Disk & cleanup. See which folders and files fill the disk, clean caches and old logs safely in one click, and see for each installed app whether it is still used (e.g. "MariaDB: 0 databases").',
      'Remove packages you no longer need, with a preview of exactly what goes and how much space it frees. System packages are protected.',
      'The dashboard shows how much space can be freed and which apps look unused.',
    ],
  },
  {
    version: '0.7.0',
    date: '2026-10-31',
    items: [
      'APIs have their own place (Hosting → APIs) and are no longer part of the Databases page.',
      'Make as many APIs as you like, also several for the same collection, each with its own rules: who may do what, which items, which fields.',
      'New, plain-language API pages: a 3-step "New API" form, a Playground to add, change, view and delete items and see the answers in plain words, and code you can copy.',
      'Existing APIs are converted when you click "Update engine"; their addresses and keys keep working.',
    ],
  },
  {
    version: '0.6.0',
    date: '2026-10-31',
    items: [
      'Databases: import a collection from a JSON, NDJSON or CSV file on your computer.',
      'Databases: a form to create and edit documents, with field types; switch to JSON at any time.',
      'Databases: only the database engines installed on the server are shown.',
      'PM2: stopping and starting the PM2 service works reliably; Serverboy no longer starts PM2 outside its boot service.',
      'Everyone gets a notice to refresh when Serverboy is updated, and the owner can send a message to the team.',
    ],
  },
  {
    version: '0.5.0',
    date: '2026-10-29',
    items: [
      'APIs: custom endpoints (saved queries and forms) and groups, several per collection.',
      'APIs: API portal with a reference for every endpoint, and .txt docs to download for AI assistants.',
      'Health: one-click fix when the PM2 boot service fails.',
    ],
  },
  {
    version: '0.4.0',
    date: '2026-10-28',
    items: ['APIs have their own page (Hosting → APIs) with endpoints, Try it, docs, keys and settings.', 'Per-user access to chosen websites and databases (view or edit).'],
  },
];
