import { api, esc, toast, run, modal, confirmDialog, formDialog, fmtBytes, fmtDate, onAction, loadingHtml, errorHtml, can } from '../ui.js';

const ARCHIVE_RE = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i;

function join(dir, name) {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

function parent(dir) {
  const p = dir.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
  return p || '/';
}

export async function render(el, { server }) {
  const base = `/servers/${server.id}`;
  const key = `sb-files-${server.id}`;
  let cwd = sessionStorage.getItem(key);
  if (!cwd) cwd = (await api(`${base}/files/home`)).path;
  let entries = [];

  el.innerHTML = `
    <div class="page-head">
      <div><h1>File Manager</h1><div class="sub">Browse, upload, edit and download files, like an FTP client.</div></div>
      <div class="row">
        <button data-action="go" data-path="/var/www">/var/www</button>
        ${can('owner') ? '<button data-action="home">Home</button>' : ''}
        <button data-action="newFolder">+ Folder</button>
        <button data-action="newFile">+ File</button>
        <label class="btn btn-primary">⬆ Upload<input type="file" id="upload" multiple hidden></label>
      </div>
    </div>
    <div class="card flush" id="drop">
      <div class="card-head">
        <div class="breadcrumb" id="crumbs"></div>
        <div class="row"><input id="goto" class="mono" placeholder="Go to path…" style="width:240px"><button data-action="refresh">↻</button></div>
      </div>
      <div id="listing"></div>
    </div>
    <p class="small muted">Tip: drag & drop files onto the list to upload. Upload a .zip and click Extract to deploy a whole site at once.</p>`;

  const listing = el.querySelector('#listing');

  async function load(path = cwd) {
    listing.innerHTML = loadingHtml();
    try {
      const r = await api(`${base}/files/list?path=${encodeURIComponent(path)}`);
      cwd = r.path;
      entries = r.entries;
      sessionStorage.setItem(key, cwd);
      draw();
    } catch (err) {
      listing.innerHTML = errorHtml(err);
    }
  }

  function draw() {
    const parts = cwd.split('/').filter(Boolean);
    el.querySelector('#crumbs').innerHTML =
      `<a href="#" data-action="go" data-path="/">/</a>` +
      parts.map((p, i) => `<a href="#" data-action="go" data-path="/${parts.slice(0, i + 1).map(esc).join('/')}">${esc(p)}</a>`).join('<span class="muted">/</span>');
    listing.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Size</th><th>Modified</th><th>Perms</th><th>Owner</th><th></th></tr></thead>
        <tbody>
          ${cwd !== '/' ? `<tr><td colspan="6"><span class="file-name" data-action="go" data-path="${esc(parent(cwd))}">↰ ..</span></td></tr>` : ''}
          ${entries
            .map((e, i) => {
              const p = join(cwd, e.name);
              return `<tr>
                <td><span class="file-name" data-action="${e.type === 'dir' ? 'go' : 'open'}" data-path="${esc(p)}">${e.type === 'dir' ? '📁' : '📄'} ${esc(e.name)}${e.link ? ` <span class="muted small">→ ${esc(e.link)}</span>` : ''}</span></td>
                <td class="small">${e.type === 'dir' ? '' : fmtBytes(e.size)}</td>
                <td class="small muted">${fmtDate(e.mtime)}</td>
                <td class="mono small"><a href="#" data-action="chmod" data-i="${i}">${esc(e.mode)}</a></td>
                <td class="small">${esc(e.owner)}</td>
                <td class="actions">
                  ${ARCHIVE_RE.test(e.name) ? `<button class="btn-sm" data-action="extract" data-path="${esc(p)}">Extract</button>` : ''}
                  <a class="btn btn-sm" href="/api${base}/files/download?path=${encodeURIComponent(p)}" download title="${e.type === 'dir' ? 'Download as .tar.gz' : 'Download'}">⬇</a>
                  <button class="btn-sm" data-action="rename" data-i="${i}">Rename</button>
                  <button class="btn-sm btn-danger" data-action="delete" data-i="${i}">Delete</button>
                </td>
              </tr>`;
            })
            .join('')}
          ${entries.length ? '' : '<tr><td colspan="6" class="empty">This folder is empty</td></tr>'}
        </tbody>
      </table></div>`;
  }

  async function upload(files) {
    if (!files.length) return;
    const form = new FormData();
    form.append('path', cwd);
    let total = 0;
    for (const f of files) {
      form.append('files', f, f.name);
      total += f.size;
    }
    toast(`Uploading ${files.length} file(s), ${fmtBytes(total)}…`);
    try {
      await api(`${base}/files/upload`, { method: 'POST', form });
      toast('Upload complete', 'ok');
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function openEditor(path) {
    let content;
    try {
      content = (await api(`${base}/files/read?path=${encodeURIComponent(path)}`)).content;
    } catch (err) {
      return toast(err.message, 'error');
    }
    const body = document.createElement('div');
    body.innerHTML = `<textarea spellcheck="false" style="width:100%;height:62vh;white-space:pre;tab-size:4"></textarea>`;
    const ta = body.querySelector('textarea');
    ta.value = content;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end');
      }
    });
    modal({
      title: path,
      wide: true,
      body,
      actions: [
        { label: 'Close' },
        {
          label: 'Save',
          className: 'btn-primary',
          onClick: async () => {
            await api(`${base}/files/write`, { method: 'POST', body: { path, content: ta.value } });
            toast('Saved', 'ok');
            load();
          },
        },
      ],
    });
  }

  const input = el.querySelector('#upload');
  input.addEventListener('change', () => {
    upload([...input.files]);
    input.value = '';
  });
  const drop = el.querySelector('#drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('drop-hint');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drop-hint'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drop-hint');
    upload([...e.dataTransfer.files]);
  });
  el.querySelector('#goto').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) load(e.target.value.trim());
  });

  onAction(el, {
    go: ({ path }) => load(path),
    home: async () => load((await api(`${base}/files/home`)).path),
    refresh: () => load(),
    open: ({ path }) => openEditor(path),
    newFolder: async () => {
      const v = await formDialog({ title: 'New folder', fields: [{ name: 'name', label: 'Folder name' }], submitLabel: 'Create' });
      if (v?.name) await run(null, () => api(`${base}/files/mkdir`, { method: 'POST', body: { path: join(cwd, v.name) } })).then(() => load());
    },
    newFile: async () => {
      const v = await formDialog({ title: 'New file', fields: [{ name: 'name', label: 'File name', placeholder: 'index.html' }], submitLabel: 'Create' });
      if (!v?.name) return;
      const path = join(cwd, v.name);
      const ok = await run(null, () => api(`${base}/files/touch`, { method: 'POST', body: { path } }));
      if (ok) {
        await load();
        openEditor(path);
      }
    },
    rename: async ({ i }) => {
      const e = entries[i];
      const v = await formDialog({ title: `Rename ${e.name}`, fields: [{ name: 'name', label: 'New name (or full path to move)', value: e.name }], submitLabel: 'Rename' });
      if (!v?.name || v.name === e.name) return;
      const to = v.name.startsWith('/') ? v.name : join(cwd, v.name);
      await run(null, () => api(`${base}/files/rename`, { method: 'POST', body: { from: join(cwd, e.name), to } }), 'Renamed');
      load();
    },
    delete: async ({ i }) => {
      const e = entries[i];
      if (!(await confirmDialog(`Delete ${e.type === 'dir' ? 'folder' : 'file'} "${e.name}"${e.type === 'dir' ? ' and everything inside it' : ''}? This cannot be undone.`, { danger: true, confirmLabel: 'Delete' }))) return;
      await run(null, () => api(`${base}/files/delete`, { method: 'POST', body: { paths: [join(cwd, e.name)] } }), 'Deleted');
      load();
    },
    chmod: async ({ i }) => {
      const e = entries[i];
      const v = await formDialog({
        title: `Permissions for ${e.name}`,
        fields: [
          { name: 'mode', label: 'Mode', value: e.mode, help: '644 = files readable by everyone, 755 = folders/scripts, 600 = private' },
          { name: 'owner', label: 'Owner (user or user:group)', value: `${e.owner}:${e.group}` },
          ...(e.type === 'dir' ? [{ name: 'recursive', label: 'Apply to everything inside', type: 'checkbox' }] : []),
        ],
      });
      if (!v) return;
      const path = join(cwd, e.name);
      if (v.mode !== e.mode) await run(null, () => api(`${base}/files/chmod`, { method: 'POST', body: { path, mode: v.mode, recursive: v.recursive } }));
      if (v.owner !== `${e.owner}:${e.group}`) await run(null, () => api(`${base}/files/chown`, { method: 'POST', body: { path, owner: v.owner, recursive: v.recursive } }));
      load();
    },
    extract: async ({ path }, btn) => {
      await run(btn, () => api(`${base}/files/extract`, { method: 'POST', body: { path } }), 'Extracted');
      load();
    },
  });

  load();
}
