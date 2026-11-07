// Node Apps → Deploys: push-to-deploy (webhook), releases with rollback, the deploy key for
// private repositories, and which files are kept between deploys.
import { api, esc, toast, run, modal, confirmDialog, showJob, fmtBytes, loadingHtml, errorHtml } from '../ui.js';

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const copyBtn = (text, label = 'Copy') => `<button type="button" class="btn-sm" data-copy="${esc(text)}">${label}</button>`;

export function openDeploys(server, app, { onChange } = {}) {
  const base = `/servers/${server.id}/node-apps/${encodeURIComponent(app.name)}`;
  const body = document.createElement('div');
  body.className = 'deploys';
  const m = modal({ title: `Deploys: ${app.name}`, wide: true, body, actions: [{ label: 'Close' }] });
  let info;

  async function load() {
    body.innerHTML = loadingHtml();
    try {
      info = await api(`${base}/deploys`);
    } catch (err) {
      body.innerHTML = errorHtml(err);
      return;
    }
    draw();
  }

  function draw() {
    const hook = info.hook;
    const url = hook ? `${location.origin}${hook.path}` : '';
    const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
    const plainHttp = location.protocol === 'http:' && !local;
    const sshRepo = /^(git@|ssh:\/\/)/.test(info.repo || '');
    const releases = info.releases || [];
    body.innerHTML = `
      <div class="row deploy-top">
        <div class="grow"><div class="mono small">${esc(info.repo)}</div><div class="small muted">Branch <b>${esc(info.branch)}</b> · builds in a separate folder; if the new version does not start, the previous one is put back automatically.</div></div>
        <button class="btn-primary" data-act="deployNow" ${info.deploying ? 'disabled' : ''}>${info.deploying ? 'Deploying…' : 'Deploy now'}</button>
      </div>

      <section>
        <h3>Push to deploy</h3>
        ${
          hook
            ? `<p class="small" style="margin-top:0"><span class="badge ok">on</span> Every push to <b>${esc(info.branch)}</b> deploys ${esc(app.name)}. Add this webhook to your repository once:</p>
               ${local ? '<div class="notice warn small">You opened Serverboy on a local address, so this URL only works on this machine. Open Serverboy on its public https address to copy a URL GitHub can reach.</div>' : plainHttp ? '<div class="notice warn small">Serverboy is on plain http. Set up HTTPS for it first, so the secret is not sent in the clear.</div>' : ''}
               <div class="deploy-kv"><span>Payload URL</span><code class="mono">${esc(url)}</code>${copyBtn(url)}</div>
               <div class="deploy-kv"><span>Secret</span><code class="mono" data-secret>••••••••••••••••</code><button type="button" class="btn-sm" data-act="showSecret">Show</button>${copyBtn(hook.secret)}</div>
               <details class="deploy-howto"><summary><b>GitHub</b>: where to add it</summary>
                 <ol class="small"><li>Repository → <b>Settings</b> → <b>Webhooks</b> → <b>Add webhook</b>.</li><li>Payload URL: the URL above. Content type: <b>application/json</b>. Secret: the secret above.</li><li>Which events: <b>Just the push event</b>. Save. GitHub sends a test (ping); it shows below as "ping".</li></ol></details>
               <details class="deploy-howto"><summary><b>GitLab</b>: where to add it</summary>
                 <ol class="small"><li>Project → <b>Settings</b> → <b>Webhooks</b> → <b>Add new webhook</b>.</li><li>URL: the URL above. Secret token: the secret above.</li><li>Trigger: <b>Push events</b> (branch filter: ${esc(info.branch)}). Save, then <b>Test → Push events</b>.</li></ol></details>
               <h4>Recent deliveries</h4>
               ${
                 hook.deliveries.length
                   ? `<div class="table-wrap"><table class="small"><tbody>${hook.deliveries
                       .map(
                         (d) => `<tr><td style="white-space:nowrap">${when(d.at)}</td><td>${esc(d.provider || '')} ${esc(d.event || '')}</td><td class="mono">${esc(d.branch || '')} ${esc(d.commit || '')}</td><td>${esc(d.message || '')}${d.pusher ? ` <span class="muted">by ${esc(d.pusher)}</span>` : ''}</td>
                         <td>${/^deploying|^queued/.test(d.result) ? `<span class="badge">${esc(d.result)}</span>` : /^ignored/.test(d.result) ? `<span class="muted">${esc(d.result)}</span>` : d.result === 'ok' || /^deployed/.test(d.result) ? `<span class="badge ok">${esc(d.result)}</span>` : `<span class="badge bad">${esc(d.result)}</span>`}
                         ${d.job ? `<button class="btn-sm btn-ghost" data-act="job" data-job="${esc(d.job)}">Log</button>` : ''}</td></tr>`,
                       )
                       .join('')}</tbody></table></div>`
                   : '<p class="small muted">Nothing received yet. After adding the webhook, GitHub sends a test delivery right away.</p>'
               }
               <button class="btn-sm btn-ghost btn-danger" data-act="hookOff">Turn off push to deploy</button>`
            : `<p class="small muted" style="margin-top:0">Deploy automatically every time someone pushes to <b>${esc(info.branch)}</b> on GitHub or GitLab. Serverboy gives you a webhook URL and a secret to paste into the repository settings.</p>
               <button class="btn-primary" data-act="hookOn">Turn on push to deploy</button>`
        }
      </section>

      <section>
        <h3>Releases</h3>
        <p class="small muted" style="margin-top:0">The live version and the previous ones (with their installed packages), so going back takes seconds.</p>
        <div class="table-wrap"><table class="small"><thead><tr><th>Version</th><th>Commit</th><th>Deployed</th><th>Size</th><th></th></tr></thead><tbody>${
          releases
            .map(
              (r) => `<tr class="${r.live ? 'deploy-live' : ''}">
              <td>${r.live ? '<span class="badge ok">live</span>' : r.failed ? '<span class="badge bad">failed</span>' : '<span class="badge">kept</span>'}</td>
              <td>${r.short ? `<span class="mono">${esc(r.short)}</span> ${esc(r.message || '')}` : '<span class="muted">before push-to-deploy</span>'}</td>
              <td>${r.deployedAt ? `${when(r.deployedAt)}${r.by ? ` <span class="muted">by ${esc(r.by)}</span>` : ''}` : '—'}</td>
              <td>${fmtBytes(r.size)}</td>
              <td class="actions">${!r.live && !r.failed ? `<button class="btn-sm" data-act="rollback" data-dir="${esc(r.dir)}">Roll back to this</button>` : ''}</td></tr>`,
            )
            .join('') || '<tr><td colspan="5" class="empty">No releases yet. The next deploy keeps the current version as one.</td></tr>'
        }</tbody></table></div>
      </section>

      <section>
        <h3>Kept between deploys</h3>
        <p class="small muted" style="margin-top:0">Each deploy starts from a fresh copy of the repository. <b>.env</b> is always kept. List here anything your app writes into its own folder, such as uploaded files or a SQLite database, or it stays behind with the old release.</p>
        <form id="keep-form" class="row" style="gap:8px;align-items:flex-end;flex-wrap:wrap">
          <label class="field grow" style="margin:0;min-width:220px"><span>Files and folders (one per line)</span><textarea name="keep" rows="3" class="mono" placeholder="uploads&#10;data/app.db">${esc((info.keep || []).join('\n'))}</textarea></label>
          <label class="field" style="margin:0;width:150px"><span>Releases to keep</span><input name="keepReleases" type="number" min="1" max="10" value="${info.keepReleases}"></label>
          <button class="btn" type="submit">Save</button>
        </form>
      </section>

      <section>
        <h3>Deploy key ${sshRepo ? '' : '<span class="muted small">(for private repositories)</span>'}</h3>
        ${
          info.deployKey
            ? `<p class="small" style="margin-top:0">Add this key to the repository (GitHub: Settings → <b>Deploy keys</b> → Add, leave "Allow write access" off; GitLab: Settings → Repository → <b>Deploy keys</b>). It lets this server read the code, nothing else.</p>
               <div class="deploy-kv"><code class="mono deploy-key">${esc(info.deployKey)}</code>${copyBtn(info.deployKey)}</div>
               ${sshRepo ? '' : '<p class="small muted">Your repository address starts with https://. For a private repository, change it to the SSH form (git@github.com:owner/repo.git) when redeploying the app.</p>'}`
            : `<p class="small muted" style="margin-top:0">Public repositories need nothing. For a private one, create a key here and add it to the repository as a read-only deploy key.</p>
               <button class="btn" data-act="newKey">Create deploy key</button>`
        }
      </section>`;
  }

  body.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) {
      try {
        await navigator.clipboard.writeText(c.dataset.copy);
        toast('Copied', 'ok');
      } catch {
        toast('Could not copy; select the text instead', 'error');
      }
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'showSecret') {
      body.querySelector('[data-secret]').textContent = info.hook.secret;
      b.remove();
    } else if (act === 'hookOn') {
      if (await run(b, () => api(`${base}/hook`, { method: 'POST' }), 'Push to deploy is on. Add the webhook to your repository.')) load();
    } else if (act === 'hookOff') {
      if (!(await confirmDialog('Turn off push to deploy? Pushes are ignored until you turn it on again (with a new URL and secret).', { confirmLabel: 'Turn off', danger: true }))) return;
      if (await run(b, () => api(`${base}/hook`, { method: 'DELETE' }), 'Push to deploy is off')) load();
    } else if (act === 'newKey') {
      if (await run(b, () => api(`${base}/deploy-key`, { method: 'POST' }), 'Deploy key created')) load();
    } else if (act === 'job') {
      showJob(server.id, { id: b.dataset.job, title: 'Deploy' });
    } else if (act === 'deployNow') {
      const job = await run(b, () => api(`${base}/redeploy`, { method: 'POST' }));
      if (job?.id) showJob(server.id, job, { onDone: () => (load(), onChange?.()) });
      else if (job?.queued) toast('A deploy is running; this one runs right after it.', 'ok');
      load();
    } else if (act === 'rollback') {
      const r = info.releases.find((x) => x.dir === b.dataset.dir);
      if (!(await confirmDialog(`Go back to ${r.short ? `${r.short} (${r.message || ''})` : 'the version from before push-to-deploy'}? The current version is kept, so you can switch forward again.`, { confirmLabel: 'Roll back' }))) return;
      const job = await run(b, () => api(`${base}/rollback`, { method: 'POST', body: { release: r.dir } }));
      if (job?.id) showJob(server.id, job, { onDone: () => (load(), onChange?.()) });
    }
  });

  body.addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.id !== 'keep-form') return;
    const r = await run(f.querySelector('button'), () => api(`${base}/deploy-settings`, { method: 'PUT', body: { keep: f.keep.value, keepReleases: Number(f.keepReleases.value) } }), 'Saved');
    if (r) {
      info.keep = r.keep;
      info.keepReleases = r.keepReleases;
    }
  });

  load();
  return m;
}
