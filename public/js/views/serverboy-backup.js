// Administration → Settings → Serverboy backup: copies of Serverboy's own data (servers and their
// encrypted logins, settings, team), encrypted with a passphrase; automatic daily cloud copies;
// restore from a file or from the cloud.
import { api, esc, run, toast, confirmDialog, onAction, loadingHtml, errorHtml, fmtBytes, viewAsToken } from '../ui.js';

const MIN = 12;
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export async function mountSelfBackup(el) {
  el.innerHTML = `<div class="card" style="max-width:780px">${loadingHtml()}</div>`;
  let info;
  try {
    info = await api('/serverboy-backup');
  } catch (err) {
    el.innerHTML = `<div class="card" style="max-width:780px">${errorHtml(err)}</div>`;
    return;
  }
  const last = info.last;
  el.innerHTML = `<div class="card" style="max-width:780px">
    <h2>Serverboy backup</h2>
    <p class="muted" style="margin-top:0">Your list of servers with their SSH logins, all Serverboy settings (including backup settings) and the team: users, roles, messages and the activity log. If the machine running Serverboy is lost, this is what brings it back in a few minutes instead of re-adding every server and person.</p>
    <div class="notice small" style="margin-bottom:14px">The file is encrypted with a passphrase you choose, because it contains the key to every stored server password and SSH key. <b>Write the passphrase down somewhere safe.</b> Without it nobody can open the file, including you.</div>
    ${info.usesEnvSecret ? '<div class="notice warn small" style="margin-bottom:14px">This Serverboy uses SERVERBOY_SECRET from /etc/serverboy.env. Keep a copy of that value too: a restore needs the same one.</div>' : ''}

    <h3>Automatic daily copy</h3>
    ${
      last
        ? `<div class="small" style="margin-bottom:8px">Last copy: <b>${when(last.at)}</b> ${last.status === 'success' ? `<span class="badge ok">done</span> ${fmtBytes(last.size)} · ${last.servers} server(s) · ${last.users ?? '–'} user(s) · ${esc(last.where)}` : `<span class="badge bad">failed</span> ${esc(last.error || '')}`}</div>`
        : '<div class="small muted" style="margin-bottom:8px">No automatic copy yet.</div>'
    }
    <form id="sb-auto">
      <label class="check"><input type="checkbox" name="enabled" ${info.enabled ? 'checked' : ''}> Copy Serverboy's data to cloud storage every day</label>
      <div class="grid grid-2" style="margin-top:8px">
        <label class="field"><span>Passphrase</span><input name="passphrase" type="password" autocomplete="new-password" placeholder="${info.passphraseSet ? 'saved (leave empty to keep)' : `at least ${MIN} characters`}"></label>
        <label class="field"><span>Passphrase again</span><input name="passphrase2" type="password" autocomplete="new-password"></label>
        <label class="field"><span>Keep it in</span>${
          info.storages.length
            ? `<select name="storageFrom"><option value="">Choose…</option>${info.storages.map((x) => `<option value="${esc(x.id)}" ${info.storageFrom === x.id ? 'selected' : ''}>${esc(x.label)} (cloud storage of ${esc(x.name)})</option>`).join('')}</select><small>Stored in its _serverboy folder.</small>`
            : '<div class="small muted">Set up cloud storage in a server\'s Backups → Settings first; it is reused here.</div><input type="hidden" name="storageFrom" value="">'
        }</label>
        <label class="field"><span>Keep</span><input name="keep" type="number" min="1" max="90" value="${info.keep}"><small>newest daily copies</small></label>
      </div>
      <div class="row"><button class="btn-primary" type="submit">Save</button><button type="button" class="btn" data-action="copyNow" ${info.enabled ? '' : 'disabled'}>Copy now</button></div>
    </form>

    <h3 style="margin-top:22px">Download a copy</h3>
    <form id="sb-dl" class="row" style="gap:8px;align-items:flex-end;flex-wrap:wrap">
      <label class="field" style="flex:1;min-width:220px;margin:0"><span>Passphrase for this file</span><input name="passphrase" type="password" autocomplete="new-password" placeholder="at least ${MIN} characters"></label>
      <button class="btn" type="submit">⬇ Download .sbbackup</button>
    </form>

    <h3 style="margin-top:22px">Restore Serverboy</h3>
    <p class="small muted" style="margin-top:0">For a new or broken Serverboy: install it, log in as admin, then restore here. Everything in this Serverboy is replaced by the backup (the current data is kept in a before-restore folder), and Serverboy restarts. Everyone logs in again; the owner uses the admin password of this installation (from /etc/serverboy.env), and team members keep theirs.</p>
    <form id="sb-restore">
      <div class="grid grid-2">
        <label class="field"><span>Backup file</span><input name="file" type="file" accept=".sbbackup"></label>
        <label class="field"><span>…or a copy from the cloud</span><select name="cloud"><option value="">${info.storageFrom ? 'Loading…' : 'No cloud storage chosen'}</option></select></label>
        <label class="field"><span>Passphrase</span><input name="passphrase" type="password" autocomplete="off"></label>
      </div>
      <div class="row"><button class="btn" type="submit">Check the backup</button></div>
      <div id="sb-preview"></div>
    </form>
  </div>`;

  const auto = el.querySelector('#sb-auto');
  const dl = el.querySelector('#sb-dl');
  const rs = el.querySelector('#sb-restore');
  const previewEl = el.querySelector('#sb-preview');

  if (info.storageFrom) {
    api('/serverboy-backup/cloud')
      .then((list) => {
        rs.cloud.innerHTML = `<option value="">${list.length ? 'Choose a copy…' : 'No copies yet'}</option>${list.map((c) => `<option value="${esc(c.name)}">${esc(c.name.replace(/^serverboy-|\.sbbackup$/g, ''))} · ${fmtBytes(c.size)}</option>`).join('')}`;
      })
      .catch((err) => {
        rs.cloud.innerHTML = `<option value="">Could not list: ${esc(err.message)}</option>`;
      });
  }

  auto.addEventListener('submit', async () => {
    const p = auto.passphrase.value;
    if (p && p.length < MIN) return toast(`The passphrase must be at least ${MIN} characters`, 'error');
    if (p !== auto.passphrase2.value) return toast('The two passphrases are different', 'error');
    const ok = await run(auto.querySelector('[type=submit]'), () => api('/serverboy-backup/settings', { method: 'PUT', body: { enabled: auto.enabled.checked, passphrase: p || undefined, storageFrom: auto.storageFrom.value || null, keep: Number(auto.keep.value) } }), 'Saved');
    if (ok) mountSelfBackup(el);
  });

  dl.addEventListener('submit', async () => {
    const p = dl.passphrase.value;
    if (p.length < MIN) return toast(`Use a passphrase of at least ${MIN} characters`, 'error');
    const btn = dl.querySelector('button');
    btn.disabled = true;
    try {
      const headers = { 'x-serverboy': '1', 'content-type': 'application/json' };
      if (viewAsToken()) headers['x-serverboy-session'] = viewAsToken();
      const res = await fetch('/api/serverboy-backup/file', { method: 'POST', headers, body: JSON.stringify({ passphrase: p }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status}`);
      const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'serverboy.sbbackup';
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast('Downloaded. Keep the file and the passphrase in different places.', 'ok', 7000);
      dl.reset();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  const body = () => {
    const file = rs.file.files[0];
    if (file) {
      const form = new FormData();
      form.append('file', file);
      form.append('passphrase', rs.passphrase.value);
      return { form };
    }
    if (rs.cloud.value) return { body: { cloud: rs.cloud.value, passphrase: rs.passphrase.value } };
    return null;
  };

  rs.addEventListener('submit', async () => {
    const b = body();
    if (!b) return toast('Choose a backup file or a cloud copy', 'error');
    const p = await run(rs.querySelector('[type=submit]'), () => api('/serverboy-backup/preview', { method: 'POST', ...b }));
    if (!p) return;
    previewEl.innerHTML = `<div class="notice" style="margin-top:12px">
      <b>Backup from ${when(p.createdAt)}</b> (Serverboy ${esc(p.serverboyVersion)})<br>
      ${p.servers.length} server(s): ${esc(p.servers.join(', ') || 'none')}<br>
      ${p.users === null ? 'No team database in this backup.' : `${p.users} user(s), ${p.roles} role(s), ${p.messages} message(s), ${p.activity} activity entries.`}
      ${p.usesEnvSecret ? '<br><b>Made with SERVERBOY_SECRET set: the same value must be in /etc/serverboy.env.</b>' : ''}
      <div class="row" style="margin-top:10px"><button type="button" class="btn-danger" data-action="doRestore">Replace everything and restart</button></div></div>`;
  });

  onAction(el, {
    copyNow: async (d, btn) => {
      const r = await run(btn, () => api('/serverboy-backup/run', { method: 'POST' }));
      if (r) {
        toast(`Copied to ${r.where}`, 'ok');
        mountSelfBackup(el);
      }
    },
    doRestore: async (d, btn) => {
      if (!(await confirmDialog('Replace all of Serverboy\'s data (servers, settings, team) with this backup? Serverboy restarts and everyone logs in again.', { danger: true, confirmLabel: 'Restore and restart' }))) return;
      const b = body();
      const r = await run(btn, () => api('/serverboy-backup/restore', { method: 'POST', ...b }));
      if (!r) return;
      previewEl.innerHTML = `<div class="notice ok" style="margin-top:12px">${r.log.map(esc).join('<br>')}<br><b>Restarting Serverboy…</b> ${r.underSystemd ? 'This page reloads when it is back.' : 'It was not started by systemd, so start it again yourself (npm start), then reload.'}</div>`;
      if (r.underSystemd) waitAndReload();
    },
  });
}

// Wait for the restart, then reload (the user logs in again: sessions were reset).
function waitAndReload() {
  let tries = 0;
  const t = setInterval(async () => {
    tries++;
    try {
      const res = await fetch('/api/me', { cache: 'no-store' });
      if (res.ok && tries > 2) {
        clearInterval(t);
        location.reload();
      }
    } catch {
      /* still restarting */
    }
    if (tries > 90) clearInterval(t);
  }, 2000);
}
