// Disk & cleanup: what fills the disk, what can be cleaned safely, and which installed software
// is still used.
import { api, esc, toast, run, modal, confirmDialog, showJob, onAction, loadingHtml, errorHtml, fmtBytes } from '../ui.js';

// Cleaned by default; the others lose something you might want (old app logs, Docker images).
const DEFAULT_CLEAN = new Set(['apt-cache', 'autoremove', 'journal', 'old-logs', 'snaps', 'crash', 'npm-cache', 'serverboy-tmp']);
const STATE = {
  needed: ['ok', 'Needed by Serverboy'],
  used: ['ok', 'In use'],
  keep: ['', 'Keep'],
  unused: ['warn', 'Looks unused'],
};

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const bar = (p) => `<div class="bar"><span style="width:${Math.min(100, p)}%;${p >= 90 ? 'background:var(--bad)' : p >= 80 ? 'background:var(--warn)' : ''}"></span></div>`;

export async function render(el, { server }) {
  const base = `/servers/${server.id}`;
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Disk & cleanup</h1><div class="sub">See what fills your disk, clean up safely, and remove software you don't use any more.</div></div>
      <button data-action="refresh">↻ Check again</button>
    </div>
    <div id="st-body">${loadingHtml('Checking the disk and the installed software (about 10 seconds)…')}</div>`;
  const body = el.querySelector('#st-body');
  let data = null;

  async function load() {
    body.innerHTML = loadingHtml('Checking the disk and the installed software (about 10 seconds)…');
    try {
      data = await api(`${base}/storage`);
    } catch (err) {
      body.innerHTML = errorHtml(err);
      return;
    }
    draw();
  }

  function draw() {
    const { disks, cleanups, apps } = data;
    const freeable = cleanups.filter((c) => DEFAULT_CLEAN.has(c.id)).reduce((s, c) => s + c.bytes, 0);
    const unused = apps.filter((a) => a.state === 'unused');
    body.innerHTML = `
      <div class="grid grid-3 st-summary">
        <div class="card stat"><div class="label">Can be freed safely</div><div class="value">${fmtBytes(freeable)}</div><div class="small muted">caches, old logs, leftovers</div></div>
        <div class="card stat"><div class="label">Software that looks unused</div><div class="value">${unused.length}</div><div class="small muted">${unused.length ? unused.map((a) => esc(a.name)).join(', ') : 'everything installed is used'}</div></div>
        <div class="card stat"><div class="label">Main disk (/)</div>${(() => {
          const d = disks.find((x) => x.mount === '/') || disks[0];
          return d ? `<div class="value">${pct(d.used, d.size)}%</div>${bar(pct(d.used, d.size))}<div class="small muted" style="margin-top:6px">${fmtBytes(d.avail)} free of ${fmtBytes(d.size)}</div>` : '';
        })()}</div>
      </div>

      <div class="card flush">
        <div class="card-head"><h2 style="margin:0">Disks</h2></div>
        <div class="table-wrap"><table><tbody>${disks
          .map(
            (d) => `<tr><td class="mono" style="width:120px">${esc(d.mount)}</td><td style="width:40%">${bar(pct(d.used, d.size))}</td>
              <td class="small muted">${fmtBytes(d.used)} used · ${fmtBytes(d.avail)} free of ${fmtBytes(d.size)}</td>
              <td class="actions"><button class="btn-sm" data-action="explore" data-path="${esc(d.mount)}">What's using it?</button></td></tr>`,
          )
          .join('')}</tbody></table></div>
        ${disks.some((d) => d.mount === '/mnt') ? '<p class="small muted" style="padding:0 16px">On Azure, <span class="mono">/mnt</span> is a temporary disk: it is wiped when the VM is stopped or moved. Never keep anything important there.</p>' : ''}
      </div>

      <div class="card flush">
        <div class="card-head"><h2 style="margin:0">Safe to clean</h2><span class="small muted">nothing your sites, apps or databases need</span></div>
        ${
          cleanups.length
            ? `<div class="table-wrap"><table><tbody>${cleanups
                .map(
                  (c) => `<tr><td style="width:32px"><input type="checkbox" data-clean="${c.id}" ${DEFAULT_CLEAN.has(c.id) ? 'checked' : ''}></td>
                    <td><b>${esc(c.label)}</b><div class="small muted">${esc(c.why)}</div>${
                      c.packages?.length ? `<details class="small"><summary>${c.packages.length} package(s)</summary><span class="mono">${c.packages.map(esc).join(', ')}</span></details>` : ''
                    }</td>
                    <td class="small" style="white-space:nowrap;text-align:right">${fmtBytes(c.bytes)}</td></tr>`,
                )
                .join('')}</tbody></table></div>
              <div class="row" style="padding:12px 16px"><button class="btn-primary" data-action="clean">Clean selected</button><span class="small muted" id="clean-total"></span></div>`
            : '<div class="empty">Nothing to clean right now.</div>'
        }
      </div>

      <div class="card flush">
        <div class="card-head"><h2 style="margin:0">Installed software</h2><a class="btn btn-sm" href="#/s/${server.id}/apps">App Store</a></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Software</th><th>Size</th><th>Is it used?</th><th></th></tr></thead>
          <tbody>${
            apps
              .map((a) => {
                const [cls, label] = STATE[a.state] || STATE.used;
                return `<tr class="${a.state === 'unused' ? 'st-unused' : ''}">
                  <td><b>${esc(a.name)}</b><div class="small muted">${esc(a.category)}${a.version ? ` · ${esc(a.version).slice(0, 40)}` : ''}</div></td>
                  <td class="small" style="white-space:nowrap">${a.program ? fmtBytes(a.program) : '-'}${a.data ? `<div class="muted">+ ${fmtBytes(a.data)} data</div>` : ''}</td>
                  <td><span class="badge ${cls}">${label}</span><div class="small muted">${esc(a.reason)}</div></td>
                  <td class="actions">${a.canUninstall ? `<button class="btn-sm ${a.state === 'unused' ? 'btn-danger' : ''}" data-action="uninstall" data-id="${esc(a.id)}">Uninstall</button>` : ''}</td>
                </tr>`;
              })
              .join('') || '<tr><td colspan="4" class="empty">Nothing from the App Store is installed.</td></tr>'
          }</tbody>
        </table></div>
        <p class="small muted" style="padding:0 16px">"Looks unused" is a hint from what Serverboy can see (websites, databases, apps, containers). Check before uninstalling. Data folders such as <span class="mono">/var/lib/mysql</span> are left in place.</p>
      </div>

      <div class="card" id="explorer">
        <div class="row"><h2 class="grow" style="margin:0">What's taking space</h2><button data-action="explore" data-path="/">Look inside /</button><button data-action="bigFiles">Find the biggest files</button></div>
        <div id="explorer-body"><p class="small muted">Shows the biggest folders. Click a folder to look inside it.</p></div>
      </div>

      <div class="card flush" id="packages">
        <div class="card-head"><h2 style="margin:0">All installed packages</h2><button class="btn-sm" data-action="packages">Show the biggest</button></div>
        <div id="pkg-body"><p class="small muted" style="padding:0 16px">Every program on the server, biggest first. Ones you (or Serverboy) installed are marked; the rest came with Ubuntu.</p></div>
      </div>`;
    updateTotal();
    body.querySelectorAll('[data-clean]').forEach((c) => c.addEventListener('change', updateTotal));
  }

  function updateTotal() {
    const t = body.querySelector('#clean-total');
    if (!t) return;
    const ids = [...body.querySelectorAll('[data-clean]:checked')].map((c) => c.dataset.clean);
    t.textContent = ids.length ? `About ${fmtBytes(data.cleanups.filter((c) => ids.includes(c.id)).reduce((s, c) => s + c.bytes, 0))} will be freed.` : 'Nothing selected.';
  }

  async function explore(path) {
    const box = body.querySelector('#explorer-body');
    body.querySelector('#explorer').scrollIntoView({ behavior: 'smooth', block: 'start' });
    box.innerHTML = loadingHtml(`Measuring ${path} (can take a minute on a big disk)…`);
    let r;
    try {
      r = await api(`${base}/storage/folders?path=${encodeURIComponent(path)}`);
    } catch (err) {
      box.innerHTML = errorHtml(err);
      return;
    }
    const parts = path.split('/').filter(Boolean);
    const max = Math.max(1, ...r.folders.map((f) => f.size));
    box.innerHTML = `
      <div class="breadcrumb" style="margin:10px 0">
        <a href="#" data-action="explore" data-path="/">/</a>${parts.map((p, i) => `<a href="#" data-action="explore" data-path="/${parts.slice(0, i + 1).map(esc).join('/')}">${esc(p)}</a>`).join('<span class="muted">/</span>')}
        <span class="muted small" style="margin-left:8px">${fmtBytes(r.total)} in total</span>
      </div>
      <div class="table-wrap"><table class="small"><tbody>
        ${r.folders
          .map(
            (f) => `<tr><td><a href="#" class="mono" data-action="explore" data-path="${esc(f.path)}">📁 ${esc(f.path.split('/').pop() || f.path)}</a>${hint(f.path) ? `<div class="muted">${esc(hint(f.path))}</div>` : ''}</td>
              <td style="width:35%">${bar(pct(f.size, max))}</td><td style="white-space:nowrap;text-align:right">${fmtBytes(f.size)}</td></tr>`,
          )
          .join('')}
        ${r.files.map((f) => `<tr><td class="mono">📄 ${esc(f.path.split('/').pop())}</td><td></td><td style="white-space:nowrap;text-align:right">${fmtBytes(f.size)}</td></tr>`).join('')}
        ${r.folders.length || r.files.length ? '' : '<tr><td class="empty">Empty, or no permission to look inside.</td></tr>'}
      </tbody></table></div>
      <div class="row" style="margin-top:8px"><button class="btn-sm" data-action="openFiles" data-path="${esc(path)}">Open in File Manager</button><span class="small muted">Delete files there if you are sure you don't need them.</span></div>`;
  }

  // What well-known folders are, in plain words.
  function hint(p) {
    const H = {
      '/var/lib/mongodb': 'MongoDB data (your databases)',
      '/var/lib/mysql': 'MariaDB / MySQL data (your databases)',
      '/var/lib/docker': 'Docker images, containers and volumes',
      '/var/lib/snapd': 'Snap packages',
      '/var/log': 'Logs',
      '/var/log/journal': 'System logs (journal)',
      '/var/cache/apt': 'Downloaded package files (safe to clean)',
      '/var/www': 'Your websites and apps',
      '/usr': 'Installed programs',
      '/usr/lib': 'Program libraries',
      '/usr/src': 'Kernel headers (old ones go with "Packages nothing needs")',
      '/opt/serverboy': 'Serverboy itself',
      '/home': 'Users\' home folders',
      '/root': 'The root user\'s home',
      '/swapfile': 'Swap memory',
      '/tmp': 'Temporary files',
      '/boot': 'Linux kernels (old ones go with "Packages nothing needs")',
      '/snap': 'Snap packages',
    };
    if (H[p]) return H[p];
    if (/\/\.npm$/.test(p)) return 'npm download cache (safe to clean)';
    if (/\/\.pm2$/.test(p)) return 'PM2: Node app logs and settings';
    if (/\/node_modules$/.test(p)) return 'Packages of a Node app (needed by that app)';
    return '';
  }

  async function bigFiles() {
    const box = body.querySelector('#explorer-body');
    body.querySelector('#explorer').scrollIntoView({ behavior: 'smooth', block: 'start' });
    box.innerHTML = loadingHtml('Looking for files bigger than 50 MB (can take a minute)…');
    try {
      const files = await api(`${base}/storage/big-files`);
      box.innerHTML = `<h3>Biggest files</h3>${
        files.length
          ? `<div class="table-wrap"><table class="small"><thead><tr><th>File</th><th>Changed</th><th></th></tr></thead><tbody>${files
              .map((f) => `<tr><td class="mono" style="word-break:break-all">${esc(f.path)}${hint(f.path) ? `<div class="muted">${esc(hint(f.path))}</div>` : ''}</td><td class="muted">${esc(f.modified)}</td><td style="white-space:nowrap;text-align:right">${fmtBytes(f.size)}</td></tr>`)
              .join('')}</tbody></table></div><p class="small muted">Typical leftovers: old backups (.tar.gz, .sql.gz), database dumps and huge logs. Program files and database files (/var/lib/…) are needed.</p>`
          : '<p class="muted">No file is bigger than 50 MB.</p>'
      }`;
    } catch (err) {
      box.innerHTML = errorHtml(err);
    }
  }

  async function packages() {
    const box = body.querySelector('#pkg-body');
    box.innerHTML = loadingHtml();
    try {
      const pkgs = await api(`${base}/storage/packages`);
      box.innerHTML = `<div class="row small" style="padding:8px 16px"><label class="check" style="margin:0"><input type="checkbox" id="pkg-mine"> Only what was installed on purpose</label></div>
        <div class="table-wrap"><table class="small"><thead><tr><th>Package</th><th>Size</th><th></th><th></th></tr></thead><tbody>${pkgs
          .map(
            (p) => `<tr data-mine="${p.manual ? 1 : 0}"><td><b class="mono">${esc(p.name)}</b><div class="muted">${esc(p.summary || '')}</div></td>
              <td style="white-space:nowrap">${fmtBytes(p.size)}</td>
              <td>${p.protected ? `<span class="badge" title="${esc(p.protected)}">🔒 system</span>` : p.manual ? '<span class="badge">installed on purpose</span>' : '<span class="muted">came with something else</span>'}</td>
              <td class="actions">${p.protected ? '' : `<button class="btn-sm" data-action="removePkg" data-name="${esc(p.name)}">Remove…</button>`}</td></tr>`,
          )
          .join('')}</tbody></table></div>`;
      box.querySelector('#pkg-mine').addEventListener('change', (e) => box.querySelectorAll('tr[data-mine]').forEach((tr) => tr.classList.toggle('hidden', e.target.checked && tr.dataset.mine !== '1')));
    } catch (err) {
      box.innerHTML = errorHtml(err);
    }
  }

  onAction(el, {
    refresh: load,
    explore: ({ path }) => explore(path),
    bigFiles,
    packages,
    openFiles: ({ path }) => {
      try {
        sessionStorage.setItem(`sb-files-${server.id}`, path);
      } catch {
        /* ignore */
      }
      location.hash = `#/s/${server.id}/files`;
    },
    clean: async (_d, btn) => {
      const ids = [...body.querySelectorAll('[data-clean]:checked')].map((c) => c.dataset.clean);
      if (!ids.length) return toast('Tick something to clean first', 'error');
      const job = await run(btn, () => api(`${base}/storage/clean`, { method: 'POST', body: { ids } }));
      if (job) showJob(server.id, job, { onDone: load });
    },
    uninstall: async ({ id }) => {
      const a = data.apps.find((x) => x.id === id);
      const msg =
        a.state === 'unused'
          ? `Uninstall ${a.name}? ${a.reason} Its data folder (if any) is left in place, so you can reinstall it later from the App Store.`
          : `${a.name} looks used: ${a.reason}\n\nUninstalling it can break what uses it. Uninstall anyway?`;
      if (!(await confirmDialog(msg, { danger: true, confirmLabel: 'Uninstall' }))) return;
      const job = await run(null, () => api(`${base}/apps/${id}/uninstall`, { method: 'POST' }));
      if (job) showJob(server.id, job, { onDone: load });
    },
    removePkg: async ({ name }) => {
      const plan = await run(null, () => api(`${base}/storage/packages/preview`, { method: 'POST', body: { name } }));
      if (!plan) return;
      modal({
        title: `Remove ${name}?`,
        body: `${plan.blocked.length ? `<div class="notice warn">This would also remove <b>${plan.blocked.map(esc).join(', ')}</b>, which the system needs. Serverboy will not do it.</div>` : ''}
          <p>These packages would be removed, freeing about <b>${fmtBytes(plan.total)}</b>:</p>
          <div class="table-wrap"><table class="small"><tbody>${plan.packages.map((p) => `<tr><td class="mono">${esc(p.name)}${p.protected ? ' 🔒' : ''}</td><td style="text-align:right">${fmtBytes(p.size)}</td></tr>`).join('')}</tbody></table></div>
          <p class="small muted">Settings files are kept. You can install it again from the App Store (search for "${esc(name)}").</p>`,
        actions: [
          { label: 'Cancel' },
          ...(plan.blocked.length
            ? []
            : [
                {
                  label: 'Remove',
                  className: 'btn-primary btn-danger-fill',
                  onClick: async () => {
                    const job = await api(`${base}/storage/packages/remove`, { method: 'POST', body: { name } });
                    showJob(server.id, job, { onDone: () => (load(), packages()) });
                  },
                },
              ]),
        ],
      });
    },
  });

  load();
}
