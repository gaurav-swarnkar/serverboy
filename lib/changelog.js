// What changed in each version, newest first. Shown to team members when Serverboy is updated
// while they have it open ("What's new").
module.exports = [
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
