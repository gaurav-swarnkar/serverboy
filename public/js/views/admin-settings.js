import { api, esc, run, toast, confirmDialog, onAction, loadingHtml, errorHtml, fmtDate } from '../ui.js';
import { check as checkUpdates } from '../updates.js';
import { adminHead, changeConnection, requireTeamDb } from './admin-common.js';

export async function render(el, { servers }) {
  el.innerHTML = `${adminHead('Settings', 'Where team accounts are stored, updates and messages to the team, and how the owner login works.')}<div id="db"></div>
    <div id="updates" style="margin-top:16px"></div>
    <div class="card" style="margin-top:16px;max-width:780px">
      <h2>Owner login</h2>
      <p class="muted" style="margin-top:0">You log in as <b>admin</b>. This login is stored by Serverboy itself, not in MongoDB, so it keeps working even if the database is down.</p>
      <ul class="muted small" style="padding-left:18px;margin:0">
        <li>Change your password under <a href="#/account">My account</a>.</li>
        <li>Forgot it? On the server, set <span class="mono">ADMIN_PASSWORD=</span> in <span class="mono">/etc/serverboy.env</span> and run <span class="mono">sudo systemctl restart serverboy</span>.</li>
      </ul>
    </div>`;
  const db = el.querySelector('#db');

  async function load() {
    db.innerHTML = loadingHtml();
    let info;
    try {
      info = await api('/team');
    } catch (err) {
      db.innerHTML = errorHtml(err);
      return;
    }
    const s = info.status;
    if (!s.connected) {
      // Same setup / error card as the other admin pages.
      await requireTeamDb(db, servers, load);
      return;
    }
    db.innerHTML = `
      <div class="card" style="max-width:780px">
        <h2>Team database</h2>
        <div class="row" style="margin-bottom:8px"><span class="badge ok">connected</span> MongoDB database <span class="mono">${esc(s.database)}</span> · ${s.users} user(s)</div>
        <p class="small muted">Holds users, roles and the activity log. The connection string is stored encrypted.</p>
        <div class="row"><button data-action="uri">Change connection</button><button class="btn-danger" data-action="disconnect">Disconnect</button></div>
      </div>`;
    onAction(db, {
      uri: () => changeConnection(load),
      disconnect: async () => {
        if (!(await confirmDialog('Disconnect the team database? Team members will not be able to log in. Their accounts stay in MongoDB and come back when you reconnect.', { danger: true, confirmLabel: 'Disconnect' }))) return;
        await run(null, () => api('/team/storage', { method: 'DELETE' }), 'Disconnected');
        load();
      },
    });
  }

  const upd = el.querySelector('#updates');
  async function loadUpdates() {
    upd.innerHTML = loadingHtml();
    let v;
    let c;
    try {
      [v, c] = await Promise.all([api('/version'), api('/team/clients')]);
    } catch (err) {
      upd.innerHTML = errorHtml(err);
      return;
    }
    const a = v.announcement;
    const old = c.clients.filter((x) => x.build !== v.build);
    upd.innerHTML = `
      <div class="card" style="max-width:780px">
        <h2>Updates and team message</h2>
        <table class="small"><tbody>
          <tr><td class="muted" style="width:170px">Running version</td><td><b>${esc(v.version)}</b> <span class="mono muted">build ${esc(v.build)}</span> · started ${fmtDate(v.startedAt)}</td></tr>
          <tr><td class="muted">Open in browsers (24 h)</td><td>${
            c.clients.length
              ? c.clients
                  .map((x) => `<div>${esc(x.name)} <span class="muted">(${esc(x.username)})</span> ${x.build === v.build ? '<span class="badge ok">up to date</span>' : '<span class="badge warn">needs refresh</span>'} <span class="muted">last seen ${fmtDate(new Date(x.at).toISOString())}</span></div>`)
                  .join('')
              : '<span class="muted">nobody yet</span>'
          }</td></tr>
        </tbody></table>
        <p class="small muted">After you update Serverboy, everyone with an older version open sees <b>"Serverboy was updated"</b> with what's new and a Refresh button, within about 2 minutes (at once on their next click).
        ${old.length ? `<b>${old.length}</b> ${old.length === 1 ? 'person still runs' : 'people still run'} an older version.` : ''}</p>
        <h3>Message to the team</h3>
        ${a ? `<div class="notice ${a.level === 'warn' ? 'warn' : ''}" style="margin-bottom:10px"><b>Showing now</b> (${a.audience === 'everyone' ? 'to everyone' : 'to people on an older version'}, since ${fmtDate(a.at)}): ${esc(a.text)}</div>` : ''}
        <form id="msg-form">
          <label class="field"><span>Message</span><textarea name="text" rows="3" maxlength="1000" placeholder="Serverboy was updated: please refresh. The new Import button is in Databases.">${esc(a?.text || '')}</textarea></label>
          <div class="form-grid">
            <label class="field"><span>Show to</span><select name="audience">
              <option value="outdated" ${a?.audience !== 'everyone' ? 'selected' : ''}>Only people on an older version (with the refresh notice)</option>
              <option value="everyone" ${a?.audience === 'everyone' ? 'selected' : ''}>Everyone</option>
            </select></label>
            <label class="field"><span>Style</span><select name="level"><option value="info">Information</option><option value="warn" ${a?.level === 'warn' ? 'selected' : ''}>Important</option></select></label>
          </div>
          <label class="check"><input type="checkbox" name="askRefresh" ${a?.askRefresh !== false ? 'checked' : ''}> Show a "Refresh now" button with it</label>
          <div class="row"><button class="btn-primary">${a ? 'Update message' : 'Send message'}</button>${a ? '<button type="button" class="btn-danger" data-action="clearMsg">Remove message</button>' : ''}</div>
        </form>
        <p class="small muted" style="margin-bottom:0">Each person can dismiss it; a new message shows again.</p>
      </div>`;
    upd.querySelector('#msg-form').addEventListener('submit', async (e) => {
      const f = e.target;
      const r = await run(f.querySelector('button.btn-primary'), () =>
        api('/team/announcement', { method: 'POST', body: { text: f.text.value, audience: f.audience.value, level: f.level.value, askRefresh: f.askRefresh.checked } }),
      );
      if (r) {
        toast(r.announcement ? 'Message sent' : 'Message removed', 'ok');
        checkUpdates();
        loadUpdates();
      }
    });
    onAction(upd, {
      clearMsg: async () => {
        await run(null, () => api('/team/announcement', { method: 'POST', body: { text: '' } }), 'Message removed');
        checkUpdates();
        loadUpdates();
      },
    });
  }

  load();
  loadUpdates();
}
