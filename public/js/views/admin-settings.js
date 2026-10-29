import { api, esc, run, confirmDialog, onAction, loadingHtml, errorHtml } from '../ui.js';
import { adminHead, changeConnection, requireTeamDb } from './admin-common.js';

export async function render(el, { servers }) {
  el.innerHTML = `${adminHead('Settings', 'Where team accounts are stored, and how the owner login works.')}<div id="db"></div>
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

  load();
}
