// Shared frontend helpers: API client, escaping, modals, toasts, job viewer, formatters.

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: { 'x-serverboy': '1' } };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, opts);
  if (res.status === 401 && path !== '/login') {
    window.dispatchEvent(new Event('sb:logout'));
    throw new Error('Your session expired. Please log in again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export function toast(message, type = 'info', ms = 4500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? ms * 2 : ms);
}

// Wrap an async action: disables the button while running and shows errors as toasts.
export async function run(button, fn, successMessage) {
  const prev = button?.disabled;
  if (button) button.disabled = true;
  try {
    const result = await fn();
    if (successMessage) toast(successMessage, 'ok');
    return result;
  } catch (err) {
    toast(err.message, 'error');
    return undefined;
  } finally {
    if (button) button.disabled = prev;
  }
}

export function modal({ title, body = '', actions = [], wide = false, onClose }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${esc(title)}</h2><button class="btn-ghost" data-close aria-label="Close">✕</button></div>
      <div class="modal-body"></div>
      ${actions.length ? '<div class="modal-foot"></div>' : ''}
    </div>`;
  const bodyEl = backdrop.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else bodyEl.append(body);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  backdrop.querySelector('[data-close]').onclick = close;
  backdrop.addEventListener('mousedown', (e) => e.target === backdrop && close());
  const foot = backdrop.querySelector('.modal-foot');
  for (const a of actions) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.className = a.className || '';
    b.onclick = async () => {
      if (!a.onClick) return close();
      b.disabled = true;
      try {
        const keepOpen = await a.onClick({ body: bodyEl, close, button: b });
        if (keepOpen !== false) close();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        b.disabled = false;
      }
    };
    foot.append(b);
  }
  document.body.append(backdrop);
  backdrop.querySelector('input, textarea, select')?.focus();
  return { el: backdrop, body: bodyEl, close };
}

export function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    modal({
      title,
      body: `<p style="margin:0;white-space:pre-wrap">${esc(message)}</p>`,
      onClose: () => !answered && resolve(false),
      actions: [
        { label: 'Cancel' },
        {
          label: confirmLabel,
          className: danger ? 'btn-primary btn-danger-fill' : 'btn-primary',
          onClick: () => {
            answered = true;
            resolve(true);
          },
        },
      ],
    });
  });
}

// fields: [{ name, label, type, value, placeholder, help, options, required }]
export function formHtml(fields) {
  return fields
    .map((f) => {
      if (f.type === 'checkbox') {
        return `<label class="check"><input type="checkbox" name="${f.name}" ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>`;
      }
      let input;
      if (f.type === 'select') {
        input = `<select name="${f.name}">${f.options.map((o) => {
          const [v, l] = Array.isArray(o) ? o : [o, o];
          return `<option value="${esc(v)}" ${String(v) === String(f.value) ? 'selected' : ''}>${esc(l)}</option>`;
        }).join('')}</select>`;
      } else if (f.type === 'textarea') {
        input = `<textarea name="${f.name}" rows="${f.rows || 5}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`;
      } else {
        input = `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''} autocomplete="${f.type === 'password' ? 'new-password' : 'off'}">`;
      }
      return `<label class="field"><span>${esc(f.label)}</span>${input}${f.help ? `<small>${f.help}</small>` : ''}</label>`;
    })
    .join('');
}

export function formValues(root) {
  const out = {};
  for (const el of root.querySelectorAll('input[name], select[name], textarea[name]')) {
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

// Show a form in a modal; resolves to submit() result, or null if cancelled.
export function formDialog({ title, fields, submitLabel = 'Save', intro = '', wide = false, submit }) {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title,
      wide,
      body: `${intro ? `<div class="notice">${intro}</div>` : ''}<form>${formHtml(fields)}</form>`,
      onClose: () => !done && resolve(null),
      actions: [
        { label: 'Cancel' },
        {
          label: submitLabel,
          className: 'btn-primary',
          onClick: async ({ body }) => {
            const values = formValues(body);
            const result = submit ? await submit(values) : values;
            done = true;
            resolve(result ?? values);
          },
        },
      ],
    });
  });
}

// Live log viewer for a background job. Resolves when the modal closes with the final status.
export function showJob(serverId, job, { onDone } = {}) {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="row" style="margin-bottom:10px"><span class="job-status"></span><span class="muted small">You can close this window; the task keeps running. See Tasks.</span></div>
    <pre class="log"></pre>`;
  const pre = body.querySelector('pre');
  const statusEl = body.querySelector('.job-status');
  let offset = 0;
  let stopped = false;
  let notified = false;
  const m = modal({ title: job.title, body, wide: true, actions: [{ label: 'Close' }], onClose: () => (stopped = true) });

  const tick = async () => {
    if (stopped) return;
    try {
      const j = await api(`/servers/${serverId}/jobs/${job.id}?offset=${offset}`);
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
      if (j.restart) pre.textContent = j.log;
      else pre.textContent += j.log;
      offset = j.offset;
      if (atBottom) pre.scrollTop = pre.scrollHeight;
      statusEl.innerHTML = statusBadge(j.status);
      if (j.status !== 'running') {
        if (!notified) {
          notified = true;
          toast(`${j.title}: ${j.status === 'success' ? 'finished' : 'failed'}`, j.status === 'success' ? 'ok' : 'error');
          onDone?.(j);
        }
        return;
      }
    } catch (err) {
      statusEl.innerHTML = `<span class="badge bad">${esc(err.message)}</span>`;
    }
    setTimeout(tick, 1000);
  };
  tick();
  return m;
}

export function statusBadge(status) {
  const map = { running: 'accent', success: 'ok', failed: 'bad', active: 'ok', online: 'ok', inactive: '', failed_: 'bad', stopped: 'warn', errored: 'bad' };
  const cls = map[status] ?? '';
  const icon = status === 'running' ? '<span class="spinner" style="width:10px;height:10px;border-width:2px"></span> ' : '';
  return `<span class="badge ${cls}">${icon}${esc(status)}</span>`;
}

export function fmtBytes(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtDuration(seconds) {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtDate(ms) {
  if (!ms) return '–';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export const loadingHtml = (text = 'Loading…') => `<div class="loading"><span class="spinner"></span>${esc(text)}</div>`;

export function errorHtml(err) {
  return `<div class="notice bad"><strong>Something went wrong.</strong><br><span style="white-space:pre-wrap">${esc(err.message || err)}</span></div>`;
}

// Delegate clicks on [data-action] elements to handlers[action](dataset, element).
// Calling it again on the same root replaces the previous handlers (views re-render in place).
export function onAction(root, handlers) {
  if (root._sbOnAction) root.removeEventListener('click', root._sbOnAction);
  root._sbOnAction = (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    const handler = handlers[el.dataset.action];
    if (handler) {
      e.preventDefault();
      handler(el.dataset, el, e);
    }
  };
  root.addEventListener('click', root._sbOnAction);
}

export function randomPassword(len = 20) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

// The logged-in user (set by app.js from /api/me). The server enforces permissions; this only
// hides buttons the user could not use anyway.
export const session = { user: null };

export function can(permission) {
  const u = session.user;
  if (!u) return false;
  if (u.isOwner) return true;
  if (permission === 'owner') return false;
  return !permission || u.permissions.includes(permission);
}
