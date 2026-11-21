// Live stats at the table: the numbers on each seat, the stats table, each player's sheet (money,
// stats and biggest hands) and the hand replayer.
import { esc, dialog, avatarHTML } from './ui.js';
import { prefs, savePrefs } from './cards.js';
import { app, emit, fmt, fmtC, gameShort, gameName } from './table-core.js';
import { historyDialog } from './hand-history.js';
import { fmtMoney } from '/shared/money.js';
import { STATS, pct, afText, val, tip, signedMoney, gameSeg, statsTable, glossaryHTML } from './stats-view.js';

export { afText };

const money = (n) => signedMoney(fmtC, n);
const sign = (n) => `${n > 0 ? '+' : ''}${fmtC(n)}`;

// ---------- the numbers on each seat (the HUD) ----------
// VPIP / PFR / AF for the game being played, with the hands behind them. The HUD is on unless it is
// switched off (prefs.hud 'off'), and each player's numbers can be switched off on their own
// (prefs.hudHide), from the HUD panel or from the player's sheet. Only this browser's view changes.
export const hudOn = () => (prefs.hud || 'game') !== 'off';
export const hudHidden = (userId) => (prefs.hudHide || []).includes(userId);
export function setHudFor(userId, show) {
  const hide = new Set(prefs.hudHide || []);
  if (show) hide.delete(userId);
  else hide.add(userId);
  savePrefs({ hudHide: [...hide] });
}
function setHudOn(on) {
  if (on) savePrefs({ hud: prefs.hudScope || 'game' });
  else savePrefs({ hud: 'off', hudScope: prefs.hud && prefs.hud !== 'off' ? prefs.hud : prefs.hudScope || 'game' });
}
const hudLine = (r) => `${pct(r.vpip)} / ${pct(r.pfr)} / ${afText(r)}`;

export function hudHTML(s, userId) {
  const mode = prefs.hud || 'game';
  if (mode === 'off' || !s.hud || hudHidden(userId)) return '';
  const src = mode === 'all' && s.hud.all ? s.hud.all : s.hud.table;
  const r = src && src[userId];
  if (!r || !r.hands) return '';
  const title = `${gameShort(s.hud.game)}, ${mode === 'all' && s.hud.all ? 'all games' : 'this game'}: VPIP ${pct(r.vpip)}%, PFR ${pct(r.pfr)}%, aggression ${afText(r)}, over ${r.hands} hand${r.hands === 1 ? '' : 's'}. Open for every stat.`;
  return `<button type="button" class="hud" data-stats="${esc(userId)}" title="${esc(title)}" aria-label="${esc(title)}"><span>${pct(r.vpip)}</span><i>/</i><span>${pct(r.pfr)}</span><i>/</i><span>${afText(r)}</span><small>${r.hands}</small></button>`;
}

// The HUD panel, from the HUD button (beside the sound button on a wide screen, in the top bar or Menu
// otherwise): the HUD on or off, which hands its numbers come from, and a switch for each player at
// the table. It stays open while the table moves on and updates with it.
let hp = null;
const hudAnchor = () => [...document.querySelectorAll('[data-open="hud"]')].find((b) => b.offsetParent && b.getBoundingClientRect().width);

function hudPlayers(s) {
  const me = s.me.userId;
  const list = (s.seats || []).filter(Boolean);
  const at = Math.max(0, list.findIndex((x) => x.userId === me));
  return [...list.slice(at), ...list.slice(0, at)]; // you first, then round the table
}

function hudPanelHTML(s) {
  const on = hudOn();
  const club = !!(s.hud && s.hud.all);
  const scope = on ? prefs.hud || 'game' : prefs.hudScope || 'game';
  const src = s.hud ? (scope === 'all' && s.hud.all ? s.hud.all : s.hud.table) : {};
  const people = hudPlayers(s);
  const rows = people.map((x) => {
    const r = src && src[x.userId];
    const show = !hudHidden(x.userId);
    const you = x.userId === s.me.userId;
    const nm = you ? `${x.name} (you)` : x.name;
    return `<div class="hp-row ${show ? '' : 'off'}">
      ${avatarHTML(x.name)}
      <button type="button" class="hp-who" data-hud-sheet="${esc(x.userId)}" title="Every stat and the biggest hands for ${esc(x.name)}"><b>${esc(nm)}</b><small>${r && r.hands ? `${esc(hudLine(r))}, ${r.hands} hand${r.hands === 1 ? '' : 's'}` : 'No hands yet'}</small></button>
      <label class="switch" title="${show ? 'Hide' : 'Show'} the numbers on ${esc(you ? 'your' : `${x.name}’s`)} seat"><input type="checkbox" data-hud-user="${esc(x.userId)}" ${show ? 'checked' : ''} ${on ? '' : 'disabled'} aria-label="HUD for ${esc(nm)}"><span aria-hidden="true"></span></label>
    </div>`;
  }).join('');
  const shown = people.filter((x) => !hudHidden(x.userId)).length;
  return `
    <div class="hp-head">
      <div><b>HUD</b><small>VPIP / PFR / AF, then hands, on each seat</small></div>
      <label class="switch big" title="${on ? 'Turn the HUD off' : 'Turn the HUD on'}"><input type="checkbox" data-hud-all ${on ? 'checked' : ''} aria-label="HUD"><span aria-hidden="true"></span></label>
    </div>
    ${club ? `<div class="seg hp-scope ${on ? '' : 'dim'}" data-hud-scope role="group" aria-label="Numbers from"><button type="button" data-v="game" class="${scope === 'game' ? 'on' : ''}" ${on ? '' : 'disabled'}>This game</button><button type="button" data-v="all" class="${scope === 'all' ? 'on' : ''}" ${on ? '' : 'disabled'}>All games</button></div>` : ''}
    <div class="hp-list ${on ? '' : 'dim'}">
      <div class="hp-lh"><span>Show for each player</span>${people.length > 1 ? `<button type="button" data-hud-every="${shown === people.length ? '0' : '1'}" ${on ? '' : 'disabled'}>${shown === people.length ? 'Hide all' : 'Show all'}</button>` : ''}</div>
      ${rows || '<p class="muted hp-none">Nobody is sitting at the table yet.</p>'}
    </div>
    <p class="hp-note">Only your screen changes. Pick a name for every stat.</p>`;
}

function placeHud() {
  if (!hp) return;
  const el = hp.el;
  const a = hudAnchor();
  const sheet = !a || innerWidth < 560;
  el.classList.toggle('sheet', sheet);
  if (sheet) { el.style.left = ''; el.style.top = ''; return; }
  const r = a.getBoundingClientRect();
  const W = el.offsetWidth;
  const H = el.offsetHeight;
  const left = Math.max(8, Math.min(innerWidth - W - 8, r.right - W));
  let top = r.bottom + 8;
  if (top + H > innerHeight - 8) top = Math.max(8, r.top - H - 8);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function drawHud(force = false) {
  const s = app.state;
  if (!hp || !s) return;
  // redrawn only when something in it changed, so a switch is never swapped out under a tap
  const key = JSON.stringify([prefs.hud, prefs.hudScope, prefs.hudHide, (s.seats || []).map((x) => x && [x.userId, x.name]), s.hud]);
  if (!force && key === hp.key) { placeHud(); return; }
  hp.key = key;
  const focused = document.activeElement && hp.el.contains(document.activeElement) ? document.activeElement : null;
  const sel = focused ? (focused.dataset.hudUser ? `[data-hud-user="${CSS.escape(focused.dataset.hudUser)}"]` : focused.matches('[data-hud-all]') ? '[data-hud-all]' : null) : null;
  hp.el.innerHTML = hudPanelHTML(s);
  if (sel) hp.el.querySelector(sel)?.focus();
  placeHud();
}

export function closeHudPanel(refocus = false) {
  if (!hp) return;
  document.removeEventListener('pointerdown', hp.outside, true);
  document.removeEventListener('keydown', hp.onKey, true);
  window.removeEventListener('resize', placeHud);
  hp.el.remove();
  hp = null;
  document.querySelectorAll('[data-open="hud"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  if (refocus) hudAnchor()?.focus();
}

export function hudPanel() {
  if (hp) { closeHudPanel(true); return; }
  const el = document.createElement('div');
  el.className = 'hud-pop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'HUD');
  document.body.appendChild(el);
  hp = { el, key: '' };
  const after = () => { app.render(); drawHud(true); };
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-hud-all]')) { setHudOn(e.target.checked); after(); return; }
    if (e.target.matches('[data-hud-user]')) { setHudFor(e.target.dataset.hudUser, e.target.checked); after(); }
  });
  el.addEventListener('click', (e) => {
    const sc = e.target.closest('[data-hud-scope] button');
    if (sc && !sc.disabled) { savePrefs({ hud: sc.dataset.v, hudScope: sc.dataset.v }); after(); return; }
    const every = e.target.closest('[data-hud-every]');
    if (every && !every.disabled) {
      const show = every.dataset.hudEvery === '1';
      const ids = hudPlayers(app.state).map((x) => x.userId);
      const hide = new Set(prefs.hudHide || []);
      for (const uid of ids) { if (show) hide.delete(uid); else hide.add(uid); }
      savePrefs({ hudHide: [...hide] });
      after();
      return;
    }
    const sheet = e.target.closest('[data-hud-sheet]');
    if (sheet) { closeHudPanel(); playerSheet(sheet.dataset.hudSheet); }
  });
  hp.outside = (e) => { if (!el.contains(e.target) && !e.target.closest('[data-open="hud"]')) closeHudPanel(); };
  hp.onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeHudPanel(true); } };
  document.addEventListener('pointerdown', hp.outside, true);
  document.addEventListener('keydown', hp.onKey, true);
  window.addEventListener('resize', placeHud);
  document.querySelectorAll('[data-open="hud"]').forEach((b) => b.setAttribute('aria-expanded', 'true'));
  drawHud(true);
  el.querySelector('[data-hud-all]')?.focus({ preventScroll: true });
}

// After the table is drawn: the panel follows its button, which was drawn again, and the players at
// the table.
export function hudRefresh() {
  if (!hp) return;
  document.querySelectorAll('[data-open="hud"]').forEach((b) => b.setAttribute('aria-expanded', 'true'));
  drawHud();
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
  const seatedNow = (app.state?.seats || []).some((x) => x && x.userId === userId);
  const hudSwitch = () => (seatedNow ? `<label class="check ps-hud"><input type="checkbox" data-hud-one ${hudHidden(userId) ? '' : 'checked'} ${hudOn() ? '' : 'disabled'}> Show ${userId === app.state.me.userId ? 'my' : `${esc(name)}’s`} numbers on ${userId === app.state.me.userId ? 'my' : 'their'} seat${hudOn() ? '' : '<small>The HUD is off. Turn it on with the HUD button.</small>'}</label>` : '');
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
      ${hudSwitch()}
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
  dlg.el.addEventListener('change', (e) => {
    if (!e.target.matches('[data-hud-one]')) return;
    setHudFor(userId, e.target.checked);
    app.render();
  });
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
