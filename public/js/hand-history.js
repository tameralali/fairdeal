// Hand history: every hand of this game in a list on the left, sorted and filtered, with the chosen
// player's result and cards on each row, and the replayer on the right. Stepping past the end of a
// hand carries straight on into the next hand of the list, and so does Play.
import { esc, dialog } from './ui.js';
import { cardHTML, backHTML, slotHTML, prefs } from './cards.js';
import { app, emit, fmt, fmtC, gameShort, gameName } from './table-core.js';
import { buildReplay, canReplay } from '/shared/replay.js';
import { boardName } from './game-form.js';
import { handDetailsInto, checkBadge } from './table-dialogs.js';

const SORTS = [['new', 'Newest first'], ['old', 'Oldest first'], ['pot', 'Biggest pots'], ['won', 'Biggest wins'], ['lost', 'Biggest losses']];
const FILTERS = [['all', 'All hands'], ['showdown', 'Showdowns'], ['allin', 'All-ins'], ['bomb', 'Bomb pots']];
const STEP_MS = 1100;
const HOLD_MS = 2400; // how long the result stays up before Play moves on to the next hand
const LETTER = { flop: 'F', turn: 'T', river: 'R' };

const signed = (n) => `${n > 0 ? '+' : ''}${fmtC(n)}`;
const when = (at) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const icon = {
  prevHand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11.5 6 5.5 12l6 6M18.5 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5 8.5 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6L19 12z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 5.5h3v13h-3zM13.5 5.5h3v13h-3z" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5.5 15.5 12 9 18.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  nextHand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 6l6 6-6 6M12.5 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  newTab: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 4.5h6v6M19.2 4.8 11 13M17.5 13.5V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

let current = null; // the open history, so new hands can be added to its list while it is open

// start: the hand to show first, at step. sort, filter, game and who: how the list opens. who is the
// player whose hands and results the list shows; empty or 'all' (Everyone) shows every hand with its
// pot. view 'details' opens on the details. page: the history fills a tab of its own (hands-page.js),
// with page.actions in its head in place of Close; otherwise its head has Open in new tab, which
// carries on in a new tab exactly where this one is.
export async function historyDialog({ start = null, sort = null, who = null, filter = null, game = null, step = 0, view = null, page = null } = {}) {
  if (current) current.close();
  const r = await emit('hands:list');
  if (!r.ok) return;
  const me = app.state.me.userId;
  const ended = app.state.table.status === 'ended';
  const firstSort = ended ? 'old' : 'new';
  const v = {
    all: r.hands, sort: SORTS.some(([k]) => k === sort) ? sort : firstSort,
    filter: FILTERS.some(([k]) => k === filter) ? filter : 'all',
    game: game && r.hands.some((h) => h.gameType === game) ? game : 'all', who: null,
    cur: null, mode: view === 'details' ? 'details' : 'replay', rec: null, R: null, i: 0, playing: false, timer: null, cache: new Map(), loading: 0,
  };
  const played = (id) => v.all.some((h) => h.nets[id] !== undefined);
  const names = () => {
    const out = new Map();
    for (const h of v.all) for (const [id, nm] of Object.entries(h.names || {})) if (!out.has(id)) out.set(id, nm);
    return out;
  };
  v.who = who === 'all' ? '' : who && played(who) ? who : played(me) ? me : '';

  // the address of this history as it stands, for Open in new tab and for the tab of its own
  const tabURL = () => {
    const q = new URLSearchParams();
    if (v.cur != null) q.set('hand', v.cur);
    if (v.mode === 'details') q.set('view', 'details');
    else if (v.R && v.i > 0) q.set('step', v.i);
    q.set('who', v.who || 'all');
    if (v.sort !== firstSort) q.set('sort', v.sort);
    if (v.filter !== 'all') q.set('show', v.filter);
    if (v.game !== 'all') q.set('game', v.game);
    return `/hands/${encodeURIComponent(app.tableId)}?${q}`;
  };
  const newTab = `<a class="btn small hh-newtab" data-newtab href="${esc(tabURL())}" target="_blank" rel="noopener" title="Open the hand history in its own tab">${icon.newTab}<span class="long">Open in new tab</span><span class="short">New tab</span></a>`;
  const dlg = dialog({
    title: `Hand history, ${app.state.table.name}`, className: `hh-dlg${page ? ' hh-page' : ''}`, closable: !page,
    actions: page ? page.actions || '' : newTab, body: '<p class="muted" style="padding:1.2rem">Loading…</p>',
  });
  current = { close: () => dlg.close(), refresh };
  const $ = (s) => dlg.el.querySelector(s);
  // keep the address up to date: the link in the head, or this tab's own address
  const syncURL = () => {
    if (page) { try { history.replaceState(null, '', tabURL()); } catch { /* not allowed */ } return; }
    const a = dlg.el.querySelector('[data-newtab]');
    if (a) a.href = tabURL();
  };

  // ----- the list -----
  const list = () => {
    let out = v.all.filter((h) => {
      if (v.game !== 'all' && h.gameType !== v.game) return false;
      if (v.who && h.nets[v.who] === undefined) return false;
      if (v.filter === 'showdown') return h.showdown;
      if (v.filter === 'allin') return h.allIn;
      if (v.filter === 'bomb') return h.isBomb;
      return true;
    });
    // a player's own result; for everyone, the biggest single win or loss in the hand
    const vals = (h) => Object.values(h.nets || {});
    const net = (h) => (v.who ? h.nets[v.who] : v.sort === 'lost' ? Math.min(0, ...vals(h)) : Math.max(0, ...vals(h)));
    if (v.sort === 'old') out.sort((a, b) => a.handNumber - b.handNumber);
    else if (v.sort === 'pot') out.sort((a, b) => b.pot - a.pot || b.handNumber - a.handNumber);
    else if (v.sort === 'won') out = out.filter((h) => net(h) > 0).sort((a, b) => net(b) - net(a) || b.handNumber - a.handNumber);
    else if (v.sort === 'lost') out = out.filter((h) => net(h) < 0).sort((a, b) => net(a) - net(b) || b.handNumber - a.handNumber);
    else out.sort((a, b) => b.handNumber - a.handNumber);
    return out;
  };
  const whoName = () => (v.who === me ? 'You' : names().get(v.who) || 'Player');
  // for everyone: who won the most in the hand, by name
  const topWinner = (h) => {
    const [id, amt] = Object.entries(h.nets || {}).sort((a, b) => b[1] - a[1])[0] || [];
    return id && amt > 0 ? `${id === me ? 'You' : h.names?.[id] || names().get(id) || 'Someone'} +${fmtC(amt)}` : '';
  };
  const rowHTML = (h) => {
    if (!v.who) {
      const flags = [h.isBomb ? 'bomb pot' : '', h.doubleBoard ? 'two boards' : '', h.runCount > 1 ? `ran ${h.runCount} times` : ''].filter(Boolean).join(', ');
      const vals = Object.values(h.nets || {});
      const big = v.sort === 'won' ? Math.max(0, ...vals) : v.sort === 'lost' ? Math.min(0, ...vals) : null;
      return `<button type="button" class="hh-row ${h.handNumber === v.cur ? 'on' : ''}" data-h="${h.handNumber}" role="option" aria-selected="${h.handNumber === v.cur}">
      <span class="hh-n">${h.handNumber}</span>
      <span class="hh-net ${big === null ? 'even' : big > 0 ? 'pos' : 'neg'}">${big === null ? fmtC(h.pot) : signed(big)}</span>
      <span class="hh-cards"></span>
      <span class="hh-sub">${esc(when(h.at))}, ${esc(gameShort(h.gameType))}${flags ? `, ${esc(flags)}` : ''}${topWinner(h) ? `<b>${esc(topWinner(h))}</b>` : ''}</span>
    </button>`;
    }
    const net = h.nets[v.who];
    const cls = net === undefined ? 'out' : net > 0 ? 'pos' : net < 0 ? 'neg' : 'even';
    const cards = h.cards?.[v.who];
    const flags = [h.isBomb ? 'bomb pot' : '', h.doubleBoard ? 'two boards' : '', h.runCount > 1 ? `ran ${h.runCount} times` : ''].filter(Boolean).join(', ');
    return `<button type="button" class="hh-row ${h.handNumber === v.cur ? 'on' : ''}" data-h="${h.handNumber}" role="option" aria-selected="${h.handNumber === v.cur}">
      <span class="hh-n">${h.handNumber}</span>
      <span class="hh-net ${cls}">${net === undefined ? 'Not in' : signed(net)}</span>
      <span class="hh-cards">${cards ? cards.map((c) => (c ? cardHTML(c) : backHTML())).join('') : ''}</span>
      <span class="hh-sub">${esc(when(h.at))}, ${esc(gameShort(h.gameType))}${flags ? `, ${esc(flags)}` : ''}${v.sort === 'pot' || net === undefined ? `<b>pot ${fmtC(h.pot)}</b>` : ''}</span>
    </button>`;
  };
  const sideHTML = () => {
    const L = list();
    const games = [...new Set(v.all.map((h) => h.gameType))];
    const people = [...names().entries()].filter(([id]) => played(id)).sort((a, b) => (a[0] === me ? -1 : b[0] === me ? 1 : a[1].localeCompare(b[1])));
    const total = v.who ? L.reduce((s, h) => s + (h.nets[v.who] || 0), 0) : 0;
    const opt = (pairs, val) => pairs.map(([k, l]) => `<option value="${esc(k)}" ${k === val ? 'selected' : ''}>${esc(l)}</option>`).join('');
    return `
      <div class="hh-side-top"><button type="button" class="btn small" data-list>Back to the hand</button></div>
      <div class="hh-tools">
        <label class="hh-who"><span class="lbl">Player</span><select data-k="who">${opt([['', 'Everyone'], ...people.map(([id, nm]) => [id, id === me ? 'You' : nm])], v.who)}</select></label>
        <label><span class="lbl">Sort</span><select data-k="sort">${opt(SORTS, v.sort)}</select></label>
        <label><span class="lbl">Show</span><select data-k="filter">${opt(FILTERS, v.filter)}</select></label>
        ${games.length > 1 ? `<label><span class="lbl">Game</span><select data-k="game">${opt([['all', 'All games'], ...games.map((g) => [g, gameShort(g)])], v.game)}</select></label>` : ''}
      </div>
      <p class="hh-sum">${L.length} hand${L.length === 1 ? '' : 's'}${L.length && v.who ? `, ${esc(whoName())} <b class="${total > 0 ? 'pos' : total < 0 ? 'neg' : ''}">${signed(total)}</b>` : ''}</p>
      <div class="hh-list" role="listbox" aria-label="Hands">${L.length ? L.map(rowHTML).join('') : `<p class="muted hh-empty">${v.all.length ? 'No hands match.' : 'No finished hands yet.'}</p>`}</div>`;
  };
  const drawSide = () => {
    $('.hh-side').innerHTML = sideHTML();
    markRow(true);
  };
  const markRow = (scroll) => {
    dlg.el.querySelectorAll('.hh-row').forEach((b) => {
      const on = Number(b.dataset.h) === v.cur;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on);
      if (on && scroll) b.scrollIntoView({ block: 'nearest' });
    });
  };

  // ----- one hand -----
  const neighbor = (d) => {
    const L = list();
    const k = L.findIndex((h) => h.handNumber === v.cur);
    if (k < 0) return L.length ? L[d > 0 ? 0 : L.length - 1].handNumber : null;
    return L[k + d]?.handNumber ?? null;
  };
  const record = async (n) => {
    if (!v.cache.has(n)) {
      const x = await emit('hand:get', { handNumber: n }, { quiet: true });
      if (!x.ok) return null;
      v.cache.set(n, x.record);
    }
    return v.cache.get(n);
  };
  const load = async (n, at = 0) => {
    if (n == null) return;
    const ticket = ++v.loading;
    v.cur = n;
    markRow(true);
    const rec = await record(n);
    if (ticket !== v.loading) return; // a later choice won
    v.rec = rec;
    v.R = rec && canReplay(rec) ? buildReplay(rec, fmt) : null;
    v.i = v.R ? (at === 'last' ? v.R.steps.length - 1 : Math.max(0, Math.min(v.R.steps.length - 1, Number(at) || 0))) : 0;
    drawMain();
    for (const d of [1, -1]) { const k = neighbor(d); if (k != null) record(k); } // ready before it is asked for
  };
  const meta = (rec) => [gameName(rec.gameType), rec.isBomb ? 'bomb pot' : '', rec.doubleBoard ? 'two boards' : '', `blinds ${fmt(rec.smallBlind)}/${fmt(rec.bigBlind)}`, rec.runCount > 1 ? `ran ${rec.runCount} times` : '', when(rec.startedAt)].filter(Boolean).join(', ');
  const drawMain = () => {
    const main = $('.hh-main');
    if (!main) return;
    syncURL();
    const rec = v.rec;
    if (!rec) { main.innerHTML = `<p class="muted">${v.all.length ? 'Pick a hand from the list.' : 'No finished hands yet. They show up here as soon as one ends.'}</p>`; return; }
    const L = list();
    const pos = L.findIndex((h) => h.handNumber === v.cur);
    main.innerHTML = `
      <div class="hh-head">
        <div><h3>Hand #${rec.handNumber}${pos >= 0 ? `<small>${pos + 1} of ${L.length}</small>` : ''}${checkBadge(rec.handNumber, L[pos]?.revealed ?? rec.revealed)}</h3><p>${esc(meta(rec))}</p></div>
        <div class="hh-views"><button type="button" class="btn small hh-list-btn" data-list>Hands</button><div class="seg" data-mode role="group" aria-label="View"><button type="button" data-v="replay" class="${v.mode === 'replay' ? 'on' : ''}">Replay</button><button type="button" data-v="details" class="${v.mode === 'details' ? 'on' : ''}" title="Details and the deck check">Details</button></div></div>
      </div>
      <div class="hh-stage ${v.mode === 'details' ? 'det' : ''}">${v.mode === 'details' ? '<div class="hh-details"></div>' : v.R ? feltHTML(rec, v.R, v.R.steps[v.i], v.who || me) : '<p class="muted">This hand was played before hands were recorded action by action, so it cannot be replayed. Details has everything else.</p>'}</div>
      ${v.mode === 'replay' && v.R ? `<div class="hh-step" aria-live="polite"><span class="num">${v.i + 1}/${v.R.steps.length}</span><span>${esc(v.R.steps[v.i].text)}</span></div>` : ''}
      ${controlsHTML()}`;
    if (v.mode === 'details') handDetailsInto(main.querySelector('.hh-details'), rec);
  };
  const controlsHTML = () => {
    const R = v.R;
    const last = R ? R.steps.length - 1 : 0;
    const prevH = neighbor(-1);
    const nextH = neighbor(1);
    const atEnd = !R || v.i === last;
    const btn = (k, label, html, on = true, cls = '') => `<button type="button" class="${cls}" data-c="${k}" title="${label}" aria-label="${label}" ${on ? '' : 'disabled'}>${html}</button>`;
    if (v.mode === 'details') return `<div class="hh-ctrl">${btn('prevHand', 'Previous hand (up arrow)', icon.prevHand, prevH != null)}${btn('nextHand', 'Next hand (down arrow)', icon.nextHand, nextH != null)}</div>`;
    return `<div class="hh-ctrl">
        ${btn('prevHand', 'Previous hand (up arrow)', icon.prevHand, prevH != null)}
        ${btn('back', 'Back a step (left arrow)', icon.back, (R && v.i > 0) || prevH != null)}
        ${btn('play', v.playing ? 'Pause (space)' : 'Play (space)', v.playing ? icon.pause : icon.play, !!R || nextH != null, 'play')}
        ${btn('next', atEnd ? 'Next hand (right arrow)' : 'Next step (right arrow)', icon.next, (R && !atEnd) || nextH != null)}
        ${btn('nextHand', 'Next hand (down arrow)', icon.nextHand, nextH != null)}
      </div>
      ${R && v.mode === 'replay' ? `<div class="hh-line" role="group" aria-label="Steps">${R.steps.map((s, k) => {
        const label = s.dealt === 'run' ? String((s.run ?? 0) + 1) : LETTER[s.dealt] || '';
        const what = s.dealt === 'run' ? `Run ${(s.run ?? 0) + 1}` : s.dealt ? s.dealt[0].toUpperCase() + s.dealt.slice(1) : s.final ? 'Result' : `Step ${k + 1}`;
        return `<button type="button" data-step="${k}" class="${k === v.i ? 'on' : k < v.i ? 'past' : ''}${label ? ' mark' : ''}${s.final ? ' fin' : ''}" title="${esc(what)}" aria-label="${esc(what)}">${label}</button>`;
      }).join('')}</div>` : ''}`;
  };

  // ----- moving -----
  const stop = () => { clearTimeout(v.timer); v.timer = null; v.playing = false; };
  const go = (k) => { if (!v.R) return; v.i = Math.max(0, Math.min(v.R.steps.length - 1, k)); drawMain(); };
  const next = async () => {
    if (v.R && v.i < v.R.steps.length - 1) return go(v.i + 1);
    await load(neighbor(1), 0);
  };
  const back = async () => {
    if (v.R && v.i > 0) return go(v.i - 1);
    await load(neighbor(-1), 'last');
  };
  const tick = async () => {
    if (!v.playing) return;
    const last = v.R ? v.R.steps.length - 1 : 0;
    if (v.R && v.i < last) {
      go(v.i + 1);
      v.timer = setTimeout(tick, v.i === last ? HOLD_MS : STEP_MS);
      return;
    }
    const n = neighbor(1);
    if (n == null) { stop(); drawMain(); return; }
    await load(n, 0);
    if (v.playing) v.timer = setTimeout(tick, STEP_MS);
  };
  const play = () => {
    if (v.playing) { stop(); drawMain(); return; }
    v.playing = true;
    if (v.mode !== 'replay') v.mode = 'replay';
    drawMain();
    tick();
  };
  const act = (k) => {
    if (k === 'play') return play();
    stop();
    if (k === 'next') return next();
    if (k === 'back') return back();
    if (k === 'nextHand') return load(neighbor(1), 0);
    if (k === 'prevHand') return load(neighbor(-1), 0);
  };

  // ----- events -----
  dlg.el.addEventListener('click', (e) => {
    // the history goes on in a tab of its own, so this one closes and the table shows again
    if (e.target.closest('[data-newtab]')) { stop(); syncURL(); setTimeout(() => dlg.close(), 0); return; }
    const row = e.target.closest('[data-h]');
    if (row) { stop(); $('.hh')?.classList.remove('list-open'); load(Number(row.dataset.h), 0); return; }
    if (e.target.closest('[data-list]')) { $('.hh')?.classList.toggle('list-open'); markRow(true); return; }
    const c = e.target.closest('[data-c]');
    if (c && !c.disabled) { act(c.dataset.c); return; }
    const st = e.target.closest('[data-step]');
    if (st) { stop(); go(Number(st.dataset.step)); return; }
    const m = e.target.closest('[data-mode] button');
    if (m && m.dataset.v !== v.mode) { stop(); v.mode = m.dataset.v; drawMain(); }
  });
  dlg.el.addEventListener('change', (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    v[k] = e.target.value;
    drawSide();
    const L = list();
    const keep = (k === 'who' || k === 'game') && L.some((h) => h.handNumber === v.cur);
    if (keep) { drawMain(); return; }
    stop();
    $('.hh-list')?.scrollTo(0, 0);
    if (L.length) load(L[0].handNumber, 0);
    else { v.cur = null; v.rec = null; drawMain(); }
  });
  dlg.el.addEventListener('keydown', (e) => {
    if (e.target.closest('select, input, textarea')) return;
    const k = { ArrowRight: 'next', ArrowLeft: 'back', ArrowDown: 'nextHand', ArrowUp: 'prevHand', ' ': 'play' }[e.key];
    if (!k || (v.mode === 'details' && (k === 'next' || k === 'back' || k === 'play'))) return;
    e.preventDefault();
    act(k);
  });
  dlg.el.addEventListener('close', () => { stop(); if (current && current.refresh === refresh) current = null; });

  // New hands at a live table join the list while it is open.
  async function refresh() {
    const x = await emit('hands:list', {}, { quiet: true });
    if (!x.ok || !dlg.el.open) return;
    v.all = x.hands;
    if (!dlg.el.querySelector('.hh-side')) return;
    const scroll = $('.hh-list')?.scrollTop || 0;
    drawSide();
    const l = $('.hh-list');
    if (l) l.scrollTop = scroll;
    if (!v.playing) drawMain();
  }

  dlg.setBody('<div class="hh"><aside class="hh-side"></aside><section class="hh-main" tabindex="-1" aria-label="Hand"></section></div>');
  drawSide();
  const L = list();
  const first = start != null && v.all.some((h) => h.handNumber === start) ? start : L[0]?.handNumber ?? null;
  if (first != null && !L.some((h) => h.handNumber === first)) { v.sort = 'new'; v.filter = 'all'; v.game = 'all'; drawSide(); }
  if (first == null) drawMain();
  else await load(first, start === first ? step : 0);
  // the keys step through the hand from the start, without a ring round the first button in the head
  if (dlg.el.open) $('.hh-main')?.focus({ preventScroll: true });
}

// Called when the table's count of finished hands changes.
export function historyRefresh() { if (current) current.refresh(); }

// The table at one step: seats around the felt, the boards and the pot in the middle. bottomId is the
// player drawn at the bottom (whose results the list shows), else the viewer.
export function feltHTML(rec, R, step, bottomId = null) {
  const ps = step.players;
  const n = ps.length;
  const at = (id) => ps.findIndex((p) => p.id === id);
  const rot = Math.max(0, bottomId && at(bottomId) >= 0 ? at(bottomId) : at(app.state?.me.userId));
  const nb = R.boards.length;
  const bpr = R.bpr;
  const runs = R.runs;
  let seats = '';
  ps.forEach((p, k) => {
    const a = ((90 + ((k - rot + n) % n) * 360 / n) * Math.PI) / 180;
    const x = 50 + 41 * Math.cos(a);
    const y = 50 + 40 * Math.sin(a);
    const bx = 50 + 25 * Math.cos(a);
    const by = 50 + 23 * Math.sin(a);
    const upper = Math.sin(a) < -0.3;
    const cards = p.cards
      ? p.cards.map((c) => (c ? cardHTML(c, step.final && p.folded ? 'dim' : '') : backHTML())).join('')
      : Array.from({ length: rec.dealt.holeCount || 2 }, () => backHTML()).join('');
    const cls = ['rp-seat', upper ? 'up' : 'down', step.actor === p.seat ? 'actor' : '', p.folded ? 'folded' : '', step.final && p.won ? 'winner' : ''].filter(Boolean).join(' ');
    const tagCls = p.won && step.final ? 'win' : p.tag === 'All-in' ? 'allin' : (p.tag || '').toLowerCase();
    seats += `<div class="${cls}" style="left:${x.toFixed(1)}%;top:${y.toFixed(1)}%">
      ${p.folded && !(p.cards || []).some(Boolean) ? '' : `<div class="rp-cards n${(p.cards || []).length || rec.dealt.holeCount || 2}">${cards}</div>`}
      <div class="rp-plate"><b>${esc(p.name)}${p.seat === rec.buttonSeat ? ' <span class="rp-btn" title="Dealer">D</span>' : ''}</b><span class="num">${fmt(p.stack)}</span>${p.tag ? `<em class="${esc(tagCls)}">${esc(p.tag)}</em>` : ''}</div>
    </div>`;
    if (p.bet > 0) seats += `<div class="rp-bet" style="left:${bx.toFixed(1)}%;top:${by.toFixed(1)}%">${fmt(p.bet)}</div>`;
  });
  let boards = '';
  const shownRuns = new Set(step.cuts.map((c, b) => (c > 0 ? Math.floor(b / bpr) : -1)).filter((r) => r >= 0));
  for (let b = 0; b < nb; b++) {
    const run = Math.floor(b / bpr);
    if (run > 0 && !shownRuns.has(run)) continue;
    const cut = step.cuts[b];
    const cards = R.boards[b].map((c, j) => (j < cut ? cardHTML(c) : slotHTML())).join('') + Array.from({ length: Math.max(0, 5 - R.boards[b].length) }, () => slotHTML()).join('');
    const label = boardName(b, bpr, nb);
    boards += `<div class="rp-board">${label && (runs > 1 || bpr > 1) ? `<small>${esc(label)}</small>` : ''}<div>${cards}</div></div>`;
  }
  return `<div class="rp-felt" style="--felt:${esc(prefs.felt || app.state?.table.settings.feltColor || '#507a4e')}">
    <div class="rp-oval"></div>
    <div class="rp-center"><div class="rp-boards b${bpr} k${Math.min(4, shownRuns.size || 1)}">${boards}</div><div class="rp-pot num">Pot ${fmt(step.pot)}</div></div>
    ${seats}
  </div>`;
}
