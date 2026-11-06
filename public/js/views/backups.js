// Backups: automatic and on-demand backups of databases, website/app folders and server settings,
// kept on the server and optionally in cloud storage, with restore.
import { api, esc, toast, run, modal, confirmDialog, showJob, onAction, loadingHtml, errorHtml, fmtBytes } from '../ui.js';

const EVERY = { '6h': 'Every 6 hours', '12h': 'Every 12 hours', day: 'Every day', week: 'Every week' };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TYPE_LABEL = { mongo: 'MongoDB', mysql: 'MySQL', files: 'Folder', settings: 'Settings' };
const STATUS = { success: ['ok', 'complete'], partial: ['warn', 'incomplete'], failed: ['bad', 'failed'], running: ['', 'running…'] };

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const pill = (status) => `<span class="badge ${STATUS[status]?.[0] || ''}">${STATUS[status]?.[1] || esc(status)}</span>`;

export async function render(el, { server }) {
  const base = `/servers/${server.id}/backups`;
  el.innerHTML = `<div class="page-head"><div><h1>Backups</h1><div class="sub">Copies of your databases, website folders and server settings, made on a schedule. Restore any of them in a few clicks.</div></div>
    <div class="row"><button class="btn" data-action="settings">Settings</button><button class="btn" data-action="drill" title="Restore the newest backup into temporary databases to prove it works. Nothing live is touched.">Test a restore</button><button class="btn-primary" data-action="now">Back up now</button></div></div>
    <div id="bk-status">${loadingHtml()}</div>
    <div id="bk-settings" class="hidden"></div>
    <div id="bk-list"></div>`;
  const statusEl = el.querySelector('#bk-status');
  const settingsEl = el.querySelector('#bk-settings');
  const listEl = el.querySelector('#bk-list');
  let info = null;
  let list = null;
  let alive = true;
  let poll = null;

  async function loadStatus() {
    info = await api(base);
    const last = info.state.last;
    const s = info.schedule;
    statusEl.innerHTML = `
      ${info.configured ? '' : `<div class="notice warn" style="margin-bottom:14px"><b>No backups are set up for ${esc(server.name)}.</b> If the server or a database is lost, the data is gone. <button class="btn-sm btn-primary" data-action="settings">Set up backups</button></div>`}
      <div class="grid bk-cards">
        <div class="card">
          <div class="small muted">Last backup</div>
          ${
            info.state.running
              ? `<h3 style="margin:6px 0">Running now…</h3><button class="btn-sm" data-action="job" data-id="${esc(info.state.running)}">Show progress</button>`
              : last
                ? `<h3 style="margin:6px 0">${ago(last.at)} ${pill(last.status)}</h3>
                   <div class="small muted">${when(last.at)} · ${fmtBytes(last.size)} · ${last.items} item(s)${last.uploaded ? ' · copied to the cloud' : ''}</div>
                   ${last.error ? `<div class="small" style="color:var(--${last.status === 'failed' ? 'bad' : 'warn'});margin-top:6px">${esc(last.error)}</div>` : ''}
                   ${last.job ? `<button class="btn-sm btn-ghost" style="margin-top:6px" data-action="job" data-id="${esc(last.job)}">Log</button>` : ''}`
                : '<h3 style="margin:6px 0">Never</h3><div class="small muted">Click Back up now to make the first one.</div>'
          }
        </div>
        <div class="card">
          <div class="small muted">Next backup</div>
          ${
            info.enabled
              ? `<h3 style="margin:6px 0">${when(info.nextRun)}</h3><div class="small muted">${EVERY[s.every]}${s.every === 'week' ? ` on ${DAYS[s.weekday]}` : ''} at ${esc(s.time)} (${esc(s.tz)})</div>`
              : `<h3 style="margin:6px 0">Not scheduled</h3><div class="small muted">Automatic backups are off.</div>`
          }
        </div>
        <div class="card">
          <div class="small muted">Stored</div>
          <h3 style="margin:6px 0">${info.remote.type === 'none' ? 'On this server only' : esc(info.remoteLabel)}</h3>
          <div class="small muted">Keeps the last ${info.keepLocal} on the server${info.remote.type === 'none' ? '' : ` and ${info.keepRemote} in the cloud`}</div>
          ${info.remote.type === 'none' ? '<div class="small" style="color:var(--warn);margin-top:6px">If the server is lost, its backups are lost too. Add cloud storage in Settings.</div>' : ''}
        </div>
        ${drillCard(info)}
      </div>`;
    clearTimeout(poll);
    if (info.state.running && alive) poll = setTimeout(() => refresh(), 5000);
  }

  // Last automatic or manual test-restore: proof that the backups really work.
  function drillCard(i) {
    const d = i.state.lastDrill;
    const plan = i.drill === 'off' ? 'Automatic tests are off.' : `Tested automatically every ${i.drill} after a scheduled backup.`;
    if (!d) return `<div class="card"><div class="small muted">Last test-restore</div><h3 style="margin:6px 0">Never tested</h3><div class="small muted">${plan} A backup you have never restored may not work when you need it.</div></div>`;
    const okItems = (d.items || []).filter((x) => x.ok);
    return `<div class="card"><div class="small muted">Last test-restore</div>
      <h3 style="margin:6px 0">${ago(d.at)} ${d.status === 'success' ? '<span class="badge ok">worked</span>' : '<span class="badge bad">failed</span>'}</h3>
      <div class="small muted">Backup ${d.backupId ? when(`${d.backupId.slice(0, 4)}-${d.backupId.slice(4, 6)}-${d.backupId.slice(6, 8)}T${d.backupId.slice(9, 11)}:${d.backupId.slice(11, 13)}:00Z`) : '?'} from the ${d.source === 'cloud' ? 'cloud copy' : 'server copy'} · ${okItems.length} of ${(d.items || []).length} item(s) restored · ${d.seconds}s</div>
      ${d.error ? `<div class="small" style="color:var(--bad);margin-top:6px">${esc(d.error)}</div>` : ''}
      <div class="small muted" style="margin-top:4px">${plan}</div>
      ${d.job ? `<button class="btn-sm btn-ghost" style="margin-top:6px" data-action="job" data-id="${esc(d.job)}">Details</button>` : ''}</div>`;
  }

  async function loadList() {
    listEl.innerHTML = loadingHtml();
    try {
      list = await api(`${base}/list`);
    } catch (err) {
      listEl.innerHTML = errorHtml(err);
      return;
    }
    listEl.innerHTML = `<div class="card flush" style="margin-top:16px">
      <div class="card-head"><h3 style="margin:0">Backups</h3><span class="small muted">${list.backups.length} · on the server in ${esc(list.root)}</span></div>
      ${list.cloudError ? `<div class="notice warn" style="margin:0 16px 12px">Cloud storage could not be listed: ${esc(list.cloudError)}</div>` : ''}
      <div class="table-wrap"><table><thead><tr><th>When</th><th>What</th><th>Size</th><th>Where</th><th>Status</th><th></th></tr></thead><tbody>
      ${
        list.backups
          .map(
            (b, i) => `<tr>
          <td><b>${when(b.at)}</b><div class="small muted mono">${esc(b.id)}</div></td>
          <td class="small">${summarize(b.items)}</td>
          <td class="small">${fmtBytes(b.size)}</td>
          <td>${b.onServer ? '<span class="badge">server</span>' : ''} ${b.inCloud ? '<span class="badge ok">cloud</span>' : info.remote.type !== 'none' ? '<span class="badge warn" title="The copy to cloud storage failed or was not made">not in cloud</span>' : ''}</td>
          <td>${pill(b.status)}</td>
          <td class="actions">${b.items.some((it) => it.file) ? `<button class="btn-sm btn-primary" data-action="restore" data-i="${i}">Restore…</button>` : ''}<button class="btn-sm btn-danger" data-action="delete" data-i="${i}">Delete</button></td>
        </tr>`,
          )
          .join('') || '<tr><td colspan="6" class="empty">No backups yet.</td></tr>'
      }
      </tbody></table></div></div>`;
  }

  function summarize(items) {
    const by = {};
    for (const it of items) (by[it.type] ||= []).push(it);
    return Object.entries(by)
      .map(([t, xs]) => {
        const bad = xs.filter((x) => x.error).length;
        return `<span class="chip">${TYPE_LABEL[t] || t}${t === 'settings' ? '' : ` ${xs.length}`}${bad ? ` <span style="color:var(--bad)">(${bad} failed)</span>` : ''}</span>`;
      })
      .join(' ');
  }

  const refresh = async () => {
    if (!alive) return;
    try {
      await loadStatus();
    } catch (err) {
      statusEl.innerHTML = errorHtml(err);
    }
    loadList();
  };

  // ---------- settings ----------
  async function openSettings() {
    settingsEl.classList.remove('hidden');
    settingsEl.innerHTML = `<div class="card" style="margin-top:16px">${loadingHtml()}</div>`;
    settingsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    let inv;
    try {
      inv = await api(`${base}/inventory`);
    } catch (err) {
      settingsEl.innerHTML = `<div class="card" style="margin-top:16px">${errorHtml(err)}</div>`;
      return;
    }
    const s = info.configured ? info : { ...info, enabled: true, schedule: { ...info.schedule, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } };
    const inc = s.include;
    const r = s.remote;
    const listPick = (kind, items, chosen, unit) =>
      !items
        ? `<div class="small muted">Not installed on this server.</div>`
        : !items.length
          ? '<div class="small muted">None found.</div>'
          : `<label class="check"><input type="radio" name="${kind}Mode" value="all" ${chosen === 'all' ? 'checked' : ''}> All ${unit} (new ones are included automatically)</label>
             <label class="check"><input type="radio" name="${kind}Mode" value="some" ${chosen === 'all' ? '' : 'checked'}> Only these:</label>
             <div class="bk-pick">${items.map((x) => `<label class="check"><input type="checkbox" name="${kind}Item" value="${esc(x.name)}" ${chosen === 'all' || chosen.includes(x.name) ? 'checked' : ''}> <span class="mono">${esc(x.name)}</span> <span class="muted small">${fmtBytes(x.size)}</span></label>`).join('')}</div>`;
    settingsEl.innerHTML = `<form class="card" id="bk-form" style="margin-top:16px">
      <div class="card-head" style="padding:0 0 10px"><h3 style="margin:0">Backup settings</h3><span class="small muted">Free disk space now: ${fmtBytes(inv.free)}</span></div>
      <div class="grid grid-2" style="align-items:start">
        <div>
          <h4>When</h4>
          <label class="check"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}> Back up automatically</label>
          <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">
            <select name="every">${Object.entries(EVERY).map(([k, v]) => `<option value="${k}" ${s.schedule.every === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
            <select name="weekday" class="${s.schedule.every === 'week' ? '' : 'hidden'}">${DAYS.map((d, i) => `<option value="${i}" ${Number(s.schedule.weekday) === i ? 'selected' : ''}>${d}</option>`).join('')}</select>
            <span>at</span><input name="time" type="time" value="${esc(s.schedule.time)}" style="width:auto">
          </div>
          <label class="field" style="margin-top:8px"><span>Time zone</span><input name="tz" value="${esc(s.schedule.tz)}" list="bk-tz"><datalist id="bk-tz">${['UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York', Intl.DateTimeFormat().resolvedOptions().timeZone].filter((v, i, a) => v && a.indexOf(v) === i).map((z) => `<option value="${esc(z)}">`).join('')}</datalist><small>Pick a quiet time, like 3:00 at night.</small></label>
          <h4>Keep</h4>
          <div class="row" style="gap:8px;flex-wrap:wrap"><label class="field" style="flex:1;min-width:140px"><span>On the server</span><input name="keepLocal" type="number" min="1" max="90" value="${s.keepLocal}"><small>newest backups</small></label>
          <label class="field" style="flex:1;min-width:140px"><span>In the cloud</span><input name="keepRemote" type="number" min="1" max="365" value="${s.keepRemote}"><small>newest backups</small></label></div>
          <h4>Test-restore</h4>
          <label class="field"><span>Prove the backups work</span><select name="drill">${[['week', 'Every week (recommended)'], ['month', 'Every month'], ['off', 'Off']].map(([v, l]) => `<option value="${v}" ${s.drill === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <small>After a scheduled backup, Serverboy restores it into temporary databases (from the cloud copy if there is one), checks the data can be read, then deletes them. Your live data is never touched.</small></label>
        </div>
        <div>
          <h4>What</h4>
          <label class="check"><input type="checkbox" name="mongo" ${inc.mongo ? 'checked' : ''}> <b>MongoDB databases</b></label>
          <div class="bk-sub">${inv.mongoError ? `<div class="small" style="color:var(--warn)">Could not list MongoDB: ${esc(inv.mongoError)}</div>` : listPick('mongo', inv.mongo, inc.mongoDbs, 'databases')}${inv.mongo && !inv.mongodump ? '<div class="small" style="color:var(--bad)">mongodump is missing: install the MongoDB database tools.</div>' : ''}</div>
          <label class="check"><input type="checkbox" name="mysql" ${inc.mysql ? 'checked' : ''}> <b>MySQL / MariaDB databases</b></label>
          <div class="bk-sub">${inv.mysqlError ? `<div class="small" style="color:var(--warn)">MySQL is installed but not answering, so it cannot be backed up: ${esc(inv.mysqlError)}. Start it under Services.</div>` : listPick('mysql', inv.mysql, inc.mysqlDbs, 'databases')}</div>
          <label class="check"><input type="checkbox" name="files" ${inc.files ? 'checked' : ''}> <b>Website and app folders</b> <span class="muted small">(/var/www)</span></label>
          <div class="bk-sub">${listPick('files', inv.files, inc.fileDirs, 'folders')}
            <label class="check small"><input type="checkbox" name="skipNodeModules" ${inc.skipNodeModules ? 'checked' : ''}> Skip node_modules (re-installed on deploy; saves a lot of space)</label></div>
          <label class="check"><input type="checkbox" name="settings" ${inc.settings ? 'checked' : ''}> <b>Server settings</b></label>
          <span class="muted small bk-hint">Nginx sites, SSL certificates, PM2 app list, firewall rules, crontabs</span>
        </div>
      </div>
      <h4>Cloud copy</h4>
      <p class="small muted" style="margin-top:0">Recommended. A copy in the cloud survives if the server is deleted, hacked or its disk fails. The keys stay in Serverboy; the server gets short-lived upload links.</p>
      <div class="row" style="gap:14px;flex-wrap:wrap">
        <label class="check"><input type="radio" name="rtype" value="none" ${r.type === 'none' ? 'checked' : ''}> None (server only)</label>
        <label class="check"><input type="radio" name="rtype" value="s3" ${r.type === 's3' ? 'checked' : ''}> S3-compatible <span class="muted small">AWS S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO</span></label>
        <label class="check"><input type="radio" name="rtype" value="azure" ${r.type === 'azure' ? 'checked' : ''}> Azure Blob Storage</label>
      </div>
      <div id="bk-s3" class="grid grid-2 ${r.type === 's3' ? '' : 'hidden'}" style="margin-top:8px">
        <label class="field"><span>Endpoint</span><input name="endpoint" value="${esc(r.endpoint || '')}" placeholder="empty for AWS · https://ACCOUNT.r2.cloudflarestorage.com · https://s3.eu-central-003.backblazeb2.com"></label>
        <label class="field"><span>Region</span><input name="region" value="${esc(r.region || '')}" placeholder="us-east-1 (R2: auto)"></label>
        <label class="field"><span>Bucket</span><input name="bucket" value="${esc(r.bucket || '')}" placeholder="my-backups"></label>
        <label class="field"><span>Folder in the bucket (optional)</span><input name="prefix" value="${esc(r.prefix || '')}" placeholder="serverboy"></label>
        <label class="field"><span>Access key ID</span><input name="accessKeyId" value="${esc(r.accessKeyId || '')}" autocomplete="off"></label>
        <label class="field"><span>Secret access key</span><input name="secretAccessKey" type="password" autocomplete="new-password" placeholder="${info.remoteSecretSet && r.type === 's3' ? 'saved (leave empty to keep)' : ''}"></label>
      </div>
      <div id="bk-azure" class="${r.type === 'azure' ? '' : 'hidden'}" style="margin-top:8px">
        <label class="field"><span>Container SAS URL</span><input name="sasUrl" type="password" autocomplete="off" placeholder="${info.remoteSecretSet && r.type === 'azure' ? 'saved (leave empty to keep)' : 'https://ACCOUNT.blob.core.windows.net/backups?sv=…&sig=…'}">
          <small>Azure portal → Storage account → Containers → your container → Shared access tokens. Allow Read, Add, Create, Write, Delete and List, and set a far expiry date.</small></label>
        <label class="field"><span>Folder in the container (optional)</span><input name="aprefix" value="${esc(r.type === 'azure' ? r.prefix || '' : '')}" placeholder="serverboy"></label>
      </div>
      <div class="row" style="margin-top:14px;gap:8px">
        <button class="btn-primary" type="submit">Save settings</button>
        <button type="button" class="btn" data-action="testStorage" id="bk-test" ${r.type === 'none' ? 'disabled' : ''}>Test cloud storage</button>
        <button type="button" class="btn-ghost" data-action="closeSettings">Cancel</button>
      </div>
    </form>`;
    const f = settingsEl.querySelector('#bk-form');
    const showType = () => {
      const t = f.rtype.value;
      f.querySelector('#bk-s3').classList.toggle('hidden', t !== 's3');
      f.querySelector('#bk-azure').classList.toggle('hidden', t !== 'azure');
      f.querySelector('#bk-test').disabled = t === 'none';
    };
    f.addEventListener('change', (e) => {
      if (e.target.name === 'rtype') showType();
      if (e.target.name === 'every') f.weekday.classList.toggle('hidden', e.target.value !== 'week');
      if (e.target.name?.endsWith('Item')) {
        const kind = e.target.name.slice(0, -4);
        const some = f.querySelector(`input[name=${kind}Mode][value=some]`);
        if (some) some.checked = true;
      }
    });
    f.addEventListener('submit', async () => {
      const body = formBody(f);
      if (!body) return;
      const saved = await run(f.querySelector('[type=submit]'), () => api(`${base}/settings`, { method: 'PUT', body }), 'Backup settings saved');
      if (saved) {
        settingsEl.classList.add('hidden');
        refresh();
      }
    });
  }

  function remoteFromForm(f) {
    const t = f.rtype.value;
    if (t === 's3') return { type: 's3', endpoint: f.endpoint.value, region: f.region.value, bucket: f.bucket.value, prefix: f.prefix.value, accessKeyId: f.accessKeyId.value, secretAccessKey: f.secretAccessKey.value };
    if (t === 'azure') return { type: 'azure', sasUrl: f.sasUrl.value, prefix: f.aprefix.value };
    return { type: 'none' };
  }

  function formBody(f) {
    const chosen = (kind) => {
      const mode = f.querySelector(`input[name=${kind}Mode]:checked`)?.value || 'all';
      if (mode === 'all') return 'all';
      return [...f.querySelectorAll(`input[name=${kind}Item]:checked`)].map((i) => i.value);
    };
    const body = {
      enabled: f.enabled.checked,
      schedule: { every: f.every.value, time: f.time.value, weekday: Number(f.weekday.value), tz: f.tz.value.trim() },
      include: { mongo: f.mongo.checked, mongoDbs: chosen('mongo'), mysql: f.mysql.checked, mysqlDbs: chosen('mysql'), files: f.files.checked, fileDirs: chosen('files'), skipNodeModules: f.skipNodeModules.checked, settings: f.settings.checked },
      keepLocal: Number(f.keepLocal.value),
      keepRemote: Number(f.keepRemote.value),
      drill: f.drill.value,
      remote: remoteFromForm(f),
    };
    if (!body.include.mongo && !body.include.mysql && !body.include.files && !body.include.settings) {
      toast('Choose at least one thing to back up', 'error');
      return null;
    }
    return body;
  }

  // ---------- restore ----------
  function openRestore(b) {
    const items = b.items.filter((it) => it.file);
    const dl = (it) => `/api${base}/${encodeURIComponent(b.id)}/download/${encodeURIComponent(it.file)}`;
    const row = (it, i) => {
      let opts = '';
      if (it.type === 'mongo')
        opts = `<select data-mode="${i}"><option value="replace">Replace the current data</option><option value="merge">Only add missing documents</option></select>
          <label class="small">into database <input data-target="${i}" value="${esc(it.name)}" class="mono" style="width:160px"></label>`;
      else if (it.type === 'mysql')
        opts = `<select data-mode="${i}"><option value="replace">Replace the current data</option><option value="merge">Import into it</option></select>
          <label class="small">into database <input data-target="${i}" value="${esc(it.name)}" class="mono" style="width:160px"></label>`;
      else if (it.type === 'files') opts = `<select data-mode="${i}"><option value="alongside">Restore next to it (new folder)</option><option value="replace">Replace the current folder</option></select>`;
      else opts = '<span class="small muted">Unpacked into a folder on the server to copy from. Nothing live is changed.</span>';
      return `<div class="bk-restore-row">
        <label class="check"><input type="checkbox" data-pick="${i}"> <b>${TYPE_LABEL[it.type]}</b> <span class="mono">${esc(it.type === 'settings' ? '' : it.name)}</span> <span class="muted small">${fmtBytes(it.size)}${it.parts ? ` · ${it.parts} parts` : ''}</span></label>
        <div class="row" style="gap:8px;flex-wrap:wrap;margin:4px 0 0 26px">${opts}${it.parts ? '' : `<a class="btn btn-sm btn-ghost" href="${dl(it)}" download>⬇ Download</a>`}</div>
      </div>`;
    };
    modal({
      title: `Restore from ${when(b.at)}`,
      wide: true,
      body: `<p class="small muted" style="margin-top:0">Tick what to restore. Before anything is replaced, Serverboy saves a safety copy of the current data in ${esc(list.root)}/safety (kept 14 days).${b.onServer ? '' : ' This backup is only in the cloud; it is downloaded to the server first.'}</p>
        ${items.map(row).join('')}`,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Restore',
          className: 'btn-primary',
          onClick: async ({ body: mb }) => {
            const chosen = items
              .map((it, i) => ({ it, i }))
              .filter(({ i }) => mb.querySelector(`[data-pick="${i}"]`).checked)
              .map(({ it, i }) => ({ file: it.file, mode: mb.querySelector(`[data-mode="${i}"]`)?.value, target: mb.querySelector(`[data-target="${i}"]`)?.value.trim() || undefined }));
            if (!chosen.length) {
              toast('Tick at least one item', 'error');
              return false;
            }
            const replacing = chosen.filter((c) => c.mode === 'replace');
            if (replacing.length && !(await confirmDialog(`Replace ${replacing.length} item(s) with the backup from ${when(b.at)}? A safety copy of the current data is taken first.`, { danger: true, confirmLabel: 'Replace' }))) return false;
            const job = await api(`${base}/${encodeURIComponent(b.id)}/restore`, { method: 'POST', body: { items: chosen } });
            showJob(server.id, job, { onDone: refresh });
          },
        },
      ],
    });
  }

  onAction(el, {
    drill: async (d, btn) => {
      const job = await run(btn, () => api(`${base}/drill`, { method: 'POST', body: {} }));
      if (job) {
        showJob(server.id, job, { onDone: refresh });
        refresh();
      }
    },
    now: async (d, btn) => {
      const job = await run(btn, () => api(`${base}/run`, { method: 'POST' }));
      if (job) {
        showJob(server.id, job, { onDone: refresh });
        refresh();
      }
    },
    settings: () => openSettings(),
    closeSettings: () => settingsEl.classList.add('hidden'),
    testStorage: async (d, btn) => {
      const f = settingsEl.querySelector('#bk-form');
      const r = await run(btn, () => api(`${base}/test-storage`, { method: 'POST', body: { remote: remoteFromForm(f) } }));
      if (r) toast(`Cloud storage works: ${r.label}. Serverboy and the server can both write to it.`, 'ok', 7000);
    },
    job: ({ id }) => showJob(server.id, { id, title: 'Backup' }),
    restore: ({ i }) => openRestore(list.backups[i]),
    delete: async ({ i }) => {
      const b = list.backups[i];
      const where = b.onServer && b.inCloud ? 'both' : b.onServer ? 'server' : 'cloud';
      if (!(await confirmDialog(`Delete the backup from ${when(b.at)}${where === 'both' ? ' from the server and from cloud storage' : where === 'cloud' ? ' from cloud storage' : ''}? This cannot be undone.`, { danger: true, confirmLabel: 'Delete' }))) return;
      const ok = await run(null, () => api(`${base}/${encodeURIComponent(b.id)}?where=${where}`, { method: 'DELETE' }), 'Backup deleted');
      if (ok) loadList();
    },
  });

  await refresh();
  return () => {
    alive = false;
    clearTimeout(poll);
  };
}
