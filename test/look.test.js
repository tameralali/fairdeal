// The table's look: all-in chances, hand labels, the bomb pot size only mattering with bomb pots on,
// and the old default felt moving to the new one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { equity } from '../shared/equity.js';
import { bestHand } from '../shared/evaluator.js';
import { shortHandName } from '../public/js/cards.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../server/table.js';
import { createServer } from '../server/index.js';

const pct = (m) => Object.fromEntries([...m].map(([k, v]) => [k, Math.round(v * 10) / 10]));

test('all-in chances: a made flush against two pair on the turn, and folded cards stay unknown', () => {
  const hands = [{ seat: 3, hole: ['5h', 'Qc', '9s', '4h'] }, { seat: 4, hole: ['As', 'Ts', 'Jc', 'Td'] }];
  // two pair needs one of four cards (4c 4d 5c 5d) from the 40 nobody has seen
  assert.deepEqual(pct(equity(hands, [['4s', '8s', '5s', '3d']], true)), { 3: 10, 4: 90 });
  // a folded hand the viewer saw is out of the deck: 4 outs from 36
  assert.deepEqual(pct(equity(hands, [['4s', '8s', '5s', '3d']], true, ['Kd', '7c', '2h', '6c'])), { 3: 11.1, 4: 88.9 });
  // the river is out: whoever is ahead has all of it
  assert.deepEqual(pct(equity(hands, [['4s', '8s', '5s', '3d', '2c']], true)), { 3: 0, 4: 100 });
});

test('all-in chances: ties split, two boards share the pot, and a sample stays the same between redraws', () => {
  const chop = equity([{ seat: 0, hole: ['Ah', 'Kd'] }, { seat: 1, hole: ['As', 'Kc'] }], [['Qh', 'Jd', 'Ts', '2c', '3h']], false);
  assert.deepEqual(pct(chop), { 0: 50, 1: 50 });
  // one board each: seat 0 wins board 1, seat 1 wins board 2
  const split = equity([{ seat: 0, hole: ['Ah', 'Ad'] }, { seat: 1, hole: ['Kh', 'Kd'] }], [['As', '7c', '2d', '9h', '3s'], ['Ks', '8c', '4d', 'Jh', '5s']], false);
  assert.deepEqual(pct(split), { 0: 50, 1: 50 });
  const pre = [{ seat: 1, hole: ['Ah', 'Ad'] }, { seat: 2, hole: ['Kc', 'Ks'] }];
  const a = equity(pre, [[]], false);
  const b = equity(pre.map((h) => ({ ...h })), [[]], false);
  assert.deepEqual(pct(a), pct(b));
  assert.ok(a.get(1) > 76 && a.get(1) < 87, `aces against kings ${a.get(1)}`);
});

test('hand labels on the table', () => {
  const name = (hole, board, omaha = false) => shortHandName(bestHand(hole, board, omaha).score);
  assert.equal(name(['5h', 'Qc', '9s', '4h'], ['4s', '8s', '5s', '3d', 'Kc'], true), 'Two pair (5,4)');
  assert.equal(name(['As', 'Ts', 'Jc', 'Td'], ['4s', '8s', '5s', '3d', 'Kc'], true), 'Flush');
  assert.equal(name(['Kh', 'Kd'], ['Kc', '7s', '7d', '2h', '3c']), 'Full house (K,7)');
  assert.equal(name(['Th', 'Td'], ['2c', '7s', '9d', 'Jh', '3c']), 'Pair (10)');
  assert.equal(name(['Ah', 'Kh'], ['Qh', 'Jh', 'Th', '2c', '3d']), 'Royal flush');
  // the short labels for several boards or runs keep the rank too: Pair (A), not just Pair
  const brief = (hole, board) => shortHandName(bestHand(hole, board, false).score, true);
  assert.equal(brief(['Th', 'Td'], ['Tc', '7s', '9d']), 'Trips (10)');
  assert.equal(brief(['Ah', '4d'], ['Ac', '7s', '9d']), 'Pair (A)');
  assert.equal(brief(['Kh', '9d'], ['Kc', '9s', '2d']), 'Two pair (K,9)');
  assert.equal(brief(['Kh', 'Kd'], ['Kc', '7s', '7d']), 'Full house (K,7)');
  assert.equal(brief(['Ah', '2h'], ['Qh', 'Jh', '5h']), 'Flush');
  assert.equal(brief(['Ah', 'Kh'], ['Qh', 'Jh', 'Th']), 'Royal flush');
  assert.equal(brief(['Ah', 'Kd'], ['7c', '4s', '9d']), 'High card (A)');
});

test('the bomb pot size only has to be filled in when there are bomb pots', () => {
  const base = structuredClone(DEFAULT_SETTINGS);
  const off = sanitizeSettings({ bombPot: { mode: 'off', every: 0, percent: 0, anteBB: 0 } }, base);
  assert.equal(off.bombPot.mode, 'off');
  assert.equal(off.bombPot.anteBB, 2, 'a blank size keeps the one from before');
  assert.equal(sanitizeSettings({ bombPot: { mode: 'off', anteBB: 4 } }, base).bombPot.anteBB, 4, 'a good size is still kept for bomb pots the host calls');
  assert.throws(() => sanitizeSettings({ bombPot: { mode: 'every', every: 10, anteBB: 0 } }, base), /Bomb pot size/);
  assert.throws(() => sanitizeSettings({ bombPot: { mode: 'percent', percent: 0, anteBB: 2 } }, base), /Bomb pot chance/);
  const both = sanitizeSettings({ bombPot: { mode: 'both', every: 8, percent: 15, anteBB: 3 } }, base);
  assert.deepEqual([both.bombPot.every, both.bombPot.percent, both.bombPot.anteBB], [8, 15, 3]);
  // a rule that is off does not stop the other from being saved
  const every = sanitizeSettings({ bombPot: { mode: 'every', every: 12, percent: 0, anteBB: 2 } }, base);
  assert.deepEqual([every.bombPot.every, every.bombPot.percent], [12, 10]);
});

test('tables and presets on the old default felt move to the new one, once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-felt-'));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    tables: {}, presets: {
      a: { id: 'a', name: 'Old green', settings: { ...structuredClone(DEFAULT_SETTINGS), feltColor: '#1d6b48' } },
      b: { id: 'b', name: 'Navy', settings: { ...structuredClone(DEFAULT_SETTINGS), feltColor: '#23446b' } },
    },
  }));
  const srv = createServer({ dataDir: dir, mailer: null });
  const presets = srv.store.data.presets;
  assert.equal(presets.a.settings.feltColor, DEFAULT_SETTINGS.feltColor);
  assert.equal(presets.b.settings.feltColor, '#23446b');
  assert.equal(srv.store.data.meta.felt2, true);
  assert.equal(DEFAULT_SETTINGS.feltColor, '#507a4e');
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
