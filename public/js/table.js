import { api, ensureIdentity } from './api.js';
import { esc, $, $$, toast, clock } from './ui.js';
import { cardHTML, backHTML, slotHTML, prefs, savePrefs, applyPrefs, suitText, shortHandName, rankLabel, SUIT } from './cards.js';
import { equity } from '/shared/equity.js';
import { playSound, unlockSound } from './sounds.js';
import { sealSVG } from './seal.js';
import { FairClient } from './fair-client.js';
import { bestHand, score5 } from '/shared/evaluator.js';
import { GAME_TYPES } from '/shared/cards.js';
import { app, emit, fmt, inp, parse, gameShort, now } from './table-core.js';
import * as D from './table-dialogs.js';
import * as S from './table-stats.js';
import * as H from './hand-history.js';
import * as VC from './voice.js';
import { boardName, stepLabel } from './game-form.js';

import { wordmarkHTML } from './brand.js';
const TIMES = ['', 'once', 'twice', 'three times', 'four times'];
const els = {};

applyPrefs();

async function main() {
  for (const id of ['top', 'stage', 'area', 'felt', 'center', 'seats', 'chips', 'mybar', 'actions', 'drawer', 'log', 'chat', 'chatfab', 'pnchat', 'pnbox', 'pnmsgs', 'pnform', 'pninput', 'pnmore', 'pnvoice', 'pnname']) els[id] = document.getElementById(id);
  let me;
  try { me = await ensureIdentity(); }
  catch (e) { fatal(e.message); return; }
  app.me = me.user;
  app.fair = new FairClient(app.tableId, (ev, p) => emit(ev, p, { quiet: true }), onVerified);
  // Where the chat goes: on a wide screen bottom left, as on PokerNow, with the log in a panel opened by
  // Log / Ledger; narrower, in the side panel; on a phone from the chat button.
  app.unread = 0;
  chatMode();
  WIDE_CHAT.addEventListener('change', () => { chatMode(); resize(); render(); });
  bindPnChat();
  keepAboveKeyboard();
  // browsers only allow sound after a tap or key press on the page
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) document.addEventListener(ev, unlockSound, { capture: true, passive: true });
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
  VC.bindVoice(socket, () => { if (app.state) renderBottom(app.state); VC.paintVoice(); });
  window.aquariumVoice = { peers: VC.voicePeers, stats: VC.voiceStats, state: VC.voice }; // for checking calls from the console
  socket.on('connect', () => {
    setConn(true);
    if (app.fair) app.fair.reconnected();
    VC.voiceReconnected();
    socket.emit('table:join', { tableId: app.tableId }, (ack) => { if (!ack || !ack.ok) fatal(ack?.error || 'Could not open this table'); });
  });
  socket.on('disconnect', (reason) => {
    setConn(false);
    // closed by the server (signed out, removed from the club, the site moved): the library does not
    // come back on its own after that, so ask again; the answer says what happened (connect_error)
    if (reason === 'io server disconnect') setTimeout(() => socket.connect(), 500);
  });
  socket.on('table:removed', (p) => { socket.close(); fatal(p?.reason || 'This game was removed.'); });
  socket.on('connect_error', (e) => {
    setConn(false);
    if (e.message === 'auth') { api.token = null; location.reload(); }
    if (e.message === 'moved') location.reload();
  });
  socket.on('state', onState);
  socket.on('log:reset', (entries) => { app.logs = entries; renderLog(); renderPnChat(); });
  socket.on('log', (entries) => {
    app.logs.push(...entries);
    if (app.logs.length > 900) app.logs.splice(0, app.logs.length - 900);
    appendLog(entries);
    appendPn(entries);
    bubbles(entries);
    for (const e of entries) {
      if (!/bounty/.test(e.kind || '')) continue;
      const m = /^(.+?) won with 7-2 and collects the (.+?) bounty from (.+): (.+)$/.exec(e.text);
      if (m) announce(`${m[1]} won with 7-2`, `${m[4]} bounty: ${m[2]} from ${m[3]}`, 'bounty');
    }
    if (!wideChat() && els.drawer.classList.contains('collapsed')) {
      const fresh = entries.filter((e) => e.kind === 'chat' && e.userId !== myId()).length;
      if (fresh) { app.unread += fresh; paintUnread(); }
    }
  });
  socket.on('toast', (t) => toast(t.text));
  socket.on('request', (r) => {
    if (prefs.sound) playSound('request');
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
  const prev = app.state;
  // cards already on the table when the page opens are not dealt again
  app.quietDeal = first;
  app.state = s;
  app.offset = s.serverNow - Date.now();
  app.dec = s.table.decimals;
  app.fair.onState(s);
  const L = s.hand?.legal;
  const turnKey = L ? `${s.hand.number}|${s.hand.street}|${L.currentBet}|${L.toCall}` : null;
  if (turnKey && turnKey !== app.turnKey && prefs.sound) playSound('turn');
  app.turnKey = turnKey;
  const h = s.hand;
  if (prev && h?.isBomb && h.phase !== 'done' && (!prev.hand || prev.hand.number !== h.number)) bombIntro(h.number);
  if (h?.rit?.canChoose && h.rit.myChoice === null && prefs.autoRun !== 'ask' && app.autoRan !== h.number) {
    app.autoRan = h.number;
    emit('rit', { runs: prefs.autoRun === 'once' ? 1 : 'any' }, { quiet: true });
  }
  if (first) app.fair.onRevealed(s.table.revealedThrough, fetchRecord);
  render();
  // A finished game opens on its hand history; an open history picks up each hand as it ends. A link
  // with ?hand=N (from the game's summary page) opens the replayer on that hand.
  const want = first ? Number(new URLSearchParams(location.search).get('hand')) || null : null;
  if (first && s.table.hands > 0 && (want || s.table.status === 'ended')) H.historyDialog(want ? { start: want, sort: 'pot' } : {});
  else if (prev && prev.table.hands !== s.table.hands) H.historyRefresh();
  tableSounds(prev, s);
  announceSeats(prev, s);
  D.onState(s);
}

// Calling 30 is announced across the table for everyone, as well as the countdown on the seat: when
// someone calls it, when a big pot starts their 30 minutes again, and when they take it back.
const CLOCK = '<svg class="an-clock" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" stroke-width="3"/><path class="an-hand" d="M20 20V8.5" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/><path d="M20 20l6.5 4" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/></svg>';
const notices = [];
function announceSeats(prev, s) {
  if (!prev || !prev.seats) return;
  for (const info of s.seats) {
    if (!info) continue;
    const was = prev.seats.find((x) => x && x.userId === info.userId);
    if (!was || info.leaving) continue;
    const you = info.userId === s.me.userId;
    if (info.leaveAt && !was.leaveAt) announce(you ? 'You called 30' : `${info.name} called 30`, you ? 'You leave in 30 minutes' : 'Leaving in 30 minutes');
    else if (info.leaveAt && was.leaveAt && info.leaveAt - was.leaveAt > 60000) announce(you ? 'Your 30 minutes start again' : `${info.name}'s 30 minutes start again`, 'Won a pot over the line');
    else if (!info.leaveAt && was.leaveAt) announce(you ? 'You are staying' : `${info.name} is staying`, 'Called 30 is taken back', 'soft');
  }
}
function announce(title, sub, kind = '') {
  notices.push({ title, sub, kind });
  if (notices.length === 1) nextNotice();
}
function nextNotice() {
  const a = notices[0];
  if (!a || !els.stage) return;
  const el = document.createElement('div');
  el.className = `announce ${a.kind}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `${CLOCK}<div class="an-txt"><b>${esc(a.title)}</b><small>${esc(a.sub)}</small></div>`;
  els.stage.appendChild(el);
  if (prefs.sound && a.kind !== 'soft') playSound(a.kind === 'bounty' ? 'win' : 'call30');
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => { el.remove(); notices.shift(); nextNotice(); }, 450);
  }, a.kind === 'soft' ? 2400 : 3800);
}

// Chips for bets and calls, a slide for a fold, a knock for a check, and the pot pushed to a winner,
// worked out from what changed since the last update. Cards dealt make their sound as they land.
function tableSounds(prev, s) {
  if (!prefs.tableSounds) { app.dealt = []; return; }
  const dealt = app.dealt || [];
  app.dealt = [];
  dealt.slice(0, 30).forEach((d) => playSound(d.kind, d.ms / 1000));
  const h = s.hand;
  const was = prev && prev.hand;
  if (!h || !was || was.number !== h.number) return;
  const before = new Map(was.players.map((p) => [p.seat, p]));
  let delay = 0;
  for (const p of h.players) {
    const b = before.get(p.seat);
    if (!b || !p.lastAction) continue;
    // a new action, or more chips in on the same one (a bet swept into the pot at the end of a street is not)
    if (p.lastAction === b.lastAction && !(p.bet > b.bet) && p.folded === b.folded) continue;
    // your own action already sounded when you pressed it
    if (p.id === s.me.userId && app.mine && app.mine.n === h.number && Date.now() - app.mine.at < 5000) { app.mine = null; continue; }
    const a = p.lastAction;
    const kind = a === 'Fold' ? 'fold' : a === 'Check' ? 'check' : a === 'All-in' ? 'allin' : a === 'Call' ? 'call' : a === 'Bet' ? 'bet' : 'raise';
    playSound(kind, delay);
    delay += 0.09;
  }
  if (h.phase === 'done' && was.phase !== 'done' && h.results) playSound('win', 0.12);
}

// Your own action sounds the moment you press it, not a round trip later when the table answers.
function soundMine(type, L, to) {
  const h = app.state && app.state.hand;
  if (!prefs.tableSounds || !h || !L) return;
  const kind = type === 'fold' ? 'fold' : type === 'check' ? 'check'
    : type === 'call' ? (L.toCall >= L.stack ? 'allin' : 'call')
      : to >= L.allInTo ? 'allin' : L.isBet ? 'bet' : 'raise';
  playSound(kind);
  app.mine = { n: h.number, at: Date.now() };
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
  land: { box: 22, me: 26, card: 5.8, myCard: 7.4, reach: 8.4, myReach: 10.6, perU: 1 },
  // on a wide screen the boxes are narrower and the fans of four and five cards tighter, as on PokerNow,
  // so seats beside the board leave it room
  wide: { box: 20, me: 25, card: 5.8, myCard: 7.4, reach: 8.2, myReach: 10.6, perU: 1, step: { 2: 0.5, 4: 0.27, 5: 0.22 }, tilt: { 2: 6.5, 4: 16.5, 5: 18 } },
  port: { box: 20, me: 24.5, card: 5.5, myCard: 8.2, reach: 7.5, myReach: 10.6, perU: 100 / 64 },
};
const STEP = { 2: 0.5, 4: 0.32, 5: 0.27 };

// How far a fanned hand of n cards sticks out to the left of its box, in units, the tilt of the
// outside card included.
const TILT = { 2: 6.5, 4: 19.5, 5: 21 };
const PIVOT = 1.5; // the cards turn about a point this many card heights below their top (transform-origin 50% 150%)
function overhang(z, n, me) {
  const w = me ? z.myCard : z.card;
  const reach = me ? z.myReach : z.reach;
  const tilt = w * 1.2 * PIVOT * Math.sin((((z.tilt || TILT)[n] || 7) * Math.PI) / 180);
  return Math.max(0, w * (1 + (n - 1) * ((z.step || STEP)[n] || 0.4)) - reach + tilt);
}

// Where everything sits, in percent of the table area. Position 0 is the bottom middle (my seat when
// I play) and the rest go round clockwise. The bottom seat gets a little more room for its bigger cards.
// Bets sit on the line from a seat to the middle, just clear of that seat's box and cards and inside the
// felt; the dealer button sits beside the bet.
const ASPECT = { land: 1.72, wide: 1.95, port: 0.74, portMax: 0.8 };
const FELT = { land: { cx: 50, cy: 48, rx: 35, ry: 32 }, wide: { cx: 50, cy: 47, rx: 35.7, ry: 34.8 }, port: { cx: 50, cy: 49, rx: 37, ry: 39 } };
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

// extra: more room to keep around the board, in units (upright, for the list of runs under it)
function geometry(n, portrait, holeN, shown = null, extra = 0) {
  const wide = !portrait && !!app.wide;
  const z = portrait ? SIZES.port : wide ? SIZES.wide : SIZES.land;
  const P = portrait
    ? { cx: 50, cy: 48.5, px: 40, py: 43, mine: 1.55, boxh: 7.2, myBoxh: 7.6, pill: [8.5, 3.4], aim: 10, dot: 3, board: 7.6 }
    : wide ? { cx: 50, cy: 49.5, px: 42, py: 38.8, mine: 1.3, boxh: 7, myBoxh: 7.4, pill: [10, 3.1], aim: 14, dot: 2.6, board: 5.6 }
      : { cx: 50, cy: 48, px: 42, py: 40, mine: 1.3, boxh: 6.4, myBoxh: 6.8, pill: [10, 3.1], aim: 14, dot: 2.6 };
  const F = portrait ? FELT.port : wide ? FELT.wide : FELT.land;
  // work in units: x in % of the width divided by ux, y in % of the height divided by uy
  const ux = z.perU;
  const uy = z.perU * (portrait ? app.aspect || ASPECT.port : wide ? ASPECT.wide : ASPECT.land);
  // Seats are spaced evenly along the edge of the table measured in box sizes, not by angle: a box is
  // much wider than it is tall, so seats along the top and bottom need more of the edge than seats at
  // the sides. The bottom seat takes a little more again.
  const weights = Array.from({ length: n }, (_, i) => (i === 0 ? P.mine : 1));
  const tall = Math.max(P.boxh, z.card * 1.2 + 0.5);
  // Upright, the board is nearly as wide as the table: seats at the sides keep above or below it. On a
  // wide screen they do too, as on PokerNow, so no name or card reaches over the board.
  const band = P.board ? (P.board + extra + P.boxh / 2) / tall : 0;
  const C = { x: F.cx / ux, y: F.cy / uy };
  // how far from the top or bottom a box has to be for a chat bubble to fit beyond it
  const room = (4.6 + P.boxh / 2) * uy + 0.5;
  const R = { x: (F.rx / ux) * 0.84, y: (F.ry / uy) * 0.84 };
  // With many seats there is not room for them all above and below the board: then the band narrows,
  // step by step, until no two boxes meet, and the board gets smaller instead (fitBoard).
  const place = (bd) => clearBets(seatsAt(spread(weights, P.px / ux / z.box, P.py / uy / tall, bd)));
  // two seats meet when one's box or cards reach over the other's
  const hit = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  // (only seats that are drawn count: free seats are hidden while you are seated)
  const seen = (i) => !shown || shown[i];
  const meets = (list) => list.reduce((k, a, i) => k + (seen(i) ? list.filter((b, j) => j > i && seen(j) && (hit(a.box, b.plate) || hit(b.box, a.plate))).length : 0), 0);
  // (upright the band always holds: the board is nearly as wide as the table there)
  if (!band || portrait) return place(band);
  // the widest band that brings no seats together that would not meet anyway
  const base = meets(place(0));
  for (const f of [1, 0.7, 0.45, 0.2]) {
    const out = place(band * f);
    if (meets(out) <= base) return out;
  }
  return place(0);

  function seatsAt(angles) { return weights.map((wt, i) => {
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
    const card = (me ? z.myCard : z.card) * 1.2;
    const box = { l: S.x - bw / 2 - over, r: S.x + bw / 2, t: S.y - Math.max(me ? P.myBoxh : P.boxh, card + 1.2) / 2, b: S.y + Math.max(me ? P.myBoxh : P.boxh, card + 0.4) / 2 };
    // a hand's label hangs a little below the cards: a bet from a seat above the middle keeps clear of it
    const reach = sn < 0 ? { ...box, b: box.b + 0.7 } : box;
    // Where the bet goes: out of the box toward the middle, aimed above or below it so bets from the
    // sides stay off the board (aimK), and far enough to be on the felt. across < 1 puts it more in front
    // of its own player than toward the middle.
    const ray = (aimK, across) => {
      const off = (S.y < C.y - 0.5 ? -P.aim : S.y > C.y + 0.5 ? P.aim : 0) * aimK;
      let d = { x: (C.x - S.x) * across, y: C.y + off - S.y };
      const len = Math.hypot(d.x, d.y) || 1;
      d = { x: d.x / len, y: d.y / len };
      const exit = Math.min(
        d.x > 1e-6 ? (reach.r - S.x) / d.x : d.x < -1e-6 ? (reach.l - S.x) / d.x : Infinity,
        d.y > 1e-6 ? (reach.b - S.y) / d.y : d.y < -1e-6 ? (reach.t - S.y) / d.y : Infinity,
      );
      const along = Math.abs(d.x) * (P.pill[0] / 2) + Math.abs(d.y) * (P.pill[1] / 2);
      let dist = exit + along + 0.6;
      // and far enough in to be on the felt: where the ray enters the inner ellipse
      const ox = (S.x - C.x) / R.x, oy = (S.y - C.y) / R.y, vx = d.x / R.x, vy = d.y / R.y;
      const qa = vx * vx + vy * vy, qb = 2 * (ox * vx + oy * vy), qc = ox * ox + oy * oy - 1;
      const disc = qb * qb - 4 * qa * qc;
      if (qc > 0 && disc > 0) dist = Math.max(dist, (-qb - Math.sqrt(disc)) / (2 * qa));
      return { S, d, len, dist: Math.min(dist, len * 0.8) };
    };
    // On a wide screen a seat along the top or the bottom has a second place to try, more in front of
    // itself, for when the first lands on its own cards or on a neighbour (clearBets picks).
    const rays = [ray(1, 1)];
    if (wide) rays.push(ray(1 - Math.abs(sn), 1 - 0.6 * Math.abs(sn)));
    const { d, dist } = rays[0];
    const B = { x: S.x + d.x * dist, y: S.y + d.y * dist };
    return {
      x, y,
      box, reach, rays,
      // where this seat's bet sits, so the board keeps clear of it too
      bet: { l: B.x - P.pill[0] / 2, r: B.x + P.pill[0] / 2, t: B.y - P.pill[1] / 2, b: B.y + P.pill[1] / 2 },
      // close to the left edge a hand's label lines up with the cards instead of centring under them
      edge: S.x - bw / 2 - over < 7,
      bx: B.x * ux, by: B.y * uy,
      upper: sn < -0.25,
      // a chat bubble goes on the outside of the box when there is room for it there
      bubbleIn: sn < -0.25 ? y < room : y > 100 - room,
      plate: { l: S.x - bw / 2 - 0.4, r: S.x + bw / 2 + 0.4, t: S.y - (me ? P.myBoxh : P.boxh) / 2 - 0.3, b: S.y + (me ? P.myBoxh : P.boxh) / 2 + 0.3 },
    };
  }); }

  // Each bet takes the first of its places that is clear of its own box, of every other player and of
  // the bets already placed; failing that, it moves on toward the middle until it is clear of them.
  function clearBets(list) {
    const placed = [];
    const pill = (ray, k) => {
      const B = { x: ray.S.x + ray.d.x * k, y: ray.S.y + ray.d.y * k };
      return { B, r: { l: B.x - P.pill[0] / 2, r: B.x + P.pill[0] / 2, t: B.y - P.pill[1] / 2, b: B.y + P.pill[1] / 2 } };
    };
    list.forEach((s, i) => {
      if (!seen(i)) return;
      const blocked = (r) => hit(r, s.reach) || hit(r, s.plate) || placed.some((q) => hit(r, q))
        || list.some((o, j) => j !== i && seen(j) && (hit(r, o.reach) || hit(r, o.plate)));
      let pick = null;
      for (const ray of s.rays) { const at = pill(ray, ray.dist); if (!blocked(at.r)) { pick = at; break; } }
      for (const ray of s.rays) {
        if (pick) break;
        let k = ray.dist;
        let at = pill(ray, k);
        while (k < ray.len * 0.8 && blocked(at.r)) { k += 0.4; at = pill(ray, k); }
        if (!blocked(at.r)) pick = at;
      }
      if (!pick) pick = pill(s.rays[0], s.rays[0].dist);
      s.bet = pick.r;
      s.bx = pick.B.x * ux;
      s.by = pick.B.y * uy;
      placed.push(pick.r);
    });
    return list;
  }
}

function resize() {
  const wide = wideChat();
  if (wide) return resizeWide();
  els.area.style.left = els.area.style.top = '';
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
  placeArea(W, H, portrait, false, aspect);
}

// On a wide screen the table spreads across the window, as on PokerNow, with its corners left for the
// menu (top left), the game and blinds (top right), the chat (bottom left) and the buttons (bottom
// right). Those are drawn for a 1650 by 954 window and scaled with it (--pk); the table sits just above
// the chat and the buttons, and is centred across.
const PN = { w: 1650, h: 954, side: 104, top: 10, bottom: 186 };
function resizeWide() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const k = Math.max(0.6, Math.min(1.7, Math.min(vw / PN.w, vh / PN.h)));
  document.body.style.setProperty('--pk', k.toFixed(4));
  const side = PN.side * k, top = PN.top * k, bottom = PN.bottom * k;
  const W = Math.max(300, Math.min(vw - 2 * side, (vh - top - bottom) * ASPECT.wide));
  const H = W / ASPECT.wide;
  els.area.style.left = ((vw - W) / 2).toFixed(1) + 'px';
  els.area.style.top = (top + Math.max(0, vh - top - bottom - H) * 0.6).toFixed(1) + 'px';
  placeArea(W, H, false, true, ASPECT.wide);
}

function placeArea(W, H, portrait, wide, aspect) {
  els.area.style.width = W + 'px';
  els.area.style.height = H + 'px';
  els.area.classList.toggle('portrait', portrait);
  els.area.classList.toggle('wide', wide);
  els.area.style.setProperty('--au', (portrait ? W / 64 : W / 100) + 'px');
  if (app.portrait !== portrait || app.wide !== wide || Math.abs((app.aspect || 0) - aspect) > 0.005) {
    app.portrait = portrait;
    app.wide = wide;
    app.aspect = aspect;
    render();
  } else { fitBoard(); fitLabels(); fitTags(); fitBets(); }
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
  S.hudRefresh();
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
  if (wideChat()) {
    els.top.innerHTML = pnTopHTML(s, { game, dbNow, rot, status, ends, reqs });
    els.pnname.innerHTML = `<b>${esc(t.name)}</b><a href="/">${esc(t.clubName || 'The Aquarium')}</a>`;
    tick();
    return;
  }
  // a tourney's level and clock need room: the table name gives some up
  els.top.classList.toggle('tb-tour', !!t.tourney);
  els.top.innerHTML = `
    <span class="conn ${app.connected ? '' : 'off'}" title="${app.connected ? 'Connected' : 'Reconnecting'}"></span>
    <a class="wordmark" href="/" title="Back to the club">${wordmarkHTML(26)}</a>
    <div class="tb-title"><strong>${esc(t.name)}</strong><a href="/">${esc(t.clubName || 'The Aquarium')}</a></div>
    <div class="tb-game">
      <span class="pill brass" title="${esc(GAME_TYPES[game]?.name || '')}">${esc(gameShort(game))}</span>${dbNow ? '<span class="pill soft" title="Two boards, each pot split between them">Double board</span>' : ''}
      <span class="pill num">${fmt(st.smallBlind)}/${fmt(st.bigBlind)}</span>
      ${t.tourney ? tourneyPills(t.tourney, true) : ''}
      ${st.sevenDeuce ? `<span class="pill s72" title="Win a Hold’em hand with 7-2 and show it: everyone else dealt in pays ${esc(fmt(st.sevenDeuce))}">7-2 ${fmt(st.sevenDeuce)}</span>` : ''}${st.straddle ? '<span class="pill soft sm-hide" title="The player under the gun can straddle">Straddle</span>' : ''}
      ${rot ? `<span class="tb-note">${esc(rot)}</span>` : ''}
      ${bomb}${status}
    </div>
    ${ends && t.status === 'running' ? `<${s.me.isHost ? 'button type="button" data-open="clock"' : 'div'} class="tb-clock" data-ends="${ends}" title="Time left in this game${s.me.isHost ? '. Add time or remove the clock' : ''}"><b>--:--</b><small>left</small></${s.me.isHost ? 'button' : 'div'}>` : ''}
    ${t.session && t.session.clockAtFirstHand && st.sessionMinutes ? `<span class="pill soft tb-wait" title="The time limit starts with the first hand">${st.sessionMinutes} min game, clock starts with the first hand</span>` : ''}
    <div class="tb-actions">
      <button class="seal-btn" data-open="fair" title="Deck seal for the next hand">${sealSVG(f.commitment, 30)}<span class="txt"><b>Hand #${f.handNumber} sealed</b>${f.contributions} player input${f.contributions === 1 ? '' : 's'}</span></button>
      ${reqs ? `<button class="btn primary small" data-open="requests">Requests <span class="count">${reqs}</span></button>` : ''}
      ${s.me.isHost && t.status === 'running' && !ends && !t.session?.clockAtFirstHand ? '<button class="btn small sm-hide" data-open="clock" title="Start a clock for this game">Clock</button>' : ''}
      ${s.me.isHost ? '<button class="btn small sm-hide" data-open="options">Options</button>' : ''}
      <button class="btn small sm-hide" data-open="ledger">Ledger</button>
      <button class="btn small sm-hide" data-open="stats">Stats</button>
      ${hudButton('btn small sm-hide md-hide hud-btn')}
      <button class="btn small sm-hide md-hide" data-open="hands">Hands</button>
      <button class="btn small sm-hide md-hide" data-open="look">Look</button>
      <button class="btn small sm-hide chat-btn ${els.drawer.classList.contains('collapsed') ? '' : 'primary'}" data-open="log">Chat<span class="unread" ${app.unread ? '' : 'hidden'}>${app.unread > 9 ? '9+' : app.unread || ''}</span></button>
      <button class="btn small menu-btn" data-open="menu">Menu</button>
    </div>`;
  tick();
}

// ---------- the corners, on a wide screen ----------
const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${d}</svg>`;
const PN_ICON = {
  menu: svg('<path d="M3.5 6h17M3.5 12h17M3.5 18h17" stroke-width="3"/>'),
  hands: svg('<rect x="3.5" y="6.5" width="10.5" height="14" rx="1.8"/><path d="M10.3 4.3l1.2-.6a1.8 1.8 0 0 1 2.4.8l5.4 10.7a1.8 1.8 0 0 1-.8 2.4l-3.1 1.6"/>'),
  chips: svg('<circle cx="10" cy="13" r="7"/><circle cx="10" cy="13" r="2.8"/><path d="M10 6v2.2M10 17.8V20M3 13h2.2M14.8 13H17M19.5 3v6M16.5 6h6"/>'),
  away: svg('<path d="M19.5 14.8A8 8 0 0 1 9.2 4.5a8 8 0 1 0 10.3 10.3z"/>'),
  back: svg('<path d="M7.5 3.5v8.5h9.5"/><path d="M5.5 12h13.5l-1.4 3.4H6.9z"/><path d="M12 15.4v4.6M7.8 20.5h8.4"/>'),
  clock: svg('<circle cx="12" cy="12.5" r="8.5"/><path d="M12 8v4.8l3.2 2"/>'),
  straddle: svg('<text x="12" y="16.6" text-anchor="middle" font-size="12.5" font-weight="900" fill="currentColor" stroke="none">2×</text><rect x="2.5" y="4.5" width="19" height="15" rx="3"/>'),
  leave: svg('<path d="M13.5 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20h7"/><path d="M10 12h10.5M16.8 8.2l3.8 3.8-3.8 3.8"/>'),
  bell: svg('<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.6 2H4.4z"/><path d="M10 20.6a2.1 2.1 0 0 0 4 0"/>'),
  soundOn: svg('<path d="M4 9.3h3.6L12.2 5v14l-4.6-4.3H4z" fill="currentColor" stroke="none"/><path d="M15.6 9a4.2 4.2 0 0 1 0 6M18.2 6.4a7.8 7.8 0 0 1 0 11.2"/>'),
  soundOff: svg('<path d="M4 9.3h3.6L12.2 5v14l-4.6-4.3H4z" fill="currentColor" stroke="none"/><path d="M15.8 9.4l5 5.2M20.8 9.4l-5 5.2"/>'),
  bomb: svg('<circle cx="10.5" cy="14" r="6.8" fill="currentColor" stroke="none"/><path d="M14.6 9.6l2.4-2.4M18.4 3.6v1.6M20.8 6.2h-1.6M20.4 4l-1.1 1.1"/>'),
};
const soundOn = () => !!(prefs.sound || prefs.tableSounds);
// opens the HUD panel: the HUD on or off, and a switch for each player
const hudButton = (cls) => {
  const on = S.hudOn();
  return `<button type="button" class="${cls} ${on ? 'on' : 'off'}" data-open="hud" aria-haspopup="dialog" aria-expanded="false" title="HUD, the stats on each seat: ${on ? 'on' : 'off'}. Switch it on or off for each player"><span>HUD</span></button>`;
};

function pnTopHTML(s, { game, dbNow, rot, status, ends, reqs }) {
  const t = s.table;
  const st = t.settings;
  const f = s.fairness;
  // the game now and, when they take turns, the next one, as PokerNow shows them
  let games = `<span class="pn-g" title="${esc(GAME_TYPES[game]?.name || '')}"><b>${esc(gameShort(game))}</b>${dbNow ? '<small>Double board</small>' : ''}</span>`;
  if (t.rotation) {
    const r = t.rotation;
    const cap = r.unit === 'orbits' && r.count > 1
      ? (r.lastOrbit ? (r.handsLeft > 0 ? 'Last orbit' : 'Last hand') : `Orbit ${r.orbit} of ${r.count}`)
      : (r.handsLeft > 0 ? `${r.handsLeft} more hand${r.handsLeft === 1 ? '' : 's'}` : 'Last hand');
    games = `<span class="pn-games" title="${esc(rot)}"><span class="pn-g"><b>${esc(gameShort(r.current))}${r.currentDouble ? ' <i>DB</i>' : ''}</b><small>${cap}</small></span><span class="pn-to" aria-hidden="true">&raquo;</span><span class="pn-g next"><b>${esc(gameShort(r.next))}${r.nextDouble ? ' <i>DB</i>' : ''}</b><small>Next</small></span></span>`;
  }
  let bomb = '';
  const bm = st.bombPot.mode;
  if (t.bombNext) bomb = '<span class="pn-bomb hot" title="Bomb pot next hand">' + PN_ICON.bomb + '<small>Next</small></span>';
  else if (bm === 'every' || bm === 'both') {
    const left = Math.max(1, st.bombPot.every - t.handsSinceBomb);
    bomb = `<span class="pn-bomb" title="Bomb pot ${left === 1 ? 'next hand' : `in ${left} hands`}${bm === 'both' ? `, or sooner: each hand has a ${st.bombPot.percent}% chance` : ''}">${PN_ICON.bomb}<small>${left === 1 ? 'Next' : left}</small></span>`;
  } else if (bm === 'percent') bomb = `<span class="pn-bomb" title="Each hand has this chance of being a bomb pot">${PN_ICON.bomb}<small>${st.bombPot.percent}%</small></span>`;
  const notes = [
    t.tourney && tourneyPills(t.tourney),
    st.sevenDeuce && `<span class="pill s72" title="Win a Hold’em hand with 7-2 and show it: everyone else dealt in pays ${esc(fmt(st.sevenDeuce))}">7-2 pays ${fmt(st.sevenDeuce)}</span>`,
    st.straddle && '<span class="pill soft" title="The player under the gun can straddle">Straddle</span>',
    ends && t.status === 'running' && `<${s.me.isHost ? 'button type="button" data-open="clock"' : 'div'} class="tb-clock" data-ends="${ends}" title="Time left in this game${s.me.isHost ? '. Add time or remove the clock' : ''}"><b>--:--</b><small>left</small></${s.me.isHost ? 'button' : 'div'}>`,
    t.session && t.session.clockAtFirstHand && st.sessionMinutes && `<span class="pill soft" title="The time limit starts with the first hand">${st.sessionMinutes} min game, clock starts with the first hand</span>`,
    status,
  ].filter(Boolean).join('');
  // the menu down the left, with what you can do in your seat under it
  const it = (attrs, icon, label, cls = '') => `<button type="button" class="pn-it ${cls}" ${attrs}>${PN_ICON[icon]}<span>${label}</span></button>`;
  let side = it('data-open="menu" title="Game options, ledger, stats, look and feel"', 'menu', 'Options') + it('data-open="hands" title="Hand history and the replayer"', 'hands', 'Hands');
  if (reqs) side += `<button type="button" class="pn-it hot" data-open="requests" title="Players waiting for you">${PN_ICON.bell}<span>Requests</span><b class="pn-n">${reqs}</b></button>`;
  if (s.me.seated) {
    const out = s.me.sittingOut || s.me.sitOutNext;
    const live = t.status !== 'ended';
    side += out ? it('data-my="back" title="Back in from the next hand"', 'back', 'I’m back', 'go') : it(`data-my="sitout" title="${awayTip(s)}"`, 'away', 'Away');
    if (live && !t.tourney) side += it('data-my="chips" title="Add chips to your stack"', 'chips', 'Add chips');
    if (live && t.tourney && t.tourney.canBuyIn && myStack(s) === 0) side += it('data-my="rebuy" title="Rebuy for the tourney buy-in"', 'chips', 'Rebuy', 'go');
    if (st.straddle && live) side += it(`data-my="straddle" aria-pressed="${!!s.me.straddle}" title="Post a straddle, twice the big blind, whenever you are under the gun"`, 'straddle', 'Straddle', s.me.straddle ? 'on' : '');
    if (s.me.leaveAt && !s.me.leaving) side += `<button type="button" class="pn-it warn" data-my="stay" title="Take back calling it">${PN_ICON.clock}<span><b data-leave-at="${s.me.leaveAt}">--:--</b> Stay</span></button>`;
    else if (!s.me.leaving && live) side += it('data-my="call30" title="Tell the table you are leaving in 30 minutes. A pot over 1,000 starts the 30 minutes again."', 'clock', 'Call 30');
    if (!s.me.leaving) side += it('data-my="stand" title="Stand up and leave your seat"', 'leave', 'Leave seat');
  }
  const sound = soundOn();
  return `
    <a class="pn-brand wordmark" href="/" title="Back to the club"><span class="conn ${app.connected ? '' : 'off'}" title="${app.connected ? 'Connected' : 'Reconnecting'}"></span>${wordmarkHTML(24)}</a>
    <nav class="pn-menu" aria-label="Table">${side}</nav>
    <div class="pn-info">
      <div class="pn-game">${games}<span class="pn-tilde" aria-hidden="true">~</span><span class="pn-blinds" title="Small and big blind">${fmt(st.smallBlind)} / ${fmt(st.bigBlind)}</span>${bomb}</div>
      <div class="pn-row2">${notes ? `<div class="pn-notes">${notes}</div>` : ''}
        <button type="button" class="pn-tool seal" data-open="fair" title="Hand #${f.handNumber} sealed, ${f.contributions} player input${f.contributions === 1 ? '' : 's'}. How the deal can be checked">${sealSVG(f.commitment, 34)}</button>
        ${hudButton('pn-tool hud-tool')}
        <button type="button" class="pn-tool" data-sound aria-pressed="${sound}" title="${sound ? 'Turn the table sounds off' : 'Turn the table sounds on'}">${sound ? PN_ICON.soundOn : PN_ICON.soundOff}</button>
      </div>
    </div>`;
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

// True the first time a card shows up in this hand (and not when the page has just opened).
function fresh(key) {
  if (app.seen.has(key)) return false;
  app.seen.add(key);
  return !app.quietDeal;
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

// What a hand makes on the run being dealt, one name per board: "Two pair (5,4) / Flush". brief: the
// short form (Straight (9), not Straight (9 high)), as the runouts use.
function madeHand(h, hole, brief = false) {
  if (!hole || !hole.length || !hole.every(Boolean)) return '';
  const { boards } = currentRun(h);
  if (!boards[0] || boards[0].length < 3) return '';
  const made = boards.map((b) => bestHand(hole, b, GAME_TYPES[h.gameType].omaha)).filter(Boolean);
  if (made.length < 2) return made.length ? shortHandName(made[0].score, brief) : '';
  return made.map((r) => shortHandName(r.score, true)).join(' / ');
}

// Who won each board, once the hand is over: board index -> [{ seat, name, amount }], the most first.
function boardWinners(h) {
  const r = h && h.phase === 'done' && h.results;
  if (!r || r.uncontested || !r.pots) return null;
  const per = new Map();
  for (const pot of r.pots) {
    if (pot.uncontested) continue;
    for (const run of pot.runs || []) {
      const i = run.b ?? run.run;
      const m = per.get(i) || new Map();
      for (const w of run.winners) {
        const cur = m.get(w.seat) || { seat: w.seat, name: w.name, amount: 0 };
        cur.amount += w.amount;
        m.set(w.seat, cur);
      }
      per.set(i, m);
    }
  }
  return new Map([...per].map(([i, m]) => [i, [...m.values()].sort((a, b) => b.amount - a.amount)]));
}

const RUN_ROOM = 2.4;
const BOARD_ROOM = 6;
const runCount = (h) => Math.max(1, Math.round((h.boards || [h.board]).length / (h.boardsPerRun || 1)));

// Run more than once on one board: for each run, who won it as soon as its last card is down (the
// server's word once the hand is over), or, while its cards are still to come and everyone left is all
// in with their cards face up, each one's chance of winning that run. Cards dealt to the other runs
// cannot come in this one, so they count as seen.
function runsInfo(h, wins) {
  const boards = h.boards || [h.board];
  const omaha = GAME_TYPES[h.gameType].omaha;
  const left = h.players.filter((p) => !p.folded);
  const live = left.filter((p) => p.hole && p.hole.length && p.hole.every(Boolean));
  const faceUp = live.length >= 2 && live.length === left.length;
  const betting = h.actorSeat !== null && h.actorSeat !== undefined;
  const foldedSeen = h.players.filter((p) => p.folded && p.hole).flatMap((p) => p.hole.filter(Boolean));
  const handOn = (hole, b) => { const r = hole && hole.every(Boolean) ? bestHand(hole, b, omaha) : null; return r ? shortHandName(r.score, true) : ''; };
  return boards.map((b, r) => {
    b = b || [];
    const server = wins && wins.get(r);
    if (server && server.length) {
      const first = h.players.find((p) => p.seat === server[0].seat);
      return { done: true, winners: server.map((w) => w.seat), hand: first ? handOn(first.hole, b) : '' };
    }
    if (b.length >= 5 && faceUp) {
      let best = -1;
      let winners = [];
      for (const p of live) {
        const res = bestHand(p.hole, b, omaha);
        const sc = res ? res.score : -1;
        if (sc > best) { best = sc; winners = [p.seat]; } else if (sc === best) winners.push(p.seat);
      }
      return { done: true, winners, hand: best >= 0 ? shortHandName(best, true) : '' };
    }
    if (faceUp && !betting && h.phase !== 'done') {
      const seen = [...boards.filter((_, i) => i !== r).flat(), ...foldedSeen];
      try { return { done: false, odds: equity(live.map((p) => ({ seat: p.seat, hole: p.hole })), [b], omaha, seen) }; } catch { /* no odds */ }
    }
    return { done: false };
  });
}

const pctText = (ch) => { const n = Math.round(ch); return `${n === 0 && ch > 0 ? '<1' : n === 100 && ch < 100 ? '>99' : n}%`; };
// odds over 50% are green, under 50% red, an even 50% neither
const eqTone = (ch) => { const n = Math.round(ch); return n > 50 ? 'up' : n < 50 ? 'down' : 'even'; };

// Once a run's cards are all down, each player's share of it as a percent: 100 for its one winner,
// split between ties, and half a share for each board when there are two.
function runShares(h, r) {
  const boards = h.boards || [h.board];
  const bpr = h.boardsPerRun || 1;
  const omaha = GAME_TYPES[h.gameType].omaha;
  const live = h.players.filter((p) => !p.folded && p.hole && p.hole.length && p.hole.every(Boolean));
  if (live.length < 2) return null;
  const out = new Map(live.map((p) => [p.seat, 0]));
  for (const b of boards.slice(r * bpr, r * bpr + bpr)) {
    if (!b || b.length < 5) return null;
    let best = -1;
    let win = [];
    for (const p of live) {
      const res = bestHand(p.hole, b, omaha);
      const sc = res ? res.score : -1;
      if (sc > best) { best = sc; win = [p.seat]; } else if (sc === best) win.push(p.seat);
    }
    for (const seat of win) out.set(seat, out.get(seat) + 100 / bpr / win.length);
  }
  return out;
}

// The last run whose cards are all down, or -1.
function lastRunDone(h) {
  const boards = h.boards || [h.board];
  const bpr = h.boardsPerRun || 1;
  let last = -1;
  for (let r = 0; r < Math.max(1, Math.round(boards.length / bpr)); r++) {
    if (boards.slice(r * bpr, r * bpr + bpr).every((b) => b && b.length >= 5)) last = r;
  }
  return last;
}

// The odds on each seat: the chance of winning the run being dealt while its cards are to come. When a
// run's last card is down, its winner goes to 100% (the others to 0) and that stays up for a moment
// before the next run's odds, or until the next hand after the last run. The numbers count from
// where they were to where they go (animateOdds).
const EQ_HOLD = 1800;
function seatOdds(h) {
  if (!h) return null;
  // runs already over when this hand is first seen (a reload mid-runout) are not held again
  if (!app.eq || app.eq.hand !== h.number) app.eq = { hand: h.number, shown: new Map(), had: false, done: lastRunDone(h), at: 0, final: null, timer: null, raf: 0 };
  const e = app.eq;
  const live = allInChances(h);
  if (live) e.had = true;
  if (e.had) {
    const r = lastRunDone(h);
    if (r > e.done) {
      const shares = runShares(h, r);
      if (shares) { e.done = r; e.at = Date.now(); e.final = shares; }
    }
  }
  const held = e.final && (!live || Date.now() - e.at < EQ_HOLD);
  if (held && live) {
    clearTimeout(e.timer);
    e.timer = setTimeout(() => { if (app.state && app.state.hand && app.state.hand.number === e.hand) renderTable(app.state); }, EQ_HOLD - (Date.now() - e.at) + 30);
  }
  return held ? e.final : live;
}

// Counts each seat's odds from what it showed to its new number, the colour following the number: a
// quick count after each card, a little longer when a run is won and they go to 100% and 0%.
const EQ_COUNT = 250;
const EQ_COUNT_WON = 500;
function animateOdds() {
  const e = app.eq;
  if (!e) return;
  cancelAnimationFrame(e.raf);
  const items = [...document.querySelectorAll('.plate .eq[data-eq-seat]')].map((el) => ({ el, seat: Number(el.dataset.eqSeat), from: Number(el.dataset.from), to: Number(el.dataset.to) }));
  for (const x of items) e.shown.set(x.seat, x.from);
  const moving = items.filter((x) => Math.abs(x.to - x.from) > 0.05);
  for (const x of items) if (!moving.includes(x)) e.shown.set(x.seat, x.to);
  if (!moving.length) return;
  const won = moving.every((x) => x.to === 0 || x.to === 100);
  const length = won ? EQ_COUNT_WON : EQ_COUNT;
  // the clock starts on the first frame drawn (a frame's time can be from before this was called)
  let start = null;
  const step = (now) => {
    if (start === null) start = now;
    const k = Math.max(0, Math.min(1, (now - start) / length));
    const ease = 1 - (1 - k) ** 3;
    for (const x of moving) {
      const v = x.from + (x.to - x.from) * ease;
      e.shown.set(x.seat, v);
      x.el.textContent = pctText(v);
      x.el.classList.remove('up', 'down', 'even');
      x.el.classList.add(eqTone(v));
    }
    if (k < 1) e.raf = requestAnimationFrame(step);
  };
  e.raf = requestAnimationFrame(step);
}

// Away, where the cards would be: in red, with how long they have been away (kept up by tick)
// ---------- a bomb pot going off ----------
// Before a bomb pot is dealt: a lit bomb drops onto the felt, shakes and goes off in a comic burst with
// BOMB POT across it, the felt jolting and sparks flying; then the cards come. The server holds the
// first player's clock for as long (DELAYS.bombIntro).
const BOMB_INTRO = 2000;
// a jagged burst: n spikes, each a little different, squashed to sx by sy
function burstPoints(n, rOut, rIn, sx = 1, sy = 1, jitter = 0) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (Math.PI * i) / n - Math.PI / 2;
    const r = i % 2 ? rIn : rOut * (1 - jitter / 2 + (((i * 37) % 11) / 10) * jitter);
    pts.push(`${(Math.cos(a) * r * sx).toFixed(1)},${(Math.sin(a) * r * sy).toFixed(1)}`);
  }
  return pts.join(' ');
}
const BOMB_SVG = (() => {
  const star = (r) => `<polygon points="${burstPoints(5, r, r * 0.45)}" fill="#ffc533" stroke="#1b1b1f" stroke-width="3" stroke-linejoin="round"/>`;
  const sparks = [[-215, -100], [210, -112], [-240, 36], [236, 50], [-125, 142], [132, 138], [8, -170], [-40, 172]]
    .map(([x, y], i) => `<g class="bi-spark" style="--dx:${x}px;--dy:${y}px;--d:${i * 22}ms">${star(12 + (i % 3) * 4)}</g>`).join('');
  return `<svg class="bi-svg" viewBox="-260 -190 520 380" aria-hidden="true">
    <defs><pattern id="bi-dots" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(20)"><circle cx="4.5" cy="4.5" r="1.7" fill="#d98e04"/></pattern></defs>
    <g class="bi-sparks">${sparks}</g>
    <g class="bi-burst">
      <polygon points="${burstPoints(14, 150, 106, 1.36, 0.95, 0.36)}" fill="#ffd23f" stroke="#1b1b1f" stroke-width="7" stroke-linejoin="round"/>
      <polygon points="${burstPoints(14, 150, 106, 1.36, 0.95, 0.36)}" fill="url(#bi-dots)" opacity=".45"/>
      <polygon points="${burstPoints(11, 104, 80, 1.3, 0.88, 0.3)}" fill="#fff3c4" stroke="#1b1b1f" stroke-width="4" stroke-linejoin="round"/>
    </g>
    <g class="bi-text">
      <text class="bi-shadow" x="6" y="30" text-anchor="middle">BOMB POT</text>
      <text class="bi-word" x="0" y="24" text-anchor="middle">BOMB POT</text>
    </g>
    <g class="bi-bomb">
      <circle r="40" fill="#1b1b1f"/>
      <ellipse cx="-14" cy="-15" rx="11" ry="7" fill="#fff" opacity=".8" transform="rotate(-35 -14 -15)"/>
      <rect x="-12" y="-52" width="24" height="15" rx="3" fill="#48484a" stroke="#1b1b1f" stroke-width="3"/>
      <path d="M0 -52 C 6 -72, 26 -70, 30 -86" fill="none" stroke="#9c7a45" stroke-width="5" stroke-linecap="round"/>
      <g transform="translate(30 -88)"><g class="bi-fuse">${star(14)}</g></g>
    </g>
  </svg>`;
})();

function bombIntro(n) {
  app.bombIntro = { hand: n, until: Date.now() + BOMB_INTRO };
  if (prefs.sound) playSound('bomb');
  const area = els.area;
  const feltEl = document.getElementById('felt');
  if (!area || !feltEl) return;
  area.querySelector('.bomb-intro')?.remove();
  const f = feltEl.getBoundingClientRect();
  const box = area.getBoundingClientRect();
  const w = Math.min(f.width * 0.96, 540);
  const el = document.createElement('div');
  el.className = 'bomb-intro';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'Bomb pot');
  el.style.cssText = `left:${f.left - box.left + f.width / 2 - w / 2}px;top:${f.top - box.top + f.height / 2 - w * 0.365}px;width:${w}px`;
  el.innerHTML = BOMB_SVG;
  area.appendChild(el);
  feltEl.classList.remove('bi-jolt');
  void feltEl.offsetWidth; // start the jolt again
  feltEl.classList.add('bi-jolt');
  setTimeout(() => { el.remove(); feltEl.classList.remove('bi-jolt'); }, BOMB_INTRO + 80);
}

// A tourney in the top bar: the level and the time left on it, the blinds after it, and the pool
// (with what each place gets, paid by place). short: the phone's bar, which has less room.
function tourneyPills(tv, short = false) {
  const lv = tv.levels[Math.min(tv.level, tv.levels.length - 1)];
  const next = tv.levels[tv.level + 1];
  const time = !tv.started || !next ? ''
    : tv.levelEndsAt ? `<b data-level-ends="${tv.levelEndsAt}">--:--</b>` : tv.levelLeft !== null && tv.levelLeft !== undefined ? `<b>${clock(tv.levelLeft)}</b>` : '';
  const title = `Level ${tv.level + 1} of ${tv.levels.length}, blinds ${fmt(lv[0])}/${fmt(lv[1])}${next ? `; then ${fmt(next[0])}/${fmt(next[1])}${tv.started ? '' : ` after ${tv.levelMinutes} minutes, from the first hand`}` : '; the last level'}. They go up between hands.`;
  const pays = tv.payouts ? tv.payouts.map((a, i) => `${ordinal(i + 1)} ${fmt(a)}`).join(', ') : 'Chips are cash';
  return `<span class="pill tour" title="${esc(title)}">${short ? 'L' : 'Level '}${tv.level + 1}${time ? ` ${time}` : ''}${next && !short ? ` <small>then ${fmt(next[0])}/${fmt(next[1])}</small>` : ''}</span>`
    + `<span class="pill soft ${short ? 'sm-hide' : ''}" title="${esc(`Prize pool from ${tv.entrants} player${tv.entrants === 1 ? '' : 's'}: ${pays}`)}">Pool ${fmt(tv.pool)}</span>`;
}
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;
// Away folds you out of a hand you are still in, then you sit out until I'm back
const awayTip = (s) => (s.hand && s.hand.phase !== 'done' && s.hand.players.some((p) => p.id === s.me.userId && !p.folded && !p.allIn)
  ? 'Fold this hand and sit out until I’m back' : 'Sit out until I’m back');
const myStack = (s) => (s.me.seated ? s.seats[s.me.seat]?.stack ?? 0 : 0);

const awayMark = (since) => `<span class="awaymark" role="img" aria-label="Away"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 14.8A8 8 0 0 1 9.2 4.5a8 8 0 1 0 10.3 10.3z"/></svg><span>Away</span>${since ? `<b data-away-since="${since}">${clock(Math.max(1000, now() - since))}</b>` : ''}</span>`;
const FOLD_MARK = '<span class="foldmark" aria-label="Folded"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 5.5l13 13M18.5 5.5l-13 13"/></svg><span>Fold</span></span>';

function renderTable(s) {
  const t = s.table;
  const n = t.settings.maxPlayers;
  const h = s.hand;
  if (h && app.seenHand !== h.number) { app.seenHand = h.number; app.seen = new Set(); }
  const nextGame = t.rotation ? t.rotation.current : t.settings.format[0].game;
  const holeN = GAME_TYPES[h ? h.gameType : nextGame]?.holeCount || 2;
  const rot0 = s.me.seat ?? 0;
  const myReq0 = s.me.requests.find((r) => r.type === 'seat');
  const asked = new Set((s.requests || []).filter((r) => r.type === 'seat').map((r) => r.seat));
  // which places are drawn, so only those have to keep clear of each other
  const shown = Array.from({ length: n }, (_, i) => {
    const seat = (i + rot0) % n;
    return !!s.seats[seat] || !s.me.seated || asked.has(seat) || (myReq0 && myReq0.seat === seat);
  });
  // Upright, the middle is taller when a hand is run more than once (its runs are listed under the
  // board) or dealt on two boards (one above the other): the seats at the sides keep clear of it.
  const runsN = h ? runCount(h) : 1;
  const bprN = h ? h.boardsPerRun || 1 : 1;
  const rowsN = bprN > 1 && runsN === 1 ? bprN : bprN > 1 ? runsN : 1;
  const extra = !app.portrait || !h ? 0 : bprN === 1 ? (runsN - 1) * RUN_ROOM : (rowsN - 1) * BOARD_ROOM;
  const geo = geometry(n, app.portrait, holeN, shown, extra);
  // Dealing goes one card at a time: one to each player, starting left of the button, then the next
  // round, each card coming from the middle of the table.
  const order = h ? h.players.map((p) => p.seat).sort((a, b) => a - b) : [];
  if (h) { const k = order.findIndex((st) => st > h.buttonSeat); if (k > 0) order.push(...order.splice(0, k)); }
  const step = order.length ? Math.max(45, Math.min(110, 1800 / (order.length * holeN))) : 0;
  const intro = h && app.bombIntro?.hand === h.number ? Math.max(0, app.bombIntro.until - Date.now()) : 0;
  const dealAt = (seat, i) => intro + Math.round((i * order.length + Math.max(0, order.indexOf(seat))) * step);
  const AW = els.area.clientWidth;
  const AH = els.area.clientHeight;
  app.dealt = [];
  const rot = s.me.seat ?? 0;
  const hp = new Map((h?.players || []).map((p) => [p.seat, p]));
  const R = resultInfo(h);
  // each player's chance of winning the run being dealt, on their seat (a hand run more than once
  // also lists each runout's odds beside it), going to 100% for a run's winner once its cards are down
  const chances = seatOdds(h);
  const myReq = s.me.requests.find((r) => r.type === 'seat');
  const pendingSeats = new Set((s.requests || []).filter((r) => r.type === 'seat').map((r) => r.seat));
  const nowMs = Date.now();
  let seats = '';
  let chips = '';
  app.boxes = [];
  for (let seat = 0; seat < n; seat++) {
    const g = geo[(seat - rot + n) % n];
    const pos = `left:${g.x.toFixed(2)}%;top:${g.y.toFixed(2)}%`;
    const info = s.seats[seat];
    const side = g.upper ? 'upper' : 'lower';
    if (!info) {
      const mine = myReq && myReq.seat === seat;
      const canSit = !s.me.seated && !myReq && t.status !== 'ended';
      // a free seat: its number in the corner and, for someone who can take it, the whole box to click
      const no = `<span class="seat-no" aria-hidden="true">${seat + 1}</span>`;
      if (canSit && !pendingSeats.has(seat)) {
        app.boxes.push(g.box);
        seats += `<div class="seat empty open ${side}" style="${pos}"><button type="button" class="plate" data-sit="${seat}" aria-label="Sit in seat ${seat + 1}">${no}<span class="sit-word">Sit</span></button></div>`;
        continue;
      }
      let inner = '';
      if (mine) inner = '<span class="sit-note">Waiting for the host</span>';
      else if (pendingSeats.has(seat)) inner = '<span class="sit-note">Requested</span>';
      // once you are seated, free seats are not drawn at all; one someone has asked for still says so
      if (s.me.seated && !inner) continue;
      app.boxes.push(g.box);
      seats += `<div class="seat empty ${side} ${mine ? 'reserved' : ''} ${inner ? '' : 'quiet'}" style="${pos}"><div class="plate" ${inner ? '' : `title="Seat ${seat + 1} is free"`}>${no}${inner}</div></div>`;
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
      // a card seen face down before is turned over in place; a new card is dealt to the seat
      const motion = (key, back, i) => {
        if (!fresh(key)) return ['', ''];
        if (app.seen.has(back) && back !== key) return ['flip', ''];
        const ms = dealAt(seat, i);
        app.dealt.push({ ms, kind: 'deal' });
        return ['deal', `;--dd:${ms}ms`];
      };
      if (faces) {
        const hc = R.handCards.get(seat);
        // once the hand is over your own cards can be tapped to show them, as well as the Show buttons
        const canShow = isMe && h && h.canShow;
        cards = p.hole.map((c, i) => {
          if (!c) { const [m, st] = motion(`b${seat}${i}`, `b${seat}${i}`, i); return backHTML(m, `--i:${i}${st}`); }
          const [m, st] = motion(`h${seat}${i}${c}`, `b${seat}${i}`, i);
          const showable = canShow && !(p.showIdx || []).includes(i);
          return cardHTML(c, `${hc ? (hc.has(c) ? 'win' : 'dim') : ''} ${isMe ? '' : 'tint'} ${m}${showable ? ' showable' : ''}`, `--i:${i}${st}`, showable ? `data-show-card="${i}" title="Show this card to the table"` : '');
        }).join('');
      } else if (!p.folded) {
        cards = Array.from({ length: count }, (_, i) => { const [m, st] = motion(`b${seat}${i}`, `b${seat}${i}`, i); return backHTML(m, `--i:${i}${st}`); }).join('');
      }
      const fx = ((50 - g.x) / 100) * AW;
      const fy = ((47.5 - g.y) / 100) * AH;
      if (cards) fan = `<div class="fan n${count}" style="--fx:${fx.toFixed(0)}px;--fy:${fy.toFixed(0)}px">${cards}</div>`;
      else if (p.folded) fan = FOLD_MARK;
      const ch = chances && chances.get(seat);
      if (ch !== undefined && ch !== null) {
        const from = app.eq.shown.has(seat) ? app.eq.shown.get(seat) : ch;
        extra += `<span class="eq ${eqTone(from)} n${count}" data-eq-seat="${seat}" data-from="${from}" data-to="${ch}" title="Chance of winning this run, from the cards on the table">${pctText(from)}</span>`;
      }
      const seeAll = p.hole && p.hole.length && p.hole.every(Boolean);
      // (not while a bomb pot goes off: the cards are not dealt yet)
      if (!intro && seeAll && (!p.folded || p.shown) && (isMe ? prefs.handStrength || !live : true) && (isMe || !live || chances || p.shown)) {
        // One label, over the bottom of the cards only: what the hand makes on the run being dealt (with
        // its number when it runs more than once). Once a hand run more than once is over, each runout
        // names its winner and their hand instead.
        const runsN = runCount(h);
        const name = runsN > 1 && h.phase === 'done' ? '' : madeHand(h, p.hole, runsN > 1);
        // two boards: both hands, on two lines where one would reach over a box (fitLabels)
        const parts = name.split(' / ').map((x) => `<span>${esc(x)}</span>`);
        if (name) extra += `<span class="made n${count}">${runsN > 1 ? `<i>#${currentRun(h).r + 1}</i>` : ''}${parts.join('<span class="sep"> / </span>')}</span>`;
      }
    }

    // Away (ran out of time, left the page or sat out): everyone sees it where the cards would be,
    // with how long, until they are back; cards still in a hand show first
    const away = info.away || info.sittingOut || info.sitOutNext;
    if (away && !fan.startsWith('<div class="fan')) fan = awayMark(info.awaySince);

    let tag = '';
    let tagCls = '';
    // during the run-it vote each player's pick shows on their seat, for the whole table
    const ritPick = h && h.phase === 'rit' && h.rit ? (h.rit.picks || []).find((x) => x.seat === seat) : null;
    if (won) { tag = '+' + fmt(won); tagCls = 'win'; }
    else if (ritPick) { tag = ritPick.pick === null ? 'Picking' : ritPick.pick === 'any' ? 'Any number' : cap(TIMES[ritPick.pick]); tagCls = ritPick.pick === null ? 'out' : 'pick'; }
    else if (p && live && p.lastAction && !p.allIn && !(p.folded && !isMe) && !away) { tag = p.lastAction; tagCls = p.lastAction.toLowerCase().replace(/[^a-z]/g, ''); }
    else if (info.leaving) { tag = 'Leaving'; tagCls = 'out'; }
    else if (!p && info.stack === 0 && !away) { tag = 'Out of chips'; tagCls = 'out'; }
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
    const vin = (s.voice || []).find((x) => x.userId === info.userId);
    app.boxes.push(g.box);
    // a player in the hand may bet: while there is betting, the board keeps clear of that place, so it
    // does not change size as bets come and go (once everyone is all in, the bets are in the pot)
    if (p && h.phase === 'betting') app.boxes.push(g.bet);
    seats += `<div class="${cls}${bubble ? ' talking' : ''}" style="${pos}" data-uid="${esc(info.userId)}" ${s.me.isHost && !isMe ? `data-player="${esc(info.userId)}" title="Host actions for ${esc(info.name)}"` : ''}>
      <div class="plate">
        ${fan}${extra}
        <div class="who">
          <div class="nm">${info.connected ? '' : '<span class="dot" title="Disconnected"></span>'}<span>${esc(info.name)}</span>${info.isHost ? '<span class="host-mark" title="Host">&#9733;</span>' : ''}${vin ? `<span class="vc ${vin.muted ? 'muted' : ''}" title="${vin.muted ? 'In voice, muted' : 'In voice'}">${vin.muted ? MIC_OFF : MIC}</span>` : ''}</div>
          <div class="st">${allIn ? 'All In' : fmt(stack)}${info.pendingChips ? ` <small>+${fmt(info.pendingChips)}</small>` : ''}</div>
          ${S.hudHTML(s, info.userId)}
        </div>
        ${timer}
        ${info.leaveAt && !info.leaving ? `<span class="c30" title="${esc(info.name)} called 30: they leave when this runs out"><i data-leave-at="${info.leaveAt}">--:--</i> left</span>` : ''}
        ${h && h.buttonSeat === seat ? '<span class="dbtn" title="Dealer" aria-label="Dealer button">D</span>' : ''}
        ${tag ? `<div class="tag ${tagCls}">${esc(tag)}</div>` : ''}
      </div>
      ${bubble}
    </div>`;
    if (p && p.bet > 0) chips += `<div class="bet" data-x="${g.bx.toFixed(2)}" data-y="${g.by.toFixed(2)}" data-uid="${esc(info.userId)}" style="left:${g.bx.toFixed(2)}%;top:${g.by.toFixed(2)}%">${fmt(p.bet)}</div>`;
  }
  els.seats.innerHTML = seats;
  els.chips.innerHTML = chips;
  VC.paintVoice();
  els.center.innerHTML = centerHTML(s, R);
  fitBoard();
  fitLabels();
  fitTags();
  fitBets();
  fitMark();
  animateOdds();
}

// The board never goes under a player: where a seat's box or cards would reach over it, the middle of
// the table is drawn smaller (--bk), just enough to keep clear of them all. The boxes come from the
// layout (in units), not from the page, so cards still flying in from the middle do not count.
function fitBoard() {
  const c = els.center;
  const b = c && c.querySelector('.boards');
  let t = 1;
  // (upright the seats keep above and below the board instead, and a smaller board would be too small)
  if (b && app.boxes && app.boxes.length && !app.portrait) {
    const A = els.area.getBoundingClientRect();
    const u = A.width / (app.portrait ? 64 : 100);
    const B = b.getBoundingClientRect();
    const K = c.getBoundingClientRect();
    if (B.width && u) {
      // Everything in the middle scales about the middle's own centre, which stays put; so take the
      // board at full size relative to that centre, and find the largest scale that keeps it clear.
      const bk = app.bk || 1;
      const kx = (K.left + K.right) / 2, ky = (K.top + K.bottom) / 2;
      const L0 = (B.left - kx) / bk, R0 = (B.right - kx) / bk, T0 = (B.top - ky) / bk, B0 = (B.bottom - ky) / bk;
      const pad = 0.9 * u;
      for (const r of app.boxes) {
        const rl = r.l * u - pad + A.left - kx, rr = r.r * u + pad + A.left - kx;
        const rt = r.t * u - pad + A.top - ky, rb = r.b * u + pad + A.top - ky;
        if (rr <= L0 || rl >= R0 || rb <= T0 || rt >= B0) continue;
        // how far the board can grow before it meets this box, across or up and down
        const tx = rl >= 0 ? (R0 > 0 ? rl / R0 : 1) : rr <= 0 ? (L0 < 0 ? rr / L0 : 1) : 0;
        const ty = rt >= 0 ? (B0 > 0 ? rt / B0 : 1) : rb <= 0 ? (T0 < 0 ? rb / T0 : 1) : 0;
        t = Math.min(t, Math.max(tx, ty));
      }
    }
  }
  t = Math.max(0.6, Math.min(1, t));
  if (Math.abs(t - (app.bk || 1)) > 0.012 || (t === 1 && app.bk && app.bk !== 1)) {
    app.bk = t;
    if (t >= 1) c.style.removeProperty('--bk');
    else c.style.setProperty('--bk', t.toFixed(3));
  }
}

// What a hand makes hangs under the cards. A long one could reach over the player's own name and
// numbers: then it moves left as far as the window allows, and on two boards it can go on two lines;
// where it would still reach down over the player below, it moves up a little over the foot of the
// cards. Whichever covers least (on a tie the label stays as it is).
function fitLabels() {
  const seats = [...els.seats.querySelectorAll('.seat')];
  if (!seats.some((x) => x.querySelector('.plate > .made'))) return;
  const hit = (a, c, k = 1) => a.left < c.right - k && c.left < a.right - k && a.top < c.bottom - k && c.top < a.bottom - k;
  const box = (r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  const rect = (el) => box(el.getBoundingClientRect());
  const real = (r) => r.right > r.left && r.bottom > r.top;
  // Measured once: what stays put while the labels move (everyone's box and cards, each player's own
  // name and numbers) and where each label is. A way to place a label is then worked out from those
  // numbers; the page is measured again only for a label's shape on two lines.
  const fixed = seats.map((x) => [...x.querySelectorAll('.plate, .fan')].map(rect).filter(real));
  const who = seats.map((x) => { const w = x.querySelector('.who'); return w ? rect(w) : null; });
  const labels = seats.map((x) => x.querySelector('.plate > .made'));
  for (const m of labels) if (m) { m.classList.remove('two'); m.style.marginLeft = m.style.marginTop = ''; }
  const at = labels.map((m) => (m ? rect(m) : null));
  const mv = (r, dx, dy) => ({ left: r.left - dx, right: r.right - dx, top: r.top - dy, bottom: r.bottom - dy });
  const others = (i) => seats.flatMap((x, j) => (j === i ? [] : at[j] ? [...fixed[j], at[j]] : fixed[j]));
  const cost = (r, i) => {
    let n = r.left < 1 ? 1 : 0;
    if (who[i] && hit(r, who[i], 2)) n++;
    for (const q of others(i)) if (hit(r, q)) n++;
    return n;
  };
  // left, clear of the player's own name, as far as the window allows
  const left = (r, i) => { const over = who[i] ? r.right - who[i].left + 3 : 0; return Math.max(0, Math.min(over, r.left - 2)); };
  // up, just clear of whoever is below, by at most two thirds of the label's height
  const up = (r, i) => {
    let need = 0;
    for (const q of others(i)) if (hit(r, q) && q.top > r.top) need = Math.max(need, r.bottom - q.top + 2);
    return need > 0 && need <= (r.bottom - r.top) * 0.65 ? need : 0;
  };
  labels.forEach((m, i) => {
    if (!m) return;
    const one = at[i];
    let two = null;
    if (m.querySelector('.sep')) { m.classList.add('two'); two = rect(m); m.classList.remove('two'); }
    const ways = [{ r: one, dx: 0 }, { r: one, dx: left(one, i) }];
    if (two) ways.push({ r: two, dx: 0, two: true }, { r: two, dx: left(two, i), two: true });
    const dx = left(one, i);
    ways.push({ r: one, dx, dy: up(mv(one, dx, 0), i) });
    let best = null;
    for (const w of ways) {
      const r = mv(w.r, w.dx, w.dy || 0);
      const n = cost(r, i);
      if (!best || n < best.n) best = { ...w, n, at: r };
      if (!n) break;
    }
    m.classList.toggle('two', !!best.two);
    m.style.marginLeft = best.dx ? `${-best.dx}px` : '';
    m.style.marginTop = best.dy ? `${-best.dy}px` : '';
    at[i] = best.at;
  });
}

// A player's last action sits just outside their box, on the side away from the middle, so it covers
// none of their name, stack or numbers; where another player's box, cards or labels are there, or the
// edge of the window, it goes on the inside of the box instead.
function fitTags() {
  const seats = [...els.seats.querySelectorAll('.seat')];
  const tags = seats.map((x) => x.querySelector('.plate > .tag')).filter(Boolean);
  if (!tags.length) return;
  const hit = (a, c) => a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1;
  const rectsOf = (x, sel) => [...x.querySelectorAll(sel)].map((el) => el.getBoundingClientRect()).filter((r) => r.width && r.height);
  const parts = seats.map((x) => rectsOf(x, '.plate, .fan, .made, .eq'));
  // the bar along the top: on a computer its parts sit on their own (the bar itself takes no room),
  // so each part counts, the game and blinds, the tags under them and the buttons
  const top = els.top ? [...els.top.querySelectorAll(':scope > *, :scope > * > *')].map((el) => el.getBoundingClientRect()).filter((q) => q.width && q.height) : [];
  const cost = (tag, own) => {
    const r = tag.getBoundingClientRect();
    let n = 0;
    seats.forEach((x, i) => {
      if (x === own) { for (const q of rectsOf(x, '.made, .eq')) if (hit(r, q)) n++; return; }
      for (const q of parts[i]) if (hit(r, q)) n++;
      const t = x.querySelector('.plate > .tag');
      if (t && hit(r, t.getBoundingClientRect())) n++;
    });
    if (r.top < 0 || r.bottom > window.innerHeight || top.some((q) => hit(r, q))) n += 2;
    return n;
  };
  for (const tag of tags) {
    tag.classList.remove('in');
    const own = tag.closest('.seat');
    const out = cost(tag, own);
    if (!out) continue;
    tag.classList.add('in');
    if (cost(tag, own) >= out) tag.classList.remove('in');
  }
}

// A bet never sits on anyone's box, cards or labels, on the pot or the board, or on another bet. The
// layout places bets for a pill of the usual size, so a long amount, or a pot pushed up by a taller
// middle, can still reach over something: such a bet moves to the nearest clear place on the felt
// around where it was put, the side nearest its player first.
function fitBets() {
  const bets = [...els.chips.querySelectorAll('.bet')];
  if (!bets.length) return;
  // start from where the layout put them
  for (const b of bets) { b.style.left = `${b.dataset.x}%`; b.style.top = `${b.dataset.y}%`; }
  const A = els.area.getBoundingClientRect();
  const F = els.felt.getBoundingClientRect();
  if (!A.width || !F.width) return;
  const pad = 2;
  const grow = (r) => ({ l: r.left - pad, r: r.right + pad, t: r.top - pad, b: r.bottom + pad });
  const hit = (a, c) => a.l < c.r && c.l < a.r && a.t < c.b && c.t < a.b;
  const keep = [];
  const add = (el) => { const r = el.getBoundingClientRect(); if (r.width && r.height) keep.push(grow(r)); };
  els.seats.querySelectorAll('.plate, .fan, .made, .tag, .hud, .dbtn, .c30').forEach(add);
  els.center.querySelectorAll('.pot:not(.ghost), .boards, .meta, .rit-note').forEach(add);
  const fx = (F.left + F.right) / 2, fy = (F.top + F.bottom) / 2, frx = F.width / 2, fry = F.height / 2;
  const onFelt = (q) => [[q.l, q.t], [q.r, q.t], [q.l, q.b], [q.r, q.b]].every(([x, y]) => ((x - fx) / frx) ** 2 + ((y - fy) / fry) ** 2 <= 1);
  const rects = bets.map((b) => b.getBoundingClientRect());
  const u = parseFloat(getComputedStyle(els.area).getPropertyValue('--au')) || A.width / 100;
  const maxR = Math.max(64, u * 14);
  bets.forEach((b, i) => {
    const r = rects[i];
    const others = rects.filter((_, j) => j !== i).map(grow);
    const at = (dx, dy) => ({ l: r.left + dx, r: r.right + dx, t: r.top + dy, b: r.bottom + dy });
    const clear = (q) => !keep.some((k) => hit(q, k)) && !others.some((k) => hit(q, k));
    if (clear(at(0, 0))) return;
    // the player's own box, to keep the bet on their side
    const own = els.seats.querySelector(`.seat[data-uid="${CSS.escape(b.dataset.uid || '')}"] .plate`);
    const o = own && own.getBoundingClientRect();
    const ox = o ? (o.left + o.right) / 2 : fx, oy = o ? (o.top + o.bottom) / 2 : fy;
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    for (let d = 3; d <= maxR; d += 3) {
      let best = null;
      for (let k = 0; k < 24; k++) {
        const th = (k / 24) * 2 * Math.PI;
        const dx = d * Math.cos(th), dy = d * Math.sin(th);
        const q = at(dx, dy);
        if (!clear(q) || !onFelt(q)) continue;
        const near = Math.hypot(cx + dx - ox, cy + dy - oy);
        if (!best || near < best.near) best = { dx, dy, near };
      }
      if (best) {
        b.style.left = `${((cx + best.dx - A.left) / A.width) * 100}%`;
        b.style.top = `${((cy + best.dy - A.top) / A.height) * 100}%`;
        rects[i] = b.getBoundingClientRect();
        return;
      }
    }
  });
}

// The Aquarium on the felt steps aside when boards or results reach down over it.
function fitMark() {
  const mark = els.felt.querySelector('.felt-mark');
  if (!mark) return;
  const k = els.center.firstElementChild ? els.center.getBoundingClientRect() : null;
  const low = els.center.querySelector(':scope > .below');
  const c = k && { top: k.top, bottom: Math.max(k.bottom, low ? low.getBoundingClientRect().bottom : 0) };
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
  // a board dealt with the hands (a bomb pot's flop) waits until the hands are out
  const boardStart = app.dealt && app.dealt.length ? Math.max(...app.dealt.map((d) => d.ms)) + 350 : 0;
  let turned = 0;
  let grid = '';
  if (bpr > 1 && !stacked) grid += `${runs > 1 ? '<span></span>' : ''}${Array.from({ length: bpr }, (_, i) => `<span class="bhead">Board ${i + 1}</span>`).join('')}`;
  // once the hand is over, each run (or board) names who won it
  const wins = boardWinners(h);
  const winNames = (i) => {
    const list = wins && wins.get(i);
    if (!list || !list.length) return '';
    return list.length === 1 ? esc(list[0].name) : `${list.slice(0, 2).map((w) => esc(w.name)).join(', ')}${list.length > 2 ? ' +' : ''} split`;
  };
  const runWin = (i) => { const n = winNames(i); return n ? `<b class="rwin">${n}</b>` : ''; };
  // Run more than once on one board: the cards the runs share are drawn once, and each run's own cards
  // stack in their column, each later run over the one before, so every card stays full size and every
  // run's number and suit still show. Who won each run is named beside its row.
  const stackRuns = runs > 1 && bpr === 1;
  if (stackRuns) {
    const sharedN = Math.min(5, h.sharedCount ?? 0);
    const used = R.boardUsed.slice(0, runs);
    let cols = '';
    for (let j = 0; j < 5; j++) {
      const stack = j >= sharedN;
      const n = stack ? runs : 1;
      let cards = '';
      for (let r = 0; r < n; r++) {
        const c = (boards[r] || [])[j];
        const under = r < n - 1 ? ' stk' : '';
        if (!c) { cards += `<span class="card slot${under}" aria-hidden="true" style="--r:${r}"></span>`; continue; }
        const isNew = fresh(`r${r}${j}${c}`);
        let style = `--r:${r}`;
        if (isNew) { const ms = boardStart + turned * 240; turned++; app.dealt.push({ ms, kind: 'board' }); style += `;--dd:${ms}ms`; }
        // a shared card is lit when any run's winner used it
        const u = stack ? (used[r] ? [used[r]] : []) : used.filter(Boolean);
        const mark = u.length ? (u.some((x) => x.has(c)) ? 'win' : 'dim') : '';
        cards += cardHTML(c, [isNew ? 'flip' : '', under, mark].join(' '), style);
      }
      cols += `<div class="bcol${stack ? ' multi' : ''}">${cards}</div>`;
    }
    // beside each run: its winner and their hand once its cards are all down, its odds until then
    const nameOf = (seat) => { const n = s.seats[seat]?.name || `Seat ${seat + 1}`; return n.length > 10 ? `${n.slice(0, 9)}…` : n; };
    const info = runsInfo(h, wins);
    const tags = info.map((x, r) => {
      let body = '';
      if (x.done && x.winners && x.winners.length) {
        const who = x.winners.length === 1 ? esc(nameOf(x.winners[0])) : `${x.winners.slice(0, 2).map((w) => esc(nameOf(w))).join(', ')}${x.winners.length > 2 ? ' +' : ''} split`;
        body = `<span class="rbody"><b class="rwin">${who}</b>${x.hand ? `<small class="rhand">${esc(x.hand)}</small>` : ''}</span>`;
      } else if (x.odds && x.odds.size) {
        const list = [...x.odds].sort((a, b) => b[1] - a[1]).slice(0, 3);
        body = `<span class="rbody rodds">${list.map(([seat, ch]) => `<span class="${eqTone(ch)}"><b>${esc(nameOf(seat))}</b> ${pctText(ch)}</span>`).join('')}</span>`;
      }
      return `<span class="rtag${x.done ? ' done' : x.odds ? ' odds' : ''}" style="--r:${r}"><i><span class="rw">Run </span>${r + 1}</i>${body}</span>`;
    }).join('');
    const label = info.map((x, r) => `Run ${r + 1}: ${x.done && x.winners ? `${x.winners.map(nameOf).join(' and ')}${x.hand ? `, ${x.hand}` : ''}` : x.odds ? [...x.odds].map(([seat, ch]) => `${nameOf(seat)} ${pctText(ch)}`).join(', ') : 'to come'}`).join('. ');
    grid = `<div class="board runs" aria-label="${esc(label)}"><div class="rtags" aria-hidden="true">${tags}</div>${cols}</div>`;
  }
  for (let r = 0; r < (stackRuns ? 0 : runs); r++) {
    // one board a run: the winner under the run's name; two boards a run: under each board instead
    if (runs > 1) grid += `<span class="run">Run ${r + 1}${bpr > 1 ? '' : runWin(r)}</span>`;
    for (let side = 0; side < bpr; side++) {
      const i = r * bpr + side;
      if (stacked) grid += `<span class="run">Board ${side + 1}${runWin(i)}</span>`;
      const b = boards[i] || [];
      const used = R.boardUsed[i];
      let slots = '';
      for (let j = 0; j < 5; j++) {
        const c = b[j];
        if (!c) { slots += slotHTML(); continue; }
        // new cards are turned over one after another; a later run's copy of the shared cards just shows
        const shared = r > 0 && j < (h.sharedCount ?? 0);
        const isNew = fresh(`r${i}${j}${c}`) && !shared;
        let style = '';
        if (isNew) { const ms = boardStart + turned * 240; turned++; app.dealt.push({ ms, kind: 'board' }); style = `--dd:${ms}ms`; }
        const cls = [isNew ? 'flip' : '', shared ? 'shared' : '', used ? (used.has(c) ? 'win' : 'dim') : ''].join(' ');
        slots += cardHTML(c, cls, style);
      }
      const cap = bpr > 1 && runs > 1 ? winNames(i) : '';
      grid += `<div class="board${cap ? ' capd' : ''}" aria-label="${esc(boardName(i, bpr, boards.length) || 'Board')}">${slots}${cap ? `<small class="bwin">${cap}</small>` : ''}</div>`;
    }
  }
  const cols = stackRuns ? 'auto' : stacked ? 'auto auto' : `${runs > 1 ? 'auto ' : ''}repeat(${bpr}, auto)`;
  let below = '';
  let above = '';
  if (h.phase === 'done' && h.results) {
    // the pot's place is kept, so the board stays where it was as the results come in under it
    const again = `<button type="button" class="replay-btn" data-replay="${h.number}">Replay hand #${h.number}</button>`;
    above = `<div class="pot-spot"><div class="pot ghost" aria-hidden="true"><b>0</b></div>${app.portrait ? '' : again}</div>`;
    below = `<div class="results">${resultLines(h).map((l) => `<div>${l}</div>`).join('')}</div>${app.portrait ? again : ''}`;
    if (t.waiting && t.waiting !== 'Waiting for players') below += `<div class="waiting"><small>${esc(t.waiting)}</small></div>`;
  } else {
    // the pot in the middle, and above it everything in, bets in front of the players included
    const out = h.potTotal - (h.pot ?? h.potTotal);
    above = h.pot > 0
      ? `<div class="pot">${out > 0 ? `<span class="total"><i>total</i> ${fmt(h.potTotal)}</span>` : ''}<b>${fmt(h.pot)}</b></div>`
      : `<div class="pot"><b><i>total</i> ${fmt(h.potTotal)}</b></div>`;
    if (h.phase === 'rit') {
      below += `<div class="rit-note">All in: picking how many times to run it, <span data-ritclock></span></div>`;
    } else if (h.rit && h.rit.result > 1 && !stackRuns) below += `<div class="rit-note">Running it ${TIMES[h.rit.result]}</div>`;
  }
  const bombWhy = h.bombReason === 'manual' ? 'called by the host' : h.bombReason === 'every' ? 'scheduled' : h.bombReason === 'percent' ? 'random' : '';
  const bomb = h.isBomb ? `<span class="bomb" title="${esc(bombWhy)}">Bomb pot</span>` : '';
  // what goes under the board hangs below it, so the board does not move when it comes and goes
  return `${above}<div class="boards ${stackRuns ? `kr` : `k${Math.min(runs, 4)}`} b${bpr}${stacked ? ' stacked' : ''}${stackRuns ? ' stackruns' : ''}${wins && bpr > 1 && runs > 1 ? ' capped' : ''}" style="grid-template-columns:${cols}${stackRuns ? `;--k:${runs}` : ''}">${grid}</div>
    <div class="below">${below}<div class="meta">${bomb}<span>${esc(gameShort(h.gameType))} hand ${h.number}</span></div></div>`;
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
      // the hand in its short name, with its ranks, as on the seats: Two pair (4,2)
      let hand = w.hand;
      try { if (w.cards && w.cards.length === 5) hand = shortHandName(score5(w.cards), true); } catch { /* keep the server's name */ }
      const cur = m.get(w.seat) || { name: w.name, amount: 0, hand };
      cur.amount += w.amount;
      m.set(w.seat, cur);
    }
  }));
  const lines = [];
  // run more than once on one board, each board is a run, and the line says so
  const word = (h.boardsPerRun || 1) === 1 && nb > 1 ? 'runs' : 'boards';
  // Three or more boards, a hand run more than once on one board, or two boards on a phone (each run
  // or board already names its winner beside it, and the seats their hands): one line for the winners,
  // so the felt stays readable (the log has every board).
  if (nb > 2 || (nb > 1 && (bpr === 1 || app.portrait))) {
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
      lines.push(`<b>${esc(x.name)}</b> wins ${fmt(x.amount)} ${x.boards === nb ? (nb === 2 ? `on both ${word}` : `on all ${nb} ${word}`) : `on ${x.boards} of ${nb} ${word}`}`);
    } else if (list.length) {
      const parts = list.map((x) => `<b>${esc(x.name)}</b> ${fmt(x.amount)}`);
      lines.push(`${parts.slice(0, -1).join(', ')} and ${parts.at(-1)} over ${nb} ${word}`);
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

const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const MIC_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" opacity=".55"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".55"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

function voiceHTML(s) {
  const v = VC.voice;
  const inVoice = s.voice || [];
  const others = inVoice.filter((x) => x.userId !== s.me.userId);
  const names = others.map((x) => x.name + (x.muted ? ' (muted)' : '')).join(', ');
  const who = others.length ? `<span class="vwho" title="${esc(names)}">${others.length === 1 ? `${esc(others[0].name)} is` : `${others.length} others are`} in voice</span>` : '';
  if (!v.on) {
    if (s.table.status === 'ended' && !inVoice.length) return '';
    return `<span class="vgroup"><button class="btn vbtn" data-voice="join" ${v.joining ? 'disabled' : ''}>${MIC}<span>${v.joining ? 'Joining voice' : 'Join voice'}</span></button>${who}</span>`;
  }
  return `<span class="vgroup on"><button class="btn vbtn ${v.muted ? 'muted' : 'live'}" data-voice="mute" aria-pressed="${v.muted}" title="${v.muted ? 'Your microphone is off' : 'Your microphone is on'}">${v.muted ? MIC_OFF : MIC}<span>${v.muted ? 'Unmute' : 'Mute'}</span></button><button class="btn ghost small" data-voice="leave">Leave voice</button>${who || '<span class="vwho">Nobody else in voice yet</span>'}</span>`;
}

// The voice box beside the chat on a wide screen, as PokerNow has it: Join, then the microphone.
function pnVoiceHTML(s) {
  const v = VC.voice;
  const inVoice = s.voice || [];
  const others = inVoice.filter((x) => x.userId !== s.me.userId);
  const names = others.map((x) => x.name + (x.muted ? ' (muted)' : '')).join(', ');
  if (!v.on) {
    return `<button type="button" class="pv-join" data-voice="join" ${v.joining ? 'disabled' : ''} title="${others.length ? `In voice: ${esc(names)}` : 'Join voice chat'}"><span class="pv-l">${v.joining ? 'Joining' : 'Join'}</span><span class="pv-mic">${MIC}</span>${others.length ? `<span class="pv-n">${others.length} in</span>` : ''}</button>`;
  }
  return `<div class="pv-on"><span class="pv-l">Voice</span><button type="button" class="pv-mic ${v.muted ? 'muted' : 'live'}" data-voice="mute" aria-pressed="${v.muted}" title="${v.muted ? 'Your microphone is off: unmute' : 'Your microphone is on: mute'}">${v.muted ? MIC_OFF : MIC}</button><button type="button" class="pv-leave" data-voice="leave" title="${others.length ? `With ${esc(names)}` : 'Nobody else in voice yet'}">Leave</button></div>`;
}

function renderBottom(s) {
  if (wideChat()) els.pnvoice.innerHTML = s.table.status === 'ended' && !(s.voice || []).length && !VC.voice.on ? '' : pnVoiceHTML(s);
  const wide = wideChat();
  let my = wide ? '' : voiceHTML(s);
  if (s.me.seated) {
    // on a wide screen these are in the menu down the left, as on PokerNow
    if (!wide) {
      const out = s.me.sittingOut || s.me.sitOutNext;
      my += out
        ? '<button class="btn primary" data-my="back">I’m back</button>'
        : `<button class="btn" data-my="sitout" title="${awayTip(s)}">Away</button>`;
      if (s.table.status !== 'ended' && !s.table.tourney) my += '<button class="btn" data-my="chips">Add chips</button>';
      if (s.table.status !== 'ended' && s.table.tourney?.canBuyIn && myStack(s) === 0) my += '<button class="btn primary" data-my="rebuy">Rebuy</button>';
      if (s.table.settings.straddle && s.table.status !== 'ended') my += `<button class="btn tog ${s.me.straddle ? 'on' : ''}" data-my="straddle" aria-pressed="${!!s.me.straddle}" title="Post a straddle, twice the big blind, whenever you are under the gun">Straddle</button>`;
      if (s.me.leaveAt && !s.me.leaving) my += `<span class="status-line call30">Leaving in <b data-leave-at="${s.me.leaveAt}">--:--</b></span><button class="btn ghost" data-my="stay" title="Take back calling it">Stay</button>`;
      else if (!s.me.leaving && s.table.status !== 'ended') my += '<button class="btn" data-my="call30" title="Tell the table you are leaving in 30 minutes. A pot over 1,000 starts the 30 minutes again.">Call 30</button>';
      if (!s.me.leaving) my += '<button class="btn ghost" data-my="stand">Stand up</button>';
    }
    if (s.hand && s.hand.canShow) {
      const mine = s.hand.players.find((p) => p.id === s.me.userId);
      const st72 = s.table.settings.sevenDeuce;
      const won = (s.hand.results?.payouts || []).some((w) => w.id === s.me.userId && w.amount > 0);
      if (st72 && won && mine?.hole?.length === 2 && mine.hole.map((c) => c && c[0]).sort().join('') === '27') my += `<span class="status-line s72-hint">Show both cards to collect the 7-2 bounty</span>`;
    }
    if (s.me.requests.some((r) => r.type === 'chips')) my += '<span class="status-line">Chip request sent to the host</span>';
  } else if (s.me.requests.length) {
    my += '<span class="status-line">Waiting for the host to approve your seat</span><button class="btn ghost small" data-my="cancel">Cancel request</button>';
  } else if (s.table.tourney && s.table.status !== 'ended' && s.table.tourney.myPlace) {
    my += `<span class="status-line">You are out in ${ordinal(s.table.tourney.myPlace)} place${s.table.tourney.canBuyIn ? '. Pick an empty seat to buy in again.' : '.'}</span>`;
  } else if (s.table.status !== 'ended') {
    my += '<span class="status-line">You are watching. Pick an empty seat to play.</span>';
  }
  // a tourney that is over: the places, and what each was paid
  const places = s.table.tourney?.places;
  if (s.table.status === 'ended' && places?.length) {
    my += `<span class="status-line t-places">${places.slice(0, 6).map((x) => `<b>${ordinal(x.place)}</b> ${esc(x.name)}${x.payout ? ` ${fmt(x.payout)}` : ''}`).join(', ')}</span>`;
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

// The action bar, as PokerNow lays it out: CALL, RAISE, CHECK and FOLD, outlined, each with its key in
// a gap in the top edge, and above them YOUR TURN with ACTIVATE EXTRA TIME. For a seated player it keeps
// its size, so the table never shifts as the turn moves round: on your turn the buttons work; otherwise
// the same places hold pre-clicks while you are in the hand (Call or Call any, Check, Check/Fold or Fold),
// or sit greyed out. RAISE opens a panel over the table with a big slider, the bet sizes and the amount.
const BANK_SECONDS = 30; // each time bank (TIME_BANK_SECONDS on the server)
function slot(cls, label, key, { act = null, pre = null, on = false, preAmount = null } = {}) {
  const live = act || pre;
  const attrs = act ? ` data-act="${act}"` : pre ? ` data-pre="${pre}" aria-pressed="${on}"${preAmount !== null ? ` data-pre-amount="${preAmount}"` : ''}` : ' disabled';
  return `<button type="button" class="act ${cls}${pre ? ' pre' : ''}${on ? ' on' : ''}${live ? '' : ' off'}"${attrs}>${pre ? '<span class="box" aria-hidden="true"></span>' : ''}<span class="al">${label}</span><kbd aria-hidden="true">${key}</kbd></button>`;
}
const idleRow = () => slot('call', 'Call', 'C') + slot('raise', 'Raise', 'R') + slot('check', 'Check', 'K') + slot('fold', 'Fold', 'F');

// YOUR TURN, the seconds left, and extra time from the time bank (T); empty but kept when it is not your turn
function turnRow(s, mine) {
  if (!mine) return '<div class="turn-row" aria-hidden="true"></div>';
  const me = s.seats[s.me.seat];
  const banks = me?.timeBanks || 0;
  const v = VC.voice;
  // on a phone the buttons under the table give way on your turn, so the mute comes along
  const mute = v.on ? `<button type="button" class="btn act-mute ${v.muted ? 'muted' : 'live'}" data-voice="mute" aria-pressed="${v.muted}" title="${v.muted ? 'Unmute' : 'Mute'}">${v.muted ? MIC_OFF : MIC}</button>` : '';
  return `<div class="turn-row">${mute}<span class="yt"><i aria-hidden="true"></i>Your turn <b data-actclock></b></span>${banks ? `<button type="button" class="xt" data-extra title="Use a time bank: ${BANK_SECONDS} more seconds. You have ${banks}.">Extra time <b>+${BANK_SECONDS}s</b><small>${banks} left</small><kbd aria-hidden="true">T</kbd></button>` : ''}</div>`;
}

// the raise panel: what to raise to, the bet sizes, and a big slider
function raisePanel(L) {
  const to = Math.max(L.minTo, Math.min(L.maxTo, app.raiseTo ?? L.minTo));
  app.raiseTo = to;
  return `<div class="raise-panel" role="group" aria-label="${L.isBet ? 'Bet' : 'Raise'}">
    <div class="rp-top"><span class="rp-what">${L.isBet ? 'Bet' : 'Raise to'}</span><input type="number" inputmode="decimal" step="${app.dec ? '0.01' : '1'}" value="${inp(to)}" data-amount aria-label="Amount"></div>
    <div class="rp-sizes">${presetList(L).map((p) => `<button type="button" data-to="${p.to}">${p.label}</button>`).join('')}</div>
    <input type="range" class="big-range" min="${L.minTo}" max="${L.maxTo}" step="1" value="${to}" data-range aria-label="Amount">
    <div class="rp-foot"><button type="button" class="btn ghost" data-raise-back>Back</button><button type="button" class="act raise go" data-act="raise"><span class="al"><span data-raise-label>${raiseLabel(L, to)}</span> <span data-raise-amt>${fmt(to)}</span></span><kbd aria-hidden="true">Enter</kbd></button></div>
  </div>`;
}

// A pre-click is for the betting round it was picked in, and is dropped once it no longer fits.
const preKey = (h) => `${h.number}|${h.street}`;
function firePre(h, L) {
  const pre = app.pre;
  app.pre = null;
  if (!pre || pre.key !== preKey(h)) return false;
  let type = null;
  if (pre.kind === 'checkfold') type = L.canCheck ? 'check' : 'fold';
  else if (pre.kind === 'check') type = L.canCheck ? 'check' : null;
  else if (pre.kind === 'call') type = L.canCheck ? 'check' : L.toCall === pre.amount ? 'call' : null;
  else if (pre.kind === 'callany') type = L.canCheck ? 'check' : 'call';
  if (!type) return false;
  soundMine(type, L);
  emit('action', { type }).then((ack) => { if (!ack.ok) { app.actionKey = null; render(); } });
  return true;
}

function renderActions(s) {
  const h = s.hand;
  const L = h && h.legal;
  const seated = !!(s.me.seated && s.table.status !== 'ended');
  document.body.classList.toggle('bar-fixed', seated);
  document.body.classList.remove('rit-open');
  if (L) {
    const v = VC.voice;
    const bank = s.seats[s.me.seat]?.timeBanks || 0;
    const key = `${h.number}|${h.street}|${L.currentBet}|${L.toCall}|${L.minTo}|${L.maxTo}|${L.canRaise}|${v.on ? (v.muted ? 'm' : 'u') : ''}|${bank}|${app.raiseOpen ? 'R' : ''}`;
    if (key === app.actionKey) return;
    if (!app.raiseOpen && firePre(h, L)) {
      app.actionKey = key;
      $$('.act', els.actions).forEach((b) => { b.disabled = true; });
      return;
    }
    app.actionKey = key;
    const allIn = L.toCall >= L.stack;
    const call = L.canCheck ? slot('call', 'Call', 'C') : slot('call', `${allIn ? 'All in' : 'Call'} <span class="amt">${fmt(L.toCall)}</span>`, 'C', { act: 'call' });
    // one size only: the raise is all in, straight from the button
    const onlyAllIn = L.canRaise && L.minTo >= L.maxTo;
    const raise = !L.canRaise ? slot('raise', L.isBet ? 'Bet' : 'Raise', 'R')
      : onlyAllIn ? slot('raise', `All in <span class="amt">${fmt(L.maxTo)}</span>`, 'R', { act: 'raise' })
        : slot('raise', L.isBet ? 'Bet' : 'Raise', 'R', { act: 'open-raise' });
    if (onlyAllIn) app.raiseTo = L.maxTo;
    els.actions.innerHTML = `${turnRow(s, true)}<div class="act-row">${call}${raise}${slot('check', 'Check', 'K', L.canCheck ? { act: 'check' } : {})}${slot('fold', 'Fold', 'F', { act: 'fold' })}</div>${app.raiseOpen && L.canRaise && !onlyAllIn ? raisePanel(L) : ''}`;
    if (app.raiseOpen) {
      fillRange($('[data-range]', els.actions));
      const a = $('[data-amount]', els.actions);
      if (a && !window.matchMedia('(pointer: coarse)').matches) { a.focus(); a.select(); }
    }
    tick();
    return;
  }
  app.actionKey = null;
  app.raiseOpen = false;
  app.raiseTo = null;
  // The vote stays open while it lasts, so a pick can be changed to meet the others'. What the others
  // picked shows on the buttons themselves: their number gets a faint ring and their name, and the
  // numbers nobody else picked are dimmed, so meeting them is one tap.
  if (h && h.rit && h.rit.canChoose) {
    const mine = h.rit.myChoice;
    const others = (h.rit.picks || []).filter((x) => x.seat !== s.me.seat);
    const nameOf = (x) => s.seats[x.seat]?.name || `Seat ${x.seat + 1}`;
    const by = new Map();
    for (const x of others) if (typeof x.pick === 'number') by.set(x.pick, [...(by.get(x.pick) || []), nameOf(x)]);
    const waiting = others.filter((x) => x.pick === null).map(nameOf);
    const any = others.filter((x) => x.pick === 'any').map(nameOf);
    const notes = [];
    if (by.size === 1) {
      const [k] = [...by.keys()];
      if (mine !== k) notes.push(`${[...by.values()][0].join(' and ')} picked ${TIMES[k]}: pick the same to run it ${TIMES[k]}.`);
    } else if (by.size > 1) notes.push('The picks differ: settle on one number.');
    if (any.length) notes.push(`${any.join(' and ')} ${any.length === 1 ? 'goes' : 'go'} with any number.`);
    if (waiting.length) notes.push(`Waiting for ${waiting.join(' and ')}.`);
    const buttons = Array.from({ length: h.rit.max }, (_, i) => {
      const k = i + 1;
      const names = by.get(k) || [];
      const dim = by.size > 0 && k > 1 && !names.length && mine !== k;
      return `<button class="act ${k === 1 ? 'call' : 'raise'}${mine === k ? ' on' : ''}${names.length ? ' theirs' : ''}${dim ? ' dim' : ''}" data-run="${k}" aria-pressed="${mine === k}"${names.length ? ` aria-label="${esc(cap(TIMES[k]))}, picked by ${esc(names.join(' and '))}"` : ''}><span>${cap(TIMES[k])}</span>${names.length ? `<small class="who">${esc(names.join(', '))}</small>` : ''}</button>`;
    }).join('');
    const box = `<div class="rit-box${seated ? ' over' : ''}" role="group" aria-label="Pick how many times to run it"><p>Run it how many times? <span data-ritclock></span><small class="rit-why">It runs more than once only if everyone picks the same number. Picking once settles it, and so does time running out before you agree.</small>${notes.length ? `<small class="rit-picks">${esc(notes.join(' '))}</small>` : ''}</p>${buttons}</div>`;
    // the vote sits over the bar's usual places, which keep their room underneath it
    els.actions.innerHTML = seated ? `${turnRow(s, false)}<div class="act-row ghost" aria-hidden="true">${idleRow()}</div>${box}` : box;
    if (seated) document.body.classList.add('rit-open');
    tick();
    return;
  }
  let status = '';
  if (h && h.phase !== 'done') {
    if (h.phase === 'rit') {
      status = 'The players in the hand are picking how many times to run it: everyone has to pick the same number, or it runs once. <span data-ritclock></span>';
    } else if (h.actorSeat !== null && h.actorSeat !== undefined) {
      const a = s.seats[h.actorSeat];
      if (a && a.userId !== s.me.userId) status = `Waiting for ${esc(a.name)}`;
    }
  }
  if (!seated) {
    app.pre = null;
    els.actions.innerHTML = status ? `<div class="status-line">${status}</div>` : '';
    if (status) tick();
    return;
  }
  const mine = h && h.players.find((p) => p.id === s.me.userId);
  const live = !!(h && h.phase === 'betting' && mine && !mine.folded && !mine.allIn);
  // once the hand is over, the places hold the panel to show your cards
  const away = s.me.sittingOut || s.me.sitOutNext;
  const backRow = '<div class="act-row"><button type="button" class="act back-big" data-my="back">I’m back</button></div>';
  const panel = h && h.canShow ? showPanel(s) : '';
  if (panel) {
    app.pre = null;
    els.actions.innerHTML = `${turnRow(s, false)}<div class="act-row ghost" aria-hidden="true">${idleRow()}</div>${panel}`;
    return;
  }
  // away, and out of the hand: one big I'm back, as on PokerNow
  if (away && !live && !(mine && !mine.folded && h && h.phase !== 'done')) {
    app.pre = null;
    els.actions.innerHTML = `${turnRow(s, false)}${status ? `<div class="ghost-note">${status}</div>` : ''}${backRow}`;
    if (status) tick();
    return;
  }
  let row = idleRow();
  if (live) {
    const toCall = Math.max(0, Math.min((h.currentBet || 0) - (mine.bet || 0), mine.stack));
    const pre = app.pre;
    if (pre && (pre.key !== preKey(h) || (pre.kind === 'check' && toCall > 0) || (pre.kind === 'call' && toCall !== pre.amount))) app.pre = null;
    const on = (k) => !!(app.pre && app.pre.kind === k);
    row = (toCall > 0 ? slot('call', `Call <span class="amt">${fmt(toCall)}</span>`, 'C', { pre: 'call', on: on('call'), preAmount: toCall }) : slot('call', 'Call any', 'C', { pre: 'callany', on: on('callany') }))
      + slot('raise', 'Raise', 'R')
      + (toCall > 0 ? slot('check', 'Check', 'K') : slot('check', 'Check', 'K', { pre: 'check', on: on('check') }))
      + slot('fold', toCall > 0 ? 'Fold' : 'Check/<wbr>Fold', 'F', { pre: 'checkfold', on: on('checkfold') });
  } else app.pre = null;
  els.actions.innerHTML = `${turnRow(s, false)}${status ? `<div class="ghost-note">${status}</div>` : ''}<div class="act-row${live ? ' pre-row' : ''}">${row}</div>`;
  if (status) tick();
}

// After the hand, as on PokerNow: one green panel to show all your cards (S) or one at a time (1 to 5)
const pipSVG = (su) => `<svg class="sp-su" aria-hidden="true" focusable="false"><use href="#su-${su}"/></svg>`;
function showPanel(s) {
  const mine = s.hand.players.find((p) => p.id === s.me.userId);
  const hole = mine?.hole || [];
  const shown = new Set(mine?.showIdx || []);
  const left = hole.filter((c, i) => c && !shown.has(i)).length;
  if (!left) return '';
  const one = (c, i) => (!c || shown.has(i)
    ? `<span class="sp-one done${c ? ` s-${c[1]}` : ''}" title="Shown">${c ? `${esc(rankLabel(c))}${pipSVG(c[1])}` : ''}</span>`
    : `<button type="button" class="sp-one s-${c[1]}" data-show="${i}" title="Show this card" aria-label="Show ${esc(rankLabel(c))}${esc(SUIT[c[1]])}">${esc(rankLabel(c))}${pipSVG(c[1])}<kbd aria-hidden="true">${i + 1}</kbd></button>`);
  // away: I'm back, big, on top of the panel, so it is the first thing seen after the hand
  const back = s.me.sittingOut || s.me.sitOutNext ? '<button type="button" class="act back-big sp-back" data-my="back">I’m back</button>' : '';
  return `<div class="show-panel n${hole.length}${back ? ' with-back' : ''}" role="group" aria-label="Show your cards">${back}<button type="button" class="sp-all" data-show="all">${left === hole.length ? 'Show all<span class="sp-x"> cards</span>' : 'Show the rest'}<kbd aria-hidden="true">S</kbd></button><div class="sp-row">${hole.map(one).join('')}</div></div>`;
}

// picking a pre-click, or picking it again to take it back
function togglePre(btn) {
  const h = app.state && app.state.hand;
  if (!h) return;
  const kind = btn.dataset.pre;
  const amount = btn.dataset.preAmount ? Number(btn.dataset.preAmount) : null;
  const same = app.pre && app.pre.kind === kind && app.pre.amount === amount;
  app.pre = same ? null : { kind, amount, key: preKey(h) };
  renderActions(app.state);
}

// the raise panel opens from RAISE (or R), closes with Back (or Escape) and after acting
function openRaise() {
  const L = app.state?.hand?.legal;
  if (!L || !L.canRaise) return;
  if (L.minTo >= L.maxTo) return act('raise');
  app.raiseOpen = true;
  app.actionKey = null;
  renderActions(app.state);
}
function closeRaise() {
  if (!app.raiseOpen) return;
  app.raiseOpen = false;
  app.actionKey = null;
  renderActions(app.state);
}

const cap = (t) => t[0].toUpperCase() + t.slice(1);
// a pick in the run-it vote, as shown on a seat
function pickWord(x) {
  return x === 'any' ? 'goes with the others' : TIMES[x];
}

function raiseLabel(L, to) {
  if (to >= L.allInTo) return 'All-in';
  return L.isBet ? 'Bet' : 'Raise to';
}

// the slider's track is green up to the amount
function fillRange(range) {
  if (!range) return;
  const lo = Number(range.min), hi = Number(range.max);
  range.style.setProperty('--fill', `${hi > lo ? ((Number(range.value) - lo) / (hi - lo)) * 100 : 100}%`);
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
  fillRange(range);
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
  soundMine(payload.type, L, payload.to);
  const ack = await emit('action', payload);
  if (ack.ok) { app.raiseOpen = false; return; }
  buttons.forEach((b) => { b.disabled = false; });
  app.actionKey = null;
  render();
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
    ac.textContent = `${Math.max(0, Math.ceil(left / 1000))}s${h.turn.usingBank ? ' with extra time' : ''}`;
    ac.classList.toggle('low', left < 8000);
    // a nudge when half of your clock has gone, and a second when only a fifth is left (each time
    // bank's clock gets its own two)
    const total = h.turn.total || 0;
    const key = `${h.number}|${h.turn.deadline}`;
    if (total >= 5000 && left > 0) {
      if (app.hurried?.key !== key) app.hurried = { key, half: false, late: false };
      const hu = app.hurried;
      if (left <= total * 0.2 && !hu.late) { hu.late = hu.half = true; if (prefs.sound) playSound('hurry2'); }
      else if (left <= total * 0.5 && !hu.half) { hu.half = true; if (prefs.sound) playSound('hurry'); }
    }
  }
  for (const rc of document.querySelectorAll('[data-ritclock]')) {
    if (h && h.ritDeadline) rc.textContent = `${Math.max(0, Math.ceil((h.ritDeadline - t) / 1000))}s left`;
  }
  for (const el of document.querySelectorAll('[data-away-since]')) el.textContent = clock(Math.max(1000, t - Number(el.dataset.awaySince)));
  for (const el of document.querySelectorAll('[data-leave-at]')) {
    const left = Number(el.dataset.leaveAt) - t;
    el.textContent = left > 0 ? clock(left) : '0:00';
  }
  for (const el of document.querySelectorAll('[data-level-ends]')) {
    const left = Number(el.dataset.levelEnds) - t;
    el.textContent = left > 0 ? clock(left) : 'next hand';
    el.closest('.tour')?.classList.toggle('low', left < 60000);
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
  if (e.kind === 'chat') {
    const mine = !!e.userId && e.userId === myId();
    const at = e.at ? new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    return `<div class="e k-chat ${e.spectator ? 'spec' : ''} ${mine ? 'mine' : ''}"><b>${esc(mine ? 'You' : e.name)}</b>${at ? `<time>${at}</time>` : ''} <span class="msg">${esc(e.text)}</span></div>`;
  }
  let text = e.text;
  const m = /^-- starting hand #(\d+) \((.+?)\) \(dealer: (.+)\) --$/.exec(text);
  if (m) text = `Hand #${m[1]}, ${m[2].replace('BOMB POT, ', 'bomb pot, ').replace('DOUBLE BOARD, ', 'double board, ')}, dealer ${m[3]}`;
  const kinds = String(e.kind).split(' ').map((k) => 'k-' + k.replace(/[^a-z-]/g, '')).join(' ');
  return `<div class="e ${kinds}">${suitText(esc(text))}</div>`;
}

function logFilter(e) { return app.logOnlyChat ? e.kind === 'chat' : true; }

function renderLog() {
  const shown = app.logs.filter(logFilter);
  els.log.innerHTML = shown.length || !app.logOnlyChat ? shown.map(entryHTML).join('') : '<p class="chat-empty">No messages yet. Say something to the table below.</p>';
  els.log.scrollTop = els.log.scrollHeight;
}

const myId = () => app.state?.me?.userId || app.me?.id;

// ---------- the chat bottom left, on a wide screen ----------
const WIDE_CHAT = window.matchMedia('(min-width: 1100px) and (min-height: 600px)');
const wideChat = () => WIDE_CHAT.matches;
function chatMode() {
  const wide = wideChat();
  document.body.classList.toggle('pn', wide);
  // the side panel: the log on a wide screen (shut until opened), the chat and log when narrower
  const pref = localStorage.getItem(wide ? 'fd:logpanel' : 'fd:chatpanel');
  els.drawer.classList.toggle('collapsed', wide ? pref !== 'open' : pref === 'closed' || (pref === null && window.innerWidth < 900));
  app.logOnlyChat = wide ? false : localStorage.getItem('fd:logtab') !== 'log';
  $$('[data-logfilter]').forEach((b) => b.classList.toggle('on', (b.dataset.logfilter === 'chat') === app.logOnlyChat));
  els.log.classList.toggle('chat-view', app.logOnlyChat);
  if (wide) { app.unread = 0; paintUnread(); }
  renderLog();
  renderPnChat();
}
function toggleLog() {
  els.drawer.classList.toggle('collapsed');
  const shut = els.drawer.classList.contains('collapsed');
  localStorage.setItem(wideChat() ? 'fd:logpanel' : 'fd:chatpanel', shut ? 'closed' : 'open');
  if (!shut) { app.unread = 0; paintUnread(); els.log.scrollTop = els.log.scrollHeight; }
  resize();
  render();
}
const pnLine = (e) => {
  const mine = !!e.userId && e.userId === myId();
  return `<div class="pm${mine ? ' mine' : ''}${e.spectator ? ' spec' : ''}"><b>${esc(mine ? 'You' : e.name)}</b> <span>${esc(e.text)}</span></div>`;
};
const PN_EMPTY = '<p class="pn-empty">It’s a bit quiet here.<br>Click on the balloon and send a message!</p>';
function renderPnChat() {
  if (!els.pnmsgs) return;
  const msgs = (app.logs || []).filter((e) => e.kind === 'chat').slice(-120);
  els.pnmsgs.innerHTML = msgs.length ? msgs.map(pnLine).join('') : PN_EMPTY;
  els.pnmsgs.scrollTop = els.pnmsgs.scrollHeight;
}
function appendPn(entries) {
  const msgs = entries.filter((e) => e.kind === 'chat');
  if (!msgs.length || !els.pnmsgs) return;
  const near = els.pnmsgs.scrollHeight - els.pnmsgs.scrollTop - els.pnmsgs.clientHeight < 60;
  if (els.pnmsgs.querySelector('.pn-empty')) els.pnmsgs.innerHTML = '';
  els.pnmsgs.insertAdjacentHTML('beforeend', msgs.map(pnLine).join(''));
  if (near || msgs.some((e) => e.userId === myId())) els.pnmsgs.scrollTop = els.pnmsgs.scrollHeight;
}
function openPnInput() {
  els.pnform.hidden = false;
  els.pnbox.classList.add('typing');
  els.pninput.focus();
}
function closePnInput() {
  els.pnform.hidden = true;
  els.pnbox.classList.remove('typing');
}
function bindPnChat() {
  $('#pnballoon').addEventListener('click', () => (els.pnform.hidden ? openPnInput() : els.pninput.focus()));
  els.pnmore.addEventListener('click', () => {
    const tall = els.pnbox.classList.toggle('tall');
    els.pnmore.setAttribute('aria-expanded', String(tall));
    els.pnmore.setAttribute('aria-label', tall ? 'Show less of the chat' : 'Show more of the chat');
    els.pnmsgs.scrollTop = els.pnmsgs.scrollHeight;
  });
  els.pnform.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = els.pninput.value.trim();
    if (!text) return closePnInput();
    const ack = await emit('chat', { text });
    if (ack.ok) els.pninput.value = '';
  });
  els.pninput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); els.pninput.value = ''; closePnInput(); els.pninput.blur(); } });
  els.pninput.addEventListener('blur', () => { setTimeout(() => { if (!els.pninput.value.trim() && document.activeElement !== els.pninput) closePnInput(); }, 150); });
}

// unread chat from the others, on the Chat button and the phone's chat button, while the chat is shut
function paintUnread() {
  const n = app.unread || 0;
  const label = n > 9 ? '9+' : String(n);
  for (const el of document.querySelectorAll('.unread')) { el.hidden = !n; el.textContent = label; }
  if (els.chatfab) els.chatfab.setAttribute('aria-label', n ? `Chat, ${n} new` : 'Chat');
}

// On a phone the chat opens from the bottom; when the keyboard comes up it keeps the box above it.
function keepAboveKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const fit = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', `${Math.round(kb)}px`);
    document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}

function appendLog(entries) {
  if (app.logOnlyChat && entries.some((e) => e.kind === 'chat') && els.log.querySelector('.chat-empty')) els.log.innerHTML = '';
  const nearBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 80;
  els.log.insertAdjacentHTML('beforeend', entries.filter(logFilter).map(entryHTML).join(''));
  while (els.log.childElementCount > 900) els.log.firstElementChild.remove();
  if (nearBottom) els.log.scrollTop = els.log.scrollHeight;
}

// ---------- sound ----------
// ---------- events ----------
function bindEvents() {
  document.addEventListener('click', async (e) => {
    const sit = e.target.closest('[data-sit]');
    if (sit) return D.seatDialog(Number(sit.dataset.sit));
    const vb = e.target.closest('[data-voice]');
    if (vb) { const k = vb.dataset.voice; return k === 'join' ? VC.joinVoice() : k === 'mute' ? VC.toggleMute() : VC.leaveVoice(); }
    const my = e.target.closest('[data-my]');
    if (my) {
      const k = my.dataset.my;
      if (k === 'sitout') emit('sitout', { value: true });
      else if (k === 'back') emit('sitout', { value: false });
      else if (k === 'chips') D.chipsDialog();
      else if (k === 'rebuy') D.rebuyNow();
      else if (k === 'stand') D.standDialog();
      else if (k === 'call30') emit('call30');
      else if (k === 'straddle') emit('straddle', { value: !app.state.me.straddle });
      else if (k === 'stay') emit('call30:cancel');
      else if (k === 'show') emit('show', {});
      else if (k === 'cancel') emit('seat:cancel');
      return;
    }
    if (e.target.closest('[data-sound]')) {
      const on = !soundOn();
      savePrefs({ sound: on, tableSounds: on });
      return render();
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
      if (k === 'log') return toggleLog();
      if (k === 'clock') return D.hostDialog({ tab: 'time' });
      ({ options: D.hostDialog, ledger: D.ledgerDialog, stats: S.statsDialog, hands: D.handsDialog, look: D.lookDialog, fair: D.fairDialog, requests: D.requestsDialog, menu: D.menuDialog, hud: S.hudPanel })[k]?.();
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
    if (a && els.actions.contains(a)) return a.dataset.act === 'open-raise' ? openRaise() : act(a.dataset.act);
    if (e.target.closest('[data-raise-back]')) return closeRaise();
    const xt = e.target.closest('[data-extra]');
    if (xt) { xt.disabled = true; return emit('timebank'); }
    const pre = e.target.closest('[data-pre]');
    if (pre && els.actions.contains(pre)) return togglePre(pre);
    const pr = e.target.closest('[data-to]');
    if (pr && els.actions.contains(pr)) return setRaise(Number(pr.dataset.to));
    const sc = e.target.closest('[data-show-card]');
    if (sc && !sc.classList.contains('sent')) {
      sc.classList.add('sent');
      return emit('show', { cards: [Number(sc.dataset.showCard)] });
    }
    const sh = e.target.closest('[data-show]');
    if (sh && (els.mybar.contains(sh) || els.actions.contains(sh))) {
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
      try { localStorage.setItem('fd:logtab', app.logOnlyChat ? 'chat' : 'log'); } catch { /* storage blocked */ }
      els.log.classList.toggle('chat-view', app.logOnlyChat);
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
        if (range) { range.value = app.raiseTo; fillRange(range); }
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
      if (e.key === 'Escape') { e.preventDefault(); closeRaise(); }
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && L) {
        e.preventDefault();
        setRaise((app.raiseTo ?? L.minTo) + (e.key === 'ArrowUp' ? 1 : -1) * L.bigBlind);
      }
      return;
    }
    // on the slider or a bet size in the raise panel, Enter raises and Escape closes it, as in the amount
    if (e.target.closest && e.target.closest('.raise-panel')) {
      if (e.key === 'Escape') { e.preventDefault(); closeRaise(); return; }
      if (e.key === 'Enter' && e.target.matches('[data-range]')) { e.preventDefault(); act('raise'); return; }
    }
    if (e.target.closest && e.target.closest('input, textarea, select, .hud-pop')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (wideChat() && (k === 'm' || k === 'l')) { e.preventDefault(); if (k === 'm') openPnInput(); else toggleLog(); return; }
    const sp = $('.show-panel', els.actions);
    if (sp && (k === 's' || /^[1-5]$/.test(k))) {
      const b = $(k === 's' ? '[data-show="all"]' : `[data-show="${Number(k) - 1}"]`, sp);
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
      return;
    }
    if (!L) return;
    if (k === 'escape') return closeRaise();
    if (k === 'f') act('fold');
    else if (k === 'c' && !L.canCheck) act('call');
    else if (k === 'k' && L.canCheck) act('check');
    else if (k === 'c' && L.canCheck) act('check');
    else if (k === 't') { const xt = $('[data-extra]', els.actions); if (xt) { xt.disabled = true; emit('timebank'); } }
    else if (k === 'r' && L.canRaise) {
      const amount = $('[data-amount]', els.actions);
      if (amount) { amount.focus(); amount.select(); } else openRaise();
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
