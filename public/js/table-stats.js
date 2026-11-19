// Live stats at the table: the numbers on each seat, the stats table, each player's sheet (money,
// stats and biggest hands) and the hand replayer.
import { esc, dialog } from './ui.js';
import { cardHTML, backHTML, slotHTML, prefs } from './cards.js';
import { app, emit, fmt, fmtC, gameShort, gameName } from './table-core.js';
import { buildReplay, canReplay } from '/shared/replay.js';
import { fmtMoney } from '/shared/money.js';
import { boardName } from './game-form.js';
import { STATS, pct, afText, val, tip, signedMoney, gameSeg, statsTable, glossaryHTML } from './stats-view.js';

export { afText };

const money = (n) => signedMoney(fmtC, n);
const sign = (n) => `${n > 0 ? '+' : ''}${fmtC(n)}`;

// ---------- the numbers on each seat ----------
// VPIP / PFR / AF for the game being played, with the hands behind them.
export function hudHTML(s, userId) {
  const mode = prefs.hud || 'game';
  if (mode === 'off' || !s.hud) return '';
  const src = mode === 'all' && s.hud.all ? s.hud.all : s.hud.table;
  const r = src && src[userId];
  if (!r || !r.hands) return '';
  const title = `${gameShort(s.hud.game)}, ${mode === 'all' && s.hud.all ? 'all games' : 'this game'}: VPIP ${pct(r.vpip)}%, PFR ${pct(r.pfr)}%, aggression ${afText(r)}, over ${r.hands} hand${r.hands === 1 ? '' : 's'}. Open for every stat.`;
  return `<button type="button" class="hud" data-stats="${esc(userId)}" title="${esc(title)}" aria-label="${esc(title)}"><span>${pct(r.vpip)}</span><i>/</i><span>${pct(r.pfr)}</span><i>/</i><span>${afText(r)}</span><small>${r.hands}</small></button>`;
}

// ---------- stats table ----------
const statsCache = new Map();
async function loadStats(scope, game) {
  const key = `${scope}|${game}|${app.state?.table.hands}`;
  if (statsCache.has(key)) return statsCache.get(key);
  const r = await emit('stats:get', { scope, game });
  if (!r.ok) return null;
  statsCache.set(key, r.stats);
  return r.stats;
}

export async function statsDialog() {
  const t = app.state.table;
  let scope = 'game';
  let game = 'all';
  const dlg = dialog({ title: 'Stats', className: 'wide stats-dlg', body: '<p class="muted">Loading…</p>' });
  const draw = async () => {
    const st = await loadStats(scope, game);
    if (!st) return;
    dlg.setBody(`
      <div class="stats-bar">
        ${t.clubId ? `<div class="seg" data-scope role="group" aria-label="Which hands"><button type="button" data-v="game" class="${scope === 'game' ? 'on' : ''}">This game</button><button type="button" data-v="all" class="${scope === 'all' ? 'on' : ''}">All games in the club</button></div>` : ''}
        ${st.games.length > 1 || game !== 'all' ? gameSeg(st.games, game) : ''}
        <span class="muted">${st.hands} hand${st.hands === 1 ? '' : 's'}</span>
      </div>
      ${statsTable(st, { me: app.state.me.userId, fmt: (a) => fmtMoney(a, st.decimals ?? app.dec, 'always') })}
      <p class="hint">Pick a player for their money, every stat and their biggest hands.</p>
      ${glossaryHTML()}`);
  };
  dlg.el.addEventListener('click', (e) => {
    const sc = e.target.closest('[data-scope] button');
    if (sc) { scope = sc.dataset.v; draw(); return; }
    const g = e.target.closest('[data-game] button');
    if (g) { game = g.dataset.v; draw(); return; }
    const row = e.target.closest('[data-player-sheet]');
    if (row) playerSheet(row.dataset.playerSheet);
  });
  dlg.el.addEventListener('keydown', (e) => {
    const row = e.target.closest('[data-player-sheet]');
    if (row && e.key === 'Enter') playerSheet(row.dataset.playerSheet);
  });
  draw();
}

// ---------- one player: money, stats, biggest hands ----------
export async function playerSheet(userId) {
  const [lr, hr] = await Promise.all([emit('ledger:get'), emit('hands:list')]);
  if (!lr.ok || !hr.ok) return;
  const row = lr.ledger.rows.find((x) => x.userId === userId);
  const hands = hr.hands.filter((h) => h.nets[userId] !== undefined);
  let game = 'all';
  let scope = 'game';
  const first = await loadStats('game', 'all');
  const name = row?.name || first?.players.find((p) => p.userId === userId)?.name || 'Player';
  const dlg = dialog({ title: name, className: 'wide', body: '<p class="muted">Loading…</p>' });
  const top = (list, k) => list.slice(0, 5).map((h) => `<li><button type="button" class="hand-link" data-replay="${h.handNumber}">
      <span class="num">#${h.handNumber}</span><span>${esc(gameShort(h.gameType))}${h.isBomb ? ' bomb' : ''}</span><span class="grow"></span><span class="n ${k}">${sign(h.nets[userId])}</span><span class="go">Replay</span></button></li>`).join('');
  const draw = async () => {
    const st = await loadStats(scope, game);
    const r = st?.players.find((p) => p.userId === userId);
    const games = (scope === 'all' ? st?.games : first?.games) || [];
    const mine = game === 'all' ? hands : hands.filter((h) => h.gameType === game);
    const wins = mine.filter((h) => h.nets[userId] > 0).sort((a, b) => b.nets[userId] - a.nets[userId]);
    const losses = mine.filter((h) => h.nets[userId] < 0).sort((a, b) => a.nets[userId] - b.nets[userId]);
    dlg.setBody(`
      <div class="ps-money">
        <div><small>Buy-ins</small><b>${row ? fmtC(row.buyIn) : '-'}</b></div>
        <div><small>Cash-outs</small><b>${row ? fmtC(row.buyOut) : '-'}</b></div>
        <div><small>${row?.seated ? 'Stack now' : 'Stack'}</small><b>${row?.seated ? fmtC(row.stack) : '-'}</b></div>
        <div><small>Net this game</small><b>${row ? money(row.net) : '-'}</b></div>
        <div><small>Hands played</small><b>${hands.length}</b></div>
      </div>
      <div class="stats-bar">
        ${app.state.table.clubId ? `<div class="seg" data-scope role="group" aria-label="Which hands"><button type="button" data-v="game" class="${scope === 'game' ? 'on' : ''}">This game</button><button type="button" data-v="all" class="${scope === 'all' ? 'on' : ''}">All games in the club</button></div>` : ''}
        ${games.length > 1 || game !== 'all' ? gameSeg(games, game) : ''}
      </div>
      ${r ? `<div class="ps-grid">
        ${STATS.map((s) => `<div title="${esc(tip(r, s))}"><small>${esc(s.label)}</small><b>${val(r, s)}${s.ratio || val(r, s) === '-' ? '' : '<i>%</i>'}</b><span>${esc(s.name)}</span></div>`).join('')}
        <div><small>Hands</small><b>${r.hands}</b><span>${r.handsWon} won</span></div>
        <div><small>bb/100</small><b>${r.bb100 === null ? '-' : r.bb100.toFixed(1)}</b><span>Big blinds per 100 hands</span></div>
      </div>` : '<p class="muted">No hands in this game type yet.</p>'}
      <h3 class="section-title">${scope === 'all' ? 'Biggest hands in this game' : 'Biggest hands'}</h3>
      <div class="ps-hands">
        <div><h4>Wins</h4>${wins.length ? `<ol class="hand-links">${top(wins, 'pos')}</ol>` : '<p class="muted">None yet.</p>'}</div>
        <div><h4>Losses</h4>${losses.length ? `<ol class="hand-links">${top(losses, 'neg')}</ol>` : '<p class="muted">None yet.</p>'}</div>
      </div>`);
  };
  dlg.el.addEventListener('click', (e) => {
    const sc = e.target.closest('[data-scope] button');
    if (sc) { scope = sc.dataset.v; game = 'all'; draw(); return; }
    const g = e.target.closest('[data-game] button');
    if (g) { game = g.dataset.v; draw(); return; }
    const rp = e.target.closest('[data-replay]');
    if (rp) {
      const order = (e.target.closest('.hand-links') ? [...e.target.closest('.hand-links').querySelectorAll('[data-replay]')] : []).map((b) => Number(b.dataset.replay));
      replayDialog(Number(rp.dataset.replay), { order });
    }
  });
  draw();
}

// ---------- replayer ----------
// order: hand numbers to step through with Previous and Next hand (the list it was opened from).
export async function replayDialog(n, { order = [], onDetails = null } = {}) {
  const dlg = dialog({ title: `Hand #${n}`, className: 'wide replay-dlg', body: '<p class="muted">Loading…</p>' });
  let timer = null;
  let R = null;
  let rec = null;
  let i = 0;
  const stop = () => { clearInterval(timer); timer = null; };
  const load = async (num) => {
    stop();
    n = num;
    dlg.$('h2').textContent = `Hand #${n}`;
    const r = await emit('hand:get', { handNumber: n });
    if (!r.ok) return;
    rec = r.record;
    if (!canReplay(rec)) {
      R = null;
      dlg.setBody(`<p class="muted">This hand was played before hands were recorded action by action, so it cannot be replayed.</p>${nav()}`);
      return;
    }
    R = buildReplay(rec, fmt);
    i = 0;
    draw();
  };
  const nav = () => {
    const pos = order.indexOf(n);
    const prev = pos > 0 ? order[pos - 1] : pos < 0 && n > 1 ? n - 1 : null;
    const next = pos >= 0 && pos < order.length - 1 ? order[pos + 1] : pos < 0 && n < (app.state?.table.hands || 0) ? n + 1 : null;
    return `<div class="rp-nav"><button type="button" class="btn small ghost" data-hand-go="${prev ?? ''}" ${prev ? '' : 'disabled'}>Previous hand</button>
      ${onDetails ? '<button type="button" class="btn small ghost" data-details>Hand details</button>' : ''}
      <button type="button" class="btn small ghost" data-hand-go="${next ?? ''}" ${next ? '' : 'disabled'}>Next hand</button></div>`;
  };
  const draw = () => {
    const step = R.steps[i];
    const last = R.steps.length - 1;
    dlg.setBody(`
      <p class="rp-meta">${esc(gameName(rec.gameType))}${rec.isBomb ? ', bomb pot' : ''}${rec.doubleBoard ? ', double board' : ''}, blinds ${fmt(rec.smallBlind)}/${fmt(rec.bigBlind)}${rec.runCount > 1 ? `, ran ${rec.runCount} times` : ''}</p>
      ${feltHTML(rec, R, step)}
      <div class="rp-step" aria-live="polite"><span class="num">${i + 1}/${last + 1}</span><span>${esc(step.text)}</span></div>
      <div class="rp-controls">
        <button type="button" class="btn small" data-rp="first" ${i ? '' : 'disabled'} aria-label="First step">Start</button>
        <button type="button" class="btn small" data-rp="prev" ${i ? '' : 'disabled'}>Back</button>
        <button type="button" class="btn small primary" data-rp="play">${timer ? 'Pause' : i === last ? 'Play again' : 'Play'}</button>
        <button type="button" class="btn small" data-rp="next" ${i < last ? '' : 'disabled'}>Next</button>
        <button type="button" class="btn small" data-rp="last" ${i < last ? '' : 'disabled'} aria-label="Last step">End</button>
        <input type="range" min="0" max="${last}" value="${i}" data-rp-range aria-label="Step">
      </div>
      ${nav()}`);
  };
  const go = (k) => {
    if (!R) return;
    i = Math.max(0, Math.min(R.steps.length - 1, k));
    if (i === R.steps.length - 1) stop();
    draw();
  };
  dlg.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rp]');
    if (b && R) {
      const k = b.dataset.rp;
      if (k === 'play') {
        if (timer) { stop(); draw(); return; }
        if (i === R.steps.length - 1) i = 0;
        timer = setInterval(() => go(i + 1), 1100);
        go(i + 1);
        return;
      }
      stop();
      go(k === 'first' ? 0 : k === 'prev' ? i - 1 : k === 'next' ? i + 1 : R.steps.length - 1);
    }
    const h = e.target.closest('[data-hand-go]');
    if (h && h.dataset.handGo) load(Number(h.dataset.handGo));
    if (e.target.closest('[data-details]') && onDetails) { stop(); dlg.close(); onDetails(n); }
  });
  dlg.el.addEventListener('input', (e) => { if (e.target.matches('[data-rp-range]')) { stop(); i = Number(e.target.value); draw(); dlg.$('[data-rp-range]')?.focus(); } });
  dlg.el.addEventListener('keydown', (e) => {
    if (!R || e.target.matches('input[type=range]')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); stop(); go(i + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); stop(); go(i - 1); }
    if (e.key === 'Home') { e.preventDefault(); stop(); go(0); }
    if (e.key === 'End') { e.preventDefault(); stop(); go(R.steps.length - 1); }
  });
  dlg.el.addEventListener('close', stop);
  await load(n);
}

// The table at one step: seats around the felt, the boards and the pot in the middle.
function feltHTML(rec, R, step) {
  const ps = step.players;
  const n = ps.length;
  const meIdx = ps.findIndex((p) => p.id === app.state?.me.userId);
  const rot = meIdx >= 0 ? meIdx : 0;
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
    if (p.bet > 0) seats += `<div class="rp-bet" style="left:${bx.toFixed(1)}%;top:${by.toFixed(1)}%"><span class="chip"></span>${fmt(p.bet)}</div>`;
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
  return `<div class="rp-felt" style="--felt:${esc(prefs.felt || app.state?.table.settings.feltColor || '#1d6b48')}">
    <div class="rp-oval"></div>
    <div class="rp-center"><div class="rp-boards b${bpr} k${Math.min(4, shownRuns.size || 1)}">${boards}</div><div class="rp-pot num">Pot ${fmt(step.pot)}</div></div>
    ${seats}
  </div>`;
}
