// Dialogs on the table page: seats and chips, host options, ledger, hand history with verification,
// appearance, fairness explainer.
import { api } from './api.js';
import { esc, dialog, toast, confirmDialog, copyText } from './ui.js';
import { cardHTML, prefs, savePrefs, FELTS, BACKS } from './cards.js';
import { sealSVG } from './seal.js';
import { webCryptoAdapter } from '/shared/fairness.js';
import { GAME_TYPES } from '/shared/cards.js';
import { app, emit, fmt, parse, inp, gameShort, gameName } from './table-core.js';
import { seg, bindSegs, formatEditorHTML, bindFormatEditor, readFormat, bombFieldsHTML, bindBombFields, readBomb, fitSeats, ritText, boardName } from './game-form.js';

const wc = webCryptoAdapter();
const open = {};

export function onState(s) {
  if (open.requests) open.requests(s);
  if (open.players) open.players(s);
}

const val = (form, n) => form.elements.namedItem(n);
const stepAttr = () => (app.dec ? '0.01' : '1');

// ---------- seats & chips ----------
export function seatDialog(seat) {
  const s = app.state;
  const st = s.table.settings;
  const club = !!s.table.clubId;
  let def = st.bigBlind * 100;
  if (st.minBuyIn) def = Math.max(def, st.minBuyIn);
  if (st.maxBuyIn) def = Math.min(def, st.maxBuyIn);
  const range = st.minBuyIn || st.maxBuyIn ? `Buy-in ${st.minBuyIn ? fmt(st.minBuyIn) : 'any'} to ${st.maxBuyIn ? fmt(st.maxBuyIn) : 'any'}.` : '';
  const avail = club && s.me.clubAvailable !== null ? ` You have ${fmt(Math.max(0, s.me.clubAvailable))} club chips available.` : '';
  const auto = s.me.isHost || st.autoApprove;
  const dlg = dialog({
    title: `Sit in seat ${seat + 1}`, className: 'narrow',
    body: `<form class="stack">
      <label><span class="lbl">Name at this table</span><input name="nick" type="text" maxlength="24" value="${esc(app.me?.name || '')}" required></label>
      <label><span class="lbl">Buy-in</span><input name="buyIn" type="number" inputmode="decimal" step="${stepAttr()}" min="0" value="${inp(def)}" required></label>
      <p class="hint">${esc(range + avail)}${auto ? '' : ' The host approves seat requests.'}</p>
      <p class="bad hidden" data-err></p>
      <button class="btn primary" type="submit">${auto ? 'Sit down' : 'Request seat'}</button>
    </form>`,
  });
  dlg.$('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const ack = await emit('seat:request', { seat, buyIn: parse(val(f, 'buyIn').value), name: val(f, 'nick').value }, { quiet: true });
    if (ack.ok) {
      dlg.close();
      toast(ack.seated ? 'You sat down' : 'Seat requested. The host will approve it.');
    } else {
      const el = dlg.$('[data-err]');
      el.textContent = ack.error || 'Could not request the seat';
      el.classList.remove('hidden');
    }
  });
  setTimeout(() => dlg.$('[name=buyIn]').select(), 30);
}

export function chipsDialog() {
  const s = app.state;
  const st = s.table.settings;
  const seat = s.seats[s.me.seat];
  const room = st.maxBuyIn ? Math.max(0, st.maxBuyIn - seat.stack - (seat.pendingChips || 0)) : null;
  const def = room !== null ? room : st.bigBlind * 100;
  const auto = s.me.isHost || st.autoApprove;
  const club = s.table.clubId && s.me.clubAvailable !== null ? ` You have ${fmt(Math.max(0, s.me.clubAvailable))} club chips available.` : '';
  const dlg = dialog({
    title: 'Add chips', className: 'narrow',
    body: `<form class="stack">
      <label><span class="lbl">Amount</span><input name="amount" type="number" inputmode="decimal" step="${stepAttr()}" value="${inp(def)}" required></label>
      <p class="hint">${room !== null ? `You can add up to ${fmt(room)} (maximum stack ${fmt(st.maxBuyIn)}).` : ''}${esc(club)} Chips added during a hand arrive when it ends.${auto ? '' : ' The host approves chip requests.'}</p>
      <button class="btn primary" type="submit">${auto ? 'Add chips' : 'Request chips'}</button>
    </form>`,
  });
  dlg.$('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ack = await emit('chips:request', { amount: parse(val(e.target, 'amount').value) });
    if (ack.ok) { dlg.close(); toast(ack.pending ? 'Chip request sent to the host' : 'Chips added'); }
  });
}

export async function standDialog() {
  const s = app.state;
  const seat = s.seats[s.me.seat];
  const inHand = s.hand && s.hand.phase !== 'done' && s.hand.players.some((p) => p.id === s.me.userId);
  const where = s.table.clubId ? 'back to your club balance' : 'out in the ledger';
  const ok = await confirmDialog(inHand
    ? `You will leave after this hand and your stack will be cashed ${where}. Remaining decisions this hand are checked or folded for you.`
    : `Your stack of ${fmt(seat.stack)} will be cashed ${where}.`, { title: 'Stand up?', ok: 'Stand up' });
  if (ok) emit('standup');
}

// ---------- host ----------
export function requestsDialog() {
  const dlg = dialog({ title: 'Requests', className: 'narrow', body: '<div class="req-list" data-reqs></div>', onClose: () => { delete open.requests; } });
  const draw = (s) => {
    const list = s.requests || [];
    dlg.$('[data-reqs]').innerHTML = list.length ? list.map((r) => `
      <div class="req"><div class="grow"><b>${esc(r.name)}</b><small>${r.type === 'seat' ? `Seat ${r.seat + 1} with ${fmt(r.amount)}` : `Add ${fmt(r.amount)}`}</small></div>
      <button class="btn small ghost" data-decide="${esc(r.id)}" data-approve="0">Decline</button>
      <button class="btn small primary" data-decide="${esc(r.id)}" data-approve="1">Approve</button></div>`).join('') : '<p class="muted">No pending requests.</p>';
  };
  open.requests = draw;
  draw(app.state);
  dlg.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-decide]');
    if (b) { b.disabled = true; emit('host:decide', { requestId: b.dataset.decide, approve: b.dataset.approve === '1' }); }
  });
}

export function playerDialog(userId) {
  const s = app.state;
  const seat = s.seats.find((x) => x && x.userId === userId);
  if (!seat || !s.me.isHost) return;
  const club = !!s.table.clubId;
  const dlg = dialog({
    title: seat.name, className: 'narrow',
    body: `<div class="stack">
      <p class="muted">Seat ${seat.seat + 1}, stack ${fmt(seat.stack)}${seat.sittingOut ? ', sitting out' : ''}${seat.connected ? '' : ', disconnected'}</p>
      <div class="row"><button class="btn" data-p="away">Set to sitting out</button><button class="btn danger" data-p="kick">Remove from table</button></div>
      ${club ? '<p class="hint">Stacks at club tables come from member balances. Credit the member in the club ledger, then they can add chips.</p>' : `
      <form class="stack" data-adjust>
        <label><span class="lbl">Adjust stack (recorded in the ledger)</span><input name="delta" type="number" step="${stepAttr()}" placeholder="e.g. 50 or -50"></label>
        <button class="btn" type="submit">Apply adjustment</button>
      </form>`}
    </div>`,
  });
  dlg.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    if (b.dataset.p === 'away') { const a = await emit('host:away', { userId }); if (a.ok) dlg.close(); }
    if (b.dataset.p === 'kick') {
      if (await confirmDialog(`Remove ${seat.name}? Their stack is cashed out.`, { ok: 'Remove', danger: true })) {
        const a = await emit('host:kick', { userId });
        if (a.ok) dlg.close();
      }
    }
  });
  dlg.$('[data-adjust]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = await emit('host:adjust', { userId, delta: parse(val(e.target, 'delta').value) });
    if (a.ok) { toast('Stack adjusted'); dlg.close(); }
  });
}

export function hostDialog() {
  const s = app.state;
  const t = s.table;
  const st = t.settings;
  const opt = (v, l, cur) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${l}</option>`;
  const ends = t.session && t.session.endsAt;
  const dlg = dialog({
    title: 'Game options', className: 'wide',
    tabs: [
      { id: 'game', label: 'Game' }, { id: 'bomb', label: 'Bomb pots' }, { id: 'run', label: 'Run it' },
      { id: 'time', label: 'Time' }, { id: 'fair', label: 'Fairness' }, { id: 'players', label: 'Players' }, { id: 'table', label: 'Table' },
    ],
    body: `<form id="hostform" autocomplete="off">
      <div data-panel="game" class="stack">
        <label><span class="lbl">Table name</span><input name="tableName" type="text" maxlength="40" value="${esc(t.name)}"></label>
        <div>
          <span class="lbl">Format</span>
          ${formatEditorHTML(st.format)}
          <p class="hint">An orbit ends when the button has gone around the table once. Changes apply from the next hand; changing which games are played, or their order, starts again from step 1.</p>
        </div>
        <div class="field-grid">
          <label><span class="lbl">Small blind</span><input name="smallBlind" type="number" step="${stepAttr()}" min="0" value="${inp(st.smallBlind)}"></label>
          <label><span class="lbl">Big blind</span><input name="bigBlind" type="number" step="${stepAttr()}" min="0" value="${inp(st.bigBlind)}"></label>
          <label><span class="lbl">Minimum buy-in</span><input name="minBuyIn" type="number" step="${stepAttr()}" min="0" value="${st.minBuyIn ? inp(st.minBuyIn) : ''}" placeholder="Any"></label>
          <label><span class="lbl">Maximum stack</span><input name="maxBuyIn" type="number" step="${stepAttr()}" min="0" value="${st.maxBuyIn ? inp(st.maxBuyIn) : ''}" placeholder="Any"></label>
          <label><span class="lbl">Seats</span><select name="maxPlayers">${[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => opt(n, n, st.maxPlayers)).join('')}</select></label>
        </div>
        <p class="hint" data-seat-hint></p>
        <label class="check"><input type="checkbox" name="autoApprove" ${st.autoApprove ? 'checked' : ''}> Approve seat and chip requests automatically<small>Leave off to approve every buy-in and rebuy yourself.</small></label>
      </div>
      <div data-panel="bomb" class="stack hidden">
        ${bombFieldsHTML(st.bombPot)}
        <p class="hint">Everyone antes, there is no preflop betting and the flop comes straight away. A random bomb pot is decided from that hand's sealed seed, so players can check it was not picked by hand.</p>
        <div class="row"><button type="button" class="btn" data-now="bomb">${t.bombNext ? 'Cancel next hand’s bomb pot' : 'Bomb pot next hand'}</button></div>
      </div>
      <div data-panel="run" class="stack hidden">
        <label class="check"><input type="checkbox" name="ritEnabled" ${st.rit.enabled ? 'checked' : ''}> Let players run it more than once<small>${esc(ritText)} Each run pays its share of every pot.</small></label>
        <div><span class="lbl">Most runs allowed</span>${seg('ritMax', [[2, 'Twice'], [3, 'Three times'], [4, 'Four times']], st.rit.maxRuns)}</div>
        <p class="hint">Extra runs come off the same sealed deck in order. In very full PLO5 pots the deck may only allow fewer runs.</p>
      </div>
      <div data-panel="time" class="stack hidden">
        <div class="field-grid">
          <label><span class="lbl">Seconds to act</span><input name="decisionSeconds" type="number" min="5" max="600" value="${st.decisionSeconds}"></label>
          <label><span class="lbl">Time bank (seconds per player)</span><input name="timeBankSeconds" type="number" min="0" max="3600" value="${st.timeBankSeconds}"></label>
          <label><span class="lbl">Game length (minutes)</span><input name="sessionMinutes" type="number" min="0" max="1440" value="${st.sessionMinutes || ''}" placeholder="No limit"></label>
        </div>
        <p class="hint">When the game length runs out, the hand in progress finishes and everyone is cashed out. Leave it empty for no limit.</p>
        ${ends && t.status === 'running' ? `<p>This game ends at <b>${new Date(ends).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>.</p>` : ''}
        ${t.status === 'running' ? `<div class="row"><button type="button" class="btn small" data-now="extend" data-min="15">Add 15 min</button><button type="button" class="btn small" data-now="extend" data-min="30">Add 30 min</button><button type="button" class="btn small" data-now="extend" data-min="60">Add 1 hour</button>${ends ? '<button type="button" class="btn small ghost" data-now="cleartime">Remove the limit</button>' : ''}</div>` : ''}
      </div>
      <div data-panel="fair" class="stack hidden">
        <label class="check"><input type="radio" name="revealPolicy" value="hand" ${st.revealPolicy === 'hand' ? 'checked' : ''}> Reveal each hand's seed right after the hand<small>Every player's browser checks every hand as it happens. Folded cards become visible in the hand history.</small></label>
        <label class="check"><input type="radio" name="revealPolicy" value="session" ${st.revealPolicy === 'session' ? 'checked' : ''}> Reveal the seeds when the game ends<small>Folded cards stay private while you play. Every hand is checked when the game ends.</small></label>
        <div class="row"><button type="button" class="btn small" data-now="reveal">Reveal seeds for finished hands now</button></div>
      </div>
      <div data-panel="players" class="stack hidden"><div data-players></div></div>
      <div data-panel="table" class="stack hidden">
        <div><span class="lbl">Felt color for everyone</span>
          <div class="swatches" data-felts>${FELTS.map((f) => `<button type="button" class="swatch ${f.id === st.feltColor ? 'on' : ''}" style="background:${f.id}" data-felt="${f.id}" title="${esc(f.name)}"></button>`).join('')}
            <input type="color" name="feltColor" value="${esc(st.feltColor)}" title="Custom color" style="width:46px;height:38px;padding:2px">
          </div>
          <p class="hint">Players can still pick their own felt under Look.</p>
        </div>
        <label class="check"><input type="checkbox" name="spectatorChat" ${st.spectatorChat ? 'checked' : ''}> Spectators can chat</label>
        ${t.clubId ? '' : `<div><span class="lbl">Chip amounts</span>${seg('decimals', [[0, 'Whole chips'], [2, 'Two decimals (0.25/0.50)']], st.decimals)}<p class="hint">Can only change before anyone buys in.</p></div>`}
        <div class="row">
          ${t.status === 'waiting' ? '<button type="button" class="btn primary" data-now="start">Start the game</button>' : ''}
          ${t.status === 'running' ? (t.paused ? '<button type="button" class="btn" data-now="resume">Resume</button>' : '<button type="button" class="btn" data-now="pause">Pause after this hand</button>') : ''}
          ${t.status !== 'ended' ? '<button type="button" class="btn danger" data-now="end">End the game</button>' : ''}
        </div>
      </div>
    </form>`,
    foot: '<button class="btn ghost" data-close>Close</button><button class="btn primary" data-save>Save settings</button>',
    onClose: () => { delete open.players; },
  });
  const form = dlg.$('#hostform');
  bindSegs(dlg.el);
  bindBombFields(form);
  const refit = () => fitSeats(val(form, 'maxPlayers'), readFormat(form), readBomb(form), dlg.$('[data-seat-hint]'));
  bindFormatEditor(form, refit);
  form.addEventListener('change', (e) => { if (e.target.closest('[data-bomb]')) refit(); });
  dlg.el.addEventListener('click', async (e) => {
    const f = e.target.closest('[data-felt]');
    if (f) {
      val(form, 'feltColor').value = f.dataset.felt;
      dlg.$$('[data-felt]').forEach((x) => x.classList.toggle('on', x === f));
    }
    const now = e.target.closest('[data-now]');
    if (!now) return;
    const k = now.dataset.now;
    if (k === 'bomb') { const a = await emit('host:bomb', { value: !app.state.table.bombNext }); if (a.ok) now.textContent = app.state.table.bombNext ? 'Bomb pot next hand' : 'Cancel next hand’s bomb pot'; }
    if (k === 'extend') { const a = await emit('host:extend', { minutes: Number(now.dataset.min) }); if (a.ok) toast('Time added'); }
    if (k === 'cleartime') { const a = await emit('host:clearTime'); if (a.ok) toast('Time limit removed'); }
    if (k === 'reveal') {
      if (await confirmDialog('Every finished hand’s seed is revealed, including folded cards.', { title: 'Reveal seeds now?', ok: 'Reveal' })) {
        const a = await emit('host:reveal');
        if (a.ok) toast('Seeds revealed');
      }
    }
    if (k === 'start') { const a = await emit('host:start'); if (a.ok) dlg.close(); }
    if (k === 'pause' || k === 'resume') { const a = await emit('host:pause', { value: k === 'pause' }); if (a.ok) dlg.close(); }
    if (k === 'end') {
      if (await confirmDialog('The hand in progress finishes, then everyone is cashed out and every seed is revealed.', { title: 'End the game?', ok: 'End the game', danger: true })) {
        const a = await emit('host:end');
        if (a.ok) dlg.close();
      }
    }
  });
  const drawPlayers = (s2) => {
    const seated = s2.seats.filter(Boolean);
    const reqs = s2.requests || [];
    dlg.$('[data-players]').innerHTML = `
      ${reqs.length ? `<h3 class="section-title">Waiting for you</h3><div class="req-list">${reqs.map((r) => `
        <div class="req"><div class="grow"><b>${esc(r.name)}</b><small>${r.type === 'seat' ? `Seat ${r.seat + 1} with ${fmt(r.amount)}` : `Add ${fmt(r.amount)}`}</small></div>
        <button type="button" class="btn small ghost" data-decide="${esc(r.id)}" data-approve="0">Decline</button>
        <button type="button" class="btn small primary" data-decide="${esc(r.id)}" data-approve="1">Approve</button></div>`).join('')}</div>` : ''}
      <h3 class="section-title">At the table</h3>
      ${seated.length ? `<table class="data"><thead><tr><th>Seat</th><th>Player</th><th class="n">Stack</th><th>Status</th><th></th></tr></thead><tbody>
      ${seated.map((p) => `<tr><td>${p.seat + 1}</td><td>${esc(p.name)}${p.isHost ? ' <span class="host-mark">&#9733;</span>' : ''}</td><td class="n">${fmt(p.stack)}</td>
        <td class="muted">${[p.sittingOut ? 'Sitting out' : '', p.leaving ? 'Leaving' : '', p.connected ? '' : 'Disconnected'].filter(Boolean).join(', ') || 'Playing'}</td>
        <td style="text-align:right">${p.userId !== s2.me.userId ? `<button type="button" class="btn tiny" data-manage="${esc(p.userId)}">Manage</button>` : ''}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">Nobody is seated yet.</p>'}`;
  };
  open.players = drawPlayers;
  drawPlayers(s);
  dlg.$('[data-players]').addEventListener('click', (e) => {
    const d = e.target.closest('[data-decide]');
    if (d) { d.disabled = true; emit('host:decide', { requestId: d.dataset.decide, approve: d.dataset.approve === '1' }); }
    const m = e.target.closest('[data-manage]');
    if (m) playerDialog(m.dataset.manage);
  });
  dlg.$('[data-save]').addEventListener('click', async () => {
    const num = (n) => Number(val(form, n).value);
    const settings = {
      name: val(form, 'tableName').value,
      format: readFormat(form),
      smallBlind: parse(val(form, 'smallBlind').value),
      bigBlind: parse(val(form, 'bigBlind').value),
      minBuyIn: val(form, 'minBuyIn').value ? parse(val(form, 'minBuyIn').value) : 0,
      maxBuyIn: val(form, 'maxBuyIn').value ? parse(val(form, 'maxBuyIn').value) : 0,
      maxPlayers: num('maxPlayers'),
      autoApprove: val(form, 'autoApprove').checked,
      bombPot: readBomb(form),
      rit: { enabled: val(form, 'ritEnabled').checked, maxRuns: num('ritMax') },
      decisionSeconds: num('decisionSeconds'),
      timeBankSeconds: num('timeBankSeconds'),
      sessionMinutes: Number(val(form, 'sessionMinutes').value || 0),
      revealPolicy: val(form, 'revealPolicy').value,
      feltColor: val(form, 'feltColor').value,
      spectatorChat: val(form, 'spectatorChat').checked,
    };
    const dec = val(form, 'decimals');
    if (dec && Number(dec.value) !== st.decimals) settings.decimals = Number(dec.value);
    const a = await emit('host:settings', { settings });
    if (a.ok) { toast('Settings saved'); dlg.close(); }
  });
}

// ---------- ledger ----------
function settleUp(rows) {
  const cred = rows.filter((r) => r.net > 0).map((r) => ({ name: r.name, amt: r.net })).sort((a, b) => b.amt - a.amt);
  const debt = rows.filter((r) => r.net < 0).map((r) => ({ name: r.name, amt: -r.net })).sort((a, b) => b.amt - a.amt);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < debt.length && j < cred.length) {
    const x = Math.min(debt[i].amt, cred[j].amt);
    out.push({ from: debt[i].name, to: cred[j].name, amt: x });
    debt[i].amt -= x;
    cred[j].amt -= x;
    if (!debt[i].amt) i++;
    if (!cred[j].amt) j++;
  }
  return out;
}

export async function ledgerDialog() {
  const r = await emit('ledger:get');
  if (!r.ok) return;
  const L = r.ledger;
  const rows = L.rows.slice().sort((a, b) => b.net - a.net);
  const tot = rows.reduce((a, x) => ({ buyIn: a.buyIn + x.buyIn, buyOut: a.buyOut + x.buyOut, stack: a.stack + x.stack, net: a.net + x.net }), { buyIn: 0, buyOut: 0, stack: 0, net: 0 });
  const sign = (n) => `<span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${n > 0 ? '+' : ''}${fmt(n)}</span>`;
  const transfers = settleUp(rows);
  const typeName = { buyin: 'Buy-in', cashout: 'Cash-out', adjust: 'Host adjustment' };
  const dlg = dialog({
    title: 'Ledger', className: 'wide',
    body: `
      ${rows.length ? `<table class="data">
        <thead><tr><th>Player</th><th class="n">Buy-ins</th><th class="n">Cash-outs</th><th class="n">Stack</th><th class="n">Net</th></tr></thead>
        <tbody>${rows.map((x) => `<tr><td>${esc(x.name)}${x.seated ? '' : ' <span class="faint">(left)</span>'}</td><td class="n">${fmt(x.buyIn)}</td><td class="n">${fmt(x.buyOut)}</td><td class="n">${x.seated ? fmt(x.stack) : '<span class="faint">-</span>'}</td><td class="n">${sign(x.net)}</td></tr>`).join('')}
        <tr class="total"><td>Total</td><td class="n">${fmt(tot.buyIn)}</td><td class="n">${fmt(tot.buyOut)}</td><td class="n">${fmt(tot.stack)}</td><td class="n">${sign(tot.net)}</td></tr></tbody>
      </table>` : '<p class="muted">No buy-ins yet.</p>'}
      ${L.clubId ? `<p class="hint">Buy-ins come out of club balances and cash-outs go back in. See the <a href="/club/${esc(L.clubId)}">club ledger</a> for balances and credit.</p>` : transfers.length ? `
        <h3 class="section-title">Settle up</h3>
        <p class="hint">The fewest payments that square everyone, based on the net column${app.state.table.status === 'ended' ? '' : ' right now'}.</p>
        <table class="data"><tbody>${transfers.map((t) => `<tr><td>${esc(t.from)} pays ${esc(t.to)}</td><td class="n">${fmt(t.amt)}</td></tr>`).join('')}</tbody></table>` : ''}
      <details style="margin-top:1rem"><summary class="muted" style="cursor:pointer">Every entry (${L.entries.length})</summary>
        <table class="data" style="margin-top:.5rem"><thead><tr><th>Time</th><th>Player</th><th>Type</th><th class="n">Amount</th><th>Note</th></tr></thead><tbody>
        ${L.entries.slice().reverse().map((e) => `<tr><td class="muted">${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td><td>${esc(e.name)}</td><td>${typeName[e.type] || esc(e.type)}</td><td class="n">${fmt(e.amount)}</td><td class="muted">${esc(e.note || '')}</td></tr>`).join('')}
        </tbody></table></details>`,
    foot: '<button class="btn" data-csv>Download CSV</button><button class="btn primary" data-close>Done</button>',
  });
  dlg.$('[data-csv]').addEventListener('click', () => api.download(`/api/tables/${app.tableId}/ledger.csv`, `ledger-${app.state.table.name.replace(/[^\w-]+/g, '-')}.csv`).catch((e) => toast(e.message, 'error')));
}

// ---------- hand history ----------
function badge(n, revealed) {
  const r = app.fair.result(n);
  if (r) return r.ok ? '<span class="vbadge ok">&#10003; Verified</span>' : '<span class="vbadge bad">&#10007; Failed</span>';
  if (!revealed) return '<span class="vbadge wait">Sealed until the game ends</span>';
  return '<span class="vbadge wait">Not checked</span>';
}

export async function handsDialog() {
  const r = await emit('hands:list');
  if (!r.ok) return;
  const dlg = dialog({ title: 'Hand history', className: 'wide', body: '' });
  const showList = () => {
    dlg.$('h2').textContent = 'Hand history';
    dlg.setBody(r.hands.length ? `<table class="data"><thead><tr><th>Hand</th><th>Time</th><th>Game</th><th>Won by</th><th class="n">Pot</th><th class="n">You</th><th>Deck check</th></tr></thead><tbody>
      ${r.hands.map((x) => `<tr class="hand-row" data-hand="${x.handNumber}" tabindex="0">
        <td class="num">#${x.handNumber}</td><td class="muted">${new Date(x.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
        <td>${esc(gameShort(x.gameType))}${x.isBomb ? ' bomb pot' : ''}${x.doubleBoard ? ', double board' : ''}${x.runCount > 1 ? `, ran ${x.runCount}×` : ''}</td>
        <td>${x.winners.map(esc).join(', ')}</td><td class="n">${fmt(x.pot)}</td>
        <td class="n">${x.myNet === null ? '<span class="faint">-</span>' : `<span class="${x.myNet > 0 ? 'pos' : x.myNet < 0 ? 'neg' : ''}">${x.myNet > 0 ? '+' : ''}${fmt(x.myNet)}</span>`}</td>
        <td>${badge(x.handNumber, x.revealed)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No finished hands yet.</p>');
  };
  showList();
  dlg.el.addEventListener('click', (e) => {
    const row = e.target.closest('[data-hand]');
    if (row) showHand(dlg, Number(row.dataset.hand), showList);
    if (e.target.closest('[data-back]')) showList();
  });
  dlg.el.addEventListener('keydown', (e) => {
    const row = e.target.closest('[data-hand]');
    if (row && e.key === 'Enter') showHand(dlg, Number(row.dataset.hand), showList);
  });
}

const mini = (cards) => `<span class="mini-cards">${(cards || []).map((c) => cardHTML(c)).join('')}</span>`;

async function showHand(dlg, n, back) {
  dlg.$('h2').textContent = `Hand #${n}`;
  dlg.setBody('<p class="muted">Loading…</p>');
  const r = await emit('hand:get', { handNumber: n });
  if (!r.ok) return back();
  const rec = r.record;
  const f = rec.fairness;
  const res = rec.revealed ? await app.fair.verify(rec) : null;
  const seedHash = f.serverSeed ? await wc.sha256Hex(f.serverSeed) : null;
  const obs = app.fair.observed(n) || {};
  const dec = rec.decimals;
  const F = (a) => (dec ? (a / 100).toFixed(2) : String(a));
  const lines = [];
  const bpr = rec.dealt.boardsPerRun || 1;
  const nb = rec.dealt.boards.length;
  const where = (run) => { const n = boardName(run.b ?? run.run, bpr, rec.results.boards.length || nb); return n ? ` on ${n.toLowerCase()}` : ''; };
  rec.results.pots.forEach((pot, pi) => pot.runs.forEach((run) => {
    if (pot.uncontested) { lines.push(`${esc(run.winners[0].name)} won ${fmt(run.amount)} (${pi ? `side pot ${pi}` : 'main pot'}, nobody else left in it)`); return; }
    lines.push(`${run.winners.map((w) => esc(w.name)).join(' and ')} ${run.winners.length > 1 ? 'split' : 'won'} ${fmt(run.amount)}${run.winners[0]?.hand ? ` with ${esc(run.winners[0].hand)}` : ''}${where(run)}${rec.results.pots.length > 1 ? (pi ? ` (side pot ${pi})` : ' (main pot)') : ''}`);
  }));
  dlg.setBody(`
    <div class="row" style="justify-content:space-between"><button class="btn small ghost" data-back>All hands</button>
      <span class="muted">${esc(gameName(rec.gameType))}${rec.isBomb ? ', bomb pot' : ''}${rec.doubleBoard ? ', double board' : ''}, blinds ${F(rec.smallBlind)}/${F(rec.bigBlind)}, ${new Date(rec.startedAt).toLocaleString()}</span></div>
    <h3 class="section-title">Board${nb > 1 ? 's' : ''}</h3>
    <div class="stack-sm">${rec.dealt.boards.map((b, i) => `<div>${nb > 1 ? `<span class="muted blabel">${esc(boardName(i, bpr, nb))}</span>` : ''}${b.length ? mini(b) : '<span class="faint">No board dealt</span>'}</div>`).join('')}</div>
    <h3 class="section-title">Players</h3>
    <table class="data"><thead><tr><th>Seat</th><th>Player</th><th>Cards</th><th class="n">Start</th><th class="n">End</th><th class="n">Net</th></tr></thead><tbody>
    ${rec.players.map((p) => `<tr><td>${p.seat + 1}${p.seat === rec.buttonSeat ? ' <span class="faint">(D)</span>' : ''}</td><td>${esc(p.name)}${p.folded ? ' <span class="faint">folded</span>' : ''}</td>
      <td>${rec.dealt.holes[p.seat] ? mini(rec.dealt.holes[p.seat]) : '<span class="faint">Hidden</span>'}</td>
      <td class="n">${fmt(p.startStack)}</td><td class="n">${fmt(p.endStack)}</td><td class="n"><span class="${p.net > 0 ? 'pos' : p.net < 0 ? 'neg' : ''}">${p.net > 0 ? '+' : ''}${fmt(p.net)}</span></td></tr>`).join('')}
    </tbody></table>
    <p style="margin-top:.6rem">${lines.join('<br>')}</p>
    <h3 class="section-title">Deck check</h3>
    <div class="seal-pair">
      <figure>${sealSVG(obs.commitment || f.commitment, 64)}<figcaption>Seal ${obs.commitment ? 'your browser saw before the deal' : 'published before the deal'}</figcaption></figure>
      <figure>${seedHash ? sealSVG(seedHash, 64) : sealSVG('', 64)}<figcaption>${seedHash ? 'Seal rebuilt from the revealed seed' : 'Seed revealed when the game ends'}</figcaption></figure>
    </div>
    ${res ? `<ul class="checks" style="margin-top:.8rem">${res.checks.map((c) => `<li class="${c.ok ? 'okc' : 'badc'}"><span class="i">${c.ok ? '&#10003;' : '&#10007;'}</span><span>${esc(c.label)}</span></li>`).join('')}</ul>` : ''}
    <details style="margin-top:.8rem"><summary class="muted" style="cursor:pointer">Raw data</summary>
      <p class="hexline">Commitment (SHA-256 of the seed): ${esc(f.commitment)}</p>
      <p class="hexline">Server seed: ${f.serverSeed ? esc(f.serverSeed) : 'not revealed yet'}</p>
      <p class="hexline">Player inputs: ${f.contributions.map((c) => `${esc(c.name)} ${esc(c.seed)}`).join(', ') || 'none'}</p>
      <p class="hexline">Entropy string: ${esc(f.entropy)}</p>
      ${res ? `<p class="hexline">Deck order: ${res.deck.join(' ')}</p>` : ''}
    </details>
    <details style="margin-top:.4rem"><summary class="muted" style="cursor:pointer">Hand log</summary><div class="hexline" style="font-family:var(--ui);font-size:14px">${(rec.log || []).map(esc).join('<br>')}</div></details>
    <div class="row" style="margin-top:1rem"><button class="btn small" data-json>Download this hand</button><a class="btn small ghost" href="/verify?table=${encodeURIComponent(rec.tableId)}&hand=${rec.handNumber}" target="_blank" rel="noopener">Open in the verifier</a></div>`);
  dlg.$('[data-json]').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(rec, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hand-${rec.tableId}-${rec.handNumber}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
}

// ---------- appearance ----------
export function lookDialog() {
  const s = app.state;
  const sample = ['Ah', 'Kd', 'Qc', 'Js', 'Th'];
  const draw = () => `
    <div class="stack">
      <div class="preview-cards" style="background:${prefs.felt || s.table.settings.feltColor}">${sample.map((c) => cardHTML(c)).join('')}<span class="card back"></span></div>
      <div><span class="lbl">Felt</span>
        <div class="swatches">
          <button type="button" class="btn small ${prefs.felt ? '' : 'primary'}" data-felt="">Table default</button>
          ${FELTS.map((f) => `<button type="button" class="swatch ${prefs.felt === f.id ? 'on' : ''}" style="background:${f.id}" data-felt="${f.id}" title="${esc(f.name)}"></button>`).join('')}
          <input type="color" data-feltpick value="${esc(prefs.felt || s.table.settings.feltColor)}" title="Custom felt color" style="width:46px;height:38px;padding:2px">
        </div></div>
      <div class="row"><div><span class="lbl">Card faces</span>${seg('deck', [['big', 'Large index'], ['classic', 'Classic']], prefs.deck)}</div>
        <label class="check" style="align-self:flex-end"><input type="checkbox" data-pref="fourColor" ${prefs.fourColor ? 'checked' : ''}> Four-color deck</label></div>
      <div><span class="lbl">Card backs</span><div class="swatches">${BACKS.map((b) => `<button type="button" class="swatch ${prefs.back === b.id ? 'on' : ''}" data-back="${b.id}" title="${esc(b.name)}" style="background:var(--back)" data-backswatch="${b.id}"></button>`).join('')}</div></div>
      <div><span class="lbl">When everyone is all in</span>${seg('autoRun', [['ask', 'Ask me to vote'], ['once', 'Always vote once'], ['max', 'Always vote the most']], prefs.autoRun)}</div>
      <label class="check"><input type="checkbox" data-pref="handStrength" ${prefs.handStrength ? 'checked' : ''}> Show what my hand makes</label>
      <label class="check"><input type="checkbox" data-pref="sound" ${prefs.sound ? 'checked' : ''}> Sound when it is my turn</label>
      <label class="check"><input type="checkbox" data-pref="verifyNotes" ${prefs.verifyNotes ? 'checked' : ''}> Note in the log when my browser has checked a hand</label>
      <p class="hint">These settings are saved in this browser and only change what you see.</p>
    </div>`;
  const dlg = dialog({ title: 'Look and feel', body: draw() });
  const redraw = () => { dlg.setBody(draw()); paintBacks(); };
  const paintBacks = () => dlg.$$('[data-backswatch]').forEach((el) => el.setAttribute('data-back', el.dataset.backswatch));
  paintBacks();
  dlg.el.addEventListener('click', (e) => {
    const felt = e.target.closest('[data-felt]');
    if (felt) { savePrefs({ felt: felt.dataset.felt }); app.render(); redraw(); return; }
    const back = e.target.closest('[data-backswatch]');
    if (back) { savePrefs({ back: back.dataset.backswatch }); app.render(); redraw(); return; }
    const sg = e.target.closest('[data-seg] button');
    if (sg) { savePrefs({ [sg.closest('[data-seg]').dataset.seg]: sg.dataset.v }); app.actionKey = null; app.render(); redraw(); }
  });
  dlg.el.addEventListener('change', (e) => {
    if (e.target.matches('[data-pref]')) { savePrefs({ [e.target.dataset.pref]: e.target.checked }); app.render(); redraw(); }
    if (e.target.matches('[data-feltpick]')) { savePrefs({ felt: e.target.value }); app.render(); redraw(); }
  });
}

// ---------- small-screen menu ----------
export function menuDialog() {
  const s = app.state;
  const items = [
    s.me.isHost && ['options', 'Game options'],
    ['ledger', 'Ledger'], ['hands', 'Hand history'], ['fair', 'Sealed deck'], ['look', 'Look and feel'], ['log', 'Log and chat'],
  ].filter(Boolean);
  const dlg = dialog({
    title: 'Menu', className: 'narrow',
    body: `<div class="stack-sm">${items.map(([k, l]) => `<button class="btn" style="width:100%" data-go="${k}">${l}</button>`).join('')}<a class="btn ghost" style="width:100%" href="/">Back to the lobby</a></div>`,
  });
  dlg.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    dlg.close();
    const k = b.dataset.go;
    if (k === 'log') { document.querySelector('[data-open="log"]')?.click(); return; }
    ({ options: hostDialog, ledger: ledgerDialog, hands: handsDialog, fair: fairDialog, look: lookDialog })[k]?.();
  });
}

// ---------- fairness explainer ----------
export function fairDialog() {
  const s = app.state;
  const f = s.fairness;
  const policy = s.table.settings.revealPolicy === 'hand' ? 'right after each hand' : 'when the game ends';
  const verified = Object.values(app.fair.data.hands).filter((h) => h.result && h.result.ok).length;
  const failed = Object.values(app.fair.data.hands).filter((h) => h.result && !h.result.ok).length;
  const dlg = dialog({
    title: 'Sealed deck',
    body: `
      <div class="big-seal">${sealSVG(f.commitment, 88)}
        <div><h3 style="margin:0">Hand #${f.handNumber} is sealed</h3>
          <p class="muted" style="margin:.3rem 0">${f.contributions} player input${f.contributions === 1 ? '' : 's'} received${s.me.seated ? (f.iContributed ? ', including yours' : ', yours is on its way') : ''}.</p>
          <p class="hexline" style="margin:0">${esc(f.commitment)}</p></div></div>
      <h3 class="section-title">How every deal can be checked</h3>
      <ol class="fair-steps">
        <li>Before each hand the server shuffles with a secret seed and publishes its SHA-256 fingerprint, drawn above as the seal. Changing the seed later would change the seal.</li>
        <li>Each seated player's browser adds its own random input after seeing the seal, so the server cannot pick a seed that favours anyone.</li>
        <li>The deck order is computed from the seed and every input with HMAC-SHA256 and a standard Fisher-Yates shuffle. Cards come off the top in order, extra runs included.</li>
        <li>The seed is revealed ${policy}. Your browser then rebuilds the deck and checks the seal, your input, your cards and every board.</li>
      </ol>
      <p style="margin-top:1rem">This browser has checked <b>${verified}</b> hand${verified === 1 ? '' : 's'} at this table${failed ? `, and <b class="bad">${failed}</b> failed` : ''}.</p>
      <p class="hint">What this does not cover: whoever runs the server can see cards in memory during a hand, as with any online poker site. The check proves the deck was fixed before the deal and never changed.</p>`,
    foot: `<button class="btn ghost" data-copy>Copy fingerprint</button><a class="btn" href="/verify" target="_blank" rel="noopener">Open the verifier</a><button class="btn primary" data-close>Done</button>`,
  });
  dlg.$('[data-copy]').addEventListener('click', () => copyText(f.commitment));
}
