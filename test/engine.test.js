import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hand, buildPots } from '../server/engine/hand.js';
import { CANONICAL_DECK, GAME_TYPES } from '../shared/cards.js';
import { reconstructDeal, deriveDeckSync } from '../shared/fairness.js';
import { hmacSync } from '../server/fair-node.js';

function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Builds a deck where the given cards come first (in order), rest canonical.
function stackedDeck(top) {
  const rest = CANONICAL_DECK.filter((c) => !top.includes(c));
  return top.concat(rest);
}

function mk(players, opts = {}) {
  return new Hand({
    number: 1, gameType: opts.gameType || 'nlh', smallBlind: opts.sb ?? 5, bigBlind: opts.bb ?? 10,
    buttonSeat: opts.button ?? players[0].seat, deck: opts.deck || CANONICAL_DECK.slice(),
    bombAnte: opts.bombAnte || 0, ritMax: opts.ritMax || 1, doubleBoard: !!opts.doubleBoard,
    players: players.map((p, i) => ({ id: p.id || 'p' + p.seat, seat: p.seat, name: p.name || 'P' + p.seat, stack: p.stack ?? 1000 })),
  });
}

const total = (h) => h.players.reduce((s, p) => s + p.stack, 0) + (h.phase === 'done' ? 0 : h.potTotal());

test('heads-up: button posts small blind and acts first preflop, big blind first after', () => {
  const h = mk([{ seat: 0 }, { seat: 3 }], { button: 3 });
  h.start();
  const btn = h.byId('p3');
  assert.equal(btn.committed, 5);
  assert.equal(h.byId('p0').committed, 10);
  assert.equal(h.actor().id, 'p3');
  h.act('p3', { type: 'call' });
  assert.equal(h.actor().id, 'p0'); // BB option
  h.act('p0', { type: 'check' });
  assert.equal(h.pending, 'next-street');
  h.advance();
  assert.equal(h.street, 'flop');
  assert.equal(h.actor().id, 'p0'); // BB acts first postflop heads-up
});

test('three-way all-in builds main and side pots and returns the uncalled excess', () => {
  const h = mk([{ seat: 0, stack: 100 }, { seat: 1, stack: 300 }, { seat: 2, stack: 1000 }], { button: 0 });
  h.start(); // SB seat1, BB seat2, UTG = seat0 (button acts first 3-handed preflop)
  assert.equal(h.actor().id, 'p0');
  h.act('p0', { type: 'allin' });
  h.act('p1', { type: 'allin' });
  h.act('p2', { type: 'call' });
  const pots = buildPots(h.players);
  assert.deepEqual(pots.map((p) => p.amount), [300, 400]);
  assert.deepEqual(pots[0].eligible.sort(), ['p0', 'p1', 'p2']);
  assert.deepEqual(pots[1].eligible.sort(), ['p1', 'p2']);
  assert.equal(h.byId('p2').stack, 700);
  while (h.phase !== 'done') h.advance();
  assert.equal(total(h), 1400);
});

test('an all-in for less than a full raise does not reopen betting', () => {
  const h = mk([{ seat: 0 }, { seat: 1, stack: 150 }, { seat: 2 }, { seat: 3 }], { button: 3 });
  h.start(); // SB 0, BB 1? button 3 -> SB seat0, BB seat1, UTG seat2
  h.act('p2', { type: 'call' });
  h.act('p3', { type: 'call' });
  h.act('p0', { type: 'call' });
  h.act('p1', { type: 'check' });
  h.advance(); // flop, first to act seat0
  h.act('p0', { type: 'bet', to: 100 });
  h.act('p1', { type: 'allin' }); // 140 behind -> to 140, raise of 40 < 100
  assert.equal(h.currentBet, 140);
  h.act('p2', { type: 'call' });
  h.act('p3', { type: 'call' });
  const legal = h.legalActions('p0');
  assert.equal(legal.canRaise, false, 'original bettor faces only an incomplete raise');
  assert.equal(legal.toCall, 40);
});

test('two short all-ins that add up to a full raise do reopen betting', () => {
  const h = mk([{ seat: 0 }, { seat: 1, stack: 160 }, { seat: 2, stack: 230 }, { seat: 3 }], { button: 3 });
  h.start();
  h.act('p2', { type: 'call' });
  h.act('p3', { type: 'call' });
  h.act('p0', { type: 'call' });
  h.act('p1', { type: 'check' });
  h.advance();
  h.act('p0', { type: 'bet', to: 100 });
  h.act('p1', { type: 'allin' }); // to 150
  h.act('p2', { type: 'allin' }); // to 220
  h.act('p3', { type: 'call' });
  const legal = h.legalActions('p0');
  assert.equal(legal.canRaise, true);
  assert.equal(legal.minTo, 320);
});

test('pot limit: preflop pot raise is 3.5 big blinds, postflop pot bet equals the pot', () => {
  const h = mk([{ seat: 0 }, { seat: 1 }, { seat: 2 }], { gameType: 'plo4', button: 0 });
  h.start();
  const l = h.legalActions('p0');
  assert.equal(l.maxTo, 35);
  assert.equal(l.minTo, 20);
  h.act('p0', { type: 'raise', to: 35 });
  h.act('p1', { type: 'call' });
  h.act('p2', { type: 'call' });
  h.advance();
  const l2 = h.legalActions('p1');
  assert.equal(l2.maxTo, 105);
  h.act('p1', { type: 'bet', to: 50 });
  const l3 = h.legalActions('p2');
  assert.equal(l3.maxTo, 50 + (105 + 50 + 50)); // call 50 then raise the pot
});

test('everyone folds: uncalled bet returned, winner collects', () => {
  const h = mk([{ seat: 0 }, { seat: 1 }, { seat: 2 }], { button: 0 });
  h.start();
  h.act('p0', { type: 'raise', to: 40 });
  h.act('p1', { type: 'fold' });
  h.act('p2', { type: 'fold' });
  assert.equal(h.phase, 'done');
  assert.equal(h.byId('p0').stack, 1015);
  assert.equal(h.results.payouts[0].amount, 25); // pot of 5 + 10 + own 10 after the uncalled 30 comes back
});

test('short big blind heads-up: small blind does not have to complete', () => {
  const h = mk([{ seat: 0, stack: 500 }, { seat: 1, stack: 3 }], { button: 0 });
  h.start();
  assert.notEqual(h.phase, 'betting');
  while (h.phase !== 'done') h.advance();
  assert.equal(total(h), 503);
});

test('bomb pot: everyone antes, flop comes immediately, first to act is left of the button', () => {
  const h = mk([{ seat: 0 }, { seat: 1 }, { seat: 2, stack: 15 }, { seat: 3 }], { button: 1, bombAnte: 20 });
  h.start();
  assert.equal(h.board.length, 3);
  assert.equal(h.street, 'flop');
  assert.equal(h.potTotal(), 75);
  assert.equal(h.byId('p2').allIn, true);
  assert.equal(h.actor().id, 'p3'); // seat2 is all-in, so seat3 acts first
  assert.equal(h.legalActions('p3').minTo, 10);
});

test('run it twice: two boards from consecutive deck cards, pot split per run', () => {
  // seat0 AA vs seat1 KK, all in preflop, ritMax 2
  const deck = stackedDeck(['Ah', 'Kh', 'Ad', 'Kd', '2c', '7s', '9d', 'Jc', '3h', 'Ks', '4s', '5s', '8c', '8h']);
  const h = mk([{ seat: 0 }, { seat: 1 }], { button: 0, deck, ritMax: 2 });
  // dealing starts left of the button: seat1 first
  h.start();
  h.act('p0', { type: 'allin' });
  h.act('p1', { type: 'call' });
  assert.equal(h.phase, 'rit');
  h.setRitChoice('p0', 2);
  assert.equal(h.phase, 'rit');
  h.setRitChoice('p1', 4); // capped at max 2; result = min = 2
  assert.equal(h.phase, 'runout');
  while (h.phase !== 'done') h.advance();
  assert.equal(h.boards.length, 2);
  const rec = h.recordData();
  const rebuilt = reconstructDeal(deck, rec.dealt);
  assert.deepEqual(rebuilt.boards, rec.dealt.boards);
  assert.deepEqual(rebuilt.holes[0], h.byId('p0').hole);
  assert.equal(h.results.pots[0].runs.length, 2);
  assert.equal(total(h), 2000);
});

function allInPreflop(n, opts = {}) {
  const h = mk(Array.from({ length: n }, (_, i) => ({ seat: i })), { button: 0, ritMax: 4, ...opts });
  h.start();
  while (h.phase === 'betting') {
    const a = h.actor();
    const l = h.legalActions(a.id);
    h.act(a.id, l.canRaise ? { type: 'allin' } : { type: 'call' });
  }
  return h;
}

test('run it vote: only votes that came in count, and the lowest one is used', () => {
  const h = allInPreflop(3);
  assert.equal(h.phase, 'rit');
  h.setRitChoice('p0', 4);
  h.setRitChoice('p1', 3);
  assert.equal(h.phase, 'rit', 'still waiting for the third player');
  h.resolveRit(); // the 15 second timer ran out; p2 never voted
  assert.equal(h.runCount, 3);
  while (h.phase !== 'done') h.advance();
  assert.equal(h.boards.length, 3);
  assert.equal(total(h), 3000);
});

test('run it vote: one vote for once decides it straight away', () => {
  const h = allInPreflop(3);
  h.setRitChoice('p0', 4);
  h.setRitChoice('p2', 1);
  assert.equal(h.phase, 'runout', 'no need to wait for the last vote');
  assert.equal(h.runCount, 1);
  assert.equal(h.rit.result, 1);
  assert.throws(() => h.setRitChoice('p1', 4), /no vote/);
});

test('run it vote: nobody voting means once, and a vote cannot be changed', () => {
  const h = allInPreflop(2);
  h.resolveRit();
  assert.equal(h.runCount, 1);
  const h2 = allInPreflop(3);
  h2.setRitChoice('p0', 3);
  assert.throws(() => h2.setRitChoice('p0', 2), /already voted/);
});

test('run it vote happens before anyone turns their cards over', () => {
  const h = allInPreflop(2);
  assert.equal(h.phase, 'rit');
  assert.equal(h.publicState('p1').players.find((p) => p.id === 'p0').hole, null, 'cards still face down while voting');
  assert.ok(!h.players.some((p) => p.shown));
  h.setRitChoice('p0', 2);
  h.setRitChoice('p1', 2);
  assert.ok(h.players.every((p) => p.shown), 'cards turned over once the vote is done');
  assert.deepEqual(h.publicState('p1').players.find((p) => p.id === 'p0').hole, h.byId('p0').hole);
});

test('double board: one pot, half on each board', () => {
  // heads-up, button seat 0: dealing starts with seat 1. Seat 0 holds aces, seat 1 holds 7-2.
  // board 1 is dry (aces win), board 2 fills up seat 1 (sevens full).
  const deck = stackedDeck(['7c', 'As', '2d', 'Ah', 'Kd', '9s', '4c', '7h', '7s', '2c', '3h', 'Jd', '8d', 'Qc']);
  const h = mk([{ seat: 0 }, { seat: 1 }], { button: 0, deck, doubleBoard: true });
  h.start();
  h.act('p0', { type: 'allin' });
  h.act('p1', { type: 'call' });
  while (h.phase !== 'done') h.advance();
  assert.deepEqual(h.boards, [['Kd', '9s', '4c', '3h', '8d'], ['7h', '7s', '2c', 'Jd', 'Qc']]);
  const runs = h.results.pots[0].runs;
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => r.winners.map((w) => w.id)), [['p0'], ['p1']]);
  assert.deepEqual(runs.map((r) => r.amount), [1000, 1000]);
  assert.equal(h.byId('p0').stack, 1000);
  assert.equal(h.byId('p1').stack, 1000);
  const rec = h.recordData();
  assert.equal(rec.doubleBoard, true);
  assert.deepEqual(reconstructDeal(deck, rec.dealt).boards, rec.dealt.boards);
});

test('double board run twice: four boards, shared flops, every card rebuilt from the deck', () => {
  const h = mk([{ seat: 0 }, { seat: 1 }], { button: 0, doubleBoard: true, ritMax: 4, deck: deriveDeckSync(hmacSync, 'db-seed', 'db') });
  h.start();
  h.act('p0', { type: 'call' });
  h.act('p1', { type: 'check' });
  h.advance(); // flop on both boards
  assert.equal(h.boards.length, 2);
  assert.ok(h.boards.every((b) => b.length === 3));
  h.act('p1', { type: 'allin' });
  h.act('p0', { type: 'call' });
  assert.equal(h.phase, 'rit');
  h.setRitChoice('p0', 2);
  h.setRitChoice('p1', 3);
  assert.equal(h.runCount, 2);
  while (h.phase !== 'done') h.advance();
  assert.equal(h.boards.length, 4);
  assert.ok(h.boards.every((b) => b.length === 5));
  assert.deepEqual(h.boards[2].slice(0, 3), h.boards[0].slice(0, 3), 'run 2 board 1 keeps the board 1 flop');
  assert.deepEqual(h.boards[3].slice(0, 3), h.boards[1].slice(0, 3), 'run 2 board 2 keeps the board 2 flop');
  const runs = h.results.pots[0].runs;
  assert.deepEqual(runs.map((r) => [r.run, r.side]), [[0, 0], [0, 1], [1, 0], [1, 1]]);
  assert.equal(runs.reduce((s, r) => s + r.amount, 0), 2000);
  assert.equal(total(h), 2000);
  const rec = h.recordData();
  const rebuilt = reconstructDeal(h.deck, rec.dealt);
  assert.deepEqual(rebuilt.boards, rec.dealt.boards);
  assert.equal(rebuilt.cardsUsed, 4 + 6 + 8);
});

test('double board needs ten board cards: a full PLO5 table cannot have it', () => {
  const players = Array.from({ length: 9 }, (_, i) => ({ seat: i }));
  assert.throws(() => mk(players, { gameType: 'plo5', doubleBoard: true }), /too many players/);
  assert.doesNotThrow(() => mk(players.slice(0, 8), { gameType: 'plo5', doubleBoard: true }));
});

test('PLO5 deck limits how many runs are possible', () => {
  const players = Array.from({ length: 9 }, (_, i) => ({ seat: i }));
  const h = mk(players, { gameType: 'plo5', button: 0, ritMax: 4 });
  h.start();
  // all in preflop: 45 hole cards dealt, 7 left, need 5 per run -> no multi-run prompt
  while (h.phase === 'betting') {
    const a = h.actor();
    const l = h.legalActions(a.id);
    h.act(a.id, l.canRaise ? { type: 'allin' } : { type: 'call' });
  }
  assert.notEqual(h.phase, 'rit');
  while (h.phase !== 'done') h.advance();
  assert.equal(total(h), 9000);
});

// ---------- randomized simulation ----------
function randomAction(legal, rng) {
  const r = rng();
  if (legal.canRaise && r < 0.22) {
    const to = legal.minTo + Math.floor(rng() * (legal.maxTo - legal.minTo + 1));
    return { type: rng() < 0.5 ? 'raise' : 'bet', to };
  }
  if (legal.canRaise && r < 0.28) return { type: 'allin' };
  if (legal.canCheck && r < 0.85) return { type: 'check' };
  if (legal.canCall && r < 0.8) return { type: 'call' };
  return { type: 'fold' };
}

function simulate(seed, hands) {
  const rng = rngFrom(seed);
  const games = Object.keys(GAME_TYPES);
  let multiRuns = 0, bombs = 0, sidePots = 0, doubleBoards = 0;
  for (let n = 0; n < hands; n++) {
    const gameType = games[Math.floor(rng() * games.length)];
    const maxP = GAME_TYPES[gameType].maxPlayers;
    const count = 2 + Math.floor(rng() * (maxP - 1));
    const seats = [...Array(10).keys()].sort(() => rng() - 0.5).slice(0, count).sort((a, b) => a - b);
    const bb = [2, 10, 20, 50][Math.floor(rng() * 4)];
    const players = seats.map((seat) => ({ seat, stack: Math.max(1, Math.floor(rng() * bb * (rng() < 0.3 ? 8 : 150))) }));
    const deck = deriveDeckSync(hmacSync, 'seed' + seed + ':' + n, 'sim');
    const bombAnte = rng() < 0.15 ? bb * 2 : 0;
    if (bombAnte) bombs++;
    const doubleBoard = rng() < 0.3 && count * GAME_TYPES[gameType].holeCount + 10 <= 52;
    if (doubleBoard) doubleBoards++;
    const h = mk(players, { gameType, bb, sb: bb / 2, button: seats[Math.floor(rng() * seats.length)], deck, bombAnte, doubleBoard, ritMax: 1 + Math.floor(rng() * 4) });
    const before = players.reduce((s, p) => s + p.stack, 0);
    h.start();
    let steps = 0;
    while (h.phase !== 'done') {
      if (++steps > 5000) throw new Error('hand did not finish');
      assert.equal(total(h), before, 'chips conserved mid-hand');
      if (h.phase === 'betting') {
        const a = h.actor();
        const l = h.legalActions(a.id);
        assert.ok(l.toCall >= 0 && l.minTo <= l.maxTo && l.maxTo <= l.allInTo, JSON.stringify(l));
        h.act(a.id, randomAction(l, rng));
      } else if (h.phase === 'rit') {
        for (const id of h.rit.eligible) if (h.phase === 'rit' && rng() < 0.9) h.setRitChoice(id, 1 + Math.floor(rng() * 4));
        if (h.phase === 'rit') h.resolveRit();
      } else if (h.pending) {
        h.advance();
      } else {
        throw new Error('stuck in ' + h.phase);
      }
    }
    if (h.runCount > 1) multiRuns++;
    if (h.results.pots.length > 1) sidePots++;
    const after = h.players.reduce((s, p) => s + p.stack, 0);
    assert.equal(after, before, `chips conserved (hand ${n})`);
    for (const p of h.players) assert.ok(p.stack >= 0);
    const paid = h.results.payouts.reduce((s, p) => s + p.amount, 0);
    const potSum = h.results.pots.reduce((s, p) => s + p.amount, 0);
    assert.equal(paid, potSum);
    const rec = h.recordData();
    const rebuilt = reconstructDeal(deck, rec.dealt);
    rec.players.forEach((p) => assert.deepEqual(rebuilt.holes[p.seat], p.hole));
    assert.deepEqual(rebuilt.boards, rec.dealt.boards);
    const used = new Set([...rec.players.flatMap((p) => p.hole), ...rec.dealt.boards.flat()]);
    assert.equal(used.size, rebuilt.cardsUsed, 'no card dealt twice');
  }
  return { multiRuns, bombs, sidePots, doubleBoards };
}

test('randomized: 6000 hands across all games conserve chips and reconstruct exactly', () => {
  const stats = simulate(12345, 6000);
  assert.ok(stats.multiRuns > 50, 'exercised multi-run: ' + stats.multiRuns);
  assert.ok(stats.bombs > 300, 'exercised bombs: ' + stats.bombs);
  assert.ok(stats.sidePots > 100, 'exercised side pots: ' + stats.sidePots);
  assert.ok(stats.doubleBoards > 1000, 'exercised double board: ' + stats.doubleBoards);
  console.log('simulation stats', stats);
});
