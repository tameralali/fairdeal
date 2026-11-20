// Home page: The Aquarium's balances, ledger, games and all-time stats, and Start a game (a pop-out,
// for admins). Also the invite, owner setup and password reset pages, and the admin page where people
// are invited and managed.
import { api, ensureIdentity, fmtChips, parseChips, toInput, BRAND_HEX } from './api.js';
import { esc, $, dialog, toast, confirmDialog, copyText, timeAgo } from './ui.js';
import { sealSVG } from './seal.js';
import { startGameDialog, formatShort, endGameText } from './game-form.js';
import { statsTable, glossaryHTML, gameSeg } from './stats-view.js';
import { fmtMoney } from '/shared/money.js';
import { GAME_TYPES } from '/shared/cards.js';

const main = $('#main');
const head = $('#head');
let me = null;
let clubSocket = null;
let watching = null;
// view state that survives live refreshes of the club page
const ui = { sort: 'name', member: '', ledgerLimit: 15, statsGame: 'all', period: 'all', from: '', to: '' };
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

// Each game opens in its own tab, so the club page stays open in this one. Admins can end a game here.
function board(tables, empty = 'No tables yet.', canEnd = false) {
  if (!tables || !tables.length) return `<div class="empty">${esc(empty)}</div>`;
  return tables.map((t) => {
    const F = (a) => fmtMoney(a, t.decimals);
    let status = t.status === 'ended' ? `Ended ${timeAgo(t.endedAt || t.createdAt)}` : t.ending ? 'Ending after this hand' : t.status === 'waiting' ? 'Waiting to start' : t.paused ? 'Paused' : 'Running';
    if (t.status === 'running' && t.endsAt && !t.ending) status += `, ends ${new Date(t.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const extra = t.bombMode && t.bombMode !== 'off' && t.status !== 'ended' && !t.ending ? ' with bomb pots' : '';
    const who = t.names.length ? `. ${t.status === 'ended' ? '' : 'Playing: '}${t.names.join(', ')}` : '';
    const end = canEnd && t.status !== 'ended' && !t.ending ? `<button type="button" class="btn small end" data-end="${esc(t.id)}" aria-label="End ${esc(t.name)}">End game</button>` : '';
    return `<div class="gb-row"><a href="/t/${esc(t.id)}" target="_blank" rel="noopener" class="${t.status === 'ended' ? 'ended' : ''}"><span class="g">${esc(t.format ? formatShort(t.format) : shortGames(t.games))}</span><span class="stakes">${F(t.smallBlind)}/${F(t.bigBlind)}</span>
      <span class="nm"><b>${esc(t.name)}</b><small>${esc(status + extra + who)}</small></span>
      <span class="seats"><b>${t.players}</b> of ${t.maxPlayers}</span></a>${end}</div>`;
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
    <a class="fair-band" href="/fair">${sealSVG(BRAND_HEX, 22, '')}<span><b>Every shuffle can be checked.</b> The code is public, every player's browser adds to the shuffle, and your browser checks each hand you play. See how it works.</span></a>
    ${c.isManager && ((c.pending && c.pending.length) || (c.requests && c.requests.length)) ? `<section class="panel waitlist"><h2>Waiting to join</h2>
      ${requestRows(c.requests || [])}
      ${(c.pending || []).map((p) => `<div class="row" style="padding:6px 0"><b class="grow">${esc(p.name)}</b><span class="muted">${timeAgo(p.requestedAt)}</span><button class="btn small ghost" data-decide="${esc(p.userId)}" data-ok="0">Decline</button><button class="btn small primary" data-decide="${esc(p.userId)}" data-ok="1">Approve</button></div>`).join('')}</section>` : ''}

    <section class="panel">
      <h2>Games</h2>
      <div class="gboard">${board(live, c.isManager ? 'No game running. Start one and it shows up here for every member.' : 'No game running right now. An admin starts the games.', c.isManager)}</div>
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

    <section class="panel" id="results">
      <div class="sec-head"><h2>Results</h2><span class="muted" data-results-count></span>${periodPicker()}</div>
      <div data-results-body><p class="muted">Loading…</p></div>
    </section>

    <section class="panel" id="stats">
      <div class="sec-head"><h2>Stats</h2><span class="muted" data-stats-count></span>${periodPicker()}</div>
      <div data-stats-body><p class="muted">Loading…</p></div>
    </section>

    <div class="club-foot">
      ${c.isManager ? '<button class="btn small" data-settings>Club settings</button>' : ''}
      ${c.settings.allowTransfers ? '<button class="btn small" data-transfer>Send money to a member</button>' : ''}
      <a class="btn small ghost" href="/fair">Fair dealing</a>
      <a class="btn small ghost" href="/verify">Shuffle verifier</a>
    </div>`;
  loadClubStats(id, c);
  loadResults(id, c);

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
  main.addEventListener('change', (e) => {
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
  });
  main.querySelector('[data-csv]').addEventListener('click', () => api.download(`/api/clubs/${id}/transactions.csv`, `club-ledger-${c.name.replace(/[^\w-]+/g, '-')}.csv`).catch((x) => toast(x.message, 'error')));

  main.addEventListener('click', onClick);
  function onClick(e) {
    if (!main.contains(e.target)) return;
    const end = e.target.closest('[data-end]');
    if (end) { endGame(end); return; }
    const rq = e.target.closest('[data-req]');
    if (rq) { decideRequest(rq, (c.requests || []).find((x) => x.id === rq.dataset.req), route); return; }
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
    const rg = e.target.closest('[data-result-game]');
    if (rg) { window.open(`/t/${encodeURIComponent(rg.dataset.resultGame)}`, '_blank', 'noopener'); return; }
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
        ${me.user.role === 'owner' && m.role !== 'owner' ? `<div class="role-pick"><span class="lbl">Role</span>
          <div class="seg" data-role role="group" aria-label="Role for ${esc(m.name)}"><button type="button" data-v="member" class="${m.role === 'manager' ? '' : 'on'}">Member</button><button type="button" data-v="admin" class="${m.role === 'manager' ? 'on' : ''}">Admin</button></div>
          <p class="hint">Members join and leave games with their balance and credit. Admins can also add to or take from balances, set credit limits, settle up, start and end games, approve people and send invites. Only you can change roles.</p>
        </div>` : ''}
        ${me.user.role === 'owner' && m.role !== 'owner' ? (m.joinedAt ? `<p class="muted">Joined ${new Date(m.joinedAt).toLocaleDateString()}</p>` : '') : `<p class="muted">${m.role === 'owner' ? 'Owner' : m.role === 'manager' ? 'Admin' : 'Member'}${m.joinedAt ? `, joined ${new Date(m.joinedAt).toLocaleDateString()}` : ''}</p>`}
        ${c.isManager ? `<div class="sheet-actions">
          <button class="btn" data-a="chips">Add to or take from balance</button>
          <button class="btn" data-a="credit">Credit limit</button>
          ${m.balance ? '<button class="btn" data-a="settle">Settle up</button>' : ''}
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
  head.innerHTML = `<a class="wordmark" href="/">${sealSVG(BRAND_HEX, 30, 'The Aquarium')}<span>The <b>Aquarium</b></span></a><a class="btn small ghost" href="/">${api.token ? 'Back to the club' : 'Sign in'}</a>`;
  let v = { commit: null, source: 'https://github.com/tameralali/fairdeal' };
  try { v = await api.get('/api/version'); } catch { /* the page still explains everything */ }
  const repo = esc(v.source);
  const commit = v.commit ? esc(v.commit.slice(0, 7)) : null;
  main.innerHTML = `<article class="panel fair-page">
    <h1>Fair dealing</h1>
    <p class="lead">You do not have to take anyone's word that the cards are random, the host's included. Every deal is sealed before anyone acts, every player's browser adds its own randomness to the shuffle, and every browser checks the hands it played on its own, against the seal it saw before the deal.</p>

    <section>
      <h2>The code is public</h2>
      <p>Everything that runs this site, the server that deals and the page in your browser, is public on GitHub: <a href="${repo}" target="_blank" rel="noopener">${repo.replace(/^https?:\/\//, '')}</a>. Anyone can read how the deck is shuffled and sealed, and what the checks below do.</p>
      ${commit ? `<p>This site is running <a href="${repo}/commit/${esc(v.commit)}" target="_blank" rel="noopener">commit ${commit}</a>, so you can read the exact version that is dealing right now.</p>` : ''}
      <p class="hint">You cannot look inside a server, so nothing here asks you to trust it. The checks below would catch a server that changed the deck, whatever code it ran.</p>
    </section>

    <section>
      <h2>How each hand is sealed</h2>
      <ol class="fair-steps">
        <li><b>Before the deal,</b> the server shuffles a deck with a secret and publishes a seal: a SHA-256 fingerprint of the whole deck. It shows at the top of the table as the round seal and "Hand sealed". Changing even one card afterwards would change the seal.</li>
        <li><b>Then every seated player's browser adds its own random number.</b> The final order of the deck depends on all of them. The server committed to its part before seeing yours, so it cannot steer any card to anyone.</li>
        <li><b>After the hand,</b> the server opens the seal: the boards, the cards that were shown, and every card nobody was dealt. Your own cards are opened to you. Folded cards can stay sealed for good, if the game is set that way.</li>
        <li><b>Your browser rebuilds the seal</b> from what was opened and checks that it matches the one it saw before the deal, that its own random number was used, and that your cards and every board came off that deck in order.</li>
      </ol>
    </section>

    <section>
      <h2>Checked for you, every hand</h2>
      <p>Your browser runs these checks by itself after every hand you play, and keeps count. At a table, open the seal at the top to see how many hands this browser has checked and whether any failed. Hand history, then Details, lists every check for one hand with a tick or a cross.</p>
    </section>

    <section>
      <h2>Check any hand yourself</h2>
      <p>The <a href="/verify">shuffle verifier</a> rebuilds a hand from its opened data using your browser's built-in cryptography, one hand or a whole game at a time. You can also download a hand from Hand history and check it with any SHA-256 tool, without this site at all.</p>
    </section>

    <section>
      <h2>What this proves, and what it does not</h2>
      <p><b>It proves</b> the deck was fixed before anyone acted, nobody could change or pick cards once the deal started (not the host, not the server), every card came off that deck in order, and every player's randomness was part of the shuffle. If the server dropped a player's random number or swapped the deck, that player's browser would show the check as failed.</p>
      <p><b>It does not prove</b> that whoever runs the server cannot read the cards in its memory during a hand. That is true of every online poker site, PokerNow included. Closing that gap takes a much slower kind of protocol, where no single computer ever knows the deck.</p>
    </section>

    <div class="row fair-links"><a class="btn primary" href="/verify">Open the shuffle verifier</a><a class="btn" href="${repo}" target="_blank" rel="noopener">Read the code on GitHub</a></div>
  </article>`;
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
  head.innerHTML = `<a class="wordmark" href="/">${sealSVG(BRAND_HEX, 30, 'The Aquarium')}<span>The <b>Aquarium</b></span></a>`;
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
