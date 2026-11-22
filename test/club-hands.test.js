// The list of every hand in the club: one summary per hand kept with the stats, amounts in cents,
// and for each viewer only the hole cards they may see (their own, shown ones, every card once the
// game opens its deck). A hand that changes after it ended (cards shown, a 7-2 bounty) is updated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handSummary, handView, StatsBook } from '../server/stats.js';

const rec = (over = {}) => ({
  handNumber: 3, startedAt: 1000, gameType: 'nlh', isBomb: false, doubleBoard: false, runCount: 2, decimals: 0,
  players: [
    { seat: 0, userId: 'ann', name: 'Ann', startStack: 100, endStack: 160, shown: true, showIdx: [0, 1] },
    { seat: 1, userId: 'ben', name: 'Ben', startStack: 100, endStack: 40, shown: false, showIdx: [1] },
    { seat: 2, userId: 'cy', name: 'Cy', startStack: 100, endStack: 100, shown: false, showIdx: [] },
  ],
  dealt: { holes: { 0: ['As', 'Kd'], 1: ['7c', '2h'], 2: ['Qs', 'Qh'] } },
  results: { uncontested: false, pots: [{ amount: 100 }, { amount: 20 }] },
  actions: [{ s: 'preflop', id: 'ann', a: 'raise', allIn: true }],
  posts: [{ id: 'ben', a: 'sb' }, { id: 'cy', a: 'bb' }, { id: 'ann', a: 'st' }],
  fairness: { version: 'aquarium-v1' },
  ...over,
});

test('a hand played in whole chips is summed up in cents, a chip counting as a dollar', () => {
  const s = handSummary(rec(), 100);
  assert.equal(s.pot, 12000);
  assert.deepEqual(s.players.map((p) => p.net), [6000, -6000, 0]);
  assert.equal(s.runCount, 2);
  assert.equal(s.straddle, true);
  assert.equal(s.allIn, true);
  assert.equal(s.showdown, true);
  assert.equal(s.sealed, false);
  const c = handSummary(rec({ decimals: 2 }), 1);
  assert.equal(c.pot, 120, 'hands in cents stay as they are');
});

test('each viewer gets their own cards and shown ones, every card once the deck is open', () => {
  const s = handSummary(rec(), 1);
  const cy = handView(s, 't1', 'cy', false);
  assert.deepEqual(cy.cards, { ann: ['As', 'Kd'], ben: [null, '2h'], cy: ['Qs', 'Qh'] }, 'Ben showed one card');
  assert.equal(cy.revealed, false);
  assert.equal(cy.tableId, 't1');
  assert.deepEqual(cy.nets, { ann: 60, ben: -60, cy: 0 });
  const ben = handView(s, 't1', 'ben', false);
  assert.deepEqual(Object.keys(ben.cards).sort(), ['ann', 'ben'], 'Cy folded and showed nothing');
  assert.deepEqual(ben.cards.ben, ['7c', '2h'], 'your own cards, all of them');
  const open = handView(s, 't1', 'ben', true);
  assert.deepEqual(open.cards, { ann: ['As', 'Kd'], ben: ['7c', '2h'], cy: ['Qs', 'Qh'] });
  assert.equal(open.revealed, true);
  // sealed hands keep folded cards for good, and count as checked straight away
  const sealed = handView(handSummary(rec({ fairness: { version: 'aquarium-v2' } }), 1), 't1', 'ben', false);
  assert.equal(sealed.cards.cy, undefined);
  assert.equal(sealed.revealed, true);
});

test('a hand that changes after it ended is summed up again', () => {
  const r = rec({ decimals: 2 });
  const table = { id: 't1', decimals: 2, records: [r], store: { readHands: () => [r] } };
  const book = new StatsBook();
  assert.equal(handView(book.summariesFor(table)[0], 't1', 'ben', false).cards.cy, undefined);
  assert.equal(book.entry(table).names.get('cy'), 'Cy');
  // Cy shows both cards, and a bounty moves money after the hand
  r.players[2].shown = true;
  r.players[2].endStack = 110;
  r.players[1].endStack = 30;
  const v = book.version;
  book.changed(table, r);
  assert.ok(book.version > v);
  const s = book.summariesFor(table)[0];
  assert.deepEqual(handView(s, 't1', 'ben', false).cards.cy, ['Qs', 'Qh']);
  assert.deepEqual(s.players.map((p) => p.net), [60, -70, 10]);
  assert.equal(book.linesFor(table)[0].players.cy.net, 10, 'the results count it too');
  // a new hand is added to what is kept, the rest stays
  table.records.push(rec({ handNumber: 4, decimals: 2 }));
  assert.equal(book.summariesFor(table).length, 2);
  assert.equal(book.summariesFor(table)[0], s);
});
