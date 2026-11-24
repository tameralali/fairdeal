import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { io as ioc } from 'socket.io-client';
import { createServer } from '../server/index.js';
import { DELAYS } from '../server/table.js';
import { TOURNEY_TIME } from '../server/tourney.js';
import { verifyHandRecord, webCryptoAdapter } from '../shared/fairness.js';
import { buildReplay } from '../shared/replay.js';

Object.assign(DELAYS, { street: 2, runoutFirst: 2, runout: 2, runBreak: 2, rebuy: 20, bombIntro: 2, bombDeal: 0, showdown: 2, afterPreflopFold: 10, afterUncontested: 10, afterShowdown: 10, perExtraRun: 2, rit: 250, autoAct: 10, away: 150 });

let srv, url, dataDir, siteOwner;
const wc = webCryptoAdapter();

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-'));
  srv = createServer({ dataDir, mailer: null });
  const port = await srv.listen(0);
  url = `http://127.0.0.1:${port}`;
  siteOwner = await call('POST', `/api/links/${srv.ownerSetupToken}`, { username: 'site_owner', password: 'secret123', name: 'Owner', email: 'owner@example.com' });
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

// Everyone joins through an invite from the site owner and lands in the one club, The Aquarium.
// Amounts are in cents. fund gives a member money to buy in with; admin can start games.
let seq = 0;
async function member(name, username = null, { fund = 0 } = {}) {
  seq++;
  const email = `${name.toLowerCase()}${seq}@example.com`;
  const inv = await call('POST', '/api/admin/invites', { email, name }, siteOwner.token);
  const token = inv.link.split('/').pop();
  const m = await call('POST', `/api/links/${token}`, { username: username || `${name.toLowerCase()}_${seq}`, password: 'secret123', name });
  if (fund) await call('POST', `/api/clubs/${m.clubId}/members/${m.user.id}/chips`, { amount: fund, note: 'Cash' }, siteOwner.token);
  return m;
}
// The hands of one game in the club's list of every hand, as one member gets them.
async function clubHandsOf(tableId, m) {
  const all = await call('GET', `/api/clubs/${siteOwner.clubId}/hands`, null, m.token);
  return { ...all, mine: all.hands.filter((h) => h.tableId === tableId) };
}
// The club's list of every hand agrees with the game's own hand list: the same hands, results and
// pot, and the same hole cards for this viewer.
function sameHands(club, game, label) {
  assert.equal(club.length, game.length, `${label}: every hand of the game`);
  for (const g of game) {
    const c = club.find((x) => x.handNumber === g.handNumber);
    assert.ok(c, `${label}: hand ${g.handNumber}`);
    for (const k of ['pot', 'runCount', 'doubleBoard', 'isBomb', 'showdown', 'allIn', 'revealed', 'gameType']) assert.deepEqual(c[k], g[k], `${label}: hand ${g.handNumber} ${k}`);
    assert.deepEqual(c.nets, g.nets, `${label}: hand ${g.handNumber} results`);
    assert.deepEqual(c.cards, g.cards, `${label}: hand ${g.handNumber} cards`);
  }
}
async function admin(name, opts) {
  const m = await member(name, null, opts);
  await call('POST', `/api/admin/users/${m.user.id}/role`, { role: 'admin' }, siteOwner.token);
  return m;
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
      this.observed[h.number] = { mySeat: me.seat, myHole: me.hole, boards: h.boards };
    }
    if (this.showOne && h.phase === 'done' && h.canShow && me && me.folded && !this.shownIn) {
      this.shownIn = h.number;
      this.socket.emit('show', { cards: [1] }, () => {});
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
    if (h.rit && h.rit.canChoose && !this.ritBusy) {
      // pick at random; seeing someone else's pick of more than once, sometimes come over to it
      const other = (h.rit.picks || []).find((x) => x.seat !== s.me.seat && typeof x.pick === 'number' && x.pick > 1);
      let runs = null;
      if (h.rit.myChoice === null) runs = this.rng() < 0.2 ? 1 : 2 + Math.floor(this.rng() * 3);
      else if (other && other.pick !== h.rit.myChoice && h.rit.myChoice !== 1 && this.ritMoved !== h.number) { this.ritMoved = h.number; runs = this.rng() < 0.7 ? other.pick : 1; }
      if (runs !== null) {
        this.ritBusy = true;
        this.socket.emit('rit', { runs }, () => { this.ritBusy = false; });
      }
    }
  }
  close() { this.socket?.close(); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b0 = (bots) => bots[0].userId;
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

test('a game: approvals, mixed games, bombs, multi-runs, ledger, stats, hand lists and verification', { timeout: 240000 }, async () => {
  const auths = [await admin('Tamer', { fund: 1000000 })];
  for (const n of ['Omar', 'Lina', 'Sam', 'Rami']) auths.push(await member(n, null, { fund: 1000000 }));
  const host = auths[0];
  await assert.rejects(call('POST', '/api/tables', { name: 'Not mine' }, auths[1].token), /Only admins/);
  const { id } = await call('POST', '/api/tables', {
    name: 'Thursday game',
    settings: {
      format: [{ game: 'plo4', unit: 'orbits', count: 1 }, { game: 'nlh', unit: 'hands', count: 4, doubleBoard: true }],
      smallBlind: 5, bigBlind: 10, minBuyIn: 500, maxBuyIn: 3000, autoApprove: false, autoStart: false,
      bombPot: { mode: 'percent', percent: 30, anteBB: 2, game: 'current', doubleBoard: true }, rit: { enabled: true, maxRuns: 4 },
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
  const doubles = recs.filter((x) => x.doubleBoard).length;
  console.log(`hands ${recs.length}, bombs ${bombs}, multi-run ${multi}, double board ${doubles}, games ${[...games]}, rebuys ${bots.reduce((x, b) => x + (b.rebuys || 0), 0)}`);
  assert.ok(bombs > 3, 'bomb pots happened');
  assert.ok(doubles > 10, 'double board hands happened');
  for (const x of recs) {
    if (x.isBomb) assert.equal(x.doubleBoard, true, 'bomb pots are double board');
    else if (x.gameType === 'nlh') assert.equal(x.doubleBoard, true, 'the NLH step is double board');
    else assert.equal(x.doubleBoard, false, 'the PLO step has one board');
    if (x.doubleBoard && !x.results.uncontested) assert.equal(x.dealt.boards.length, 2 * x.runCount);
  }
  // the NLH step lasts exactly 4 hands, bomb pots included (they are played as the current game)
  let streak = 0;
  for (const x of recs) {
    if (x.gameType === 'nlh') streak++;
    else { if (streak) assert.equal(streak, 4, 'NLH step lasts 4 hands'); streak = 0; }
  }

  const v = await verifyAll(id, bots, host.token);
  console.log('verified', v);
  assert.ok(v.verified >= recs.length * 3);
  for (const b of bots) assert.deepEqual(b.errors.filter((e) => !/not your turn/i.test(e)), [], `${b.name} action errors`);

  // every hand keeps its actions and blinds for the replayer and the stats
  for (const x of recs) {
    assert.ok(Array.isArray(x.actions) && Array.isArray(x.posts), 'actions and posts recorded');
    if (x.isBomb) assert.ok(x.posts.every((p) => p.a === 'ante') && x.posts.length === x.players.length);
    else assert.deepEqual(x.posts.map((p) => p.a), ['sb', 'bb']);
  }
  // live stats: hands played match the records, percentages stay in range, results match the ledger
  const st = (await bots[1].emit('stats:get', { scope: 'game', game: 'all' })).stats;
  assert.equal(st.hands, recs.length);
  for (const row of st.players) {
    assert.equal(row.hands, recs.filter((x) => x.players.some((p) => p.userId === row.userId)).length, `${row.name} hands`);
    for (const k of ['vpip', 'pfr', 'threeBet', 'ats', 'cbet', 'wtsd', 'wsd']) if (row[k] !== null) assert.ok(row[k] >= 0 && row[k] <= 100, `${row.name} ${k} ${row[k]}`);
    assert.ok(row.pfr === null || row.pfr <= row.vpip, 'PFR never above VPIP');
    const lrow = ledger.rows.find((x) => x.userId === row.userId);
    assert.equal(row.net, lrow.stack + lrow.buyOut - lrow.buyIn, `${row.name} net matches the ledger`);
  }
  assert.deepEqual(st.games.map((g) => g.id).sort(), [...games].sort());
  const plo = (await bots[1].emit('stats:get', { scope: 'game', game: 'plo4' })).stats;
  assert.equal(plo.hands, recs.filter((x) => x.gameType === 'plo4').length);
  // the seats carry the numbers for the game being played
  const hud = bots[1].state.hud;
  assert.ok(['plo4', 'nlh'].includes(hud.game));
  for (const b of bots) assert.ok(hud.table[b.userId]?.hands > 0, 'every seated player has numbers');
  assert.ok(hud.all[b0(bots)].hands >= hud.table[b0(bots)].hands);
  // the hand list has everyone's result so it can sort by pot and by anyone's wins and losses
  const list = (await bots[1].emit('hands:list', {})).hands;
  assert.equal(list.length, recs.length, 'every hand, not just the latest');
  const big = list.slice().sort((a, b) => b.pot - a.pot)[0];
  assert.equal(big.pot, Math.max(...recs.map((x) => x.results.pots.reduce((s2, p) => s2 + p.amount, 0))));
  for (const h of list.slice(0, 5)) assert.equal(Object.values(h.nets).reduce((a, b) => a + b, 0), 0, 'a hand moves money between players only');
  // the club's list of every hand has this game's hands, the same as its own list
  const club = await clubHandsOf(id, auths[1]);
  sameHands(club.mine, list, 'every hand of the club');
  const session = club.sessions.find((x) => x.id === id);
  assert.equal(session.name, 'Thursday game');
  assert.equal(session.hands, recs.length);
  assert.equal(session.live, true);
  for (const a of auths) assert.equal(club.names[a.user.id], a.user.name, 'everyone who played is named');
  assert.equal(club.seeAll, false, 'a member does not see the whole club');
  assert.equal(club.me, auths[1].user.id);
  assert.equal((await call('GET', `/api/clubs/${siteOwner.clubId}/hands/version`, null, auths[1].token)).version, club.version, 'nothing changed');
  // the replayer can step through every hand: money adds up at each step and it ends on the real stacks
  for (const x of recs) {
    const R = buildReplay(x);
    const total = x.players.reduce((s2, p) => s2 + p.startStack, 0);
    for (const step of R.steps) if (!step.final) assert.equal(step.players.reduce((s2, p) => s2 + p.stack, 0) + step.pot, total, `hand ${x.handNumber} at "${step.text}"`);
    for (const p of x.players) assert.equal(R.steps.at(-1).players.find((q) => q.id === p.userId).stack, p.endStack, `hand ${x.handNumber} end stacks`);
    assert.equal(R.steps.filter((st) => st.dealt === 'run').length, x.runCount > 1 ? x.runCount : 0, `hand ${x.handNumber} runs`);
  }

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
  const a = await admin('Host', { fund: 100000 });
  const b = await member('Guest', null, { fund: 100000 });
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
  // the club's list of every hand keeps them hidden too, until the game ends
  await bots[0].emit('host:pause', { value: true });
  await until(() => !bots[0].state.hand || bots[0].state.hand.phase === 'done', 10000, 'hand to end');
  await wait(100);
  let club = await clubHandsOf(id, b);
  sameHands(club.mine, (await call('GET', `/api/tables/${id}/hands`, null, b.token)).hands, 'sealed for now');
  assert.ok(club.mine.every((h) => !h.revealed));
  const before = club.version;
  await bots[0].emit('host:end', {});
  await until(() => bots[0].state?.table.status === 'ended', 60000, 'end');
  ({ record } = await call('GET', `/api/tables/${id}/hands/2`, null, b.token));
  assert.equal(record.revealed, true);
  club = await clubHandsOf(id, b);
  assert.notEqual(club.version, before, 'opening the deck changes the list');
  sameHands(club.mine, (await call('GET', `/api/tables/${id}/hands`, null, b.token)).hands, 'opened at the end');
  assert.ok(club.mine.every((h) => h.revealed && Object.keys(h.cards).length === 2), 'every hand open, both players\' cards');
  assert.equal(club.sessions.find((x) => x.id === id).live, false);
  const v = await verifyAll(id, bots, a.token);
  assert.ok(v.verified > 0);
  bots.forEach((x) => x.close());
});

test('folded cards stay hidden for good: every hand checks out, nobody sees another player\'s folded cards', { timeout: 150000 }, async () => {
  const auths = [await admin('Host', { fund: 1000000 }), await member('Bea', null, { fund: 1000000 }), await member('Cy', null, { fund: 1000000 })];
  const { id } = await call('POST', '/api/tables', {
    settings: {
      format: [{ game: 'plo4', unit: 'hands', count: 3 }, { game: 'nlh', unit: 'hands', count: 3, doubleBoard: true }],
      revealPolicy: 'hidden', autoApprove: true, decisionSeconds: 5, timeBankSeconds: 0, minPlayers: 3,
      bombPot: { mode: 'both', every: 4, percent: 30, anteBB: 1 }, rit: { enabled: true, maxRuns: 3 },
    },
  }, auths[0].token);
  const bots = auths.map((a, i) => new Bot(a.user.name, a, 40 + i));
  bots[1].showOne = true;
  for (const b of bots) await b.connect(id);
  await bots[0].emit('host:start', {});
  await bots[0].emit('seat:request', { seat: 0, buyIn: 1000 });
  await bots[1].emit('seat:request', { seat: 1, buyIn: 1000 });
  await wait(400);
  assert.equal(bots[0].state.table.handNumber, 0, 'the first hand waits for three players');
  assert.match(bots[0].state.table.waiting, /3 players/);
  await bots[2].emit('seat:request', { seat: 2, buyIn: 1000 });
  await until(() => (bots[0].state?.table.handNumber || 0) >= 24, 120000, '24 sealed hands');
  await bots[0].emit('host:pause', { value: true });
  await until(() => !bots[0].state.hand || bots[0].state.hand.phase === 'done', 10000, 'hand to end');
  await wait(300);
  const t = srv.tables.get(id);
  const recs = t.getRecords();
  assert.ok(recs.every((r) => r.fairness.version === 'aquarium-v2'));
  // every player's browser checks every hand, its own cards included, as soon as the hand ends
  const v = await verifyAll(id, bots, auths[0].token);
  assert.equal(v.verified, recs.length * 3);
  // no copy of a record holds another player's folded cards, unless they showed them
  let hiddenSeen = 0;
  for (const r of recs) {
    for (const b of bots) {
      const { record } = await call('GET', `/api/tables/${id}/hands/${r.handNumber}`, null, b.token);
      const text = JSON.stringify(record);
      assert.ok(!text.includes(r.fairness.serverSeed), 'the seed never leaves the server');
      for (const p of r.players) {
        if (p.userId === b.userId || p.shown) continue;
        const shown = p.showIdx || [];
        r.dealt.holes[p.seat].forEach((c, k) => {
          if (shown.includes(k)) return;
          hiddenSeen++;
          assert.equal(record.dealt.holes[p.seat]?.[k] ?? null, null);
          // a folded card may still appear on a board? never: the deck has one of each card
          assert.ok(!text.includes(`"c":"${c}"`), `hand ${r.handNumber}: ${b.name} cannot see ${p.name}'s ${c}`);
        });
      }
    }
  }
  assert.ok(hiddenSeen > 20, 'there were folded cards to hide');
  // the hand list shows each viewer their own cards and shown cards, never anyone's folded cards
  for (const b of bots) {
    const { hands } = await call('GET', `/api/tables/${id}/hands`, null, b.token);
    for (const h of hands) {
      const r = recs.find((x) => x.handNumber === h.handNumber);
      for (const p of r.players) {
        const all = r.dealt.holes[p.seat];
        const got = h.cards[p.userId];
        if (p.userId === b.userId || p.shown) { assert.deepEqual(got, all, `hand ${h.handNumber}: ${b.name} sees ${p.name}'s cards`); continue; }
        const shown = p.showIdx || [];
        if (!shown.length) { assert.equal(got, undefined, `hand ${h.handNumber}: ${p.name}'s folded cards stay out of ${b.name}'s list`); continue; }
        assert.deepEqual(got, all.map((c, k) => (shown.includes(k) ? c : null)));
      }
    }
  }
  // the club's list of every hand gives each viewer the same cards as the game's own list
  for (const b of bots) {
    const { hands } = await call('GET', `/api/tables/${id}/hands`, null, b.token);
    sameHands((await clubHandsOf(id, b)).mine, hands, `${b.name}, sealed for good`);
  }
  // Bea showed one card of a hand she folded: everyone sees that card and only that one
  const shownRec = recs.find((r) => r.handNumber === bots[1].shownIn);
  assert.ok(shownRec, 'Bea folded a hand and showed a card');
  const bea = shownRec.players.find((p) => p.userId === bots[1].userId);
  assert.deepEqual(bea.showIdx, [1]);
  const seen = (await call('GET', `/api/tables/${id}/hands/${shownRec.handNumber}`, null, bots[2].token)).record;
  assert.deepEqual(seen.dealt.holes[bea.seat].map((c) => c !== null), shownRec.dealt.holes[bea.seat].map((_, k) => k === 1));
  assert.equal(seen.dealt.holes[bea.seat][1], shownRec.dealt.holes[bea.seat][1]);
  // the show is written down, so it is there after a restart too
  const reread = srv.store.readHands(id).find((r) => r.handNumber === shownRec.handNumber);
  assert.deepEqual(reread.players.find((p) => p.userId === bots[1].userId).showIdx, [1]);
  // bomb pots every 4 hands at the latest, and random ones in between (checked from the opened key)
  let since = 0;
  for (const r of recs) { if (r.isBomb) since = 0; else { since++; assert.ok(since < 4, 'a bomb pot at least every 4 hands'); } }
  assert.ok(recs.some((r) => r.isBomb && r.bomb.reason === 'percent'), 'random bomb pots happened too');
  bots.forEach((b) => b.close());
});

test('the rathole rule: a player who stands up comes back with at least what they left with', { timeout: 60000 }, async () => {
  const a = await admin('Rat', { fund: 500000 });
  const b = await member('Hole', null, { fund: 500000 });
  const { id } = await call('POST', '/api/tables', { settings: { autoApprove: true, autoStart: false, ratholeMinutes: 60, maxBuyIn: 2000 } }, a.token);
  const bot = new Bot('Hole', b, 7);
  bot.passive = true;
  await bot.connect(id);
  let r = await bot.emit('seat:request', { seat: 3, buyIn: 1000 });
  assert.ok(r.ok && r.seated);
  // their stack grew to 1800 before they left
  srv.tables.get(id).players.get(b.user.id).stack = 1800;
  await bot.emit('standup', {});
  await until(() => !bot.state.me.seated, 5000, 'stood up');
  assert.equal(bot.state.me.rathole.amount, 1800);
  r = await bot.emit('seat:request', { seat: 3, buyIn: 1000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /rathole/);
  r = await bot.emit('seat:request', { seat: 5, buyIn: 1800 });
  assert.ok(r.ok && r.seated, 'back with what they left with');
  // a bigger stack than the usual maximum is allowed when the rule asks for it
  srv.tables.get(id).players.get(b.user.id).stack = 2600;
  await bot.emit('standup', {});
  await until(() => !bot.state.me.seated, 5000, 'stood up again');
  r = await bot.emit('seat:request', { seat: 5, buyIn: 2600 });
  assert.ok(r.ok && r.seated, JSON.stringify(r));
  // after the time runs out the normal buy-in applies again
  srv.tables.get(id).players.get(b.user.id).stack = 1500;
  await bot.emit('standup', {});
  await until(() => !bot.state.me.seated, 5000, 'stood up a third time');
  srv.tables.get(id).leftWith[b.user.id].at -= 61 * 60000;
  r = await bot.emit('seat:request', { seat: 5, buyIn: 500 });
  assert.ok(r.ok && r.seated);
  bot.close();
});

test('run it: matching picks settle it at once; different picks get a short time to settle, then it runs once', { timeout: 60000 }, async () => {
  const keep = { rit: DELAYS.rit, ritSettle: DELAYS.ritSettle };
  Object.assign(DELAYS, { rit: 8000, ritSettle: 500 });
  try {
    const a = await admin('Ria', { fund: 500000 });
    const b = await member('Tom', null, { fund: 500000 });
    const { id } = await call('POST', '/api/tables', { settings: { autoApprove: true, autoStart: true, smallBlind: 5, bigBlind: 10, rit: { enabled: true, maxRuns: 4 } } }, a.token);
    const ba = new Bot('Ria', a, 11);
    const bb = new Bot('Tom', b, 12);
    ba.passive = bb.passive = true;
    await ba.connect(id);
    await bb.connect(id);
    assert.ok((await ba.emit('seat:request', { seat: 0, buyIn: 1000 })).ok);
    assert.ok((await bb.emit('seat:request', { seat: 1, buyIn: 1000 })).ok);
    const t = srv.tables.get(id);
    const allIn = async () => {
      await until(() => t.hand && t.hand.phase === 'betting' && t.hand.actor(), 8000, 'a hand to start');
      const first = t.hand.actor().id === a.user.id ? ba : bb;
      const second = first === ba ? bb : ba;
      assert.ok((await first.emit('action', { type: 'allin' })).ok);
      assert.ok((await second.emit('action', { type: 'call' })).ok);
      await until(() => t.hand.phase === 'rit', 3000, 'the vote');
      await until(() => ba.state.hand?.rit?.canChoose && bb.state.hand?.rit?.canChoose, 3000, 'both can pick');
    };
    // different picks: everyone has picked, so the time left drops to the short settle window
    await allIn();
    const h1 = t.hand;
    assert.ok((await ba.emit('rit', { runs: 2 })).ok);
    assert.ok((await bb.emit('rit', { runs: 3 })).ok);
    assert.equal(h1.phase, 'rit', 'not agreed yet');
    assert.ok(t.ritDeadline - Date.now() <= 600, 'a short time to settle');
    await until(() => bb.state.hand?.rit?.picks?.every((x) => x.pick !== null), 3000, 'each sees the other pick');
    assert.deepEqual(bb.state.hand.rit.picks.map((x) => x.pick).sort(), [2, 3]);
    await until(() => h1.phase !== 'rit', 3000, 'the vote to end');
    assert.equal(h1.runCount, 1, 'no agreement: once');
    // matching picks run it that many times straight away (both stacks topped up for the next hand)
    await until(() => h1.phase === 'done', 8000, 'the first hand to end');
    for (const u of [a, b]) t.players.get(u.user.id).stack = 1000;
    t.maybeStartHand();
    await until(() => t.hand && t.hand !== h1, 15000, 'the next hand');
    await allIn();
    const h2 = t.hand;
    assert.ok((await ba.emit('rit', { runs: 3 })).ok);
    assert.ok((await bb.emit('rit', { runs: 3 })).ok);
    assert.equal(h2.rit.result, 3);
    assert.equal(h2.runCount, 3);
    ba.close();
    bb.close();
  } finally {
    Object.assign(DELAYS, keep);
  }
});

test('an all-in runout waits before its first card and between cards, and longer before each further run', { timeout: 60000 }, async () => {
  const keep = { ...DELAYS };
  const F = 150, R = 150, B = 450;
  Object.assign(DELAYS, { runoutFirst: F, runout: R, runBreak: B, showdown: 20, rit: 8000 });
  try {
    const a = await admin('Rex', { fund: 500000 });
    const b = await member('Una', null, { fund: 500000 });
    const { id } = await call('POST', '/api/tables', { settings: { autoApprove: true, autoStart: true, smallBlind: 5, bigBlind: 10, rit: { enabled: true, maxRuns: 2 } } }, a.token);
    const ba = new Bot('Rex', a, 31);
    const bb = new Bot('Una', b, 32);
    ba.passive = bb.passive = true;
    await ba.connect(id);
    await bb.connect(id);
    assert.ok((await ba.emit('seat:request', { seat: 0, buyIn: 1000 })).ok);
    assert.ok((await bb.emit('seat:request', { seat: 1, buyIn: 1000 })).ok);
    const t = srv.tables.get(id);
    await until(() => t.hand && t.hand.phase === 'betting' && t.hand.actor(), 8000, 'a hand to start');
    const h = t.hand;
    const first = h.actor().id === a.user.id ? ba : bb;
    const second = first === ba ? bb : ba;
    assert.ok((await first.emit('action', { type: 'allin' })).ok);
    assert.ok((await second.emit('action', { type: 'call' })).ok);
    await until(() => h.phase === 'rit', 3000, 'the vote');
    await until(() => ba.state.hand?.rit?.canChoose && bb.state.hand?.rit?.canChoose, 3000, 'both can pick');
    // when each street of each run lands
    const lands = [];
    let last = '';
    const poll = setInterval(() => {
      const key = h.boards.map((x) => x.length).join(',');
      if (key !== last) { lands.push({ at: Date.now(), key }); last = key; }
    }, 2);
    assert.ok((await ba.emit('rit', { runs: 2 })).ok);
    assert.ok((await bb.emit('rit', { runs: 2 })).ok);
    await until(() => h.phase === 'done', 10000, 'the hand to end');
    clearInterval(poll);
    const steps = ['0,0', '3,0', '4,0', '5,0', '5,3', '5,4', '5,5'];
    const at = steps.map((k) => lands.find((x) => x.key === k)?.at);
    assert.ok(at.every(Number.isFinite), `each street lands in turn: ${lands.map((x) => x.key).join(' ')}`);
    const gaps = at.slice(1).map((x, i) => x - at[i]);
    assert.ok(gaps[0] >= F - 5 && gaps[0] < F + B - 100, `the wait before the first card: ${gaps}`);
    for (const i of [1, 2, 4, 5]) assert.ok(gaps[i] >= R - 5 && gaps[i] < R + B - 100, `the wait between cards: ${gaps}`);
    assert.ok(gaps[3] >= R + B - 5, `the longer wait before the second run: ${gaps}`);
    ba.close();
    bb.close();
  } finally {
    Object.assign(DELAYS, keep);
  }
});

test('sitting down away, and the moment to rebuy: the next deal waits for a felted player, and goes on when they rebuy or say not now', { timeout: 90000 }, async () => {
  const keep = { ...DELAYS };
  Object.assign(DELAYS, { afterShowdown: 100, afterPreflopFold: 100, afterUncontested: 100, rebuy: 700 });
  try {
    const a = await admin('Rea', { fund: 500000 });
    const b = await member('Bo', null, { fund: 500000 });
    const c = await member('Cy', null, { fund: 500000 });
    const { id } = await call('POST', '/api/tables', { settings: { autoApprove: true, autoStart: false, smallBlind: 5, bigBlind: 10, rit: { enabled: false, maxRuns: 2 } } }, a.token);
    const bots = new Map();
    for (const [u, name, seed] of [[a, 'Rea', 41], [b, 'Bo', 42], [c, 'Cy', 43]]) {
      const bot = new Bot(name, u, seed);
      bot.passive = true;
      await bot.connect(id);
      bots.set(u.user.id, bot);
    }
    const [ba, bb, bc] = [...bots.values()];
    const t = srv.tables.get(id);
    assert.ok((await ba.emit('seat:request', { seat: 0, buyIn: 1000 })).ok);
    assert.ok((await bb.emit('seat:request', { seat: 1, buyIn: 1000 })).ok);
    // sit while away: seated, sitting out, not dealt in until "I'm back"
    assert.ok((await bc.emit('seat:request', { seat: 2, buyIn: 1000, away: true })).ok);
    assert.equal(t.players.get(c.user.id).sittingOut, true, 'sat down away');
    assert.ok((await ba.emit('host:start', {})).ok);
    await until(() => t.hand && t.hand.phase === 'betting', 5000, 'the first hand');
    assert.ok(!t.hand.byId(c.user.id), 'a player who sat down away is not dealt in');
    assert.ok((await bc.emit('sitout', { value: false })).ok);
    // every hand: Cy folds, the first of the others to act goes all in and the next calls
    const play = async (h) => {
      let shoved = false;
      for (let i = 0; i < 20 && t.hand === h && h.phase === 'betting'; i++) {
        const actor = h.actor();
        if (!actor) { await new Promise((r) => setTimeout(r, 5)); continue; }
        const type = actor.id === c.user.id ? 'fold' : shoved ? 'call' : 'allin';
        const ack = await bots.get(actor.id).emit('action', { type });
        if (ack.ok && type === 'allin') shoved = true;
        if (!ack.ok) await bots.get(actor.id).emit('action', { type: 'call' });
      }
    };
    const seen = [];
    for (let n = 0; n < 60 && seen.length < 3; n++) {
      await until(() => t.hand && t.hand.phase === 'betting', 8000, 'a hand');
      const h = t.hand;
      await play(h);
      await until(() => t.hand !== h, 8000, 'the hand to end');
      const out = [...t.players.values()].filter((p) => p.stack === 0 && !p.pendingChips);
      if (!out.length) continue;
      const f = out[0];
      const fb = bots.get(f.userId);
      assert.ok(t.rebuy && t.rebuy.ids.has(f.userId), 'a felted player gets the moment to rebuy');
      const until1 = t.rebuy.until;
      await until(() => fb.state.me.rebuyUntil === until1, 2000, 'the felted player to see it');
      if (seen.length === 0) {
        // nobody does anything: the deal waits for the moment to run out
        await until(() => t.hand, 5000, 'the next hand');
        assert.ok(Date.now() >= until1 - 20, 'the next deal waited for the felted player');
        assert.ok(!t.hand.byId(f.userId));
        await until(() => (fb.state.me.rebuyUntil ?? null) === null, 2000, 'the pop-up to go once the next hand is dealt');
        assert.ok((await fb.emit('chips:request', { amount: 1000 })).ok, 'chips still come later, after the hand');
        seen.push('waited');
      } else if (seen.length === 1) {
        // a rebuy straight away: dealt into the next hand, without waiting out the moment
        assert.ok((await fb.emit('chips:request', { amount: 1000 })).ok);
        await until(() => t.hand, 3000, 'the next hand');
        assert.ok(Date.now() < until1 - 200, 'no waiting once they rebought');
        assert.ok(t.hand.byId(f.userId), 'the rebuy is dealt in');
        seen.push('rebought');
      } else {
        // not now: the deal goes on at once
        assert.ok((await fb.emit('rebuy:skip', {})).ok);
        await until(() => t.hand, 3000, 'the next hand');
        assert.ok(Date.now() < until1 - 200, 'no waiting after not now');
        assert.ok(!t.hand.byId(f.userId));
        seen.push('skipped');
      }
    }
    assert.deepEqual(seen, ['waited', 'rebought', 'skipped']);
    for (const bot of bots.values()) bot.close();
  } finally {
    Object.assign(DELAYS, keep);
  }
});

test('away in a hand: you fold when it comes to you, even with a check free, or at once on your turn, then sit out', { timeout: 60000 }, async () => {
  const keep = { ...DELAYS };
  Object.assign(DELAYS, { afterShowdown: 300, afterPreflopFold: 300, afterUncontested: 300 });
  const bots = new Map();
  try {
    const a = await admin('Aya', { fund: 500000 });
    const b = await member('Ben', null, { fund: 500000 });
    const c = await member('Cal', null, { fund: 500000 });
    const { id } = await call('POST', '/api/tables', { settings: { autoApprove: true, autoStart: false, smallBlind: 5, bigBlind: 10 } }, a.token);
    const t = srv.tables.get(id);
    let seat = 0;
    for (const [u, name, seed] of [[a, 'Aya', 71], [b, 'Ben', 72], [c, 'Cal', 73]]) {
      const bot = new Bot(name, u, seed);
      bot.passive = true;
      await bot.connect(id);
      bots.set(u.user.id, bot);
      assert.ok((await bot.emit('seat:request', { seat: seat++, buyIn: 1000 })).ok);
    }
    assert.ok((await bots.get(a.user.id).emit('host:start', {})).ok);
    await until(() => t.hand && t.hand.phase === 'betting' && t.hand.actor(), 5000, 'the first hand');
    const h = t.hand;
    // the first two to act limp; the third (the big blind, who could check) put themselves away first
    const first = h.actor().id;
    assert.ok((await bots.get(first).emit('action', { type: 'call' })).ok);
    const second = h.actor().id;
    const away = h.players.find((p) => p.id !== first && p.id !== second).id;
    assert.ok((await bots.get(away).emit('sitout', { value: true })).ok);
    assert.ok(!h.byId(away).folded, 'not their turn yet, so still in');
    assert.ok((await bots.get(second).emit('action', { type: 'call' })).ok);
    await until(() => h.byId(away).folded, 2000, 'the away player to fold');
    assert.equal(h.byId(away).lastAction, 'Fold', 'a fold, not a check, though checking was free');
    // the other two check it down
    for (let i = 0; i < 20 && t.hand === h && h.phase !== 'done'; i++) {
      const x = h.actor();
      if (!x) { await new Promise((r) => setTimeout(r, 10)); continue; }
      const ack = await bots.get(x.id).emit('action', { type: 'check' });
      if (!ack.ok) await bots.get(x.id).emit('action', { type: 'call' });
    }
    await until(() => t.hand !== h, 8000, 'the hand to end');
    await until(() => t.hand && t.hand.phase === 'betting' && t.hand.actor(), 5000, 'the next hand');
    assert.ok(!t.hand.byId(away), 'then sitting out');
    // on your turn: the fold is at once
    const h2 = t.hand;
    const actor = h2.actor().id;
    assert.ok((await bots.get(actor).emit('sitout', { value: true })).ok);
    assert.ok(h2.byId(actor).folded, 'away on your turn folds at once');
  } finally {
    for (const bot of bots.values()) bot.close();
    Object.assign(DELAYS, keep);
  }
});

test('a finished hand leaves the felt once its result has had its time when no next hand can be dealt, showing who is away', { timeout: 60000 }, async () => {
  const keep = { ...DELAYS };
  Object.assign(DELAYS, { afterShowdown: 300, afterPreflopFold: 300, afterUncontested: 300 });
  const bots = [];
  try {
    const a = await admin('Hal', { fund: 500000 });
    const b = await member('Ivy', null, { fund: 500000 });
    const { id } = await call('POST', '/api/tables', { settings: { autoApprove: true, autoStart: false, smallBlind: 5, bigBlind: 10 } }, a.token);
    const t = srv.tables.get(id);
    for (const [u, name, seed, seat] of [[a, 'Hal', 81, 0], [b, 'Ivy', 82, 1]]) {
      const bot = new Bot(name, u, seed);
      bot.passive = true;
      await bot.connect(id);
      bots.push(bot);
      assert.ok((await bot.emit('seat:request', { seat, buyIn: 1000 })).ok);
    }
    const [ba, bb] = bots;
    assert.ok((await ba.emit('host:start', {})).ok);
    await until(() => t.hand && t.hand.phase === 'betting' && t.hand.actor(), 5000, 'a hand');
    const h = t.hand;
    const actor = h.actor().id === a.user.id ? ba : bb;
    assert.ok((await actor.emit('action', { type: 'fold' })).ok);
    await until(() => t.hand === null, 3000, 'the hand to end');
    await until(() => ba.state.hand && ba.state.hand.phase === 'done', 2000, 'the result on the felt');
    // heads-up, one of them goes away after the hand: there can be no next hand
    assert.ok((await bb.emit('sitout', { value: true })).ok);
    await until(() => ba.state.hand === null, 3000, 'the felt to clear once the result had its time');
    const ivy = ba.state.seats.find((x) => x && x.userId === b.user.id);
    assert.ok(ivy.sittingOut, 'and the away player shows as away');
    assert.ok(ba.state.table.waiting, 'the table says why it is not dealing');
  } finally {
    for (const bot of bots) bot.close();
    Object.assign(DELAYS, keep);
  }
});

test('a bomb pot holds its first clock while it goes off: no turn and no actions until then', { timeout: 60000 }, async () => {
  const keep = { ...DELAYS };
  Object.assign(DELAYS, { bombIntro: 400 });
  const bots = [];
  try {
    const a = await admin('Kai', { fund: 500000 });
    const b = await member('Lou', null, { fund: 500000 });
    const { id } = await call('POST', '/api/tables', { settings: { autoApprove: true, autoStart: false, smallBlind: 5, bigBlind: 10 } }, a.token);
    const t = srv.tables.get(id);
    for (const [u, name, seed, seat] of [[a, 'Kai', 91, 0], [b, 'Lou', 92, 1]]) {
      const bot = new Bot(name, u, seed);
      bot.passive = true;
      await bot.connect(id);
      bots.push(bot);
      assert.ok((await bot.emit('seat:request', { seat, buyIn: 1000 })).ok);
    }
    const [ba, bb] = bots;
    assert.ok((await ba.emit('host:bomb', { value: true })).ok);
    assert.ok((await ba.emit('host:start', {})).ok);
    await until(() => t.hand && t.hand.isBomb, 3000, 'a bomb pot');
    const started = Date.now();
    assert.ok(t.timers.intro, 'held while it goes off');
    assert.equal(t.turn, null, 'nobody on the clock yet');
    const actor = t.hand.actor().id === a.user.id ? ba : bb;
    await until(() => actor.state.hand?.intro, 2000, 'the players to see it');
    assert.equal(actor.state.hand.legal ?? null, null, 'no action buttons yet');
    const early = await actor.emit('action', { type: 'check' });
    assert.ok(!early.ok && /going off/.test(early.error), 'no acting yet');
    await until(() => t.turn, 3000, 'the first clock');
    assert.ok(Date.now() - started >= 300, 'the clock started once it had gone off');
    await until(() => actor.state.hand?.legal, 2000, 'the action buttons');
    assert.ok((await actor.emit('action', { type: 'check' })).ok);
  } finally {
    for (const bot of bots) bot.close();
    Object.assign(DELAYS, keep);
  }
});

test('a hand folded before the flop moves on sooner than one that saw a flop, unless its winner holds 7-2 to show', { timeout: 60000 }, async () => {
  const keep = { ...DELAYS };
  Object.assign(DELAYS, { afterPreflopFold: 80, afterUncontested: 700, afterShowdown: 700 });
  const bots = [];
  try {
    const a = await admin('Pia', { fund: 500000 });
    const b = await member('Quin', null, { fund: 500000 });
    const { id } = await call('POST', '/api/tables', { settings: { autoApprove: true, autoStart: false, smallBlind: 5, bigBlind: 10, sevenDeuce: 50 } }, a.token);
    const t = srv.tables.get(id);
    for (const [u, name, seed, seat] of [[a, 'Pia', 95, 0], [b, 'Quin', 96, 1]]) {
      const bot = new Bot(name, u, seed);
      bot.passive = true;
      await bot.connect(id);
      bots.push(bot);
      assert.ok((await bot.emit('seat:request', { seat, buyIn: 1000 })).ok);
    }
    const byId = new Map([[a.user.id, bots[0]], [b.user.id, bots[1]]]);
    assert.ok((await bots[0].emit('host:start', {})).ok);
    const pause = async (play) => {
      await until(() => t.hand && t.hand.phase === 'betting' && t.hand.actor(), 5000, 'a hand');
      const h = t.hand;
      await play(h);
      await until(() => t.hand !== h, 5000, 'the hand to end');
      const ended = Date.now();
      await until(() => t.hand && t.hand !== h, 5000, 'the next hand');
      return Date.now() - ended;
    };
    // folded straight away
    const quick = await pause(async (h) => { assert.ok((await byId.get(h.actor().id).emit('action', { type: 'fold' })).ok); });
    // called to the flop, then folded there
    const slow = await pause(async (h) => {
      assert.ok((await byId.get(h.actor().id).emit('action', { type: 'call' })).ok);
      assert.ok((await byId.get(h.actor().id).emit('action', { type: 'check' })).ok);
      await until(() => h.board.length === 3 && h.actor(), 3000, 'the flop');
      assert.ok((await byId.get(h.actor().id).emit('action', { type: 'fold' })).ok);
    });
    assert.ok(quick < 400, `a fold before the flop moves on quickly (${quick} ms)`);
    assert.ok(slow >= 650, `a hand that saw a flop keeps the full pause (${slow} ms)`);
    // the 7-2 winner of a hand folded round before the flop keeps the full time to show
    const fake = (hole, shown = false) => ({ game: { holeCount: 2 }, results: { payouts: [{ id: 'w', amount: 15 }] }, byId: () => ({ hole, shown }) });
    assert.equal(t.sevenDeuceToShow(fake(['7h', '2c'])), true);
    assert.equal(t.sevenDeuceToShow(fake(['7h', '2c'], true)), false, 'once shown, no need to wait');
    assert.equal(t.sevenDeuceToShow(fake(['7h', '3c'])), false);
  } finally {
    for (const bot of bots) bot.close();
    Object.assign(DELAYS, keep);
  }
});

test('adding chips puts a note in the chat for everyone: now, after this hand, or a rebuy', { timeout: 60000 }, async () => {
  const bots = [];
  try {
    const a = await admin('Rio', { fund: 500000 });
    const b = await member('Sol', null, { fund: 500000 });
    const { id } = await call('POST', '/api/tables', { settings: { autoApprove: true, autoStart: false, smallBlind: 5, bigBlind: 10 } }, a.token);
    const t = srv.tables.get(id);
    for (const [u, name, seed, seat] of [[a, 'Rio', 97, 0], [b, 'Sol', 98, 1]]) {
      const bot = new Bot(name, u, seed);
      bot.passive = true;
      await bot.connect(id);
      bots.push(bot);
      assert.ok((await bot.emit('seat:request', { seat, buyIn: 1000 })).ok);
    }
    const notes = () => t.logEntries.filter((e) => e.kind === 'chat' && e.note).map((e) => e.text);
    assert.ok((await bots[0].emit('chips:request', { amount: 250 })).ok);
    assert.equal(notes().at(-1), `Rio is adding ${t.fmt(250)} to their stack`);
    assert.ok((await bots[0].emit('host:start', {})).ok);
    await until(() => t.hand && t.hand.phase === 'betting', 5000, 'a hand');
    assert.ok((await bots[1].emit('chips:request', { amount: 300 })).ok);
    assert.equal(notes().at(-1), `Sol is adding ${t.fmt(300)} to their stack after this hand`);
    // the note is not anyone's message: no bubble by a seat, no name to answer
    const last = t.logEntries.filter((e) => e.note).at(-1);
    assert.equal(last.userId, undefined);
    assert.equal(last.by, b.user.id);
    // a rebuy on no chips: pause, fold the hand out, and the player who is out of chips rebuys
    assert.ok((await bots[0].emit('host:pause', { value: true })).ok);
    const h = t.hand;
    const actor = h.actor().id === a.user.id ? bots[0] : bots[1];
    assert.ok((await actor.emit('action', { type: 'fold' })).ok);
    await until(() => t.hand === null, 3000, 'the hand to end');
    t.players.get(a.user.id).stack = 0;
    assert.ok((await bots[0].emit('chips:request', { amount: 1000 })).ok);
    assert.equal(notes().at(-1), `Rio rebuys for ${t.fmt(1000)}`);
  } finally {
    for (const bot of bots) bot.close();
  }
});

test('adding chips in a hand counts from the chips behind, and what is added after the hand stops at the maximum stack', { timeout: 60000 }, async () => {
  const bots = [];
  try {
    const a = await admin('Ria', { fund: 500000 });
    const b = await member('Sul', null, { fund: 500000 });
    const { id } = await call('POST', '/api/tables', { settings: { autoApprove: true, autoStart: false, smallBlind: 5, bigBlind: 10, maxBuyIn: 2000 } }, a.token);
    const t = srv.tables.get(id);
    const byId = new Map();
    for (const [u, name, seed, seat] of [[a, 'Ria', 91, 0], [b, 'Sul', 92, 1]]) {
      const bot = new Bot(name, u, seed);
      bot.passive = true;
      await bot.connect(id);
      bots.push(bot);
      byId.set(u.user.id, bot);
      assert.ok((await bot.emit('seat:request', { seat, buyIn: 1500 })).ok);
    }
    assert.ok((await bots[0].emit('host:start', {})).ok);
    await until(() => t.hand && t.hand.phase === 'betting', 5000, 'a hand');
    const h = t.hand;
    // the first to act puts 500 in: 1,000 behind, so 1,000 more fits under the 2,000 maximum
    const raiser = h.actor();
    const rb = byId.get(raiser.id);
    const other = byId.get(h.players.find((p) => p.id !== raiser.id).id);
    assert.ok((await rb.emit('action', { type: 'raise', to: 500 })).ok);
    const avail0 = srv.clubs.available(t.clubId, raiser.id);
    let r = await rb.emit('chips:request', { amount: 1000 });
    assert.ok(r.ok, r.error);
    assert.equal(t.players.get(raiser.id).pendingChips, 1000);
    r = await rb.emit('chips:request', { amount: 1 });
    assert.equal(r.ok, false);
    assert.match(r.error, /add up to/);
    // the other player folds: the raiser takes the pot back to 1,510, and only 490 of the 1,000 is added
    assert.ok((await bots[0].emit('host:pause', { value: true })).ok);
    assert.ok((await other.emit('action', { type: 'fold' })).ok);
    await until(() => t.hand === null, 3000, 'the hand to end');
    const p = t.players.get(raiser.id);
    assert.equal(p.stack, 2000);
    assert.equal(p.pendingChips, 0);
    assert.equal(srv.clubs.available(t.clubId, raiser.id), avail0 - 490, 'only what went on the stack came out of the balance');
    assert.ok(t.logEntries.some((e) => e.text === `${p.name} adds ${t.fmt(490)} of the ${t.fmt(1000)} asked for: the maximum stack is ${t.fmt(2000)}`));
    // at the maximum, nothing more fits
    r = await rb.emit('chips:request', { amount: 100 });
    assert.equal(r.ok, false);
  } finally {
    for (const bot of bots) bot.close();
  }
});

// Plays the hand in progress with everyone in it all in: the first to act shoves and the rest call.
async function allInHand(t, bots, h) {
  for (let i = 0; i < 30 && t.hand === h && h.phase === 'betting'; i++) {
    const actor = h.actor();
    if (!actor) { await new Promise((r) => setTimeout(r, 5)); continue; }
    const bot = bots.get(actor.id);
    let ack = await bot.emit('action', { type: 'allin' });
    if (!ack.ok) ack = await bot.emit('action', { type: 'call' });
    if (!ack.ok) await bot.emit('action', { type: 'check' });
  }
}

test('a tourney paid by place: one buy-in whatever is sent, no adding chips, blinds up on the clock, players out in order, the pool paid by the split', { timeout: 120000 }, async () => {
  const keep = { ...DELAYS };
  const minute = TOURNEY_TIME.minute;
  Object.assign(DELAYS, { afterShowdown: 30, afterPreflopFold: 30, afterUncontested: 30, rebuy: 30 });
  TOURNEY_TIME.minute = 150; // a level lasts 150 ms
  const bots = new Map();
  try {
    const a = await admin('Tia', { fund: 500000 });
    const b = await member('Tob', null, { fund: 500000 });
    const c = await member('Tec', null, { fund: 500000 });
    const tourney = { on: true, buyIn: 1000, buyIns: 1, lastRebuyLevel: 0, levelMinutes: 1, levels: [[5, 10], [10, 20], [20, 40]], pay: 'place', split: [70, 30] };
    const { id } = await call('POST', '/api/tables', { settings: { autoApprove: true, autoStart: false, rit: { enabled: false, maxRuns: 2 }, tourney } }, a.token);
    const t = srv.tables.get(id);
    assert.equal(t.settings.minBuyIn, 1000);
    assert.equal(t.settings.maxBuyIn, 1000);
    assert.deepEqual([t.settings.smallBlind, t.settings.bigBlind], [5, 10], 'the game starts at the first level');
    const club = srv.clubs.data[a.clubId];
    const before = new Map([a, b, c].map((u) => [u.user.id, club.members[u.user.id].balance]));
    let seat = 0;
    for (const [u, name, seed] of [[a, 'Tia', 51], [b, 'Tob', 52], [c, 'Tec', 53]]) {
      const bot = new Bot(name, u, seed);
      bot.passive = true;
      await bot.connect(id);
      bots.set(u.user.id, bot);
      // whatever amount is sent, a tourney seat is the one buy-in
      assert.ok((await bot.emit('seat:request', { seat: seat++, buyIn: 50 })).ok);
    }
    for (const p of t.players.values()) assert.equal(p.stack, 1000);
    assert.equal(t.tourney.pool, 3000);
    const add = await bots.get(a.user.id).emit('chips:request', { amount: 500 });
    assert.ok(!add.ok && /out of chips/.test(add.error), 'no adding chips in a tourney');
    assert.ok((await bots.get(a.user.id).emit('host:start', {})).ok);
    let sawLevel = 0;
    for (let n = 0; n < 80 && t.status !== 'ended'; n++) {
      await until(() => t.status === 'ended' || (t.hand && t.hand.phase === 'betting'), 8000, 'a hand or the end');
      if (t.status === 'ended') break;
      sawLevel = Math.max(sawLevel, t.tourney.level);
      assert.deepEqual([t.settings.smallBlind, t.settings.bigBlind], t.settings.tourney.levels[t.tourney.level], 'each hand is dealt at its level');
      const h = t.hand;
      if (n < 4) {
        // the first hands are folded round while the clock moves the blinds up
        await new Promise((r) => setTimeout(r, 90));
        for (let i = 0; i < 10 && t.hand === h && h.phase === 'betting'; i++) {
          const actor = h.actor();
          if (!actor) { await new Promise((r) => setTimeout(r, 5)); continue; }
          const ack = await bots.get(actor.id).emit('action', { type: 'fold' });
          if (!ack.ok) await bots.get(actor.id).emit('action', { type: 'check' });
        }
      } else {
        await allInHand(t, bots, h);
      }
      await until(() => t.hand !== h || t.status === 'ended', 8000, 'the hand to end');
    }
    assert.equal(t.status, 'ended', 'the tourney ends when one player has every chip');
    assert.ok(sawLevel >= 1, 'the blinds went up on the clock');
    const places = t.tourney.places;
    assert.deepEqual(places.map((x) => x.place), [1, 2, 3]);
    assert.deepEqual(places.map((x) => x.payout), [2100, 900, null], '70/30 of 3000');
    // each player's money: the buy-in out, the payout in
    for (const x of places) {
      const change = club.members[x.userId].balance - before.get(x.userId);
      assert.equal(change, (x.payout || 0) - 1000, `${x.name} paid by place`);
    }
  } finally {
    for (const bot of bots.values()) bot.close();
    Object.assign(DELAYS, keep);
    TOURNEY_TIME.minute = minute;
  }
});

test('a tourney with rebuys where chips are cash: a rebuy on no chips counts against the buy-ins, then out; buying in closes after its level; the last player cashes out every chip', { timeout: 120000 }, async () => {
  const keep = { ...DELAYS };
  Object.assign(DELAYS, { afterShowdown: 30, afterPreflopFold: 30, afterUncontested: 30, rebuy: 400 });
  const bots = new Map();
  try {
    const a = await admin('Ria', { fund: 500000 });
    const b = await member('Rob', null, { fund: 500000 });
    const late = await member('Rue', null, { fund: 500000 });
    const tourney = { on: true, buyIn: 1000, buyIns: 2, lastRebuyLevel: 2, levelMinutes: 30, levels: [[5, 10], [10, 20], [20, 40], [40, 80]], pay: 'chips' };
    const { id } = await call('POST', '/api/tables', { settings: { autoApprove: true, autoStart: false, rit: { enabled: false, maxRuns: 2 }, tourney } }, a.token);
    const t = srv.tables.get(id);
    const club = srv.clubs.data[a.clubId];
    const before = new Map([a, b].map((u) => [u.user.id, club.members[u.user.id].balance]));
    for (const [u, name, seed, seat] of [[a, 'Ria', 61, 0], [b, 'Rob', 62, 1]]) {
      const bot = new Bot(name, u, seed);
      bot.passive = true;
      await bot.connect(id);
      bots.set(u.user.id, bot);
      assert.ok((await bot.emit('seat:request', { seat, buyIn: 1000 })).ok);
    }
    assert.ok((await bots.get(a.user.id).emit('host:start', {})).ok);
    let rebought = null;
    for (let n = 0; n < 80 && t.status !== 'ended'; n++) {
      try {
        await until(() => t.status === 'ended' || (t.hand && t.hand.phase === 'betting'), 8000, 'a hand or the end');
      } catch (e) {
        console.log('STUCK', JSON.stringify({ status: t.status, phase: t.hand?.phase, waiting: t.waitingReason(), next: !!t.timers.next, rebuy: t.rebuy && [...t.rebuy.ids], players: [...t.players.values()].map((p) => [p.name, p.stack, p.pendingChips, p.sittingOut]), out: t.tourney.out, req: t.requests.length }));
        throw e;
      }
      if (t.status === 'ended') break;
      const h = t.hand;
      await allInHand(t, bots, h);
      await until(() => t.hand !== h || t.status === 'ended', 8000, 'the hand to end');
      const broke = [...t.players.values()].find((p) => p.stack === 0);
      if (broke && !rebought) {
        // the first time out of chips: a second buy-in is left, so they can rebuy
        assert.equal(t.tourneyBuyInsLeft(broke.userId), 1);
        const ack = await bots.get(broke.userId).emit('chips:request', { amount: 1 });
        assert.ok(ack.ok, 'a rebuy on no chips');
        assert.equal(t.players.get(broke.userId).stack, 1000, 'for the one buy-in');
        assert.equal(t.tourney.pool, 3000);
        rebought = broke.userId;
      } else if (broke && broke.userId !== rebought && t.canTourneyBuyIn(broke.userId)) {
        // the other player out of chips, with a buy-in left: the tourney waits for them to rebuy or
        // leave; leaving puts them out, which ends it
        assert.ok((await bots.get(broke.userId).emit('standup', {})).ok);
      }
    }
    assert.equal(t.status, 'ended');
    assert.ok(rebought, 'someone rebought');
    const winner = t.tourney.places[0];
    // chips are cash: the winner cashed out all 3000; the money moved is the money bought in
    const net = (u) => club.members[u].balance - before.get(u);
    assert.equal(net(winner.userId) + net(t.tourney.places[1].userId), 0, 'no money made or lost');
    assert.equal(net(winner.userId), winner.userId === rebought ? 1000 : 2000);

    // buying in closes after its level: a new tourney table with the clock past level 2
    const { id: id2 } = await call('POST', '/api/tables', { settings: { autoApprove: true, autoStart: false, tourney } }, a.token);
    const t2 = srv.tables.get(id2);
    t2.tourney.started = true;
    t2.tourney.level = 2;
    t2.tourney.levelEndsAt = Date.now() + 60000;
    const lb = new Bot('Rue', late, 63);
    lb.passive = true;
    await lb.connect(id2);
    const ack = await lb.emit('seat:request', { seat: 3, buyIn: 1000 });
    assert.ok(!ack.ok && /closed/.test(ack.error), 'buying in is closed after the last level to buy in');
    lb.close();
  } finally {
    for (const bot of bots.values()) bot.close();
    Object.assign(DELAYS, keep);
  }
});

test('game presets: admins save, update and delete them; members cannot', async () => {
  const a = await admin('Preset');
  const m = await member('Plain');
  const settings = { format: [{ game: 'plo4', unit: 'orbits', count: 2 }], smallBlind: 25, bigBlind: 50, minPlayers: 4, ratholeMinutes: 120, revealPolicy: 'hidden', bombPot: { mode: 'both', every: 8, percent: 5, anteBB: 2 } };
  const r = await call('POST', '/api/presets', { name: 'Thursday PLO', tableName: 'Thursday game', settings }, a.token);
  assert.equal(r.preset.settings.minPlayers, 4);
  assert.equal(r.preset.settings.bombPot.mode, 'both');
  await assert.rejects(call('POST', '/api/presets', { name: 'thursday plo', settings }, a.token), /exists already/);
  await assert.rejects(call('POST', '/api/presets', { name: 'Broken', settings: { format: [{ game: 'plo5', unit: 'orbits', count: 1, doubleBoard: true }], maxPlayers: 10 } }, a.token), /at most 8 seats/);
  await assert.rejects(call('GET', '/api/presets', null, m.token), /Only admins/);
  const up = await call('PUT', `/api/presets/${r.preset.id}`, { name: 'Thursday PLO', tableName: 'Thursday game', settings: { ...settings, bigBlind: 100 } }, a.token);
  assert.equal(up.preset.settings.bigBlind, 100);
  assert.equal((await call('GET', '/api/presets', null, siteOwner.token)).presets.length, 1, 'every admin sees the club presets');
  const t = await call('POST', '/api/tables', { name: up.preset.tableName, settings: up.preset.settings }, a.token);
  assert.equal(srv.tables.get(t.id).settings.minPlayers, 4);
  assert.deepEqual((await call('DELETE', `/api/presets/${r.preset.id}`, null, a.token)).presets, []);
});

test('the club: one club, chips, credit limits, buy-ins draw from balance, cash-outs return', { timeout: 150000 }, async () => {
  const owner = siteOwner;
  const m1 = await member('Omar', 'omar');
  const m2 = await member('Lina', 'lina');
  await assert.rejects(call('POST', '/api/auth/guest', { name: 'Nope' }), /invite only/);
  await assert.rejects(call('POST', '/api/clubs', { name: 'Dubai Thursday Club' }, owner.token), /only club/);
  const clubId = m1.clubId;
  let view = await call('GET', `/api/clubs/${clubId}`, null, owner.token);
  assert.equal(view.club.name, 'The Aquarium');
  assert.equal(view.club.settings.decimals, 2, 'dollars and cents');
  assert.equal(view.club.myRole, 'owner');
  assert.ok([m1, m2].every((m) => view.club.members.some((x) => x.userId === m.user.id)), 'invited people are members straight away');
  await assert.rejects(call('POST', '/api/clubs/join', { code: view.club.inviteCode }, m1.token), /already in The Aquarium/);
  await assert.rejects(call('POST', `/api/clubs/${clubId}/members/${m2.user.id}/chips`, { amount: 100 }, m1.token), /owner or a manager/);
  await assert.rejects(call('POST', `/api/clubs/${clubId}/members/${m2.user.id}/role`, { role: 'manager' }, owner.token), /People page/);
  await call('POST', `/api/clubs/${clubId}/members/${m1.user.id}/chips`, { amount: 50000, note: 'Cash received' }, owner.token);
  await call('POST', `/api/clubs/${clubId}/members/${m2.user.id}/credit`, { limit: 30000 }, owner.token);
  await call('POST', `/api/clubs/${clubId}/members/${owner.user.id}/chips`, { amount: 100000 }, owner.token);
  const mine = (v) => [owner, m1, m2].map((m) => v.club.members.find((x) => x.userId === m.user.id));
  const startTotal = mine(await call('GET', `/api/clubs/${clubId}`, null, owner.token)).reduce((s2, x) => s2 + x.balance, 0);
  view = await call('GET', `/api/clubs/${clubId}`, null, m1.token);
  assert.equal(view.club.me.balance, 50000);
  assert.equal(view.club.members.find((x) => x.userId === m2.user.id).balance, undefined, 'members cannot see others by default');

  const { id: tableId } = await call('POST', '/api/tables', { name: 'Club PLO', settings: { games: ['plo5'], smallBlind: 25, bigBlind: 50, decisionSeconds: 5, timeBankSeconds: 0, bombPot: { mode: 'every', every: 3, anteBB: 1 } } }, owner.token);
  // the start-a-game form sends a format; PLO5 on two boards only fits eight players
  await assert.rejects(call('POST', '/api/tables', { settings: { format: [{ game: 'plo5', unit: 'orbits', count: 1, doubleBoard: true }], maxPlayers: 9 } }, owner.token), /at most 8 seats/);
  await assert.rejects(call('POST', '/api/tables', { settings: { format: [] } }, owner.token), /at least one game/);
  await assert.rejects(call('POST', '/api/tables', { settings: { format: [{ game: 'nlh', unit: 'hands', count: 0 }] } }, owner.token), /1 to 500 hands/);
  await assert.rejects(call('POST', '/api/tables', { settings: { format: [{ game: 'nlh', unit: 'orbits', count: 51 }] } }, owner.token), /1 to 50 orbits/);
  await assert.rejects(call('POST', '/api/tables', { settings: { format: [{ game: 'nlh', unit: 'orbits', count: 1 }] } }, m1.token), /Only admins/);
  const { id: laterId } = await call('POST', '/api/tables', {
    name: 'Saturday', settings: { format: [{ game: 'plo4', unit: 'orbits', count: 2 }, { game: 'nlh', unit: 'hands', count: 10, doubleBoard: true }, { game: 'plo5', length: 'orbit' }], autoStart: false, maxPlayers: 7, bombPot: { mode: 'every', every: 8, anteBB: 2, game: 'plo4', doubleBoard: true } },
  }, owner.token);
  view = await call('GET', `/api/clubs/${clubId}`, null, owner.token);
  const later = view.tables.find((x) => x.id === laterId);
  assert.equal(later.status, 'waiting', 'a table can wait for the host to start it');
  assert.deepEqual(later.format.map((x) => [x.game, x.unit, x.count, x.doubleBoard]), [['plo4', 'orbits', 2, false], ['nlh', 'hands', 10, true], ['plo5', 'orbits', 1, false]], 'older step shapes still read');
  assert.equal(srv.tables.get(laterId).settings.bombPot.doubleBoard, true);
  const bots = [new Bot('Owner', owner, 11), new Bot('Omar', m1, 12), new Bot('Lina', m2, 13)];
  for (const b of bots) await b.connect(tableId);
  let r = await bots[2].emit('seat:request', { seat: 1, buyIn: 40000 });
  assert.equal(r.ok, false, 'over credit limit rejected');
  r = await bots[2].emit('seat:request', { seat: 1, buyIn: 30000 });
  assert.ok(r.ok && r.seated, 'credit buy-in auto-approved');
  r = await bots[1].emit('seat:request', { seat: 3, buyIn: 20000 });
  assert.ok(r.ok && r.seated);
  r = await bots[0].emit('seat:request', { seat: 5, buyIn: 20000 });
  assert.ok(r.ok && r.seated);
  assert.equal(bots[0].state.table.decimals, 2);
  view = await call('GET', `/api/clubs/${clubId}`, null, owner.token);
  assert.equal(view.club.members.find((x) => x.userId === m2.user.id).balance, -30000);
  await until(() => (bots[0].state?.table.handNumber || 0) >= 12, 90000, 'club hands');
  const t = srv.tables.get(tableId);
  assert.ok(t.getRecords().some((x) => x.isBomb), 'every-N bomb pots');
  assert.match(t.loadLog().map((e) => e.text).join('\n'), /posts a small blind of 0\.25/, 'the log shows dollars and cents, without the dollar sign');
  // bots keep playing so the hand in progress can finish; the game ends right after it
  await bots[0].emit('host:end', {});
  await until(() => bots[0].state?.table.status === 'ended', 60000, 'club table end');
  for (const b of bots) b.passive = true;
  view = await call('GET', `/api/clubs/${clubId}`, null, owner.token);
  assert.equal(mine(view).reduce((s2, x) => s2 + x.balance, 0), startTotal, 'all chips back in balances');
  assert.equal(mine(view).reduce((s2, x) => s2 + x.net, 0), 0, 'nets sum to zero');
  // all-time stats on the club page: results of others only for those who see the whole ledger
  const cs = (await call('GET', `/api/clubs/${clubId}/stats`, null, owner.token)).stats;
  assert.ok(cs.players.find((x) => x.userId === m1.user.id).hands >= 12);
  assert.ok(cs.players.every((x) => x.net !== null));
  const ms = (await call('GET', `/api/clubs/${clubId}/stats?game=plo5`, null, m1.token)).stats;
  assert.equal(ms.game, 'plo5');
  assert.equal(ms.players.find((x) => x.userId === m2.user.id).net, null, 'members see others\' play, not their results');
  assert.notEqual(ms.players.find((x) => x.userId === m1.user.id).net, null, 'but always their own');
  const atTable = (await bots[1].emit('stats:get', { scope: 'all', game: 'all' })).stats;
  assert.equal(atTable.players.find((x) => x.userId === m2.user.id).net, null, 'the same at the table for all games in the club');
  assert.notEqual((await bots[1].emit('stats:get', { scope: 'game', game: 'all' })).stats.players.find((x) => x.userId === m2.user.id).net, null, 'this game\'s results are open at the table, as in its ledger');
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
  assert.match(csv, /amount_usd/);
  bots.forEach((b) => b.close());
});

test('a table that deals on its own starts its time limit with the first hand', { timeout: 60000 }, async () => {
  const a = await admin('Early', { fund: 100000 });
  const b = await member('Late', null, { fund: 100000 });
  const { id } = await call('POST', '/api/tables', { settings: { autoStart: true, autoApprove: true, sessionMinutes: 120, decisionSeconds: 5, timeBankSeconds: 0 } }, a.token);
  let t = await call('GET', `/api/tables/${id}`, null, a.token);
  assert.equal(t.status, 'running');
  assert.equal(t.endsAt, null, 'no clock while nobody is playing');
  const bots = [new Bot('Early', a, 3), new Bot('Late', b, 4)];
  for (const x of bots) await x.connect(id);
  await bots[0].emit('seat:request', { seat: 0, buyIn: 1000 });
  await wait(300);
  assert.equal((await call('GET', `/api/tables/${id}`, null, a.token)).endsAt, null, 'one player does not start the clock');
  const before = Date.now();
  await bots[1].emit('seat:request', { seat: 1, buyIn: 1000 });
  await until(() => (bots[0].state?.table.handNumber || 0) >= 1, 10000, 'first hand');
  t = await call('GET', `/api/tables/${id}`, null, a.token);
  assert.ok(t.endsAt >= before + 120 * 60000 && t.endsAt <= Date.now() + 120 * 60000, 'clock runs from the first hand');
  bots.forEach((x) => x.close());
});

test('the games board: each game lists its buy-in, seats, average stack and extras, and says when it is waiting for players', { timeout: 60000 }, async () => {
  const a = await admin('Boarder', { fund: 100000 });
  const b = await member('Joiner', null, { fund: 100000 });
  const { id } = await call('POST', '/api/tables', {
    name: 'Board test',
    settings: { autoStart: true, autoApprove: true, decisionSeconds: 30, timeBankSeconds: 0, minBuyIn: 500, maxBuyIn: 3000, straddle: true, sevenDeuce: 100, rit: { enabled: true, maxRuns: 3 }, bombPot: { mode: 'percent', percent: 15, anteBB: 2, game: 'current', doubleBoard: false } },
  }, a.token);
  const listed = async () => {
    const { clubs } = await call('GET', '/api/me', null, a.token);
    return (await call('GET', `/api/clubs/${clubs[0].id}`, null, a.token)).tables.find((x) => x.id === id);
  };
  let t = await listed();
  assert.equal(t.minBuyIn, 500);
  assert.equal(t.maxBuyIn, 3000);
  assert.equal(t.straddle, true);
  assert.equal(t.sevenDeuce, 100);
  assert.equal(t.runs, 3);
  assert.deepEqual(t.bomb, { mode: 'percent', every: 10, percent: 15 });
  assert.equal(t.avgStack, null, 'nobody sitting: no average');
  assert.deepEqual(t.taken, []);
  assert.equal(t.waiting, 'Waiting for players', 'running but nobody to deal to');
  const bots = [new Bot('Boarder', a, 21), new Bot('Joiner', b, 22)];
  for (const x of bots) await x.connect(id);
  for (const x of bots) x.passive = true; // the first hand stays open, so the stacks hold still
  await bots[0].emit('seat:request', { seat: 2, buyIn: 1000 });
  t = await listed();
  assert.deepEqual(t.taken, [2]);
  assert.equal(t.waiting, 'Waiting for players', 'one player is not a game');
  await bots[1].emit('seat:request', { seat: 5, buyIn: 2000 });
  await until(() => bots[0].state?.hand && bots[0].state.hand.phase !== 'done', 10000, 'a hand in progress');
  t = await listed();
  assert.deepEqual(t.taken.slice().sort((x, y) => x - y), [2, 5]);
  assert.equal(t.waiting, null, 'cards are being dealt: live');
  const stacks = bots[0].state.seats.filter(Boolean).map((x) => x.stack);
  assert.equal(t.avgStack, Math.round(stacks.reduce((x, y) => x + y, 0) / stacks.length));
  // the hand history in a tab of its own
  const page = await fetch(`${url}/hands/${id}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /hands-page\.js/);
  bots.forEach((x) => x.close());
});

test('an admin ends a game from the home page; the hand in progress finishes first, and members cannot', { timeout: 60000 }, async () => {
  const a = await admin('Closer', { fund: 100000 });
  const b = await member('Stayer', null, { fund: 100000 });
  const { id } = await call('POST', '/api/tables', { settings: { autoStart: true, autoApprove: true, decisionSeconds: 30, timeBankSeconds: 0 } }, a.token);
  await assert.rejects(call('POST', `/api/tables/${id}/end`, {}, b.token), /Only the host/);
  const bots = [new Bot('Closer', a, 5), new Bot('Stayer', b, 6)];
  for (const x of bots) await x.connect(id);
  for (const x of bots) x.passive = true; // nobody acts, so the first hand stays open
  await bots[0].emit('seat:request', { seat: 0, buyIn: 1000 });
  await bots[1].emit('seat:request', { seat: 1, buyIn: 1000 });
  await until(() => bots[0].state?.hand && bots[0].state.hand.phase !== 'done', 10000, 'a hand in progress');
  const r = await call('POST', `/api/tables/${id}/end`, {}, a.token);
  assert.equal(r.status, 'running');
  assert.equal(r.ending, true);
  const { clubs } = await call('GET', '/api/me', null, a.token);
  const club = await call('GET', `/api/clubs/${clubs[0].id}`, null, a.token);
  assert.equal(club.tables.find((x) => x.id === id).ending, true, 'the home page shows it ending');
  for (const x of bots) { x.passive = false; x.onState(x.state); }
  await until(async () => (await call('GET', `/api/tables/${id}`, null, a.token)).status === 'ended', 30000, 'the game to end');
  bots.forEach((x) => x.close());
});

test('a player who leaves the page checks or folds at once, then sits out until they are back', { timeout: 60000 }, async () => {
  const a = await admin('Stays', { fund: 100000 });
  const b = await member('Leaves', null, { fund: 100000 });
  const c = await member('Watches', null, { fund: 100000 });
  const { id } = await call('POST', '/api/tables', { settings: { autoStart: true, autoApprove: true, decisionSeconds: 120, timeBankSeconds: 0, minPlayers: 3 } }, a.token);
  const bots = [new Bot('Stays', a, 11), new Bot('Leaves', b, 12), new Bot('Watches', c, 13)];
  for (const x of bots) await x.connect(id);
  bots[1].passive = true;
  for (let k = 0; k < 3; k++) await bots[k].emit('seat:request', { seat: k, buyIn: 1000 });
  const t = srv.tables.get(id);
  // Leaves stops acting; when it is their turn they close the page
  await until(() => t.hand && t.hand.phase !== 'done' && t.hand.actor()?.id === b.user.id, 20000, 'the leaving player to be on the clock');
  const n = t.hand.number;
  const since = Date.now();
  bots[1].close();
  await until(() => !t.hand || t.hand.number !== n || t.hand.actor()?.id !== b.user.id, 5000, 'the hand to move on');
  assert.ok(Date.now() - since < 3000, 'no waiting out a two-minute clock');
  const p = t.players.get(b.user.id);
  assert.ok(p.away && (p.sittingOut || p.sitOutNext), 'they sit out from the next hand');
  assert.ok(t.loadLog().some((e) => /Leaves left the table/.test(e.text)));
  await until(() => t.hand && t.hand.number > n && t.hand.phase !== 'done', 20000, 'the next hand');
  assert.ok(!t.hand.byId(b.user.id), 'the next hand is dealt without them');
  // a page reload inside the grace time changes nothing
  bots[2].socket.close();
  await wait(40);
  await bots[2].connect(id);
  await wait(400);
  const w = t.players.get(c.user.id);
  assert.ok(!w.away && !w.sittingOut && !w.sitOutNext, 'a quick reload is not leaving');
  bots.forEach((x) => x.close());
});

test('the join link: anyone with it asks for an account, an admin approves or declines', async () => {
  const boss = await admin('Gatekeeper');
  const plain = await member('Plain');
  await assert.rejects(call('POST', '/api/admin/join-link', { on: true }, plain.token), /Only admins/);
  const { joinLink } = await call('POST', '/api/admin/join-link', { on: true }, boss.token);
  assert.equal(joinLink.token.length, 16);
  assert.deepEqual(await call('GET', `/api/join/${joinLink.token}`), { club: 'The Aquarium' });
  await assert.rejects(call('GET', '/api/join/AAAAAAAAAAAAAAAA'), /turned off or replaced/);
  const asked = await call('POST', `/api/join/${joinLink.token}`, { name: 'Newbie', username: 'newbie_1', password: 'secret123' });
  assert.equal(asked.username, 'newbie_1');
  await assert.rejects(call('POST', '/api/auth/login', { username: 'newbie_1', password: 'secret123' }), /waiting for an admin/);
  await assert.rejects(call('POST', `/api/join/${joinLink.token}`, { name: 'Copy', username: 'newbie_1', password: 'secret123' }), /taken/);
  // admins see the request on the club page, members do not; it is not an account yet
  const { clubs } = await call('GET', '/api/me', null, boss.token);
  const clubId = clubs[0].id;
  const req = (await call('GET', `/api/clubs/${clubId}`, null, boss.token)).club.requests.find((r) => r.username === 'newbie_1');
  assert.ok(req && req.name === 'Newbie');
  assert.equal((await call('GET', `/api/clubs/${clubId}`, null, plain.token)).club.requests, undefined);
  const people = await call('GET', '/api/admin/people', null, boss.token);
  assert.ok(!people.users.some((u) => u.username === 'newbie_1'));
  assert.ok(people.requests.some((r) => r.username === 'newbie_1'));
  await assert.rejects(call('POST', `/api/admin/requests/${req.id}`, { approve: true }, plain.token), /Only admins/);
  await call('POST', `/api/admin/requests/${req.id}`, { approve: true }, boss.token);
  await assert.rejects(call('POST', `/api/admin/requests/${req.id}`, { approve: true }, boss.token), /already been answered/);
  const inn = await call('POST', '/api/auth/login', { username: 'newbie_1', password: 'secret123' });
  const club = (await call('GET', `/api/clubs/${clubId}`, null, inn.token)).club;
  assert.equal(club.myStatus, 'active');
  assert.equal(club.myRole, 'member');
  // a declined request is gone, and its username can be asked for again
  await call('POST', `/api/join/${joinLink.token}`, { name: 'Maybe', username: 'maybe_1', password: 'secret123', email: 'maybe@example.com' });
  const r2 = (await call('GET', `/api/clubs/${clubId}`, null, boss.token)).club.requests.find((r) => r.username === 'maybe_1');
  assert.equal(r2.email, 'maybe@example.com');
  await call('POST', `/api/admin/requests/${r2.id}`, { approve: false }, boss.token);
  await assert.rejects(call('POST', '/api/auth/login', { username: 'maybe_1', password: 'secret123' }), /Wrong username/);
  await call('POST', `/api/join/${joinLink.token}`, { name: 'Maybe', username: 'maybe_1', password: 'secret123', email: 'maybe@example.com' });
  // a new link replaces the old one, and a link turned off takes no requests
  const fresh = (await call('POST', '/api/admin/join-link', { on: true }, boss.token)).joinLink;
  assert.notEqual(fresh.token, joinLink.token);
  await assert.rejects(call('POST', `/api/join/${joinLink.token}`, { name: 'Late', username: 'late_1', password: 'secret123' }), /turned off or replaced/);
  assert.equal((await call('POST', '/api/admin/join-link', { on: false }, boss.token)).joinLink, null);
  await assert.rejects(call('GET', `/api/join/${fresh.token}`), /turned off or replaced/);
});

test('voice: the server sets up calls only between people in voice, shows who is muted, and lets go when they leave', { timeout: 30000 }, async () => {
  const a = await admin('Talker');
  const b = await member('Listener');
  const c = await member('Outside');
  const { id } = await call('POST', '/api/tables', { settings: {} }, a.token);
  const bots = [new Bot('Talker', a, 21), new Bot('Listener', b, 22), new Bot('Outside', c, 23)];
  for (const x of bots) await x.connect(id);
  const got = bots.map(() => []);
  const listen = (x, i) => { for (const ev of ['voice:joined', 'voice:left', 'voice:signal', 'voice:ended']) x.socket.on(ev, (p) => got[i].push([ev, p])); };
  bots.forEach(listen);
  const j0 = await bots[0].emit('voice:join', {});
  assert.ok(j0.ok);
  assert.deepEqual(j0.peers, []);
  assert.ok(j0.iceServers.some((x) => String(x.urls).includes('stun:')));
  const j1 = await bots[1].emit('voice:join', {});
  assert.equal(j1.peers.length, 1);
  assert.equal(j1.peers[0].userId, a.user.id);
  const peerA = j1.peers[0].peerId;
  await until(() => got[0].some(([ev]) => ev === 'voice:joined'), 5000, 'the joined notice');
  const peerB = got[0].find(([ev]) => ev === 'voice:joined')[1].peerId;
  // the newcomer calls; the offer reaches only the one it is for, marked with who sent it
  assert.ok((await bots[1].emit('voice:signal', { to: peerA, data: { sdp: { type: 'offer', sdp: 'v=0' } } })).ok);
  await until(() => got[0].some(([ev]) => ev === 'voice:signal'), 5000, 'the offer');
  const sig = got[0].find(([ev]) => ev === 'voice:signal')[1];
  assert.equal(sig.from, peerB);
  assert.equal(sig.data.sdp.type, 'offer');
  assert.ok(!got[2].some(([ev]) => ev === 'voice:signal'), 'someone outside voice gets nothing');
  assert.equal((await bots[2].emit('voice:signal', { to: peerA, data: { candidate: { candidate: '' } } })).ok, false, 'and cannot send');
  assert.equal((await bots[1].emit('voice:signal', { to: peerA, data: { other: 1 } })).ok, false, 'only offers, answers and candidates pass');
  await bots[1].emit('voice:mute', { muted: true });
  await until(() => (bots[2].state?.voice || []).some((v) => v.userId === b.user.id && v.muted), 5000, 'muted in the state');
  // the same person joining on a second page takes over from the first
  const again = new Bot('Talker', a, 24);
  await again.connect(id);
  const j2 = await again.emit('voice:join', {});
  assert.ok(j2.ok);
  await until(() => got[0].some(([ev]) => ev === 'voice:ended'), 5000, 'the first page to leave voice');
  await wait(50);
  assert.equal(srv.tables.get(id).voiceList().filter((v) => v.userId === a.user.id).length, 1, 'one page per person');
  // leaving, or closing the page, tells the others
  bots[1].close();
  await until(() => srv.tables.get(id).voiceList().length === 1, 5000, 'the listener to drop out');
  bots.forEach((x) => x.close());
  again.close();
});

test('accounts: invite only, login, rename', async () => {
  await assert.rejects(call('POST', '/api/auth/guest', { name: 'Temp' }), /invite only/);
  await assert.rejects(call('POST', '/api/auth/register', { username: 'temp_user', password: 'abcdefgh' }), /invite only/);
  await assert.rejects(call('GET', '/api/me'), /sign in/);
  const g = await member('Temp', 'temp_user');
  await assert.rejects(call('POST', '/api/auth/login', { username: 'temp_user', password: 'wrong!!!' }), /Wrong/);
  const li = await call('POST', '/api/auth/login', { username: 'TEMP_USER', password: 'secret123' });
  assert.equal(li.user.id, g.user.id);
  const me = await call('PATCH', '/api/me', { name: 'Renamed' }, li.token);
  assert.equal(me.user.name, 'Renamed');
});

test('calling 30: a countdown on the seat, a big pot starts it again, and when it runs out they stand up', { timeout: 60000 }, async () => {
  const a = await admin('Caller', { fund: 100000 });
  const b = await member('Opponent', null, { fund: 100000 });
  const { id } = await call('POST', '/api/tables', { settings: { autoStart: true, autoApprove: true, decisionSeconds: 5, timeBankSeconds: 0 } }, a.token);
  const bots = [new Bot('Caller', a, 41), new Bot('Opponent', b, 42)];
  for (const x of bots) await x.connect(id);
  await bots[0].emit('seat:request', { seat: 0, buyIn: 1000 });
  await bots[1].emit('seat:request', { seat: 1, buyIn: 1000 });
  const t = srv.tables.get(id);
  await until(() => t.handNumber >= 1, 10000, 'a hand');
  const keep = DELAYS.call;
  try {
    DELAYS.call = 60000;
    assert.ok((await bots[0].emit('call30', {})).ok);
    assert.equal((await bots[0].emit('call30', {})).ok, false, 'once is enough');
    await until(() => bots[1].state?.seats.some((x) => x && x.userId === a.user.id && x.leaveAt), 5000, 'the countdown on the seat, for everyone');
    assert.ok(t.loadLog().some((e) => /Caller called/.test(e.text)));
    assert.ok((await bots[0].emit('call30:cancel', {})).ok);
    assert.equal(t.players.get(a.user.id).leaveAt, null, 'staying takes it back');
    // a pot over the line starts the 30 minutes again
    const real = t.callResetAt;
    t.callResetAt = () => 0;
    await bots[0].emit('call30', {});
    const first = t.players.get(a.user.id).leaveAt;
    await until(() => t.players.get(a.user.id).leaveAt > first, 20000, 'a pot won to start it again');
    assert.ok(t.loadLog().some((e) => /Caller won a pot over/.test(e.text)));
    t.callResetAt = real;
    // when the time is up they stand up after the hand, and their chips go back to their balance
    await bots[0].emit('call30:cancel', {});
    DELAYS.call = 300;
    await bots[0].emit('call30', {});
    await until(() => !t.players.has(a.user.id), 20000, 'the caller to stand up');
    assert.ok(t.loadLog().some((e) => /Caller's time is up/.test(e.text)));
  } finally {
    DELAYS.call = keep;
    bots.forEach((x) => x.close());
  }
});

// Runs last: it clears every game on the test server.
test('time banks: each is 30 more seconds, several can go in one hand, and one comes back every few hands', { timeout: 90000 }, async () => {
  const a = await admin('Banker', { fund: 100000 });
  const b = await member('Ben', null, { fund: 100000 });
  // the defaults: 3 time banks, one back every 15 hands; the old seconds setting of 0 still means none
  const plain = await call('POST', '/api/tables', { settings: {} }, a.token);
  assert.equal(srv.tables.get(plain.id).settings.timeBanks, 3);
  assert.equal(srv.tables.get(plain.id).settings.timeBankRefill, 15);
  const old = await call('POST', '/api/tables', { settings: { timeBankSeconds: 0 } }, a.token);
  assert.equal(srv.tables.get(old.id).settings.timeBanks, 0);
  const { id } = await call('POST', '/api/tables', { settings: { autoStart: true, autoApprove: true, decisionSeconds: 30, timeBanks: 2, timeBankRefill: 2 } }, a.token);
  const bots = [new Bot('Banker', a, 7), new Bot('Ben', b, 8)];
  for (const x of bots) { x.passive = true; await x.connect(id); }
  await bots[0].emit('seat:request', { seat: 0, buyIn: 1000 });
  await bots[1].emit('seat:request', { seat: 1, buyIn: 1000 });
  await until(() => bots.some((x) => x.state?.hand?.legal), 15000, 'a turn');
  const actor = bots.find((x) => x.state.hand.legal);
  const other = bots.find((x) => x !== actor);
  const mine = (x) => x.state.seats[x.state.me.seat];
  assert.equal(mine(actor).timeBanks, 2);
  const before = actor.state.hand.turn.deadline;
  let r = await actor.emit('timebank', {});
  assert.ok(r.ok, r.error);
  r = await actor.emit('timebank', {});
  assert.ok(r.ok, r.error);
  await until(() => mine(actor).timeBanks === 0, 3000, 'both used');
  assert.equal(actor.state.hand.turn.deadline - before, 60000, 'two time banks: a minute more');
  assert.equal(actor.state.hand.turn.total, 90000);
  r = await actor.emit('timebank', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /no time banks left/);
  r = await other.emit('timebank', {});
  assert.equal(r.ok, false, 'only on your turn');
  // play on: one back for every 2 hands dealt, up to the 2 they started with
  for (const x of bots) { x.passive = false; x.onState(x.state); }
  await until(() => (bots[0].state?.table.handNumber || 0) >= 6, 60000, 'six hands');
  assert.equal(mine(actor).timeBanks, 2);
  assert.equal(srv.tables.get(id).players.get(actor.userId).timeBanks, 2);
  // fewer time banks set during the game: nobody keeps more than the new number
  r = await bots[0].emit('host:settings', { settings: { timeBanks: 1 } });
  assert.ok(r.ok, r.error);
  await until(() => srv.tables.get(id).players.get(actor.userId).timeBanks === 1, 5000, 'cut to one');
  bots.forEach((x) => x.close());
});

test('the straddle: a player who turns it on straddles twice the big blind when under the gun', { timeout: 60000 }, async () => {
  const a = await admin('Straddler', { fund: 100000 });
  const b = await member('Second', null, { fund: 100000 });
  const c = await member('Third', null, { fund: 100000 });
  const { id } = await call('POST', '/api/tables', { settings: { autoStart: true, autoApprove: true, straddle: true, sevenDeuce: 100 } }, a.token);
  const bots = [new Bot('Straddler', a, 51), new Bot('Second', b, 52), new Bot('Third', c, 53)];
  try {
    for (const x of bots) await x.connect(id);
    for (const [i, x] of bots.entries()) await x.emit('seat:request', { seat: i, buyIn: 1000 });
    assert.ok((await bots[0].emit('straddle', { value: true })).ok);
    await until(() => bots[1].state?.seats[0]?.straddle, 5000, 'the choice showing on the seat');
    const t = srv.tables.get(id);
    assert.equal(t.settings.sevenDeuce, 100);
    await until(() => t.getRecords().some((r) => r.posts.some((x) => x.a === 'st')), 40000, 'a straddled hand');
    const rec = t.getRecords().find((r) => r.posts.some((x) => x.a === 'st'));
    const st = rec.posts.find((x) => x.a === 'st');
    assert.equal(st.id, a.user.id, 'the player who asked for it straddles');
    assert.equal(st.amt, 2 * rec.bigBlind);
    assert.ok((await bots[0].emit('straddle', { value: false })).ok);
    assert.equal(t.players.get(a.user.id).straddle, false, 'and can turn it off');
    const ack = await bots[1].emit('straddle', { value: true });
    assert.ok(ack.ok);
    await call('POST', `/api/tables/${id}/end`, {}, a.token).catch(() => {});
  } finally {
    bots.forEach((x) => x.close());
  }
});

test('settling one player against another, results over a period, and the owner clearing all history', { timeout: 90000 }, async () => {
  const a = await admin('Banker', { fund: 100000 });
  const b = await member('Owes', null, { fund: 100000 });
  const d = await member('Owed', null, { fund: 100000 });
  const { clubs: [{ id: clubId }] } = await call('GET', '/api/me', null, a.token);
  const bal = async (uid) => (await call('GET', `/api/clubs/${clubId}`, null, a.token)).club.members.find((m) => m.userId === uid).balance;
  // Owes is down 400 and Owed is up 300; Owes pays Owed 250 in cash
  await call('POST', `/api/clubs/${clubId}/members/${b.user.id}/chips`, { amount: -100400, note: 'Lost' }, siteOwner.token);
  await call('POST', `/api/clubs/${clubId}/members/${d.user.id}/chips`, { amount: 300, note: 'Won' }, siteOwner.token);
  assert.equal(await bal(b.user.id), -400);
  await assert.rejects(call('POST', `/api/clubs/${clubId}/members/${b.user.id}/settle`, { withUserId: d.user.id, amount: 250 }, d.token), /owner or a manager/);
  await assert.rejects(call('POST', `/api/clubs/${clubId}/members/${b.user.id}/settle`, { withUserId: d.user.id, amount: 401 }, a.token), /only has/);
  await assert.rejects(call('POST', `/api/clubs/${clubId}/members/${b.user.id}/settle`, { withUserId: b.user.id, amount: 10 }, a.token), /someone else/);
  const before = await bal(d.user.id);
  const v = await call('POST', `/api/clubs/${clubId}/members/${b.user.id}/settle`, { withUserId: d.user.id, amount: 250, note: 'cash' }, a.token);
  assert.equal(await bal(b.user.id), -150);
  assert.equal(await bal(d.user.id), before - 250);
  const pairId = v.club.transactions.find((t) => t.type === 'settlement' && t.pairId && t.userId === b.user.id)?.pairId;
  const pair = v.club.transactions.filter((t) => t.pairId === pairId);
  assert.ok(pairId);
  assert.equal(pair.length, 2, 'one entry for each of them');
  assert.deepEqual(pair.map((t) => t.amount).sort((x, y) => x - y), [-250, 250]);
  assert.ok(pair.some((t) => t.userId === b.user.id && /Paid Owed \(cash\)/.test(t.note)));
  assert.ok(pair.some((t) => t.userId === d.user.id && /Paid by Owes \(cash\)/.test(t.note)));
  // settling with the club still sets the balance to zero
  await call('POST', `/api/clubs/${clubId}/members/${b.user.id}/settle`, {}, a.token);
  assert.equal(await bal(b.user.id), 0);

  // a few hands, then the results over all time and over a period that ends before them
  await call('POST', `/api/clubs/${clubId}/members/${b.user.id}/chips`, { amount: 100000, note: 'Back in' }, siteOwner.token);
  const { id } = await call('POST', '/api/tables', { name: 'Results game', settings: { autoStart: true, autoApprove: true, decisionSeconds: 5, timeBankSeconds: 0 } }, a.token);
  const bots = [new Bot('Banker', a, 31), new Bot('Owes', b, 32)];
  for (const x of bots) await x.connect(id);
  await bots[0].emit('seat:request', { seat: 0, buyIn: 1000 });
  await bots[1].emit('seat:request', { seat: 1, buyIn: 1000 });
  await until(() => (bots[0].state?.table.handNumber || 0) >= 6, 30000, 'six hands');
  // pause, so no hand ends between reading the results and reading the hands
  assert.ok((await bots[0].emit('host:pause', { value: true })).ok);
  await until(() => srv.tables.get(id).hand === null, 10000, 'the hand to end');
  await wait(50);
  const watcher = new Bot('Owed', d, 33);
  await watcher.connect(id);
  let removed = null;
  watcher.socket.on('table:removed', (p) => { removed = p; });
  const all = (await call('GET', `/api/clubs/${clubId}/results`, null, a.token)).results;
  const mine = all.players.filter((p) => [a.user.id, b.user.id].includes(p.userId));
  assert.equal(mine.length, 2);
  const recs = srv.tables.get(id).getRecords();
  for (const p of mine) {
    const net = recs.reduce((s, r) => s + (r.players.find((x) => x.userId === p.userId)?.net || 0), 0);
    assert.equal(p.net, net, `${p.name}'s result adds up their hands`);
    assert.ok(p.games >= 1 && p.hands >= recs.length);
  }
  assert.ok(all.players[0].net >= all.players[all.players.length - 1].net, 'biggest winner first');
  const early = (await call('GET', `/api/clubs/${clubId}/results?to=${recs[0].startedAt - 1}`, null, a.token)).results;
  assert.ok(!early.players.some((p) => p.userId === b.user.id && p.hands >= recs.length), 'a period before the game leaves it out');
  const stats = (await call('GET', `/api/clubs/${clubId}/stats?from=${Date.now() + 60000}`, null, a.token)).stats;
  assert.equal(stats.hands, 0, 'stats follow the period too');
  // a member who may not see the ledger sees only their own result
  await call('PATCH', `/api/clubs/${clubId}`, { membersSeeLedger: false }, a.token);
  const theirs = (await call('GET', `/api/clubs/${clubId}/results`, null, b.token)).results;
  assert.ok(theirs.players.filter((p) => p.userId !== b.user.id).every((p) => p.net === null));

  // only the owner clears, after typing CLEAR; games, hands, ledger and balances go, accounts stay
  await assert.rejects(call('POST', '/api/admin/clear-history', { confirm: 'CLEAR' }, a.token), /Only the owner/);
  await assert.rejects(call('POST', '/api/admin/clear-history', { confirm: 'yes' }, siteOwner.token), /Type CLEAR/);
  await call('POST', '/api/admin/clear-history', { confirm: 'CLEAR' }, siteOwner.token);
  await until(() => removed, 5000, 'pages at the game to hear it is gone');
  assert.equal(srv.tables.tables.size, 0);
  assert.ok(!fs.existsSync(path.join(dataDir, 'hands', id + '.jsonl')));
  const after = (await call('GET', `/api/clubs/${clubId}`, null, a.token)).club;
  assert.equal(after.transactions.length, 0);
  assert.ok(after.members.every((m) => m.balance === 0));
  assert.equal((await call('GET', `/api/clubs/${clubId}`, null, a.token)).tables.length, 0);
  assert.equal((await call('GET', `/api/clubs/${clubId}/results`, null, a.token)).results.players.length, 0);
  assert.ok((await call('POST', '/api/auth/login', { username: b.user.username, password: 'secret123' })).token, 'accounts stay');
  bots.forEach((x) => x.close());
  watcher.close();
});
