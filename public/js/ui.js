// Small DOM helpers shared by every page.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let toastBox;
export function toast(text, kind = '') {
  if (!toastBox) {
    toastBox = document.createElement('div');
    toastBox.className = 'toasts';
    toastBox.setAttribute('role', 'status');
    toastBox.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastBox);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  toastBox.appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 5000 : 3200);
}

// Opens a modal <dialog>. body/foot are HTML strings. Returns helpers.
export function dialog({ title, body = '', foot = '', className = '', tabs = null, onClose = null, closable = true }) {
  const d = document.createElement('dialog');
  d.className = className;
  d.innerHTML = `
    <div class="dlg-head"><h2>${esc(title)}</h2>${closable ? '<button class="btn ghost small" data-close aria-label="Close">Close</button>' : ''}</div>
    ${tabs ? `<div class="tabs" role="tablist">${tabs.map((t, i) => `<button role="tab" data-tab="${esc(t.id)}" class="${i === 0 ? 'on' : ''}">${esc(t.label)}</button>`).join('')}</div>` : ''}
    <div class="dlg-body">${body}</div>
    ${foot ? `<div class="dlg-foot">${foot}</div>` : ''}`;
  document.body.appendChild(d);
  const api = {
    el: d,
    $: (s) => d.querySelector(s),
    $$: (s) => [...d.querySelectorAll(s)],
    body: d.querySelector('.dlg-body'),
    close() { if (d.open) d.close(); },
    setBody(html) { d.querySelector('.dlg-body').innerHTML = html; },
  };
  d.addEventListener('close', () => { d.remove(); onClose && onClose(); });
  if (!closable) d.addEventListener('cancel', (e) => e.preventDefault());
  d.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) api.close();
    const tab = e.target.closest('[data-tab]');
    if (tab && tabs) {
      d.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b === tab));
      d.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.tab));
    }
  });
  d.showModal();
  return api;
}

export function confirmDialog(text, { title = 'Are you sure?', ok = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const dlg = dialog({
      title, className: 'narrow',
      body: `<p>${esc(text)}</p>`,
      foot: `<button class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button>`,
      onClose: () => { if (!answered) resolve(false); },
    });
    dlg.$('[data-ok]').addEventListener('click', () => { answered = true; resolve(true); dlg.close(); });
  });
}

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

export function clock(ms) {
  if (ms <= 0) return '0:00';
  const t = Math.ceil(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function copyText(text) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', 'error'));
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  toast('Copied');
}
