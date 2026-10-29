// "Access" section of the user dialog: all websites / databases, or only chosen ones with
// View or Edit. Returns a function that reads the current choice as a scope object.
import { api, esc, loadingHtml } from '../ui.js';

// System databases, and Serverboy's own team database, are never handed out.
const SYSTEM_DBS = new Set(['admin', 'local', 'config', 'information_schema', 'mysql', 'performance_schema', 'sys', 'serverboy']);

async function inventory(servers) {
  const out = { sites: [], databases: [] };
  await Promise.all(
    servers.map(async (srv) => {
      const [sites, mongo, mysql] = await Promise.all([
        api(`/servers/${srv.id}/sites`).catch(() => ({ sites: [] })),
        api(`/servers/${srv.id}/mongo/databases`).catch(() => []),
        api(`/servers/${srv.id}/mysql/databases`).catch(() => []),
      ]);
      for (const s of sites.sites || []) if (s.name !== 'default') out.sites.push({ s: srv.id, server: srv.name, n: s.name, detail: s.serverNames?.join(', ') });
      for (const d of mongo) if (!SYSTEM_DBS.has(d.name)) out.databases.push({ s: srv.id, server: srv.name, e: 'mongo', n: d.name });
      for (const d of mysql) if (!SYSTEM_DBS.has(d.name)) out.databases.push({ s: srv.id, server: srv.name, e: 'mysql', n: d.name });
    }),
  );
  return out;
}

const keyOf = (x) => `${x.s}|${x.e || ''}|${x.n}`;

export function accessPicker(el, servers, scope = { sites: 'all', databases: 'all' }) {
  el.innerHTML = loadingHtml('Loading websites and databases…');
  const chosen = {
    sites: Array.isArray(scope.sites) ? new Map(scope.sites.map((x) => [keyOf(x), x.l])) : null,
    databases: Array.isArray(scope.databases) ? new Map(scope.databases.map((x) => [keyOf(x), x.l])) : null,
  };
  let items = { sites: [], databases: [] };

  function block(kind, title, noun) {
    const list = items[kind];
    const all = !chosen[kind];
    const multiServer = servers.length > 1;
    return `<div class="access-block">
      <div class="row" style="margin-bottom:6px"><b>${title}</b><span class="grow"></span>
        <label class="check" style="margin:0"><input type="radio" name="acc-${kind}" value="all" ${all ? 'checked' : ''}> All ${noun}</label>
        <label class="check" style="margin:0"><input type="radio" name="acc-${kind}" value="some" ${all ? '' : 'checked'}> Only the ones I choose</label>
      </div>
      <div class="access-list ${all ? 'hidden' : ''}" data-kind="${kind}">
        ${
          list.length
            ? `<table class="small"><tbody>${list
                .map(
                  (x) => `<tr>
                    <td>${kind === 'databases' ? `<span class="badge">${x.e === 'mongo' ? 'MongoDB' : 'MariaDB'}</span> ` : ''}<b>${esc(x.n)}</b>${x.detail && x.detail !== x.n ? `<div class="muted">${esc(x.detail)}</div>` : ''}${multiServer ? `<div class="muted">${esc(x.server)}</div>` : ''}</td>
                    <td style="width:150px"><select data-key="${esc(keyOf(x))}">
                      ${['', 'view', 'edit'].map((l) => `<option value="${l}" ${(chosen[kind]?.get(keyOf(x)) || '') === l ? 'selected' : ''}>${l === '' ? 'No access' : l === 'view' ? 'View' : 'Edit'}</option>`).join('')}
                    </select></td>
                  </tr>`,
                )
                .join('')}</tbody></table>`
            : `<p class="muted small">No ${noun} found on your servers yet.</p>`
        }
      </div>
    </div>`;
  }

  function draw() {
    el.innerHTML = `
      ${block('sites', 'Websites', 'websites')}
      ${block('databases', 'Databases', 'databases')}
      <p class="small muted">View: see it and download its files / data. Edit: also change files, documents, SSL and on/off. Creating or deleting whole websites or databases, and the raw SQL console, need "All".
      This only narrows what their role allows: someone without the Databases permission gets no databases even if you pick some.</p>`;
    for (const kind of ['sites', 'databases']) {
      el.querySelectorAll(`input[name=acc-${kind}]`).forEach((r) =>
        r.addEventListener('change', () => {
          const some = el.querySelector(`input[name=acc-${kind}]:checked`).value === 'some';
          if (some && !chosen[kind]) chosen[kind] = new Map();
          if (!some) chosen[kind] = null;
          el.querySelector(`.access-list[data-kind=${kind}]`).classList.toggle('hidden', !some);
        }),
      );
      el.querySelectorAll(`.access-list[data-kind=${kind}] select`).forEach((s) =>
        s.addEventListener('change', () => {
          if (!chosen[kind]) chosen[kind] = new Map();
          if (s.value) chosen[kind].set(s.dataset.key, s.value);
          else chosen[kind].delete(s.dataset.key);
        }),
      );
    }
  }

  inventory(servers).then((inv) => {
    items = inv;
    draw();
  });

  // Current choice in the API's scope format.
  return () => {
    const toList = (kind) => {
      if (!chosen[kind]) return 'all';
      const out = [];
      for (const [key, l] of chosen[kind]) {
        const [s, e, ...rest] = key.split('|');
        out.push(kind === 'databases' ? { s, e, n: rest.join('|'), l } : { s, n: rest.join('|'), l });
      }
      return out;
    };
    return { sites: toList('sites'), databases: toList('databases') };
  };
}

export function scopeSummary(scope) {
  const part = (v, one, many) => (Array.isArray(v) ? `${v.length} ${v.length === 1 ? one : many}` : `all ${many}`);
  if (!scope || (!Array.isArray(scope.sites) && !Array.isArray(scope.databases))) return 'All';
  return `${part(scope.sites, 'website', 'websites')} · ${part(scope.databases, 'database', 'databases')}`;
}
