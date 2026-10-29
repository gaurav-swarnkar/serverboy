import { api, esc, toast, run, modal, confirmDialog, formDialog, showJob, fmtBytes, onAction, loadingHtml, errorHtml, randomPassword, can, hasAll } from '../ui.js';
import { mountApiSummary, mountConnectGuide, apiPageUrl } from './data-api.js';

export async function render(el, { server, rest }) {
  const tab = rest[0] === 'mongo' ? 'mongo' : 'mysql';
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Databases</h1><div class="sub">Create databases and users, browse data and run queries, like phpMyAdmin.</div></div>
    </div>
    <div class="tabs">
      <button class="${tab === 'mysql' ? 'active' : ''}" data-action="tab" data-tab="mysql">MariaDB / MySQL</button>
      <button class="${tab === 'mongo' ? 'active' : ''}" data-action="tab" data-tab="mongo">MongoDB</button>
    </div>
    <div id="db-view"></div>`;
  onAction(el.querySelector('.tabs'), {
    tab: ({ tab: t }) => {
      location.hash = `#/s/${server.id}/databases/${t}`;
    },
  });
  const view = el.querySelector('#db-view');
  if (tab === 'mongo') return renderMongo(view, server);
  return renderMysql(view, server);
}

// ============================ MariaDB ============================

function renderMysql(el, server) {
  const base = `/servers/${server.id}/mysql`;
  let dbs = [];

  el.innerHTML = `
    <div class="grid grid-2">
      <div class="card flush">
        <div class="card-head"><h2>Databases</h2><div class="row">${hasAll('databases') ? '<button class="btn-sm" data-action="users">Users</button><button class="btn-sm btn-primary" data-action="create">+ New database</button>' : ''}</div></div>
        <div id="dbs">${loadingHtml()}</div>
      </div>
      ${hasAll('databases') ? `<div class="card">
        <h2>SQL query</h2>
        <form id="sql-form">
          <div class="row" style="margin-bottom:8px"><select name="database" style="width:auto"><option value="">(no database)</option></select></div>
          <textarea name="sql" rows="6" placeholder="SELECT * FROM users LIMIT 20;"></textarea>
          <div class="row" style="margin-top:8px"><button class="btn-primary">Run</button><span class="small muted">Runs as the database root user. Be careful with DELETE / DROP.</span></div>
        </form>
      </div>` : `<div class="card"><h2>Browse data</h2><p class="muted" style="margin:0">Click <b>Tables</b> next to a database, then <b>Browse</b>. The SQL console is only for users with access to all databases, because it runs as the database root user.</p></div>`}
    </div>
    <div id="result" style="margin-top:16px"></div>`;

  const dbsEl = el.querySelector('#dbs');
  const select = el.querySelector('select[name=database]') || document.createElement('select');
  const resultEl = el.querySelector('#result');

  async function load() {
    try {
      dbs = await api(`${base}/databases`);
      const userDbs = dbs.filter((d) => !d.system);
      dbsEl.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Tables</th><th>Size</th><th></th></tr></thead>
        <tbody>${userDbs
          .map(
            (d) => `<tr><td><b>${esc(d.name)}</b></td><td>${d.tables}</td><td>${fmtBytes(d.size)}</td>
            <td class="actions">
              <button class="btn-sm" data-action="tables" data-name="${esc(d.name)}">Tables</button>
              <a class="btn btn-sm" href="/api${base}/databases/${encodeURIComponent(d.name)}/export" download>Export</a>
              ${d.access === 'edit' ? `<button class="btn-sm" data-action="import" data-name="${esc(d.name)}">Import</button>` : ''}
              ${hasAll('databases') ? `<button class="btn-sm btn-danger" data-action="drop" data-name="${esc(d.name)}">Drop</button>` : ''}
            </td></tr>`,
          )
          .join('')}
        ${userDbs.length ? '' : '<tr><td colspan="4" class="empty">No databases yet</td></tr>'}
        </tbody></table></div>`;
      const current = select.value;
      select.innerHTML = `<option value="">(no database)</option>${dbs.map((d) => `<option ${d.name === current ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}`;
    } catch (err) {
      dbsEl.innerHTML = `<div style="padding:16px">${errorHtml(err)}<p>Need MariaDB? <a href="#/s/${server.id}/apps">Install it from the App Store</a>.</p></div>`;
    }
  }

  // Without SQL access, browsing a table uses the read-only rows endpoint instead of a query.
  async function query(database, sql, table) {
    resultEl.innerHTML = loadingHtml('Running query…');
    try {
      const r = table
        ? await api(`${base}/databases/${encodeURIComponent(database)}/tables/${encodeURIComponent(table)}/rows?limit=100`)
        : await api(`${base}/query`, { method: 'POST', body: { database, sql } });
      if (!r.columns.length) {
        resultEl.innerHTML = '<div class="notice">Query OK (no rows returned).</div>';
        load();
        return;
      }
      resultEl.innerHTML = `<div class="card flush">
        <div class="card-head"><h2>Result</h2><span class="small muted">${r.totalRows} row(s)${r.truncated ? ', showing the first 1000' : ''}</span></div>
        <div class="table-wrap"><table>
          <thead><tr>${r.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>${r.rows.map((row) => `<tr>${row.map((v) => `<td class="mono small">${v === null ? '<span class="muted">NULL</span>' : esc(v.length > 200 ? `${v.slice(0, 200)}…` : v)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div></div>`;
    } catch (err) {
      resultEl.innerHTML = errorHtml(err);
    }
  }

  el.querySelector('#sql-form')?.addEventListener('submit', (e) => query(e.target.database.value, e.target.sql.value));

  onAction(el, {
    create: async () => {
      const pw = randomPassword();
      const r = await formDialog({
        title: 'New database',
        fields: [
          { name: 'name', label: 'Database name', placeholder: 'myapp', required: true },
          { name: 'user', label: 'Create a user for it (optional)', placeholder: 'myapp_user' },
          { name: 'password', label: 'User password', value: pw, help: 'A strong password was generated. Copy it now.' },
        ],
        submitLabel: 'Create',
        submit: async (v) => {
          await api(`${base}/databases`, { method: 'POST', body: v });
          return v;
        },
      });
      if (!r) return;
      load();
      if (r.user) {
        modal({
          title: 'Database created',
          body: `<p>Use these settings in your app:</p><pre class="log">DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_NAME=${esc(r.name)}\nDB_USER=${esc(r.user)}\nDB_PASSWORD=${esc(r.password)}\nDATABASE_URL=mysql://${esc(encodeURIComponent(r.user))}:${esc(encodeURIComponent(r.password))}@127.0.0.1:3306/${esc(r.name)}</pre>`,
          actions: [{ label: 'Done', className: 'btn-primary' }],
        });
      } else toast('Database created', 'ok');
    },
    drop: async ({ name }) => {
      if (!(await confirmDialog(`Drop database "${name}" and ALL its data? Export it first if you need a backup.`, { danger: true, confirmLabel: 'Drop database' }))) return;
      await run(null, () => api(`${base}/databases/${encodeURIComponent(name)}`, { method: 'DELETE' }), 'Database dropped');
      load();
    },
    tables: async ({ name }) => {
      const m = modal({ title: `Tables in ${name}`, wide: true, body: loadingHtml() });
      try {
        const tables = await api(`${base}/databases/${encodeURIComponent(name)}/tables`);
        m.body.innerHTML = tables.length
          ? `<table><thead><tr><th>Table</th><th>Rows (approx.)</th><th>Size</th><th>Engine</th><th></th></tr></thead><tbody>${tables
              .map((t) => `<tr><td class="mono">${esc(t.name)}</td><td>${t.rows}</td><td>${fmtBytes(t.size)}</td><td>${esc(t.engine)}</td><td class="actions"><button class="btn-sm" data-browse="${esc(t.name)}">Browse</button></td></tr>`)
              .join('')}</tbody></table>`
          : '<div class="empty">No tables</div>';
        m.body.addEventListener('click', (e) => {
          const t = e.target.closest('[data-browse]')?.dataset.browse;
          if (!t) return;
          m.close();
          if (!hasAll('databases')) return query(name, null, t);
          select.value = name;
          const sql = `SELECT * FROM \`${t}\` LIMIT 100;`;
          el.querySelector('textarea[name=sql]').value = sql;
          query(name, sql);
        });
      } catch (err) {
        m.body.innerHTML = errorHtml(err);
      }
    },
    import: async ({ name }) => {
      const body = document.createElement('div');
      body.innerHTML = `<p>Upload a <span class="mono">.sql</span> or <span class="mono">.sql.gz</span> file to import into <b>${esc(name)}</b>.</p><input type="file" accept=".sql,.gz">`;
      modal({
        title: `Import into ${name}`,
        body,
        actions: [
          { label: 'Cancel' },
          {
            label: 'Upload & import',
            className: 'btn-primary',
            onClick: async () => {
              const file = body.querySelector('input').files[0];
              if (!file) throw new Error('Choose a file');
              const form = new FormData();
              form.append('file', file);
              const job = await api(`${base}/databases/${encodeURIComponent(name)}/import`, { method: 'POST', form });
              showJob(server.id, job, { onDone: load });
            },
          },
        ],
      });
    },
    users: async () => {
      const m = modal({ title: 'Database users', wide: true, body: loadingHtml(), actions: [{ label: 'Close' }] });
      const draw = async () => {
        const users = await api(`${base}/users`);
        m.body.innerHTML = `<div class="row" style="margin-bottom:12px"><button class="btn-primary btn-sm" data-add>+ New user / change password</button></div>
          <table><thead><tr><th>User</th><th>Host</th><th></th></tr></thead><tbody>${users
            .map((u) => `<tr><td class="mono">${esc(u.user)}</td><td class="mono">${esc(u.host)}</td><td class="actions">${['root', 'mysql', 'mariadb.sys'].includes(u.user) ? '' : `<button class="btn-sm btn-danger" data-drop="${esc(u.user)}" data-host="${esc(u.host)}">Drop</button>`}</td></tr>`)
            .join('')}</tbody></table>`;
      };
      m.body.addEventListener('click', async (e) => {
        if (e.target.closest('[data-add]')) {
          const ok = await formDialog({
            title: 'Database user',
            fields: [
              { name: 'user', label: 'User name', required: true },
              { name: 'password', label: 'Password', value: randomPassword() },
              { name: 'host', label: 'Allowed from host', value: 'localhost', help: 'localhost = only apps on this server (recommended). % = anywhere.' },
              { name: 'database', label: 'Grant full access to database (optional)', type: 'select', options: ['', ...dbs.filter((d) => !d.system).map((d) => d.name)] },
            ],
            submit: (v) => api(`${base}/users`, { method: 'POST', body: v }),
          });
          if (ok) {
            toast('User saved', 'ok');
            draw();
          }
        }
        const drop = e.target.closest('[data-drop]');
        if (drop && (await confirmDialog(`Drop user ${drop.dataset.drop}@${drop.dataset.host}?`, { danger: true, confirmLabel: 'Drop' }))) {
          await run(null, () => api(`${base}/users`, { method: 'DELETE', body: { user: drop.dataset.drop, host: drop.dataset.host } }), 'User dropped');
          draw();
        }
      });
      draw().catch((err) => (m.body.innerHTML = errorHtml(err)));
    },
  });

  load();
}

// ============================ MongoDB ============================

function renderMongo(el, server) {
  const base = `/servers/${server.id}/mongo`;
  let dbs = [];
  const canEditDb = (name) => hasAll('databases') || dbs.find((d) => d.name === name)?.access === 'edit';
  let current = { db: null, collection: null, skip: 0 };

  el.innerHTML = `<div id="mongo-status"></div>
    <div class="grid" style="grid-template-columns: minmax(240px, 320px) 1fr; align-items:start">
      <div class="card flush">
        <div class="card-head"><h2>Databases</h2>${hasAll('databases') ? '<button class="btn-sm btn-primary" data-action="newDb">+ New</button>' : ''}</div>
        <div id="tree">${loadingHtml()}</div>
      </div>
      <div id="docs" class="card"><div class="empty">Select a collection to browse its documents.</div></div>
    </div>`;

  const statusEl = el.querySelector('#mongo-status');
  const treeEl = el.querySelector('#tree');
  const docsEl = el.querySelector('#docs');

  async function loadStatus() {
    const s = await api(`${base}/status`);
    if (!s.installed) {
      statusEl.innerHTML = `<div class="notice">MongoDB is not installed. <a href="#/s/${server.id}/apps">Install it from the App Store</a>.</div>`;
      return false;
    }
    statusEl.innerHTML = `<div class="card" style="margin-bottom:16px"><div class="row">
      <span>mongod: ${s.running ? '<span class="badge ok">running</span>' : '<span class="badge bad">stopped</span>'}</span>
      <span>Authentication: ${s.authEnabled ? '<span class="badge ok">enabled</span>' : '<span class="badge warn">off</span>'}</span>
      <span class="grow"></span>
      <button class="btn-sm" data-action="users">Users</button>
      ${can('owner') ? '<button class="btn-sm" data-action="creds">Connection settings</button>' : ''}
      ${s.authEnabled || !can('owner') ? '' : '<button class="btn-sm btn-primary" data-action="secure">Secure MongoDB</button>'}
    </div>
    ${s.authEnabled ? '' : '<p class="small muted" style="margin:8px 0 0">Authentication is off: anything on this server can read your data. Click "Secure MongoDB" before going live.</p>'}
    ${s.authEnabled && !s.hasCredentials ? '<p class="small" style="margin:8px 0 0;color:var(--warn)">Auth is on but Serverboy has no admin credentials. Add them under "Connection settings".</p>' : ''}
    </div>`;
    return s.running;
  }

  async function loadTree() {
    try {
      dbs = await api(`${base}/databases`);
      treeEl.innerHTML = dbs
        .map(
          (d) => `<div style="border-bottom:1px solid var(--border)">
          <div class="row" style="padding:8px 12px">
            <span class="file-name grow" data-action="openDb" data-db="${esc(d.name)}">⛁ <b>${esc(d.name)}</b></span>
            <span class="small muted">${fmtBytes(d.size)}</span>
            ${d.system || !hasAll('databases') ? '' : `<button class="btn-sm btn-ghost" title="Drop database" data-action="dropDb" data-db="${esc(d.name)}">✕</button>`}
            ${d.access === 'view' ? '<span class="badge">view</span>' : ''}
          </div>
          <div data-cols="${esc(d.name)}"></div>
        </div>`,
        )
        .join('');
    } catch (err) {
      const hint = /requires authentication|Authentication failed/i.test(err.message)
        ? '<p class="small" style="margin:8px 0 0">MongoDB needs a login: click <b>Connection settings</b> above.</p>'
        : '';
      treeEl.innerHTML = `<div style="padding:12px">${errorHtml(err)}${hint}</div>`;
    }
  }

  async function openDb(db) {
    const box = treeEl.querySelector(`[data-cols="${CSS.escape(db)}"]`);
    if (box.innerHTML) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = loadingHtml();
    try {
      const cols = await api(`${base}/databases/${encodeURIComponent(db)}/collections`);
      box.innerHTML = `${cols
        .map((c) => `<div class="row" style="padding:4px 12px 4px 32px"><span class="file-name grow" data-action="openCol" data-db="${esc(db)}" data-col="${esc(c.name)}">▤ ${esc(c.name)}</span><span class="small muted">${c.count ?? ''}</span></div>`)
        .join('')}${canEditDb(db) ? `<div style="padding:4px 12px 8px 32px"><button class="btn-sm" data-action="newCol" data-db="${esc(db)}">+ Collection</button></div>` : ''}`;
    } catch (err) {
      box.innerHTML = errorHtml(err);
    }
  }

  function drawDocsShell(tab = 'docs') {
    current.tab = tab;
    docsEl.innerHTML = `
      <div class="row" style="margin-bottom:6px"><h2 class="grow" style="margin:0">${esc(current.db)}.${esc(current.collection)}</h2>
        ${tab === 'docs' && canEditDb(current.db) ? `<button class="btn-sm" data-action="insert">+ Insert document</button>
        <button class="btn-sm btn-danger" data-action="dropCol">Drop collection</button>` : ''}
        ${canEditDb(current.db) ? '' : '<span class="badge">view only</span>'}
        <a class="btn btn-sm" href="${apiPageUrl(server, current.db, current.collection)}" target="_blank" rel="noopener" title="Open this collection's API in a new browser tab">API ↗</a></div>
      <div class="tabs">
        <button class="${tab === 'docs' ? 'active' : ''}" data-action="colTab" data-tab="docs">Documents</button>
        <button class="${tab === 'api' ? 'active' : ''}" data-action="colTab" data-tab="api">API</button>
        <button class="${tab === 'connect' ? 'active' : ''}" data-action="colTab" data-tab="connect">Connect</button>
      </div>
      <div id="col-tab"></div>`;
    const tabEl = docsEl.querySelector('#col-tab');
    if (tab === 'api') return mountApiSummary(tabEl, server, current.db, current.collection, canEditDb(current.db));
    if (tab === 'connect') return mountConnectGuide(tabEl, server, current.db, current.collection);
    tabEl.innerHTML = `
      <form id="find-form" class="row" style="margin-bottom:10px">
        <input name="filter" class="mono grow" style="width:auto" placeholder='Filter, e.g. { "email": "a@b.com" }' value="${esc(current.filter || '')}">
        <input name="sort" class="mono" style="width:180px" placeholder='Sort { "_id": -1 }' value="${esc(current.sort || '')}">
        <button class="btn-primary">Find</button>
      </form>
      <div id="doc-list">${loadingHtml()}</div>`;
    docsEl.querySelector('#find-form').addEventListener('submit', (e) => {
      current.filter = e.target.filter.value;
      current.sort = e.target.sort.value;
      current.skip = 0;
      loadDocs();
    });
  }

  async function loadDocs() {
    const listEl = docsEl.querySelector('#doc-list');
    listEl.innerHTML = loadingHtml();
    try {
      const r = await api(`${base}/find`, { method: 'POST', body: { db: current.db, collection: current.collection, filter: current.filter, sort: current.sort, skip: current.skip, limit: 20 } });
      current.docs = r.docs;
      const from = r.total ? current.skip + 1 : 0;
      listEl.innerHTML = `
        <div class="row small muted" style="margin-bottom:8px"><span class="grow">${from}–${current.skip + r.docs.length} of ${r.total}</span>
          <button class="btn-sm" data-action="page" data-dir="-1" ${current.skip ? '' : 'disabled'}>‹ Prev</button>
          <button class="btn-sm" data-action="page" data-dir="1" ${current.skip + r.docs.length < r.total ? '' : 'disabled'}>Next ›</button></div>
        ${r.docs
          .map(
            (d, i) => `<div style="border:1px solid var(--border);border-radius:8px;margin-bottom:8px;overflow:hidden">
            <div class="row" style="padding:4px 8px;background:var(--panel-2);justify-content:flex-end">
              ${canEditDb(current.db) ? `<button class="btn-sm btn-ghost" data-action="editDoc" data-i="${i}">Edit</button>
              <button class="btn-sm btn-ghost btn-danger" data-action="deleteDoc" data-i="${i}">Delete</button>` : ''}</div>
            <pre class="mono small" style="margin:0;padding:8px 12px;overflow:auto;max-height:300px">${esc(JSON.stringify(d, null, 2))}</pre></div>`,
          )
          .join('') || '<div class="empty">No documents</div>'}`;
    } catch (err) {
      listEl.innerHTML = errorHtml(err);
    }
  }

  function docEditor(title, value, onSave) {
    const body = document.createElement('div');
    body.innerHTML = '<textarea spellcheck="false" style="width:100%;height:50vh"></textarea><p class="small muted">JSON / Extended JSON, e.g. {"$oid": "…"} for ObjectIds or {"$date": "2025-01-01T00:00:00Z"} for dates.</p>';
    body.querySelector('textarea').value = value;
    modal({ title, wide: true, body, actions: [{ label: 'Cancel' }, { label: 'Save', className: 'btn-primary', onClick: () => onSave(body.querySelector('textarea').value) }] });
  }

  onAction(el, {
    openDb: ({ db }) => openDb(db),
    openCol: ({ db, col }) => {
      current = { db, collection: col, skip: 0 };
      drawDocsShell();
      loadDocs();
    },
    colTab: ({ tab }) => {
      drawDocsShell(tab);
      if (tab === 'docs') loadDocs();
    },
    page: ({ dir }) => {
      current.skip = Math.max(0, current.skip + Number(dir) * 20);
      loadDocs();
    },
    newDb: async () => {
      const v = await formDialog({
        title: 'New MongoDB database',
        intro: 'MongoDB creates a database when its first collection is created.',
        fields: [
          { name: 'db', label: 'Database name', placeholder: 'myapp', required: true },
          { name: 'col', label: 'First collection', placeholder: 'users', required: true },
        ],
        submitLabel: 'Create',
        submit: (x) => api(`${base}/databases/${encodeURIComponent(x.db)}/collections`, { method: 'POST', body: { name: x.col } }),
      });
      if (v) loadTree();
    },
    newCol: async ({ db }) => {
      const v = await formDialog({
        title: `New collection in ${db}`,
        fields: [{ name: 'name', label: 'Collection name', required: true }],
        submitLabel: 'Create',
        submit: (x) => api(`${base}/databases/${encodeURIComponent(db)}/collections`, { method: 'POST', body: x }),
      });
      if (v) {
        await loadTree();
        openDb(db);
      }
    },
    dropDb: async ({ db }) => {
      if (!(await confirmDialog(`Drop database "${db}" and all of its collections?`, { danger: true, confirmLabel: 'Drop database' }))) return;
      await run(null, () => api(`${base}/databases/${encodeURIComponent(db)}`, { method: 'DELETE' }), 'Database dropped');
      loadTree();
    },
    dropCol: async () => {
      if (!(await confirmDialog(`Drop collection "${current.collection}" and all of its documents?`, { danger: true, confirmLabel: 'Drop collection' }))) return;
      await run(null, () => api(`${base}/databases/${encodeURIComponent(current.db)}/collections/${encodeURIComponent(current.collection)}`, { method: 'DELETE' }), 'Collection dropped');
      docsEl.innerHTML = '<div class="empty">Select a collection to browse its documents.</div>';
      loadTree();
    },
    insert: () =>
      docEditor('Insert document', '{\n  \n}', async (text) => {
        await api(`${base}/insert`, { method: 'POST', body: { db: current.db, collection: current.collection, document: text } });
        toast('Inserted', 'ok');
        loadDocs();
      }),
    editDoc: ({ i }) =>
      // Documents arrive as relaxed Extended JSON ({"$oid": …}), which the server parses back with EJSON.
      docEditor('Edit document', JSON.stringify(current.docs[i], null, 2), async (text) => {
        await api(`${base}/update`, { method: 'POST', body: { db: current.db, collection: current.collection, document: text } });
        toast('Saved', 'ok');
        loadDocs();
      }),
    deleteDoc: async ({ i }) => {
      const doc = current.docs[i];
      if (!(await confirmDialog('Delete this document?', { danger: true, confirmLabel: 'Delete' }))) return;
      await run(null, () => api(`${base}/delete`, { method: 'POST', body: { db: current.db, collection: current.collection, filter: JSON.stringify({ _id: doc._id }) } }), 'Deleted');
      loadDocs();
    },
    secure: async () => {
      const job = await formDialog({
        title: 'Secure MongoDB',
        intro: 'Creates an admin user, turns on authentication and restarts MongoDB. Apps will then need a username and password in their connection string.',
        fields: [
          { name: 'user', label: 'Admin user name', value: 'admin' },
          { name: 'password', label: 'Admin password', value: randomPassword(24), help: 'Saved (encrypted) in Serverboy. Copy it somewhere safe too.' },
        ],
        submitLabel: 'Enable authentication',
        submit: (v) => api(`${base}/secure`, { method: 'POST', body: v }),
      });
      if (job?.id) showJob(server.id, job, { onDone: () => loadStatus() });
    },
    creds: async () => {
      const v = await formDialog({
        title: 'MongoDB login used by Serverboy',
        intro: 'Enter a MongoDB admin user (one with the root role). Serverboy checks the login works before saving it, encrypted. Leave everything empty to connect without a password.',
        fields: [
          { name: 'user', label: 'Admin user name', placeholder: 'admin' },
          { name: 'password', label: 'Password', type: 'password' },
          { name: 'authDb', label: 'Authentication database', value: 'admin', help: 'Almost always admin.' },
          { name: 'uri', label: 'Or a full connection string (advanced)', placeholder: 'mongodb://admin:password@127.0.0.1:27017/?authSource=admin' },
        ],
        submitLabel: 'Test & save',
        submit: (x) => api(`${base}/credentials`, { method: 'POST', body: x }),
      });
      if (v) {
        toast('Connected and saved', 'ok');
        refresh();
      }
    },
    users: async () => {
      const m = modal({ title: 'MongoDB users', wide: true, body: loadingHtml(), actions: [{ label: 'Close' }] });
      const draw = async () => {
        const users = await api(`${base}/users`);
        m.body.innerHTML = `<div class="row" style="margin-bottom:12px"><button class="btn-primary btn-sm" data-add>+ New app user</button></div>
          <table><thead><tr><th>User</th><th>Database</th><th>Roles</th><th></th></tr></thead><tbody>${users
            .map((u) => `<tr><td class="mono">${esc(u.user)}</td><td>${esc(u.db)}</td><td class="small">${u.roles.map(esc).join(', ')}</td><td class="actions"><button class="btn-sm btn-danger" data-drop="${esc(u.user)}" data-db="${esc(u.db)}">Drop</button></td></tr>`)
            .join('') || '<tr><td colspan="4" class="empty">No users</td></tr>'}</tbody></table>`;
      };
      m.body.addEventListener('click', async (e) => {
        if (e.target.closest('[data-add]')) {
          const r = await formDialog({
            title: 'New MongoDB user',
            intro: 'Create one user per app, with access to just its own database.',
            fields: [
              { name: 'db', label: 'Database', placeholder: 'myapp', required: true },
              { name: 'user', label: 'User name', placeholder: 'myapp_user', required: true },
              { name: 'password', label: 'Password', value: randomPassword() },
              { name: 'role', label: 'Role', type: 'select', value: 'readWrite', options: [['readWrite', 'readWrite (normal app access)'], ['dbOwner', 'dbOwner (also manage indexes/users)'], ['read', 'read (read-only)']] },
            ],
            submit: (v) => api(`${base}/users`, { method: 'POST', body: v }),
          });
          if (r?.connectionString) {
            modal({
              title: 'User created',
              body: `<p>Put this in your app's environment variables:</p><pre class="log">MONGODB_URI=${esc(r.connectionString)}</pre>`,
              actions: [{ label: 'Done', className: 'btn-primary' }],
            });
            draw();
          }
        }
        const drop = e.target.closest('[data-drop]');
        if (drop && (await confirmDialog(`Drop user ${drop.dataset.drop} (${drop.dataset.db})?`, { danger: true, confirmLabel: 'Drop' }))) {
          await run(null, () => api(`${base}/users`, { method: 'DELETE', body: { user: drop.dataset.drop, db: drop.dataset.db } }), 'User dropped');
          draw();
        }
      });
      draw().catch((err) => (m.body.innerHTML = errorHtml(err)));
    },
  });

  async function refresh() {
    try {
      if (await loadStatus()) loadTree();
      else treeEl.innerHTML = '<div class="empty">MongoDB is not running.</div>';
    } catch (err) {
      statusEl.innerHTML = errorHtml(err);
    }
  }
  refresh();
}
