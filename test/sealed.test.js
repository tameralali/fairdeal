// Version 2 dealing: every card sealed on its own, so a hand can be checked while folded cards stay
// hidden for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hand } from '../server/engine/hand.js';
import { newCommitment, settleCommitment, openV2 } from '../server/fair-node.js';
import { verifyHandRecord, webCryptoAdapter, FAIRNESS_V2 } from '../shared/fairness.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const wc = webCryptoAdapter();

// Plays a three-handed hand on a v2 sealed deck: p0 folds preflop, p1 and p2 check it down.
function playSealed() {
  const pend = newCommitment(5, FAIRNESS_V2);
  for (const [i, seed] of ['a1b2c3d4e5f60718', '9988776655443322', '00112233445566ff'].entries()) pend.contributions.set('p' + i, { userId: 'p' + i, seat: i, seed });
  const settled = settleCommitment('TBL', pend);
  const h = new Hand({
    number: 5, gameType: 'plo4', smallBlind: 5, bigBlind: 10, buttonSeat: 0, deck: settled.deck,
    players: [0, 1, 2].map((i) => ({ id: 'p' + i, seat: i, name: 'P' + i, stack: 1000 })),
  });
  h.start();
  h.act('p0', { type: 'fold' });
  for (let g = 0; h.phase !== 'done' && g < 100; g++) {
    if (h.phase === 'betting') { const a = h.actor(); h.act(a.id, { type: h.legalActions(a.id).canCheck ? 'check' : 'call' }); } else h.advance();
  }
  const d = h.recordData();
  const holes = Object.fromEntries(d.players.map((p) => [p.seat, p.hole]));
  return { pend, settled, d, holes };
}

// The record as a viewer sees it: shown cards (p1 and p2 at showdown), the viewer's own cards opened privately.
function viewFor({ pend, settled, d, holes }, viewerSeat, shown = { 1: [0, 1, 2, 3], 2: [0, 1, 2, 3] }) {
  const open = openV2(pend.serverSeed, pend.v2.key, settled.entropy, d.dealt, shown, viewerSeat);
  const visible = {};
  for (const [seat, idxs] of Object.entries(shown)) visible[seat] = holes[seat].map((c, k) => (idxs.includes(k) ? c : null));
  return {
    tableId: 'TBL', handNumber: 5, isBomb: false,
    fairness: {
      version: FAIRNESS_V2, commitment: pend.commitment, key: pend.v2.key, entropy: settled.entropy,
      contributions: [...pend.contributions.values()].map((c) => ({ seat: c.seat, seed: c.seed })), ...open,
    },
    dealt: { ...d.dealt, holes: visible },
  };
}

test('a sealed hand checks out for every player while the folded cards stay hidden', async () => {
  const hand = playSealed();
  const folded = hand.holes[0];
  // the player who folded checks their own cards privately
  const mine = viewFor(hand, 0);
  const res = await verifyHandRecord(mine, wc, { commitment: hand.pend.commitment, mySeed: 'a1b2c3d4e5f60718', mySeat: 0, myHole: folded, boards: mine.dealt.boards });
  assert.ok(res.ok, JSON.stringify(res.checks.filter((c) => !c.ok)));
  assert.equal(res.hidden, 0, 'nothing is hidden from the player themself');
  // another player's copy of the record never contains the folded cards
  const theirs = viewFor(hand, 1);
  const text = JSON.stringify(theirs);
  for (const c of folded) assert.ok(!text.includes(`"${c}"`), `folded ${c} is not in the record`);
  assert.ok(!text.includes(hand.pend.serverSeed), 'the seed never leaves the server');
  const res1 = await verifyHandRecord(theirs, wc, { mySeat: 1, myHole: hand.holes[1] });
  assert.ok(res1.ok, JSON.stringify(res1.checks.filter((c) => !c.ok)));
  assert.equal(res1.hidden, 4, 'the four folded cards stay sealed');
  // a spectator checks the boards and the shown hands
  const spec = viewFor(hand, null);
  const res2 = await verifyHandRecord(spec, wc, {});
  assert.ok(res2.ok);
});

test('a moved card, a swapped seal or a changed key fails the check; partial shows open only those cards', async () => {
  const hand = playSealed();
  const rec = viewFor(hand, 1);
  const moved = structuredClone(rec);
  [moved.dealt.boards[0][0], moved.dealt.boards[0][1]] = [moved.dealt.boards[0][1], moved.dealt.boards[0][0]];
  assert.equal((await verifyHandRecord(moved, wc)).ok, false);
  const reseal = structuredClone(rec);
  const k = Object.keys(reseal.fairness.sealed)[0];
  reseal.fairness.sealed[k] = 'f'.repeat(64);
  assert.equal((await verifyHandRecord(reseal, wc)).ok, false, 'a sealed card cannot be swapped');
  const lie = structuredClone(rec);
  lie.fairness.openings[0].c = lie.fairness.openings[0].c === 'As' ? 'Ks' : 'As';
  assert.equal((await verifyHandRecord(lie, wc)).ok, false, 'an opening cannot name another card');
  const rekey = structuredClone(rec);
  rekey.fairness.key = 'ab'.repeat(32);
  assert.equal((await verifyHandRecord(rekey, wc)).ok, false);
  // p0 shows two of their four folded cards after the hand
  const partial = viewFor(hand, 2, { 0: [1, 3], 1: [0, 1, 2, 3], 2: [0, 1, 2, 3] });
  const text = JSON.stringify(partial);
  assert.ok(text.includes(`"${hand.holes[0][1]}"`) && text.includes(`"${hand.holes[0][3]}"`));
  assert.ok(!text.includes(`"${hand.holes[0][0]}"`) && !text.includes(`"${hand.holes[0][2]}"`));
  const res = await verifyHandRecord(partial, wc);
  assert.ok(res.ok, JSON.stringify(res.checks.filter((c) => !c.ok)));
  assert.equal(res.hidden, 2);
  const fake = structuredClone(partial);
  fake.dealt.holes[0][1] = hand.holes[0][0];
  assert.equal((await verifyHandRecord(fake, wc)).ok, false, 'a shown card has to be the one dealt there');
});

test('the command-line checker passes a downloaded hand and fails a changed one or a wrong seal', () => {
  const hand = playSealed();
  const rec = viewFor(hand, 1);
  const dir = mkdtempSync(path.join(tmpdir(), 'aq-verify-'));
  const run = (file, ...extra) => spawnSync(process.execPath, ['scripts/verify-hand.js', file, ...extra], { encoding: 'utf8' });
  const good = path.join(dir, 'hand.json');
  writeFileSync(good, JSON.stringify(rec));
  let r = run(good);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /The hand passed every check/);
  assert.match(r.stdout, /\?\? \?\? \?\? \?\?/, 'the folded cards show as sealed');
  r = run(good, '--seal', hand.pend.commitment.toUpperCase());
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /\u2713 Commitment matches the fingerprint you copied before the deal/);
  r = run(good, '--seal', 'ab'.repeat(32));
  assert.equal(r.status, 1, 'a different seal fails');
  // the same cards opened in different places
  const moved = structuredClone(rec);
  const [a, b] = moved.fairness.openings;
  [a.c, b.c] = [b.c, a.c];
  const bad = path.join(dir, 'moved.json');
  writeFileSync(bad, JSON.stringify({ record: moved }));
  r = run(bad);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /\u2717 The opened cards and sealed cards rebuild the commitment/);
  assert.equal(run(path.join(dir, 'missing.json')).status, 2);
});
