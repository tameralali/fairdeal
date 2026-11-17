import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { io as ioc } from 'socket.io-client';
import { createServer } from '../server/index.js';
import { DELAYS } from '../server/table.js';
import { verifyHandRecord, webCryptoAdapter } from '../shared/fairness.js';

Object.assign(DELAYS, { street: 2, runoutFirst: 2, runout: 2, showdown: 2, afterUncontested: 10, afterShowdown: 10, perExtraRun: 2, rit: 250, autoAct: 10 });

let srv, url, dataDir;
const wc = webCryptoAdapter();

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-'));
  srv = createServer({ dataDir });
  const port = await srv.listen(0);
  url = `http://127.0.0.1:${port}`;
});
const allBots = [];
after(async () => { for (const b of allBots) b.close(); await srv.close(); });

async function call(method, p, body, token) {
  const r = await fetch(url + p, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}

function rngFrom(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

class Bot {
  constructor(name, auth, seed) {
    this.name = name; this.token = auth.token; this.userId = auth.user.id;
    this.rng = rngFrom(seed);
    this.seeds = {}; this.observed = {}; this.errors = []; this.busy = false; this.ritBusy = false;
    this.contributedFor = null; this.state = null;
    this.passive = false;
    allBots.push(this);
  }
  connect(tableId) {
    return new Promise((resolve, reject) => {
      this.socket = ioc(url, { auth: { token: this.token }, transports: ['websocket'], forceNew: true });
      this.socket.on('state', (s) => this.onState(s));
      this.socket.on('connect_error', reject);
      this.socket.on('connect', () => this.socket.emit('table:join', { tableId }, (ack) => (ack.ok ? resolve() : reject(new Error(ack.error)))));
    });
  }
  emit(ev, payload) { return new Promise((resolve) => this.socket.emit(ev, payload, resolve)); }
  onState(s) {
    this.state = s;
    if (s.me.seated && s.fairness.commitment !== this.contributedFor) {
      this.contributedFor = s.fairness.commitment;
      const seed = randomBytes(16).toString('hex');
      const n = s.fairness.handNumber;
      this.socket.emit('fair:contribute', { handNumber: n, commitment: s.fairness.commitment, seed }, (ack) => {
        if (ack.ok && ack.ok === true && !ack.stale && !ack.notSeated && !ack.already) this.seeds[n] = { seed, commitment: s.fairness.commitment };
      });
    }
    if (!this.passive && s.me.seated) {
      const seat = s.seats[s.me.seat];
      const inHand = s.hand && s.hand.phase !== 'done' && s.hand.players.some((p) => p.id === this.userId);
      if (seat && seat.stack === 0 && !seat.pendingChips && !s.me.requests.length && !inHand && !this.rebuyBusy) {
        this.rebuyBusy = true;
        this.rebuys = (this.rebuys || 0) + 1;
        this.socket.emit('chips:request', { amount: 1000 }, () => { this.rebuyBusy = false; });
      }
      if ((s.me.sittingOut || s.me.sitOutNext) && !this.backBusy) {
        this.backBusy = true;
        this.socket.emit('sitout', { value: false }, () => { this.backBusy = false; });
      }
    }
    if (this.approver && s.requests) {
      this.approved ||= new Set();
      for (const r of s.requests) {
        if (this.approved.has(r.id)) continue;
        this.approved.add(r.id);
        this.socket.emit('host:decide', { requestId: r.id, approve: true }, (ack) => { if (!ack.ok) this.errors.push('approve: ' + ack.error); });
      }
    }
    const h = s.hand;
    if (!h) return;
    const me = h.players.find((p) => p.id === this.userId);
    if (me && me.hole) {
      this.observed[h.number] = { mySeat: me.seat, myHole: me.hole, boards: h.runs ? h.runs : [h.board] };
    }
    if (this.passive) return;
    if (h.legal && !this.busy) {
      this.busy = true;
      const l = h.legal;
      const r = this.rng();
      let a;
      if (l.canRaise && r < 0.2) a = { type: 'raise', to: l.minTo + Math.floor(this.rng() * (l.maxTo - l.minTo + 1)) };
      else if (l.canRaise && r < 0.27) a = { type: 'allin' };
      else if (l.canCheck) a = { type: 'check' };
      else if (r < 0.75) a = { type: 'call' };
      else a = { type: 'fold' };
      this.socket.emit('action', a, (ack) => { this.busy = false; if (!ack.ok) this.errors.push(ack.error); });
    }
    if (h.rit && h.rit.canChoose && h.rit.myChoice === null && !this.ritBusy) {
      this.ritBusy = true;
      this.socket.emit('rit', { runs: 1 + Math.floor(this.rng() * 4) }, () => { this.ritBusy = false; });
    }
  }
  close() { this.socket?.close(); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let progress = () => '';
async function until(fn, ms = 20000, label = 'condition') {
  const t0 = Date.now();
  let lastPrint = t0;
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await wait(20);
    if (process.env.DEBUG_TEST && Date.now() - lastPrint > 2000) { lastPrint = Date.now(); console.log('[wait]', label, progress()); }
  }
  throw new Error('timed out waiting for ' + label);
}

async function verifyAll(tableId, bots, hostToken) {
  const { hands } = await call('GET', `/api/tables/${tableId}/hands`, null, hostToken);
  let verified = 0;
  for (const h of hands) {
    for (const b of bots) {
      const { record } = await call('GET', `/api/tables/${tableId}/hands/${h.handNumber}`, null, b.token);
      if (!record.revealed) continue;
      const obs = { ...(b.observed[h.handNumber] || {}) };
      if (b.seeds[h.handNumber]) { obs.mySeed = b.seeds[h.handNumber].seed; obs.commitment = b.seeds[h.handNumber].commitment; }
      if (!b.observed[h.handNumber]) { delete obs.myHole; delete obs.mySeat; }
      const res = await verifyHandRecord(record, wc, obs);
      assert.ok(res.ok, `hand ${h.handNumber} for ${b.name}: ${JSON.stringify(res.checks.filter((c) => !c.ok))}`);
      verified++;
    }
  }
  return { hands: hands.length, verified };
}

test('standalone game: approvals, mixed games, bombs, multi-runs, ledger and verification', { timeout: 240000 }, async () => {
  const auths = [];
  for (const n of ['Tamer', 'Omar', 'Lina', 'Sam', 'Rami']) auths.push(await call('POST', '/api/auth/guest', { name: n }));
  const host = auths[0];
  const { id } = await call('POST', '/api/tables', {
    name: 'Thursday game',
    settings: {
      games: ['plo4', 'nlh'], rotateEvery: 'orbit', smallBlind: 5, bigBlind: 10, minBuyIn: 500, maxBuyIn: 3000,
      bombPot: { mode: 'percent', percent: 30, anteBB: 2, game: 'current' }, rit: { enabled: true, maxRuns: 4 },
      decisionSeconds: 5, timeBankSeconds: 0, revealPolicy: 'hand',
    },
  }, host.token);
  const bots = auths.map((a, i) => new Bot(a.user.name, a, 100 + i));
  for (const b of bots) await b.connect(id);
  progress = () => { const t = srv.tables.get(id); const h = t.hand; return JSON.stringify({ n: t.handNumber, phase: h?.phase, pending: h?.pending, actor: h?.actor()?.name, turn: t.turn, timers: Object.keys(t.timers).filter((k) => t.timers[k] && k !== 'session'), status: t.status, paused: t.paused, waiting: t.waitingReason(), busy: bots.map((b) => b.busy), reqs: t.requests.length }); };

  // host sits directly, others need approval
  let r = await bots[0].emit('seat:request', { seat: 0, buyIn: 1000 });
  assert.ok(r.ok && r.seated);
  r = await bots[1].emit('seat:request', { seat: 2, buyIn: 100 });
  assert.equal(r.ok, false, 'below minimum buy-in rejected');
  for (let i = 1; i < 5; i++) {
    r = await bots[i].emit('seat:request', { seat: i * 2 % 9, buyIn: 1000 + i * 100 });
    assert.ok(r.ok && r.pending, JSON.stringify(r));
  }
  await until(() => bots[0].state?.requests?.length === 4, 5000, 'requests visible to host');
  for (const req of bots[0].state.requests) {
    r = await bots[0].emit('host:decide', { requestId: req.id, approve: true });
    assert.ok(r.ok, r.error);
  }
  r = await bots[1].emit('host:start', {});
  assert.equal(r.ok, false, 'non-host cannot start');
  bots[0].approver = true;
  r = await bots[0].emit('host:start', {});
  assert.ok(r.ok);

  await until(() => (bots[0].state?.table.handNumber || 0) >= 60, 150000, '60 hands');
  // rebuy for anyone busted, then pause
  await bots[0].emit('host:pause', { value: true });
  await until(() => !bots[0].state.hand || bots[0].state.hand.phase === 'done', 10000, 'hand to end');
  await wait(50);

  const ledger = (await bots[0].emit('ledger:get', {})).ledger;
  const totalBuyIn = ledger.rows.reduce((s, x) => s + x.buyIn, 0);
  const totalStacks = ledger.rows.reduce((s, x) => s + x.stack + x.buyOut, 0);
  assert.equal(totalStacks, totalBuyIn, 'ledger balances');
  assert.equal(ledger.rows.reduce((s, x) => s + x.net, 0), 0, 'nets sum to zero');

  const t = srv.tables.get(id);
  const recs = t.getRecords();
  const games = new Set(recs.map((x) => x.gameType));
  assert.ok(games.has('plo4') && games.has('nlh'), 'rotation used both games');
  const bombs = recs.filter((x) => x.isBomb).length;
  const multi = recs.filter((x) => x.runCount > 1).length;
  console.log(`hands ${recs.length}, bombs ${bombs}, multi-run ${multi}, games ${[...games]}, rebuys ${bots.reduce((x, b) => x + (b.rebuys || 0), 0)}`);
  assert.ok(bombs > 3, 'bomb pots happened');

  const v = await verifyAll(id, bots, host.token);
  console.log('verified', v);
  assert.ok(v.verified >= recs.length * 3);
  for (const b of bots) assert.deepEqual(b.errors.filter((e) => !/not your turn/i.test(e)), [], `${b.name} action errors`);

  // time limit: end shortly, the game ends after the current hand and everyone is cashed out
  await bots[0].emit('host:pause', { value: false });
  t.session.endsAt = Date.now() + 300;
  t.scheduleSession();
  await until(() => bots[0].state?.table.status === 'ended', 20000, 'game end by time limit');
  const finalLedger = (await bots[0].emit('ledger:get', {})).ledger;
  assert.ok(finalLedger.rows.every((x) => !x.seated));
  assert.equal(finalLedger.rows.reduce((s, x) => s + x.net, 0), 0);
  bots.forEach((b) => b.close());
});

test('seeds stay hidden until the game ends when the reveal policy is per session', { timeout: 120000 }, async () => {
  const a = await call('POST', '/api/auth/guest', { name: 'Host' });
  const b = await call('POST', '/api/auth/guest', { name: 'Guest' });
  const { id } = await call('POST', '/api/tables', { settings: { revealPolicy: 'session', autoApprove: true, decisionSeconds: 5, timeBankSeconds: 0 } }, a.token);
  const bots = [new Bot('Host', a, 1), new Bot('Guest', b, 2)];
  for (const x of bots) await x.connect(id);
  await bots[0].emit('seat:request', { seat: 0, buyIn: 1000 });
  await bots[1].emit('seat:request', { seat: 1, buyIn: 1000 });
  await bots[0].emit('host:start', {});
  await until(() => (bots[0].state?.table.handNumber || 0) >= 6, 60000, 'hands');
  let { record } = await call('GET', `/api/tables/${id}/hands/2`, null, b.token);
  assert.equal(record.revealed, false);
  assert.equal(record.fairness.serverSeed, null);
  const hidden = record.players.filter((p) => !p.shown && p.userId !== b.user.id);
  for (const p of hidden) assert.equal(record.dealt.holes[p.seat], undefined, 'opponent mucked cards hidden');
  await bots[0].emit('host:end', {});
  await until(() => bots[0].state?.table.status === 'ended', 60000, 'end');
  ({ record } = await call('GET', `/api/tables/${id}/hands/2`, null, b.token));
  assert.equal(record.revealed, true);
  const v = await verifyAll(id, bots, a.token);
  assert.ok(v.verified > 0);
  bots.forEach((x) => x.close());
});

test('club: invites, approvals, chips, credit limits, buy-ins draw from balance, cash-outs return', { timeout: 150000 }, async () => {
  const owner = await call('POST', '/api/auth/register', { username: 'tamer', password: 'secret123', name: 'Tamer' });
  const m1 = await call('POST', '/api/auth/register', { username: 'omar', password: 'secret123', name: 'Omar' });
  const m2 = await call('POST', '/api/auth/register', { username: 'lina', password: 'secret123', name: 'Lina' });
  const guest = await call('POST', '/api/auth/guest', { name: 'Drifter' });
  await assert.rejects(call('POST', '/api/clubs', { name: 'Nope' }, guest.token), /account/);
  const { id: clubId } = await call('POST', '/api/clubs', { name: 'Dubai Thursday Club', decimals: 2 }, owner.token);
  let view = await call('GET', `/api/clubs/${clubId}`, null, owner.token);
  const code = view.club.inviteCode;
  assert.ok(code);
  for (const m of [m1, m2]) {
    const j = await call('POST', '/api/clubs/join', { code }, m.token);
    assert.equal(j.status, 'pending');
  }
  await assert.rejects(call('POST', `/api/clubs/${clubId}/members/${m2.user.id}/decide`, { approve: true }, m1.token), /owner or a manager/);
  for (const m of [m1, m2]) await call('POST', `/api/clubs/${clubId}/members/${m.user.id}/decide`, { approve: true }, owner.token);
  await call('POST', `/api/clubs/${clubId}/members/${m1.user.id}/chips`, { amount: 50000, note: 'Cash received' }, owner.token);
  await call('POST', `/api/clubs/${clubId}/members/${m2.user.id}/credit`, { limit: 30000 }, owner.token);
  await call('POST', `/api/clubs/${clubId}/members/${owner.user.id}/chips`, { amount: 100000 }, owner.token);
  view = await call('GET', `/api/clubs/${clubId}`, null, m1.token);
  assert.equal(view.club.me.balance, 50000);
  assert.equal(view.club.members.find((x) => x.userId === m2.user.id).balance, undefined, 'members cannot see others by default');

  const { id: tableId } = await call('POST', `/api/clubs/${clubId}/tables`, { name: 'Club PLO', settings: { games: ['plo5'], smallBlind: 25, bigBlind: 50, decisionSeconds: 5, timeBankSeconds: 0, bombPot: { mode: 'every', every: 3, anteBB: 1 } } }, owner.token);
  const outsider = new Bot('Drifter', guest, 9);
  await assert.rejects(outsider.connect(tableId), /club members/);
  outsider.close();
  const bots = [new Bot('Tamer', owner, 11), new Bot('Omar', m1, 12), new Bot('Lina', m2, 13)];
  for (const b of bots) await b.connect(tableId);
  let r = await bots[2].emit('seat:request', { seat: 1, buyIn: 40000 });
  assert.equal(r.ok, false, 'over credit limit rejected');
  r = await bots[2].emit('seat:request', { seat: 1, buyIn: 30000 });
  assert.ok(r.ok && r.seated, 'credit buy-in auto-approved');
  r = await bots[1].emit('seat:request', { seat: 3, buyIn: 20000 });
  assert.ok(r.ok && r.seated);
  r = await bots[0].emit('seat:request', { seat: 5, buyIn: 20000 });
  assert.ok(r.ok && r.seated);
  view = await call('GET', `/api/clubs/${clubId}`, null, owner.token);
  assert.equal(view.club.members.find((x) => x.userId === m2.user.id).balance, -30000);
  await until(() => (bots[0].state?.table.handNumber || 0) >= 12, 90000, 'club hands');
  const t = srv.tables.get(tableId);
  assert.ok(t.getRecords().some((x) => x.isBomb), 'every-N bomb pots');
  // bots keep playing so the hand in progress can finish; the game ends right after it
  await bots[0].emit('host:end', {});
  await until(() => bots[0].state?.table.status === 'ended', 60000, 'club table end');
  for (const b of bots) b.passive = true;
  view = await call('GET', `/api/clubs/${clubId}`, null, owner.token);
  const total = view.club.members.reduce((s, x) => s + x.balance, 0);
  assert.equal(total, 150000, 'all chips back in balances');
  assert.equal(view.club.members.reduce((s, x) => s + x.net, 0), 0, 'club nets sum to zero');
  const lina = view.club.members.find((x) => x.userId === m2.user.id);
  if (lina.balance !== 0) {
    await call('POST', `/api/clubs/${clubId}/members/${m2.user.id}/settle`, { note: 'Bank transfer' }, owner.token);
    view = await call('GET', `/api/clubs/${clubId}`, null, owner.token);
    assert.equal(view.club.members.find((x) => x.userId === m2.user.id).balance, 0);
  }
  await call('PATCH', `/api/clubs/${clubId}`, { allowTransfers: true, membersSeeLedger: true }, owner.token);
  await call('POST', `/api/clubs/${clubId}/transfer`, { toUserId: m2.user.id, amount: 100, note: 'lunch' }, owner.token);
  view = await call('GET', `/api/clubs/${clubId}`, null, m1.token);
  assert.ok(view.club.members.find((x) => x.userId === m2.user.id).balance !== undefined, 'ledger visible to members when enabled');
  const csv = await fetch(`${url}/api/clubs/${clubId}/transactions.csv`, { headers: { authorization: 'Bearer ' + owner.token } }).then((x) => x.text());
  assert.match(csv, /buyin/);
  assert.match(csv, /chips_add/);
  bots.forEach((b) => b.close());
});

test('accounts: login, guest upgrade, rename', async () => {
  const g = await call('POST', '/api/auth/guest', { name: 'Temp' });
  const up = await call('POST', '/api/auth/register', { username: 'temp_user', password: 'abcdef' }, g.token);
  assert.equal(up.user.id, g.user.id, 'guest upgraded in place');
  await assert.rejects(call('POST', '/api/auth/login', { username: 'temp_user', password: 'wrong!' }), /Wrong/);
  const li = await call('POST', '/api/auth/login', { username: 'TEMP_USER', password: 'abcdef' });
  assert.equal(li.user.id, g.user.id);
  const me = await call('PATCH', '/api/me', { name: 'Renamed' }, li.token);
  assert.equal(me.user.name, 'Renamed');
});
