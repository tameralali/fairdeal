// Lobby, club pages and invite links.
import { api, ensureIdentity, identityDialog, accountDialog, fmtChips, parseChips } from './api.js';
import { esc, $, dialog, toast, confirmDialog, copyText, timeAgo } from './ui.js';
import { sealSVG } from './seal.js';
import { GAME_TYPES } from '/shared/cards.js';

const BRAND_HEX = '6f3ac1d0a85c2e94b7f1036d4e5a9c8b21f0e7d6c5b4a39281706f5e4d3c2b1a';
const main = $('#main');
const head = $('#head');
let me = null;
let clubSocket = null;
let watching = null;

async function boot() {
  try { me = await ensureIdentity(); }
  catch (e) { main.innerHTML = `<p class="bad">${esc(e.message)}</p>`; return; }
  renderHead();
  route();
}

function route() {
  const path = location.pathname;
  let m;
  if ((m = path.match(/^\/club\/([^/]+)/))) return clubPage(decodeURIComponent(m[1]), new URLSearchParams(location.search).get('tab') || 'tables');
  if ((m = path.match(/^\/join\/([^/]+)/))) return joinPage(decodeURIComponent(m[1]));
  return home();
}
window.addEventListener('popstate', route);

function go(url) { history.pushState(null, '', url); route(); }

function renderHead() {
  const u = me.user;
  head.innerHTML = `<a class="wordmark" href="/">${sealSVG(BRAND_HEX, 30, 'The Aquarium')}<span>The <b>Aquarium</b></span></a>
    <div class="who"><span>Playing as <b>${esc(u.name)}</b>${u.username ? ` <span class="faint">@${esc(u.username)}</span>` : ''}</span>
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

const shortGames = (games) => games.map((g) => GAME_TYPES[g]?.short || g).join(' / ');

function board(tables, empty = 'No tables yet.') {
  if (!tables || !tables.length) return `<div class="empty">${esc(empty)}</div>`;
  return tables.map((t) => {
    const F = (a) => fmtChips(a, t.decimals);
    let status = t.status === 'ended' ? 'Ended' : t.status === 'waiting' ? 'Not started' : t.paused ? 'Paused' : 'Running';
    if (t.status === 'running' && t.endsAt) status += `, ends ${new Date(t.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    return `<a href="/t/${esc(t.id)}"><span class="g">${esc(shortGames(t.games))}</span><span class="stakes">${F(t.smallBlind)}/${F(t.bigBlind)}</span>
      <span class="nm"><b>${esc(t.name)}</b><small>${esc(status)}${t.names.length ? `: ${t.names.map(esc).join(', ')}` : ''}</small></span>
      <span class="seats"><b>${t.players}</b> of ${t.maxPlayers}</span></a>`;
  }).join('');
}

const gamePicker = (checked = ['nlh']) => `<div class="game-pick">
  <label><input type="checkbox" name="g" value="nlh" ${checked.includes('nlh') ? 'checked' : ''}><span>NLH<small>No limit hold'em</small></span></label>
  <label><input type="checkbox" name="g" value="plo4" ${checked.includes('plo4') ? 'checked' : ''}><span>PLO<small>Pot limit Omaha</small></span></label>
  <label><input type="checkbox" name="g" value="plo5" ${checked.includes('plo5') ? 'checked' : ''}><span>PLO5<small>Five card Omaha</small></span></label>
</div>`;

function readTableForm(f, dec) {
  const games = [...f.querySelectorAll('input[name=g]:checked')].map((x) => x.value);
  if (!games.length) throw new Error('Pick at least one game');
  const P = (n) => parseChips(f.elements[n].value, dec);
  const settings = {
    games, smallBlind: P('sb'), bigBlind: P('bb'),
    minBuyIn: f.elements.min.value ? P('min') : 0, maxBuyIn: f.elements.max.value ? P('max') : 0,
  };
  if (f.elements.seats) settings.maxPlayers = Number(f.elements.seats.value);
  return settings;
}

// ---------- home ----------
async function home() {
  unwatch();
  me = await api.get('/api/me');
  document.title = 'The Aquarium';
  const clubs = me.clubs.length ? me.clubs.map((c) => `<a href="/club/${esc(c.id)}"><span><b>${esc(c.name)}</b><br><small>${c.status === 'pending' ? 'Waiting for approval' : c.role}</small></span>${c.status === 'active' ? `<span class="num">${fmtChips(c.balance, c.decimals)}</span>` : ''}</a>`).join('') : '<p class="muted">You are not in a club yet.</p>';
  main.innerHTML = `<div class="lob-grid">
    <div>
      <section class="panel">
        <h2>Start a game</h2>
        <p class="lead">Pick the games and stakes, then send the table link to your players. You approve each seat and rebuy, and every player's browser checks every deal.</p>
        <form id="newtable" class="stack">
          <div>${gamePicker()}<p class="hint">Pick two or three to rotate them, one orbit each.</p></div>
          <div class="field-grid">
            <label><span class="lbl">Table name</span><input name="tname" type="text" maxlength="40" placeholder="${esc(me.user.name)}'s game"></label>
            <label><span class="lbl">Chip amounts</span><select name="decimals"><option value="0">Whole chips (5/10)</option><option value="2">Two decimals (0.25/0.50)</option></select></label>
            <label><span class="lbl">Small blind</span><input name="sb" type="number" step="any" min="0" value="5"></label>
            <label><span class="lbl">Big blind</span><input name="bb" type="number" step="any" min="0" value="10"></label>
            <label><span class="lbl">Minimum buy-in</span><input name="min" type="number" step="any" min="0" placeholder="Any"></label>
            <label><span class="lbl">Maximum stack</span><input name="max" type="number" step="any" min="0" placeholder="Any"></label>
          </div>
          <div class="row"><button class="btn primary" type="submit">Create table</button><span class="hint">Bomb pots, running it up to four times, time limits and reveal timing are under Options at the table.</span></div>
        </form>
      </section>
      <section class="panel"><h2>Your tables</h2><div class="gboard">${board(me.tables, 'Tables you host or play at show up here.')}</div></section>
    </div>
    <div>
      <section class="panel">
        <h2>Clubs</h2>
        <p class="muted">A club keeps each member's chip balance across games. Managers add chips, set credit limits and settle up.</p>
        <div class="club-list">${clubs}</div>
        <div class="stack" style="margin-top:1rem">
          <form id="joinclub" class="row"><input name="code" placeholder="Invite code" aria-label="Invite code" style="max-width:190px" autocapitalize="characters"><button class="btn" type="submit">Join club</button></form>
          <form id="newclub" class="row"><input name="cname" placeholder="New club name" aria-label="New club name" style="max-width:220px"><select name="decimals" style="width:auto" aria-label="Chip amounts"><option value="0">Whole chips</option><option value="2">Two decimals</option></select><button class="btn" type="submit">Create club</button></form>
          ${me.user.username ? '' : '<p class="hint">Clubs need an account, so a balance belongs to you and not to this browser. Use Create account at the top.</p>'}
        </div>
      </section>
      <section class="panel">
        <h2>Checking the shuffle</h2>
        <p class="muted">Each hand is sealed before the deal and opened afterwards. Players' browsers check every card automatically, and anyone can recheck a hand with the verifier.</p>
        <a class="btn small" href="/verify">Open the verifier</a>
      </section>
    </div>
  </div>`;
  const nt = $('#newtable');
  nt.elements.decimals.addEventListener('change', (e) => {
    const two = e.target.value === '2';
    nt.elements.sb.value = two ? '0.25' : '5';
    nt.elements.bb.value = two ? '0.50' : '10';
  });
  nt.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const dec = Number(nt.elements.decimals.value);
      const settings = { ...readTableForm(nt, dec), decimals: dec };
      const r = await api.post('/api/tables', { name: nt.elements.tname.value, settings });
      location.href = '/t/' + r.id;
    } catch (x) { toast(x.message, 'error'); }
  });
  $('#joinclub').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = e.target.elements.code.value.trim();
    if (code) go('/join/' + encodeURIComponent(code));
  });
  $('#newclub').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/api/clubs', { name: e.target.elements.cname.value, decimals: Number(e.target.elements.decimals.value) });
      go('/club/' + r.id);
    } catch (x) { toast(x.message, 'error'); }
  });
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

// ---------- clubs ----------
function unwatch() { watching = null; }
function watch(clubId) {
  watching = clubId;
  if (!clubSocket) {
    clubSocket = window.io({ auth: { token: api.token }, transports: ['websocket', 'polling'] });
    clubSocket.on('connect', () => { if (watching) clubSocket.emit('club:watch', { clubId: watching }); });
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

const TX = {
  chips_add: 'Chips added', chips_remove: 'Chips removed', settlement: 'Settled', transfer_in: 'Transfer in',
  transfer_out: 'Transfer out', buyin: 'Buy-in', cashout: 'Cash-out', credit_limit: 'Credit limit',
};

async function clubPage(id, tab) {
  let data;
  try { data = await api.get('/api/clubs/' + encodeURIComponent(id)); }
  catch (e) { main.innerHTML = `<p class="bad">${esc(e.message)}</p><p><a href="/">Back to the lobby</a></p>`; return; }
  const c = data.club;
  document.title = `${c.name} | The Aquarium`;
  if (c.myStatus !== 'active') {
    main.innerHTML = `<section class="panel" style="max-width:560px"><h2>${esc(c.name)}</h2><p>${c.myStatus === 'pending' ? 'Your request to join is waiting for a manager.' : 'You are not a member of this club.'}</p><a href="/">Back to the lobby</a></section>`;
    return;
  }
  watch(id);
  const dec = c.settings.decimals;
  const F = (a) => fmtChips(a, dec);
  const P = (v) => parseChips(v, dec);
  const tabs = [['tables', 'Tables'], ['members', 'Members'], ['ledger', 'Ledger'], c.isManager && ['settings', 'Settings']].filter(Boolean);
  if (!tabs.some(([k]) => k === tab)) tab = 'tables';
  const roleLabel = { owner: 'You own this club', manager: 'You are a manager', member: 'Member' }[c.myRole];
  main.innerHTML = `
    <div class="club-head">
      <div><a href="/" class="muted">Lobby</a><h1>${esc(c.name)}</h1><span class="muted">${roleLabel}</span></div>
      <div class="bal">
        <div><small>Your balance</small><b class="${c.me.balance < 0 ? 'neg' : ''}">${F(c.me.balance)}</b></div>
        <div><small>Credit limit</small><b>${F(c.me.creditLimit)}</b></div>
        <div><small>Available to play</small><b>${F(Math.max(0, c.me.available))}</b></div>
      </div>
    </div>
    ${c.announcement ? `<div class="announce">${esc(c.announcement)}</div>` : ''}
    ${c.isManager && c.pending && c.pending.length ? `<section class="panel" style="margin-bottom:18px"><h2>Waiting to join</h2>
      ${c.pending.map((p) => `<div class="row" style="padding:6px 0"><b class="grow">${esc(p.name)}</b><span class="muted">${timeAgo(p.requestedAt)}</span><button class="btn small ghost" data-decide="${esc(p.userId)}" data-ok="0">Decline</button><button class="btn small primary" data-decide="${esc(p.userId)}" data-ok="1">Approve</button></div>`).join('')}</section>` : ''}
    <nav class="page-tabs">${tabs.map(([k, l]) => `<a href="/club/${esc(id)}?tab=${k}" data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</nav>
    <div id="tabbody"></div>`;
  main.querySelector('.page-tabs').addEventListener('click', (e) => {
    const a = e.target.closest('[data-tab]');
    if (!a) return;
    e.preventDefault();
    go(`/club/${id}?tab=${a.dataset.tab}`);
  });
  main.querySelectorAll('[data-decide]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.post(`/api/clubs/${id}/members/${b.dataset.decide}/decide`, { approve: b.dataset.ok === '1' }); route(); }
    catch (x) { toast(x.message, 'error'); }
  }));
  const body = $('#tabbody');
  const post = async (path, payload, done) => {
    try { await api.post(`/api/clubs/${id}${path}`, payload); if (done) toast(done); route(); return true; }
    catch (x) { toast(x.message, 'error'); return false; }
  };

  if (tab === 'tables') {
    body.innerHTML = `<section class="panel"><h2>Club tables</h2><p class="muted">Members buy in from their balance (plus any credit) and cash out back into it.</p><div class="gboard">${board(data.tables, 'No club tables yet.')}</div></section>
      ${c.isManager ? `<section class="panel"><h2>Open a table</h2>
        <form id="clubtable" class="stack">
          ${gamePicker(['plo4', 'nlh'])}
          <div class="field-grid">
            <label><span class="lbl">Table name</span><input name="tname" maxlength="40" placeholder="Main game"></label>
            <label><span class="lbl">Small blind</span><input name="sb" type="number" step="any" value="${dec ? '0.25' : '5'}"></label>
            <label><span class="lbl">Big blind</span><input name="bb" type="number" step="any" value="${dec ? '0.50' : '10'}"></label>
            <label><span class="lbl">Minimum buy-in</span><input name="min" type="number" step="any" placeholder="Any"></label>
            <label><span class="lbl">Maximum stack</span><input name="max" type="number" step="any" placeholder="Any"></label>
            <label><span class="lbl">Seats</span><select name="seats">${[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<option ${n === 8 ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          </div>
          <div class="row"><button class="btn primary" type="submit">Open table</button><span class="hint">Club tables start right away and seat members straight from their balance, so the game runs without a manager present.</span></div>
        </form></section>` : ''}`;
    $('#clubtable')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const f = e.target;
        const r = await api.post(`/api/clubs/${id}/tables`, { name: f.elements.tname.value || 'Main game', settings: readTableForm(f, dec) });
        location.href = '/t/' + r.id;
      } catch (x) { toast(x.message, 'error'); }
    });
  }

  if (tab === 'members') {
    const sortKey = new URLSearchParams(location.search).get('sort') || 'name';
    const members = c.members.slice().sort((a, b) => (sortKey === 'net' ? (b.net ?? -1e18) - (a.net ?? -1e18) : sortKey === 'balance' ? (b.balance ?? -1e18) - (a.balance ?? -1e18) : 0));
    const money = (n) => (n === undefined ? '<span class="faint">-</span>' : `<span class="${n < 0 ? 'neg' : ''}">${F(n)}</span>`);
    const net = (n) => (n === undefined ? '<span class="faint">-</span>' : `<span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${n > 0 ? '+' : ''}${F(n)}</span>`);
    const invite = `${location.origin}/join/${c.inviteCode}`;
    body.innerHTML = `<section class="panel">
      ${c.isManager ? `<div class="invite" style="margin-bottom:16px"><span class="muted">Invite link</span><code class="grow">${esc(invite)}</code><button class="btn small" data-copy="${esc(invite)}">Copy</button><button class="btn small ghost" data-newcode>New link</button></div>` : ''}
      ${c.totals ? `<div class="totals">
        <div><small>Held by members</small><b>${F(c.totals.held)}</b></div>
        <div><small>Owed to the club</small><b class="${c.totals.owed < 0 ? 'neg' : ''}">${F(c.totals.owed)}</b></div>
        <div><small>On tables now</small><b>${F(c.totals.onTables)}</b></div>
        <div><small>Net balance</small><b>${F(c.totals.balances)}</b></div></div>` : ''}
      <div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 style="margin:0">Members</h2>
        ${c.seeAll ? `<div class="seg">${[['name', 'By role'], ['balance', 'By balance'], ['net', 'Leaderboard']].map(([k, l]) => `<button type="button" data-sort="${k}" class="${k === sortKey ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}</div>
      <div class="scroll-x"><table class="data"><thead><tr><th>Member</th><th>Role</th><th class="n">Balance</th><th class="n">Credit limit</th><th class="n">Available</th><th class="n">On tables</th><th class="n">Net from play</th>${c.isManager ? '<th></th>' : ''}</tr></thead>
      <tbody>${members.map((m) => `<tr><td>${esc(m.name)}${m.userId === me.user.id ? ' <span class="faint">(you)</span>' : ''}</td><td class="muted">${m.role}</td>
        <td class="n">${money(m.balance)}</td><td class="n">${m.creditLimit === undefined ? '<span class="faint">-</span>' : F(m.creditLimit)}</td><td class="n">${m.available === undefined ? '<span class="faint">-</span>' : F(Math.max(0, m.available))}</td>
        <td class="n">${m.onTables === undefined ? '<span class="faint">-</span>' : F(m.onTables)}</td><td class="n">${net(m.net)}</td>
        ${c.isManager ? `<td><div class="member-actions">
          <button class="btn tiny" data-m="chips" data-u="${esc(m.userId)}">Chips</button>
          <button class="btn tiny" data-m="credit" data-u="${esc(m.userId)}">Credit</button>
          ${m.balance ? `<button class="btn tiny" data-m="settle" data-u="${esc(m.userId)}">Settle</button>` : ''}
          ${c.myRole === 'owner' && m.role !== 'owner' ? `<button class="btn tiny ghost" data-m="role" data-u="${esc(m.userId)}">${m.role === 'manager' ? 'Make member' : 'Make manager'}</button>` : ''}
          ${m.role !== 'owner' ? `<button class="btn tiny ghost" data-m="remove" data-u="${esc(m.userId)}">Remove</button>` : ''}
        </div></td>` : ''}</tr>`).join('')}</tbody></table></div>
      ${!c.seeAll ? '<p class="hint">Only managers see other members’ balances in this club.</p>' : ''}
    </section>
    ${c.settings.allowTransfers ? `<section class="panel"><h2>Send chips to a member</h2>
      <form id="transfer" class="row"><select name="to" style="width:auto">${c.members.filter((m) => m.userId !== me.user.id).map((m) => `<option value="${esc(m.userId)}">${esc(m.name)}</option>`).join('')}</select>
      <input name="amount" type="number" step="any" min="0" placeholder="Amount" style="max-width:140px"><input name="note" placeholder="Note (optional)" style="max-width:220px"><button class="btn" type="submit">Send chips</button></form>
      <p class="hint">You can send chips from a positive balance only; credit cannot be transferred.</p></section>` : ''}`;
    body.addEventListener('click', async (e) => {
      const cp = e.target.closest('[data-copy]');
      if (cp) return copyText(cp.dataset.copy);
      if (e.target.closest('[data-newcode]')) {
        if (await confirmDialog('The old invite link stops working.', { title: 'Make a new invite link?', ok: 'Make new link' })) post('/invite', {}, 'New invite link ready');
        return;
      }
      const s = e.target.closest('[data-sort]');
      if (s) return go(`/club/${id}?tab=members&sort=${s.dataset.sort}`);
      const b = e.target.closest('[data-m]');
      if (!b) return;
      const m = c.members.find((x) => x.userId === b.dataset.u);
      const k = b.dataset.m;
      if (k === 'chips') memberChips(m);
      if (k === 'credit') memberCredit(m);
      if (k === 'settle') {
        const d = dialog({
          title: `Settle ${m.name}`, className: 'narrow',
          body: `<form class="stack"><p>${m.balance < 0 ? `${esc(m.name)} owes the club ${F(-m.balance)}.` : `The club owes ${esc(m.name)} ${F(m.balance)}.`} Settling records the payment and sets the balance to zero.</p>
            <label><span class="lbl">How it was paid</span><input name="note" placeholder="e.g. Cash, bank transfer"></label><button class="btn primary" type="submit">Record settlement</button></form>`,
        });
        d.$('form').addEventListener('submit', async (ev) => { ev.preventDefault(); if (await post(`/members/${m.userId}/settle`, { note: ev.target.elements.note.value }, 'Settlement recorded')) d.close(); });
      }
      if (k === 'role') post(`/members/${m.userId}/role`, { role: m.role === 'manager' ? 'member' : 'manager' }, 'Role changed');
      if (k === 'remove' && await confirmDialog(`Remove ${m.name} from the club? Their balance must be zero.`, { ok: 'Remove', danger: true })) post(`/members/${m.userId}/remove`, {}, 'Member removed');
    });
    $('#transfer')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      post('/transfer', { toUserId: f.elements.to.value, amount: P(f.elements.amount.value), note: f.elements.note.value }, 'Chips sent');
    });

    const memberChips = (m) => {
      const d = dialog({
        title: `Chips for ${m.name}`, className: 'narrow',
        body: `<form class="stack">
          <div class="seg" data-dir><button type="button" class="on" data-v="1">Add chips</button><button type="button" data-v="-1">Remove chips</button></div>
          <label><span class="lbl">Amount</span><input name="amount" type="number" step="any" min="0" required></label>
          <label><span class="lbl">Note</span><input name="note" maxlength="140" placeholder="e.g. Cash received"></label>
          <p class="hint">Balance now ${F(m.balance)}. Removing more than the balance leaves the member owing the club.</p>
          <button class="btn primary" type="submit">Save</button></form>`,
      });
      let dir = 1;
      d.$('[data-dir]').addEventListener('click', (ev) => {
        const x = ev.target.closest('button');
        if (!x) return;
        dir = Number(x.dataset.v);
        d.$$('[data-dir] button').forEach((y) => y.classList.toggle('on', y === x));
      });
      d.$('form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const amt = P(ev.target.elements.amount.value);
        if (!(amt > 0)) return toast('Enter an amount', 'error');
        if (await post(`/members/${m.userId}/chips`, { amount: dir * amt, note: ev.target.elements.note.value }, dir > 0 ? 'Chips added' : 'Chips removed')) d.close();
      });
    };
    const memberCredit = (m) => {
      const d = dialog({
        title: `Credit limit for ${m.name}`, className: 'narrow',
        body: `<form class="stack"><p class="muted">How far below zero ${esc(m.name)} can go when buying in. Their own chips are used first, then credit.</p>
          <label><span class="lbl">Credit limit</span><input name="limit" type="number" step="any" min="0" value="${dec ? (m.creditLimit / 100).toFixed(2) : m.creditLimit}"></label>
          <button class="btn primary" type="submit">Save limit</button></form>`,
      });
      d.$('form').addEventListener('submit', async (ev) => { ev.preventDefault(); if (await post(`/members/${m.userId}/credit`, { limit: P(ev.target.elements.limit.value) }, 'Credit limit saved')) d.close(); });
    };
  }

  if (tab === 'ledger') {
    const filter = new URLSearchParams(location.search).get('member') || '';
    const txs = c.transactions.filter((t) => !filter || t.userId === filter);
    body.innerHTML = `<section class="panel">
      <div class="row" style="justify-content:space-between;margin-bottom:10px"><h2 style="margin:0">Ledger</h2>
        <div class="row">${c.seeAll ? `<select data-filter style="width:auto"><option value="">Everyone</option>${c.members.map((m) => `<option value="${esc(m.userId)}" ${m.userId === filter ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>` : ''}
        <button class="btn small" data-csv>Download CSV</button></div></div>
      ${txs.length ? `<div class="scroll-x"><table class="data"><thead><tr><th>When</th><th>Member</th><th>What</th><th class="n">Amount</th><th class="n">Balance after</th><th>By</th><th>Detail</th></tr></thead><tbody>
      ${txs.map((t) => `<tr><td class="muted">${new Date(t.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>${esc(t.name)}</td><td class="tx-type">${TX[t.type] || esc(t.type)}</td>
        <td class="n"><span class="${t.amount > 0 ? 'pos' : t.amount < 0 ? 'neg' : ''}">${t.amount > 0 ? '+' : ''}${t.type === 'credit_limit' ? '' : F(t.amount)}</span></td><td class="n">${F(t.balanceAfter)}</td>
        <td class="muted">${esc(t.byName || '')}</td><td class="muted">${esc([t.tableName, t.note].filter(Boolean).join(': '))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No entries yet.</p>'}
    </section>`;
    body.querySelector('[data-filter]')?.addEventListener('change', (e) => go(`/club/${id}?tab=ledger${e.target.value ? '&member=' + encodeURIComponent(e.target.value) : ''}`));
    body.querySelector('[data-csv]').addEventListener('click', () => api.download(`/api/clubs/${id}/transactions.csv`, `club-ledger-${c.name.replace(/[^\w-]+/g, '-')}.csv`).catch((x) => toast(x.message, 'error')));
  }

  if (tab === 'settings' && c.isManager) {
    const st = c.settings;
    const used = c.transactions.some((t) => t.amount !== 0);
    body.innerHTML = `<section class="panel"><h2>Club settings</h2>
      <form id="clubset" class="stack">
        <div class="field-grid">
          <label><span class="lbl">Club name</span><input name="cname" maxlength="40" value="${esc(c.name)}"></label>
          <label><span class="lbl">Default credit limit for new members</span><input name="defaultCreditLimit" type="number" step="any" min="0" value="${dec ? (st.defaultCreditLimit / 100).toFixed(2) : st.defaultCreditLimit}"></label>
          <label><span class="lbl">Chip amounts</span><select name="decimals" ${used ? 'disabled' : ''}><option value="0" ${st.decimals === 0 ? 'selected' : ''}>Whole chips</option><option value="2" ${st.decimals === 2 ? 'selected' : ''}>Two decimals</option></select></label>
        </div>
        <label><span class="lbl">Announcement for members</span><input name="announcement" maxlength="140" value="${esc(c.announcement || '')}" placeholder="e.g. Settle up by Sunday night"></label>
        <label class="check"><input type="checkbox" name="membersSeeLedger" ${st.membersSeeLedger ? 'checked' : ''}> Members can see everyone's balance and the full ledger<small>Off: each member sees only their own balance and entries.</small></label>
        <label class="check"><input type="checkbox" name="allowTransfers" ${st.allowTransfers ? 'checked' : ''}> Members can send chips to each other<small>Only from a positive balance; credit cannot be passed on.</small></label>
        <label class="check"><input type="checkbox" name="requireApproval" ${st.requireApproval ? 'checked' : ''}> A manager approves new members<small>Off: anyone with the invite link joins straight away.</small></label>
        <div><button class="btn primary" type="submit">Save settings</button></div>
      </form></section>`;
    $('#clubset').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      try {
        await api.patch(`/api/clubs/${id}`, {
          name: f.cname.value, announcement: f.announcement.value, defaultCreditLimit: P(f.defaultCreditLimit.value),
          membersSeeLedger: f.membersSeeLedger.checked, allowTransfers: f.allowTransfers.checked, requireApproval: f.requireApproval.checked,
          ...(used ? {} : { decimals: Number(f.decimals.value) }),
        });
        toast('Settings saved');
        route();
      } catch (x) { toast(x.message, 'error'); }
    });
  }
}

boot();
