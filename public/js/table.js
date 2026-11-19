import { api, ensureIdentity } from './api.js';
import { esc, $, $$, toast, clock } from './ui.js';
import { cardHTML, backHTML, slotHTML, prefs, applyPrefs, suitText, shortHandName } from './cards.js';
import { equity } from '/shared/equity.js';
import { sealSVG } from './seal.js';
import { FairClient } from './fair-client.js';
import { bestHand } from '/shared/evaluator.js';
import { GAME_TYPES } from '/shared/cards.js';
import { app, emit, fmt, inp, parse, gameShort, now } from './table-core.js';
import * as D from './table-dialogs.js';
import * as S from './table-stats.js';
import { boardName, stepLabel } from './game-form.js';

import { BRAND_HEX } from './api.js';
const TIMES = ['', 'once', 'twice', 'three times', 'four times'];
const els = {};

applyPrefs();

async function main() {
  for (const id of ['top', 'stage', 'area', 'felt', 'center', 'seats', 'chips', 'mybar', 'actions', 'drawer', 'log', 'chat']) els[id] = document.getElementById(id);
  let me;
  try { me = await ensureIdentity(); }
  catch (e) { fatal(e.message); return; }
  app.me = me.user;
  app.fair = new FairClient(app.tableId, (ev, p) => emit(ev, p, { quiet: true }), onVerified);
  const drawerPref = localStorage.getItem('fd:drawer');
  if (drawerPref === 'closed' || (drawerPref === null && window.innerWidth < 900)) els.drawer.classList.add('collapsed');
  connect();
  new ResizeObserver(resize).observe(els.stage);
  resize();
  setInterval(tick, 200);
  bindEvents();
}

function fatal(msg) {
  document.body.innerHTML = `<div style="display:grid;place-items:center;height:100dvh;padding:24px;text-align:center"><div><h2>${esc(msg)}</h2><p><a href="/">Back to the lobby</a></p></div></div>`;
}

// ---------- realtime ----------
function connect() {
  const socket = window.io({ auth: { token: api.token }, transports: ['websocket', 'polling'], reconnectionDelayMax: 4000 });
  app.socket = socket;
  socket.on('connect', () => {
    setConn(true);
    socket.emit('table:join', { tableId: app.tableId }, (ack) => { if (!ack || !ack.ok) fatal(ack?.error || 'Could not open this table'); });
  });
  socket.on('disconnect', () => setConn(false));
  socket.on('connect_error', (e) => {
    setConn(false);
    if (e.message === 'auth') { api.token = null; location.reload(); }
    if (e.message === 'moved') location.reload();
  });
  socket.on('state', onState);
  socket.on('log:reset', (entries) => { app.logs = entries; renderLog(); });
  socket.on('log', (entries) => {
    app.logs.push(...entries);
    if (app.logs.length > 900) app.logs.splice(0, app.logs.length - 900);
    appendLog(entries);
    bubbles(entries);
  });
  socket.on('toast', (t) => toast(t.text));
  socket.on('request', (r) => {
    chime('request');
    toast(`${r.name} ${r.type === 'seat' ? 'asked for a seat' : 'asked to add chips'} (${r.amount})`);
  });
  socket.on('hands:revealed', ({ through }) => app.fair.onRevealed(through, fetchRecord));
}

// What a seated player says shows for a few seconds in a bubble by their seat.
const BUBBLE_MS = 6000;
function bubbles(entries) {
  let any = false;
  for (const e of entries) {
    if (e.kind !== 'chat' || e.spectator || !e.userId) continue;
    app.bubbles.set(e.userId, { text: e.text, until: Date.now() + BUBBLE_MS, fresh: true });
    any = true;
  }
  if (!any) return;
  if (app.state) renderTable(app.state);
  clearTimeout(app.bubbleTimer);
  app.bubbleTimer = setTimeout(function expire() {
    const t = Date.now();
    for (const [k, b] of app.bubbles) if (b.until <= t) app.bubbles.delete(k);
    if (app.state) renderTable(app.state);
    if (app.bubbles.size) app.bubbleTimer = setTimeout(expire, Math.max(200, Math.min(...[...app.bubbles.values()].map((b) => b.until)) - t));
  }, BUBBLE_MS + 50);
}

export async function fetchRecord(n) {
  const r = await emit('hand:get', { handNumber: n }, { quiet: true });
  return r.record;
}

function setConn(ok) {
  app.connected = ok;
  const dot = document.querySelector('.conn');
  if (dot) { dot.classList.toggle('off', !ok); dot.title = ok ? 'Connected' : 'Reconnecting'; }
}

function onState(s) {
  const first = !app.state;
  app.state = s;
  app.offset = s.serverNow - Date.now();
  app.dec = s.table.decimals;
  app.fair.onState(s);
  const L = s.hand?.legal;
  const turnKey = L ? `${s.hand.number}|${s.hand.street}|${L.currentBet}|${L.toCall}` : null;
  if (turnKey && turnKey !== app.turnKey) chime('turn');
  app.turnKey = turnKey;
  const h = s.hand;
  if (h?.rit?.canChoose && h.rit.myChoice === null && prefs.autoRun !== 'ask' && app.autoRan !== h.number) {
    app.autoRan = h.number;
    emit('rit', { runs: prefs.autoRun === 'once' ? 1 : h.rit.max }, { quiet: true });
  }
  if (first) app.fair.onRevealed(s.table.revealedThrough, fetchRecord);
  render();
  D.onState(s);
}

function onVerified(n, res) {
  if (!prefs.verifyNotes) return;
  const e = {
    id: 'v' + n, at: Date.now(), kind: res.ok ? 'verify' : 'verify badv',
    text: res.ok ? `Hand #${n} checked in your browser: every card matches the sealed deck` : `Hand #${n} did not pass the check in your browser. Open Hands to see which check failed.`,
  };
  app.logs.push(e);
  appendLog([e]);
}

// ---------- layout ----------
// Sizes in units of --u (a hundredth of the table's width, or a 64th when it stands upright): the
// player boxes and how far a fanned hand reaches past the left edge of its box.
const SIZES = {
  land: { box: 21, me: 23, card: 5, myCard: 6.4, reach: 8, myReach: 9.8, perU: 1 },
  port: { box: 20, me: 24, card: 5, myCard: 7.6, reach: 7.4, myReach: 10.6, perU: 100 / 64 },
};
const STEP = { 2: 0.5, 4: 0.34, 5: 0.29 };

// How far a fanned hand of n cards sticks out to the left of its box, in units, the tilt of the
// outside card included.
const TILT = { 2: 3, 4: 7.5, 5: 8.4 };
function overhang(z, n, me) {
  const w = me ? z.myCard : z.card;
  const reach = me ? z.myReach : z.reach;
  const tilt = w * 1.25 * 1.7 * Math.sin(((TILT[n] || 7) * Math.PI) / 180);
  return Math.max(0, w * (1 + (n - 1) * (STEP[n] || 0.4)) - reach + tilt);
}

// Where everything sits, in percent of the table area. Position 0 is the bottom middle (my seat when
// I play) and the rest go round clockwise. The bottom seat gets a little more room for its bigger cards.
// Bets sit on the line from a seat to the middle, just clear of that seat's box and cards and inside the
// felt; the dealer button sits beside the bet.
const ASPECT = { land: 1.72, port: 0.74, portMax: 0.8 };
const FELT = { land: { cx: 50, cy: 48, rx: 35, ry: 32 }, port: { cx: 50, cy: 49, rx: 37, ry: 39 } };
// Angles for seats with these weights around an ellipse with radii a and b, the first one at the
// bottom, going clockwise, each taking a share of the edge in proportion to its weight. The edge
// within band of the middle, up or down, hardly counts, so the seats pass over it.
function spread(weights, a, b, band = 0) {
  const N = 720;
  const cum = new Float64Array(N + 1);
  let px = a, py = 0;
  for (let k = 1; k <= N; k++) {
    const th = (k / N) * 2 * Math.PI;
    const x = a * Math.cos(th), y = b * Math.sin(th);
    cum[k] = cum[k - 1] + Math.hypot(x - px, y - py) * (Math.abs(y + py) / 2 < band ? 0.06 : 1);
    px = x; py = y;
  }
  const total = cum[N];
  const unit = total / weights.reduce((s, w) => s + w, 0);
  const angleAt = (len) => {
    len = ((len % total) + total) % total;
    let lo = 0, hi = N;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] < len) lo = mid; else hi = mid; }
    const f = (len - cum[lo]) / (cum[hi] - cum[lo] || 1);
    return ((lo + f) / N) * 2 * Math.PI;
  };
  const bottom = cum[N / 4];
  let at = bottom - (weights[0] * unit) / 2;
  return weights.map((w) => { const mid = at + (w * unit) / 2; at += w * unit; return angleAt(mid); });
}

function geometry(n, portrait, holeN) {
  const z = portrait ? SIZES.port : SIZES.land;
  const P = portrait
    ? { cx: 50, cy: 48.5, px: 40, py: 42.5, mine: 1.55, boxh: 7.2, myBoxh: 7.6, pill: [8.5, 3.4], aim: 10, dot: 3, board: 8.5 }
    : { cx: 50, cy: 48, px: 42, py: 40, mine: 1.3, boxh: 6.4, myBoxh: 6.8, pill: [10, 3.1], aim: 14, dot: 2.6 };
  const F = portrait ? FELT.port : FELT.land;
  // work in units: x in % of the width divided by ux, y in % of the height divided by uy
  const ux = z.perU;
  const uy = z.perU * (portrait ? app.aspect || ASPECT.port : ASPECT.land);
  // Seats are spaced evenly along the edge of the table measured in box sizes, not by angle: a box is
  // much wider than it is tall, so seats along the top and bottom need more of the edge than seats at
  // the sides. The bottom seat takes a little more again.
  const weights = Array.from({ length: n }, (_, i) => (i === 0 ? P.mine : 1));
  const tall = Math.max(P.boxh, z.card * 1.25 + 0.5);
  // upright, the board is nearly as wide as the table: seats at the sides keep above or below it
  const band = portrait ? (P.board + P.boxh / 2) / tall : 0;
  const angles = spread(weights, P.px / ux / z.box, P.py / uy / tall, band);
  const C = { x: F.cx / ux, y: F.cy / uy };
  // how far from the top or bottom a box has to be for a chat bubble to fit beyond it
  const room = (4.6 + P.boxh / 2) * uy + 0.5;
  const R = { x: (F.rx / ux) * 0.84, y: (F.ry / uy) * 0.84 };
  return weights.map((wt, i) => {
    const t = angles[i];
    const c = Math.cos(t);
    const sn = Math.sin(t);
    const me = i === 0;
    const bw = me ? z.me : z.box;
    const over = overhang(z, holeN, me);
    // keep the box, and the cards fanned to its left, on the table area
    const half = (bw / 2) * ux;
    // (the dealer button sits on the right edge of the box)
    const x = Math.max(half + over * ux + 0.6, Math.min(100 - half - P.dot * ux * 0.6, P.cx + P.px * c));
    const y = P.cy + P.py * sn;
    const S = { x: x / ux, y: y / uy };
    // the box with its cards: wider on the left, and the cards a little taller than the box
    const card = (me ? z.myCard : z.card) * 1.25;
    const box = { l: S.x - bw / 2 - over, r: S.x + bw / 2, t: S.y - Math.max(me ? P.myBoxh : P.boxh, card + 1.2) / 2, b: S.y + Math.max(me ? P.myBoxh : P.boxh, card + 0.4) / 2 };
    // aim above or below the middle, so bets from the sides stay off the board
    const off = S.y < C.y - 0.5 ? -P.aim : S.y > C.y + 0.5 ? P.aim : 0;
    let d = { x: C.x - S.x, y: C.y + off - S.y };
    const len = Math.hypot(d.x, d.y) || 1;
    d = { x: d.x / len, y: d.y / len };
    const exit = Math.min(
      d.x > 1e-6 ? (box.r - S.x) / d.x : d.x < -1e-6 ? (box.l - S.x) / d.x : Infinity,
      d.y > 1e-6 ? (box.b - S.y) / d.y : d.y < -1e-6 ? (box.t - S.y) / d.y : Infinity,
    );
    const along = Math.abs(d.x) * (P.pill[0] / 2) + Math.abs(d.y) * (P.pill[1] / 2);
    let dist = exit + along + 0.6;
    // and far enough in to be on the felt: where the ray enters the inner ellipse
    const ox = (S.x - C.x) / R.x, oy = (S.y - C.y) / R.y, vx = d.x / R.x, vy = d.y / R.y;
    const qa = vx * vx + vy * vy, qb = 2 * (ox * vx + oy * vy), qc = ox * ox + oy * oy - 1;
    const disc = qb * qb - 4 * qa * qc;
    if (qc > 0 && disc > 0) dist = Math.max(dist, (-qb - Math.sqrt(disc)) / (2 * qa));
    dist = Math.min(dist, len * 0.8);
    const B = { x: S.x + d.x * dist, y: S.y + d.y * dist };
    return {
      x, y,
      // close to the left edge a hand's label lines up with the cards instead of centring under them
      edge: S.x - bw / 2 - over < 7,
      bx: B.x * ux, by: B.y * uy,
      upper: sn < -0.25,
      // a chat bubble goes on the outside of the box when there is room for it there
      bubbleIn: sn < -0.25 ? y < room : y > 100 - room,
    };
  });
}

function resize() {
  const w = els.stage.clientWidth;
  const h = els.stage.clientHeight;
  if (!w || !h) return;
  const portrait = w / h < 0.95;
  let aspect = ASPECT.land;
  if (portrait) {
    // Upright, the table takes the height there is with the action buttons showing, worked out from
    // the window so that nothing moves when my turn comes and the buttons appear.
    const room = Math.max(240, window.innerHeight - (els.top.offsetHeight || 46) - 176);
    aspect = Math.max(0.56, Math.min(ASPECT.portMax, (w * 0.985) / (room * 0.97)));
  }
  // a little room above and below for the action tags and what my hand makes
  const W = Math.min(w * 0.985, h * 0.955 * aspect);
  const H = W / aspect;
  els.area.style.width = W + 'px';
  els.area.style.height = H + 'px';
  els.area.classList.toggle('portrait', portrait);
  els.area.style.setProperty('--u', (portrait ? W / 64 : W / 100) + 'px');
  if (app.portrait !== portrait || Math.abs((app.aspect || 0) - aspect) > 0.005) {
    app.portrait = portrait;
    app.aspect = aspect;
    render();
  }
}

// ---------- render ----------
function render() {
  const s = app.state;
  if (!s) return;
  document.documentElement.style.setProperty('--felt', prefs.felt || s.table.settings.feltColor);
  renderTop(s);
  renderTable(s);
  renderBottom(s);
  document.title = `${s.hand?.legal ? 'Your turn | ' : ''}${s.table.name}`;
  document.body.classList.toggle('my-turn', !!(s.hand && (s.hand.legal || (s.hand.rit && s.hand.rit.canChoose && s.hand.rit.myChoice === null))));
}
app.render = render;

function renderTop(s) {
  const t = s.table;
  const st = t.settings;
  const live = s.hand && s.hand.phase !== 'done';
  const first = st.format[0];
  const game = live ? s.hand.gameType : t.rotation ? t.rotation.current : first.game;
  const dbNow = live ? s.hand.doubleBoard : t.rotation ? t.rotation.currentDouble : first.doubleBoard;
  let rot = '';
  if (t.rotation) {
    const r = t.rotation;
    const cur = stepLabel({ game: r.current, doubleBoard: r.currentDouble });
    const next = stepLabel({ game: r.next, doubleBoard: r.nextDouble });
    const more = (k) => `${k} more hand${k === 1 ? '' : 's'}`;
    if (r.unit === 'orbits' && r.count > 1) {
      rot = r.lastOrbit
        ? (r.handsLeft > 0 ? `${cur}, last orbit of ${r.count}: ${more(r.handsLeft)}, then ${next}` : `${next} from the next hand`)
        : `${cur}, orbit ${r.orbit} of ${r.count}, then ${next}`;
    } else rot = r.handsLeft > 0 ? `${cur} for ${more(r.handsLeft)}, then ${next}` : `${next} from the next hand`;
  }
  let bomb = '';
  const bm = st.bombPot.mode;
  if (t.bombNext) bomb = '<span class="pill brass">Bomb pot next hand</span>';
  else {
    if (bm === 'every' || bm === 'both') {
      const left = Math.max(1, st.bombPot.every - t.handsSinceBomb);
      bomb += `<span class="pill soft">Bomb pot ${left === 1 ? 'next hand' : `in ${left} hands`}</span>`;
    }
    if (bm === 'percent' || bm === 'both') bomb += `<span class="pill soft" title="Each hand has this chance of being a bomb pot">${bm === 'both' ? `or ${st.bombPot.percent}% sooner` : `Bomb pots ${st.bombPot.percent}%`}</span>`;
  }
  let status = '';
  if (t.status === 'ended') status = '<span class="pill warn">Game over</span>';
  else if (t.status === 'waiting') status = '<span class="pill soft">Not started</span>';
  else if (t.paused) status = '<span class="pill warn">Paused</span>';
  if (t.endAfterHand) status += '<span class="pill warn">Last hand</span>';
  const ends = t.session && t.session.endsAt;
  const reqs = s.requests ? s.requests.length : 0;
  const f = s.fairness;
  els.top.innerHTML = `
    <span class="conn ${app.connected ? '' : 'off'}" title="${app.connected ? 'Connected' : 'Reconnecting'}"></span>
    <a class="wordmark" href="/" title="Back to the club">${sealSVG(BRAND_HEX, 26, 'The Aquarium')}<span>The <b>Aquarium</b></span></a>
    <div class="tb-title"><strong>${esc(t.name)}</strong><a href="/">${esc(t.clubName || 'The Aquarium')}</a></div>
    <div class="tb-game">
      <span class="pill brass" title="${esc(GAME_TYPES[game]?.name || '')}">${esc(gameShort(game))}</span>${dbNow ? '<span class="pill soft" title="Two boards, each pot split between them">Double board</span>' : ''}
      <span class="pill num">${fmt(st.smallBlind)}/${fmt(st.bigBlind)}</span>
      ${rot ? `<span class="tb-note">${esc(rot)}</span>` : ''}
      ${bomb}${status}
    </div>
    ${ends && t.status === 'running' ? `<div class="tb-clock" data-ends="${ends}" title="Time left in this game"><b>--:--</b><small>left</small></div>` : ''}
    ${t.session && t.session.clockAtFirstHand && st.sessionMinutes ? `<span class="pill soft tb-wait" title="The time limit starts with the first hand">${st.sessionMinutes} min game, clock starts with the first hand</span>` : ''}
    <div class="tb-actions">
      <button class="seal-btn" data-open="fair" title="Deck seal for the next hand">${sealSVG(f.commitment, 30)}<span class="txt"><b>Hand #${f.handNumber} sealed</b>${f.contributions} player input${f.contributions === 1 ? '' : 's'}</span></button>
      ${reqs ? `<button class="btn primary small" data-open="requests">Requests <span class="count">${reqs}</span></button>` : ''}
      ${s.me.isHost ? '<button class="btn small sm-hide" data-open="options">Options</button>' : ''}
      <button class="btn small sm-hide" data-open="ledger">Ledger</button>
      <button class="btn small sm-hide" data-open="stats">Stats</button>
      <button class="btn small sm-hide md-hide" data-open="hands">Hands</button>
      <button class="btn small sm-hide md-hide" data-open="look">Look</button>
      <button class="btn small sm-hide ${els.drawer.classList.contains('collapsed') ? '' : 'primary'}" data-open="log">Log</button>
      <button class="btn small menu-btn" data-open="menu">Menu</button>
    </div>`;
  tick();
}

function resultInfo(h) {
  const info = { won: new Map(), handCards: new Map(), boardUsed: [] };
  if (!h || h.phase !== 'done' || !h.results) return info;
  for (const p of h.results.payouts) info.won.set(p.seat, (info.won.get(p.seat) || 0) + p.amount);
  if (!h.results.uncontested) {
    h.results.pots.forEach((pot, pi) => pot.runs.forEach((r) => {
      const used = (info.boardUsed[r.b ?? r.run] ||= new Set());
      for (const w of r.winners) {
        if (!w.cards) continue;
        if (pi === 0) w.cards.forEach((c) => used.add(c));
        const hc = info.handCards.get(w.seat) || new Set();
        w.cards.forEach((c) => hc.add(c));
        info.handCards.set(w.seat, hc);
      }
    }));
  }
  return info;
}

function dealCls(key) {
  if (app.seen.has(key)) return '';
  app.seen.add(key);
  return 'deal';
}

// The run being dealt: the first whose boards are not all complete, or the last one.
function currentRun(h) {
  const boards = h.boards || [h.board];
  const bpr = h.boardsPerRun || 1;
  const runs = Math.max(1, Math.round(boards.length / bpr));
  let r = 0;
  while (r < runs - 1 && boards.slice(r * bpr, r * bpr + bpr).every((b) => b.length >= 5)) r++;
  return { r, boards: boards.slice(r * bpr, r * bpr + bpr), others: boards.filter((_, i) => i < r * bpr || i >= r * bpr + bpr) };
}

// Everyone left is all in with their cards face up and cards still to come: each one's chance of
// winning this run, worked out here from the cards on the table (folded cards count as unknown).
function allInChances(h) {
  if (!h || h.phase === 'done' || (h.actorSeat !== null && h.actorSeat !== undefined)) return null;
  const live = h.players.filter((p) => !p.folded);
  if (live.length < 2 || !live.every((p) => p.hole && p.hole.length && p.hole.every(Boolean))) return null;
  const cur = currentRun(h);
  if (cur.boards.every((b) => b.length >= 5)) return null;
  const seen = [...cur.others.flat(), ...h.players.filter((p) => p.folded && p.hole).flatMap((p) => p.hole.filter(Boolean))];
  try { return equity(live.map((p) => ({ seat: p.seat, hole: p.hole })), cur.boards, GAME_TYPES[h.gameType].omaha, seen); }
  catch { return null; }
}

// What a hand makes on the run being dealt, one name per board: "Two pair (5,4) / Flush".
function madeHand(h, hole) {
  if (!hole || !hole.length || !hole.every(Boolean)) return '';
  const { boards } = currentRun(h);
  if (!boards[0] || boards[0].length < 3) return '';
  const made = boards.map((b) => bestHand(hole, b, GAME_TYPES[h.gameType].omaha)).filter(Boolean);
  if (made.length < 2) return made.length ? shortHandName(made[0].score) : '';
  return made.map((r) => shortHandName(r.score, true)).join(' / ');
}

const FOLD_MARK = '<span class="foldmark" aria-label="Folded"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 5.5l13 13M18.5 5.5l-13 13"/></svg><span>Fold</span></span>';

function renderTable(s) {
  const t = s.table;
  const n = t.settings.maxPlayers;
  const h = s.hand;
  if (h && app.seenHand !== h.number) { app.seenHand = h.number; app.seen = new Set(); }
  const nextGame = t.rotation ? t.rotation.current : t.settings.format[0].game;
  const holeN = GAME_TYPES[h ? h.gameType : nextGame]?.holeCount || 2;
  const geo = geometry(n, app.portrait, holeN);
  const rot = s.me.seat ?? 0;
  const hp = new Map((h?.players || []).map((p) => [p.seat, p]));
  const R = resultInfo(h);
  const chances = allInChances(h);
  const best = chances ? Math.max(...chances.values()) : 0;
  const myReq = s.me.requests.find((r) => r.type === 'seat');
  const pendingSeats = new Set((s.requests || []).filter((r) => r.type === 'seat').map((r) => r.seat));
  const nowMs = Date.now();
  let seats = '';
  let chips = '';
  for (let seat = 0; seat < n; seat++) {
    const g = geo[(seat - rot + n) % n];
    const pos = `left:${g.x.toFixed(2)}%;top:${g.y.toFixed(2)}%`;
    const info = s.seats[seat];
    const side = g.upper ? 'upper' : 'lower';
    if (!info) {
      const mine = myReq && myReq.seat === seat;
      const canSit = !s.me.seated && !myReq && t.status !== 'ended';
      let inner = canSit ? `<button class="sit" data-sit="${seat}">Sit here</button>` : '';
      if (mine) inner = '<span>Waiting for the host</span>';
      else if (pendingSeats.has(seat)) inner = '<span>Requested</span>';
      seats += `<div class="seat empty ${side} ${mine ? 'reserved' : ''} ${inner ? '' : 'quiet'}" style="${pos}"><div class="plate" ${inner ? '' : `title="Seat ${seat + 1} is free"`}>${inner}</div></div>`;
      continue;
    }
    const p = hp.get(seat);
    const isMe = info.userId === s.me.userId;
    const actor = h && h.phase === 'betting' && h.actorSeat === seat;
    const won = R.won.get(seat);
    const live = h && h.phase !== 'done';
    const cls = ['seat', side, g.edge && 'edge', isMe && 'me', actor && 'actor', p && p.folded && 'folded', !p && (info.sittingOut || info.stack === 0) && 'out', won && 'winner'].filter(Boolean).join(' ');

    // the cards, fanned to the left of the box
    let fan = '';
    let extra = '';
    if (p) {
      const count = p.holeCount || (p.hole ? p.hole.length : 0);
      const faces = p.hole && (!p.folded || isMe || p.shown || p.hole.some(Boolean));
      let cards = '';
      if (faces) {
        const hc = R.handCards.get(seat);
        cards = p.hole.map((c, i) => (c
          ? cardHTML(c, `${hc ? (hc.has(c) ? 'win' : 'dim') : ''} ${dealCls(`h${seat}${i}${c}`)}`, `--i:${i}`)
          : backHTML('', `--i:${i}`))).join('');
      } else if (!p.folded) {
        cards = Array.from({ length: count }, (_, i) => backHTML(dealCls(`b${seat}${i}`), `--i:${i}`)).join('');
      }
      if (cards) fan = `<div class="fan n${count}">${cards}</div>`;
      else if (p.folded) fan = FOLD_MARK;
      const ch = chances && chances.get(seat);
      if (ch !== undefined && ch !== null) {
        const shown = Math.round(ch);
        extra += `<span class="eq ${ch >= best - 0.01 ? 'up' : 'down'} n${count}" title="Chance of winning this run, from the cards on the table">${shown === 0 && ch > 0 ? '<1' : shown === 100 && ch < 100 ? '>99' : shown}%</span>`;
      }
      const seeAll = p.hole && p.hole.length && p.hole.every(Boolean);
      if (seeAll && (!p.folded || p.shown) && (isMe ? prefs.handStrength || !live : true) && (isMe || !live || chances || p.shown)) {
        const name = madeHand(h, p.hole);
        if (name) extra += `<span class="made n${count}">${esc(name)}</span>`;
      }
    }

    let tag = '';
    let tagCls = '';
    if (won) { tag = '+' + fmt(won); tagCls = 'win'; }
    else if (p && live && p.lastAction && !p.allIn && !(p.folded && !isMe)) { tag = p.lastAction; tagCls = p.lastAction.toLowerCase().replace(/[^a-z]/g, ''); }
    else if (info.leaving) { tag = 'Leaving'; tagCls = 'out'; }
    else if (!p && info.sittingOut) { tag = info.away ? 'Away' : 'Sitting out'; tagCls = 'out'; }
    else if (!p && info.stack === 0) { tag = 'Out of chips'; tagCls = 'out'; }
    else if (info.sitOutNext) { tag = 'Sitting out next'; tagCls = 'out'; }
    let timer = '';
    if (actor && h.turn) {
      timer = `<div class="timer ${h.turn.usingBank ? 'bank' : ''}"><i data-deadline="${h.turn.deadline}" data-total="${h.turn.total || 30000}"></i></div>`;
    }
    const stack = p ? p.stack : info.stack;
    const allIn = p && p.allIn && !p.folded && live;
    const bub = app.bubbles.get(info.userId);
    // the bubble pops in once; later redraws of the table leave it still
    const bubble = bub && bub.until > nowMs ? `<div class="bubble ${g.bubbleIn ? 'in' : 'out'}${bub.fresh ? ' fresh' : ''}" role="status"><span>${esc(bub.text)}</span></div>` : '';
    if (bub) bub.fresh = false;
    seats += `<div class="${cls}${bubble ? ' talking' : ''}" style="${pos}" ${s.me.isHost && !isMe ? `data-player="${esc(info.userId)}" title="Host actions for ${esc(info.name)}"` : ''}>
      <div class="plate">
        ${fan}${extra}
        <div class="who">
          <div class="nm">${info.connected ? '' : '<span class="dot" title="Disconnected"></span>'}<span>${esc(info.name)}</span>${info.isHost ? '<span class="host-mark" title="Host">&#9733;</span>' : ''}</div>
          <div class="st">${allIn ? 'All In' : fmt(stack)}${info.pendingChips ? ` <small>+${fmt(info.pendingChips)}</small>` : ''}</div>
          ${S.hudHTML(s, info.userId)}
        </div>
        ${timer}
        ${h && h.buttonSeat === seat ? '<span class="dbtn" title="Dealer" aria-label="Dealer button">D</span>' : ''}
        ${tag ? `<div class="tag ${tagCls}">${esc(tag)}</div>` : ''}
      </div>
      ${bubble}
    </div>`;
    if (p && p.bet > 0) chips += `<div class="bet" style="left:${g.bx.toFixed(2)}%;top:${g.by.toFixed(2)}%">${fmt(p.bet)}</div>`;
  }
  els.seats.innerHTML = seats;
  els.chips.innerHTML = chips;
  els.center.innerHTML = centerHTML(s, R);
  fitMark();
}

// The Aquarium on the felt steps aside when boards or results reach down over it.
function fitMark() {
  const mark = els.felt.querySelector('.felt-mark');
  if (!mark) return;
  const c = els.center.firstElementChild ? els.center.getBoundingClientRect() : null;
  const m = mark.getBoundingClientRect();
  mark.classList.toggle('hide', !!c && c.bottom > m.top + 2 && c.top < m.bottom);
}

function centerHTML(s, R) {
  const h = s.hand;
  const t = s.table;
  if (!h) return waitingHTML(s);
  const boards = h.boards || [h.board];
  const bpr = h.boardsPerRun || 1;
  const runs = Math.max(1, Math.round(boards.length / bpr));
  // A double board with one run is stacked, board 1 above board 2, so the cards stay big.
  const stacked = bpr > 1 && runs === 1;
  let grid = '';
  if (bpr > 1 && !stacked) grid += `${runs > 1 ? '<span></span>' : ''}${Array.from({ length: bpr }, (_, i) => `<span class="bhead">Board ${i + 1}</span>`).join('')}`;
  for (let r = 0; r < runs; r++) {
    if (runs > 1) grid += `<span class="run">Run ${r + 1}</span>`;
    for (let side = 0; side < bpr; side++) {
      const i = r * bpr + side;
      if (stacked) grid += `<span class="run">Board ${side + 1}</span>`;
      const b = boards[i] || [];
      const used = R.boardUsed[i];
      let slots = '';
      for (let j = 0; j < 5; j++) {
        const c = b[j];
        if (!c) { slots += slotHTML(); continue; }
        const cls = [dealCls(`r${i}${j}${c}`), r > 0 && j < (h.sharedCount ?? 0) ? 'shared' : '', used ? (used.has(c) ? 'win' : 'dim') : ''].join(' ');
        slots += cardHTML(c, cls);
      }
      grid += `<div class="board" aria-label="${esc(boardName(i, bpr, boards.length) || 'Board')}">${slots}</div>`;
    }
  }
  const cols = stacked ? 'auto auto' : `${runs > 1 ? 'auto ' : ''}repeat(${bpr}, auto)`;
  let below = '';
  let above = '';
  if (h.phase === 'done' && h.results) {
    below = `<div class="results">${resultLines(h).map((l) => `<div>${l}</div>`).join('')}</div><button type="button" class="replay-btn" data-replay="${h.number}">Replay hand #${h.number}</button>`;
    if (t.waiting && t.waiting !== 'Waiting for players') below += `<div class="waiting"><small>${esc(t.waiting)}</small></div>`;
  } else {
    // the pot in the middle, and above it everything in, bets in front of the players included
    const out = h.potTotal - (h.pot ?? h.potTotal);
    above = h.pot > 0
      ? `<div class="pot">${out > 0 ? `<span class="total"><i>total</i> ${fmt(h.potTotal)}</span>` : ''}<b>${fmt(h.pot)}</b></div>`
      : `<div class="pot"><b><i>total</i> ${fmt(h.potTotal)}</b></div>`;
    if (h.phase === 'rit') {
      const voted = h.rit ? h.rit.chosenSeats.length : 0;
      const of = h.rit ? h.rit.eligibleSeats.length : 0;
      below += `<div class="rit-note">All in. Voting on how many times to run it: ${voted} of ${of} voted, <span data-ritclock></span></div>`;
    } else if (h.rit && h.rit.result > 1) below += `<div class="rit-note">Running it ${TIMES[h.rit.result]}</div>`;
  }
  const bombWhy = h.bombReason === 'manual' ? 'called by the host' : h.bombReason === 'every' ? 'scheduled' : h.bombReason === 'percent' ? 'random' : '';
  const bomb = h.isBomb ? `<span class="bomb" title="${esc(bombWhy)}">Bomb pot</span>` : '';
  return `${above}<div class="boards k${Math.min(runs, 4)} b${bpr}${stacked ? ' stacked' : ''}" style="grid-template-columns:${cols}">${grid}</div>${below}
    <div class="meta">${bomb}<span>${esc(gameShort(h.gameType))} hand ${h.number}</span></div>`;
}

function resultLines(h) {
  const r = h.results;
  if (r.uncontested) {
    const w = r.payouts[0];
    return [`<b>${esc(w.name)}</b> wins ${fmt(w.amount)}`];
  }
  const nb = r.boards.length;
  const bpr = h.boardsPerRun || 1;
  // each board: every winner's total on it and the hand that won
  const per = Array.from({ length: nb }, () => new Map());
  const alone = new Map();
  r.pots.forEach((pot) => pot.runs.forEach((run) => {
    for (const w of run.winners) {
      if (pot.uncontested) { alone.set(w.name, (alone.get(w.name) || 0) + w.amount); continue; }
      const m = per[run.b ?? run.run];
      const cur = m.get(w.seat) || { name: w.name, amount: 0, hand: w.hand };
      cur.amount += w.amount;
      m.set(w.seat, cur);
    }
  }));
  const lines = [];
  if (nb > 2) {
    // three or more boards: one line per winner, so the felt stays readable (the log has every board)
    const tot = new Map();
    per.forEach((m) => m.forEach((x, seat) => {
      const t = tot.get(seat) || { name: x.name, amount: 0, boards: 0 };
      t.amount += x.amount;
      t.boards++;
      tot.set(seat, t);
    }));
    const list = [...tot.values()].sort((a, b) => b.amount - a.amount);
    if (list.length === 1) {
      const x = list[0];
      lines.push(`<b>${esc(x.name)}</b> wins ${fmt(x.amount)} ${x.boards === nb ? `on all ${nb} boards` : `on ${x.boards} of ${nb} boards`}`);
    } else if (list.length) {
      const parts = list.map((x) => `<b>${esc(x.name)}</b> ${fmt(x.amount)}`);
      lines.push(`${parts.slice(0, -1).join(', ')} and ${parts.at(-1)} over ${nb} boards`);
    }
  } else {
    per.forEach((m, i) => {
      const parts = [...m.values()].sort((a, b) => b.amount - a.amount).map((x) => `<b>${esc(x.name)}</b> ${fmt(x.amount)} with ${esc(x.hand)}`);
      if (!parts.length) return;
      const label = boardName(i, bpr, nb);
      if (label) lines.push(`${label}: ${parts.join(', ')}`);
      else if (parts.length === 1) lines.push(parts[0].replace('</b> ', '</b> wins '));
      else lines.push(parts.join(', '));
    });
  }
  for (const [name, amount] of alone) lines.push(`<b>${esc(name)}</b> takes ${fmt(amount)} from a side pot nobody else was left in`);
  return lines.slice(0, 5);
}

function waitingHTML(s) {
  const t = s.table;
  let btn = '';
  if (t.status === 'waiting' && s.me.isHost) btn = '<button class="btn primary" data-host="start">Start the game</button>';
  else if (t.status === 'running' && t.paused && s.me.isHost) btn = '<button class="btn primary" data-host="resume">Resume the game</button>';
  let extra = '';
  if (t.status === 'waiting' && s.me.isHost) extra = '<small class="muted">Share this page’s link so your players can request seats.</small>';
  return `<div class="waiting">${t.waiting ? `<span>${esc(t.waiting)}</span>` : ''}${btn}${extra}</div>`;
}

function renderBottom(s) {
  let my = '';
  if (s.me.seated) {
    const out = s.me.sittingOut || s.me.sitOutNext;
    my += out
      ? `<button class="btn ${s.me.sittingOut ? 'primary' : ''}" data-my="back">I’m back</button>`
      : '<button class="btn" data-my="sitout">Sit out next hand</button>';
    if (s.table.status !== 'ended') my += '<button class="btn" data-my="chips">Add chips</button>';
    if (!s.me.leaving) my += '<button class="btn ghost" data-my="stand">Stand up</button>';
    if (s.hand && s.hand.canShow) {
      const mine = s.hand.players.find((p) => p.id === s.me.userId);
      const left = (mine?.hole || []).map((c, i) => [c, i]).filter(([, i]) => !(mine.showIdx || []).includes(i));
      my += `<span class="show-pick" role="group" aria-label="Show your cards"><span class="sp-lbl">Show</span>${left.map(([c, i]) => `<button type="button" class="sp-card" data-show="${i}" title="Show this card">${cardHTML(c)}</button>`).join('')}<button type="button" class="btn small" data-show="all">${left.length === (mine?.hole || []).length ? 'All' : 'The rest'}</button></span>`;
    }
    if (s.me.requests.some((r) => r.type === 'chips')) my += '<span class="status-line">Chip request sent to the host</span>';
  } else if (s.me.requests.length) {
    my += '<span class="status-line">Waiting for the host to approve your seat</span><button class="btn ghost small" data-my="cancel">Cancel request</button>';
  } else if (s.table.status !== 'ended') {
    my += '<span class="status-line">You are watching. Pick an empty seat to play.</span>';
  }
  els.mybar.innerHTML = my;
  renderActions(s);
}

function presetList(L) {
  const full = L.potTotal + (L.currentBet - L.myBet);
  const clampTo = (x) => Math.max(L.minTo, Math.min(L.maxTo, Math.round(x)));
  const list = [{ label: 'Min', to: L.minTo }];
  for (const [f, label] of [[0.5, '½ pot'], [0.75, '¾ pot'], [1, 'Pot']]) list.push({ label, to: clampTo(L.currentBet + f * full) });
  if (L.limit === 'nl') list.push({ label: 'All-in', to: L.maxTo });
  return list;
}

function renderActions(s) {
  const h = s.hand;
  const L = h && h.legal;
  if (L) {
    const key = `${h.number}|${h.street}|${L.currentBet}|${L.toCall}|${L.minTo}|${L.maxTo}|${L.canRaise}`;
    if (key === app.actionKey) return;
    app.actionKey = key;
    const call = L.canCheck ? '<span>Check</span>' : `<span>${L.toCall >= L.stack ? 'Call all-in' : 'Call'}</span><span class="amt">${fmt(L.toCall)}</span>`;
    let sizing = '';
    if (L.canRaise && L.minTo < L.maxTo) {
      sizing = `<div class="sizing">
        <div class="presets">${presetList(L).map((p) => `<button type="button" data-to="${p.to}">${p.label}</button>`).join('')}</div>
        <input type="range" min="${L.minTo}" max="${L.maxTo}" step="1" value="${L.minTo}" data-range aria-label="Raise amount">
        <input type="number" inputmode="decimal" step="${app.dec ? '0.01' : '1'}" value="${inp(L.minTo)}" data-amount aria-label="Raise to amount">
      </div>`;
    }
    els.actions.innerHTML = `${sizing}<div class="act-row">
      <span class="act-clock" data-actclock></span>
      <button class="act fold" data-act="fold"><span>Fold</span><kbd>F</kbd></button>
      <button class="act call" data-act="${L.canCheck ? 'check' : 'call'}">${call}<kbd>${L.canCheck ? 'K' : 'C'}</kbd></button>
      ${L.canRaise ? `<button class="act raise" data-act="raise"><span data-raise-label>${raiseLabel(L, L.minTo)}</span><span class="amt" data-raise-amt>${fmt(L.minTo)}</span><kbd>R</kbd></button>` : ''}
    </div>`;
    app.raiseTo = L.minTo;
    tick();
    return;
  }
  app.actionKey = null;
  if (h && h.rit && h.rit.canChoose && h.rit.myChoice === null) {
    els.actions.innerHTML = `<div class="rit-box" role="group" aria-label="Vote on how many times to run it"><p>Run it how many times?<small>Any vote for once wins, otherwise the lowest vote. <span data-ritclock></span></small></p>
      ${Array.from({ length: h.rit.max }, (_, i) => `<button class="act ${i === 0 ? 'call' : 'raise'}" data-run="${i + 1}"><span>${TIMES[i + 1][0].toUpperCase() + TIMES[i + 1].slice(1)}</span></button>`).join('')}</div>`;
    tick();
    return;
  }
  let status = '';
  if (h && h.phase !== 'done') {
    if (h.phase === 'rit') {
      const left = h.rit ? h.rit.eligibleSeats.length - h.rit.chosenSeats.length : 0;
      status = h.rit && h.rit.myChoice
        ? `You voted ${TIMES[h.rit.myChoice]}. Waiting for ${left} more vote${left === 1 ? '' : 's'}, <span data-ritclock></span>`
        : 'The players in the hand are voting on how many times to run it';
    } else if (h.actorSeat !== null && h.actorSeat !== undefined) {
      const a = s.seats[h.actorSeat];
      if (a && a.userId !== s.me.userId) status = `Waiting for ${esc(a.name)}`;
    }
  }
  els.actions.innerHTML = status ? `<div class="status-line">${status}</div>` : '';
  if (status) tick();
}

function raiseLabel(L, to) {
  if (to >= L.allInTo) return 'All-in';
  return L.isBet ? 'Bet' : 'Raise to';
}

function setRaise(to, from) {
  const L = app.state?.hand?.legal;
  if (!L) return;
  if (!Number.isFinite(to)) return;
  to = Math.max(L.minTo, Math.min(L.maxTo, Math.round(to)));
  app.raiseTo = to;
  const range = $('[data-range]', els.actions);
  const amount = $('[data-amount]', els.actions);
  if (range && from !== 'range') range.value = to;
  if (amount && from !== 'amount') amount.value = inp(to);
  const lbl = $('[data-raise-label]', els.actions);
  const amt = $('[data-raise-amt]', els.actions);
  if (lbl) lbl.textContent = raiseLabel(L, to);
  if (amt) amt.textContent = fmt(to);
}

async function act(type) {
  const L = app.state?.hand?.legal;
  if (!L) return;
  const buttons = $$('.act', els.actions);
  buttons.forEach((b) => { b.disabled = true; });
  let payload = { type };
  if (type === 'raise') {
    const amount = $('[data-amount]', els.actions);
    let to = app.raiseTo ?? L.minTo;
    if (amount) { const v = parse(amount.value); if (Number.isFinite(v)) to = v; }
    payload = { type: 'raise', to: Math.max(L.minTo, Math.min(L.maxTo, to)) };
  }
  const ack = await emit('action', payload);
  if (!ack.ok) { buttons.forEach((b) => { b.disabled = false; }); app.actionKey = null; render(); }
}

// ---------- clock ----------
function tick() {
  const t = now();
  for (const el of document.querySelectorAll('[data-deadline]')) {
    const left = Number(el.dataset.deadline) - t;
    const total = Number(el.dataset.total) || 1;
    el.style.transform = `scaleX(${Math.max(0, Math.min(1, left / total)).toFixed(3)})`;
  }
  const h = app.state && app.state.hand;
  const ac = document.querySelector('[data-actclock]');
  if (ac && h && h.turn) {
    const left = h.turn.deadline - t;
    ac.textContent = `${h.turn.usingBank ? 'Bank ' : ''}${Math.max(0, Math.ceil(left / 1000))}s`;
    ac.classList.toggle('low', left < 8000);
  }
  for (const rc of document.querySelectorAll('[data-ritclock]')) {
    if (h && h.ritDeadline) rc.textContent = `${Math.max(0, Math.ceil((h.ritDeadline - t) / 1000))}s left`;
  }
  const clk = document.querySelector('[data-ends]');
  if (clk) {
    const left = Number(clk.dataset.ends) - t;
    const b = clk.querySelector('b');
    if (b) b.textContent = left > 0 ? clock(left) : '0:00';
    clk.classList.toggle('low', left < 10 * 60000);
  }
}

// ---------- log & chat ----------
function entryHTML(e) {
  if (e.kind === 'hand-end') return '';
  if (e.kind === 'chat') return `<div class="e k-chat ${e.spectator ? 'spec' : ''}"><b>${esc(e.name)}</b> ${esc(e.text)}</div>`;
  let text = e.text;
  const m = /^-- starting hand #(\d+) \((.+?)\) \(dealer: (.+)\) --$/.exec(text);
  if (m) text = `Hand #${m[1]}, ${m[2].replace('BOMB POT, ', 'bomb pot, ').replace('DOUBLE BOARD, ', 'double board, ')}, dealer ${m[3]}`;
  const kinds = String(e.kind).split(' ').map((k) => 'k-' + k.replace(/[^a-z-]/g, '')).join(' ');
  return `<div class="e ${kinds}">${suitText(esc(text))}</div>`;
}

function logFilter(e) { return app.logOnlyChat ? e.kind === 'chat' : true; }

function renderLog() {
  els.log.innerHTML = app.logs.filter(logFilter).map(entryHTML).join('');
  els.log.scrollTop = els.log.scrollHeight;
}

function appendLog(entries) {
  const nearBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 80;
  els.log.insertAdjacentHTML('beforeend', entries.filter(logFilter).map(entryHTML).join(''));
  while (els.log.childElementCount > 900) els.log.firstElementChild.remove();
  if (nearBottom) els.log.scrollTop = els.log.scrollHeight;
}

// ---------- sound ----------
let audio;
function chime(kind) {
  if (!prefs.sound) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const notes = kind === 'turn' ? [660, 990] : [523, 659];
    notes.forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      const t0 = audio.currentTime + i * 0.11;
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      o.connect(g).connect(audio.destination);
      o.start(t0);
      o.stop(t0 + 0.22);
    });
  } catch { /* audio unavailable */ }
}

// ---------- events ----------
function bindEvents() {
  document.addEventListener('click', async (e) => {
    const sit = e.target.closest('[data-sit]');
    if (sit) return D.seatDialog(Number(sit.dataset.sit));
    const my = e.target.closest('[data-my]');
    if (my) {
      const k = my.dataset.my;
      if (k === 'sitout') emit('sitout', { value: true });
      else if (k === 'back') emit('sitout', { value: false });
      else if (k === 'chips') D.chipsDialog();
      else if (k === 'stand') D.standDialog();
      else if (k === 'show') emit('show', {});
      else if (k === 'cancel') emit('seat:cancel');
      return;
    }
    const host = e.target.closest('[data-host]');
    if (host) {
      if (host.dataset.host === 'start') emit('host:start');
      if (host.dataset.host === 'resume') emit('host:pause', { value: false });
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) {
      const k = open.dataset.open;
      if (k === 'log') {
        els.drawer.classList.toggle('collapsed');
        localStorage.setItem('fd:drawer', els.drawer.classList.contains('collapsed') ? 'closed' : 'open');
        resize();
        render();
        return;
      }
      ({ options: D.hostDialog, ledger: D.ledgerDialog, stats: S.statsDialog, hands: D.handsDialog, look: D.lookDialog, fair: D.fairDialog, requests: D.requestsDialog, menu: D.menuDialog })[k]?.();
      return;
    }
    if (e.target.closest('dialog')) return; // dialogs handle their own buttons
    const rp = e.target.closest('[data-replay]');
    if (rp) return S.replayDialog(Number(rp.dataset.replay), { onDetails: (n) => D.handDetailDialog(n) });
    const hud = e.target.closest('[data-stats]');
    if (hud) return S.playerSheet(hud.dataset.stats);
    const player = e.target.closest('[data-player]');
    if (player) return D.playerDialog(player.dataset.player);
    const a = e.target.closest('[data-act]');
    if (a && els.actions.contains(a)) return act(a.dataset.act);
    const pr = e.target.closest('[data-to]');
    if (pr && els.actions.contains(pr)) return setRaise(Number(pr.dataset.to));
    const sh = e.target.closest('[data-show]');
    if (sh && els.mybar.contains(sh)) {
      sh.disabled = true;
      return emit('show', sh.dataset.show === 'all' ? {} : { cards: [Number(sh.dataset.show)] });
    }
    const run = e.target.closest('[data-run]');
    if (run) {
      $$('[data-run]').forEach((b) => { b.disabled = true; });
      return emit('rit', { runs: Number(run.dataset.run) });
    }
    const lf = e.target.closest('[data-logfilter]');
    if (lf) {
      app.logOnlyChat = lf.dataset.logfilter === 'chat';
      $$('[data-logfilter]').forEach((b) => b.classList.toggle('on', b === lf));
      renderLog();
    }
  });
  els.actions.addEventListener('input', (e) => {
    if (e.target.matches('[data-range]')) setRaise(Number(e.target.value), 'range');
    if (e.target.matches('[data-amount]')) {
      const v = parse(e.target.value);
      const L = app.state?.hand?.legal;
      if (Number.isFinite(v) && L) {
        app.raiseTo = Math.max(L.minTo, Math.min(L.maxTo, v));
        const range = $('[data-range]', els.actions);
        if (range) range.value = app.raiseTo;
        const lbl = $('[data-raise-label]', els.actions);
        const amt = $('[data-raise-amt]', els.actions);
        if (lbl) lbl.textContent = raiseLabel(L, app.raiseTo);
        if (amt) amt.textContent = fmt(app.raiseTo);
      }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    const L = app.state?.hand?.legal;
    const inAmount = e.target.matches && e.target.matches('[data-amount]');
    if (inAmount) {
      if (e.key === 'Enter') { e.preventDefault(); act('raise'); }
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && L) {
        e.preventDefault();
        setRaise((app.raiseTo ?? L.minTo) + (e.key === 'ArrowUp' ? 1 : -1) * L.bigBlind);
      }
      return;
    }
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    if (!L || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'f') act('fold');
    else if (k === 'c' || k === 'k') act(L.canCheck ? 'check' : 'call');
    else if (k === 'r' && L.canRaise) {
      const amount = $('[data-amount]', els.actions);
      if (amount) { amount.focus(); amount.select(); } else act('raise');
    }
  });
  els.chat.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = els.chat.querySelector('input');
    const text = input.value.trim();
    if (!text) return;
    const ack = await emit('chat', { text });
    if (ack.ok) input.value = '';
  });
}

main();
