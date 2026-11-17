// REST client, identity bootstrap and chip formatting.
import { dialog, esc } from './ui.js';

const KEY = 'fd:token';

export const api = {
  get token() { try { return localStorage.getItem(KEY); } catch { return null; } },
  set token(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* storage blocked */ } },
  async req(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = 'Bearer ' + this.token;
    const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let j = {};
    try { j = await r.json(); } catch { /* empty body */ }
    if (!r.ok) {
      const e = new Error(j.error || `Request failed (${r.status})`);
      e.status = r.status;
      throw e;
    }
    return j;
  },
  get(p) { return this.req('GET', p); },
  post(p, b) { return this.req('POST', p, b || {}); },
  patch(p, b) { return this.req('PATCH', p, b || {}); },
  async download(path, filename) {
    const r = await fetch(path, { headers: { authorization: 'Bearer ' + this.token } });
    if (!r.ok) throw new Error('Download failed');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  },
};

// Returns /api/me, creating a guest identity (just a name, like PokerNow) when needed.
export async function ensureIdentity() {
  if (api.token) {
    try { return await api.get('/api/me'); }
    catch (e) { if (e.status === 401) api.token = null; else throw e; }
  }
  await identityDialog();
  return api.get('/api/me');
}

export function identityDialog({ mode = 'guest', closable = false } = {}) {
  return new Promise((resolve) => {
    const dlg = dialog({
      title: mode === 'login' ? 'Sign in' : 'What should the table call you?',
      className: 'narrow',
      closable,
      body: `
        <form data-form="guest" class="stack ${mode === 'login' ? 'hidden' : ''}">
          <label><span class="lbl">Your name at the table</span><input name="name" type="text" maxlength="24" autocomplete="nickname" required></label>
          <button class="btn primary" type="submit">Continue</button>
          <p class="hint">No account needed to play. Create one later to join clubs or play from another device.</p>
          <button class="btn ghost small" type="button" data-switch="login">I have an account</button>
        </form>
        <form data-form="login" class="stack ${mode === 'login' ? '' : 'hidden'}">
          <label><span class="lbl">Username</span><input name="username" type="text" autocomplete="username" required></label>
          <label><span class="lbl">Password</span><input name="password" type="password" autocomplete="current-password" required></label>
          <button class="btn primary" type="submit">Sign in</button>
          <button class="btn ghost small" type="button" data-switch="guest">Play as a guest instead</button>
        </form>
        <p class="bad hidden" data-err></p>`,
    });
    const err = dlg.$('[data-err]');
    const show = (m) => { err.textContent = m; err.classList.remove('hidden'); };
    dlg.el.addEventListener('click', (e) => {
      const sw = e.target.closest('[data-switch]');
      if (!sw) return;
      dlg.$$('[data-form]').forEach((f) => f.classList.toggle('hidden', f.dataset.form !== sw.dataset.switch));
      dlg.$('h2').textContent = sw.dataset.switch === 'login' ? 'Sign in' : 'What should the table call you?';
    });
    dlg.$('[data-form=guest]').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api.post('/api/auth/guest', { name: e.target.name.value });
        api.token = r.token;
        dlg.close();
        resolve(r.user);
      } catch (x) { show(x.message); }
    });
    dlg.$('[data-form=login]').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api.post('/api/auth/login', { username: e.target.username.value, password: e.target.password.value });
        api.token = r.token;
        dlg.close();
        resolve(r.user);
      } catch (x) { show(x.message); }
    });
    setTimeout(() => dlg.$('input:not([type=hidden])')?.focus(), 30);
  });
}

export function accountDialog(user) {
  return new Promise((resolve) => {
    const dlg = dialog({
      title: 'Create an account',
      className: 'narrow',
      body: `
        <form class="stack">
          <p class="muted">Keeps your name, tables and club balances. Sign in on any device with the same username.</p>
          <label><span class="lbl">Username</span><input name="username" type="text" autocomplete="username" required minlength="3" maxlength="20"></label>
          <label><span class="lbl">Password</span><input name="password" type="password" autocomplete="new-password" required minlength="6"></label>
          <label><span class="lbl">Display name</span><input name="name" type="text" maxlength="24" value="${esc(user?.name || '')}"></label>
          <p class="bad hidden" data-err></p>
          <button class="btn primary" type="submit">Create account</button>
        </form>`,
      onClose: () => resolve(null),
    });
    dlg.$('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const f = e.target;
        const r = await api.post('/api/auth/register', { username: f.username.value, password: f.password.value, name: f.name.value });
        api.token = r.token;
        resolve(r.user);
        dlg.close();
      } catch (x) {
        const el = dlg.$('[data-err]');
        el.textContent = x.message;
        el.classList.remove('hidden');
      }
    });
  });
}

export function fmtChips(a, decimals = 0) {
  if (a === null || a === undefined || Number.isNaN(a)) return '';
  const v = decimals ? a / 100 : a;
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function toInput(a, decimals = 0) {
  if (a === null || a === undefined) return '';
  return decimals ? (a / 100).toFixed(2) : String(a);
}

export function parseChips(str, decimals = 0) {
  const v = Number(String(str ?? '').replace(/[,\s]/g, ''));
  if (!Number.isFinite(v)) return NaN;
  return Math.round(decimals ? v * 100 : v);
}
