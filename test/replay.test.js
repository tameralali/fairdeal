import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hand } from '../server/engine/hand.js';
import { deriveDeckSync } from '../shared/fairness.js';
import { hmacSync } from '../server/fair-node.js';
import { buildReplay, canReplay } from '../shared/replay.js';

function hand(n, opts = {}) {
  return new Hand({
    number: 1, gameType: opts.game || 'nlh', smallBlind: 5, bigBlind: 10, buttonSeat: 0, bombAnte: opts.bomb || 0,
    ritMax: opts.ritMax || 1, doubleBoard: !!opts.doubleBoard,
    deck: deriveDeckSync(hmacSync, opts.seed || 'replay', 'x'),
    players: Array.from({ length: n }, (_, i) => ({ id: 'p' + i, seat: i, name: 'P' + i, stack: opts.stacks?.[i] ?? 1000 })),
  });
}

// Plays the script, votes on run it if asked, then checks or folds to the end. Returns a record shaped
// like the stored one (players by userId, hole cards under dealt.holes).
function play(h, steps, runs = 1) {
  h.start();
  for (const [id, type, to] of steps) {
    while (h.phase === 'pending') h.advance();
    assert.equal(h.actor()?.id, id, `expected ${id} to act`);
    h.act(id, { type, to });
  }
  for (let guard = 0; h.phase !== 'done' && guard < 300; guard++) {
    if (h.phase === 'rit') { for (const id of h.rit.eligible) h.setRitChoice(id, runs); h.resolveRit(); continue; }
    if (h.phase === 'betting') {
      const a = h.actor();
      h.act(a.id, { type: h.legalActions(a.id).canCheck ? 'check' : 'fold' });
    } else h.advance();
  }
  assert.equal(h.phase, 'done');
  const d = h.recordData();
  return {
    ...d, handNumber: 1,
    players: d.players.map((p) => ({ seat: p.seat, userId: p.id, name: p.name, startStack: p.startStack, endStack: p.endStack, net: p.endStack - p.startStack, shown: p.shown, folded: p.folded })),
    dealt: { ...d.dealt, holes: Object.fromEntries(d.players.map((p) => [p.seat, p.hole])) },
  };
}

// Every step: money is never made or lost, and the board only grows.
function checkSteps(rec, R) {
  const total = rec.players.reduce((s, p) => s + p.startStack, 0);
  let prev = null;
  for (const st of R.steps) {
    const onTable = st.players.reduce((s, p) => s + p.stack, 0);
    if (!st.final) assert.equal(onTable + st.pot, total, `money adds up at "${st.text}"`);
    if (prev) st.cuts.forEach((c, i) => assert.ok(c >= prev.cuts[i], 'cards are never taken back'));
    prev = st;
  }
  const last = R.steps.at(-1);
  assert.ok(last.final);
  for (const p of rec.players) assert.equal(last.players.find((x) => x.id === p.userId).stack, p.endStack, 'end stacks');
  assert.deepEqual(last.cuts, rec.dealt.boards.map((b) => b.length), 'every card is out at the end');
}

test('a raised pot with a flop bet and a fold', () => {
  const rec = play(hand(4), [['p3', 'raise', 30], ['p0', 'call'], ['p1', 'fold'], ['p2', 'fold'], ['p3', 'bet', 40], ['p0', 'fold']]);
  assert.ok(canReplay(rec));
  const R = buildReplay(rec, (a) => `$${a}`);
  checkSteps(rec, R);
  assert.deepEqual(R.steps.map((s) => s.text), [
    'P1 posts the small blind $5, P2 posts the big blind $10',
    'P3 raises to $30', 'P0 calls $30', 'P1 folds', 'P2 folds',
    `Flop: ${rec.dealt.boards[0].slice(0, 3).join(' ')}`,
    'P3 bets $40', 'P0 folds',
    'P3 wins $75', // the flop bet nobody called goes back
  ]);
  assert.equal(R.steps[2].pot, 5 + 10 + 30 + 30);
  assert.equal(R.steps[2].players.find((p) => p.id === 'p0').bet, 30);
  assert.equal(R.steps[5].players.find((p) => p.id === 'p0').bet, 0, 'bets go into the pot on a new street');
  assert.deepEqual(R.steps[5].cuts, [3]);
  assert.equal(R.steps[1].actor, 3);
  assert.deepEqual(R.steps.at(-1).winners, [3]);
});

test('all in preflop, run three times on two boards', () => {
  // heads up the button posts the small blind and acts first preflop
  const rec = play(hand(2, { doubleBoard: true, ritMax: 3, seed: 'db3' }), [['p0', 'raise', 1000], ['p1', 'call']], 3);
  assert.equal(rec.runCount, 3);
  const R = buildReplay(rec);
  checkSteps(rec, R);
  const runs = R.steps.filter((s) => s.dealt === 'run');
  assert.equal(runs.length, 3);
  assert.deepEqual(runs[0].cuts, [3, 3, 0, 0, 0, 0], 'run 1 starts with the flop on both of its boards');
  assert.deepEqual(runs[1].cuts, [5, 5, 3, 3, 0, 0], 'run 2 starts once run 1 is out');
  // every run goes street by street: flop, turn, river
  const at = R.steps.indexOf(runs[0]);
  assert.deepEqual(R.steps.slice(at, at + 3).map((x) => x.cuts.slice(0, 2)), [[3, 3], [4, 4], [5, 5]]);
  assert.deepEqual(R.steps.slice(at, at + 9).map((x) => x.street), ['flop', 'turn', 'river', 'flop', 'turn', 'river', 'flop', 'turn', 'river']);
});

test('a bomb pot starts on the flop; a hand checked down deals every street', () => {
  const rec = play(hand(3, { bomb: 20 }), []);
  const R = buildReplay(rec, (a) => `$${a}`);
  checkSteps(rec, R);
  assert.equal(R.steps[0].text, 'Bomb pot: everyone antes $20');
  assert.equal(R.steps[0].pot, 60);
  assert.equal(R.steps[1].dealt, 'flop');
  assert.deepEqual(R.steps.filter((s) => s.dealt).map((s) => s.dealt), ['flop', 'turn', 'river']);
  // a short stack all in for the blind
  const short = play(hand(3, { stacks: [1000, 3, 1000] }), [['p0', 'call'], ['p2', 'check']]);
  checkSteps(short, buildReplay(short));
  assert.ok(!canReplay({ players: [] }), 'hands recorded before actions were kept cannot be replayed');
});
