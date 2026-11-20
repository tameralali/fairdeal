// Live stats at the table: the numbers on each seat, the stats table, each player's sheet (money,
// stats and biggest hands) and the hand replayer.
import { esc, dialog } from './ui.js';
import { prefs } from './cards.js';
import { app, emit, fmt, fmtC, gameShort, gameName } from './table-core.js';
import { historyDialog } from './hand-history.js';
import { fmtMoney } from '/shared/money.js';
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
      ${statsTable(st, { me: app.state.me.userId, fmt: (a) => fmtMoney(a, st.decimals ?? app.dec, 'always', '') })}
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
        <div><h4>Losses</h4>${losses.length ? `<ol class="hand-links" data-losses>${top(losses, 'neg')}</ol>` : '<p class="muted">None yet.</p>'}</div>
      </div>`);
  };
  dlg.el.addEventListener('click', (e) => {
    const sc = e.target.closest('[data-scope] button');
    if (sc) { scope = sc.dataset.v; game = 'all'; draw(); return; }
    const g = e.target.closest('[data-game] button');
    if (g) { game = g.dataset.v; draw(); return; }
    const rp = e.target.closest('[data-replay]');
    if (rp) historyDialog({ start: Number(rp.dataset.replay), sort: rp.closest('[data-losses]') ? 'lost' : 'won', who: userId });
  });
  draw();
}

// ---------- replayer ----------
// The replayer lives in the hand history now: the list of hands beside it, Next running on into the
// following hand. Kept under this name for the links that open a hand.
export function replayDialog(n, opts = {}) {
  return historyDialog({ start: n, ...opts });
}
