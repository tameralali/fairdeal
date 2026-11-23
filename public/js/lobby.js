// Home page: The Aquarium's balances, ledger, games and all-time stats, and Start a game (a pop-out,
// for admins). Also the invite, owner setup and password reset pages, and the admin page where people
// are invited and managed.
import { api, ensureIdentity, fmtChips, parseChips, toInput, BRAND_HEX } from './api.js';
import { esc, $, dialog, toast, confirmDialog, copyText, timeAgo, avatarHTML } from './ui.js';
import { sealSVG } from './seal.js';
import { wordmarkHTML } from './brand.js';
import { cardHTML, backHTML, applyPrefs } from './cards.js';
import { SORTS, showChoices, runChoices, handKey, pickHands, resultOf, topWinner } from './hand-filter.js';
import { startGameDialog, endGameText } from './game-form.js';
import { statsTable, glossaryHTML, gameSeg } from './stats-view.js';
import { fmtMoney } from '/shared/money.js';
import { GAME_TYPES } from '/shared/cards.js';

const main = $('#main');
const head = $('#head');
let me = null;
let clubSocket = null;
let watching = null;
// view state that survives live refreshes of the club page
const ui = {
  member: '', ledgerLimit: 15, statsGame: 'all', period: 'all', from: '', to: '', tab: readTab(),
  hands: { session: 'all', who: '', sort: 'pot', filter: 'all', runs: 'any', game: 'all', limit: 50 },
};
function readTab() { try { return localStorage.getItem('fd:hometab') || 'past'; } catch { return 'past'; } }
function saveTab() { try { localStorage.setItem('fd:hometab', ui.tab); } catch { /* storage blocked */ } }
const isAdmin = () => me && (me.user.role === 'owner' || me.user.role === 'admin');

async function boot() {
  const link = location.pathname.match(/^\/(invite|reset)\/([0-9a-f]{64})$/);
  if (link) return linkPage(link[2]);
  const join = location.pathname.match(/^\/join\/([A-Za-z0-9_-]{16})$/);
  if (join) return joinPage(join[1]);
  if (location.pathname === '/fair') return fairPage();
  try { me = await ensureIdentity(); }
  catch (e) { main.innerHTML = `<p class="bad">${esc(e.message)}</p>`; return; }
  const next = new URLSearchParams(location.search).get('next');
  if (next && /^\/(?!\/)/.test(next)) { location.replace(next); return; }
  renderHead();
  const game = location.pathname.match(/^\/g\/([A-Za-z0-9_-]{4,40})$/);
  if (game) return gamePage(game[1]);
  route();
}

function route() {
  const path = location.pathname;
  if (path === '/admin') return adminPage();
  // one club: every other address is its home page
  if (path !== '/') history.replaceState(null, '', '/' + location.hash);
  return home();
}
window.addEventListener('popstate', route);

function go(url) { history.pushState(null, '', url); route(); }

function renderHead() {
  const u = me.user;
  head.innerHTML = `<a class="wordmark" href="/">${wordmarkHTML(30)}</a>
    <div class="who"><span><span class="pre">Playing as </span><b>${esc(u.name)}</b> <span class="faint uname">@${esc(u.username)}</span></span>
      ${isAdmin() ? '<button class="btn small" data-h="invite">Invite</button><a class="btn small ghost" href="/admin" data-h="admin">People</a>' : ''}
      <button class="btn small ghost" data-h="rename">Change name</button>
      <button class="btn small ghost" data-h="logout">Sign out</button>
    </div>`;
}

head.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-h]');
  if (!b) return;
  const k = b.dataset.h;
  if (k === 'invite') return inviteDialog();
  if (k === 'admin') { e.preventDefault(); return go('/admin'); }
  if (k === 'logout') {
    await api.post('/api/auth/logout').catch(() => {});
    api.token = null;
    location.href = '/';
  }
  if (k === 'rename') {
    const dlg = dialog({
      title: 'Change your name', className: 'narrow',
      body: `<form class="stack"><label><span class="lbl">Name</span><input name="nick" maxlength="24" value="${esc(me.user.name)}" required></label><p class="hint">Applies to tables you join from now on.</p><button class="btn primary" type="submit">Save name</button></form>`,
    });
    dlg.$('form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const r = await api.patch('/api/me', { name: ev.target.elements.nick.value });
        me.user = r.user;
        renderHead();
        dlg.close();
        toast('Name saved');
      } catch (x) { toast(x.message, 'error'); }
    });
  }
});

// ---------- the games board ----------
// Each game is a row like a card room's board, or PokerNow's lobby: a little table with its seats, the
// name with a Live badge, what is played, then blinds, buy-in, players and the average stack, and a
// button to go in. Games open in their own tab, so the club page stays open in this one. Admins can
// end a game here.
const GB_ICON = {
  go: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5.5 15.5 12 9 18.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bomb: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="14" r="6.8" fill="currentColor"/><path d="M14.6 9.6l2.4-2.4M18.4 3.6v1.6M20.8 6.2h-1.6M20.4 4l-1.1 1.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  runs: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h12.5M13 4.5 16.5 8 13 11.5M20 16H7.5M11 12.5 7.5 16l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12.5" r="8" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 8.3v4.4l2.9 1.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
};
const GAME_HUE = { nlh: 'g-nlh', plo4: 'g-plo', plo5: 'g-plo5' };

// a table seen from above: an oval with a dot for each seat, filled where someone sits
function tableGlyph(max, taken = []) {
  const n = Math.max(2, Math.min(10, max || 9));
  const set = new Set(taken);
  let dots = '';
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 2 + (i * 2 * Math.PI) / n;
    dots += `<circle cx="${(24 + 17.5 * Math.cos(a)).toFixed(1)}" cy="${(24 + 12 * Math.sin(a)).toFixed(1)}" r="2.9" class="${set.has(i) ? 'on' : ''}"/>`;
  }
  return `<svg viewBox="0 0 48 48" aria-hidden="true"><ellipse class="tg-felt" cx="24" cy="24" rx="12.5" ry="7.5"/>${dots}</svg>`;
}

// amounts on the board leave out the dollar sign, as at the table; big ones are shortened, as on PokerNow
const boardMoney = (a, dec) => fmtMoney(a, dec, 'auto', '');
function compactMoney(a, dec) {
  const v = dec ? a / 100 : a;
  if (v >= 1000) return `${Number((v / 1000).toFixed(v % 1000 ? 1 : 0))}k`;
  return boardMoney(a, dec);
}
function buyInText(t) {
  const lo = t.minBuyIn ? compactMoney(t.minBuyIn, t.decimals) : '';
  const hi = t.maxBuyIn ? compactMoney(t.maxBuyIn, t.decimals) : '';
  if (lo && hi) return `${lo}-${hi}`;
  if (lo) return `${lo}+`;
  if (hi) return `Up to ${hi}`;
  return 'Any';
}

// what the game plays, step by step, each game in its own colour
function formatChips(t) {
  const steps = (t.format || []).map((s) => ({ g: s.game, db: !!s.doubleBoard }));
  const seen = new Set();
  const uniq = steps.filter((s) => { const k = `${s.g}${s.db}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!uniq.length) return (t.games || []).map((g) => `<span class="gb-gm ${GAME_HUE[g] || ''}">${esc(GAME_TYPES[g]?.short || g)}</span>`).join('');
  return uniq.map((s) => `<span class="gb-gm ${GAME_HUE[s.g] || ''}" title="${esc(GAME_TYPES[s.g]?.name || s.g)}${s.db ? ', double board' : ''}">${esc(GAME_TYPES[s.g]?.short || s.g)}${s.db ? '<i>DB</i>' : ''}</span>`).join('<span class="gb-then" aria-label="then">&rsaquo;</span>');
}

// the extras played at the game, as small tags
function extrasHTML(t) {
  const out = [];
  // a tourney: its buy-in, its level while it is played, and its winner once it is over
  const tr = t.tourney;
  if (tr) {
    const tip = `Tourney: everyone buys in for ${boardMoney(tr.buyIn, t.decimals)}, the blinds go up on a clock, ${tr.pay === 'place' ? 'and the prize pool is paid by place' : 'and chips are cash'}`;
    const where = t.status === 'ended' ? (tr.winner ? `, won by ${tr.winner}` : '') : t.handNumber ? `, level ${tr.level}` : '';
    out.push(`<span class="gb-x tour" title="${esc(tip)}">Tourney ${esc(boardMoney(tr.buyIn, t.decimals))}${esc(where)}</span>`);
  }
  const b = t.bomb;
  if (b) {
    const every = b.mode === 'every' || b.mode === 'both';
    const pct = b.mode === 'percent' || b.mode === 'both';
    const text = every && pct ? `${b.every} or ${b.percent}%` : every ? `every ${b.every}` : `${b.percent}%`;
    const tip = every && pct ? `A bomb pot every ${b.every} hands, or sooner: each hand has a ${b.percent}% chance` : every ? `A bomb pot every ${b.every} hands` : `Each hand has a ${b.percent}% chance of being a bomb pot`;
    out.push(`<span class="gb-x bomb" title="${esc(tip)}">${GB_ICON.bomb}${esc(text)}</span>`);
  }
  if (t.sevenDeuce) out.push(`<span class="gb-x s72" title="The 7-2 game: win a Hold’em hand with 7-2 and show it, and everyone else dealt in pays ${esc(boardMoney(t.sevenDeuce, t.decimals))}"><span class="s72-cards" aria-hidden="true"><b>7</b><b>2</b></span>${esc(boardMoney(t.sevenDeuce, t.decimals))}</span>`);
  if (t.straddle) out.push('<span class="gb-x strad" title="The player under the gun can straddle">Straddle</span>');
  if (t.runs > 1) out.push(`<span class="gb-x runs" title="All in? Run it up to ${t.runs} times if everyone in agrees">${GB_ICON.runs}Up to ${t.runs} runs</span>`);
  if (t.status === 'running' && t.endsAt && !t.ending) out.push(`<span class="gb-x" title="The game ends at this time">${GB_ICON.clock}Ends ${esc(new Date(t.endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span>`);
  return out.join('');
}

// Live: cards are being dealt. A running game short of players, or paused, is waiting.
const isLive = (t) => t.status === 'running' && !t.paused && !t.waiting;
function statusHTML(t) {
  if (t.status === 'ended') return `<span class="gb-st ended">Ended ${esc(timeAgo(t.endedAt || t.createdAt))}</span>`;
  if (t.ending) return '<span class="gb-st warn"><i></i>Last hand</span>';
  if (t.status === 'waiting') return '<span class="gb-st wait"><i></i>Not started</span>';
  if (t.paused) return '<span class="gb-st wait"><i></i>Paused</span>';
  if (t.waiting) return `<span class="gb-st wait" title="${esc(t.waiting)}"><i></i>Waiting for players</span>`;
  return '<span class="gb-st live"><i></i>Live</span>';
}

function facesHTML(names) {
  if (!names.length) return '';
  const shown = names.slice(0, names.length > 5 ? 4 : 5);
  const more = names.length - shown.length;
  return `<span class="gb-faces" title="${esc(names.join(', '))}">${shown.map((n) => avatarHTML(n)).join('')}${more ? `<span class="av more">+${more}</span>` : ''}</span>`;
}

// One live game. mine: the viewer sits at it.
function gameRow(t, canEnd) {
  const ended = t.status === 'ended';
  const href = `/${ended ? 'g' : 't'}/${encodeURIComponent(t.id)}`;
  const full = t.players >= t.maxPlayers;
  const go = ended ? 'Summary' : t.seated ? 'Back to table' : full ? 'Watch' : 'Join';
  const state = ended ? 'ended' : isLive(t) ? 'live' : 'wait';
  const end = canEnd && !ended && !t.ending ? `<button type="button" class="btn small gb-end" data-end="${esc(t.id)}" aria-label="End ${esc(t.name)}">End game</button>` : '';
  const sum = `${t.name}. ${ended ? 'Ended' : state === 'live' ? 'Live' : 'Waiting'}. Blinds ${boardMoney(t.smallBlind, t.decimals)}/${boardMoney(t.bigBlind, t.decimals)}. ${ended ? `${t.handNumber} hands` : `${t.players} of ${t.maxPlayers} seats taken`}.`;
  return `<div class="gb-row ${state}${t.seated ? ' mine' : ''}">
    <a class="gb-hit" href="${href}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true" title="${esc(`${t.name}${!ended && t.names?.length ? `: ${t.names.join(', ')}` : ''}. Opens in a new tab`)}"></a>
    <span class="gb-tile">${tableGlyph(t.maxPlayers, ended ? [] : t.taken)}</span>
    <span class="gb-main">
      <span class="gb-title"><b>${esc(t.name)}</b>${statusHTML(t)}${t.seated && !ended ? '<span class="gb-you">You’re playing</span>' : ''}</span>
      <span class="gb-meta">${formatChips(t)}${ended ? '' : extrasHTML(t)}</span>
    </span>
    <span class="gb-cells">
    <span class="gb-c blinds"><small>Blinds</small><b>${esc(boardMoney(t.smallBlind, t.decimals))}/${esc(boardMoney(t.bigBlind, t.decimals))}</b></span>
    ${ended
      ? `<span class="gb-c hands"><small>Hands</small><b>${t.handNumber || 0}</b></span>`
      : `<span class="gb-c buy"><small>Buy-in</small><b>${esc(buyInText(t))}</b></span>
    <span class="gb-c seats"><small>Players</small><span class="gb-pl"><b><em>${t.players}</em>/${t.maxPlayers}</b>${facesHTML(t.names || [])}</span></span>
    <span class="gb-c avg"><small>Avg stack</small><b>${t.avgStack === null || t.avgStack === undefined ? '-' : esc(boardMoney(Math.round(t.avgStack / (t.decimals ? 100 : 1)) * (t.decimals ? 100 : 1), t.decimals))}</b></span>`}
    </span>
    <span class="gb-act">${end}<a class="btn ${ended ? '' : 'primary'} gb-go" href="${href}" target="_blank" rel="noopener" aria-label="${esc(`${go}: ${sum} Opens in a new tab`)}">${go}${GB_ICON.go}</a></span>
  </div>`;
}

function board(tables, empty = 'No tables yet.', canEnd = false) {
  if (!tables || !tables.length) return `<div class="gb-empty"><span class="gb-tile">${tableGlyph(8)}</span><span>${esc(empty)}</span></div>`;
  const live = tables[0].status !== 'ended';
  const head = live ? '<div class="gb-head" aria-hidden="true"><span></span><span>Game</span><span>Blinds</span><span>Buy-in</span><span>Players</span><span>Avg stack</span><span></span></div>' : '';
  return head + tables.map((t) => gameRow(t, canEnd)).join('');
}

// PokerNow's line above its lobby: how many are playing right now, with a dot that glows when someone is
function nowPlaying(live) {
  const running = live.filter((t) => isLive(t) && t.players > 0);
  const n = running.reduce((a, t) => a + t.players, 0);
  const text = n ? `${n} player${n === 1 ? '' : 's'} at ${running.length} table${running.length === 1 ? '' : 's'} right now` : 'Nobody is playing right now';
  return `<span class="gb-now ${n ? 'on' : ''}"><i></i>${esc(text)}</span>`;
}

const openStart = (presetId = null) => startGameDialog({ user: me.user, presetId });

// Saved presets under Start a game: one click opens the game form filled in from it.
async function loadQuickStart() {
  const box = main.querySelector('[data-quick]');
  if (!box) return;
  let list = [];
  try { list = (await api.get('/api/presets')).presets; } catch { return; }
  if (!list.length) return;
  box.innerHTML = `<span class="qs-lbl">From a preset</span>${list.slice(0, 6).map((p) => `<button type="button" class="fmt-chip" data-qs="${esc(p.id)}">${esc(p.name)}</button>`).join('')}`;
  box.classList.remove('hidden');
  box.addEventListener('click', (e) => { const b = e.target.closest('[data-qs]'); if (b) openStart(b.dataset.qs); });
}

// ---------- home ----------
async function home() {
  me = await api.get('/api/me');
  if (!me.clubId) { main.innerHTML = '<section class="panel" style="max-width:560px"><h2>The club is not set up yet</h2><p class="muted">Reload in a moment.</p></section>'; return; }
  return clubHome(me.clubId);
}

// ---------- live updates ----------
function unwatch() {
  watching = null;
  main.onclick = null;
  if (main._clubClick) { main.removeEventListener('click', main._clubClick); main._clubClick = null; }
}
function watch(clubId) {
  watching = clubId;
  if (!clubSocket) {
    clubSocket = window.io({ auth: { token: api.token }, transports: ['websocket', 'polling'] });
    clubSocket.on('connect', () => { if (watching) clubSocket.emit('club:watch', { clubId: watching }); });
    // closed by the server: the library does not come back on its own, so ask again (see connect_error)
    clubSocket.on('disconnect', (reason) => { if (reason === 'io server disconnect') setTimeout(() => clubSocket.connect(), 500); });
    clubSocket.on('connect_error', (e) => {
      if (e.message === 'moved') location.reload();
      // signed out elsewhere, or no longer a member: back to the sign-in page instead of trying forever
      if (e.message === 'auth') { clubSocket.close(); api.token = null; location.reload(); }
    });
    let t = null;
    clubSocket.on('club:changed', ({ clubId: cid }) => {
      if (cid !== watching) return;
      clearTimeout(t);
      const refresh = () => {
        const busy = document.querySelector('dialog[open]') || (document.activeElement && main.contains(document.activeElement) && document.activeElement.matches('input, select, textarea'));
        if (busy) { t = setTimeout(refresh, 1500); return; }
        route();
      };
      t = setTimeout(refresh, 300);
    });
  } else if (clubSocket.connected) {
    clubSocket.emit('club:watch', { clubId });
  }
}

// ---------- club home ----------
const TX = {
  chips_add: 'Added', chips_remove: 'Taken out', settlement: 'Settled', transfer_in: 'Transfer in',
  transfer_out: 'Transfer out', buyin: 'Buy-in', cashout: 'Cash-out', credit_limit: 'Credit limit',
};

// Credit limit entries carry the old and new limit; older ones only have a note like "Credit limit 0 - 2000".
function txDetail(t, F) {
  if (t.type === 'credit_limit') {
    let from = t.limitFrom;
    let to = t.limitTo;
    const m = /^Credit limit (-?\d+) -\s*>?\s*(-?\d+)$/.exec(t.note || '');
    if (to === undefined && m) { from = Number(m[1]); to = Number(m[2]); }
    if (to !== undefined) return `Set to ${F(to)} (was ${F(from)})`;
  }
  return [t.tableName, t.note].filter(Boolean).join(': ');
}

// One line for the phone ledger: what happened, where, and the balance after it.
function txLine(t, F) {
  const d = txDetail(t, F);
  if (t.type === 'credit_limit') return d ? `Credit limit ${d[0].toLowerCase()}${d.slice(1)}` : 'Credit limit changed';
  return `${TX[t.type] || t.type}${d ? `, ${d}` : ''}. Balance ${F(t.balanceAfter)}`;
}

async function clubHome(id) {
  let data;
  try { data = await api.get('/api/clubs/' + encodeURIComponent(id)); }
  catch (e) {
    main.innerHTML = `<section class="panel" style="max-width:560px"><h2>The club page did not load</h2><p class="muted">${esc(e.message)}</p><a href="/">Try again</a></section>`;
    return;
  }
  const c = data.club;
  document.title = 'The Aquarium';
  if (c.myStatus !== 'active') {
    main.innerHTML = `<section class="panel" style="max-width:560px"><h2>${esc(c.name)}</h2><p>Your account is not set up in the club yet. Reload in a moment.</p></section>`;
    return;
  }
  watch(id);
  const dec = c.settings.decimals;
  const F = (a) => fmtChips(a, dec);
  const P = (v) => parseChips(v, dec);
  const roleLabel = { owner: 'You own the club', manager: 'You are an admin', member: 'Member' }[c.myRole];
  // games being dealt first, then the ones waiting for players or a start
  const live = data.tables.filter((t) => t.status !== 'ended').sort((a, b) => Number(isLive(b)) - Number(isLive(a)));
  const past = data.tables.filter((t) => t.status === 'ended');
  const money = (n) => (n === undefined ? '<span class="faint">-</span>' : `<span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${F(n)}</span>`);
  const signed = (n) => (n === undefined ? '<span class="faint">-</span>' : `<span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${n > 0 ? '+' : ''}${F(n)}</span>`);
  // always by balance, the most first, then by name
  const members = c.members.slice().sort((a, b) => (b.balance ?? -1e18) - (a.balance ?? -1e18) || a.name.localeCompare(b.name));
  if (ui.member && !c.members.some((m) => m.userId === ui.member)) ui.member = '';
  const txs = c.transactions.filter((t) => !ui.member || t.userId === ui.member);
  const shown = txs.slice(0, ui.ledgerLimit);
  const when = (at) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  // the history in tabs under the balances: one open at a time, kept between visits
  const TABS = [['past', 'Past games'], ['standings', 'Leaderboard'], ['stats', 'Stats'], ['hands', 'Hands'], ['ledger', 'Ledger']];
  if (!TABS.some(([k]) => k === ui.tab)) ui.tab = 'past';
  const tabBtn = ([k, label]) => `<button type="button" role="tab" id="tab-${k}" aria-controls="panel-${k}" aria-selected="${ui.tab === k}" tabindex="${ui.tab === k ? 0 : -1}" data-tab="${k}">${label}</button>`;
  const tabPanel = (k, html) => `<div class="tab-panel" role="tabpanel" id="panel-${k}" aria-labelledby="tab-${k}" ${ui.tab === k ? '' : 'hidden'}>${html}</div>`;
  const ledgerHTML = `<div class="sec-head tab-head">
        <div class="row">${c.seeAll ? `<select data-filter style="width:auto" aria-label="Show entries for"><option value="">Everyone</option>${c.members.map((m) => `<option value="${esc(m.userId)}" ${m.userId === ui.member ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>` : ''}
        <button class="btn small" data-csv>Download CSV</button></div>
      </div>
      ${shown.length ? `<div class="scroll-x wide-only"><table class="data"><thead><tr><th>When</th><th>Member</th><th>What</th><th class="n">Amount</th><th class="n">Balance after</th><th>By</th><th>Detail</th></tr></thead><tbody>
      ${shown.map((t) => `<tr><td class="muted nowrap">${when(t.at)}</td><td>${esc(t.name)}</td><td class="nowrap">${TX[t.type] || esc(t.type)}</td>
        <td class="n">${t.type === 'credit_limit' ? '' : signed(t.amount)}</td><td class="n">${money(t.balanceAfter)}</td>
        <td class="muted">${esc(t.byName || '')}</td><td class="muted">${esc(txDetail(t, F))}</td></tr>`).join('')}</tbody></table></div>
      <ul class="led-list narrow-only">${shown.map((t) => `<li>
        <div class="li-top"><b>${esc(t.name)}</b><span>${t.type === 'credit_limit' ? '' : signed(t.amount)}</span></div>
        <div class="li-sub"><span>${esc(txLine(t, F))}</span><span class="nowrap">${when(t.at)}</span></div>
      </li>`).join('')}</ul>
      ${txs.length > shown.length ? `<div class="more"><button class="btn small ghost" data-more>Show ${Math.min(50, txs.length - shown.length)} more of ${txs.length - shown.length}</button></div>` : ''}` : '<p class="muted">No entries yet. Money added, buy-ins, cash-outs and settlements show up here.</p>'}`;

  main.innerHTML = `
    <section class="club-band">
      <div class="cb-name">
        <h1>${esc(c.name)}</h1>
        <span class="muted">${roleLabel}, ${c.members.length} member${c.members.length === 1 ? '' : 's'}</span>
      </div>
      <div class="cb-bal">
        <div><small>Your balance</small><b class="${c.me.balance > 0 ? 'pos' : c.me.balance < 0 ? 'neg' : ''}">${F(c.me.balance)}</b></div>
        <div><small>Credit limit</small><b>${F(c.me.creditLimit)}</b></div>
        <div><small>Available to play</small><b>${F(Math.max(0, c.me.available))}</b></div>
      </div>
      ${c.isManager ? '<div class="cb-start"><button class="btn primary big" data-start>Start a game</button><div class="quick-start hidden" data-quick></div></div>' : ''}
    </section>
    ${c.announcement ? `<div class="announce">${esc(c.announcement)}</div>` : ''}
    <a class="fair-band" href="/fair">${sealSVG(BRAND_HEX, 22, '')}<span><b>Every shuffle can be checked.</b> The code is public, every player's browser adds to the shuffle, and your browser checks each hand you play. See how to check a hand yourself.</span></a>
    ${c.isManager && ((c.pending && c.pending.length) || (c.requests && c.requests.length)) ? `<section class="panel waitlist"><h2>Waiting to join</h2>
      ${requestRows(c.requests || [])}
      ${(c.pending || []).map((p) => `<div class="row" style="padding:6px 0"><b class="grow">${esc(p.name)}</b><span class="muted">${timeAgo(p.requestedAt)}</span><button class="btn small ghost" data-decide="${esc(p.userId)}" data-ok="0">Decline</button><button class="btn small primary" data-decide="${esc(p.userId)}" data-ok="1">Approve</button></div>`).join('')}</section>` : ''}

    <section class="panel games-panel">
      <div class="sec-head"><h2>Games</h2>${nowPlaying(live)}</div>
      <div class="gboard">${board(live, c.isManager ? 'No game running. Start one and it shows up here for every member.' : 'No game running right now. An admin starts the games.', c.isManager)}</div>
    </section>

    <section class="panel" id="balances">
      <div class="sec-head"><h2>Balances</h2>
        <div class="row">
          ${isAdmin() ? '<button class="btn small" data-invite>Invite players</button>' : ''}
        </div>
      </div>
      ${c.totals ? `<div class="totals">
        <div><small>Held by members</small><b>${F(c.totals.held)}</b></div>
        <div><small>Owed to the club</small><b class="${c.totals.owed < 0 ? 'neg' : ''}">${F(c.totals.owed)}</b></div>
        <div><small>On tables now</small><b>${F(c.totals.onTables)}</b></div>
        <div><small>Net balance</small><b>${F(c.totals.balances)}</b></div></div>` : ''}
      <div class="scroll-x"><table class="data balances"><thead><tr><th>Member</th><th class="n">Balance</th><th class="n col-credit">Credit<span class="wide-lbl"> limit</span></th><th class="n">Available</th><th class="n hide-sm">On tables</th>${c.isManager ? '<th class="col-act"><span class="sr">Actions</span></th>' : ''}</tr></thead>
      <tbody>${members.map((m) => `<tr class="${m.userId === me.user.id ? 'me' : ''}" ${c.isManager || m.userId === me.user.id ? `data-mrow="${esc(m.userId)}"` : ''}><td class="mem"><button type="button" class="linkish" data-mm="${esc(m.userId)}" ${c.isManager || m.userId === me.user.id ? '' : 'disabled'}>${esc(m.name)}</button>${m.userId === me.user.id ? ' <span class="faint you">(you)</span>' : ''}${m.role !== 'member' ? ` <span class="role">${m.role === 'manager' ? 'admin' : m.role}</span>` : ''}${m.off ? ' <span class="off">access off</span>' : ''}</td>
        <td class="n bal">${money(m.balance)}</td><td class="n col-credit">${m.creditLimit === undefined ? '<span class="faint">-</span>' : F(m.creditLimit)}</td><td class="n">${m.available === undefined ? '<span class="faint">-</span>' : F(Math.max(0, m.available))}</td>
        <td class="n hide-sm">${m.onTables === undefined ? '<span class="faint">-</span>' : F(m.onTables)}</td>
        ${c.isManager ? `<td class="col-act"><div class="member-actions">
          <button class="btn tiny" data-m="chips" data-u="${esc(m.userId)}">Adjust</button>
          <button class="btn tiny" data-m="credit" data-u="${esc(m.userId)}">Credit</button>
          ${m.balance ? `<button class="btn tiny" data-m="settle" data-u="${esc(m.userId)}">Settle</button>` : ''}
        </div></td>` : ''}</tr>`).join('')}</tbody></table></div>
      ${!c.seeAll ? '<p class="hint">Only admins see other members’ balances.</p>' : ''}
    </section>

    <section class="panel club-tabs" id="history">
      <div class="tab-row" id="tabs" role="tablist" aria-label="History">${TABS.map(tabBtn).join('')}</div>
      ${tabPanel('past', past.length ? `<div class="gboard past-board">${board(past.slice(0, 60))}</div>` : '<p class="muted">No games have finished yet.</p>')}
      ${tabPanel('standings', `<div class="sec-head tab-head"><span class="muted" data-results-count></span>${periodPicker()}</div>
      <div data-results-body><p class="muted">Loading…</p></div>`)}
      ${tabPanel('stats', `<div class="sec-head tab-head"><span class="muted" data-stats-count></span>${periodPicker()}</div>
      <div data-stats-body><p class="muted">Loading…</p></div>`)}
      ${tabPanel('hands', '<div data-hands><p class="muted">Loading…</p></div>')}
      ${tabPanel('ledger', ledgerHTML)}
    </section>

    <div class="club-foot">
      ${c.isManager ? '<button class="btn small" data-settings>Club settings</button>' : ''}
      ${c.settings.allowTransfers ? '<button class="btn small" data-transfer>Send money to a member</button>' : ''}
      <a class="btn small ghost" href="/fair">Fair dealing</a>
      <a class="btn small ghost" href="/verify">Shuffle verifier</a>
    </div>`;
  loadClubStats(id, c);
  loadResults(id, c);
  if (ui.tab === 'hands') loadHands(id);

  function selectTab(k, focus = false) {
    ui.tab = k;
    saveTab();
    main.querySelectorAll('[data-tab]').forEach((b) => {
      const on = b.dataset.tab === k;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    main.querySelectorAll('.tab-panel').forEach((x) => { x.hidden = x.id !== `panel-${k}`; });
    if (k === 'hands') loadHands(id);
  }
  main.querySelector('#tabs')?.addEventListener('keydown', (e) => {
    const all = TABS.map(([k]) => k);
    const i = all.indexOf(ui.tab);
    const j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : null;
    if (j === null) return;
    e.preventDefault();
    selectTab(all[(j + all.length) % all.length], true);
  });

  async function endGame(btn) {
    const t = data.tables.find((x) => x.id === btn.dataset.end);
    if (!t) return;
    if (!(await confirmDialog(endGameText(t.revealPolicy), { title: `End ${t.name}?`, ok: 'End game', danger: true }))) return;
    btn.disabled = true;
    try {
      const r = await api.post(`/api/tables/${encodeURIComponent(t.id)}/end`, {});
      toast(r.status === 'ended' ? `${t.name} has ended` : `${t.name} ends after this hand`);
      route();
    } catch (x) { toast(x.message, 'error'); btn.disabled = false; }
  }

  const post = async (path, payload, done) => {
    try { await api.post(`/api/clubs/${id}${path}`, payload); if (done) toast(done); route(); return true; }
    catch (x) { toast(x.message, 'error'); return false; }
  };

  main.querySelector('[data-start]')?.addEventListener('click', () => openStart());
  if (c.isManager) loadQuickStart();
  main.querySelector('[data-filter]')?.addEventListener('change', (e) => { ui.member = e.target.value; ui.ledgerLimit = 15; clubHome(id); });
  if (main._clubChange) main.removeEventListener('change', main._clubChange);
  main._clubChange = onPeriod;
  main.addEventListener('change', onPeriod);
  function onPeriod(e) {
    const k = e.target.dataset.period;
    if (!k) return;
    ui[k] = e.target.value;
    if (k === 'period' && ui.period === 'custom' && !ui.from) {
      const d = new Date();
      ui.to = d.toISOString().slice(0, 10);
      d.setDate(d.getDate() - 30);
      ui.from = d.toISOString().slice(0, 10);
    }
    // both panels show the same period
    for (const box of main.querySelectorAll('[data-period-box]')) box.outerHTML = periodPicker();
    loadClubStats(id, c);
    loadResults(id, c);
  }
  main.querySelector('[data-csv]')?.addEventListener('click', () => api.download(`/api/clubs/${id}/transactions.csv`, `club-ledger-${c.name.replace(/[^\w-]+/g, '-')}.csv`).catch((x) => toast(x.message, 'error')));

  main.addEventListener('click', onClick);
  function onClick(e) {
    if (!main.contains(e.target)) return;
    const tab = e.target.closest('[data-tab]');
    if (tab) { selectTab(tab.dataset.tab); return; }
    const end = e.target.closest('[data-end]');
    if (end) { endGame(end); return; }
    const rq = e.target.closest('[data-req]');
    if (rq) { decideRequest(rq, (c.requests || []).find((x) => x.id === rq.dataset.req), route); return; }
    const d = e.target.closest('[data-decide]');
    if (d) { post(`/members/${d.dataset.decide}/decide`, { approve: d.dataset.ok === '1' }); return; }
    const mm = e.target.closest('[data-mm]');
    if (mm) { const m = c.members.find((x) => x.userId === mm.dataset.mm); if (m) memberSheet(m); return; }
    // on a phone the balances have no actions column: the whole row opens the member
    const row = e.target.closest('tr[data-mrow]');
    if (row && !e.target.closest('button, a') && matchMedia('(max-width: 640px)').matches) {
      const m = c.members.find((x) => x.userId === row.dataset.mrow);
      if (m) memberSheet(m);
      return;
    }
    if (e.target.closest('[data-more]')) { ui.ledgerLimit += 50; clubHome(id); return; }
    if (e.target.closest('[data-invite]')) return inviteDialog();
    if (e.target.closest('[data-settings]')) return settingsDialog();
    if (e.target.closest('[data-transfer]')) return transferDialog();
    const sg = e.target.closest('#panel-stats [data-game] button');
    if (sg) { ui.statsGame = sg.dataset.v; loadClubStats(id, c); return; }
    const rg = e.target.closest('[data-result-game]');
    if (rg) { window.open(`/g/${encodeURIComponent(rg.dataset.resultGame)}`, '_blank', 'noopener'); return; }
    const b = e.target.closest('[data-m]');
    if (!b) return;
    const m = c.members.find((x) => x.userId === b.dataset.u);
    const k = b.dataset.m;
    if (k === 'chips') memberChips(m);
    if (k === 'credit') memberCredit(m);
    if (k === 'settle') memberSettle(m);
  }
  // clubHome re-renders main in place; drop this render's listener on the next one
  const prev = main._clubClick;
  if (prev) main.removeEventListener('click', prev);
  main._clubClick = onClick;

  const canRemove = (m) => c.isManager && m.userId !== me.user.id && m.role !== 'owner' && (m.role !== 'manager' || me.user.role === 'owner');

  function memberSheet(m) {
    const mine = m.userId === me.user.id;
    const stat = (label, v) => `<div><small>${label}</small><b>${v}</b></div>`;
    const dlg = dialog({
      title: m.name, className: 'narrow',
      body: `<div class="stack">
        ${m.balance === undefined ? '<p class="muted">Only managers see this member’s balance.</p>' : `<div class="totals sheet">
          ${stat('Balance', money(m.balance))}${stat('Credit limit', F(m.creditLimit))}${stat('Available', F(Math.max(0, m.available)))}${stat('On tables', F(m.onTables))}${stat('Net from play', signed(m.net))}
        </div>`}
        ${me.user.role === 'owner' && m.role !== 'owner' ? `<div class="role-pick"><span class="lbl">Role</span>
          <div class="seg" data-role role="group" aria-label="Role for ${esc(m.name)}"><button type="button" data-v="member" class="${m.role === 'manager' ? '' : 'on'}">Member</button><button type="button" data-v="admin" class="${m.role === 'manager' ? 'on' : ''}">Admin</button></div>
          <p class="hint">Members join and leave games with their balance and credit. Admins can also add to or take from balances, set credit limits, settle up, start and end games, approve people and send invites. Only you can change roles.</p>
        </div>` : ''}
        ${me.user.role === 'owner' && m.role !== 'owner' ? (m.joinedAt ? `<p class="muted">Joined ${new Date(m.joinedAt).toLocaleDateString()}</p>` : '') : `<p class="muted">${m.role === 'owner' ? 'Owner' : m.role === 'manager' ? 'Admin' : 'Member'}${m.joinedAt ? `, joined ${new Date(m.joinedAt).toLocaleDateString()}` : ''}</p>`}
        ${c.isManager ? `<div class="sheet-actions">
          <button class="btn" data-a="chips">Add to or take from balance</button>
          <button class="btn" data-a="credit">Credit limit</button>
          ${m.balance ? '<button class="btn" data-a="settle">Settle up</button>' : ''}
          ${canRemove(m) ? '<button class="btn danger" data-a="remove">Remove from the club</button>' : ''}
        </div>` : ''}
      </div>`,
      foot: `<button class="btn ghost" data-a="entries">${mine ? 'Show my' : 'Show their'} ledger entries</button><button class="btn primary" data-close>Done</button>`,
    });
    dlg.el.addEventListener('click', async (ev) => {
      const rb = ev.target.closest('[data-role] button');
      if (rb && !rb.classList.contains('on')) {
        const role = rb.dataset.v;
        dlg.$$('[data-role] button').forEach((b) => { b.disabled = true; });
        try {
          await api.post(`/api/admin/users/${encodeURIComponent(m.userId)}/role`, { role });
          toast(role === 'admin' ? `${m.name} is now an admin` : `${m.name} is now a member`);
          dlg.close();
          await clubHome(id);
        } catch (x) { toast(x.message, 'error'); dlg.$$('[data-role] button').forEach((b) => { b.disabled = false; }); }
        return;
      }
      const a = ev.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      dlg.close();
      if (a === 'chips') memberChips(m);
      if (a === 'credit') memberCredit(m);
      if (a === 'settle') memberSettle(m);
      if (a === 'remove' && (await removeFromClub(id, m, F))) route();
      if (a === 'entries') {
        ui.member = m.userId;
        ui.ledgerLimit = 15;
        ui.tab = 'ledger';
        saveTab();
        await clubHome(id);
        document.getElementById('history')?.scrollIntoView({ block: 'start' });
      }
    });
  }

  const moneyBox = (name, value = '') => `<span class="money"><input name="${name}" type="text" inputmode="decimal" autocomplete="off" value="${esc(value)}" required></span>`;

  function memberChips(m) {
    const dlg = dialog({
      title: `Balance for ${m.name}`, className: 'narrow',
      body: `<form class="stack">
        <div class="seg" data-dir><button type="button" class="on" data-v="1">Add to balance</button><button type="button" data-v="-1">Take from balance</button></div>
        <label><span class="lbl">Amount</span>${moneyBox('amount')}</label>
        <label><span class="lbl">Note</span><input name="note" maxlength="140" placeholder="e.g. Cash received"></label>
        <p class="hint">Balance now ${F(m.balance)}. Taking more than the balance leaves the member owing the club.</p>
        <button class="btn primary" type="submit">Save</button></form>`,
    });
    let dir = 1;
    dlg.$('[data-dir]').addEventListener('click', (ev) => {
      const x = ev.target.closest('button');
      if (!x) return;
      dir = Number(x.dataset.v);
      dlg.$$('[data-dir] button').forEach((y) => y.classList.toggle('on', y === x));
    });
    dlg.$('form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const amt = P(ev.target.elements.amount.value);
      if (!(amt > 0)) return toast('Enter an amount', 'error');
      if (await post(`/members/${m.userId}/chips`, { amount: dir * amt, note: ev.target.elements.note.value }, dir > 0 ? 'Added to the balance' : 'Taken from the balance')) dlg.close();
    });
    setTimeout(() => dlg.$('[name=amount]').focus(), 30);
  }

  function memberCredit(m) {
    const dlg = dialog({
      title: `Credit limit for ${m.name}`, className: 'narrow',
      body: `<form class="stack"><p class="muted">How far below zero ${esc(m.name)} can go when buying in. Their own balance is used first, then credit.</p>
        <label><span class="lbl">Credit limit</span>${moneyBox('limit', toInput(m.creditLimit, dec))}</label>
        <button class="btn primary" type="submit">Save limit</button></form>`,
    });
    dlg.$('form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const limit = P(ev.target.elements.limit.value || '0');
      if (!(limit >= 0)) return toast('Enter the credit limit in dollars', 'error');
      if (await post(`/members/${m.userId}/credit`, { limit }, 'Credit limit saved')) dlg.close();
    });
  }

  // Settling: with the player they paid, or who paid them (one entry each, naming each other), or with
  // the club in cash.
  function memberSettle(m) {
    const owes = m.balance < 0;
    const others = c.members.filter((x) => x.userId !== m.userId && x.balance !== undefined)
      .sort((a, b) => (owes ? b.balance - a.balance : a.balance - b.balance));
    const fits = (x) => (owes ? x.balance > 0 : x.balance < 0);
    const label = (x) => `${x.name}${x.balance > 0 ? `, is owed ${F(x.balance)}` : x.balance < 0 ? `, owes ${F(-x.balance)}` : ', settled'}`;
    const first = others.find(fits);
    const suggest = (x) => (x && fits(x) ? Math.min(Math.abs(m.balance), Math.abs(x.balance)) : Math.abs(m.balance));
    const dlg = dialog({
      title: `Settle ${m.name}`, className: 'narrow',
      body: `<form class="stack" novalidate>
        <p>${owes ? `${esc(m.name)} owes ${F(-m.balance)}.` : `${esc(m.name)} is owed ${F(m.balance)}.`}</p>
        <label><span class="lbl">${owes ? 'Who did they pay?' : 'Who paid them?'}</span><select name="with">
          ${others.filter(fits).map((x) => `<option value="${esc(x.userId)}">${esc(label(x))}</option>`).join('')}
          ${others.filter((x) => !fits(x)).length ? `<optgroup label="Others">${others.filter((x) => !fits(x)).map((x) => `<option value="${esc(x.userId)}">${esc(label(x))}</option>`).join('')}</optgroup>` : ''}
          <option value="" ${first ? '' : 'selected'}>${owes ? 'The club (paid in cash)' : 'The club (paid out in cash)'}</option>
        </select></label>
        <label data-amt><span class="lbl">Amount</span>${moneyBox('amount', toInput(suggest(first), dec))}</label>
        <label><span class="lbl">How it was paid</span><input name="note" maxlength="60" placeholder="e.g. Cash, bank transfer"></label>
        <p class="hint" data-explain></p>
        <p class="bad hidden" data-err role="alert"></p>
        <button class="btn primary" type="submit">Record settlement</button></form>`,
    });
    const f = dlg.$('form');
    const pick = () => others.find((x) => x.userId === f.elements.with.value) || null;
    const explain = () => {
      const x = pick();
      dlg.$('[data-amt]').classList.toggle('hidden', !x);
      dlg.$('[data-explain]').textContent = x
        ? `${owes ? `${m.name}'s balance goes up and ${x.name}'s goes down` : `${m.name}'s balance goes down and ${x.name}'s goes up`} by the amount: one entry each in the ledger, naming the other.`
        : `Records the cash ${owes ? 'paid in' : 'paid out'} and sets ${m.name}'s balance to zero.`;
    };
    f.elements.with.addEventListener('change', () => { f.elements.amount.value = toInput(suggest(pick()), dec); explain(); });
    explain();
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const x = pick();
      const err = dlg.$('[data-err]');
      err.classList.add('hidden');
      const body = { note: f.elements.note.value };
      if (x) {
        const amount = P(f.elements.amount.value);
        if (!(amount > 0) || amount > Math.abs(m.balance)) { err.textContent = `Enter an amount up to ${F(Math.abs(m.balance))}.`; err.classList.remove('hidden'); return; }
        Object.assign(body, { withUserId: x.userId, amount });
      }
      if (await post(`/members/${m.userId}/settle`, body, x ? `Settled ${m.name} with ${x.name}` : 'Settlement recorded')) dlg.close();
    });
  }

  function transferDialog() {
    const others = c.members.filter((m) => m.userId !== me.user.id);
    const dlg = dialog({
      title: 'Send money to a member', className: 'narrow',
      body: `<form class="stack">
        <label><span class="lbl">To</span><select name="to">${others.map((m) => `<option value="${esc(m.userId)}">${esc(m.name)}</option>`).join('')}</select></label>
        <label><span class="lbl">Amount</span>${moneyBox('amount')}</label>
        <label><span class="lbl">Note</span><input name="note" maxlength="140" placeholder="Optional"></label>
        <p class="hint">You can send money from a positive balance only; credit cannot be passed on.</p>
        <button class="btn primary" type="submit">Send money</button></form>`,
    });
    dlg.$('form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target.elements;
      if (await post('/transfer', { toUserId: f.to.value, amount: P(f.amount.value), note: f.note.value }, 'Money sent')) dlg.close();
    });
  }

  function settingsDialog() {
    const st = c.settings;
    const dlg = dialog({
      title: 'Club settings',
      body: `<form class="stack" id="clubset">
        <div class="field-grid">
          <label><span class="lbl">Club name</span><input name="cname" maxlength="40" value="${esc(c.name)}"></label>
          <label><span class="lbl">Default credit limit for new members</span>${moneyBox('defaultCreditLimit', toInput(st.defaultCreditLimit, dec))}</label>
        </div>
        <label><span class="lbl">Announcement for members</span><input name="announcement" maxlength="140" value="${esc(c.announcement || '')}" placeholder="e.g. Settle up by Sunday night"></label>
        <label class="check"><input type="checkbox" name="membersSeeLedger" ${st.membersSeeLedger ? 'checked' : ''}> Members can see everyone's balance, the full ledger and everyone's results<small>Off: each member sees only their own balance, entries and results. Everyone sees how others play in Stats.</small></label>
        <label class="check"><input type="checkbox" name="allowTransfers" ${st.allowTransfers ? 'checked' : ''}> Members can send money to each other<small>Only from a positive balance; credit cannot be passed on.</small></label>
        <p class="hint">Amounts are in dollars and cents. New people join with an invite from an admin.</p>
      </form>
      ${me.user.role === 'owner' ? `<div class="danger-zone"><h3 class="section-title">Clear history</h3>
        <p class="hint">For a fresh start, for example after testing: deletes every game with its hands, the club ledger and all stats, and sets every balance to zero. Accounts, roles, credit limits, presets, invites and the join link stay.</p>
        <button type="button" class="btn danger small" data-clear>Clear history</button></div>` : ''}`,
      foot: '<button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-save>Save settings</button>',
    });
    dlg.$('[data-clear]')?.addEventListener('click', () => clearHistoryDialog(dlg));
    dlg.$('[data-save]').addEventListener('click', async () => {
      const f = dlg.$('#clubset').elements;
      try {
        await api.patch(`/api/clubs/${id}`, {
          name: f.cname.value, announcement: f.announcement.value, defaultCreditLimit: P(f.defaultCreditLimit.value || '0'),
          membersSeeLedger: f.membersSeeLedger.checked, allowTransfers: f.allowTransfers.checked,
        });
        me = await api.get('/api/me');
        dlg.close();
        toast('Settings saved');
        route();
      } catch (x) { toast(x.message, 'error'); }
    });
  }
}

// The owner's fresh start: everything played and every ledger entry goes, after typing CLEAR.
function clearHistoryDialog(parent) {
  const d = dialog({
    title: 'Clear all history?', className: 'narrow',
    body: `<form class="stack" novalidate>
      <p>This deletes, for good:</p>
      <ul class="plain-list"><li>every game, running or finished, with its hands, log and replays</li><li>the club ledger: buy-ins, cash-outs, adjustments and settlements</li><li>all stats and results</li></ul>
      <p>Every balance is set to $0.00. Accounts, roles, credit limits, presets, invites and the join link stay. <b>This cannot be undone.</b></p>
      <label><span class="lbl">Type CLEAR to confirm</span><input name="confirm" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
      <p class="bad hidden" data-err role="alert"></p>
    </form>`,
    foot: '<button class="btn ghost" data-close>Cancel</button><button class="btn danger" data-go disabled>Clear history</button>',
  });
  const input = d.$('input[name=confirm]');
  const go = d.$('[data-go]');
  input.addEventListener('input', () => { go.disabled = input.value.trim() !== 'CLEAR'; });
  d.$('form').addEventListener('submit', (e) => { e.preventDefault(); if (!go.disabled) go.click(); });
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      await api.post('/api/admin/clear-history', { confirm: 'CLEAR' });
      d.close();
      parent.close();
      toast('History cleared');
      route();
    } catch (x) {
      const err = d.$('[data-err]');
      err.textContent = x.message;
      err.classList.remove('hidden');
      go.disabled = false;
    }
  });
  input.focus();
}

// All-time stats on the club page, for one game type or all of them.
async function loadClubStats(id, c) {
  const body = main.querySelector('[data-stats-body]');
  if (!body) return;
  let st;
  try { st = (await api.get(`/api/clubs/${encodeURIComponent(id)}/stats?game=${encodeURIComponent(ui.statsGame)}${periodQuery()}`)).stats; }
  catch (e) { body.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  const count = main.querySelector('[data-stats-count]');
  if (count) count.textContent = `${st.hands} hand${st.hands === 1 ? '' : 's'}, ${periodLabel()}`;
  const F = (a) => fmtChips(a, c.settings.decimals);
  body.innerHTML = `${st.games.length > 1 || ui.statsGame !== 'all' ? `<div class="stats-bar">${gameSeg(st.games, ui.statsGame)}</div>` : ''}
    ${statsTable(st, { me: me.user.id, fmt: F, rowAttr: null })}
    ${st.players.some((p) => p.net === null) ? '<p class="hint">Results of other members are shown to admins, or to everyone when the club settings allow it.</p>' : ''}
    ${glossaryHTML()}`;
}

// ---------- fair dealing: how anyone can check the shuffle ----------
async function fairPage() {
  document.title = 'Fair dealing | The Aquarium';
  head.innerHTML = `<a class="wordmark" href="/">${wordmarkHTML(30)}</a><a class="btn small ghost" href="/">${api.token ? 'Back to the club' : 'Sign in'}</a>`;
  let v = { commit: null, source: 'https://github.com/tameralali/fairdeal' };
  try { v = await api.get('/api/version'); } catch { /* the page still explains everything */ }
  const repo = esc(v.source);
  const commit = v.commit ? esc(v.commit.slice(0, 7)) : null;
  const zip = v.commit ? `${repo}/archive/${esc(v.commit)}.zip` : `${repo}/archive/refs/heads/main.zip`;
  main.innerHTML = `<article class="panel fair-page">
    <h1>Fair dealing</h1>
    <p class="lead">You do not have to take anyone's word that the cards are random, the host's included. Every deck is sealed before the deal, every player's browser adds its own randomness to the shuffle, and any hand can be checked afterwards: by your browser on its own, or on your own computer with nothing from this site.</p>

    <section>
      <h2>Check a hand at the table</h2>
      <ol class="fair-steps">
        <li><b>Before the deal, look at the seal</b> at the top of the table. It is always for the next hand: while hand 12 is played it reads "Hand #13 sealed", so the deck for hand 13 is fixed before anyone sees a card of it. Tap it to see the deck's fingerprint and whether your browser's input is in. On a phone it is Sealed deck in the menu.</li>
        <li><b>After the hand, tap the seal again.</b> It says how many hands your browser has checked at this table and whether every one passed. Your browser runs these checks by itself after every hand, against the seal it saw before the deal.</li>
        <li><b>To see the checks for one hand,</b> open Hands (Hand history in the phone menu), pick the hand and choose Details. Under Deck check, the seal your browser saw before the deal and the seal rebuilt after the hand should be the same picture, and every check below them should have a tick. A cross says which check failed.</li>
      </ol>
      <p class="hint">If the host set the game to reveal the deck only when the game ends, the checks run then.</p>
    </section>

    <section>
      <h2>Check a hand without this site</h2>
      <p>The checks above run in your browser, but the page that runs them comes from this site. To take the site out of it completely, check the hand on your own computer, with your own copy of the code.</p>
      <ol class="fair-steps">
        <li><b>Before the deal,</b> tap the seal and choose Copy fingerprint. Paste it somewhere this site cannot change, such as your notes or the group chat. Posted in the group chat, it holds everyone to the same deck.</li>
        <li><b>After the hand,</b> open it in Hands, choose Details, then Download this hand. You get a file named like hand-ab12cd-13.json.</li>
        <li><b>Get the code</b> this site is running: <a href="${zip}" rel="noopener">download it from GitHub as a ZIP</a> and unzip it. You also need Node.js 20 or newer, free from <a href="https://nodejs.org" target="_blank" rel="noopener">nodejs.org</a>. There is nothing else to install.</li>
        <li><b>Run the check.</b> Open a terminal in the unzipped folder. On a Mac, open Terminal, type cd and a space, drag the folder onto the window and press Return. On Windows, open the folder, type cmd in its address bar and press Enter. Then run this, with your hand file and the fingerprint you copied:
          <div class="fair-cmd"><code>${'node scripts/verify-hand.js hand-ab12cd-13.json --seal YOUR-FINGERPRINT'.split(' ').map((w) => `<span>${w}</span>`).join(' ')}</code><button type="button" class="btn small ghost" data-copy-cmd>Copy</button></div>
          You can drag the hand file onto the window instead of typing its name. The check lists every test with a tick or a cross, shows who was dealt which card, and ends with "The hand passed every check". Folded cards stay sealed and show as ??, but their seals are part of the check, so they could not have been swapped either.</li>
      </ol>
      <p class="hint">In a game set to reveal the whole deck, the seal is the SHA-256 of the revealed server seed, so any SHA-256 tool can check it as well. Copy the seed from Raw data in Details, and on a Mac run <code>printf '%s' SEED | shasum -a 256</code> with the seed in place of SEED.</p>
    </section>

    <section>
      <h2>Check a whole game</h2>
      <p>The <a href="/verify">shuffle verifier</a> checks every hand of a game at once: enter the table ID, which is the part after /t/ in the table's link, and choose Check every hand. Opened in the browser you played from, it also checks the seals your browser saw before each deal and your own cards.</p>
    </section>

    <section>
      <h2>How each hand is sealed</h2>
      <ol class="fair-steps">
        <li><b>Before the deal,</b> the server shuffles a deck with a secret and publishes a seal: a SHA-256 fingerprint of the whole deck. Changing even one card afterwards would change the seal.</li>
        <li><b>Then every seated player's browser adds its own random number.</b> The final order of the deck depends on all of them. The server committed to its part before seeing yours, so it cannot steer any card to anyone.</li>
        <li><b>After the hand,</b> the server opens the seal: the boards, the cards that were shown, and every card nobody was dealt. Your own cards are opened to you. Folded cards can stay sealed for good, if the game is set that way.</li>
        <li><b>Your browser rebuilds the seal</b> from what was opened and checks that it matches the one it saw before the deal, that its own random number was used, and that your cards and every board came off that deck in order.</li>
      </ol>
    </section>

    <section>
      <h2>The code is public</h2>
      <p>Everything that runs this site, the server that deals and the page in your browser, is public on GitHub: <a href="${repo}" target="_blank" rel="noopener">${repo.replace(/^https?:\/\//, '')}</a>. Anyone can read how the deck is shuffled and sealed, and what the checks do. The checks themselves are one file, shared/fairness.js.</p>
      ${commit ? `<p>This site is running <a href="${repo}/commit/${esc(v.commit)}" target="_blank" rel="noopener">commit ${commit}</a>, so you can read the exact version that is dealing right now.</p>` : ''}
      <p class="hint">You cannot look inside a server, so nothing here asks you to trust it. The checks would catch a server that changed the deck, whatever code it ran.</p>
    </section>

    <section>
      <h2>What this proves, and what it does not</h2>
      <p><b>It proves</b> the deck was fixed before anyone acted, nobody could change or pick cards once the deal started (not the host, not the server), every card came off that deck in order, and every player's randomness was part of the shuffle. If the server dropped a player's random number or swapped the deck, that player's browser would show the check as failed.</p>
      <p><b>It does not prove</b> that whoever runs the server cannot read the cards in its memory during a hand. That is true of every online poker site, PokerNow included. Closing that gap takes a much slower kind of protocol, where no single computer ever knows the deck.</p>
    </section>

    <div class="row fair-links"><a class="btn primary" href="/verify">Open the shuffle verifier</a><a class="btn" href="${zip}" rel="noopener">Download the code</a><a class="btn" href="${repo}" target="_blank" rel="noopener">Read the code on GitHub</a></div>
  </article>`;
  // copies the start of the command: the file and the fingerprint are the reader's own
  main.querySelector('[data-copy-cmd]').addEventListener('click', () => copyText('node scripts/verify-hand.js '));
}

// ---------- a game: its results, highlights, biggest hands and stats ----------
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const cardText = (c) => `<span class="ct s-${esc(c[1])}">${esc(c[0] === 'T' ? '10' : c[0])}${SUIT[c[1]] || ''}</span>`;
const when = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
// "Sam", "Sam and Lina", "Sam, Lina and Omar", "Sam, Lina and 3 others"
const nameList = (names) => (names.length <= 1 ? names.join('') : names.length <= 3 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`);
function lasted(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${m} minutes` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

async function gamePage(id) {
  main.innerHTML = '<p class="muted" style="padding:2rem 0">Loading the game…</p>';
  const q = encodeURIComponent(id);
  let sum, led, list, st;
  try {
    [sum, led, list, st] = await Promise.all([
      api.get(`/api/tables/${q}`), api.get(`/api/tables/${q}/ledger`), api.get(`/api/tables/${q}/hands`),
      api.get(`/api/tables/${q}/stats?scope=game`).then((r) => r.stats).catch(() => null),
    ]);
  } catch (e) {
    main.innerHTML = `<section class="panel"><p class="bad">${esc(e.message)}</p><p><a class="btn" href="/">Back to the club</a></p></section>`;
    return;
  }
  document.title = `${sum.name} | The Aquarium`;
  const F = (a) => fmtChips(a, sum.decimals);
  const signed = (n) => `<span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${n > 0 ? '+' : ''}${F(n)}</span>`;
  const you = (uid, name) => (uid === me.user.id ? 'You' : name);
  const hands = list.hands.slice().sort((a, b) => a.handNumber - b.handNumber);
  const replay = (n) => `/hands/${q}?hand=${n}`;
  const first = hands[0];
  const last = hands[hands.length - 1];
  const ended = sum.status === 'ended';

  // results: what each player took home, from the game's ledger
  const played = new Map();
  for (const h of hands) for (const [uid, net] of Object.entries(h.nets || {})) {
    const x = played.get(uid) || { hands: 0, won: 0 };
    x.hands++;
    if (net > 0) x.won++;
    played.set(uid, x);
  }
  const rows = led.rows.slice().sort((a, b) => b.net - a.net);
  const top = rows[0] && rows[0].net > 0 ? rows[0] : null;

  // highlights
  const byPot = hands.slice().sort((a, b) => b.pot - a.pot || a.handNumber - b.handNumber);
  const swings = hands.flatMap((h) => Object.entries(h.nets || {}).map(([uid, net]) => ({ h, uid, net, name: h.names?.[uid] || 'Someone' })));
  const bigWin = swings.reduce((m, x) => (x.net > (m?.net ?? 0) ? x : m), null);
  const bigLoss = swings.reduce((m, x) => (x.net < (m?.net ?? 0) ? x : m), null);
  const bestHand = hands.filter((h) => h.best).reduce((m, h) => (!m || h.best.score > m.best.score ? h : m), null);
  const mostPots = [...played.entries()].sort((a, b) => b[1].won - a[1].won)[0];
  const nameOf = (uid) => rows.find((r) => r.userId === uid)?.name || hands.find((h) => h.names?.[uid])?.names[uid] || 'Someone';
  const bounties = hands.filter((h) => h.bounty);
  const multi = hands.filter((h) => h.runCount > 1).length;
  const hl = [];
  if (byPot[0]) hl.push(['Biggest pot', F(byPot[0].pot), `Hand #${byPot[0].handNumber}${byPot[0].winners?.length ? `, won by ${esc(nameList(byPot[0].winners))}` : ''}`, byPot[0].handNumber]);
  if (bigWin) hl.push(['Biggest win', signed(bigWin.net), `${esc(you(bigWin.uid, bigWin.name))}, hand #${bigWin.h.handNumber}`, bigWin.h.handNumber]);
  if (bigLoss) hl.push(['Biggest loss', signed(bigLoss.net), `${esc(you(bigLoss.uid, bigLoss.name))}, hand #${bigLoss.h.handNumber}`, bigLoss.h.handNumber]);
  if (bestHand) hl.push(['Best hand', `<span class="hl-cards">${bestHand.best.cards.map(cardText).join('')}</span>`, `${esc(bestHand.best.hand)}, ${esc(you(bestHand.best.userId, bestHand.best.name))}, hand #${bestHand.handNumber}`, bestHand.handNumber]);
  if (mostPots && mostPots[1].won) hl.push(['Most pots won', String(mostPots[1].won), `${esc(you(mostPots[0], nameOf(mostPots[0])))}, of ${mostPots[1].hands} hands played`, null]);
  if (bounties.length) hl.push(['7-2 bounties', String(bounties.length), bounties.map((h) => `${esc(you(h.bounty.userId, h.bounty.name))} ${F(h.bounty.total)} (hand #${h.handNumber})`).join(', '), bounties[0].handNumber]);
  if (multi) hl.push(['Run more than once', String(multi), `hand${multi === 1 ? '' : 's'} all in and run more than once`, null]);

  const bigRow = (h) => {
    const [wid, wnet] = Object.entries(h.nets || {}).sort((a, b) => b[1] - a[1])[0] || [];
    const flags = [h.isBomb ? 'bomb pot' : '', h.doubleBoard ? 'two boards' : '', h.runCount > 1 ? `ran ${h.runCount} times` : '', h.allIn ? 'all in' : ''].filter(Boolean).join(', ');
    return `<a class="bh-row" href="${replay(h.handNumber)}">
      <span class="bh-n">#${h.handNumber}</span>
      <span class="bh-pot">${F(h.pot)}</span>
      <span class="bh-who">${wid && wnet > 0 ? `<b>${esc(you(wid, h.names?.[wid] || 'Someone'))}</b> ${signed(wnet)}` : '<span class="faint">Split</span>'}${h.best ? `<small>${esc(h.best.hand)}</small>` : ''}</span>
      <span class="bh-sub">${esc((GAME_TYPES[h.gameType] || {}).short || h.gameType)}${flags ? `, ${esc(flags)}` : ''}</span>
      <span class="bh-go">Replay</span>
    </a>`;
  };
  const SHOW = 10;
  const meta = [first ? when(first.at) : '', first && last && last !== first ? lasted(last.at - first.at) : '', `${hands.length} hand${hands.length === 1 ? '' : 's'}`, sum.games?.length ? sum.games.map((g) => (GAME_TYPES[g] || {}).short || g).join(' and ') : '', `${F(sum.smallBlind)}/${F(sum.bigBlind)}`].filter(Boolean);

  main.innerHTML = `<article class="game-page">
    <div class="gp-nav"><a class="btn small ghost" href="/">Back to the club</a><a class="btn small" href="/t/${q}">${ended ? 'Hand history' : 'Open the table'}</a></div>
    <header class="gp-hero panel">
      <h1>${esc(sum.name)}</h1>
      <p class="gp-meta">${meta.map(esc).join(', ')}</p>
      ${!ended ? '<p class="gp-live">This game is still going. The numbers below are so far.</p>' : top ? `<p class="gp-win"><b>${esc(you(top.userId, top.name))}</b> won the game, ${signed(top.net)}</p>` : ''}
    </header>

    <section class="panel">
      <div class="sec-head"><h2>Results</h2><a class="btn small ghost" href="/api/tables/${q}/ledger.csv" data-csv-game>Download CSV</a></div>
      ${rows.length ? `<div class="scroll-x"><table class="data results">
        <thead><tr><th class="n">#</th><th>Player</th><th class="n">Net</th><th class="n hide-sm">Bought in</th><th class="n hide-sm">Took home</th><th class="n">Hands</th><th class="n">Pots won</th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr class="${r.userId === me.user.id ? 'mine' : ''}"><td class="n muted">${i + 1}</td><td class="who"><b>${esc(r.name)}</b>${r.userId === me.user.id ? ' <span class="faint">(you)</span>' : ''}</td>
          <td class="n">${signed(r.net)}</td><td class="n hide-sm">${F(r.buyIn)}</td><td class="n hide-sm">${F(r.buyOut + (r.seated ? r.stack : 0))}</td>
          <td class="n">${played.get(r.userId)?.hands || 0}</td><td class="n">${played.get(r.userId)?.won || 0}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">Nobody bought in.</p>'}
    </section>

    ${hl.length ? `<section class="panel"><div class="sec-head"><h2>Highlights</h2></div>
      <div class="hl-grid">${hl.map(([label, value, note, n]) => `<${n ? `a href="${replay(n)}"` : 'div'} class="hl"><span class="hl-l">${label}</span><span class="hl-v">${value}</span><span class="hl-n">${note}</span></${n ? 'a' : 'div'}>`).join('')}</div>
    </section>` : ''}

    <section class="panel">
      <div class="sec-head"><h2>Biggest hands</h2><span class="muted">Largest pot first</span></div>
      ${byPot.length ? `<div class="bh-list" data-bh>${byPot.slice(0, SHOW).map(bigRow).join('')}</div>
        ${byPot.length > SHOW ? `<button type="button" class="btn small" data-bh-all>Show all ${byPot.length} hands</button>` : ''}` : '<p class="muted">No hands were played.</p>'}
    </section>

    ${st && st.players && st.players.length ? `<section class="panel"><div class="sec-head"><h2>Stats</h2><span class="muted">${st.hands} hand${st.hands === 1 ? '' : 's'} in this game</span></div>
      ${statsTable(st, { me: me.user.id, fmt: (a) => fmtChips(a, 2), rowAttr: null })}
      ${glossaryHTML()}</section>` : ''}
  </article>`;
  const all = main.querySelector('[data-bh-all]');
  if (all) all.addEventListener('click', () => { main.querySelector('[data-bh]').innerHTML = byPot.map(bigRow).join(''); all.remove(); });
  const csv = main.querySelector('[data-csv-game]');
  if (csv) csv.addEventListener('click', async (e) => {
    e.preventDefault();
    try { await api.download(`/api/tables/${q}/ledger.csv`, `ledger-${id}.csv`); } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- the period for results and stats ----------
const PERIODS = [['all', 'All time'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['ytd', 'This year'], ['custom', 'Dates…']];

function periodPicker() {
  return `<span class="period" data-period-box><select data-period="period" aria-label="Period">${PERIODS.map(([k, l]) => `<option value="${k}" ${k === ui.period ? 'selected' : ''}>${l}</option>`).join('')}</select>${ui.period === 'custom'
    ? `<input type="date" data-period="from" value="${esc(ui.from)}" aria-label="From"><span class="muted">to</span><input type="date" data-period="to" value="${esc(ui.to)}" aria-label="To">` : ''}</span>`;
}

// The period as a range in ms: from its first moment up to (not including) the moment after it.
function periodRange() {
  const day = 864e5;
  const now = Date.now();
  if (ui.period === '7d' || ui.period === '30d' || ui.period === '90d') return { from: now - parseInt(ui.period, 10) * day, to: null };
  if (ui.period === 'ytd') return { from: new Date(new Date().getFullYear(), 0, 1).getTime(), to: null };
  if (ui.period === 'custom') {
    const at = (v, end) => { if (!v) return null; const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d + (end ? 1 : 0)).getTime(); };
    return { from: at(ui.from, false), to: at(ui.to, true) };
  }
  return { from: null, to: null };
}
const periodQuery = () => { const r = periodRange(); return `${r.from ? `&from=${r.from}` : ''}${r.to ? `&to=${r.to}` : ''}`; };
function periodLabel() {
  if (ui.period === 'custom') {
    const f = (v) => (v ? new Date(v + 'T00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');
    return ui.from || ui.to ? `${f(ui.from) || 'the start'} to ${f(ui.to) || 'today'}` : 'all time';
  }
  return (PERIODS.find(([k]) => k === ui.period) || PERIODS[0])[1].toLowerCase();
}

// Profit and loss over the period, every game added up, the biggest winner first.
// ---------- the Hands tab: every hand of every game ----------
// A table like the ledger: when, which game and hand, what was played (the games board's tags), the
// cards that can be seen, the pot and the result. The list comes from /api/clubs/:id/hands (amounts
// in cents, each member's own view of the cards) and is kept for a while; a row opens the replayer.
let handsData = null;
let handsAt = 0;
const HANDS_FRESH = 30000;
const RUN_WORDS = { any: 'Any runs', more: 'Run more than once', 1: 'Run once', 2: 'Run twice' };

async function loadHands(id) {
  const box = main.querySelector('[data-hands]');
  if (!box) return;
  const have = handsData && handsData.clubId === id;
  if (have) drawHands(box, id);
  if (have && Date.now() - handsAt < HANDS_FRESH) return;
  try {
    handsData = { ...(await api.get(`/api/clubs/${encodeURIComponent(id)}/hands`)), clubId: id };
    handsAt = Date.now();
  } catch (e) {
    if (!have) box.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    return;
  }
  const now = main.querySelector('[data-hands]');
  if (now) drawHands(now, id);
}

function drawHands(box, id) {
  const d = handsData;
  const h = ui.hands;
  const meId = d.me;
  const played = (uid) => d.hands.some((x) => x.nets[uid] !== undefined);
  if (h.who === null) h.who = played(meId) ? meId : '';
  if (h.who && !played(h.who)) h.who = '';
  if (h.session !== 'all' && !d.sessions.some((x) => x.id === h.session)) h.session = 'all';
  if (!d.hands.length) { box.innerHTML = '<p class="muted">No hands yet. Every hand of every game shows up here once it has been played.</p>'; return; }
  const F = (a) => fmtChips(a, 2);
  const signed = (n) => `<span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${n > 0 ? '+' : n < 0 ? '-' : ''}${F(Math.abs(n))}</span>`;
  const sessions = new Map(d.sessions.map((x) => [x.id, x]));
  const nameOf = (uid) => (uid === meId ? 'You' : d.names[uid] || 'Someone');
  const L = pickHands(d.hands, h);
  const shown = L.slice(0, h.limit);
  const opt = (pairs, val) => pairs.map(([k, l]) => `<option value="${esc(k)}" ${k === val ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const pick = (k, label, pairs) => `<select data-hk="${k}" aria-label="${label}">${opt(pairs, h[k])}</select>`;
  const people = Object.entries(d.names).filter(([uid]) => played(uid)).sort((a, b) => (a[0] === meId ? -1 : b[0] === meId ? 1 : a[1].localeCompare(b[1])));
  const games = [...new Set(d.hands.map((x) => x.gameType))];
  const runs = runChoices(d.hands).map(([k]) => [k, RUN_WORDS[k] || `Run ${k} times`]);
  // a player's total over the hands listed: your own, or anyone's for those who see the whole club
  const total = h.who && (d.seeAll || h.who === meId) && L.length ? L.reduce((sum, x) => sum + x.nets[h.who], 0) : null;
  // what the hand was, in the games board's tags
  const tags = (x) => `<span class="gb-gm ${GAME_HUE[x.gameType] || ''}">${esc(GAME_TYPES[x.gameType]?.short || x.gameType)}${x.doubleBoard ? '<i>DB</i>' : ''}</span>`
    + (x.isBomb ? `<span class="gb-x bomb" title="Bomb pot">${GB_ICON.bomb}Bomb</span>` : '')
    + (x.runCount > 1 ? `<span class="gb-x runs" title="Run ${x.runCount} times">${GB_ICON.runs}${x.runCount} runs</span>` : '')
    + (x.straddle ? '<span class="gb-x strad" title="Straddled">Straddle</span>' : '')
    + (x.bounty ? '<span class="gb-x s72" title="The 7-2 was paid"><span class="s72-cards" aria-hidden="true"><b>7</b><b>2</b></span>Paid</span>' : '');
  const cardsHTML = (cs) => (cs ? cs.map((cc) => (cc ? cardHTML(cc) : backHTML())).join('') : '');
  const day = (at) => new Date(at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  // who was dealt in: you first, then the others
  const players = (x) => Object.keys(x.nets).sort((a, b) => (a === meId ? -1 : b === meId ? 1 : 0)).map(nameOf).join(', ');
  // the pot, and who won it; or the chosen player's result over the pot; for the biggest wins and
  // losses with everyone, the biggest one and whose it was
  const result = (x) => {
    if (h.who) {
      const n = x.nets[h.who];
      return { cards: x.cards[h.who], big: n ? signed(n) : '<span class="faint">0</span>', small: `pot ${F(x.pot)}` };
    }
    if (h.sort === 'won' || h.sort === 'lost') {
      const n = resultOf(x, '', h.sort);
      const uid = Object.keys(x.nets).find((k) => x.nets[k] === n);
      return { cards: x.cards[uid], big: signed(n), small: `${nameOf(uid)}, pot ${F(x.pot)}` };
    }
    const w = topWinner(x);
    return { cards: w ? x.cards[w[0]] : null, big: F(x.pot), small: w ? `${nameOf(w[0])} won ${F(w[1])}` : '' };
  };
  const row = (x) => {
    const r = result(x);
    return `<li><button type="button" class="hd-row" data-hand="${esc(handKey(x))}">
      <span class="hd-cards">${cardsHTML(r.cards)}</span>
      <span class="hd-what"><span class="hd-when"><b>${esc(day(x.at))}</b><span class="hd-tags">${tags(x)}</span></span><small>${esc(players(x))}</small></span>
      <span class="hd-amt"><b>${r.big}</b><small>${esc(r.small)}</small></span>
    </button></li>`;
  };
  box.innerHTML = `
    <div class="sec-head tab-head">
      <span class="muted">${L.length} hand${L.length === 1 ? '' : 's'}${total !== null ? `, ${esc(nameOf(h.who))} <b>${signed(total)}</b>` : ''}</span>
      <div class="row hd-tools">
        ${pick('session', 'Session', [['all', 'All sessions'], ...d.sessions.map((x) => [x.id, `${x.name}, ${new Date(x.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}`])])}
        ${pick('who', 'Player', [['', 'Everyone'], ...people.map(([uid, nm]) => [uid, uid === meId ? 'You' : nm])])}
        ${pick('sort', 'Sort', SORTS)}
        ${pick('filter', 'Show', showChoices(d.hands))}
        ${runs.length ? pick('runs', 'Times run', runs) : ''}
        ${games.length > 1 ? pick('game', 'Game', [['all', 'All games'], ...games.map((g) => [g, GAME_TYPES[g]?.short || g])]) : ''}
        <a class="btn small" data-hands-tab href="/hands" target="_blank" rel="noopener">Open in new tab</a>
      </div>
    </div>
    ${L.length ? `<ul class="hd-list">${shown.map(row).join('')}</ul>
    ${L.length > shown.length ? `<div class="more"><button class="btn small ghost" data-hmore>Show ${Math.min(50, L.length - shown.length)} more of ${L.length - shown.length}</button></div>` : ''}`
    : '<p class="muted">No hands match.</p>'}`;
  // Open in new tab carries the choices over, as the replayer's own does
  const q = new URLSearchParams({ who: h.who || 'all' });
  for (const [k, def, name] of [['session', 'all', 'session'], ['sort', 'pot', 'sort'], ['filter', 'all', 'show'], ['runs', 'any', 'runs'], ['game', 'all', 'game']]) if (h[k] !== def) q.set(name, h[k]);
  box.querySelector('[data-hands-tab]').href = `/hands?${q}`;
  if (box._wired) return;
  box._wired = true;
  const open = async (key) => {
    const { historyDialog } = await import('./hand-history.js');
    applyPrefs();
    historyDialog({
      club: { id, data: handsData }, start: key,
      who: h.who || 'all', sort: h.sort, filter: h.filter, runs: h.runs, game: h.game, session: h.session,
      // the list here follows what was picked in the replayer
      onClose: (st) => {
        Object.assign(h, { session: st.session, who: st.who || '', sort: st.sort, filter: st.filter, runs: st.runs, game: st.game });
        if (box.isConnected) drawHands(box, id);
      },
    });
  };
  box.addEventListener('change', (e) => {
    const k = e.target.dataset.hk;
    if (!k) return;
    h[k] = e.target.value;
    h.limit = 50;
    drawHands(box, id);
  });
  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-hmore]')) { h.limit += 50; drawHands(box, id); return; }
    const row = e.target.closest('[data-hand]');
    if (row) open(row.dataset.hand);
  });
}

async function loadResults(id, c) {
  const body = main.querySelector('[data-results-body]');
  if (!body) return;
  let r;
  try { r = (await api.get(`/api/clubs/${encodeURIComponent(id)}/results?x=1${periodQuery()}`)).results; }
  catch (e) { body.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  const count = main.querySelector('[data-results-count]');
  if (count) count.textContent = `${r.games} game${r.games === 1 ? '' : 's'}, ${r.hands} hand${r.hands === 1 ? '' : 's'}, ${periodLabel()}`;
  const F = (a) => fmtChips(a, c.settings.decimals);
  const signed = (n) => (n === null || n === undefined ? '<span class="faint">-</span>' : `<span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${n > 0 ? '+' : ''}${F(n)}</span>`);
  const game = (g) => (g ? `<button type="button" class="linkish" data-result-game="${esc(g.tableId)}" title="${esc(g.name)}${g.at ? `, ${new Date(g.at).toLocaleDateString()}` : ''}">${signed(g.net)}<small> ${esc(g.name)}</small></button>` : '<span class="faint">-</span>');
  if (!r.players.length) { body.innerHTML = `<p class="muted">No hands ${ui.period === 'all' ? 'yet' : 'in this period'}.</p>`; return; }
  let rank = 0;
  body.innerHTML = `<div class="scroll-x"><table class="data results">
    <thead><tr><th class="n">#</th><th>Player</th><th class="n">Net</th><th class="n">Games</th><th class="n hide-sm">Won</th><th class="n hide-sm">Hands</th><th class="hide-sm">Best game</th><th class="hide-sm">Worst game</th><th class="hide-sm">Last played</th></tr></thead>
    <tbody>${r.players.map((p) => `<tr class="${p.userId === me.user.id ? 'mine' : ''}">
      <td class="n muted">${p.net === null ? '' : ++rank}</td>
      <td class="who"><b>${esc(p.name)}</b>${p.userId === me.user.id ? ' <span class="faint">(you)</span>' : ''}</td>
      <td class="n big">${signed(p.net)}</td><td class="n">${p.games}</td><td class="n hide-sm">${p.gamesWon ?? '<span class="faint">-</span>'}</td><td class="n hide-sm">${p.hands}</td>
      <td class="hide-sm">${game(p.best)}</td><td class="hide-sm">${game(p.worst)}</td><td class="hide-sm muted">${p.lastAt ? new Date(p.lastAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''}</td>
    </tr>`).join('')}</tbody></table></div>
    ${r.players.some((p) => p.net === null) ? '<p class="hint">Results of other members are shown to admins, or to everyone when the club settings allow it.</p>' : ''}`;
}

// ---------- invites (admins) ----------
const DAYS = [[1, '1 day'], [3, '3 days'], [7, '7 days'], [14, '14 days'], [30, '30 days']];

// ---------- the join link and the requests it brings ----------
const joinUrl = (j) => `${location.origin}/join/${j.token}`;

function joinLinkBox(j) {
  if (!j) {
    return `<div class="jl-off"><button type="button" class="btn primary" data-jl="on">Make a join link</button>
      <p class="hint">One link you can post in your group chat. Anyone who opens it can ask to join, and nobody gets in until you or an admin approve them.</p></div>`;
  }
  return `<div class="invite"><code>${esc(joinUrl(j))}</code><button type="button" class="btn small" data-jl="copy">Copy</button></div>
    <p class="hint">Anyone who opens it can ask to join. Requests wait on the club page until you or an admin approve them.</p>
    <div class="row jl-actions"><button type="button" class="btn small ghost" data-jl="new">Make a new link</button><button type="button" class="btn small ghost" data-jl="off">Turn it off</button></div>`;
}

// k: on, new, off or copy. done gets the link as it is now.
async function joinLinkAction(k, j, done) {
  if (k === 'copy') { if (j) copyText(joinUrl(j)); return; }
  if (k === 'new' && !(await confirmDialog('The link you have shared stops working and a new one takes its place.', { title: 'Make a new join link?', ok: 'Make a new link' }))) return;
  if (k === 'off' && !(await confirmDialog('Nobody can ask to join with it until you make a new one. People already waiting stay on the list.', { title: 'Turn off the join link?', ok: 'Turn it off', danger: true }))) return;
  try {
    const r = await api.post('/api/admin/join-link', { on: k !== 'off' });
    toast(k === 'off' ? 'Join link turned off' : k === 'new' ? 'New join link made' : 'Join link made');
    done(r.joinLink);
  } catch (x) { toast(x.message, 'error'); }
}

function requestRows(list) {
  return list.map((r) => `<div class="row req-row"><span class="grow"><b>${esc(r.name)}</b> <span class="faint">@${esc(r.username)}${r.email ? `, ${esc(r.email)}` : ''}</span><small class="muted"> asked ${timeAgo(r.requestedAt)} with the join link</small></span>
    <button type="button" class="btn small ghost" data-req="${esc(r.id)}" data-ok="0">Decline</button><button type="button" class="btn small primary" data-req="${esc(r.id)}" data-ok="1">Approve</button></div>`).join('');
}

async function decideRequest(btn, r, after) {
  const approve = btn.dataset.ok === '1';
  if (!approve && !(await confirmDialog(`${r ? r.name : 'They'} can ask again with the join link while it is on.`, { title: `Decline ${r ? r.name : 'this request'}?`, ok: 'Decline', danger: true }))) return;
  btn.disabled = true;
  try {
    await api.post(`/api/admin/requests/${encodeURIComponent(btn.dataset.req)}`, { approve });
    toast(approve ? `${r ? r.name : 'They'} can sign in now` : 'Request declined');
    after();
  } catch (x) { toast(x.message, 'error'); btn.disabled = false; }
}

// The page the join link opens: ask for an account, then wait for an admin.
async function joinPage(token) {
  head.innerHTML = `<a class="wordmark" href="/">${wordmarkHTML(30)}</a>`;
  document.title = 'Ask to join | The Aquarium';
  try { await api.get('/api/join/' + token); }
  catch (e) {
    main.innerHTML = `<section class="panel link-panel"><h1>This join link no longer works</h1><p class="muted">${esc(e.message)}</p><a class="btn" href="/">Sign in</a></section>`;
    return;
  }
  const field = (label, name, attrs = '') => `<label><span class="lbl">${label}</span><input name="${name}" ${attrs}></label>`;
  main.innerHTML = `<section class="panel link-panel">
    <h1>Ask to join The Aquarium</h1>
    <p class="lead">A private poker game. Choose your name at the table, a username and a password. An admin approves each new player, and then you sign in with your username and password on any device.</p>
    ${api.token ? '<p class="hint">This browser is signed in to an account already. Asking here does not change it.</p>' : ''}
    <form class="stack" data-join novalidate>
      ${field('Your name at the table', 'name', 'type="text" maxlength="24" required')}
      ${field('Username', 'username', 'type="text" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="20" required')}
      <p class="hint field-hint">3 to 20 letters, numbers, dots, dashes or underscores. You sign in with it.</p>
      ${field('Password', 'password', 'type="password" autocomplete="new-password" minlength="8" required')}
      <p class="hint field-hint">At least 8 characters.</p>
      ${field('Email (optional)', 'email', 'type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false"')}
      <p class="hint field-hint">Only used to send you a password reset link.</p>
      <p class="bad hidden" data-err role="alert"></p>
      <button class="btn primary big" type="submit">Ask to join</button>
    </form>
  </section>`;
  const f = main.querySelector('[data-join]');
  const err = main.querySelector('[data-err]');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.add('hidden');
    const v = (n) => f.elements[n].value.trim();
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await api.post('/api/join/' + token, { name: v('name'), username: v('username'), password: f.elements.password.value, email: v('email') || undefined });
      main.innerHTML = `<section class="panel link-panel"><h1>Request sent</h1>
        <p class="lead">An admin of The Aquarium will look at it. Once they approve it, sign in as <b>${esc(r.username)}</b> with the password you chose.</p>
        <a class="btn primary" href="/">Go to sign in</a></section>`;
    } catch (x) {
      err.textContent = x.message;
      err.classList.remove('hidden');
      btn.disabled = false;
    }
  });
}
const longDay = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

// After an invite or reset link is made: say whether it was emailed, and offer the link either way.
function linkResult(dlg, r, { what = 'Invite', again = null } = {}) {
  const subject = what === 'Invite' ? `${me.user.name} invited you to The Aquarium` : 'Set a new password for The Aquarium';
  const body = what === 'Invite'
    ? `${me.user.name} invited you to The Aquarium, a private poker game. Create your account here (the link works once):\n\n${r.link}`
    : `Here is a link to set a new password for The Aquarium (it works once):\n\n${r.link}`;
  const mailto = r.email ? `mailto:${encodeURIComponent(r.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : null;
  dlg.setBody(`<div class="stack">
    ${r.sent
      ? `<p class="sent-note">${what} sent to <b>${esc(r.email)}</b>. The link works once and expires ${esc(longDay(r.expiresAt))}.</p>`
      : `<p>${esc(r.error || 'Email is not set up yet, so send this link yourself.')}</p>`}
    <div class="invite"><code class="grow">${esc(r.link)}</code><button class="btn small" data-copy>Copy</button></div>
    ${!r.sent && mailto ? '<p class="hint">Or open it in your own email app, ready to send.</p>' : ''}
  </div>`);
  dlg.el.querySelector('.dlg-foot').innerHTML = `${again ? '<button class="btn ghost" data-again>Invite someone else</button>' : ''}${!r.sent && mailto ? `<a class="btn" href="${esc(mailto)}">Open in my email app</a>` : ''}<button class="btn primary" data-close>Done</button>`;
  dlg.$('[data-copy]').addEventListener('click', () => copyText(r.link));
  dlg.$('[data-again]')?.addEventListener('click', () => { dlg.close(); again(); });
}

async function inviteDialog({ onDone = null } = {}) {
  let jl = { joinLink: null, mail: true };
  try { jl = await api.get('/api/admin/join-link'); } catch { /* the email invite still works */ }
  const joinSec = `<section class="inv-join"><h3 class="section-title">Share a join link</h3><div data-jlbox>${joinLinkBox(jl.joinLink)}</div></section>`;
  const dlg = dialog({
    title: 'Invite people', className: 'narrow',
    body: `${jl.mail ? '' : joinSec}
    <h3 class="section-title">${jl.mail ? 'Invite someone by email' : 'Or invite one person'}</h3>
    ${jl.mail ? '' : '<p class="hint">Email is not set up, so this makes a link you send yourself. It works once, for that email address.</p>'}
    <form class="stack" id="invform" novalidate>
      <label><span class="lbl">Their email</span><input name="email" type="email" inputmode="email" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>
      <label><span class="lbl">Their name (optional)</span><input name="name" type="text" maxlength="24" placeholder="Shown in the email"></label>
      <label><span class="lbl">The link works for</span><select name="days">${DAYS.map(([d, l]) => `<option value="${d}" ${d === 7 ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <p class="hint">The link works once, only for this email address. They choose their own username and password, and join the club straight away.</p>
      <p class="bad hidden" data-err role="alert"></p>
    </form>
    ${jl.mail ? joinSec : ''}`,
    foot: '<button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-send>Send invite</button>',
    onClose: () => onDone && onDone(),
  });
  dlg.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-jl]');
    if (b) joinLinkAction(b.dataset.jl, jl.joinLink, (j) => { jl.joinLink = j; dlg.$('[data-jlbox]').innerHTML = joinLinkBox(j); });
  });
  const f = dlg.$('#invform');
  const send = async () => {
    const err = dlg.$('[data-err]');
    err.classList.add('hidden');
    const btn = dlg.$('[data-send]');
    btn.disabled = true;
    btn.textContent = 'Sending';
    try {
      const r = await api.post('/api/admin/invites', {
        email: f.elements.email.value.trim(), name: f.elements.name.value.trim() || undefined,
        days: Number(f.elements.days.value),
      });
      linkResult(dlg, r, { again: () => inviteDialog({ onDone }) });
    } catch (x) {
      err.textContent = x.message;
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Send invite';
    }
  };
  dlg.$('[data-send]').addEventListener('click', send);
  f.addEventListener('submit', (e) => { e.preventDefault(); send(); });
  setTimeout(() => f.elements.email.focus(), 30);
}

// ---------- invite, owner setup and reset pages ----------
async function linkPage(token) {
  head.innerHTML = `<a class="wordmark" href="/">${wordmarkHTML(30)}</a>`;
  let info;
  try { info = await api.get('/api/links/' + token); }
  catch (e) {
    main.innerHTML = `<section class="panel link-panel"><h1>This link no longer works</h1>
      <p class="muted">${esc(e.message)}</p><a class="btn" href="/">Sign in</a></section>`;
    return;
  }
  const field = (label, name, attrs = '') => `<label><span class="lbl">${label}</span><input name="${name}" ${attrs}></label>`;
  const account = (nameValue = '') => `
    ${field('Your name at the table', 'name', `type="text" maxlength="24" value="${esc(nameValue)}" required`)}
    ${field('Username', 'username', 'type="text" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="20" required')}
    <p class="hint field-hint">3 to 20 letters, numbers, dots, dashes or underscores. You sign in with it.</p>
    ${field('Password', 'password', 'type="password" autocomplete="new-password" minlength="8" required')}
    <p class="hint field-hint">At least 8 characters.</p>`;
  let title;
  let lead;
  let form;
  let button;
  if (info.kind === 'join') {
    document.title = 'You are invited | The Aquarium';
    title = `${esc(info.invitedBy || 'An admin')} invited you to The Aquarium`;
    lead = 'A private poker game. Choose a username and password to sign in with on any device.';
    form = `<div><span class="lbl">Email</span><b>${esc(info.email)}</b></div>${account(info.name || '')}`;
    button = 'Create my account';
  } else if (info.kind === 'owner') {
    document.title = 'Set up | The Aquarium';
    title = 'Set up The Aquarium';
    lead = 'This link makes you the owner. You choose who is an admin, and you and your admins invite everyone else.';
    form = `${field('Your email', 'email', 'type="email" autocomplete="email" autocapitalize="none" spellcheck="false" required')}
      <p class="hint field-hint">Password reset links are sent here.</p>${account()}`;
    button = 'Create the owner account';
  } else {
    document.title = 'New password | The Aquarium';
    title = 'Set a new password';
    lead = `For ${info.name ? `${esc(info.name)}, ` : ''}username <b>${esc(info.username)}</b>. Every device signed in to this account is signed out.`;
    form = `${field('New password', 'password', 'type="password" autocomplete="new-password" minlength="8" required')}
      ${field('Type it again', 'password2', 'type="password" autocomplete="new-password" minlength="8" required')}`;
    button = 'Save the new password';
  }
  main.innerHTML = `<section class="panel link-panel">
    <h1>${title}</h1>
    <p class="lead">${lead}</p>
    ${api.token && info.kind !== 'reset' ? '<p class="hint">This browser is signed in to an account already. Finishing here signs it in to this one instead.</p>' : ''}
    <form class="stack" data-accept novalidate>
      ${form}
      <p class="bad hidden" data-err role="alert"></p>
      <button class="btn primary big" type="submit">${button}</button>
    </form>
    ${info.kind === 'owner' ? `<details class="claim"><summary>I already have an account here</summary>
      <form class="stack" data-claim>${field('Username', 'username', 'type="text" autocomplete="username" autocapitalize="none" required')}${field('Password', 'password', 'type="password" autocomplete="current-password" required')}
        <button class="btn" type="submit">Make this account the owner</button></form></details>` : ''}
    <p class="hint">This link works once and expires ${esc(longDay(info.expiresAt))}.</p>
  </section>`;
  const err = main.querySelector('[data-err]');
  const finish = (r) => {
    api.token = r.token;
    location.replace('/');
  };
  const submit = async (payload, btn) => {
    err.classList.add('hidden');
    btn.disabled = true;
    try { finish(await api.post('/api/links/' + token, payload)); }
    catch (x) { err.textContent = x.message; err.classList.remove('hidden'); btn.disabled = false; }
  };
  main.querySelector('[data-accept]').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const btn = e.target.querySelector('button[type=submit]');
    if (info.kind === 'reset') {
      if (f.password.value !== f.password2.value) { err.textContent = 'The two passwords are different.'; err.classList.remove('hidden'); return; }
      return submit({ password: f.password.value }, btn);
    }
    submit({ name: f.name.value.trim(), username: f.username.value.trim(), password: f.password.value, email: f.email ? f.email.value.trim() : undefined }, btn);
  });
  main.querySelector('[data-claim]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    submit({ existing: { username: f.username.value.trim(), password: f.password.value } }, e.target.querySelector('button'));
  });
  setTimeout(() => main.querySelector('[data-accept] input:not([type=hidden])')?.focus(), 30);
}

// Takes someone out of the club after saying what that does, and what happens to a balance that is
// not zero (it is settled, and the ledger says so). m: the member as the club page lists it, with the
// balance and the chips on tables that admins see. Resolves to whether they were removed.
async function removeFromClub(clubId, m, F) {
  if (m.onTables > 0) {
    toast(`${m.name} is sitting in a game. Take them off the table first (Players, in the game's menu), then remove them.`, 'error');
    return false;
  }
  const bal = m.balance || 0;
  const money = bal > 0 ? ` ${m.name} has ${F(bal)} with the club: removing them settles it, and the ledger records it as paid out to them.`
    : bal < 0 ? ` ${m.name} owes the club ${F(-bal)}: removing them settles it, and the ledger records the debt as paid.` : '';
  const ok = await confirmDialog(`${m.name} is signed out and can no longer open The Aquarium. Their past hands and ledger entries stay, and you can bring them back from the People page.${money}`,
    { title: `Remove ${m.name} from the club?`, ok: `Remove ${m.name}`, danger: true });
  if (!ok) return false;
  try {
    await api.post(`/api/clubs/${clubId}/members/${encodeURIComponent(m.userId)}/remove`, { settle: bal !== 0 });
    toast(`${m.name} was removed from the club`);
    return true;
  } catch (x) { toast(x.message, 'error'); return false; }
}

// ---------- people (admins) ----------
const STATUS = { pending: 'Waiting', used: 'Joined', expired: 'Expired', revoked: 'Cancelled' };

async function adminPage() {
  unwatch();
  document.title = 'People | The Aquarium';
  let data;
  try { data = await api.get('/api/admin/people'); }
  catch (e) { main.innerHTML = `<section class="panel link-panel"><h1>Admins only</h1><p class="muted">${esc(e.message)}</p><a href="/">Back to the club</a></section>`; return; }
  const owner = data.me.role === 'owner';
  const ago = (t) => (t ? timeAgo(t) : '<span class="faint">never</span>');
  const role = (u) => `${u.role === 'member' ? 'Member' : `<span class="role">${u.role}</span>`}${u.removed ? ' <span class="off">removed</span>' : u.disabled ? ' <span class="off">access off</span>' : ''}`;
  const waiting = data.invites.filter((i) => i.status === 'pending').length;
  main.innerHTML = `
    <section class="club-band admin-band">
      <div class="cb-name"><h1>People</h1><span class="muted">Only people with an account can open The Aquarium. Accounts come from invites and approved join requests.</span></div>
      <div class="cb-bal"><div><small>Accounts</small><b>${data.users.length}</b></div><div><small>Invites waiting</small><b>${waiting}</b></div></div>
      <button class="btn primary big" data-inv>Invite someone</button>
    </section>
    ${data.requests.length ? `<section class="panel waitlist"><div class="sec-head"><h2>Waiting for approval</h2><span class="muted">Asked to join with the join link</span></div>${requestRows(data.requests)}</section>` : ''}
    <div class="announce ${data.mail.on ? '' : 'warn'}">${data.mail.on
      ? `Invites and password reset links are emailed from ${esc(data.mail.from)}.`
      : 'Email is not set up yet, so after you invite someone you copy the link and send it yourself. To have the site send it from your Gmail, add SMTP_USER and SMTP_PASS on Render.'}</div>
    <section class="panel">
      <div class="sec-head"><h2>Join link</h2></div>
      <div data-jlbox>${joinLinkBox(data.joinLink)}</div>
    </section>
    <section class="panel">
      <div class="sec-head"><h2>Accounts</h2>${owner ? '<span class="muted">Open someone to make them an admin, reset their password or turn their access off.</span>' : '<span class="muted">Admins invite people and send members password reset links.</span>'}</div>
      <div class="scroll-x"><table class="data people"><thead><tr><th>Name</th><th class="hide-sm">Email</th><th>Role</th><th class="hide-sm">Joined</th><th class="hide-sm">Last seen</th><th><span class="sr">Actions</span></th></tr></thead><tbody>
      ${data.users.map((u) => `<tr class="${u.disabled ? 'is-off' : ''}"><td><b>${esc(u.name)}</b> <span class="faint">@${esc(u.username)}</span>${u.id === me.user.id ? ' <span class="faint">(you)</span>' : ''}</td>
        <td class="hide-sm muted">${esc(u.email || '')}</td><td>${role(u)}</td><td class="hide-sm muted">${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : ''}</td><td class="hide-sm muted">${ago(u.lastSeenAt)}</td>
        <td class="n"><button class="btn tiny" data-person="${esc(u.id)}">Open</button></td></tr>`).join('')}
      </tbody></table></div>
    </section>
    <section class="panel">
      <div class="sec-head"><h2>Invites</h2></div>
      ${data.invites.length ? `<div class="scroll-x"><table class="data invites"><thead><tr><th>Email</th><th class="hide-sm">From</th><th>Status</th><th><span class="sr">Actions</span></th></tr></thead><tbody>
      ${data.invites.map((i) => `<tr><td>${esc(i.email)}${i.name ? ` <span class="faint">${esc(i.name)}</span>` : ''}${i.sendError && i.status === 'pending' ? '<br><small class="bad">The email did not go through</small>' : ''}</td>
        <td class="hide-sm muted">${esc(i.createdBy || '')}</td>
        <td><span class="st st-${i.status}">${STATUS[i.status]}</span> <small class="muted">${i.status === 'pending' ? `until ${esc(longDay(i.expiresAt))}` : i.status === 'used' ? `as ${esc(i.usedBy || '')}` : ''}</small></td>
        <td class="n nowrap">${i.status === 'pending' || i.status === 'expired' || i.status === 'revoked' ? `<button class="btn tiny" data-renew="${esc(i.id)}">${i.status === 'pending' ? 'Send again' : 'New invite'}</button>` : ''}${i.status === 'pending' ? ` <button class="btn tiny ghost" data-revoke="${esc(i.id)}">Cancel</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No invites yet. Use Invite someone to send the first one.</p>'}
    </section>`;

  main.onclick = async (e) => {
    if (e.target.closest('[data-inv]')) return inviteDialog({ onDone: () => location.pathname === '/admin' && adminPage() });
    const jb = e.target.closest('[data-jl]');
    if (jb) return joinLinkAction(jb.dataset.jl, data.joinLink, () => adminPage());
    const rq = e.target.closest('[data-req]');
    if (rq) return decideRequest(rq, data.requests.find((x) => x.id === rq.dataset.req), () => adminPage());
    const p = e.target.closest('[data-person]');
    if (p) return personSheet(data.users.find((u) => u.id === p.dataset.person), owner);
    const rn = e.target.closest('[data-renew]');
    if (rn) {
      const inv = data.invites.find((i) => i.id === rn.dataset.renew);
      const dlg = dialog({ title: `Invite ${inv.email}`, className: 'narrow', body: '<p class="muted">Making a new link</p>', foot: '<button class="btn primary" data-close>Done</button>', onClose: () => adminPage() });
      try { linkResult(dlg, await api.post(`/api/admin/invites/${inv.id}/renew`, { days: 7 })); }
      catch (x) { dlg.setBody(`<p class="bad">${esc(x.message)}</p>`); }
      return;
    }
    const rv = e.target.closest('[data-revoke]');
    if (rv) {
      const inv = data.invites.find((i) => i.id === rv.dataset.revoke);
      if (!(await confirmDialog(`The invite link for ${inv.email} stops working.`, { title: 'Cancel this invite?', ok: 'Cancel the invite', danger: true }))) return;
      try { await api.post(`/api/admin/invites/${inv.id}/revoke`); toast('Invite cancelled'); adminPage(); }
      catch (x) { toast(x.message, 'error'); }
    }
  };
}

function personSheet(u, viewerIsOwner) {
  const self = u.id === me.user.id;
  const canReset = !u.disabled && (viewerIsOwner || u.role === 'member' || self);
  const canManage = viewerIsOwner && u.role !== 'owner';
  const canRemove = !u.removed && !self && u.role !== 'owner' && (viewerIsOwner || u.role === 'member');
  const dlg = dialog({
    title: u.name, className: 'narrow',
    body: `<div class="stack">
      <div class="person-facts">
        <div><small>Username</small><b>@${esc(u.username)}</b></div>
        <div><small>Email</small><b>${esc(u.email || 'none')}</b></div>
        <div><small>Role</small><b>${u.role === 'owner' ? 'Owner' : u.role === 'admin' ? 'Admin' : 'Member'}${u.removed ? ', removed from the club' : u.disabled ? ', access off' : ''}</b></div>
        <div><small>Invited by</small><b>${esc(u.invitedBy || 'nobody')}</b></div>
      </div>
      <div class="sheet-actions">
        ${canManage && !u.removed ? `<button class="btn" data-a="role">${u.role === 'admin' ? 'Make them a member' : 'Make them an admin'}</button>` : ''}
        ${canReset ? `<button class="btn" data-a="reset">${u.email ? 'Email a password reset link' : 'Make a password reset link'}</button>` : ''}
        ${canManage ? `<button class="btn ${u.disabled ? '' : 'danger'}" data-a="access">${u.removed ? 'Bring them back' : u.disabled ? 'Turn their access back on' : 'Turn their access off'}</button>` : ''}
        ${canRemove ? '<button class="btn danger" data-a="remove">Remove from the club</button>' : ''}
      </div>
      ${!canManage && !viewerIsOwner && u.role !== 'member' ? '<p class="hint">Only the owner changes admins.</p>' : ''}
      ${canManage ? `<p class="hint">Admins invite people, send members password reset links, start games and look after the club ledger. ${u.removed
    ? 'Bringing them back turns their access on and puts them back in the club, with a zero balance.'
    : 'Turning access off signs them out everywhere and keeps their balance. Removing them also takes them off the club’s list, once their balance is settled.'}</p>` : ''}
    </div>`,
    foot: '<button class="btn primary" data-close>Done</button>',
  });
  dlg.el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    try {
      if (a === 'role') {
        await api.post(`/api/admin/users/${u.id}/role`, { role: u.role === 'admin' ? 'member' : 'admin' });
        toast(u.role === 'admin' ? `${u.name} is a member now` : `${u.name} is an admin now`);
        dlg.close();
        adminPage();
      }
      if (a === 'access') {
        if (!u.disabled && !(await confirmDialog(`${u.name} is signed out and cannot open The Aquarium until you turn their access back on.`, { title: 'Turn their access off?', ok: 'Turn access off', danger: true }))) return;
        await api.post(`/api/admin/users/${u.id}/access`, { enabled: !!u.disabled });
        toast(u.removed ? `${u.name} is back in the club` : u.disabled ? 'Access turned back on' : 'Access turned off');
        dlg.close();
        adminPage();
      }
      if (a === 'remove') {
        // the club page's list has the balance and the chips on tables
        const { club } = await api.get(`/api/clubs/${me.clubId}`);
        const m = club.members.find((x) => x.userId === u.id);
        if (!m) { toast(`${u.name} is not in the club`, 'error'); return; }
        dlg.close();
        if (await removeFromClub(me.clubId, m, (v) => fmtChips(v, club.settings.decimals))) adminPage();
      }
      if (a === 'reset') {
        const r = await api.post(`/api/admin/users/${u.id}/reset`);
        dlg.el.querySelector('h2').textContent = `Password reset for ${u.name}`;
        linkResult(dlg, r, { what: 'Reset link' });
      }
    } catch (x) { toast(x.message, 'error'); }
  });
}

boot();
