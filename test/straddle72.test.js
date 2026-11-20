// The straddle and the 7-2 game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hand } from '../server/engine/hand.js';
import { Table, sanitizeSettings } from '../server/table.js';
import { CANONICAL_DECK } from '../shared/cards.js';
import { buildReplay } from '../shared/replay.js';

const stacked = (top) => top.concat(CANONICAL_DECK.filter((c) => !top.includes(c)));
function hand(seats, opts = {}) {
  return new Hand({
    number: 1, gameType: opts.gameType || 'nlh', smallBlind: 5, bigBlind: 10, buttonSeat: opts.button ?? seats[0],
    deck: opts.deck || CANONICAL_DECK.slice(), bombAnte: opts.bombAnte || 0, straddleIds: opts.straddleIds || [],
    players: seats.map((s) => ({ id: 'p' + s, seat: s, name: 'P' + s, stack: (opts.stacks && opts.stacks[s]) ?? 1000 })),
  });
}
const playOut = (h, pick = () => null) => {
  for (let g = 0; g < 200 && h.phase !== 'done'; g++) {
    if (h.phase === 'betting') {
      const a = h.actor();
      const L = h.legalActions(a.id);
      h.act(a.id, pick(a, L) || { type: L.canCheck ? 'check' : 'call' });
    } else h.advance();
  }
};

test('a straddle: under the gun posts twice the big blind, action starts after them and they get the option', () => {
  const h = hand([0, 1, 2, 3], { button: 0, straddleIds: ['p3'] });
  h.start();
  const st = h.byId('p3');
  assert.equal(st.bet, 20, 'the straddle is twice the big blind');
  assert.equal(st.lastAction, 'Straddle');
  assert.equal(h.currentBet, 20);
  assert.equal(h.publicState('p0').straddleSeat, 3);
  assert.equal(h.actor().id, 'p0', 'the player after the straddle acts first');
  assert.equal(h.legalActions('p0').minTo, 40, 'a raise has to go to at least twice the straddle');
  h.act('p0', { type: 'call' });
  h.act('p1', { type: 'call' });
  h.act('p2', { type: 'call' });
  assert.equal(h.actor().id, 'p3', 'the straddler acts last before the flop');
  const L = h.legalActions('p3');
  assert.ok(L.canCheck && L.canRaise, 'with the option to check or raise');
  h.act('p3', { type: 'check' });
  for (let g = 0; g < 5 && h.phase === 'pending'; g++) h.advance();
  assert.equal(h.street, 'flop');
  assert.equal(h.actor().id, 'p1', 'after the flop the small blind acts first as usual');
  assert.ok(h.posts.some((x) => x.a === 'st' && x.amt === 20));
  playOut(h);
  const rec = { ...h.recordData(), handNumber: 1, players: h.recordData().players.map((p) => ({ ...p, userId: p.id })) };
  const steps = buildReplay(rec);
  assert.ok(steps.steps.some((x) => /straddles 20/.test(x.text || '')), 'the replayer says who straddled');
});

test('no straddle heads-up, from a short stack, in a bomb pot, or when not asked for', () => {
  const two = hand([0, 1], { button: 0, straddleIds: ['p0', 'p1'] });
  two.start();
  assert.equal(two.currentBet, 10);
  assert.equal(two.straddleIdx, null);
  const short = hand([0, 1, 2, 3], { button: 0, straddleIds: ['p3'], stacks: { 3: 20 } });
  short.start();
  assert.equal(short.byId('p3').bet, 0, 'only with more than the straddle behind');
  assert.equal(short.currentBet, 10);
  const bomb = hand([0, 1, 2, 3], { button: 0, straddleIds: ['p3'], bombAnte: 20 });
  bomb.start();
  assert.equal(bomb.straddleIdx, null);
  const nobody = hand([0, 1, 2, 3], { button: 0, straddleIds: ['p1'] });
  nobody.start();
  assert.equal(nobody.straddleIdx, null, 'it is for the player under the gun only');
  assert.equal(sanitizeSettings({ straddle: true }).straddle, true);
});

// The bounty is worked out on the table; these call its two methods on a small stand-in for it.
function table(sevenDeuce, h) {
  const logs = [];
  const t = {
    settings: { sevenDeuce }, logs, fmt: String, log: (text) => logs.push(text),
    players: new Map(h.players.map((p) => [p.id, { userId: p.id, stack: p.stack }])),
    sevenDeuceWinner: Table.prototype.sevenDeuceWinner,
  };
  const rec = { players: h.players.map((p) => ({ userId: p.id, endStack: p.stack, net: p.stack - p.startStack })) };
  return { t, rec, pay: () => Table.prototype.paySevenDeuce.call(t, h, rec) };
}
// button seat 0, three players: hole cards go to seats 1, 2, 0, then again; the board follows
const SEVEN_DEUCE = stacked(['Ac', '3c', '7h', 'Ad', '4c', '2c', '7s', '7d', '2d', 'Ks', '9h']);

test('the 7-2 game: winning a shown 7-2 at showdown collects the bounty from everyone else dealt in', () => {
  const h = hand([0, 1, 2], { button: 0, deck: SEVEN_DEUCE, stacks: { 2: 1030 } });
  h.start();
  playOut(h);
  assert.deepEqual(h.results.payouts.map((p) => p.id), ['p0'], 'seat 0 wins with sevens full of deuces');
  const { t, rec, pay } = table(50, h);
  const before = [...t.players.values()].map((p) => p.stack);
  const paid = pay();
  assert.ok(paid, 'paid at the end of the hand, the cards having been shown');
  assert.equal(t.players.get('p0').stack, before[0] + 100);
  assert.equal(t.players.get('p1').stack, before[1] - 50);
  assert.equal(rec.bounty.total, 100);
  assert.equal(rec.players.find((p) => p.userId === 'p0').net, h.byId('p0').stack - 1000 + 100, 'the hand record counts the bounty');
  assert.match(t.logs[0], /P0 won with 7-2 and collects the 50 bounty from 2 players: 100/);
  assert.equal(pay(), null, 'only once a hand');
});

test('the 7-2 game: won without a showdown, the bounty waits until both cards are shown', () => {
  const h = hand([0, 1, 2], { button: 0, deck: SEVEN_DEUCE, stacks: { 1: 1000, 2: 1000 } });
  h.start();
  // seat 0, under the gun three-handed, raises and the blinds fold
  playOut(h, (a) => (a.id === 'p0' ? { type: 'raise', to: 40 } : { type: 'fold' }));
  assert.ok(h.results.uncontested);
  const { t, rec, pay } = table(50, h);
  t.players.get('p2').stack = 30;
  assert.equal(pay(), null, 'nothing until the cards are shown');
  h.showCards('p0', [0]);
  assert.equal(pay(), null, 'one card is not enough');
  h.showCards('p0', null);
  const paid = pay();
  assert.ok(paid);
  assert.equal(rec.bounty.payers.find((x) => x.userId === 'p2').amount, 30, 'nobody pays more than they have');
  assert.equal(rec.bounty.total, 80);
});

test('the 7-2 game: off, in Omaha, or with no 7-2 winning, nobody collects', () => {
  const h = hand([0, 1, 2], { button: 0, deck: SEVEN_DEUCE });
  h.start();
  playOut(h);
  assert.equal(table(0, h).pay(), null, 'the game is off');
  const plo = hand([0, 1, 2], { button: 0, gameType: 'plo4' });
  plo.start();
  playOut(plo);
  assert.equal(table(50, plo).pay(), null, 'Hold’em only');
  const plain = hand([0, 1, 2], { button: 0 });
  plain.start();
  playOut(plain);
  assert.equal(table(50, plain).pay(), null, 'a hand won without 7-2');
  assert.equal(sanitizeSettings({ sevenDeuce: 500 }).sevenDeuce, 500);
});

test('a double board hand, bomb pot or not, runs once: no vote to run it again', () => {
  const players = (stack) => [0, 1, 2].map((s) => ({ id: 'p' + s, seat: s, name: 'P' + s, stack }));
  for (const bombAnte of [0, 20]) {
    const h = new Hand({ number: 1, gameType: 'nlh', smallBlind: 5, bigBlind: 10, buttonSeat: 0, deck: CANONICAL_DECK.slice(), bombAnte, ritMax: 4, doubleBoard: true, players: players(200) });
    h.start();
    assert.equal(h.ritMax, 1);
    for (let g = 0; g < 200 && h.phase !== 'done'; g++) {
      assert.notEqual(h.phase, 'rit', 'never asked how many times to run it');
      if (h.phase === 'betting') {
        const a = h.actor();
        const L = h.legalActions(a.id);
        h.act(a.id, L.canRaise ? { type: 'allin' } : { type: 'call' });
      } else h.advance();
    }
    assert.equal(h.runCount, 1);
    assert.equal(h.boards.length, 2, 'the two boards, once');
  }
  const single = new Hand({ number: 1, gameType: 'nlh', smallBlind: 5, bigBlind: 10, buttonSeat: 0, deck: CANONICAL_DECK.slice(), ritMax: 3, players: players(200) });
  assert.equal(single.ritMax, 3, 'one board still runs up to the table setting');
});
