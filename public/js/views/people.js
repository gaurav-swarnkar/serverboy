// Team directory (#/people) and profiles (#/people/<id> or #/people/me).
import { api, esc, toast, run, modal, loadingHtml, errorHtml, fmtDate, session } from '../ui.js';

const PERMISSION_WORDS = {
  databases: 'Databases',
  sites: 'Websites',
  files: 'Website files',
  services: 'Services and logs',
  nodeapps: 'Node.js apps',
  terminal: 'Terminal',
  system: 'Software, firewall, updates',
};

export function initials(p) {
  return (p.name || p.username || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function avatarHtml(p, size = 40) {
  const pr = p.profile || {};
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px;background:${esc(pr.color || '#6366f1')}`;
  return pr.avatar ? `<img class="pf-avatar" style="${style}" src="${esc(pr.avatar)}" alt="">` : `<span class="pf-avatar" style="${style}">${esc(initials(p))}</span>`;
}

export async function render(el, { rest }) {
  if (rest[0]) return renderProfile(el, rest[0]);
  return renderDirectory(el);
}

// ---------- directory ----------

async function renderDirectory(el) {
  el.innerHTML = `<div class="page-head"><div><h1>Team</h1><div class="sub">Everyone who works on these servers.</div></div>
    <div class="row"><input id="pf-search" placeholder="Search people…" style="width:220px">${session.user.isOwner ? '<a class="btn" href="#/messages/new">✉ Message everyone</a><a class="btn btn-primary" href="#/admin/users">+ Add member</a>' : ''}</div></div>
    <div id="pf-body">${loadingHtml()}</div>`;
  const body = el.querySelector('#pf-body');
  let data;
  try {
    data = await api('/people');
  } catch (err) {
    body.innerHTML = errorHtml(err);
    return;
  }
  const draw = (q = '') => {
    const t = q.trim().toLowerCase();
    const list = data.people.filter((p) => !t || `${p.name} ${p.username} ${p.email} ${p.profile?.title || ''} ${p.role}`.toLowerCase().includes(t));
    body.innerHTML = `${data.teamDb ? '' : '<div class="notice">Team accounts are not set up yet (Administration → Settings).</div>'}
      <div class="pf-grid">${list
        .map(
          (p) => `<a class="card pf-card ${p.disabled ? 'pf-disabled' : ''}" href="#/people/${esc(p.id)}">
            ${avatarHtml(p, 56)}
            <div class="grow" style="min-width:0">
              <div class="row" style="gap:6px"><b>${esc(p.name)}</b>${p.id === data.me ? '<span class="badge">you</span>' : ''}${p.disabled ? '<span class="badge">disabled</span>' : ''}</div>
              <div class="small">${esc(p.profile?.title || '')}</div>
              <div class="small muted">${esc(p.role)}${p.email ? ` · ${esc(p.email)}` : ''}</div>
            </div>
          </a>`,
        )
        .join('') || '<div class="empty">Nobody matches.</div>'}</div>`;
  };
  draw();
  el.querySelector('#pf-search').addEventListener('input', (e) => draw(e.target.value));
}

// ---------- profile ----------

async function renderProfile(el, id) {
  el.innerHTML = loadingHtml();
  let p;
  let meta;
  try {
    [p, meta] = await Promise.all([api(`/people/${encodeURIComponent(id)}`), api('/people')]);
  } catch (err) {
    el.innerHTML = errorHtml(err);
    return;
  }
  const me = meta.me;
  const mine = p.id === me;
  const canEdit = mine || session.user.isOwner;
  const pr = p.profile || {};
  let localTime = '';
  try {
    if (pr.timezone) localTime = new Date().toLocaleTimeString([], { timeZone: pr.timezone, hour: '2-digit', minute: '2-digit' });
  } catch {
    /* unknown zone */
  }
  const canMessage = !mine && meta.teamDb && (session.user.isOwner || p.isOwner);
  el.innerHTML = `
    <div class="small" style="margin-bottom:6px"><a href="#/people">← Team</a></div>
    <div class="card pf-head">
      ${avatarHtml(p, 96)}
      <div class="grow" style="min-width:0">
        <h1 style="margin:0">${esc(p.name)} ${p.disabled ? '<span class="badge">disabled</span>' : ''}</h1>
        ${pr.title ? `<div style="margin-top:2px">${esc(pr.title)}</div>` : ''}
        <div class="row small" style="margin-top:8px;gap:6px"><span class="badge accent">${esc(p.role)}</span><span class="muted mono">@${esc(p.username)}</span></div>
      </div>
      <div class="row">
        ${canMessage ? `<a class="btn btn-primary" href="#/messages/new/${esc(p.id)}">✉ Send message</a>` : ''}
        ${canEdit ? '<button data-pf="edit">Edit profile</button>' : ''}
        ${session.user.isOwner && !p.isOwner ? '<a class="btn" href="#/admin/users">Access & password</a>' : ''}
        ${mine ? '<a class="btn" href="#/account">Password</a>' : ''}
      </div>
    </div>
    <div class="grid grid-2" style="align-items:start;margin-top:16px">
      <div class="card">
        <h3 style="margin-top:0">Contact</h3>
        <table class="small"><tbody>
          <tr><td class="muted" style="width:120px">Email</td><td>${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : '<span class="muted">-</span>'}</td></tr>
          <tr><td class="muted">Phone</td><td>${pr.phone ? `<a href="tel:${esc(pr.phone.replace(/[^+\d]/g, ''))}">${esc(pr.phone)}</a>` : '<span class="muted">-</span>'}</td></tr>
          <tr><td class="muted">Location</td><td>${esc(pr.location || '-')}</td></tr>
          <tr><td class="muted">Time zone</td><td>${pr.timezone ? `${esc(pr.timezone)}${localTime ? ` <span class="muted">(now ${esc(localTime)})</span>` : ''}` : '-'}</td></tr>
          ${p.createdAt ? `<tr><td class="muted">Member since</td><td>${fmtDate(p.createdAt)}</td></tr>` : ''}
          ${p.lastLoginAt ? `<tr><td class="muted">Last login</td><td>${fmtDate(p.lastLoginAt)}</td></tr>` : ''}
        </tbody></table>
        ${pr.bio ? `<h3>About</h3><p style="white-space:pre-wrap;margin:0">${esc(pr.bio)}</p>` : ''}
      </div>
      ${
        p.permissions || p.isOwner
          ? `<div class="card">
          <h3 style="margin-top:0">Access</h3>
          ${
            p.isOwner
              ? '<p class="small" style="margin:0">Everything, including administration.</p>'
              : `<div class="row" style="gap:6px;flex-wrap:wrap">${(p.permissions || []).map((x) => `<span class="badge">${esc(PERMISSION_WORDS[x] || x)}</span>`).join('') || '<span class="muted small">Can only look (dashboards, logs)</span>'}</div>
                 <p class="small muted">Websites: ${Array.isArray(p.scope?.sites) ? `${p.scope.sites.length} chosen` : 'all'} · Databases: ${Array.isArray(p.scope?.databases) ? `${p.scope.databases.length} chosen` : 'all'}</p>`
          }
        </div>`
          : ''
      }
    </div>
    ${
      p.activity
        ? `<div class="card flush" style="margin-top:16px"><div class="card-head"><h3 style="margin:0">Recent activity</h3>${session.user.isOwner ? `<a class="btn btn-sm" href="#/admin/activity">All activity</a>` : ''}</div>
        <div class="table-wrap"><table class="small"><tbody>${p.activity
          .filter((a) => !/^(GET|POST|PUT|PATCH|DELETE) \//.test(a.action))
          .slice(0, 15)
          .map((a) => `<tr><td class="muted" style="width:170px;white-space:nowrap">${fmtDate(a.at)}</td><td>${esc(a.action)}</td></tr>`)
          .join('') || '<tr><td class="empty">Nothing yet.</td></tr>'}</tbody></table></div></div>`
        : ''
    }`;
  el.querySelector('[data-pf=edit]')?.addEventListener('click', () => editProfile(p, meta.colors, () => renderProfile(el, id)));
}

// Shrink a picked photo to a 256 px square JPEG (keeps profiles small).
function photoToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const size = 256;
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('That file is not an image'));
    // A data: URL (the page's security policy allows data: images, not blob:).
    const reader = new FileReader();
    reader.onload = () => (img.src = reader.result);
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

function editProfile(p, colors, onSaved) {
  const pr = { ...(p.profile || {}) };
  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = ['UTC', 'Europe/London', 'America/New_York'];
  }
  // Some browsers only list old names (Asia/Calcutta); offer the current one and the browser's own.
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  zones = [...new Set([...zones, 'Asia/Kolkata', browserZone].filter(Boolean))].sort();
  if (!pr.timezone && browserZone) pr.timezone = browserZone;
  const box = document.createElement('div');
  const preview = () => avatarHtml({ ...p, profile: pr }, 72);
  box.innerHTML = `
    <div class="row" style="margin-bottom:12px;gap:14px">
      <span id="pf-preview">${preview()}</span>
      <div>
        <label class="btn btn-sm">Upload photo<input type="file" accept="image/*" id="pf-photo" hidden></label>
        <button type="button" class="btn-sm" id="pf-nophoto">Remove photo</button>
        <div class="row" style="gap:4px;margin-top:8px" id="pf-colors">${colors.map((c) => `<button type="button" class="pf-swatch ${c === (pr.color || colors[0]) ? 'on' : ''}" data-color="${c}" style="background:${c}" title="Colour"></button>`).join('')}</div>
      </div>
    </div>
    <div class="form-grid">
      <label class="field"><span>Name</span><input name="name" value="${esc(pr.name ?? p.name)}" maxlength="80"></label>
      <label class="field"><span>Job title</span><input name="title" value="${esc(pr.title || '')}" placeholder="Frontend developer" maxlength="80"></label>
      <label class="field"><span>Phone</span><input name="phone" value="${esc(pr.phone || '')}" placeholder="+91 98765 43210" maxlength="40"></label>
      <label class="field"><span>Location</span><input name="location" value="${esc(pr.location || '')}" placeholder="Pune, India" maxlength="80"></label>
      <label class="field"><span>Time zone</span><select name="timezone"><option value="">-</option>${zones.map((z) => `<option ${z === pr.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></label>
    </div>
    <label class="field"><span>About</span><textarea name="bio" rows="3" maxlength="1000" placeholder="What you work on, how to reach you best…">${esc(pr.bio || '')}</textarea></label>`;
  box.querySelector('#pf-photo').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      pr.avatar = await photoToDataUrl(f);
      box.querySelector('#pf-preview').innerHTML = preview();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  box.querySelector('#pf-nophoto').addEventListener('click', () => {
    pr.avatar = '';
    box.querySelector('#pf-preview').innerHTML = preview();
  });
  box.querySelector('#pf-colors').addEventListener('click', (e) => {
    const c = e.target.dataset.color;
    if (!c) return;
    pr.color = c;
    box.querySelectorAll('.pf-swatch').forEach((s) => s.classList.toggle('on', s.dataset.color === c));
    box.querySelector('#pf-preview').innerHTML = preview();
  });
  modal({
    title: p.id === session.user.id ? 'Edit your profile' : `Edit ${p.name}'s profile`,
    wide: true,
    body: box,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save',
        className: 'btn-primary',
        onClick: async () => {
          const v = (n) => box.querySelector(`[name=${n}]`).value;
          await api(`/people/${encodeURIComponent(p.id)}`, { method: 'PUT', body: { name: v('name'), title: v('title'), phone: v('phone'), location: v('location'), timezone: v('timezone'), bio: v('bio'), color: pr.color || colors[0], avatar: pr.avatar || '' } });
          toast('Profile saved', 'ok');
          if (p.id === session.user.id) {
            session.user.avatar = pr.avatar || '';
            session.user.color = pr.color || '';
          }
          onSaved();
        },
      },
    ],
  });
}
