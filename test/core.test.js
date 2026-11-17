import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score5, bestHand, handName } from '../shared/evaluator.js';
import { CANONICAL_DECK } from '../shared/cards.js';
import {
  buildEntropy, deriveDeckSync, deriveDeckAsync, webCryptoAdapter, reconstructDeal, uniformInt,
  verifyHandRecord, bombMessage, rollFromBlock,
} from '../shared/fairness.js';
import { hmacSync, sha256Hex, newServerSeed } from '../server/fair-node.js';

const s = (str) => str.split(' ');

test('category ordering', () => {
  const hands = [
    'Ah Kh Qh Jh Th', // royal
    '9s 8s 7s 6s 5s', // straight flush
    '5d 4d 3d 2d Ad', // steel wheel
    'Kc Kd Kh Ks 2c', // quads
    'Qc Qd Qh 2s 2c', // full house
    'Ac Jc 8c 4c 2c', // flush
    'Tc 9d 8h 7s 6c', // straight
    '5c 4d 3h 2s Ac', // wheel
    '7c 7d 7h Ks 2c', // trips
    'Jc Jd 4h 4s Ac', // two pair
    'Tc Td Ah 8s 3c', // pair
    'Ac Qd 9h 6s 3c', // high card
  ].map((h) => score5(s(h)));
  for (let i = 1; i < hands.length; i++) assert.ok(hands[i - 1] > hands[i], `hand ${i - 1} should beat ${i}`);
});

test('kickers and names', () => {
  assert.ok(score5(s('Ac Ad Kh 7s 2c')) > score5(s('As Ah Qh Js Tc')));
  assert.ok(score5(s('9c 9d 4h 4s Ac')) > score5(s('9h 9s 4c 4d Kc')));
  assert.equal(score5(s('9c 9d 4h 4s Ac')), score5(s('9h 9s 4c 4d Ah')));
  assert.equal(handName(score5(s('Ah Kh Qh Jh Th'))), 'Royal Flush');
  assert.equal(handName(score5(s('5c 4d 3h 2s Ac'))), 'Straight, Five high');
  assert.equal(handName(score5(s('Qc Qd Qh 2s 2c'))), 'Full House, Queens full of Twos');
  assert.equal(handName(score5(s('Jc Jd 4h 4s Ac'))), 'Two Pair, Jacks and Fours');
  assert.equal(handName(score5(s('Tc Td Ah 8s 3c'))), 'Pair of Tens');
  assert.equal(handName(score5(s('Ac Qd 9h 6s 3c'))), 'Ace High');
});

test("hold'em best of seven", () => {
  const r = bestHand(s('Ah Kh'), s('Qh Jh Th 2c 3d'), false);
  assert.equal(r.name, 'Royal Flush');
  const r2 = bestHand(s('2c 3d'), s('As Ks Qs Js 9s'), false); // board flush, holes irrelevant
  assert.equal(r2.name, 'Flush, Ace high');
  const r3 = bestHand(s('7c 7d'), s('7h 7s Kd 2c 3d'), false);
  assert.equal(r3.name, 'Four of a Kind, Sevens');
});

test('omaha uses exactly two hole cards', () => {
  // four hearts on board, one heart in hand: no flush in Omaha
  const r = bestHand(s('Ah Kc Qd Js'), s('2h 5h 8h 9h Tc'), true);
  assert.notEqual(r.category, 5);
  // board straight is not usable without two hole cards
  const r2 = bestHand(s('Ac Ad 2s 2d'), s('5c 6d 7h 8s 9c'), true);
  assert.equal(r2.name, 'Pair of Aces');
  // two hole hearts + three board hearts = flush
  const r3 = bestHand(s('Ah Kh Qd Js'), s('2h 5h 8h 9c Tc'), true);
  assert.equal(r3.name, 'Flush, Ace high');
  // PLO5
  const r4 = bestHand(s('Ah Kh Qd Js 2c'), s('Ac Ad 8h 9c Tc'), true);
  assert.equal(r4.name, 'Straight, Queen high'); // Q J + 8 9 T beats A + A A
  const r5 = bestHand(s('Ah Kh 5d 4s 2c'), s('Ac Ad 8h 9c Tc'), true);
  assert.equal(r5.name, 'Three of a Kind, Aces');
});

test('server (node:crypto) and browser (WebCrypto) produce the identical deck', async () => {
  const wc = webCryptoAdapter();
  for (let i = 0; i < 25; i++) {
    const seed = newServerSeed();
    const entropy = buildEntropy('tbl' + i, i + 1, ['a1b2c3d4e5f60718', 'ffeeddccbbaa9988' + i.toString(16).padStart(2, '0')]);
    const a = deriveDeckSync(hmacSync, seed, entropy);
    const b = await deriveDeckAsync(wc.hmac, seed, entropy);
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, 52);
    assert.equal(await wc.sha256Hex(seed), sha256Hex(seed));
    assert.equal(rollFromBlock(hmacSync(seed, bombMessage(entropy))), rollFromBlock(await wc.hmac(seed, bombMessage(entropy))));
  }
});

test('entropy is independent of contribution order', () => {
  assert.equal(buildEntropy('t', 3, ['bb', 'aa', 'cc']), buildEntropy('t', 3, ['cc', 'bb', 'aa']));
});

test('shuffle is uniform enough (first card chi-square)', () => {
  const counts = new Map(CANONICAL_DECK.map((c) => [c, 0]));
  const N = 26000;
  const seed = newServerSeed();
  for (let i = 0; i < N; i++) {
    const deck = deriveDeckSync(hmacSync, seed, 'x|' + i);
    counts.set(deck[0], counts.get(deck[0]) + 1);
  }
  const exp = N / 52;
  let chi = 0;
  for (const v of counts.values()) chi += ((v - exp) ** 2) / exp;
  // 51 degrees of freedom: p=0.001 critical value about 87
  assert.ok(chi < 87, 'chi-square ' + chi);
});

test('uniformInt rejection sampling stays in range', () => {
  let x = 0;
  const next = () => { x = (x + 2654435761) >>> 0; return x; };
  for (let n = 1; n < 60; n++) for (let k = 0; k < 50; k++) { const v = uniformInt(next, n); assert.ok(v >= 0 && v < n); }
});

test('deal reconstruction and full verification', async () => {
  const wc = webCryptoAdapter();
  const serverSeed = newServerSeed();
  const seeds = ['0123456789abcdef', 'fedcba9876543210'];
  const entropy = buildEntropy('T1', 7, seeds);
  const deck = deriveDeckSync(hmacSync, serverSeed, entropy);
  // 3 players, PLO4, all-in on the flop, run twice
  const dealOrder = [4, 0, 2];
  const holes = { 4: [], 0: [], 2: [] };
  let p = 0;
  for (let r = 0; r < 4; r++) for (const seat of dealOrder) holes[seat].push(deck[p++]);
  const flop = deck.slice(p, p + 3); p += 3;
  const run1 = flop.concat(deck.slice(p, p + 2)); p += 2;
  const run2 = flop.concat(deck.slice(p, p + 2)); p += 2;
  const record = {
    tableId: 'T1', handNumber: 7,
    fairness: { serverSeed, commitment: sha256Hex(serverSeed), entropy, contributions: seeds.map((seed, i) => ({ seat: i, seed })), deck },
    dealt: { dealOrder, holeCount: 4, sharedCount: 3, boards: [run1, run2], holes },
  };
  const rebuilt = reconstructDeal(deck, record.dealt);
  assert.deepEqual(rebuilt.boards, [run1, run2]);
  const res = await verifyHandRecord(record, wc, { commitment: sha256Hex(serverSeed), mySeed: seeds[0], mySeat: 0, myHole: holes[0], boards: [flop] });
  assert.ok(res.ok, JSON.stringify(res.checks, null, 1));
  // tamper: swap a board card
  const bad = structuredClone(record);
  bad.dealt.boards[1][4] = run1[4];
  const res2 = await verifyHandRecord(bad, wc);
  assert.equal(res2.ok, false);
  // tamper: different seed
  const bad2 = structuredClone(record);
  bad2.fairness.serverSeed = newServerSeed();
  assert.equal((await verifyHandRecord(bad2, wc)).ok, false);
});
