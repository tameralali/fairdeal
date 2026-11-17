import { api, ensureIdentity } from './api.js';
import { esc, $, $$, toast, clock } from './ui.js';
import { cardHTML, backHTML, slotHTML, prefs, applyPrefs, suitText } from './cards.js';
import { sealSVG } from './seal.js';
import { FairClient } from './fair-client.js';
import { bestHand } from '/shared/evaluator.js';
import { GAME_TYPES } from '/shared/cards.js';
import { app, emit, fmt, inp, parse, gameShort, now } from './table-core.js';
import * as D from './table-dialogs.js';
import { boardName, stepLabel } from './game-form.js';

export const BRAND_HEX = '6f3ac1d0a85c2e94b7f1036d4e5a9c8b21f0e7d6c5b4a39281706f5e4d3c2b1a';
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
  });
  socket.on('toast', (t) => toast(t.text));
  socket.on('request', (r) => {
    chime('request');
    toast(`${r.name} ${r.type === 'seat' ? 'asked for a seat' : 'asked to add chips'} (${r.amount})`);
  });
  socket.on('hands:revealed', ({ through }) => app.fair.onRevealed(through, fetchRecord));
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
function geometry(n, portrait) {
  const P = portrait
    ? { cy: 48.5, px: 39, py: 43, bx: 24, by: 29.5, dx: 30.5, dy: 35.5 }
    : { cy: 47, px: 43.5, py: 40, bx: 29.5, by: 23.5, dx: 36, dy: 29.5 };
  return Array.from({ length: n }, (_, i) => {
    const t = ((90 + (i * 360) / n) * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const td = t + (portrait ? 0.22 : 0.15);
    return {
      x: 50 + P.px * c, y: P.cy + P.py * s,
      bx: 50 + P.bx * c, by: P.cy + P.by * s,
      dx: 50 + P.dx * Math.cos(td), dy: P.cy + P.dy * Math.sin(td),
      upper: s < -0.25,
    };
  });
}

function resize() {
  const w = els.stage.clientWidth;
  const h = els.stage.clientHeight;
  if (!w || !h) return;
  const portrait = w / h < 0.95;
  const aspect = portrait ? 0.74 : 1.72;
  let W = Math.min(w * 0.985, h * 0.985 * aspect);
  let H = W / aspect;
  els.area.style.width = W + 'px';
  els.area.style.height = H + 'px';
  els.area.classList.toggle('portrait', portrait);
  els.area.style.setProperty('--u', (portrait ? W / 64 : W / 100) + 'px');
  if (app.portrait !== portrait) { app.portrait = portrait; render(); }
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
    rot = r.handsLeft > 0 ? `${cur} for ${r.handsLeft} more hand${r.handsLeft === 1 ? '' : 's'}, then ${next}` : `${next} from the next hand`;
  }
  let bomb = '';
  if (t.bombNext) bomb = '<span class="pill brass">Bomb pot next hand</span>';
  else if (st.bombPot.mode === 'every') {
    const left = Math.max(1, st.bombPot.every - t.handsSinceBomb);
    bomb = `<span class="pill soft">Bomb pot ${left === 1 ? 'next hand' : `in ${left} hands`}</span>`;
  } else if (st.bombPot.mode === 'percent') bomb = `<span class="pill soft">Bomb pots ${st.bombPot.percent}%</span>`;
  let status = '';
  if (t.status === 'ended') status = '<span class="pill warn">Game over</span>';
  else if (t.status === 'waiting') status = '<span class="pill soft">Not started</span>';
  else if (t.paused) status = '<span class="pill warn">Paused</span>';
  if (t.endAfterHand) status += '<span class="pill warn">Last hand</span>';
  const ends = t.session && t.session.endsAt;
  const reqs = s.requests ? s.requests.length : 0;
  const f = s.fairness;
  const acct = app.me && !app.me.username ? '<button class="btn ghost small" data-open="account" title="Create an account">Save account</button>' : '';
  els.top.innerHTML = `
    <span class="conn ${app.connected ? '' : 'off'}" title="${app.connected ? 'Connected' : 'Reconnecting'}"></span>
    <a class="wordmark" href="/" title="Lobby">${sealSVG(BRAND_HEX, 26, 'The Aquarium')}<span>The <b>Aquarium</b></span></a>
    <div class="tb-title"><strong>${esc(t.name)}</strong>${t.clubId ? `<a href="/club/${esc(t.clubId)}">${esc(t.clubName || 'Club')}</a>` : ''}</div>
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
      <button class="btn small sm-hide" data-open="hands">Hands</button>
      <button class="btn small sm-hide" data-open="look">Look</button>
      <button class="btn small sm-hide ${els.drawer.classList.contains('collapsed') ? '' : 'primary'}" data-open="log">Log</button>
      <span class="sm-hide">${acct}</span>
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

function renderTable(s) {
  const t = s.table;
  const n = t.settings.maxPlayers;
  const h = s.hand;
  if (h && app.seenHand !== h.number) { app.seenHand = h.number; app.seen = new Set(); }
  const geo = geometry(n, app.portrait);
  const rot = s.me.seat ?? 0;
  const hp = new Map((h?.players || []).map((p) => [p.seat, p]));
  const R = resultInfo(h);
  const myReq = s.me.requests.find((r) => r.type === 'seat');
  const pendingSeats = new Set((s.requests || []).filter((r) => r.type === 'seat').map((r) => r.seat));
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
      let inner = canSit ? `<button class="sit" data-sit="${seat}">Sit here</button>` : `Seat ${seat + 1}`;
      if (mine) inner = 'Waiting for the host';
      else if (pendingSeats.has(seat)) inner = 'Requested';
      seats += `<div class="seat empty ${side} ${mine ? 'reserved' : ''}" style="${pos}"><div class="plate">${inner}</div></div>`;
      continue;
    }
    const p = hp.get(seat);
    const isMe = info.userId === s.me.userId;
    const actor = h && h.phase === 'betting' && h.actorSeat === seat;
    const won = R.won.get(seat);
    const cls = ['seat', side, isMe && 'me', actor && 'actor', p && p.folded && 'folded', !p && (info.sittingOut || info.stack === 0) && 'out', won && 'winner'].filter(Boolean).join(' ');
    let hole = '';
    if (p) {
      if (p.hole && (!p.folded || isMe || p.shown)) {
        const hc = R.handCards.get(seat);
        hole = `<div class="hole faces n${p.hole.length}">${p.hole.map((c, i) => cardHTML(c, `${hc ? (hc.has(c) ? 'win' : 'dim') : ''} ${dealCls(`h${seat}${i}${c}`)}`)).join('')}</div>`;
      } else if (!p.folded) {
        hole = `<div class="hole n${p.holeCount}">${Array.from({ length: p.holeCount }, (_, i) => backHTML(dealCls(`b${seat}${i}`))).join('')}</div>`;
      }
    }
    let tag = '';
    let tagCls = '';
    if (won) { tag = '+' + fmt(won); tagCls = 'win'; }
    else if (p && p.allIn && !p.folded) { tag = 'All-in'; tagCls = 'allin'; }
    else if (p && p.lastAction && h.phase !== 'done') { tag = p.lastAction; tagCls = p.lastAction.toLowerCase().replace(/[^a-z]/g, ''); }
    else if (info.leaving) { tag = 'Leaving'; tagCls = 'out'; }
    else if (!p && info.sittingOut) { tag = info.away ? 'Away' : 'Sitting out'; tagCls = 'out'; }
    else if (!p && info.stack === 0) { tag = 'Out of chips'; tagCls = 'out'; }
    else if (info.sitOutNext) { tag = 'Sitting out next'; tagCls = 'out'; }
    let timer = '';
    if (actor && h.turn) {
      timer = `<div class="timer ${h.turn.usingBank ? 'bank' : ''}"><i data-deadline="${h.turn.deadline}" data-total="${h.turn.total || 30000}"></i></div>`;
    }
    let strength = '';
    if (isMe && prefs.handStrength && p && p.hole && !p.folded) {
      const firstRun = (h.boards || [h.board]).slice(0, h.boardsPerRun || 1);
      if (firstRun[0].length >= 3) {
        const names = firstRun.map((b) => bestHand(p.hole, b, GAME_TYPES[h.gameType].omaha)?.name).filter(Boolean);
        if (names.length) strength = `<div class="strength">${esc(names.join(' / '))}</div>`;
      }
    }
    const stack = p ? p.stack : info.stack;
    seats += `<div class="${cls}" style="${pos}" ${s.me.isHost && !isMe ? `data-player="${esc(info.userId)}" title="Host actions for ${esc(info.name)}"` : ''}>
      ${hole}
      <div class="plate">
        ${timer}
        <div class="nm">${info.connected ? '' : '<span class="dot" title="Disconnected"></span>'}<span>${esc(info.name)}</span>${info.isHost ? '<span class="host-mark" title="Host">&#9733;</span>' : ''}</div>
        <div class="st">${fmt(stack)}${info.pendingChips ? ` <small class="muted">+${fmt(info.pendingChips)}</small>` : ''}</div>
        ${tag ? `<div class="tag ${tagCls}">${esc(tag)}</div>` : ''}
      </div>
      ${strength}
    </div>`;
    if (p && p.bet > 0) chips += `<div class="bet" style="left:${g.bx.toFixed(2)}%;top:${g.by.toFixed(2)}%"><span class="chip"></span>${fmt(p.bet)}</div>`;
  }
  if (h && h.buttonSeat !== null && h.buttonSeat !== undefined && h.buttonSeat < n) {
    const g = geo[(h.buttonSeat - rot + n) % n];
    chips += `<div class="dealer" style="left:${g.dx.toFixed(2)}%;top:${g.dy.toFixed(2)}%" title="Dealer">D</div>`;
  }
  els.seats.innerHTML = seats;
  els.chips.innerHTML = chips;
  els.center.innerHTML = centerHTML(s, R);
}

function centerHTML(s, R) {
  const h = s.hand;
  const t = s.table;
  if (!h) return waitingHTML(s);
  const boards = h.boards || [h.board];
  const bpr = h.boardsPerRun || 1;
  const runs = Math.max(1, Math.round(boards.length / bpr));
  // On a phone held upright, a double board with one run is stacked: board 1 above board 2.
  const stacked = app.portrait && bpr > 1 && runs === 1;
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
  if (h.phase === 'done' && h.results) {
    below = `<div class="results">${resultLines(h).map((l) => `<div>${l}</div>`).join('')}</div>`;
    if (t.waiting && t.waiting !== 'Waiting for players') below += `<div class="waiting"><small>${esc(t.waiting)}</small></div>`;
  } else {
    below = `<div class="pot"><span>Pot ${fmt(h.potTotal)}</span></div>`;
    if (h.phase === 'rit') {
      const voted = h.rit ? h.rit.chosenSeats.length : 0;
      const of = h.rit ? h.rit.eligibleSeats.length : 0;
      below += `<div class="rit-note">All in. Voting on how many times to run it: ${voted} of ${of} voted, <span data-ritclock></span></div>`;
    } else if (h.rit && h.rit.result > 1) below += `<div class="rit-note">Running it ${TIMES[h.rit.result]}</div>`;
  }
  const bombWhy = h.bombReason === 'manual' ? 'called by the host' : h.bombReason === 'every' ? 'scheduled' : h.bombReason === 'percent' ? 'random' : '';
  return `<div class="meta">${h.isBomb ? `<span class="bomb" title="${esc(bombWhy)}">Bomb pot</span>` : ''}<span>${esc(gameShort(h.gameType))} hand ${h.number}</span></div>
    <div class="boards k${Math.min(runs, 4)} b${bpr}${stacked ? ' stacked' : ''}" style="grid-template-columns:${cols}">${grid}</div>${below}`;
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
    if (s.hand && s.hand.canShow) my += '<button class="btn" data-my="show">Show my cards</button>';
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
      else if (k === 'show') emit('show');
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
      ({ options: D.hostDialog, ledger: D.ledgerDialog, hands: D.handsDialog, look: D.lookDialog, fair: D.fairDialog, requests: D.requestsDialog, account: D.accountFromTable, menu: D.menuDialog })[k]?.();
      return;
    }
    const player = e.target.closest('[data-player]');
    if (player) return D.playerDialog(player.dataset.player);
    const a = e.target.closest('[data-act]');
    if (a && els.actions.contains(a)) return act(a.dataset.act);
    const pr = e.target.closest('[data-to]');
    if (pr && els.actions.contains(pr)) return setRaise(Number(pr.dataset.to));
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
