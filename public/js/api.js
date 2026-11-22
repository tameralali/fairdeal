// REST client, sign-in and chip formatting.
import { wordmarkHTML } from './brand.js';
import { fmtMoney, parseMoney, moneyInput } from '/shared/money.js';

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
    if (r.status === 401 && headers.authorization && !path.startsWith('/api/auth/')) {
      // the sign-in has ended (signed out elsewhere, a new password, removed from the club): back to
      // the sign-in page; what was asked for waits, as the page is going anyway
      this.token = null;
      location.reload();
      return new Promise(() => {});
    }
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

export const BRAND_HEX = '6f3ac1d0a85c2e94b7f1036d4e5a9c8b21f0e7d6c5b4a39281706f5e4d3c2b1a';

// Returns /api/me. The site is invite only, so without a valid sign-in the page shows the
// members-only sign-in screen and waits there.
export async function ensureIdentity() {
  if (api.token) {
    try { return await api.get('/api/me'); }
    catch (e) { if (e.status === 401) api.token = null; else throw e; }
  }
  await gate();
  return api.get('/api/me');
}

export function gate() {
  return new Promise((resolve) => {
    document.body.classList.add('gated');
    const el = document.createElement('div');
    el.className = 'gate';
    el.innerHTML = `<main class="gate-card">
      <div class="wordmark">${wordmarkHTML(34)}</div>
      <h1>Members only</h1>
      <p class="muted">The Aquarium is a private poker game. Sign in with your username and password. New here? Open the invite link an admin emailed you.</p>
      <form class="stack" data-login>
        <label><span class="lbl">Username</span><input name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
        <label><span class="lbl">Password</span><input name="password" type="password" autocomplete="current-password" required></label>
        <p class="bad hidden" data-err role="alert"></p>
        <button class="btn primary big" type="submit">Sign in</button>
      </form>
      <p class="hint">Forgot your password? Ask an admin to email you a reset link.</p>
      <p class="hint"><a href="/fair">How the deal is kept fair</a></p>
    </main>`;
    document.body.appendChild(el);
    const form = el.querySelector('[data-login]');
    const err = el.querySelector('[data-err]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.classList.add('hidden');
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        const r = await api.post('/api/auth/login', { username: form.elements.username.value.trim(), password: form.elements.password.value });
        api.token = r.token;
        el.remove();
        document.body.classList.remove('gated');
        resolve(r.user);
      } catch (x) {
        err.textContent = x.message;
        err.classList.remove('hidden');
        btn.disabled = false;
      }
    });
    setTimeout(() => form.elements.username.focus(), 30);
  });
}

// Ledgers keep the cents ($25.00) so amounts line up; see /shared/money.js.
export function fmtChips(a, decimals = 2) { return fmtMoney(a, decimals, 'always'); }
export function toInput(a, decimals = 2) { return moneyInput(a, decimals); }
export function parseChips(str, decimals = 2) { return parseMoney(str, decimals); }
