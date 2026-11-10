// #/approve/<id>: someone is logging in with your account; opened from the notification on your
// phone. Pick the number the login screen shows to approve, or deny.
import { api, esc, toast, loadingHtml, errorHtml } from '../ui.js';

export async function render(el, { rest = [] }) {
  const id = rest[0];
  el.innerHTML = loadingHtml();
  let r;
  try {
    r = await api(`/login-approvals/${encodeURIComponent(id || '')}`);
  } catch (err) {
    el.innerHTML = `<div class="card" style="max-width:460px;margin:20px auto;text-align:center"><h2>Nothing to approve</h2>${errorHtml(err)}<a class="btn" href="#/servers">Home</a></div>`;
    return;
  }
  const done = (status) => {
    el.innerHTML = `<div class="card" style="max-width:460px;margin:20px auto;text-align:center">
      <h2>${status === 'approved' ? '✓ Approved' : 'Denied'}</h2>
      <p>${status === 'approved' ? 'The login can continue on the other device.' : 'That login was stopped. If it was not you, change your password now (My account).'}</p>
      <div class="row" style="justify-content:center">${status === 'approved' ? '' : '<a class="btn btn-primary" href="#/account">Change password</a>'}<a class="btn" href="#/servers">Home</a></div></div>`;
  };
  if (r.status !== 'pending') return done(r.status);
  el.innerHTML = `<div class="card" style="max-width:460px;margin:20px auto">
    <h2 style="margin-top:0;text-align:center">Is this you logging in?</h2>
    <table class="small"><tbody>
      <tr><td class="muted">Account</td><td><b>${esc(r.username)}</b></td></tr>
      <tr><td class="muted">Device</td><td>${esc(r.device)}</td></tr>
      <tr><td class="muted">From</td><td class="mono">${esc(r.ip)}</td></tr>
    </tbody></table>
    <p style="text-align:center;margin:16px 0 0">Tap the number the login screen shows:</p>
    <div class="approve-choices">${r.choices.map((n) => `<button class="btn" data-n="${n}">${n}</button>`).join('')}</div>
    <button class="btn-danger" data-deny style="width:100%;justify-content:center">This wasn't me: deny</button>
  </div>`;
  const decide = async (body) => {
    el.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const out = await api(`/login-approvals/${encodeURIComponent(id)}`, { method: 'POST', body });
      if (body.decision === 'approve' && out.status !== 'approved') toast('That was not the number on the login screen, so the login was denied.', 'error', 8000);
      done(out.status);
    } catch (err) {
      toast(err.message, 'error');
      el.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  };
  el.querySelectorAll('[data-n]').forEach((b) => b.addEventListener('click', () => decide({ decision: 'approve', number: Number(b.dataset.n) })));
  el.querySelector('[data-deny]').addEventListener('click', () => decide({ decision: 'deny' }));
}
