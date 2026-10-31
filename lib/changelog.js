// What changed in each version, newest first. Shown to team members when Serverboy is updated
// while they have it open ("What's new").
module.exports = [
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
