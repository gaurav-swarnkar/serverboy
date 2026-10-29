# Serverboy

A self-hosted web control panel for your Linux server, a little like cPanel + phpMyAdmin + an FTP client, all in the browser.

Give it your server's IP, username and password (or SSH key), and you can:

| Page | What it does |
| --- | --- |
| **Dashboard** | A **health card** that checks essential services, every website (real HTTP check + certificate expiry) and Node apps, explains problems in plain English and offers one-click fixes for known issues. Plus live CPU, memory, disk, uptime and top processes; update all packages, reboot. |
| **Terminal** | A full SSH terminal in the browser, with a **command book**: about 140 everyday commands in 18 sections (services, logs, Nginx, SSL, MongoDB, MariaDB, PM2, Git, Docker, firewall, disk cleanup…), each explained in plain English. Search, fill in values, then Insert or Run. Risky ones ask first, and you can save your own. |
| **File Manager** | Browse, upload (drag & drop), download (folders as `.tar.gz`), edit, rename, delete, chmod/chown, extract `.zip`/`.tar.gz`. Falls back to sudo for root-owned files. |
| **App Store** | One-click installs: Nginx, MongoDB 8.0, MariaDB, Redis, Node.js 22, PM2, PHP-FPM, Docker, Certbot, UFW, Fail2ban, Git. Two "quick stacks" install everything for a Node+MongoDB SaaS or a PHP+MariaDB site. Also search and install any apt package. |
| **Services** | Start / stop / restart / enable / disable systemd services and read their logs. |
| **Websites** | Create Nginx sites (static, single-page app, PHP, or reverse proxy to an app port). Edit config with automatic `nginx -t` rollback. Free Let's Encrypt SSL in one click. |
| **Node Apps** | Deploy a Node.js app from Git (or from uploaded files), set environment variables, run it with PM2, put it on a domain, redeploy with one click, view logs. |
| **Databases** | **MariaDB:** create databases + users, browse tables, run SQL, export (`.sql.gz`) and import. **MongoDB:** browse databases/collections/documents, insert/edit/delete documents, create per-app users (gives you the connection string), and turn on authentication with one click. |
| **Data APIs** | Turn a MongoDB collection into a REST API in a few clicks: choose per endpoint (list / count / get / create / update / replace / delete) whether it is off, public or needs an API key; hide, protect and require fields; manage keys; try requests; get ready-to-paste code. Each collection also has a **Connect** guide for using the database from your backend and web pages. |
| **Firewall** | Manage UFW rules. It always allows your SSH port before turning on, so you can't lock yourself out. |
| **Tasks** | Live logs of every install / deployment. |
| **Administration** | Users, roles & permissions for your team, and an activity log of who did what (stored in MongoDB). Owner only. |

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
   curl -fsSL https://raw.githubusercontent.com/gaurav-swarnkar/serverboy/ccr-af56e66b-azkhkc/scripts/install-on-server.sh | bash
   ```
   (Or run it with `sudo` from any SSH app, such as Termius.) It takes a few minutes. It installs Node.js, runs Serverboy as a `serverboy` systemd service on `127.0.0.1:3000`, puts Nginx in front of it, and gets a free Let's Encrypt certificate.
3. The output ends with your link, like `https://20-115-10-42.sslip.io`, and the admin password. [sslip.io](https://sslip.io) is a free service that turns your IP into a hostname, so no domain is needed.
4. Open the link on your phone and log in. Add the server itself with host `127.0.0.1` and your VM username and password.

**Private repository?** The command above only works if the repository is public. Otherwise, create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with read-only *Contents* access to this repo, and run:
```bash
T=github_pat_XXXX
curl -fsSL -H "Authorization: Bearer $T" https://raw.githubusercontent.com/gaurav-swarnkar/serverboy/ccr-af56e66b-azkhkc/scripts/install-on-server.sh | SERVERBOY_REPO="https://x-access-token:$T@github.com/gaurav-swarnkar/serverboy.git" bash
```

Got a domain later? Point it at the server and run `sudo bash /opt/serverboy/scripts/install-on-server.sh panel.example.com you@example.com`. Run the installer again any time to update Serverboy; your password and saved servers are kept. Change the password under **Settings** in Serverboy. Forgot it? Put a new one in `ADMIN_PASSWORD=` in `/etc/serverboy.env` (`sudo nano /etc/serverboy.env`) and run `sudo systemctl restart serverboy`.

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

## Data APIs (MongoDB collections over HTTPS)

Databases → MongoDB → pick a collection → **API** tab.

1. **Create the API service** (once per database). Serverboy installs a small Node.js service in `/var/www/<name>` (run by PM2, visible under Node Apps), gives it its own MongoDB user that can only access that database, and optionally publishes it on a domain with HTTPS.
2. **Open the collection** with a preset, then set each endpoint to *Off*, *Public* or *API key needed*:

   | Endpoint | |
   | --- | --- |
   | `GET /api/<collection>` | list, with `?field=value`, `?filter={json}`, `?sort=-createdAt`, `?limit=&page=`, `?fields=` |
   | `GET /api/<collection>/count` | count |
   | `GET /api/<collection>/:id` | one document |
   | `POST /api/<collection>` | create |
   | `PATCH /api/<collection>/:id` | update some fields |
   | `PUT /api/<collection>/:id` | replace |
   | `DELETE /api/<collection>/:id` | delete |

3. **Field rules:** *hidden* fields are never returned and cannot be filtered on; *read-only* fields cannot be written; *required* fields must be present on create; optional automatic `createdAt` / `updatedAt`.
4. **API keys** (sent as `x-api-key`) can be read-only or read/write, for all collections or chosen ones. Keys are stored only as hashes and shown once.
5. **Settings:** allowed websites (CORS), rate limit per minute, maximum page size.

Changes apply within about 2 seconds without a restart. JavaScript query operators (`$where`, `$function`) are blocked. The **Try it** box sends real requests from the server, and **How to call it** shows URLs plus `fetch` and `curl` examples for your configuration.

Rule of thumb: make reading public only for data anyone may see, and never put a key that can write into web page code. Call write endpoints from your backend.

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
