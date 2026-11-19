// Home page: The Aquarium's balances, ledger, games and all-time stats, and Start a game (a pop-out,
// for admins). Also the invite, owner setup and password reset pages, and the admin page where people
// are invited and managed.
import { api, ensureIdentity, fmtChips, parseChips, toInput, BRAND_HEX } from './api.js';
import { esc, $, dialog, toast, confirmDialog, copyText, timeAgo } from './ui.js';
import { sealSVG } from './seal.js';
import { startGameDialog, formatShort } from './game-form.js';
import { statsTable, glossaryHTML, gameSeg } from './stats-view.js';
import { fmtMoney } from '/shared/money.js';
import { GAME_TYPES } from '/shared/cards.js';

const main = $('#main');
const head = $('#head');
let me = null;
let clubSocket = null;
let watching = null;
// view state that survives live refreshes of the club page
const ui = { sort: 'name', member: '', ledgerLimit: 15, statsGame: 'all' };
const isAdmin = () => me && (me.user.role === 'owner' || me.user.role === 'admin');

async function boot() {
  const link = location.pathname.match(/^\/(invite|reset)\/([0-9a-f]{64})$/);
  if (link) return linkPage(link[2]);
  try { me = await ensureIdentity(); }
  catch (e) { main.innerHTML = `<p class="bad">${esc(e.message)}</p>`; return; }
  const next = new URLSearchParams(location.search).get('next');
  if (next && /^\/(?!\/)/.test(next)) { location.replace(next); return; }
  renderHead();
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
  head.innerHTML = `<a class="wordmark" href="/">${sealSVG(BRAND_HEX, 30, 'The Aquarium')}<span>The <b>Aquarium</b></span></a>
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

// ---------- shared pieces ----------
const shortGames = (games) => (games || []).map((g) => GAME_TYPES[g]?.short || g).join(' / ');

function board(tables, empty = 'No tables yet.') {
  if (!tables || !tables.length) return `<div class="empty">${esc(empty)}</div>`;
  return tables.map((t) => {
    const F = (a) => fmtMoney(a, t.decimals);
    let status = t.status === 'ended' ? `Ended ${timeAgo(t.endedAt || t.createdAt)}` : t.status === 'waiting' ? 'Waiting to start' : t.paused ? 'Paused' : 'Running';
    if (t.status === 'running' && t.endsAt) status += `, ends ${new Date(t.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const extra = t.bombMode && t.bombMode !== 'off' && t.status !== 'ended' ? ' with bomb pots' : '';
    const who = t.names.length ? `. ${t.status === 'ended' ? '' : 'Playing: '}${t.names.join(', ')}` : '';
    return `<a href="/t/${esc(t.id)}" class="${t.status === 'ended' ? 'ended' : ''}"><span class="g">${esc(t.format ? formatShort(t.format) : shortGames(t.games))}</span><span class="stakes">${F(t.smallBlind)}/${F(t.bigBlind)}</span>
      <span class="nm"><b>${esc(t.name)}</b><small>${esc(status + extra + who)}</small></span>
      <span class="seats"><b>${t.players}</b> of ${t.maxPlayers}</span></a>`;
  }).join('');
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
    clubSocket.on('connect_error', (e) => { if (e.message === 'moved') location.reload(); });
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
  const live = data.tables.filter((t) => t.status !== 'ended');
  const past = data.tables.filter((t) => t.status === 'ended');
  const money = (n) => (n === undefined ? '<span class="faint">-</span>' : `<span class="${n < 0 ? 'neg' : ''}">${F(n)}</span>`);
  const signed = (n) => (n === undefined ? '<span class="faint">-</span>' : `<span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${n > 0 ? '+' : ''}${F(n)}</span>`);
  const members = c.members.slice().sort((a, b) => (ui.sort === 'net' ? (b.net ?? -1e18) - (a.net ?? -1e18) : ui.sort === 'balance' ? (b.balance ?? -1e18) - (a.balance ?? -1e18) : 0));
  if (ui.member && !c.members.some((m) => m.userId === ui.member)) ui.member = '';
  const txs = c.transactions.filter((t) => !ui.member || t.userId === ui.member);
  const shown = txs.slice(0, ui.ledgerLimit);
  const when = (at) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  main.innerHTML = `
    <section class="club-band">
      <div class="cb-name">
        <h1>${esc(c.name)}</h1>
        <span class="muted">${roleLabel}, ${c.members.length} member${c.members.length === 1 ? '' : 's'}</span>
      </div>
      <div class="cb-bal">
        <div><small>Your balance</small><b class="${c.me.balance < 0 ? 'neg' : ''}">${F(c.me.balance)}</b></div>
        <div><small>Credit limit</small><b>${F(c.me.creditLimit)}</b></div>
        <div><small>Available to play</small><b>${F(Math.max(0, c.me.available))}</b></div>
      </div>
      ${c.isManager ? '<div class="cb-start"><button class="btn primary big" data-start>Start a game</button><div class="quick-start hidden" data-quick></div></div>' : ''}
    </section>
    ${c.announcement ? `<div class="announce">${esc(c.announcement)}</div>` : ''}
    ${c.isManager && c.pending && c.pending.length ? `<section class="panel waitlist"><h2>Waiting to join</h2>
      ${c.pending.map((p) => `<div class="row" style="padding:6px 0"><b class="grow">${esc(p.name)}</b><span class="muted">${timeAgo(p.requestedAt)}</span><button class="btn small ghost" data-decide="${esc(p.userId)}" data-ok="0">Decline</button><button class="btn small primary" data-decide="${esc(p.userId)}" data-ok="1">Approve</button></div>`).join('')}</section>` : ''}

    <section class="panel">
      <h2>Games</h2>
      <div class="gboard">${board(live, c.isManager ? 'No game running. Start one and it shows up here for every member.' : 'No game running right now. An admin starts the games.')}</div>
      ${past.length ? `<details class="past"><summary>Past games (${past.length})</summary><div class="gboard">${board(past.slice(0, 20))}</div></details>` : ''}
    </section>

    <section class="panel" id="balances">
      <div class="sec-head"><h2>Balances</h2>
        <div class="row">
          ${c.seeAll ? `<div class="seg" role="group" aria-label="Sort members">${[['name', 'By role'], ['balance', 'By balance'], ['net', 'Leaderboard']].map(([k, l]) => `<button type="button" data-sort="${k}" class="${k === ui.sort ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}
          ${isAdmin() ? '<button class="btn small" data-invite>Invite players</button>' : ''}
        </div>
      </div>
      ${c.totals ? `<div class="totals">
        <div><small>Held by members</small><b>${F(c.totals.held)}</b></div>
        <div><small>Owed to the club</small><b class="${c.totals.owed < 0 ? 'neg' : ''}">${F(c.totals.owed)}</b></div>
        <div><small>On tables now</small><b>${F(c.totals.onTables)}</b></div>
        <div><small>Net balance</small><b>${F(c.totals.balances)}</b></div></div>` : ''}
      <div class="scroll-x wide-only"><table class="data balances"><thead><tr><th>Member</th><th class="n">Balance</th><th class="n hide-sm">Credit limit</th><th class="n">Available</th><th class="n hide-sm">On tables</th><th class="n">Net from play</th>${c.isManager ? '<th><span class="sr">Actions</span></th>' : ''}</tr></thead>
      <tbody>${members.map((m) => `<tr class="${m.userId === me.user.id ? 'me' : ''}"><td><button type="button" class="linkish" data-mm="${esc(m.userId)}" ${c.isManager || m.userId === me.user.id ? '' : 'disabled'}>${esc(m.name)}</button>${m.userId === me.user.id ? ' <span class="faint">(you)</span>' : ''}${m.role !== 'member' ? ` <span class="role">${m.role === 'manager' ? 'admin' : m.role}</span>` : ''}${m.off ? ' <span class="off">access off</span>' : ''}</td>
        <td class="n bal">${money(m.balance)}</td><td class="n hide-sm">${m.creditLimit === undefined ? '<span class="faint">-</span>' : F(m.creditLimit)}</td><td class="n">${m.available === undefined ? '<span class="faint">-</span>' : F(Math.max(0, m.available))}</td>
        <td class="n hide-sm">${m.onTables === undefined ? '<span class="faint">-</span>' : F(m.onTables)}</td><td class="n">${signed(m.net)}</td>
        ${c.isManager ? `<td><div class="member-actions">
          <button class="btn tiny" data-m="chips" data-u="${esc(m.userId)}">Adjust</button>
          <button class="btn tiny" data-m="credit" data-u="${esc(m.userId)}">Credit</button>
          ${m.balance ? `<button class="btn tiny" data-m="settle" data-u="${esc(m.userId)}">Settle</button>` : ''}
        </div></td>` : ''}</tr>`).join('')}</tbody></table></div>
      <ul class="bal-list narrow-only">${members.map((m) => `<li><button type="button" class="bal-item ${m.userId === me.user.id ? 'me' : ''}" data-mm="${esc(m.userId)}" ${c.isManager || m.userId === me.user.id ? '' : 'disabled'}>
        <span class="bi-name"><b>${esc(m.name)}</b>${m.userId === me.user.id ? ' <span class="faint">(you)</span>' : ''}${m.role !== 'member' ? ` <span class="role">${m.role === 'manager' ? 'admin' : m.role}</span>` : ''}</span>
        <span class="bi-bal">${money(m.balance)}</span>
        ${m.balance === undefined ? '' : `<small class="bi-sub">Available ${F(Math.max(0, m.available))}${m.onTables ? `, ${F(m.onTables)} on tables` : ''}${m.creditLimit ? `, credit ${F(m.creditLimit)}` : ''}</small><small class="bi-net">${signed(m.net)}</small>`}
      </button></li>`).join('')}</ul>
      ${!c.seeAll ? '<p class="hint">Only admins see other members’ balances.</p>' : ''}
    </section>

    <section class="panel" id="ledger">
      <div class="sec-head"><h2>Ledger</h2>
        <div class="row">${c.seeAll ? `<select data-filter style="width:auto" aria-label="Show entries for"><option value="">Everyone</option>${c.members.map((m) => `<option value="${esc(m.userId)}" ${m.userId === ui.member ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>` : ''}
        <button class="btn small" data-csv>Download CSV</button></div>
      </div>
      ${shown.length ? `<div class="scroll-x wide-only"><table class="data"><thead><tr><th>When</th><th>Member</th><th>What</th><th class="n">Amount</th><th class="n">Balance after</th><th>By</th><th>Detail</th></tr></thead><tbody>
      ${shown.map((t) => `<tr><td class="muted nowrap">${when(t.at)}</td><td>${esc(t.name)}</td><td class="nowrap">${TX[t.type] || esc(t.type)}</td>
        <td class="n">${t.type === 'credit_limit' ? '' : signed(t.amount)}</td><td class="n">${F(t.balanceAfter)}</td>
        <td class="muted">${esc(t.byName || '')}</td><td class="muted">${esc(txDetail(t, F))}</td></tr>`).join('')}</tbody></table></div>
      <ul class="led-list narrow-only">${shown.map((t) => `<li>
        <div class="li-top"><b>${esc(t.name)}</b><span>${t.type === 'credit_limit' ? '' : signed(t.amount)}</span></div>
        <div class="li-sub"><span>${esc(txLine(t, F))}</span><span class="nowrap">${when(t.at)}</span></div>
      </li>`).join('')}</ul>
      ${txs.length > shown.length ? `<div class="more"><button class="btn small ghost" data-more>Show ${Math.min(50, txs.length - shown.length)} more of ${txs.length - shown.length}</button></div>` : ''}` : '<p class="muted">No entries yet. Money added, buy-ins, cash-outs and settlements show up here.</p>'}
    </section>

    <section class="panel" id="stats">
      <div class="sec-head"><h2>Stats</h2><span class="muted" data-stats-count></span></div>
      <div data-stats-body><p class="muted">Loading…</p></div>
    </section>

    <div class="club-foot">
      ${c.isManager ? '<button class="btn small" data-settings>Club settings</button>' : ''}
      ${c.settings.allowTransfers ? '<button class="btn small" data-transfer>Send money to a member</button>' : ''}
      <a class="btn small ghost" href="/verify">Shuffle verifier</a>
    </div>`;
  loadClubStats(id, c);

  const post = async (path, payload, done) => {
    try { await api.post(`/api/clubs/${id}${path}`, payload); if (done) toast(done); route(); return true; }
    catch (x) { toast(x.message, 'error'); return false; }
  };

  main.querySelector('[data-start]')?.addEventListener('click', () => openStart());
  if (c.isManager) loadQuickStart();
  main.querySelector('[data-filter]')?.addEventListener('change', (e) => { ui.member = e.target.value; ui.ledgerLimit = 15; clubHome(id); });
  main.querySelector('[data-csv]').addEventListener('click', () => api.download(`/api/clubs/${id}/transactions.csv`, `club-ledger-${c.name.replace(/[^\w-]+/g, '-')}.csv`).catch((x) => toast(x.message, 'error')));

  main.addEventListener('click', onClick);
  function onClick(e) {
    if (!main.contains(e.target)) return;
    const d = e.target.closest('[data-decide]');
    if (d) { post(`/members/${d.dataset.decide}/decide`, { approve: d.dataset.ok === '1' }); return; }
    const mm = e.target.closest('[data-mm]');
    if (mm) { const m = c.members.find((x) => x.userId === mm.dataset.mm); if (m) memberSheet(m); return; }
    const s = e.target.closest('[data-sort]');
    if (s) { ui.sort = s.dataset.sort; clubHome(id); return; }
    if (e.target.closest('[data-more]')) { ui.ledgerLimit += 50; clubHome(id); return; }
    if (e.target.closest('[data-invite]')) return inviteDialog();
    if (e.target.closest('[data-settings]')) return settingsDialog();
    if (e.target.closest('[data-transfer]')) return transferDialog();
    const sg = e.target.closest('#stats [data-game] button');
    if (sg) { ui.statsGame = sg.dataset.v; loadClubStats(id, c); return; }
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

  function memberSheet(m) {
    const mine = m.userId === me.user.id;
    const stat = (label, v) => `<div><small>${label}</small><b>${v}</b></div>`;
    const dlg = dialog({
      title: m.name, className: 'narrow',
      body: `<div class="stack">
        ${m.balance === undefined ? '<p class="muted">Only managers see this member’s balance.</p>' : `<div class="totals sheet">
          ${stat('Balance', money(m.balance))}${stat('Credit limit', F(m.creditLimit))}${stat('Available', F(Math.max(0, m.available)))}${stat('On tables', F(m.onTables))}${stat('Net from play', signed(m.net))}
        </div>`}
        <p class="muted">${m.role === 'owner' ? 'Owner' : m.role === 'manager' ? 'Admin' : 'Member'}${m.joinedAt ? `, joined ${new Date(m.joinedAt).toLocaleDateString()}` : ''}</p>
        ${c.isManager ? `<div class="sheet-actions">
          <button class="btn" data-a="chips">Add to or take from balance</button>
          <button class="btn" data-a="credit">Credit limit</button>
          ${m.balance ? '<button class="btn" data-a="settle">Settle up</button>' : ''}
        </div>` : ''}
      </div>`,
      foot: `<button class="btn ghost" data-a="entries">${mine ? 'Show my' : 'Show their'} ledger entries</button><button class="btn primary" data-close>Done</button>`,
    });
    dlg.el.addEventListener('click', async (ev) => {
      const a = ev.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      dlg.close();
      if (a === 'chips') memberChips(m);
      if (a === 'credit') memberCredit(m);
      if (a === 'settle') memberSettle(m);
      if (a === 'entries') {
        ui.member = m.userId;
        ui.ledgerLimit = 15;
        await clubHome(id);
        document.getElementById('ledger')?.scrollIntoView({ block: 'start' });
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

  function memberSettle(m) {
    const dlg = dialog({
      title: `Settle ${m.name}`, className: 'narrow',
      body: `<form class="stack"><p>${m.balance < 0 ? `${esc(m.name)} owes the club ${F(-m.balance)}.` : `The club owes ${esc(m.name)} ${F(m.balance)}.`} Settling records the payment and sets the balance to zero.</p>
        <label><span class="lbl">How it was paid</span><input name="note" placeholder="e.g. Cash, bank transfer"></label><button class="btn primary" type="submit">Record settlement</button></form>`,
    });
    dlg.$('form').addEventListener('submit', async (ev) => { ev.preventDefault(); if (await post(`/members/${m.userId}/settle`, { note: ev.target.elements.note.value }, 'Settlement recorded')) dlg.close(); });
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
      </form>`,
      foot: '<button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-save>Save settings</button>',
    });
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

// All-time stats on the club page, for one game type or all of them.
async function loadClubStats(id, c) {
  const body = main.querySelector('[data-stats-body]');
  if (!body) return;
  let st;
  try { st = (await api.get(`/api/clubs/${encodeURIComponent(id)}/stats?game=${encodeURIComponent(ui.statsGame)}`)).stats; }
  catch (e) { body.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  const count = main.querySelector('[data-stats-count]');
  if (count) count.textContent = `${st.hands} hand${st.hands === 1 ? '' : 's'}, every game`;
  const F = (a) => fmtChips(a, c.settings.decimals);
  body.innerHTML = `${st.games.length > 1 || ui.statsGame !== 'all' ? `<div class="stats-bar">${gameSeg(st.games, ui.statsGame)}</div>` : ''}
    ${statsTable(st, { me: me.user.id, fmt: F, rowAttr: null })}
    ${st.players.some((p) => p.net === null) ? '<p class="hint">Results of other members are shown to admins, or to everyone when the club settings allow it.</p>' : ''}
    ${glossaryHTML()}`;
}

// ---------- invites (admins) ----------
const DAYS = [[1, '1 day'], [3, '3 days'], [7, '7 days'], [14, '14 days'], [30, '30 days']];
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

function inviteDialog({ onDone = null } = {}) {
  const dlg = dialog({
    title: 'Invite someone', className: 'narrow',
    body: `<form class="stack" id="invform" novalidate>
      <label><span class="lbl">Their email</span><input name="email" type="email" inputmode="email" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>
      <label><span class="lbl">Their name (optional)</span><input name="name" type="text" maxlength="24" placeholder="Shown in the email"></label>
      <label><span class="lbl">The link works for</span><select name="days">${DAYS.map(([d, l]) => `<option value="${d}" ${d === 7 ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <p class="hint">The link works once, only for this email address. They choose their own username and password, and join the club straight away.</p>
      <p class="bad hidden" data-err role="alert"></p>
    </form>`,
    foot: '<button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-send>Send invite</button>',
    onClose: () => onDone && onDone(),
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
  head.innerHTML = `<a class="wordmark" href="/">${sealSVG(BRAND_HEX, 30, 'The Aquarium')}<span>The <b>Aquarium</b></span></a>`;
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
  const role = (u) => `${u.role === 'member' ? 'Member' : `<span class="role">${u.role}</span>`}${u.disabled ? ' <span class="off">access off</span>' : ''}`;
  const waiting = data.invites.filter((i) => i.status === 'pending').length;
  main.innerHTML = `
    <section class="club-band admin-band">
      <div class="cb-name"><h1>People</h1><span class="muted">Only people with an account can open The Aquarium. Accounts come from invites.</span></div>
      <div class="cb-bal"><div><small>Accounts</small><b>${data.users.length}</b></div><div><small>Invites waiting</small><b>${waiting}</b></div></div>
      <button class="btn primary big" data-inv>Invite someone</button>
    </section>
    <div class="announce ${data.mail.on ? '' : 'warn'}">${data.mail.on
      ? `Invites and password reset links are emailed from ${esc(data.mail.from)}.`
      : 'Email is not set up yet, so after you invite someone you copy the link and send it yourself. To have the site send it from your Gmail, add SMTP_USER and SMTP_PASS on Render.'}</div>
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
  const dlg = dialog({
    title: u.name, className: 'narrow',
    body: `<div class="stack">
      <div class="person-facts">
        <div><small>Username</small><b>@${esc(u.username)}</b></div>
        <div><small>Email</small><b>${esc(u.email || 'none')}</b></div>
        <div><small>Role</small><b>${u.role === 'owner' ? 'Owner' : u.role === 'admin' ? 'Admin' : 'Member'}${u.disabled ? ', access off' : ''}</b></div>
        <div><small>Invited by</small><b>${esc(u.invitedBy || 'nobody')}</b></div>
      </div>
      <div class="sheet-actions">
        ${canManage ? `<button class="btn" data-a="role">${u.role === 'admin' ? 'Make them a member' : 'Make them an admin'}</button>` : ''}
        ${canReset ? `<button class="btn" data-a="reset">${u.email ? 'Email a password reset link' : 'Make a password reset link'}</button>` : ''}
        ${canManage ? `<button class="btn ${u.disabled ? '' : 'danger'}" data-a="access">${u.disabled ? 'Turn their access back on' : 'Turn their access off'}</button>` : ''}
      </div>
      ${!canManage && !viewerIsOwner && u.role !== 'member' ? '<p class="hint">Only the owner changes admins.</p>' : ''}
      ${canManage ? '<p class="hint">Admins invite people, send members password reset links, start games and look after the club ledger. Turning access off signs them out everywhere; their balances stay as they are.</p>' : ''}
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
        toast(u.disabled ? 'Access turned back on' : 'Access turned off');
        dlg.close();
        adminPage();
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
