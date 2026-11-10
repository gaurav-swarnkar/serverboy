// AI connector (MCP): connect Claude or any other AI agent to Serverboy.
import { api, esc, toast, run, modal, confirmDialog, formDialog, loadingHtml, errorHtml, session } from '../ui.js';

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

function copy(text) {
  navigator.clipboard?.writeText(text).then(() => toast('Copied', 'ok')).catch(() => modal({ title: 'Copy', body: `<pre class="log">${esc(text)}</pre>`, actions: [{ label: 'Close' }] }));
}

const TOOLS = [
  ['Look', 'servers and their health, websites, databases, collections and documents, APIs (and Diagnose), services and their logs, Node apps, backups, tasks'],
  ['Manage', 'create websites, make them live, get HTTPS, add documents, create APIs in a website folder, restart API servers, services and Node apps, redeploy, start backups'],
  ['Terminal', 'run a shell command (only for people with the Terminal permission, with a "manage" token)'],
  ['Anything else', 'any Serverboy action through its API, with your permissions'],
];

export async function render(el) {
  const url = `${location.origin}/mcp`;
  const https = location.protocol === 'https:';
  const user = session.user;
  let showAll = false;
  el.innerHTML = `
    <div class="page-head"><div><h1>AI connector</h1><div class="sub">Manage Serverboy from Claude or any other AI agent (MCP). Everyone on the team can connect their own AI: it can do what that person can do here, and nothing more.</div></div></div>
    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-top:0">Connector address</h3>
      <div class="row" style="flex-wrap:nowrap"><input class="mono" readonly value="${esc(url)}" style="flex:1"><button data-act="copyUrl">Copy</button></div>
      ${https ? '' : '<div class="notice warn" style="margin:10px 0 0">Serverboy is not opened over HTTPS here. Claude.ai and most AI apps need an <b>https://</b> address: open Serverboy through its HTTPS address (the install command sets one up).</div>'}
    </div>
    <div class="grid grid-2" style="align-items:start">
      <div class="card">
        <h3 style="margin-top:0">Connect Claude (claude.ai and the Claude apps)</h3>
        <ol class="ai-steps">
          <li>In Claude, open <b>Settings → Connectors</b> and click <b>Add custom connector</b>.</li>
          <li>Name: <b>Serverboy</b>. URL: the connector address above. Click <b>Add</b>.</li>
          <li>Click <b>Connect</b>. Claude opens Serverboy: log in if asked, choose <b>Look and manage</b> (or <b>Only look</b>) and click <b>Allow</b>.</li>
          <li>In a chat, turn on the Serverboy connector and ask, for example: <i>"Is my server healthy?"</i> or <i>"Create an API for the products collection in the shop website."</i></li>
        </ol>
        <p class="small muted" style="margin-bottom:0">Claude asks you before it changes something. Disconnect it any time below.</p>
      </div>
      <div class="card">
        <h3 style="margin-top:0">Claude Code, Cursor and other agents</h3>
        <ol class="ai-steps">
          <li>Make a token: <button class="btn-sm btn-primary" data-act="newToken">+ New token</button></li>
          <li>Add Serverboy to your agent with the token. Claude Code:
            <pre class="log ai-code">claude mcp add --transport http serverboy ${esc(url)} \\
  --header "Authorization: Bearer YOUR_TOKEN"</pre>
            Other agents (Cursor, Windsurf, VS Code…), in their MCP settings:
            <pre class="log ai-code">{ "mcpServers": { "serverboy": {
  "url": "${esc(url)}",
  "headers": { "Authorization": "Bearer YOUR_TOKEN" } } } }</pre></li>
        </ol>
      </div>
    </div>
    <div class="card flush" style="margin-top:14px">
      <div class="card-head"><h3 style="margin:0">Connected apps and tokens</h3>
        <div class="row">${user.isOwner ? '<label class="check small"><input type="checkbox" data-act="all"> Everyone\'s</label>' : ''}<button class="btn-sm btn-primary" data-act="newToken">+ New token</button></div></div>
      <div id="ai-list">${loadingHtml()}</div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0">What ${user.isOwner ? 'an AI' : 'your AI'} can do</h3>${user.isOwner ? '' : `<p class="small muted" style="margin-top:0">Only what your role allows (${esc(user.role || 'your role')}): it sees only the matching tools.</p>`}
      <table class="small"><tbody>${TOOLS.map(([k, v]) => `<tr><td style="width:120px"><b>${k}</b></td><td>${v}</td></tr>`).join('')}</tbody></table>
      <p class="small muted" style="margin-bottom:0">It acts as you: your role, and only your websites and databases. "Only look" tokens cannot change anything. It can never make tokens, change passwords or log in as someone else, and Serverboy's self-protection still applies. Everything it changes appears in the activity log with "(via AI: …)".</p>
    </div>`;

  const list = el.querySelector('#ai-list');
  async function load() {
    let r;
    try {
      r = await api(`/ai-tokens${showAll ? '?all=1' : ''}`);
    } catch (err) {
      list.innerHTML = errorHtml(err);
      return;
    }
    list.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Access</th>${showAll ? '<th>Person</th>' : ''}<th>Made</th><th>Last used</th><th>Expires</th><th></th></tr></thead><tbody>${
      r.tokens
        .map(
          (t) => `<tr><td><b>${esc(t.client || t.label)}</b><div class="small muted">${t.via === 'oauth' ? 'Connected app (signed in with Serverboy)' : `Token <span class="mono">${esc(t.prefix || '')}…</span>`}</div></td>
          <td><span class="badge ${t.access === 'manage' ? 'warn' : ''}">${t.access === 'manage' ? 'look and manage' : 'only look'}</span></td>
          ${showAll ? `<td>${esc(t.username || t.userId)}</td>` : ''}
          <td class="small">${when(t.createdAt)}</td><td class="small">${when(t.lastUsedAt)}</td>
          <td class="small">${t.via === 'oauth' ? 'renews itself' : t.expiresAt ? when(new Date(t.expiresAt).toISOString()) : 'never'}</td>
          <td class="actions"><button class="btn-sm btn-danger" data-act="revoke" data-id="${esc(t.id)}" data-name="${esc(t.client || t.label)}">${t.via === 'oauth' ? 'Disconnect' : 'Revoke'}</button></td></tr>`,
        )
        .join('') || `<tr><td class="empty" colspan="7">Nothing connected yet.</td></tr>`
    }</tbody></table></div>`;
  }

  async function newToken() {
    const v = await formDialog({
      title: 'New AI access token',
      intro: 'The token acts as you. Paste it only into AI tools you trust.',
      fields: [
        { name: 'label', label: 'Name', placeholder: 'Claude Code on my laptop' },
        { name: 'access', label: 'Access', type: 'select', value: 'read', options: [['read', 'Only look (safe to start with)'], ['manage', 'Look and manage']] },
        { name: 'days', label: 'Expires', type: 'select', value: '90', options: [['30', 'In 30 days'], ['90', 'In 90 days'], ['365', 'In a year'], ['0', 'Never']] },
      ],
      submitLabel: 'Make token',
      submit: (x) => api('/ai-tokens', { method: 'POST', body: { label: x.label, access: x.access, days: Number(x.days) } }),
    });
    if (!v?.token) return;
    const cmd = `claude mcp add --transport http serverboy ${url} \\\n  --header "Authorization: Bearer ${v.token}"`;
    modal({
      title: 'Copy your token now',
      wide: true,
      body: `<p>This token is shown <b>only once</b>.</p><pre class="log">${esc(v.token)}</pre>
        <p class="small muted">Claude Code, ready to paste:</p><pre class="log ai-code">${esc(cmd)}</pre>`,
      actions: [
        { label: 'Copy token', onClick: () => (copy(v.token), false) },
        { label: 'Copy Claude Code command', onClick: () => (copy(cmd), false) },
        { label: 'Done', className: 'btn-primary' },
      ],
    });
    load();
  }

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.dataset.act === 'all') return;
    if (b.dataset.act === 'copyUrl') copy(url);
    else if (b.dataset.act === 'newToken') newToken();
    else if (b.dataset.act === 'revoke') {
      if (!(await confirmDialog(`${b.textContent.trim()} "${b.dataset.name}"? It stops working right away.`, { danger: true, confirmLabel: b.textContent.trim() }))) return;
      if (await run(b, () => api(`/ai-tokens/${encodeURIComponent(b.dataset.id)}`, { method: 'DELETE' }), 'Done')) load();
    }
  });
  el.querySelector('[data-act=all]')?.addEventListener('change', (e) => {
    showAll = e.target.checked;
    load();
  });
  load();
}
