import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hand } from '../server/engine/hand.js';
import { deriveDeckSync } from '../shared/fairness.js';
import { hmacSync } from '../server/fair-node.js';
import { handLines, aggregate, summarize } from '../server/stats.js';

function hand(n, { button = 0, bomb = 0, seed = 'stats' } = {}) {
  return new Hand({
    number: 1, gameType: 'nlh', smallBlind: 5, bigBlind: 10, buttonSeat: button, bombAnte: bomb,
    deck: deriveDeckSync(hmacSync, seed, 'x'),
    players: Array.from({ length: n }, (_, i) => ({ id: 'p' + i, seat: i, name: 'P' + i, stack: 1000 })),
  });
}

// Plays the given actions in order, dealing the next street whenever betting closes. After the
// script, everyone left checks (or folds) to the end.
function play(h, steps) {
  if (!h.started) { h.start(); h.started = true; }
  for (const [id, type, to] of steps) {
    while (h.phase === 'pending') h.advance();
    assert.equal(h.actor()?.id, id, `expected ${id} to act`);
    h.act(id, { type, to });
  }
  for (let guard = 0; h.phase !== 'done' && guard < 200; guard++) {
    if (h.phase === 'betting') {
      const a = h.actor();
      const l = h.legalActions(a.id);
      h.act(a.id, { type: l.canCheck ? 'check' : 'fold' });
    } else h.advance();
  }
  assert.equal(h.phase, 'done');
  return handLines({ ...h.recordData(), startedAt: 1 }).players;
}

test('preflop: VPIP, PFR, steals, 3-bets, folds to 3-bets; flop c-bets and folds to them', () => {
  // six handed, button p0: SB p1, BB p2, UTG p3, HJ p4, CO p5
  const P = play(hand(6), [
    ['p3', 'fold'], ['p4', 'fold'],
    ['p5', 'raise', 25], // the cutoff opens when it is folded to them: a steal attempt
    ['p0', 'raise', 75], // the button 3-bets
    ['p1', 'fold'], ['p2', 'fold'],
    ['p5', 'call'], // the opener calls the 3-bet
    ['p5', 'check'], ['p0', 'bet', 100], // flop: the 3-bettor c-bets
    ['p5', 'fold'],
  ]);
  assert.deepEqual([P.p3.pfOpp, P.p3.vpip, P.p3.stOpp], [1, 0, 0], 'UTG folded: an opportunity, no VPIP, not a steal seat');
  assert.deepEqual([P.p5.stOpp, P.p5.st, P.p5.vpip, P.p5.pfr], [1, 1, 1, 1]);
  assert.deepEqual([P.p5.f3Opp, P.p5.f3], [1, 0], 'faced a 3-bet and called');
  assert.deepEqual([P.p0.tbOpp, P.p0.tb, P.p0.stOpp], [1, 1, 0]);
  assert.deepEqual([P.p1.fsOpp, P.p2.fsOpp], [0, 0], 'the steal was already answered by a 3-bet');
  assert.deepEqual([P.p0.cbOpp, P.p0.cb, P.p0.agg], [1, 1, 1]);
  assert.deepEqual([P.p5.fcbOpp, P.p5.fcb, P.p5.folds], [1, 1, 1], 'checked, then folded to the c-bet');
  assert.deepEqual([P.p0.sawFlop, P.p5.sawFlop, P.p1.sawFlop], [1, 1, 0]);
  assert.deepEqual([P.p0.wtsd, P.p0.won, P.p0.wwsf], [0, 1, 1], 'won without a showdown');
  assert.equal(P.p5.net, -75);
  assert.equal(P.p0.net, 75 + 5 + 10);
});

test('blinds facing a steal, a called c-bet, and a showdown', () => {
  // four handed, button p0: SB p1, BB p2, CO p3
  const P = play(hand(4, { seed: 'sd' }), [
    ['p3', 'fold'],
    ['p0', 'raise', 25], // button steal
    ['p1', 'fold'], // small blind folds to the steal
    ['p2', 'call'], // big blind defends
    ['p2', 'check'], ['p0', 'bet', 30], ['p2', 'call'], // flop c-bet called
    ['p2', 'check'], ['p0', 'check'],
    ['p2', 'bet', 50], ['p0', 'call'], // river
  ]);
  assert.deepEqual([P.p0.stOpp, P.p0.st], [1, 1]);
  assert.deepEqual([P.p3.stOpp, P.p3.st], [1, 0], 'the cutoff was a steal seat and folded');
  assert.deepEqual([P.p1.fsOpp, P.p1.fs], [1, 1]);
  assert.deepEqual([P.p2.fsOpp, P.p2.fs, P.p2.vpip], [1, 0, 1]);
  assert.deepEqual([P.p2.fcbOpp, P.p2.fcb], [1, 0]);
  assert.deepEqual([P.p0.agg, P.p0.calls, P.p2.agg, P.p2.calls], [1, 1, 1, 1]);
  assert.deepEqual([P.p0.wtsd, P.p2.wtsd], [1, 1]);
  assert.equal(P.p0.wsd + P.p2.wsd >= 1, true, 'someone won at showdown');
  assert.equal(P.p0.wsd, P.p0.won);
});

test('bomb pots skip preflop stats; everyone sees the flop', () => {
  const P = play(hand(3, { bomb: 20 }), []);
  for (const id of ['p0', 'p1', 'p2']) {
    assert.equal(P[id].pfOpp, 0);
    assert.equal(P[id].sawFlop, 1);
  }
});

test('adding up: percentages, aggression factor, bb/100, and game filters', () => {
  const a = play(hand(4, { seed: 'a' }), [['p3', 'raise', 30], ['p0', 'fold'], ['p1', 'fold'], ['p2', 'fold']]);
  const b = play(hand(4, { seed: 'b', button: 1 }), [['p0', 'call'], ['p1', 'fold'], ['p2', 'call'], ['p3', 'check']]);
  const lines = [{ gameType: 'nlh', players: a }, { gameType: 'nlh', players: b }, { gameType: 'plo4', players: a }];
  const t = summarize(aggregate(lines, 'nlh').get('p3'));
  assert.equal(t.hands, 2);
  assert.equal(t.vpip, 50, 'raised one hand, checked the big blind in the other');
  assert.equal(t.pfr, 50);
  assert.equal(aggregate(lines, 'plo4').get('p3').h, 1);
  assert.equal(aggregate(lines, 'all').get('p3').h, 3);
  const legacy = handLines({ gameType: 'nlh', bigBlind: 10, players: [{ id: 'x', seat: 0, startStack: 100, endStack: 150 }], results: { payouts: [{ id: 'x', amount: 50 }] } });
  assert.deepEqual([legacy.players.x.h, legacy.players.x.net, legacy.players.x.pfOpp], [1, 50, 0], 'old hands count toward results only');
  assert.equal(summarize(aggregate([legacy]).get('x')).bb100, 500);
});
