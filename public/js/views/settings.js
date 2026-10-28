import { api, run, toast } from '../ui.js';

export async function render(el) {
  el.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><div class="sub">Serverboy portal settings.</div></div></div>
    <div class="card" style="max-width:480px">
      <h2>Change admin password</h2>
      <form id="pw">
        <label class="field"><span>Current password</span><input type="password" name="current" required autocomplete="current-password"></label>
        <label class="field"><span>New password</span><input type="password" name="next" required minlength="8" autocomplete="new-password"></label>
        <label class="field"><span>Repeat new password</span><input type="password" name="repeat" required autocomplete="new-password"></label>
        <button class="btn-primary">Change password</button>
      </form>
    </div>`;
  el.querySelector('#pw').addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.next.value !== f.repeat.value) return toast('The new passwords do not match', 'error');
    const ok = await run(f.querySelector('button'), () => api('/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } }), 'Password changed');
    if (ok) f.reset();
  });
}
