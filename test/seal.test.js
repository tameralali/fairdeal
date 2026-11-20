// The seal for the next hand outlives a restart, and a hand number never gets a second seal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, DEFAULT_SETTINGS } from '../server/table.js';
import { newCommitment, savedCommitment, restoreCommitment } from '../server/fair-node.js';
import { FAIRNESS_VERSION, FAIRNESS_V2 } from '../shared/fairness.js';

function fakeManager() {
  const logs = [];
  return {
    logs,
    store: { data: { tables: {} }, save() {}, readLog: () => [], appendLog: (id, e) => logs.push(e.text), readHands: () => [] },
    clubs: { isManager: () => false, changed() {} },
  };
}
const input = (n) => ({ userId: 'u' + n, name: 'P' + n, seat: n, seed: String(n).repeat(32).slice(0, 32) });

test('a saved seal rebuilds exactly, inputs included, for both kinds of seal', () => {
  for (const version of [FAIRNESS_VERSION, FAIRNESS_V2]) {
    const c = newCommitment(5, version);
    c.contributions.set('u1', input(1));
    const back = restoreCommitment(JSON.parse(JSON.stringify(savedCommitment(c))));
    assert.equal(back.commitment, c.commitment);
    assert.equal(back.handNumber, 5);
    assert.deepEqual([...back.contributions.values()], [input(1)]);
    if (version === FAIRNESS_V2) assert.deepEqual(back.v2.base, c.v2.base);
    const bad = { ...savedCommitment(c), serverSeed: 'f'.repeat(64) };
    assert.throws(() => restoreCommitment(bad), /does not rebuild/);
  }
});

test('after a restart the next hand keeps the seal browsers saw, and the inputs they sent', () => {
  for (const revealPolicy of ['hand', 'hidden']) {
    const m = fakeManager();
    const t = new Table(m, { id: 'T' + revealPolicy, name: 'Game', ownerId: 'host', settings: { ...DEFAULT_SETTINGS, revealPolicy }, unit: 2 });
    assert.equal(t.fair.pending.handNumber, 1, 'a new table starts at hand 1');
    t.handNumber = 6;
    t.status = 'running';
    t.fair.pending = newCommitment(7, t.fairVersion());
    t.fair.pending.contributions.set('u1', input(1));
    t.snapshot();
    const seen = t.fair.pending.commitment;
    const again = new Table(m, JSON.parse(JSON.stringify(m.store.data.tables[t.id])));
    assert.equal(again.fair.pending.handNumber, 7);
    assert.equal(again.fair.pending.commitment, seen, 'same seal after the restart');
    assert.ok(again.fair.pending.contributions.has('u1'), 'the input sent before the restart still counts');
  }
});

test('a save without the seal, or a seal that no longer fits, skips that hand number', () => {
  const m = fakeManager();
  const t = new Table(m, { id: 'T2', name: 'Game', ownerId: 'host', settings: { ...DEFAULT_SETTINGS, revealPolicy: 'hand' }, unit: 2 });
  t.handNumber = 6;
  t.status = 'running';
  t.fair.pending = newCommitment(7, t.fairVersion());
  t.snapshot();
  const old = JSON.parse(JSON.stringify(m.store.data.tables.T2));
  delete old.fairPending;
  assert.equal(new Table(m, old).fair.pending.handNumber, 8, 'hand 7 may have been shown a seal that is gone');
  const changed = JSON.parse(JSON.stringify(m.store.data.tables.T2));
  changed.settings.revealPolicy = 'hidden';
  const t3 = new Table(m, changed);
  assert.equal(t3.fair.pending.handNumber, 8);
  assert.equal(t3.fair.pending.version, FAIRNESS_V2);
});

test('changing how folded cards are kept seals the next hand under the next number', () => {
  const m = fakeManager();
  const t = new Table(m, { id: 'T3', name: 'Game', ownerId: 'host', settings: { ...DEFAULT_SETTINGS, revealPolicy: 'hand' }, unit: 2 });
  t.handNumber = 3;
  t.fair.pending = newCommitment(4, t.fairVersion());
  const before = t.fair.pending.commitment;
  t.hostSettings({ id: 'host' }, { revealPolicy: 'hidden' });
  assert.equal(t.fair.pending.handNumber, 5, 'hand 4 already has a seal browsers saved');
  assert.equal(t.fair.pending.version, FAIRNESS_V2);
  assert.notEqual(t.fair.pending.commitment, before);
  assert.ok(m.logs.some((x) => /hand #5 and #4 is skipped/.test(x)), m.logs.join(' | '));
  t.hostSettings({ id: 'host' }, { spectatorChat: !t.settings.spectatorChat });
  assert.equal(t.fair.pending.handNumber, 5, 'other changes keep the seal');
});
