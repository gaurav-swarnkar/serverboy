// Messages: the owner writes to one person, several or everyone; members read, reply, and can
// write to the owner.  #/messages, #/messages/<id>, #/messages/new[/<personId>]
import { api, esc, toast, run, confirmDialog, loadingHtml, errorHtml, fmtDate, session } from '../ui.js';
import { avatarHtml } from './people.js';
import { refreshUnread } from '../updates.js';

export async function render(el, { rest }) {
  el.innerHTML = `<div class="page-head"><div><h1>Messages</h1><div class="sub">${session.user.isOwner ? 'Write to one person, a few, or the whole team.' : 'Messages from the owner. You can reply, or write to the owner.'}</div></div>
    <a class="btn btn-primary" href="#/messages/new">${session.user.isOwner ? '✉ New message' : '✉ Message the owner'}</a></div>
    <div id="msg-body">${loadingHtml()}</div>`;
  const body = el.querySelector('#msg-body');
  let list;
  let people;
  try {
    [list, people] = await Promise.all([api('/messages'), api('/people')]);
  } catch (err) {
    body.innerHTML = errorHtml(err);
    return;
  }
  refreshUnread();
  const byId = new Map(people.people.map((p) => [p.id, p]));
  const selected = rest[0] && rest[0] !== 'new' ? rest[0] : null;
  const composing = rest[0] === 'new';
  body.innerHTML = `<div class="grid msg-layout">
      <div class="card flush msg-list">${
        list
          .map(
            (m) => `<a class="msg-item ${m.id === selected ? 'active' : ''} ${m.unread ? 'unread' : ''}" href="#/messages/${m.id}">
              ${avatarHtml(byId.get(m.from.id) || { name: m.from.name }, 32)}
              <div class="grow" style="min-width:0">
                <div class="row" style="gap:6px"><b class="grow msg-subject">${esc(m.subject)}</b>${m.level === 'important' ? '<span class="badge warn">important</span>' : ''}</div>
                <div class="small muted msg-meta">${esc(m.from.name)} → ${m.to === 'all' ? 'everyone' : esc(m.to.map((t) => t.name).join(', '))}${m.replies.length ? ` · ${m.replies.length} repl${m.replies.length === 1 ? 'y' : 'ies'}` : ''}</div>
              </div>
              <span class="small muted" style="white-space:nowrap">${fmtDate(m.lastAt).replace(/,? \d{4}/, '')}</span>
            </a>`,
          )
          .join('') || '<div class="empty">No messages yet.</div>'
      }</div>
      <div id="msg-main"></div>
    </div>`;
  const main = body.querySelector('#msg-main');
  if (composing) compose(main, people, rest[1]);
  else if (selected) thread(main, list.find((m) => m.id === selected), byId, people);
  else main.innerHTML = `<div class="card empty">${list.length ? 'Choose a message on the left.' : session.user.isOwner ? 'Send your first message with ✉ New message.' : 'No messages yet.'}</div>`;
}

function compose(main, people, toId) {
  const owner = session.user.isOwner;
  const others = people.people.filter((p) => p.id !== people.me && !p.disabled);
  main.innerHTML = `<form class="card" id="msg-form">
    <h3 style="margin-top:0">${owner ? 'New message' : 'Message to the owner'}</h3>
    ${
      owner
        ? `<div class="field"><span>To</span>
        <label class="check"><input type="radio" name="toMode" value="all" ${toId ? '' : 'checked'}> Everyone (${others.length})</label>
        <label class="check"><input type="radio" name="toMode" value="some" ${toId ? 'checked' : ''}> Chosen people</label>
        <div id="msg-people" class="msg-people ${toId ? '' : 'hidden'}">${others
          .map((p) => `<label class="check msg-person">${avatarHtml(p, 24)}<input type="checkbox" value="${esc(p.id)}" ${p.id === toId ? 'checked' : ''}> ${esc(p.name)} <span class="muted small">${esc(p.profile?.title || p.role)}</span></label>`)
          .join('')}</div></div>`
        : ''
    }
    <label class="field"><span>Subject</span><input name="subject" maxlength="150" required></label>
    <label class="field"><span>Message</span><textarea name="body" rows="7" maxlength="10000" required></textarea></label>
    ${owner ? '<label class="check"><input type="checkbox" name="important"> Important (highlighted for everyone)</label>' : ''}
    <div class="row"><button class="btn-primary">Send</button><a class="btn" href="#/messages">Cancel</a></div>
  </form>`;
  const f = main.querySelector('#msg-form');
  f.addEventListener('change', (e) => {
    if (e.target.name === 'toMode') main.querySelector('#msg-people').classList.toggle('hidden', e.target.value !== 'some');
  });
  f.addEventListener('submit', async () => {
    let to = null;
    if (owner) {
      to = f.toMode.value === 'all' ? 'all' : [...main.querySelectorAll('#msg-people input:checked')].map((i) => i.value);
      if (Array.isArray(to) && !to.length) return toast('Tick at least one person', 'error');
    }
    const r = await run(f.querySelector('button'), () => api('/messages', { method: 'POST', body: { to, subject: f.subject.value, body: f.body.value, level: f.important?.checked ? 'important' : 'normal' } }), 'Message sent');
    if (r) location.hash = `#/messages/${r.id}`;
  });
}

async function thread(main, m, byId, people) {
  if (!m) {
    main.innerHTML = '<div class="card empty">This message no longer exists.</div>';
    return;
  }
  const total = m.to === 'all' ? people.people.filter((p) => !p.disabled && p.id !== m.from.id).length : m.to.length;
  const bubble = (fromId, fromName, text, at) => `<div class="msg-bubble ${fromId === people.me ? 'mine' : ''}">
      ${avatarHtml(byId.get(fromId) || { name: fromName }, 32)}
      <div class="grow" style="min-width:0"><div class="small"><b>${esc(fromName)}</b> <span class="muted">${fmtDate(at)}</span></div><div class="msg-text">${esc(text)}</div></div>
    </div>`;
  main.innerHTML = `<div class="card">
      <div class="row"><h2 class="grow" style="margin:0">${esc(m.subject)}</h2>${m.level === 'important' ? '<span class="badge warn">important</span>' : ''}${session.user.isOwner ? '<button class="btn-sm btn-danger" id="msg-del">Delete</button>' : ''}</div>
      <div class="small muted" style="margin:4px 0 12px">To ${m.to === 'all' ? 'everyone' : esc(m.to.map((t) => t.name).join(', '))}${m.from.id === people.me ? ` · read by ${m.readCount} of ${total}` : ''}</div>
      ${bubble(m.from.id, m.from.name, m.body, m.createdAt)}
      ${m.replies.map((r) => bubble(r.fromId, r.fromName, r.body, r.at)).join('')}
      <form id="msg-reply" style="margin-top:12px"><textarea name="body" rows="3" placeholder="Write a reply…" required></textarea><div class="row" style="margin-top:6px"><button class="btn-primary">Reply</button></div></form>
    </div>`;
  if (m.unread) {
    api(`/messages/${m.id}/read`, { method: 'POST' })
      .then(() => {
        document.querySelector(`.msg-item[href="#/messages/${m.id}"]`)?.classList.remove('unread');
        refreshUnread();
      })
      .catch(() => {});
  }
  main.querySelector('#msg-reply').addEventListener('submit', async (e) => {
    const f = e.target;
    const ok = await run(f.querySelector('button'), () => api(`/messages/${m.id}/reply`, { method: 'POST', body: { body: f.body.value } }), 'Reply sent');
    if (ok) window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  main.querySelector('#msg-del')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete this conversation for everyone?', { danger: true, confirmLabel: 'Delete' }))) return;
    const ok = await run(null, () => api(`/messages/${m.id}`, { method: 'DELETE' }), 'Deleted');
    if (ok) location.hash = '#/messages';
  });
}
