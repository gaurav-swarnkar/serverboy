# Serverboy

A self-hosted web control panel for your Linux server, a little like cPanel + phpMyAdmin + an FTP client, all in the browser.

Give it your server's IP, username and password (or SSH key), and you can:

| Page | What it does |
| --- | --- |
| **Dashboard** | Server status, live CPU / memory / disk with a usage chart, a **health score**, a disks donut, top processes and system details. A **health card** that checks essential services, every website (real HTTP check + certificate expiry) and Node apps, explains problems in plain English and offers one-click fixes for known issues. Plus live CPU, memory, disk, uptime and top processes; update all packages, reboot. |
| **Terminal** | A full SSH terminal in the browser, with a **command book**: about 140 everyday commands in 18 sections (services, logs, Nginx, SSL, MongoDB, MariaDB, PM2, Git, Docker, firewall, disk cleanup…), each explained in plain English. Search, fill in values, then Insert or Run. Risky ones ask first, and you can save your own. |
| **File Manager** | Browse, upload (drag & drop), download (folders as `.tar.gz`), edit, rename, delete, chmod/chown, extract `.zip`/`.tar.gz`. Falls back to sudo for root-owned files. |
| **App Store** | One-click installs: Nginx, MongoDB 8.0, MariaDB, Redis, Node.js 22, PM2, PHP-FPM, Docker, Certbot, UFW, Fail2ban, Git. Two "quick stacks" install everything for a Node+MongoDB SaaS or a PHP+MariaDB site. Also search and install any apt package. |
| **Disk & cleanup** | What fills the disk (biggest folders, click to look inside; biggest files), one-click safe cleanup (package cache, unused packages and old kernels, old logs, old snaps, crash reports, npm cache, PM2 logs, unused Docker data), and for every installed app whether it is still used ("Redis: empty", "MariaDB: 2 databases", "Needed by Serverboy") with Uninstall. All installed packages biggest first, with a preview before removing; system packages are protected. |
| **Services** | Start / stop / restart / enable / disable systemd services and read their logs. Starting the PM2 service takes over a PM2 that was started by hand, instead of failing. |
| **Websites** | New websites start in **test mode**: visitors see a "Coming soon" page (with `noindex`), while your team and clients use a **preview link** (it sets a cookie for 30 days). Only the owner can **Make live**; anyone who may edit a site can put it back in test mode. Create Nginx sites (static, single-page app, PHP, or reverse proxy to an app port). Edit config with automatic `nginx -t` rollback. Free Let's Encrypt SSL in one click. |
| **Node Apps** | Deploy a Node.js app from Git (or from uploaded files), set environment variables, run it with PM2, put it on a domain, redeploy with one click, view logs. |
| **Databases** | **MariaDB:** create databases + users, browse tables, run SQL, export (`.sql.gz`) and import. **MongoDB:** browse databases/collections/documents, insert and edit documents with a **form** (field types: text, number, yes/no, date, ObjectId, list, object…) or as JSON, delete documents, **import** a collection from a JSON / NDJSON / CSV file and **export** it as JSON, create per-app users (gives you the connection string), and turn on authentication with one click. |
| **APIs** | Let websites and apps use your MongoDB data over HTTPS. Make as many APIs as you like (several per collection if you want), each with its own rules: who may see, add, change or delete, which items and which fields. Try everything in a playground, copy ready code, download docs for AI assistants. |
| **Firewall** | Manage UFW rules. It always allows your SSH port before turning on, so you can't lock yourself out. |
| **Tasks** | Live logs of every install / deployment. |
| **Team & profiles** | A directory of everyone with a profile page: photo, title, email, phone, location, time zone (with their local time), about, role and access, and recent activity. Everyone edits their own profile; the owner can edit anyone's. |
| **Messages** | The owner writes to one person, several or everyone, normal or important. Members see a ✉ count in the top bar, read, reply, and can write to the owner. The owner sees who has read a message. Stored in the team database. |
| **Administration** | Users, roles & permissions for your team, and an activity log of who did what (stored in MongoDB). Owner only. |

Only the database engines installed on the server are shown (e.g. just MongoDB).

Installers target **Ubuntu 22.04 / 24.04** (Azure's default images) and Debian.

## Quick start (on your own computer)

You need [Node.js 20.12+](https://nodejs.org).

```bash
git clone <this repo> serverboy
cd serverboy
npm install
npm start
```

Open <http://127.0.0.1:3000>. On first start, Serverboy prints a generated admin password in the terminal. Log in, then **Servers → Add server** and enter:

- **IP address**: your Azure VM's *Public IP address* (VM → Overview)
- **Username**: the admin user you chose when creating the VM (e.g. `azureuser`). Azure disables direct `root` login.
- **Password**, or paste the **private key** (`.pem`) Azure gave you. If you use a key *and* sudo asks for a password, enter the password too.

Serverboy connects over SSH, so the server needs nothing extra installed.

## Using it on your phone

The interface works on phones: the menu collapses behind a ☰ button.

**Option A — on your home Wi-Fi (quick test).** Start Serverboy on your computer listening on your network:

```bash
HOST=0.0.0.0 npm start          # Windows PowerShell: $env:HOST="0.0.0.0"; npm start
```

It prints a line like `On your phone (same Wi-Fi), open: http://192.168.1.20:3000`. Open that on your phone. If it doesn't load, allow Node.js through your computer's firewall (Windows asks the first time). This is plain HTTP, so only do it on a network you trust, and stop it afterwards.

**Option B — from anywhere, with HTTPS (recommended).** Install Serverboy on the Azure server itself. This works with **only a phone and no domain**:

1. In the Azure Portal (portal.azure.com in your phone's browser, or the Azure app), open your VM → **Networking** → add inbound port rules for **80** and **443**.
2. Open your VM → **Run command** → **RunShellScript**, paste this, and tap **Run**:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/gaurav-swarnkar/serverboy/HEAD/scripts/install-on-server.sh | bash
   ```
   (Or run it with `sudo` from any SSH app, such as Termius.) It takes a few minutes. It installs Node.js, runs Serverboy as a `serverboy` systemd service on `127.0.0.1:3000`, puts Nginx in front of it, and gets a free Let's Encrypt certificate.
3. The output ends with your link, like `https://20-115-10-42.sslip.io`, and the admin password. [sslip.io](https://sslip.io) is a free service that turns your IP into a hostname, so no domain is needed.
4. Open the link on your phone and log in. Add the server itself with host `127.0.0.1` and your VM username and password.

**Private repository?** The command above only works if the repository is public. Otherwise, create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with read-only *Contents* access to this repo, and run:
```bash
T=github_pat_XXXX
curl -fsSL -H "Authorization: Bearer $T" https://raw.githubusercontent.com/gaurav-swarnkar/serverboy/HEAD/scripts/install-on-server.sh | SERVERBOY_REPO="https://x-access-token:$T@github.com/gaurav-swarnkar/serverboy.git" bash
```

The installer installs the newest **release**. Run the same command again any time to update; your password, servers and data are kept. Administration → Settings → Updates tells you when a new release is out.

- A specific version (for example to go back after a bad update): `curl -fsSL …/install-on-server.sh | sudo SERVERBOY_VERSION=v1.5.0 bash`
- The newest development code instead of a release: `… | sudo SERVERBOY_VERSION=edge bash`

Got a domain later? Point it at the server and run the installer with it: `curl -fsSL …/install-on-server.sh | sudo bash -s panel.example.com you@example.com`. Change the password under **Settings** in Serverboy. Forgot it? Put a new one in `ADMIN_PASSWORD=` in `/etc/serverboy.env` (`sudo nano /etc/serverboy.env`) and run `sudo systemctl restart serverboy`.

## AI connector (MCP)

Manage Serverboy by chatting with Claude or any other AI agent that speaks the Model Context Protocol. Open **AI connector** (menu → Preference) for the address, `https://<your-serverboy>/mcp`.

- **Claude (claude.ai, desktop and mobile apps):** Settings → Connectors → **Add custom connector** → name *Serverboy*, the address above → **Connect**. Serverboy asks you to log in and approve (**Look and manage** or **Only look**). This uses OAuth 2.1 with PKCE; the app gets a 1-hour token that renews itself.
- **Claude Code:** make a token on the AI connector page, then
  `claude mcp add --transport http serverboy https://<your-serverboy>/mcp --header "Authorization: Bearer sbt_…"`
- **Other agents** (Cursor, Windsurf, VS Code…): add an HTTP MCP server with that URL and the `Authorization: Bearer` header.

Tools (26): servers and health; websites (create, make live, HTTPS); databases, collections, find and insert documents; APIs (list, create in a website folder, Diagnose, restart); services and logs; Node apps (restart, redeploy, logs); backups; task status; a shell command (only with the Terminal permission); and `call_api` for any other Serverboy API endpoint.

The AI acts as the person who connected it: same role, same website and database limits. *Only look* tokens can't change anything. Tokens can never manage tokens, passwords or "Log in as". Serverboy's self-protection still applies, and every change is in the activity log marked "(via AI: …)". Tokens are stored hashed; revoke or disconnect them on the AI connector page (the owner sees everyone's). Claude.ai needs Serverboy on **https** (the install command sets that up).

## Tutorials

**Learn → Tutorials** (or the **?** button at the top of any page) explains Serverboy in plain words, chapter by chapter: getting started, dashboard, **websites**, **databases**, **APIs**, Node apps, 1-click apps, files, terminal, software, backups, firewall, alerts, team, and what to do when something breaks. Websites, Databases and APIs are full step-by-step guides; each step has a button that opens the right page on your server. The chapters live in `public/js/tutorials.js`.

## Azure checklist

1. Azure Portal → your VM → **Networking** → make sure inbound port **22** is allowed (ideally only from your own IP).
2. For websites, add inbound rules for **80** and **443**.
3. Point your domain's **A record** to the VM's public IP before requesting SSL.

A port has to be open in **both** the Azure Network Security Group and the server's own firewall (UFW) to be reachable.

## Deploying a SaaS with MongoDB, step by step

1. **App Store → Node.js SaaS (MongoDB)** quick stack. This installs Git, Nginx, Node.js, PM2, MongoDB, Certbot, UFW and Fail2ban.
2. **Firewall** → *Allow SSH*, *Allow HTTP*, *Allow HTTPS*, then *Turn on*.
3. **Databases → MongoDB → Secure MongoDB.** Creates an admin user and turns on authentication.
4. **Databases → MongoDB → Users → New app user** for your app's database. Copy the `MONGODB_URI` it shows.
5. **Node Apps → Deploy app**: your Git URL, branch, the port your app listens on (it gets `PORT` as an env var), build/start commands, `MONGODB_URI=…` and other secrets in *Environment variables*, and your domain.
6. **Websites → Enable SSL** on that domain.
7. After pushing new code, click **Redeploy**.

Private GitHub repo? Use `https://<token>@github.com/you/repo.git` with a fine-grained, read-only token.

Each app lives in `/var/www/<name>`, owned by your SSH user, with its settings in `.serverboy-app.json` and secrets in `.env`.

## Push to deploy (Node apps from git)

Every git app has a **Deploys** button in Node Apps.

- **Safe deploys.** A deploy fetches the branch into a separate folder, installs and builds there, and only then switches the live folder. If the build fails, the running app is not touched. If the new version does not start (PM2 not online, or nothing answering on its port within about 20 seconds), the previous version is put back automatically and you get a message.
- **Push to deploy.** Turn it on to get a webhook URL and secret. Add them in GitHub (Settings → Webhooks, content type `application/json`, push events) or GitLab (Settings → Webhooks, secret token, push events). Pushes to the app's branch deploy it; other branches are ignored; a push during a deploy runs right after it. GitHub deliveries are checked with the HMAC signature, GitLab ones with the token. Serverboy must be reachable from the internet over HTTPS for this.
- **Releases and rollback.** The last 3 versions are kept (with `node_modules`), so **Roll back** takes seconds. A version that failed to start is kept for 7 days to look at.
- **Kept between deploys.** `.env` is always carried over. Add anything your app writes into its own folder (for example `uploads` or `data/app.db`) under *Kept between deploys*.
- **Private repositories.** *Create deploy key* makes an SSH key on the server for this app; add the public key to the repository as a read-only deploy key and use the `git@github.com:owner/repo.git` address.

## Alerts

**Administration → Alerts** sends alerts by **email** (any SMTP account; for Gmail use an app password), **Telegram** (a bot from @BotFather), **Slack**, **Discord** or a **webhook**, and always to the Serverboy inbox. Every channel has a *Send test* button.

Serverboy checks each server every 5 minutes (configurable): websites and Nginx, services, Node apps, disk and memory, whether the server can be reached at all, and HTTPS certificates (every 6 hours, alert under 14 days). Backups, test-restores and deploys report their failures through the same channels.

- A problem alerts only after two checks in a row; you get a **Fixed** message when it clears and a reminder once a day while it lasts.
- Several problems found at once arrive as one grouped message, and problems hidden by a bigger one (server unreachable, Nginx down) are not reported as fixed.
- Serverboy checks from where it runs. If it runs on the same server it watches, also use an outside check (for example Uptime Kuma from *1-click apps* on another machine, or UptimeRobot) for "the whole server is off".

## 1-click apps (Docker)

**Hosting → 1-click apps** installs ready-made apps with Docker: **WordPress** (with its own MariaDB), **n8n** (workflow automation) and **Uptime Kuma** (uptime monitoring). Install Docker from the App Store first.

- Choose a name and an address; Serverboy writes a `docker-compose.yml` in `/opt/serverboy-apps/<name>/`, generates the passwords (in a private `.env`), starts the app, puts it behind Nginx and gets a free HTTPS certificate.
- Containers listen on **127.0.0.1 only**, so Docker cannot open ports past UFW (a common Docker pitfall).
- Start, stop, restart, **Update** (pulls the newest image), logs, and Remove (keeps the data unless you tick delete) from the same page.
- Backups include the app folders. For WordPress the database is dumped and paused during the copy; restore stops the app, puts its folder back and starts it.

## APIs (MongoDB data over HTTPS)

**Where APIs live.** Each website has one **API folder**, named by you, for example `https://shop.com/data-k3x9/` (avoid `/api`: it is the first thing people try). APIs from any of your databases can live in it, and an API's **group** becomes a sub-folder:

```
https://shop.com/data-k3x9/auth/login       database users → collection users
https://shop.com/data-k3x9/auth/register
https://shop.com/data-k3x9/blog/posts       database blog  → collection posts
```

Choose the website and folder when you make the first API of a database (**New API → Where should it live?**), or later under **API server → Settings → Address → Put in a website**. The APIs page shows websites → folder → groups, and **Rename folder** moves every API of a website at once. Serverboy writes the Nginx routes (`/etc/nginx/serverboy/api/<website>.conf`, included by the website) and keeps them up to date when APIs are added, renamed or deleted. The website's own pages are not touched; the folder answers JSON 404 for anything that is not an API. Two APIs can never get the same address. An API server can also stay private, or keep its own address (a sub-domain with `/api/<name>`), as before.

**Several API servers, and moving APIs.** A database can have more than one API server (New API → *API server* → **+ New API server**). An API can move to another API server of the same database: API → Settings → **API server** → Move, or **Move all APIs to…** on the API server. Its settings and the keys that may use it move along (keys for "every API" are narrowed to the moved APIs); in the same website folder the address does not change. Deleting an API server offers to move its APIs first.

A folder copied from an API server (for example a backup restored as `<name>-restored-<date>`) is marked as a copy on the APIs page: it gets no routes and no new APIs, and can be deleted or made separate in one click.

Hosting → **APIs** lists every database, its collections and the APIs of each collection (Try · Docs · settings, and **+ New API for <collection>**). In **Databases → MongoDB**, each collection shows how many APIs use it and has an **APIs** tab with the same links. An API is a named, safe door to one MongoDB collection, at `https://<api-server>/api/<name>`. Make as many as you like, also several for the same collection with different rules, e.g. **Products** (anyone can see) and **Products admin** (apps with a key can add, change and delete).

- **+ New API** asks three things: which data (database and collection, or a new one), what it is for (*Show it on a website*, *Website + my admin app*, *Private, for my own app*, *A form*, or *I'll choose myself*) and its name and address. The first API of a database also sets up that database's **API server** (a small Node.js service in `/var/www/<name>`, run by PM2, with its own MongoDB user limited to that database), optionally on a domain with HTTPS.
- **Endpoints** (first tab): one row per allowed action (method, address, what it does, who can use it) with **Test**, which opens a small form under the row (link options, a real item id, a sample body, send as anyone or with key) and shows the answer, and **Code** (JavaScript and curl). The same table is in Databases → collection → APIs → **Endpoints**.
- **Items:** a live table of the items with **+ Add item**, **View**, **Edit** and **Delete**. Switch **Try as** between *Anyone on the internet* and *An app with a key*. Every answer is explained in plain words, with the request, the answer and the same request as `curl`. An *Advanced* box sends any request.
- **What it can do:**
  - *Who can do what*: for each of see the list, see one item, count, add, change and delete, choose *Nobody*, *Anyone* or *Apps with a key*.
  - *Which items*: all, or only items where e.g. `status is published`. Values can come from the link (`?author=ravi`); such values are typed and only ever used as values, never as commands. Requests by id only reach items the API shows.
  - *Fields*: show or hide each field, whether callers may fill it in, required when adding, or *always set to* a value. Tick *ignore unticked fields* for public forms.
  - *Order and page size*, and the name, address, folder and description.
- **⬇ .txt** (in the API header, and **Docs for AI** on the APIs page): a plain-text reference to paste into an AI assistant, a README or a message.
- **API docs (Swagger):** an OpenAPI 3 description of every API (actions, link values, fields from your data, which actions need a key), shown with Swagger UI. **Try it out** runs through Serverboy, so it works before the API is published, with exactly the same rules; click **Authorize** to send a key. **⬇ openapi.json** imports into Postman, Insomnia or code generators.
- **Keys:** a key can be limited to one API (see, add, change, delete) or cover every API of its API server. Keys are stored only as hashes and shown once; apps send them in `x-api-key`.
- **API server** (APIs page → *API servers* → Manage): its address (publish on a domain), allowed websites (CORS), rate limit, maximum page size, engine update, logs, delete.
- **🩺 Diagnose** (in the header of an API and of an API server): checks step by step whether the settings exist, the setup finished, the process runs, the database answers, the engine is current and has the latest settings, the API exists, its collection has data, a real request works and the public address reaches it. It stops at the first blocking problem, explains it in plain words and offers the next step as a button (Finish setup, Restart, Logs, Update engine, Move to a free port, Fix the address, Publish). If another app answers on the API server's port (the API shows *not running* and tests get 404 "There is no API called …"), Diagnose names that app and moves this API server to a free port. A copied API server folder (it still carries the original's name, port and address) is spotted too: **Make it independent** gives it its own name, port, database login and PM2 entry. Tests that get no answer, an error or "no such API" offer Diagnose too, and a failed API setup says at which step it stopped, with **Try again** (it continues where it stopped).

Changes apply without a restart: saving waits until the API server has loaded them (instantly with engine v4, about 2 seconds with older engines). JavaScript query operators (`$where`, `$function`) are blocked.

**Upgrading from an older version:** APIs made before 0.7 show *"runs an older API engine"*. Click **Update engine** once: each collection's endpoints become an API at the same address, each custom endpoint becomes its own API (old `/api/<collection>/views/<name>` addresses keep working), and keys keep their access. A backup of the old settings is kept as `api.config.json.bak-v2`.

Rule of thumb: let *anyone* see only data anyone may see, and never put a key that can change data into web page code. Call those actions from your backend.

## Team accounts and permissions

You (the **owner**) log in as `admin`. Your login is stored in `data/config.json` (or `/etc/serverboy.env` on a server install), **not** in MongoDB, so you can always get in, even when MongoDB is down.

Team members, their permissions and the activity log live in a `serverboy` database in MongoDB:

1. Databases → MongoDB → **Connection settings**: save your MongoDB admin login (needed once, for setup).
2. Account menu (top right) → **Administration** → **Users** → **Create the serverboy database**. This creates the database and a `serverboy_app` MongoDB user that can only access that database. You can paste your own connection string instead.
3. **+ Add user**: pick a username and a **role**, then share the login details it shows you.
4. **Roles & permissions**: tick what each role can do. Changing a role updates everyone who has it at once. Pick **Custom** on a user to give just that person their own set.

| Permission | Allows |
| --- | --- |
| Databases | MariaDB / MongoDB databases, users, queries, import / export |
| Websites | Create sites, SSL, enable / disable, delete (raw Nginx config editing stays owner-only) |
| Website files | File manager inside `/var/www` only, with no admin rights; Node app folders need *Node apps* |
| Services | Service logs, start / stop / restart |
| Node apps ⚠ | Deploy and manage Node.js apps |
| Terminal ⚠ | Shell on the server |
| System ⚠ | App Store, packages, firewall, updates, reboot, killing processes |

Serverboy starts with two roles you can edit: **Developer** (Databases, Websites, Website files, Services) and **Viewer** (look only). Everyone can see the dashboard, the service list and task logs. Adding servers and Administration are always owner-only.

⚠ *Node apps*, *Terminal* and *System* run commands as the server's SSH user (who can use sudo), so they are effectively full server access. Only give them to people you would give the server password to.

**Access to specific websites and databases.** In a user's dialog, under **Access**, choose *All websites* or *Only the ones I choose*, then give each website **View** or **Edit**. Do the same for databases. A user limited this way:

- sees only those websites, their files (in the file manager and on the dashboard) and those databases; everything else is invisible;
- with **View** can browse, read and download; with **Edit** can also change files, documents, collections, SSL and on/off, and that database's API;
- cannot create or delete whole websites or databases, or use the MariaDB SQL console (it runs as the database root user and could reach other databases). They get a table browser instead.

Access only narrows what the role allows: without the *Databases* permission, picking databases gives nothing.

**After you update Serverboy**, everyone who has it open on an older version sees *"Serverboy was updated"* with **What's new** (from `lib/changelog.js`) and a **Refresh now** button, within about 2 minutes. Logins survive updates. Under **Administration → Settings → Updates and team message** you can see who still runs an older version, and send a message to the team: either only to people on an older version (next to the refresh notice) or to everyone.

Permission changes, disabling and deleting a user take effect immediately (their sessions end). The activity log records logins, every change and every download (who, when, from which IP, and whether it was allowed) and keeps entries for 90 days. Passwords and file contents are never logged.

## Configuration

Copy `.env.example` to `.env` (it is loaded automatically by `npm start`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interface to listen on. Keep the default unless you put Serverboy behind HTTPS. |
| `PORT` | `3000` | Port for the web UI. |
| `ADMIN_PASSWORD` | *(generated)* | Initial admin password. You can still change it under Settings; changing this value later resets the password to it. |
| `SERVERBOY_SECRET` | *(generated)* | Key used to encrypt saved server credentials. |
| `DATA_DIR` | `./data` | Where config and saved servers are stored. |
| `SERVERBOY_MONGO_URI` | *(set in Administration)* | MongoDB connection string for team accounts; overrides the one saved in Administration → Settings. |
| `TRUST_PROXY` | *(off)* | Set to `1` when running behind Nginx so the real client IP is used. |

## Security notes

Serverboy holds the keys to your server, so treat it like one:

- By default it **only listens on 127.0.0.1**, so only your own computer can reach it.
- Saved passwords, keys and database URIs are encrypted (AES-256-GCM) in `data/servers.json`. The encryption key is in `data/config.json` (or `SERVERBOY_SECRET`), so protect the `data/` folder.
- The server's SSH host key is pinned on first connection; Serverboy refuses to connect if it changes (a sign of a man-in-the-middle attack, or a rebuilt server: use *Edit → Reset host key* in that case).
- Login is rate-limited, sessions use HttpOnly SameSite cookies, and every state-changing request needs a custom header (CSRF protection).
- Prefer SSH keys over passwords, keep port 22 restricted to your IP in Azure, and install Fail2ban.

### Running Serverboy on the server itself

If you'd rather reach Serverboy from anywhere, run it **on the server** and put it behind HTTPS:

1. Use **Node Apps** (or SSH) to run Serverboy on the server, listening on `127.0.0.1:3000`, with a strong `ADMIN_PASSWORD` and `TRUST_PROXY=1`.
2. **Websites → Add website**, type *Reverse proxy*, port `3000`, e.g. `panel.example.com`.
3. **Enable SSL** for it.

Never expose it over plain HTTP. Add the server to itself with host `127.0.0.1`.

**Serverboy protects itself.** On the machine it runs on (recognised by `/etc/machine-id`), Serverboy refuses actions that would take it offline:

- **Websites:** the site that serves Serverboy's address is marked *🛡 Serverboy itself* and cannot be deleted, disabled, put in test mode or edited (Enable SSL still works). No other website, API or 1-click app can take over its address.
- **File Manager:** Serverboy's program folder, its data folder, `/etc/serverboy.env`, its systemd service, the Node.js program, its Nginx site files and its HTTPS certificate cannot be deleted, moved, overwritten or re-permissioned. Neither can a folder that contains them, such as `/opt`.
- **Services and processes:** Serverboy and Nginx cannot be stopped or disabled (Restart works). Their processes cannot be killed.
- **Software:** Node.js, Nginx and certbot cannot be uninstalled, also not by removing a package that would take them along.
- **Firewall:** ports 80 and 443 cannot be blocked, and the last rule that opens them cannot be deleted. Turning the firewall on also opens them.

On **every** server, the SSH service and the last firewall rule for the SSH port are protected the same way, because Serverboy works over SSH. The **Terminal** is not limited: it is a full shell on purpose. If something does break, run the install command again on the server (Azure portal → Run command, or SSH): it repairs Serverboy and keeps your data.

## Development, tests and releases

```bash
npm install
npm run dev          # start with auto-reload
npm run check        # syntax check of every JS file (server and browser)
npm test             # unit tests, API tests (starts a throwaway Serverboy)
TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm test   # also the Data API engine against MongoDB
```

Tests use Node's built-in test runner (no extra dependencies) and live in `test/`. Every push and pull request runs **GitHub Actions** (`.github/workflows/ci.yml`):

1. syntax check and all tests on Node 20, 22 and 24, with a real MongoDB;
2. `npm audit` of the production dependencies;
3. a full install on a fresh Ubuntu 24.04 machine with the real installer, a login check, and a second run to prove updates keep the data.

**Releasing a version**

1. Add an entry for the new version at the top of `lib/changelog.js` (plain words; it is shown to your team as "What's new" and becomes the release notes). Commit it.
2. Run `npm run release -- 1.6.0`. It checks everything, sets the version, runs the tests, commits and tags `v1.6.0`.
3. Push: `git push origin <branch> && git push origin v1.6.0` (or use `npm run release -- 1.6.0 --push`).

If you cannot push tags, open GitHub → **Actions → Release → Run workflow**, choose the branch and enter the version (for example `v1.6.0`); it creates the tag for you.

Pushing the tag (or running it by hand) starts `.github/workflows/release.yml`: it checks the tag matches `package.json`, runs the tests again, and publishes the GitHub release with notes and a source archive. Installs and the Updates card pick it up automatically. A test (`test/unit/release.test.js`) fails if `package.json` and the changelog disagree.

## Project layout

```
server.js            HTTP server, routing, security headers
lib/ssh.js           SSH connection pool, sudo handling, SFTP helpers
lib/store.js         Encrypted storage for servers + admin password
lib/auth.js          Login sessions (owner + team), CSRF guard
lib/team.js          Team accounts + activity log in MongoDB
lib/permissions.js   Permission list and which routes need which permission
lib/jobs.js          Background tasks with live logs
lib/catalog.js       One-click installer definitions (add new apps here)
lib/nginx.js         Nginx site templates
lib/terminal.js      WebSocket ⇄ SSH shell bridge
routes/*.js          REST API (system, health, files, databases, dataapi, sites, nodeapps, team)
templates/data-api/  The Data API service deployed for each database
lib/health.js        Dashboard health checks, diagnosis rules and fixes
public/              Frontend (vanilla JS modules, no build step)
```

Adding a new one-click app is just a new entry in `lib/catalog.js` with `check`, `install` and (optionally) `uninstall` shell snippets.

## Roadmap ideas

- Scheduled database backups (to disk or Azure Blob Storage)
- Cron job manager
- Docker containers / compose page
- Per-server access for team members
- Run team actions as a separate low-privilege Linux user, so *Node apps* no longer means full access
- Uptime alerts by email
- Python / PHP app deploys
