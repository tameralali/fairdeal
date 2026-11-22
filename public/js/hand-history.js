// Hand history: every hand of this game, or of every game of the club, in a list on the left, sorted
// and filtered, with the chosen player's result and cards on each row, and the replayer on the right.
// Stepping past the end of a hand carries straight on into the next hand of the list, and so does Play.
import { esc, dialog, toast } from './ui.js';
import { api } from './api.js';
import { cardHTML, backHTML, slotHTML, prefs } from './cards.js';
import { app, emit, fmt, fmtC, gameShort, gameName } from './table-core.js';
import { buildReplay, canReplay } from '/shared/replay.js';
import { fmtMoney } from '/shared/money.js';
import { boardName } from './game-form.js';
import { handDetailsInto, checkBadge } from './table-dialogs.js';
import { FairClient } from './fair-client.js';
import { SORTS, showChoices, runChoices, isShow, isRuns, handKey, pickHands, resultOf, topWinner } from './hand-filter.js';

const STEP_MS = 1100;
const HOLD_MS = 2400; // how long the result stays up before Play moves on to the next hand
const LETTER = { flop: 'F', turn: 'T', river: 'R' };
const LOOK_EVERY = 30000; // how often a history of every game looks for new hands while it is open

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
const fairs = new Map(); // every game's check of its hands, for the history of every game

// start: the hand to show first (its number, or for every game its key, game.number), at step. sort,
// filter, game, runs, session and who: how the list opens. who is the player whose hands and results
// the list shows; empty or 'all' (Everyone) shows every hand with its pot. view 'details' opens on the
// details. page: the history fills a tab of its own (hands-page.js), with page.actions in its head in
// place of Close; otherwise its head has Open in new tab, which carries on in a new tab exactly where
// this one is. club: { id, data } for the hands of every game of the club (data: what
// /api/clubs/:id/hands answered, if it is at hand already). onClose(choices) hears how the list was
// left when the history closes.
export async function historyDialog({ start = null, sort = null, who = null, filter = null, game = null, runs = null, session = null, step = 0, view = null, page = null, club = null, onClose = null } = {}) {
  if (current) current.close();
  const fetchAll = async () => {
    if (!club) return emit('hands:list', {}, { quiet: true });
    try { return { ok: true, ...(await api.get(`/api/clubs/${encodeURIComponent(club.id)}/hands`)) }; }
    catch (e) { toast(e.message, 'error'); return { ok: false }; }
  };
  const r = club?.data ? { ok: true, ...club.data } : club ? await fetchAll() : await emit('hands:list');
  if (!r.ok) return;
  if (club) {
    // every game: no table of its own, each hand is drawn with its game's money and felt
    app.state ||= { me: { userId: r.me }, table: { id: '', name: 'All games', status: 'ended', settings: {} } };
    app.me ||= { id: r.me };
  }
  const me = club ? r.me : app.state.me.userId;
  const ended = club || app.state.table.status === 'ended';
  const firstSort = club ? 'pot' : ended ? 'old' : 'new'; // every game: biggest pots first
  const sessions = new Map((r.sessions || []).map((x) => [x.id, x]));
  const v = {
    all: r.hands, sort: SORTS.some(([k]) => k === sort) ? sort : firstSort,
    filter: isShow(filter) ? filter : 'all', runs: isRuns(runs) ? String(runs) : 'any',
    session: session && sessions.has(session) ? session : 'all',
    game: game && r.hands.some((h) => h.gameType === game) ? game : 'all', who: null,
    names: r.names || null, seeAll: club ? !!r.seeAll : true, version: r.version || null,
    cur: null, mode: view === 'details' ? 'details' : 'replay', rec: null, R: null, i: 0, playing: false, timer: null, cache: new Map(), loading: 0,
  };
  const played = (id) => v.all.some((h) => h.nets[id] !== undefined);
  const names = () => {
    const out = new Map(Object.entries(v.names || {}));
    for (const h of v.all) for (const [id, nm] of Object.entries(h.names || {})) if (!out.has(id)) out.set(id, nm);
    return out;
  };
  v.who = who === 'all' ? '' : who && played(who) ? who : played(me) ? me : '';
  const byKey = (k) => v.all.find((h) => handKey(h) === k) || null;
  // amounts in the list: cents across every game (each game's own unit otherwise)
  const money = club ? (a) => fmtMoney(a, 2, 'always', '') : fmtC;
  const signed = (n) => `${n > 0 ? '+' : ''}${money(n)}`;
  const sessionName = (h) => (club ? sessions.get(h.tableId)?.name || 'Game' : '');

  // the address of this history as it stands, for Open in new tab and for the tab of its own
  const tabURL = () => {
    const q = new URLSearchParams();
    if (v.cur != null) q.set('hand', v.cur);
    if (v.mode === 'details') q.set('view', 'details');
    else if (v.R && v.i > 0) q.set('step', v.i);
    q.set('who', v.who || 'all');
    if (v.session !== 'all') q.set('session', v.session);
    if (v.sort !== firstSort) q.set('sort', v.sort);
    if (v.filter !== 'all') q.set('show', v.filter);
    if (v.runs !== 'any') q.set('runs', v.runs);
    if (v.game !== 'all') q.set('game', v.game);
    return club ? `/hands?${q}` : `/hands/${encodeURIComponent(app.tableId)}?${q}`;
  };
  const newTab = `<a class="btn small hh-newtab" data-newtab href="${esc(tabURL())}" target="_blank" rel="noopener" title="Open the hand history in its own tab">${icon.newTab}<span class="long">Open in new tab</span><span class="short">New tab</span></a>`;
  const dlg = dialog({
    title: club ? 'Hand history, every game' : `Hand history, ${app.state.table.name}`, className: `hh-dlg${page ? ' hh-page' : ''}${club ? ' hh-all' : ''}`, closable: !page,
    actions: page ? page.actions || '' : newTab, body: '<p class="muted" style="padding:1.2rem">Loading…</p>',
  });
  current = { close: () => dlg.close(), refresh };
  const $ = (q) => dlg.el.querySelector(q);
  // keep the address up to date: the link in the head, or this tab's own address
  const syncURL = () => {
    if (page) { try { history.replaceState(null, '', tabURL()); } catch { /* not allowed */ } return; }
    const a = dlg.el.querySelector('[data-newtab]');
    if (a) a.href = tabURL();
  };

  // ----- the list -----
  const list = () => pickHands(v.all, v);
  const whoName = () => (v.who === me ? 'You' : names().get(v.who) || 'Player');
  const winnerText = (h) => {
    const w = topWinner(h);
    return w ? `${w[0] === me ? 'You' : h.names?.[w[0]] || names().get(w[0]) || 'Someone'} +${money(w[1])}` : '';
  };
  const flagsOf = (h) => [h.isBomb ? 'bomb pot' : '', h.doubleBoard ? 'two boards' : '', h.runCount > 1 ? `ran ${h.runCount} times` : ''].filter(Boolean).join(', ');
  const subOf = (h) => [sessionName(h), when(h.at), gameShort(h.gameType), flagsOf(h)].filter(Boolean).join(', ');
  const rowHTML = (h) => {
    const k = handKey(h);
    const on = k === v.cur;
    if (!v.who) {
      const big = v.sort === 'won' || v.sort === 'lost' ? resultOf(h, '', v.sort) : null;
      return `<button type="button" class="hh-row ${on ? 'on' : ''}" data-h="${esc(k)}" role="option" aria-selected="${on}">
      <span class="hh-n">${h.handNumber}</span>
      <span class="hh-net ${big === null ? 'even' : big > 0 ? 'pos' : 'neg'}">${big === null ? money(h.pot) : signed(big)}</span>
      <span class="hh-cards"></span>
      <span class="hh-sub">${esc(subOf(h))}${winnerText(h) ? `<b>${esc(winnerText(h))}</b>` : ''}</span>
    </button>`;
    }
    const net = h.nets[v.who];
    const cls = net === undefined ? 'out' : net > 0 ? 'pos' : net < 0 ? 'neg' : 'even';
    const cards = h.cards?.[v.who];
    return `<button type="button" class="hh-row ${on ? 'on' : ''}" data-h="${esc(k)}" role="option" aria-selected="${on}">
      <span class="hh-n">${h.handNumber}</span>
      <span class="hh-net ${cls}">${net === undefined ? 'Not in' : signed(net)}</span>
      <span class="hh-cards">${cards ? cards.map((c) => (c ? cardHTML(c) : backHTML())).join('') : ''}</span>
      <span class="hh-sub">${esc(subOf(h))}${v.sort === 'pot' || net === undefined ? `<b>pot ${money(h.pot)}</b>` : ''}</span>
    </button>`;
  };
  const sideHTML = () => {
    const L = list();
    const games = [...new Set(v.all.map((h) => h.gameType))];
    const people = [...names().entries()].filter(([id]) => played(id)).sort((a, b) => (a[0] === me ? -1 : b[0] === me ? 1 : a[1].localeCompare(b[1])));
    // a player's total over the hands listed; across every game only your own, unless you see the whole club
    const total = v.who && (v.seeAll || v.who === me) ? L.reduce((sum, h) => sum + (h.nets[v.who] || 0), 0) : null;
    const opt = (pairs, val) => pairs.map(([k, l]) => `<option value="${esc(k)}" ${k === val ? 'selected' : ''}>${esc(l)}</option>`).join('');
    const ran = runChoices(v.all);
    const sess = [...sessions.values()];
    return `
      <div class="hh-side-top"><button type="button" class="btn small" data-list>Back to the hand</button></div>
      <div class="hh-tools">
        ${club ? `<label class="hh-wide"><span class="lbl">Session</span><select data-k="session">${opt([['all', 'Every session'], ...sess.map((x) => [x.id, `${x.name}, ${new Date(x.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}`])], v.session)}</select></label>` : ''}
        <label class="hh-who"><span class="lbl">Player</span><select data-k="who">${opt([['', 'Everyone'], ...people.map(([id, nm]) => [id, id === me ? 'You' : nm])], v.who)}</select></label>
        <label><span class="lbl">Sort</span><select data-k="sort">${opt(SORTS, v.sort)}</select></label>
        <label><span class="lbl">Show</span><select data-k="filter">${opt(showChoices(v.all), v.filter)}</select></label>
        ${ran.length ? `<label><span class="lbl">Times run</span><select data-k="runs">${opt(ran, v.runs)}</select></label>` : ''}
        ${games.length > 1 ? `<label><span class="lbl">Game</span><select data-k="game">${opt([['all', 'All games'], ...games.map((g) => [g, gameShort(g)])], v.game)}</select></label>` : ''}
      </div>
      <p class="hh-sum">${L.length} hand${L.length === 1 ? '' : 's'}${L.length && total !== null ? `, ${esc(whoName())} <b class="${total > 0 ? 'pos' : total < 0 ? 'neg' : ''}">${signed(total)}</b>` : ''}</p>
      <div class="hh-list" role="listbox" aria-label="Hands">${L.length ? L.map(rowHTML).join('') : `<p class="muted hh-empty">${v.all.length ? 'No hands match.' : 'No finished hands yet.'}</p>`}</div>`;
  };
  const drawSide = () => {
    $('.hh-side').innerHTML = sideHTML();
    markRow(true);
  };
  const markRow = (scroll) => {
    dlg.el.querySelectorAll('.hh-row').forEach((b) => {
      const on = b.dataset.h === v.cur;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on);
      if (on && scroll) b.scrollIntoView({ block: 'nearest' });
    });
  };

  // ----- one hand -----
  const neighbor = (d) => {
    const L = list();
    const k = L.findIndex((h) => handKey(h) === v.cur);
    if (k < 0) return L.length ? handKey(L[d > 0 ? 0 : L.length - 1]) : null;
    return L[k + d] ? handKey(L[k + d]) : null;
  };
  const fetchRecord = async (k) => {
    if (!club) {
      const x = await emit('hand:get', { handNumber: Number(k) }, { quiet: true });
      return x.ok ? x.record : null;
    }
    const h = byKey(k);
    if (!h) return null;
    try { return (await api.get(`/api/tables/${encodeURIComponent(h.tableId)}/hands/${h.handNumber}`)).record; }
    catch { return null; }
  };
  const record = async (k) => {
    if (!v.cache.has(k)) {
      const rec = await fetchRecord(k);
      if (!rec) return null;
      v.cache.set(k, rec);
    }
    return v.cache.get(k);
  };
  // across every game, each hand is drawn in its own game's money and felt, and checked as that game's
  const useGameOf = (k) => {
    const h = club && byKey(k);
    if (!h) return;
    const x = sessions.get(h.tableId);
    app.dec = x?.decimals ?? 2;
    app.state.table.settings.feltColor = x?.felt || null;
    if (!fairs.has(h.tableId)) fairs.set(h.tableId, new FairClient(h.tableId, async () => ({ ok: false }), null));
    app.fair = fairs.get(h.tableId);
  };
  const load = async (k, at = 0) => {
    if (k == null) return;
    const ticket = ++v.loading;
    v.cur = k;
    markRow(true);
    const rec = await record(k);
    if (ticket !== v.loading) return; // a later choice won
    useGameOf(k);
    v.rec = rec;
    v.R = rec && canReplay(rec) ? buildReplay(rec, fmt) : null;
    v.i = v.R ? (at === 'last' ? v.R.steps.length - 1 : Math.max(0, Math.min(v.R.steps.length - 1, Number(at) || 0))) : 0;
    drawMain();
    for (const d of [1, -1]) { const n = neighbor(d); if (n != null) record(n); } // ready before it is asked for
  };
  const meta = (rec) => [club ? sessionName(byKey(v.cur) || {}) : '', gameName(rec.gameType), rec.isBomb ? 'bomb pot' : '', rec.doubleBoard ? 'two boards' : '', `blinds ${fmt(rec.smallBlind)}/${fmt(rec.bigBlind)}`, rec.runCount > 1 ? `ran ${rec.runCount} times` : '', when(rec.startedAt)].filter(Boolean).join(', ');
  const drawMain = () => {
    const main = $('.hh-main');
    if (!main) return;
    syncURL();
    const rec = v.rec;
    if (!rec) { main.innerHTML = `<p class="muted">${v.all.length ? (v.cur != null ? 'That hand did not load. Try another one.' : 'Pick a hand from the list.') : 'No finished hands yet. They show up here as soon as one ends.'}</p>`; return; }
    const L = list();
    const pos = L.findIndex((h) => handKey(h) === v.cur);
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
      ${R && v.mode === 'replay' ? `<div class="hh-line" role="group" aria-label="Steps">${R.steps.map((st, k) => {
        const label = st.dealt === 'run' ? String((st.run ?? 0) + 1) : LETTER[st.dealt] || '';
        const what = st.dealt === 'run' ? `Run ${(st.run ?? 0) + 1}` : st.dealt ? st.dealt[0].toUpperCase() + st.dealt.slice(1) : st.final ? 'Result' : `Step ${k + 1}`;
        return `<button type="button" data-step="${k}" class="${k === v.i ? 'on' : k < v.i ? 'past' : ''}${label ? ' mark' : ''}${st.final ? ' fin' : ''}" title="${esc(what)}" aria-label="${esc(what)}">${label}</button>`;
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
    if (row) { stop(); $('.hh')?.classList.remove('list-open'); load(row.dataset.h, 0); return; }
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
    const keep = (k === 'who' || k === 'game') && L.some((h) => handKey(h) === v.cur);
    if (keep) { drawMain(); return; }
    stop();
    $('.hh-list')?.scrollTo(0, 0);
    if (L.length) load(handKey(L[0]), 0);
    else { v.cur = null; v.rec = null; drawMain(); }
  });
  dlg.el.addEventListener('keydown', (e) => {
    if (e.target.closest('select, input, textarea')) return;
    const k = { ArrowRight: 'next', ArrowLeft: 'back', ArrowDown: 'nextHand', ArrowUp: 'prevHand', ' ': 'play' }[e.key];
    if (!k || (v.mode === 'details' && (k === 'next' || k === 'back' || k === 'play'))) return;
    e.preventDefault();
    act(k);
  });
  // across every game, new hands from games being played join the list while it is open
  let looker = null;
  if (club) {
    const look = async () => {
      if (document.visibilityState !== 'visible' || !dlg.el.open) return;
      try {
        const x = await api.get(`/api/clubs/${encodeURIComponent(club.id)}/hands/version`);
        if (x.version !== v.version) refresh();
      } catch { /* try again next time */ }
    };
    looker = setInterval(look, LOOK_EVERY);
    document.addEventListener('visibilitychange', look);
    dlg.el.addEventListener('close', () => { clearInterval(looker); document.removeEventListener('visibilitychange', look); });
  }
  dlg.el.addEventListener('close', () => {
    stop();
    if (current && current.refresh === refresh) current = null;
    onClose?.({ who: v.who, sort: v.sort, filter: v.filter, runs: v.runs, game: v.game, session: v.session });
  });

  // New hands join the list while it is open: at a live table as they end, across every game when
  // the club's hands change.
  async function refresh() {
    const x = await fetchAll();
    if (!x.ok || !dlg.el.open) return;
    v.all = x.hands;
    if (club) {
      v.names = x.names || v.names;
      v.version = x.version || v.version;
      sessions.clear();
      for (const s of x.sessions || []) sessions.set(s.id, s);
    }
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
  const want = start == null ? null : String(start);
  const first = want != null && byKey(want) ? want : L[0] ? handKey(L[0]) : null;
  if (first != null && !L.some((h) => handKey(h) === first)) { v.sort = 'new'; v.filter = 'all'; v.game = 'all'; v.runs = 'any'; v.session = 'all'; drawSide(); }
  if (first == null) drawMain();
  else await load(first, want === first ? step : 0);
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
