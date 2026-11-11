// Tutorial chapters (Learn → Tutorials). Plain data, written for people new to servers.
//   [[sites|Open Websites]]  becomes a button to that page (on the server you last used)
//   steps: numbered instructions; tip / warn: a note; faq: [question, answer] pairs.
// Websites, Databases and APIs are full step-by-step guides; the rest are the basics for now.

export const CHAPTERS = [
  {
    id: 'start',
    icon: 'sparkle',
    title: 'Getting started',
    minutes: 3,
    summary: 'What Serverboy is, and finding your way around.',
    sections: [
      {
        p: 'Serverboy is a control panel for your own server (for example an Azure virtual machine). Instead of typing commands, you click: host websites, keep databases, make APIs, install software, take backups and get alerts.',
      },
      {
        h: 'Finding your way around',
        steps: [
          '<b>Home</b> lists your servers. Click one to work on it.',
          'The menu on the left shows what you can do on that server: <b>Websites</b>, <b>Databases</b>, <b>APIs</b>, <b>Backups</b> and more.',
          'The search box at the top (or <kbd>Ctrl</kbd>+<kbd>K</kbd>) jumps to any page.',
          'The <b>?</b> button at the top opens the tutorial for the page you are on.',
        ],
      },
      {
        h: 'Adding a server',
        steps: ['On <b>Home</b>, click <b>+ Add server</b>.', 'Enter its address (IP), the SSH user (on Azure usually <span class="mono">azureuser</span>) and its password or SSH key.', 'Click <b>Test</b> to check the connection, then save.'],
        tip: 'If Serverboy runs on the same server, use the address <span class="mono">127.0.0.1</span>.',
      },
      { h: 'A good order to learn in', p: 'Websites → Databases → APIs. Each chapter builds on the one before.', link: 'servers|Open Home' },
    ],
  },
  {
    id: 'dashboard',
    icon: 'home',
    title: 'Dashboard and health',
    minutes: 2,
    summary: 'See at a glance whether your server is fine.',
    view: 'dashboard',
    sections: [
      { p: 'The Dashboard shows how busy the server is (CPU, memory, disk) and a list of problems Serverboy found, such as a website that is down, a full disk or a stopped service.' },
      {
        h: 'Using it',
        steps: ['Open the server and look at the <b>health card</b> at the top.', 'Each problem says what is wrong in plain words. Many have a <b>Fix</b> button.', 'A warning you know about and accept? Click <b>Ignore</b> (for 7 days, 30 days or always). It leaves the count and the alerts; bring it back under "ignored warnings".', 'Green everywhere means nothing needs your attention.'],
        link: 'dashboard|Open the Dashboard',
      },
    ],
  },
  {
    id: 'websites',
    icon: 'globe',
    title: 'Websites',
    minutes: 10,
    detailed: true,
    summary: 'Put a website online with your own domain and free HTTPS, step by step.',
    view: 'sites',
    sections: [
      {
        h: 'How it works',
        p: 'A website is a domain name (like <span class="mono">myshop.com</span>) that shows something: your HTML files, a WordPress (PHP) site, a React app, or a Node.js app. Serverboy sets up <b>Nginx</b>, the program that answers visitors, for you.',
        list: [
          '<b>Test mode</b>: every new website starts hidden. Visitors see "Coming soon"; you and the people you send the <b>preview link</b> see the real site.',
          '<b>Live</b>: everyone sees it. Only the owner can make a website live.',
          '<b>HTTPS</b>: the padlock in the browser. Serverboy gets a free certificate and renews it automatically.',
        ],
      },
      {
        h: 'Before you start',
        list: [
          'A <b>domain</b>. No domain yet? Use a free address: <span class="mono">mysite.172-198-68-241.sslip.io</span> (your server\'s IP with dashes) works without buying anything.',
          'Ports <b>80 and 443 open</b> in Azure (Virtual machine → Networking → Add inbound port rule). Without them nobody can reach your websites.',
        ],
      },
      {
        h: 'Step by step: your first website',
        steps: [
          '<b>Point the domain to your server.</b> At the company where you bought the domain (GoDaddy, Namecheap, Cloudflare…), add an <b>A record</b>: name <span class="mono">@</span>, value = your server\'s IP. Add the same for <span class="mono">www</span>. It can take a few minutes to work. (Skip this with an sslip.io address.)',
          '<b>Open Websites</b> and click <b>+ Add website</b>. [[sites|Open Websites]]',
          '<b>Fill in the form.</b> Domain: <span class="mono">myshop.com</span>. Keep "Also serve www" ticked. Type: <b>Static website</b> for plain HTML/CSS/JS files. Leave "Document root" empty: Serverboy uses <span class="mono">/var/www/myshop.com/public_html</span>. Click <b>Create website</b>.',
          '<b>Your website is in test mode.</b> Click <b>Preview</b> to see it (a placeholder page for now), or <b>⧉ Link</b> to copy the preview link for someone else.',
          '<b>Upload your files.</b> Click <b>Files</b> on the website\'s row. The File Manager opens in its folder. Click <b>Upload</b> and choose your files; <span class="mono">index.html</span> is the home page. Tip: upload a <span class="mono">.zip</span> and click <b>Extract</b> to upload many files at once.',
          '<b>Check it.</b> Click <b>Preview</b> again: you should see your own page.',
          '<b>Make it live.</b> Click <b>Make live</b>. Now everyone can visit it.',
          '<b>Turn on HTTPS.</b> Click <b>Enable SSL</b>, enter your email (for renewal notices) and confirm. After about a minute the row shows <b>https</b>.',
        ],
        tip: 'Done! Visit <span class="mono">https://myshop.com</span>. To change the site later, upload new files the same way.',
      },
      {
        h: 'Other kinds of websites',
        list: [
          '<b>Single-page app</b> (React, Vue, Angular): build it on your computer (<span class="mono">npm run build</span>) and upload what is <i>inside</i> the <span class="mono">dist</span> or <span class="mono">build</span> folder.',
          '<b>PHP website</b> (WordPress, Laravel): install <b>PHP</b> in the App Store first, then choose type <b>PHP website</b>. For WordPress, <b>1-click apps</b> is even easier.',
          '<b>Reverse proxy</b>: shows an app that runs on a port, like a Node.js app on 3000. Easier: <b>Node Apps</b> creates this for you.',
        ],
      },
      {
        h: 'Everyday tasks',
        list: [
          '<b>Disable</b> takes a website offline without deleting it; <b>Enable</b> brings it back.',
          '<b>Test mode</b> hides a live website again (for example while you redo it).',
          '<b>Config</b> shows the Nginx settings (only the owner can change them; mistakes are rolled back automatically).',
          '<b>Delete</b> removes the website. You choose whether its files are deleted too.',
          'The website that serves Serverboy itself is marked <b>🛡 Serverboy itself</b> and cannot be deleted or switched off, so you cannot lock yourself out.',
        ],
      },
      {
        h: 'Common problems',
        faq: [
          ['"This site can\'t be reached"', 'The domain does not point to your server yet (check the A record and wait a few minutes), or ports 80/443 are closed in Azure.'],
          ['Visitors see "Coming soon"', 'The website is still in test mode. Click <b>Make live</b>.'],
          ['Enable SSL failed', 'Let\'s Encrypt must reach your server on port 80 using the domain. Check the A record and that port 80 is open, then try again.'],
          ['404 Not Found', 'There is no <span class="mono">index.html</span> in the website\'s folder, or the files are one folder too deep (for example inside <span class="mono">public_html/mysite/</span>). Move them up.'],
          ['I changed a file but see the old page', 'Your browser keeps a copy. Reload with <kbd>Ctrl</kbd>+<kbd>F5</kbd> (or <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>).'],
        ],
      },
    ],
  },
  {
    id: 'databases',
    icon: 'database',
    title: 'Databases',
    minutes: 10,
    detailed: true,
    summary: 'Create a database, add data, import files and connect your app, step by step.',
    view: 'databases',
    sections: [
      {
        h: 'How it works',
        p: 'A database keeps your app\'s data: users, products, orders, posts. Serverboy works with two kinds:',
        list: [
          '<b>MongoDB</b>: data is stored as <b>documents</b> (like JSON) in <b>collections</b>. A database has several collections, for example <span class="mono">users</span> and <span class="mono">orders</span>. Most modern Node.js apps use it, and it is what <b>APIs</b> are built on.',
          '<b>MariaDB / MySQL</b>: data is stored in <b>tables</b> with rows and columns. WordPress, Laravel and many PHP apps use it.',
        ],
      },
      {
        h: 'Before you start',
        steps: ['Open the <b>App Store</b> and install <b>MongoDB</b> (or <b>MariaDB</b>) if it is not installed yet. It takes a minute or two. [[apps|Open the App Store]]'],
      },
      {
        h: 'Step by step: a MongoDB database',
        steps: [
          '<b>Open Databases</b> and choose the <b>MongoDB</b> tab. [[databases|Open Databases]]',
          '<b>Secure it first.</b> If you see "Authentication is off", click <b>Secure MongoDB</b>. Serverboy turns on logins and keeps its own admin login safe. Do this before you store real data.',
          '<b>Create the database.</b> Click <b>+ New</b>. Enter a database name (<span class="mono">myshop</span>) and its first collection (<span class="mono">products</span>). Click <b>Create</b>.',
          '<b>Open the collection.</b> In the list on the left, click the database, then the collection. The <b>Documents</b> tab shows what is inside.',
          '<b>Add an item.</b> Click <b>+ Insert document</b> and type it as JSON, for example <span class="mono">{"name": "Green tea", "price": 4.5}</span>. Click save. MongoDB gives every item an <span class="mono">_id</span> by itself.',
          '<b>Change or delete items</b> with <b>Edit</b> and <b>Delete</b> on each document.',
          '<b>Import many items at once.</b> Click <b>⬆ Import</b>, choose a <span class="mono">.json</span> or <span class="mono">.csv</span> file (for example exported from Excel), check the preview and click <b>Import</b>.',
          '<b>Add more collections</b> with <b>+ Collection</b> under the database.',
        ],
      },
      {
        h: 'Connect your app',
        steps: [
          'Open the collection and choose the <b>Connect</b> tab.',
          'Copy the connection string (<span class="mono">mongodb://…</span>) into your app\'s settings, usually an environment variable such as <span class="mono">MONGODB_URI</span> in the app\'s <span class="mono">.env</span> file.',
          'Websites in the browser should not talk to the database directly. Give them an <b>API</b> instead (next chapter).',
        ],
        link: 'learn:apis|Next: APIs',
      },
      {
        h: 'Step by step: a MariaDB / MySQL database',
        steps: [
          'Open <b>Databases</b> and choose the <b>MariaDB / MySQL</b> tab.',
          'Click <b>+ New database</b>. Enter a name (<span class="mono">myshop</span>). To give an app its own login, also fill in a user name; a strong password is generated for you.',
          'Click <b>Create</b>. Serverboy shows the settings for your app (<span class="mono">DB_HOST</span>, <span class="mono">DB_NAME</span>, <span class="mono">DB_USER</span>, <span class="mono">DB_PASSWORD</span>). <b>Copy them now</b>: the password is shown only once.',
          'Use <b>Tables</b> to look inside, <b>Import</b> to load a <span class="mono">.sql</span> file (for example a WordPress export) and <b>Users</b> to manage logins.',
        ],
      },
      {
        h: 'Staying safe',
        list: [
          '<b>Drop</b> deletes a database or collection with all its data, for good. Take a backup first (Backups → Back up now).',
          'Databases that belong to MongoDB, MySQL or Serverboy itself are listed under "System & internal" and are read-only, so they cannot be broken by accident.',
          'Turn on automatic <b>Backups</b> before your app goes live.',
        ],
      },
      {
        h: 'Common problems',
        faq: [
          ['"MongoDB needs a login"', 'MongoDB has logins turned on but Serverboy does not know the admin login. Click <b>Connection settings</b> and enter it.'],
          ['My app cannot connect', 'Check the connection string: user, password and database name must match. Apps on the same server use <span class="mono">127.0.0.1</span> as the host.'],
          ['Import shows the wrong columns', 'For CSV, the first line must hold the column names. Check the preview before you click Import.'],
        ],
      },
    ],
  },
  {
    id: 'apis',
    icon: 'plug',
    title: 'APIs',
    minutes: 12,
    detailed: true,
    summary: 'Let your website or app use your data over the internet, safely, step by step.',
    view: 'apis',
    sections: [
      {
        h: 'How it works',
        p: 'An <b>API</b> is a safe door to one MongoDB collection. Your website or mobile app calls an address, and gets data back (or adds data), following rules you set. Nobody gets the database password.',
        list: [
          '<b>API folder</b>: every website has one folder where its APIs live, for example <span class="mono">https://myshop.com/data-k3x9/</span>. Choose a name that is hard to guess: <span class="mono">/api</span> is the first thing people try.',
          '<b>Group</b>: a sub-folder that keeps related APIs together, for example <span class="mono">…/auth/login</span> and <span class="mono">…/auth/register</span>, or <span class="mono">…/blog/posts</span>.',
          '<b>Public or key</b>: each action (see the list, see one item, count, add, change, delete) is either off, open to anyone, or only for apps with an <b>API key</b>.',
          '<b>API server</b>: a small program Serverboy runs in the background for each database. You don\'t have to manage it; it is set up with your first API.',
        ],
        code: 'https://myshop.com/data-k3x9/blog/posts\n        website   API folder  group  API',
      },
      {
        h: 'Before you start',
        list: ['A MongoDB database with a collection (see <b>Databases</b>).', 'A website (see <b>Websites</b>). Its address becomes the address of your APIs. You can also start without one and add it later.'],
      },
      {
        h: 'Step by step: your first API',
        steps: [
          '<b>Open APIs</b> and click <b>+ New API</b>. (Or: Databases → open a collection → <b>APIs</b> tab → <b>+ New API</b>.) [[apis|Open APIs]]',
          '<b>1. Which data?</b> Choose the database and the collection, for example <span class="mono">myshop</span> → <span class="mono">products</span>. Serverboy shows the fields it finds.',
          '<b>2. What is it for?</b> Pick a starting point. <b>Website + my admin app</b> (popular): anyone can see items, only apps with a key can add, change or delete. <b>Show it on a website</b>: read-only for everyone. <b>A form</b>: anyone can add (contact or sign-up forms) but nobody can read them. You can change all of this later.',
          '<b>3. Name and address.</b> Name: <span class="mono">Products</span>. Group (optional): <span class="mono">shop</span>. Address name: filled in for you (<span class="mono">products</span>).',
          '<b>Where should it live?</b> Choose <b>In a website\'s API folder</b>, pick your website and a folder name (a random one like <span class="mono">data-k3x9</span> is suggested). If the website already has an API folder, that one is used. The full address appears below, for example <span class="mono">https://myshop.com/data-k3x9/shop/products</span>.',
          '<b>Click Create API.</b> The first API of a database also sets up its API server: a window shows the progress (about a minute). Then the API opens.',
          '<b>Try it.</b> On the <b>Items</b> tab you see the items as the internet would. Switch <b>Try as</b> between "Anyone on the internet" and "An app with a key", add an item with <b>+ Add item</b>, or edit one. Every answer is explained in plain words.',
          '<b>Get the code.</b> On the <b>Endpoints</b> tab, each action has <b>Test</b> and <b>Code</b> (JavaScript and curl, with your real address). Copy it into your website.',
        ],
        tip: 'Done! Open the address in your browser: you see your products as JSON.',
      },
      {
        h: 'Use it on your website',
        p: 'Put this in your website\'s JavaScript (use your own address):',
        code: "fetch('https://myshop.com/data-k3x9/shop/products?limit=20')\n  .then((r) => r.json())\n  .then(({ data }) => {\n    // data is a list of products\n    console.log(data);\n  });",
        tip: 'Add <span class="mono">?limit=10&page=2</span> for pages, <span class="mono">?sort=-price</span> to sort, and <span class="mono">/count</span> to count items. The Endpoints tab lists every option.',
      },
      {
        h: 'API keys (for adding, changing and deleting)',
        steps: [
          'Open the API and choose the <b>Keys</b> tab. Click <b>+ New key</b>.',
          'Give it a name (<span class="mono">admin app</span>) and tick what it may do: See items, Add, Change, Delete.',
          'Click <b>Create key</b> and <b>copy it now</b>: it is shown only once.',
          'Your app sends it in the <span class="mono">x-api-key</span> header. Keep keys that can change data in your server code or <span class="mono">.env</span>, <b>never in web page code</b> where visitors could read it.',
        ],
      },
      {
        h: 'Keeping things organised',
        list: [
          '<b>Groups</b>: give related APIs the same group (<span class="mono">auth</span>, <span class="mono">blog</span>, <span class="mono">shop</span>). On the APIs page they appear together under their sub-folder.',
          '<b>Several databases, one website</b>: APIs from different databases can share a website\'s API folder. Serverboy makes sure no two APIs get the same address.',
          '<b>Rename the folder</b>: APIs page → your website → <b>Rename folder</b>. Every API moves at once (update your website\'s code afterwards).',
          '<b>Move an API server</b>: open it (click its database name) → <b>Settings</b> → <b>Address</b> → <b>Put in a website</b>, <b>Move to another website</b> or <b>Take out of the website</b>.',
          '<b>Several API servers</b>: when you make an API, choose its <b>API server</b>, or <b>+ New API server</b> to start another one for the same database (for example one per project or website).',
          '<b>Move an API to another API server</b>: open the API → <b>Settings</b> → <b>API server</b> → choose one → <b>Move</b>. Its settings and keys move with it; in the same website folder its address does not change. <b>Move all APIs to…</b> on an API server moves all of them at once.',
          '<b>Deleting an API server</b> first offers to move its APIs to another one, so nothing is lost.',
        ],
      },
      {
        h: 'Fine-tuning an API (Settings tab)',
        list: [
          '<b>What it can do</b>: switch each action off, public or key-only.',
          '<b>Hidden fields</b> are never returned (passwords, internal notes). <b>Read-only fields</b> can be seen but not changed. <b>Required fields</b> must be filled in when adding.',
          '<b>Which items</b>: a filter, for example only <span class="mono">status = published</span>, and values callers can put in the address.',
          'Changes are live within a second.',
        ],
      },
      {
        h: 'Docs for your team',
        list: ['<b>📖 Swagger</b>: interactive documentation; developers can try every API there.', '<b>⬇ .txt / Docs for AI</b>: a plain-text description to paste into ChatGPT, Claude or a README.'],
      },
      {
        h: 'When something does not work: Diagnose',
        steps: [
          'Open the API and click <b>🩺 Diagnose</b>.',
          'Serverboy checks everything in order: settings, setup, the API server, the database, the API, its data, a real request and the website address.',
          'It stops at the first problem, explains it, and offers the next step as a button: <b>Finish setup</b>, <b>Restart it</b>, <b>Make it independent</b>, <b>Update the website routes</b>…',
        ],
        faq: [
          ['404 "There is no API called …"', 'The request reached a different API server. Click <b>Diagnose</b>: it usually offers <b>Move to a free port</b> or <b>Make it independent</b>.'],
          ['The API server is "not running" or "errored"', 'Click <b>Diagnose</b>. Most often <b>Finish setup</b> or <b>Restart it</b> fixes it.'],
          ['A yellow note says an API server is "a copy"', 'A backup was restored as a copy (its name ends in <span class="mono">-restored-…</span>). It is not used. Click <b>Delete this copy</b>, unless you really want a second API server.'],
          ['The address shows "Coming soon"', 'The website is in test mode, and its API folder is hidden with it. Make the website live (Websites → Make live).'],
          ['401 or 403', '401: this action needs an API key. 403: the key is not allowed to do it (Keys tab).'],
          ['429', 'Too many requests in a minute. Change the limit in API server → Settings.'],
        ],
      },
    ],
  },
  {
    id: 'nodeapps',
    icon: 'hexagon',
    title: 'Node apps and push to deploy',
    minutes: 3,
    summary: 'Run a Node.js app and update it with a git push.',
    view: 'nodeapps',
    sections: [
      { p: 'Node Apps runs your Node.js app (Express, Next.js, NestJS…) in the background with PM2, restarts it if it crashes, and gives it an address.' },
      {
        h: 'The basics',
        steps: ['Install <b>Node.js</b> and <b>PM2</b> from the App Store.', 'Open <b>Node Apps</b> → <b>+ Deploy app</b>: a name, your git repository and the port your app listens on.', 'Serverboy downloads, installs and starts it. <b>Logs</b> shows what it prints.', 'Under <b>Deploys</b>, add the webhook to GitHub or GitLab: every push deploys the new version. A broken build never replaces the running one, and <b>Rollback</b> goes back in one click.'],
        link: 'nodeapps|Open Node Apps',
      },
    ],
  },
  {
    id: 'oneclick',
    icon: 'grid',
    title: '1-click apps',
    minutes: 2,
    summary: 'WordPress, n8n and Uptime Kuma in one click.',
    view: 'oneclick',
    sections: [
      { p: 'Ready-made apps that run in Docker, each on its own address with HTTPS. Passwords are generated for you, and backups include them.' },
      { h: 'The basics', steps: ['Open <b>1-click apps</b> and choose an app.', 'Enter the address (a domain or a free sslip.io address) and click <b>Install</b>.', 'Start, stop, update, see logs or remove it from the same page.'], link: 'oneclick|Open 1-click apps' },
    ],
  },
  {
    id: 'files',
    icon: 'folder',
    title: 'File Manager',
    minutes: 2,
    summary: 'Upload, edit and organise files, like an FTP program.',
    view: 'files',
    sections: [
      { p: 'Browse the server\'s folders, upload and download files, edit text files, and extract zip files.' },
      { h: 'The basics', steps: ['Websites live in <span class="mono">/var/www/&lt;domain&gt;/public_html</span>.', 'Drag files onto the page or click <b>Upload</b>. Upload a <span class="mono">.zip</span> and click <b>Extract</b> for many files.', 'Click a text file to edit it, then save.'], warn: 'Deleting is permanent. Serverboy\'s own files are protected, but your website files are not: take a backup first.', link: 'files|Open the File Manager' },
    ],
  },
  {
    id: 'terminal',
    icon: 'terminal',
    title: 'Terminal and the command book',
    minutes: 2,
    summary: 'Run commands, with plain-English explanations.',
    view: 'terminal',
    sections: [
      { p: 'A command line on your server, in the browser. The <b>command book</b> next to it explains about 140 everyday commands and can paste them for you.' },
      { h: 'The basics', steps: ['Open <b>Terminal</b>.', 'Look up a task in the command book (for example "disk space"), read what it does, and click it to paste it.', 'Press <kbd>Enter</kbd> to run it.'], warn: 'The Terminal can do anything, including breaking things. If unsure, use the pages in Serverboy instead.', link: 'terminal|Open the Terminal' },
    ],
  },
  {
    id: 'software',
    icon: 'package',
    title: 'App Store, Services and Disk',
    minutes: 3,
    summary: 'Install software, start and stop it, and keep the disk tidy.',
    view: 'apps',
    sections: [
      {
        list: [
          '<b>App Store</b>: install Nginx, MongoDB, MariaDB, Node.js, PM2, PHP, Docker, certbot and more in one click.',
          '<b>Services</b>: the programs running in the background. Start, stop, restart and read their logs.',
          '<b>Disk &amp; cleanup</b>: see what fills the disk, and clean safe things (old logs, caches, unused packages).',
        ],
        link: 'apps|Open the App Store',
      },
    ],
  },
  {
    id: 'backups',
    icon: 'archive',
    title: 'Backups',
    minutes: 3,
    summary: 'Automatic copies of your data, and restoring them.',
    view: 'backups',
    sections: [
      { p: 'Serverboy backs up your databases, website files, 1-click apps and settings every night, keeps 7 daily and 4 weekly copies, and can send them to Azure, S3 or Backblaze so they survive if the server is lost.' },
      {
        h: 'The basics',
        steps: ['Open <b>Backups</b> and click <b>Backup settings</b>: turn on the schedule and choose where copies go (this server only, or Azure / S3 / Backblaze too).', 'Click <b>Back up now</b> once to check it works.', 'To get data back, click <b>Restore…</b> on a backup and pick what to restore. <b>Restore next to it (new folder)</b> keeps your current data; <b>Replace</b> puts the old version back.', 'A weekly or monthly <b>test-restore</b> proves the backups really work.'],
        tip: 'Restoring an API server "as a copy" makes a folder ending in <span class="mono">-restored-…</span>. It is not used; delete it from the APIs page when you are done.',
        link: 'backups|Open Backups',
      },
    ],
  },
  {
    id: 'security',
    icon: 'shield',
    title: 'Firewall and safety',
    minutes: 2,
    summary: 'Which ports are open, and what Serverboy protects.',
    view: 'firewall',
    sections: [
      { p: 'The <b>Firewall</b> decides which ports the internet can reach. Websites need 80 and 443; SSH (22) is how Serverboy reaches the server.' },
      {
        h: 'The basics',
        steps: ['Open <b>Firewall</b> and turn it on. SSH, 80 and 443 stay open automatically.', 'Open other ports only when an app needs them.'],
        tip: 'Serverboy protects itself: on the server it runs on, its files, its website, Nginx and SSH cannot be deleted or stopped from Serverboy.',
        link: 'firewall|Open the Firewall',
      },
    ],
  },
  {
    id: 'alerts',
    icon: 'alert',
    title: 'Alerts',
    minutes: 2,
    summary: 'Hear about problems by email, Telegram, Slack or Discord.',
    sections: [
      { p: 'Serverboy checks your servers every few minutes: websites down, apps crashed, disk full, certificates about to expire, failed backups. It tells you, and tells you again when it is fixed.' },
      { h: 'The basics', steps: ['Open <b>Administration → Alerts</b> (owner).', 'Fill in email or Telegram (each has a short how-to) and click <b>Send test</b>.', 'Tick what to alert about and click <b>Save</b>.'], link: 'admin-alerts|Open Alerts' },
    ],
  },
  {
    id: 'team',
    icon: 'users',
    title: 'Team and permissions',
    minutes: 2,
    summary: 'Give your developers their own login, with only what they need.',
    sections: [
      { p: 'The owner can add team members, each with a role that decides what they may do, and limit them to certain websites or databases. Everything they do is in the activity log.' },
      { h: 'The basics', steps: ['Open <b>Administration → Users</b> and click <b>+ Add user</b>.', 'Choose a role (or make your own under Roles & permissions).', 'Optionally limit the user to some websites or databases.'], link: 'admin-users|Open Users' },
    ],
  },
  {
    id: 'ai',
    icon: 'sparkle',
    title: 'AI connector (MCP)',
    minutes: 3,
    summary: 'Manage Serverboy by chatting with Claude or another AI agent.',
    sections: [
      { p: 'With the AI connector, you can ask Claude things like <i>"Is my server healthy?"</i> or <i>"Create an API for the products collection in my shop website"</i>, and it does it in Serverboy for you. It acts as you: it can do what you can do, and nothing more.' },
      {
        h: 'Connect Claude',
        steps: [
          'Open <b>AI connector</b> (in the menu under Preference) and copy the connector address. [[ai|Open AI connector]]',
          'In Claude: <b>Settings → Connectors → Add custom connector</b>. Name it Serverboy, paste the address, click <b>Add</b>, then <b>Connect</b>.',
          'Serverboy opens: choose <b>Look and manage</b> (or <b>Only look</b>) and click <b>Allow</b>.',
          'In a chat, turn on the Serverboy connector and ask away.',
        ],
        tip: 'For Claude Code, Cursor and other agents, make a token on the AI connector page instead; it shows the command to paste.',
      },
      { h: 'Staying in control', list: ['Everyone on the team can connect their own AI. It can only do what that person\'s role allows.', 'Everything the AI changes is in the activity log, marked "(via AI: …)".', '"Only look" access cannot change anything.', 'Disconnect an app or revoke a token any time on the AI connector page.'] },
    ],
  },
  {
    id: 'app',
    icon: 'shield',
    title: 'The app, two-step login and notifications',
    minutes: 4,
    summary: 'Install Serverboy on your phone, protect your login, and get alerts there.',
    view: 'account',
    sections: [
      { p: 'Serverboy installs on your phone or computer like an app. With two-step login, a stolen password is not enough to get in. With notifications on, alerts, messages and login requests reach you even when Serverboy is closed.' },
      {
        h: 'Install the app',
        steps: [
          '<b>Android, Windows, Mac (Chrome or Edge):</b> open Serverboy, then the install icon in the address bar or the menu → <b>Install Serverboy</b>. Or My account → <b>Install the app</b>.',
          '<b>iPhone and iPad:</b> open Serverboy in Safari → <b>Share</b> → <b>Add to Home Screen</b> → <b>Add</b>. Open it from the Home Screen from now on.',
        ],
      },
      {
        h: 'Turn on two-step login',
        steps: [
          'Install an authenticator app on your phone: Google Authenticator, Microsoft Authenticator, Authy or 1Password.',
          'Open <b>My account</b> → <b>Two-step login</b> → <b>Turn on two-step login</b>. [[account|Open My account]]',
          'Scan the QR code with the app, type the 6-digit code it shows, and click <b>Turn on</b>.',
          '<b>Save the 10 recovery codes</b> (download or copy them into a password manager). Each works once if you lose your phone.',
        ],
        tip: 'From now on Serverboy asks for a code after your password. Owners can require it for everyone: Administration → Settings → Two-step login.',
      },
      {
        h: 'Turn on notifications and approve logins',
        steps: [
          'In the app on your phone, open <b>My account</b> → <b>Notifications</b> → <b>Turn on</b>, and allow notifications.',
          'Click <b>Send a test</b>: a notification should appear within seconds.',
          'Next time you log in somewhere else, click <b>Approve on my phone instead</b>. Your phone gets a notification; tap it and pick the number the login screen shows.',
        ],
        faq: [
          ['I lost my phone', 'Log in with one of your recovery codes, then turn two-step login off and on again with your new phone. Team members can also ask the owner: Users → <b>Reset two-step</b>.'],
          ['The owner lost their phone and the recovery codes', 'On the server run <span class="mono">sudo -u serverboy DATA_DIR=/var/lib/serverboy node /opt/serverboy/scripts/reset-2fa.js admin</span>, then <span class="mono">sudo systemctl restart serverboy</span>.'],
          ['Notifications do not arrive on iPhone', 'They only work in the app added to the Home Screen (iOS 16.4 or newer), not in a Safari tab. Turn them on from inside the app.'],
          ['A login approval I did not ask for', 'Tap <b>This wasn\'t me: deny</b>, then change your password: someone knows it.'],
        ],
      },
    ],
  },
  {
    id: 'trouble',
    icon: 'help',
    title: 'When something breaks',
    minutes: 3,
    summary: 'Where to look first, and how to repair Serverboy.',
    sections: [
      {
        list: [
          '<b>Dashboard</b>: lists what is wrong, often with a Fix button.',
          '<b>Tasks</b>: the full log of every install, deploy and backup. A failed task shows the step that failed.',
          '<b>APIs → 🩺 Diagnose</b>: finds what is wrong with an API and offers the fix.',
          '<b>Services → Logs</b>: what a program printed before it stopped.',
        ],
      },
      {
        h: 'If Serverboy itself does not open',
        steps: ['Open the Azure portal → your VM → <b>Run command</b> → <b>RunShellScript</b> (or connect with SSH).', 'Run the install command again: <span class="mono">curl -fsSL https://raw.githubusercontent.com/gaurav-swarnkar/serverboy/HEAD/scripts/install-on-server.sh | sudo bash</span>', 'It repairs Serverboy and keeps all your data.'],
      },
    ],
  },
];

// Which chapter belongs to which page (for the ? button).
export const CHAPTER_FOR_VIEW = Object.fromEntries(
  [
    ...CHAPTERS.filter((c) => c.view).map((c) => [c.view, c.id]),
    ['services', 'software'],
    ['storage', 'software'],
    ['jobs', 'trouble'],
    ['admin-alerts', 'alerts'],
    ['admin-users', 'team'],
    ['admin-roles', 'team'],
    ['people', 'team'],
    ['ai', 'ai'],
    ['approve', 'app'],
  ],
);
