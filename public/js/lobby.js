// Home page. With a club: the club's balances and ledger, its tables, and Start a game (a pop-out).
// Without one: Start a game, your tables, and joining or creating a club. Also invite links.
import { api, ensureIdentity, identityDialog, accountDialog, fmtChips, parseChips, toInput } from './api.js';
import { esc, $, dialog, toast, confirmDialog, copyText, timeAgo } from './ui.js';
import { sealSVG } from './seal.js';
import { startGameDialog, formatShort } from './game-form.js';
import { GAME_TYPES } from '/shared/cards.js';

const BRAND_HEX = '6f3ac1d0a85c2e94b7f1036d4e5a9c8b21f0e7d6c5b4a39281706f5e4d3c2b1a';
const CLUB_KEY = 'aq:club';
const main = $('#main');
const head = $('#head');
let me = null;
let clubSocket = null;
let watching = null;
// view state that survives live refreshes of the club page
const ui = { sort: 'name', member: '', ledgerLimit: 30 };

async function boot() {
  try { me = await ensureIdentity(); }
  catch (e) { main.innerHTML = `<p class="bad">${esc(e.message)}</p>`; return; }
  renderHead();
  route();
}

function route() {
  const path = location.pathname;
  let m;
  if ((m = path.match(/^\/club\/([^/]+)/))) return clubHome(decodeURIComponent(m[1]));
  if ((m = path.match(/^\/join\/([^/]+)/))) return joinPage(decodeURIComponent(m[1]));
  return home();
}
window.addEventListener('popstate', route);

function go(url) { history.pushState(null, '', url); route(); }

function renderHead() {
  const u = me.user;
  head.innerHTML = `<a class="wordmark" href="/">${sealSVG(BRAND_HEX, 30, 'The Aquarium')}<span>The <b>Aquarium</b></span></a>
    <div class="who"><span><span class="pre">Playing as </span><b>${esc(u.name)}</b>${u.username ? ` <span class="faint uname">@${esc(u.username)}</span>` : ''}</span>
      <button class="btn small ghost" data-h="rename">Change name</button>
      ${u.username ? '<button class="btn small ghost" data-h="logout">Sign out</button>' : '<button class="btn small" data-h="register">Create account</button><button class="btn small ghost" data-h="login">Sign in</button>'}
    </div>`;
}

head.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-h]');
  if (!b) return;
  const k = b.dataset.h;
  if (k === 'register') {
    const u = await accountDialog(me.user);
    if (u) { me = await api.get('/api/me'); renderHead(); route(); toast('Account created'); }
  }
  if (k === 'login') {
    await identityDialog({ mode: 'login', closable: true });
    me = await api.get('/api/me');
    renderHead();
    route();
  }
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
    const F = (a) => fmtChips(a, t.decimals);
    let status = t.status === 'ended' ? `Ended ${timeAgo(t.endedAt || t.createdAt)}` : t.status === 'waiting' ? 'Waiting to start' : t.paused ? 'Paused' : 'Running';
    if (t.status === 'running' && t.endsAt) status += `, ends ${new Date(t.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const extra = t.bombMode && t.bombMode !== 'off' && t.status !== 'ended' ? ' with bomb pots' : '';
    const who = t.names.length ? `. ${t.status === 'ended' ? '' : 'Playing: '}${t.names.join(', ')}` : '';
    return `<a href="/t/${esc(t.id)}" class="${t.status === 'ended' ? 'ended' : ''}"><span class="g">${esc(t.format ? formatShort(t.format) : shortGames(t.games))}</span><span class="stakes">${F(t.smallBlind)}/${F(t.bigBlind)}</span>
      <span class="nm"><b>${esc(t.name)}</b><small>${esc(status + extra + who)}</small></span>
      <span class="seats"><b>${t.players}</b> of ${t.maxPlayers}</span></a>`;
  }).join('');
}

const managedClubs = () => me.clubs.filter((c) => c.status === 'active' && (c.role === 'owner' || c.role === 'manager')).map((c) => ({ id: c.id, name: c.name, decimals: c.decimals }));
const openStart = (clubId = null) => startGameDialog({ user: me.user, clubs: managedClubs(), clubId });

function clubForms() {
  return `<div class="stack-sm">
    <form data-joinclub class="row"><input name="code" placeholder="Invite code" aria-label="Invite code" style="max-width:190px" autocapitalize="characters"><button class="btn" type="submit">Join club</button></form>
    <form data-newclub class="row"><input name="cname" placeholder="New club name" aria-label="New club name" style="max-width:220px"><select name="decimals" style="width:auto" aria-label="Chip amounts"><option value="0">Whole chips</option><option value="2">Two decimals</option></select><button class="btn" type="submit">Create club</button></form>
    ${me.user.username ? '' : '<p class="hint">Clubs need an account, so a balance belongs to you and not to this browser. Use Create account at the top.</p>'}
  </div>`;
}

function bindClubForms(root, after = () => {}) {
  root.querySelector('[data-joinclub]').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = e.target.elements.code.value.trim();
    if (code) { after(); go('/join/' + encodeURIComponent(code)); }
  });
  root.querySelector('[data-newclub]').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/api/clubs', { name: e.target.elements.cname.value, decimals: Number(e.target.elements.decimals.value) });
      me = await api.get('/api/me');
      after();
      go('/club/' + r.id);
    } catch (x) { toast(x.message, 'error'); }
  });
}

// ---------- home ----------
async function home() {
  me = await api.get('/api/me');
  const active = me.clubs.filter((c) => c.status === 'active');
  if (active.length) {
    let saved = null;
    try { saved = localStorage.getItem(CLUB_KEY); } catch { /* storage blocked */ }
    return clubHome((active.find((c) => c.id === saved) || active[0]).id);
  }
  unwatch();
  document.title = 'The Aquarium';
  const pending = me.clubs.filter((c) => c.status === 'pending');
  main.innerHTML = `<div class="lob-grid">
    <div>
      <section class="panel start-panel">
        <h2>Start a game</h2>
        <p class="lead">Choose the format, stakes and bomb pots, then send the table link to your players. Every player's browser checks every deal.</p>
        <button class="btn primary big" data-start>Start a game</button>
      </section>
      <section class="panel"><h2>Your tables</h2><div class="gboard">${board(me.tables, 'Tables you host or play at show up here.')}</div></section>
    </div>
    <div>
      <section class="panel">
        <h2>Clubs</h2>
        <p class="muted">A club keeps each member's chip balance across games. Managers add chips, set credit limits and settle up, and the club's balances and ledger become your home page.</p>
        ${pending.length ? `<div class="club-list">${pending.map((c) => `<div><b>${esc(c.name)}</b><small>Waiting for a manager to approve you</small></div>`).join('')}</div>` : ''}
        ${clubForms()}
      </section>
      <section class="panel">
        <h2>Checking the shuffle</h2>
        <p class="muted">Each hand is sealed before the deal and opened afterwards. Players' browsers check every card automatically, and anyone can recheck a hand with the verifier.</p>
        <a class="btn small" href="/verify">Open the verifier</a>
      </section>
    </div>
  </div>`;
  main.querySelector('[data-start]').addEventListener('click', () => openStart());
  bindClubForms(main);
}

// ---------- invite ----------
async function joinPage(code) {
  unwatch();
  let info;
  try { info = await api.get('/api/clubs/invite/' + encodeURIComponent(code)); }
  catch (e) { main.innerHTML = `<section class="panel" style="max-width:560px"><h2>That invite does not work</h2><p class="muted">${esc(e.message)}. Ask the club manager for a fresh link.</p><a href="/">Back to the lobby</a></section>`; return; }
  const mine = me.clubs.find((c) => c.id === info.id);
  if (mine && mine.status === 'active') return go('/club/' + info.id);
  main.innerHTML = `<section class="panel" style="max-width:560px">
    <h2>Join ${esc(info.name)}</h2>
    ${mine && mine.status === 'pending' ? '<p>Your request is waiting for a manager to approve it.</p>' : me.user.username
      ? '<p class="muted">A manager approves new members. Once approved, your balance and the club tables appear here.</p><button class="btn primary" data-join>Ask to join</button>'
      : '<p class="muted">You need an account to join a club, so your balance belongs to you rather than this browser.</p><div class="row"><button class="btn primary" data-reg>Create account</button><button class="btn ghost" data-login>Sign in</button></div>'}
  </section>`;
  main.querySelector('[data-join]')?.addEventListener('click', async () => {
    try {
      const r = await api.post('/api/clubs/join', { code });
      me = await api.get('/api/me');
      if (r.status === 'active') go('/club/' + r.id); else joinPage(code);
    } catch (x) { toast(x.message, 'error'); }
  });
  main.querySelector('[data-reg]')?.addEventListener('click', async () => { const u = await accountDialog(me.user); if (u) { me = await api.get('/api/me'); renderHead(); joinPage(code); } });
  main.querySelector('[data-login]')?.addEventListener('click', async () => { await identityDialog({ mode: 'login', closable: true }); me = await api.get('/api/me'); renderHead(); joinPage(code); });
}

// ---------- live updates ----------
function unwatch() {
  watching = null;
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
  chips_add: 'Chips added', chips_remove: 'Chips removed', settlement: 'Settled', transfer_in: 'Transfer in',
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
    try { localStorage.removeItem(CLUB_KEY); } catch { /* storage blocked */ }
    main.innerHTML = `<section class="panel" style="max-width:560px"><h2>That club is not available</h2><p class="muted">${esc(e.message)}</p><a href="/">Back to the lobby</a></section>`;
    return;
  }
  const c = data.club;
  document.title = `${c.name} | The Aquarium`;
  if (c.myStatus !== 'active') {
    main.innerHTML = `<section class="panel" style="max-width:560px"><h2>${esc(c.name)}</h2><p>${c.myStatus === 'pending' ? 'Your request to join is waiting for a manager.' : 'You are not a member of this club.'}</p><a href="/">Back to the lobby</a></section>`;
    return;
  }
  try { localStorage.setItem(CLUB_KEY, id); } catch { /* storage blocked */ }
  watch(id);
  const dec = c.settings.decimals;
  const F = (a) => fmtChips(a, dec);
  const P = (v) => parseChips(v, dec);
  const roleLabel = { owner: 'You own this club', manager: 'You are a manager', member: 'Member' }[c.myRole];
  const clubs = me.clubs.filter((x) => x.status === 'active');
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
        <div class="row"><h1>${esc(c.name)}</h1>${clubs.length > 1 ? `<select data-switch aria-label="Switch club" style="width:auto">${clubs.map((x) => `<option value="${esc(x.id)}" ${x.id === c.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}</div>
        <span class="muted">${roleLabel}, ${c.members.length} member${c.members.length === 1 ? '' : 's'}</span>
      </div>
      <div class="cb-bal">
        <div><small>Your balance</small><b class="${c.me.balance < 0 ? 'neg' : ''}">${F(c.me.balance)}</b></div>
        <div><small>Credit limit</small><b>${F(c.me.creditLimit)}</b></div>
        <div><small>Available to play</small><b>${F(Math.max(0, c.me.available))}</b></div>
      </div>
      <button class="btn primary big" data-start>Start a game</button>
    </section>
    ${c.announcement ? `<div class="announce">${esc(c.announcement)}</div>` : ''}
    ${c.isManager && c.pending && c.pending.length ? `<section class="panel waitlist"><h2>Waiting to join</h2>
      ${c.pending.map((p) => `<div class="row" style="padding:6px 0"><b class="grow">${esc(p.name)}</b><span class="muted">${timeAgo(p.requestedAt)}</span><button class="btn small ghost" data-decide="${esc(p.userId)}" data-ok="0">Decline</button><button class="btn small primary" data-decide="${esc(p.userId)}" data-ok="1">Approve</button></div>`).join('')}</section>` : ''}

    <section class="panel">
      <h2>Tables</h2>
      <div class="gboard">${board(live, c.isManager ? 'No game running. Start one and it shows up here for every member.' : 'No game running right now.')}</div>
      ${past.length ? `<details class="past"><summary>Past games (${past.length})</summary><div class="gboard">${board(past.slice(0, 20))}</div></details>` : ''}
    </section>

    <section class="panel" id="balances">
      <div class="sec-head"><h2>Balances</h2>
        <div class="row">
          ${c.seeAll ? `<div class="seg" role="group" aria-label="Sort members">${[['name', 'By role'], ['balance', 'By balance'], ['net', 'Leaderboard']].map(([k, l]) => `<button type="button" data-sort="${k}" class="${k === ui.sort ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}
          ${c.isManager ? '<button class="btn small" data-invite>Invite players</button>' : ''}
        </div>
      </div>
      ${c.totals ? `<div class="totals">
        <div><small>Held by members</small><b>${F(c.totals.held)}</b></div>
        <div><small>Owed to the club</small><b class="${c.totals.owed < 0 ? 'neg' : ''}">${F(c.totals.owed)}</b></div>
        <div><small>On tables now</small><b>${F(c.totals.onTables)}</b></div>
        <div><small>Net balance</small><b>${F(c.totals.balances)}</b></div></div>` : ''}
      <div class="scroll-x wide-only"><table class="data balances"><thead><tr><th>Member</th><th class="n">Balance</th><th class="n hide-sm">Credit limit</th><th class="n">Available</th><th class="n hide-sm">On tables</th><th class="n">Net from play</th>${c.isManager ? '<th><span class="sr">Actions</span></th>' : ''}</tr></thead>
      <tbody>${members.map((m) => `<tr class="${m.userId === me.user.id ? 'me' : ''}"><td><button type="button" class="linkish" data-mm="${esc(m.userId)}" ${c.isManager || m.userId === me.user.id ? '' : 'disabled'}>${esc(m.name)}</button>${m.userId === me.user.id ? ' <span class="faint">(you)</span>' : ''}${m.role !== 'member' ? ` <span class="role">${m.role}</span>` : ''}</td>
        <td class="n bal">${money(m.balance)}</td><td class="n hide-sm">${m.creditLimit === undefined ? '<span class="faint">-</span>' : F(m.creditLimit)}</td><td class="n">${m.available === undefined ? '<span class="faint">-</span>' : F(Math.max(0, m.available))}</td>
        <td class="n hide-sm">${m.onTables === undefined ? '<span class="faint">-</span>' : F(m.onTables)}</td><td class="n">${signed(m.net)}</td>
        ${c.isManager ? `<td><div class="member-actions">
          <button class="btn tiny" data-m="chips" data-u="${esc(m.userId)}">Chips</button>
          <button class="btn tiny" data-m="credit" data-u="${esc(m.userId)}">Credit</button>
          ${m.balance ? `<button class="btn tiny" data-m="settle" data-u="${esc(m.userId)}">Settle</button>` : ''}
          ${c.myRole === 'owner' && m.role !== 'owner' ? `<button class="btn tiny ghost" data-m="role" data-u="${esc(m.userId)}">${m.role === 'manager' ? 'Make member' : 'Make manager'}</button>` : ''}
          ${m.role !== 'owner' ? `<button class="btn tiny ghost" data-m="remove" data-u="${esc(m.userId)}">Remove</button>` : ''}
        </div></td>` : ''}</tr>`).join('')}</tbody></table></div>
      <ul class="bal-list narrow-only">${members.map((m) => `<li><button type="button" class="bal-item ${m.userId === me.user.id ? 'me' : ''}" data-mm="${esc(m.userId)}" ${c.isManager || m.userId === me.user.id ? '' : 'disabled'}>
        <span class="bi-name"><b>${esc(m.name)}</b>${m.userId === me.user.id ? ' <span class="faint">(you)</span>' : ''}${m.role !== 'member' ? ` <span class="role">${m.role}</span>` : ''}</span>
        <span class="bi-bal">${money(m.balance)}</span>
        ${m.balance === undefined ? '' : `<small class="bi-sub">Available ${F(Math.max(0, m.available))}${m.onTables ? `, ${F(m.onTables)} on tables` : ''}${m.creditLimit ? `, credit ${F(m.creditLimit)}` : ''}</small><small class="bi-net">${signed(m.net)}</small>`}
      </button></li>`).join('')}</ul>
      ${!c.seeAll ? '<p class="hint">Only managers see other members’ balances in this club.</p>' : ''}
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
      ${txs.length > shown.length ? `<div class="more"><button class="btn small ghost" data-more>Show ${Math.min(50, txs.length - shown.length)} more of ${txs.length - shown.length}</button></div>` : ''}` : '<p class="muted">No entries yet. Chips added, buy-ins, cash-outs and settlements show up here.</p>'}
    </section>

    <div class="club-foot">
      ${c.isManager ? '<button class="btn small" data-settings>Club settings</button>' : ''}
      ${c.settings.allowTransfers ? '<button class="btn small" data-transfer>Send chips to a member</button>' : ''}
      <button class="btn small ghost" data-clubs>Join or create another club</button>
      <a class="btn small ghost" href="/verify">Shuffle verifier</a>
    </div>`;

  const post = async (path, payload, done) => {
    try { await api.post(`/api/clubs/${id}${path}`, payload); if (done) toast(done); route(); return true; }
    catch (x) { toast(x.message, 'error'); return false; }
  };

  main.querySelector('[data-start]').addEventListener('click', () => openStart(c.isManager ? c.id : null));
  main.querySelector('[data-switch]')?.addEventListener('change', (e) => { ui.member = ''; ui.ledgerLimit = 30; go('/club/' + e.target.value); });
  main.querySelector('[data-filter]')?.addEventListener('change', (e) => { ui.member = e.target.value; ui.ledgerLimit = 30; clubHome(id); });
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
    if (e.target.closest('[data-clubs]')) {
      const dlg = dialog({ title: 'Clubs', className: 'narrow', body: `<p class="muted">Join a club with its invite code, or start a new one.</p>${clubForms()}` });
      bindClubForms(dlg.el, () => dlg.close());
      return;
    }
    const b = e.target.closest('[data-m]');
    if (!b) return;
    const m = c.members.find((x) => x.userId === b.dataset.u);
    const k = b.dataset.m;
    if (k === 'chips') memberChips(m);
    if (k === 'credit') memberCredit(m);
    if (k === 'settle') memberSettle(m);
    if (k === 'role') post(`/members/${m.userId}/role`, { role: m.role === 'manager' ? 'member' : 'manager' }, 'Role changed');
    if (k === 'remove') confirmDialog(`Remove ${m.name} from the club? Their balance must be zero.`, { ok: 'Remove', danger: true }).then((ok) => ok && post(`/members/${m.userId}/remove`, {}, 'Member removed'));
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
        <p class="muted">${m.role === 'owner' ? 'Owner' : m.role === 'manager' ? 'Manager' : 'Member'}${m.joinedAt ? `, joined ${new Date(m.joinedAt).toLocaleDateString()}` : ''}</p>
        ${c.isManager ? `<div class="sheet-actions">
          <button class="btn" data-a="chips">Add or remove chips</button>
          <button class="btn" data-a="credit">Credit limit</button>
          ${m.balance ? '<button class="btn" data-a="settle">Settle up</button>' : ''}
          ${c.myRole === 'owner' && m.role !== 'owner' ? `<button class="btn ghost" data-a="role">${m.role === 'manager' ? 'Make member' : 'Make manager'}</button>` : ''}
          ${m.role !== 'owner' ? '<button class="btn danger" data-a="remove">Remove from club</button>' : ''}
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
      if (a === 'role') post(`/members/${m.userId}/role`, { role: m.role === 'manager' ? 'member' : 'manager' }, 'Role changed');
      if (a === 'remove' && await confirmDialog(`Remove ${m.name} from the club? Their balance must be zero.`, { ok: 'Remove', danger: true })) post(`/members/${m.userId}/remove`, {}, 'Member removed');
      if (a === 'entries') {
        ui.member = m.userId;
        ui.ledgerLimit = 30;
        await clubHome(id);
        document.getElementById('ledger')?.scrollIntoView({ block: 'start' });
      }
    });
  }

  function inviteDialog() {
    const link = `${location.origin}/join/${c.inviteCode}`;
    const dlg = dialog({
      title: 'Invite players', className: 'narrow',
      body: `<div class="stack"><p class="muted">Send this link. New members ${c.settings.requireApproval ? 'wait for a manager to approve them' : 'join straight away'}, and need an account so their balance is theirs.</p>
        <div class="invite"><code class="grow">${esc(link)}</code><button class="btn small" data-copy>Copy</button></div>
        <p class="hint">Invite code ${esc(c.inviteCode)}. Making a new link stops the old one from working.</p></div>`,
      foot: '<button class="btn ghost" data-newcode>Make a new link</button><button class="btn primary" data-close>Done</button>',
    });
    dlg.$('[data-copy]').addEventListener('click', () => copyText(link));
    dlg.$('[data-newcode]').addEventListener('click', async () => {
      if (await confirmDialog('The old invite link stops working.', { title: 'Make a new invite link?', ok: 'Make new link' })) {
        dlg.close();
        post('/invite', {}, 'New invite link ready');
      }
    });
  }

  function memberChips(m) {
    const dlg = dialog({
      title: `Chips for ${m.name}`, className: 'narrow',
      body: `<form class="stack">
        <div class="seg" data-dir><button type="button" class="on" data-v="1">Add chips</button><button type="button" data-v="-1">Remove chips</button></div>
        <label><span class="lbl">Amount</span><input name="amount" type="number" inputmode="decimal" step="any" min="0" required></label>
        <label><span class="lbl">Note</span><input name="note" maxlength="140" placeholder="e.g. Cash received"></label>
        <p class="hint">Balance now ${F(m.balance)}. Removing more than the balance leaves the member owing the club.</p>
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
      if (await post(`/members/${m.userId}/chips`, { amount: dir * amt, note: ev.target.elements.note.value }, dir > 0 ? 'Chips added' : 'Chips removed')) dlg.close();
    });
    setTimeout(() => dlg.$('[name=amount]').focus(), 30);
  }

  function memberCredit(m) {
    const dlg = dialog({
      title: `Credit limit for ${m.name}`, className: 'narrow',
      body: `<form class="stack"><p class="muted">How far below zero ${esc(m.name)} can go when buying in. Their own chips are used first, then credit.</p>
        <label><span class="lbl">Credit limit</span><input name="limit" type="number" inputmode="decimal" step="any" min="0" value="${toInput(m.creditLimit, dec)}"></label>
        <button class="btn primary" type="submit">Save limit</button></form>`,
    });
    dlg.$('form').addEventListener('submit', async (ev) => { ev.preventDefault(); if (await post(`/members/${m.userId}/credit`, { limit: P(ev.target.elements.limit.value) }, 'Credit limit saved')) dlg.close(); });
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
      title: 'Send chips to a member', className: 'narrow',
      body: `<form class="stack">
        <label><span class="lbl">To</span><select name="to">${others.map((m) => `<option value="${esc(m.userId)}">${esc(m.name)}</option>`).join('')}</select></label>
        <label><span class="lbl">Amount</span><input name="amount" type="number" inputmode="decimal" step="any" min="0" required></label>
        <label><span class="lbl">Note</span><input name="note" maxlength="140" placeholder="Optional"></label>
        <p class="hint">You can send chips from a positive balance only; credit cannot be passed on.</p>
        <button class="btn primary" type="submit">Send chips</button></form>`,
    });
    dlg.$('form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target.elements;
      if (await post('/transfer', { toUserId: f.to.value, amount: P(f.amount.value), note: f.note.value }, 'Chips sent')) dlg.close();
    });
  }

  function settingsDialog() {
    const st = c.settings;
    const used = c.transactions.some((t) => t.amount !== 0);
    const dlg = dialog({
      title: 'Club settings',
      body: `<form class="stack" id="clubset">
        <div class="field-grid">
          <label><span class="lbl">Club name</span><input name="cname" maxlength="40" value="${esc(c.name)}"></label>
          <label><span class="lbl">Default credit limit for new members</span><input name="defaultCreditLimit" type="number" step="any" min="0" value="${toInput(st.defaultCreditLimit, dec)}"></label>
          <label><span class="lbl">Chip amounts</span><select name="decimals" ${used ? 'disabled' : ''}><option value="0" ${st.decimals === 0 ? 'selected' : ''}>Whole chips</option><option value="2" ${st.decimals === 2 ? 'selected' : ''}>Two decimals</option></select></label>
        </div>
        <label><span class="lbl">Announcement for members</span><input name="announcement" maxlength="140" value="${esc(c.announcement || '')}" placeholder="e.g. Settle up by Sunday night"></label>
        <label class="check"><input type="checkbox" name="membersSeeLedger" ${st.membersSeeLedger ? 'checked' : ''}> Members can see everyone's balance and the full ledger<small>Off: each member sees only their own balance and entries.</small></label>
        <label class="check"><input type="checkbox" name="allowTransfers" ${st.allowTransfers ? 'checked' : ''}> Members can send chips to each other<small>Only from a positive balance; credit cannot be passed on.</small></label>
        <label class="check"><input type="checkbox" name="requireApproval" ${st.requireApproval ? 'checked' : ''}> A manager approves new members<small>Off: anyone with the invite link joins straight away.</small></label>
      </form>`,
      foot: '<button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-save>Save settings</button>',
    });
    dlg.$('[data-save]').addEventListener('click', async () => {
      const f = dlg.$('#clubset').elements;
      try {
        await api.patch(`/api/clubs/${id}`, {
          name: f.cname.value, announcement: f.announcement.value, defaultCreditLimit: P(f.defaultCreditLimit.value),
          membersSeeLedger: f.membersSeeLedger.checked, allowTransfers: f.allowTransfers.checked, requireApproval: f.requireApproval.checked,
          ...(used ? {} : { decimals: Number(f.decimals.value) }),
        });
        me = await api.get('/api/me');
        dlg.close();
        toast('Settings saved');
        route();
      } catch (x) { toast(x.message, 'error'); }
    });
  }
}

boot();
