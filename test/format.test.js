import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.js';
import { sanitizeSettings, migrateSettings, stepText, DEFAULT_SETTINGS } from '../server/table.js';

test('steps last a number of orbits or a number of hands, in order, then start again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-fmt-'));
  const srv = createServer({ dataDir: dir, mailer: null });
  const r = srv.auth.acceptLink(srv.ownerSetupToken, { username: 'tamer', password: 'secret123', name: 'Tamer', email: 't@example.com' }, '');
  srv.clubs.join(r.user.id);
  const t = srv.tables.create(r.user, { name: 'Format', settings: { format: [{ game: 'plo4', unit: 'orbits', count: 2 }, { game: 'nlh', unit: 'hands', count: 3 }], autoStart: false } });
  // three players; the button moves one seat each hand
  t.seats = ['a', 'b', 'c', null, null, null, null, null, null, null];
  const games = [];
  const notes = [];
  for (let i = 0; i < 13; i++) {
    t.buttonSeat = i % 3;
    games.push(t.pickStep().game);
    notes.push(t.rotationInfo());
  }
  assert.deepEqual(games, ['plo4', 'plo4', 'plo4', 'plo4', 'plo4', 'plo4', 'nlh', 'nlh', 'nlh', 'plo4', 'plo4', 'plo4', 'plo4']);
  assert.deepEqual([notes[0].orbit, notes[0].count, notes[0].lastOrbit], [1, 2, false], 'the first orbit of two');
  assert.deepEqual([notes[3].orbit, notes[3].lastOrbit], [2, true], 'then the last one');
  assert.deepEqual([notes[6].unit, notes[6].handsLeft], ['hands', 2], 'two more hands of hold\'em after the first');
  srv.store.flush();
});

test('older step shapes still read, and counts are checked', () => {
  const old = migrateSettings({ format: [{ game: 'plo4', length: 'orbit', doubleBoard: true }, { game: 'nlh', length: 12 }] });
  assert.deepEqual(old.format, [{ game: 'plo4', unit: 'orbits', count: 1, doubleBoard: true }, { game: 'nlh', unit: 'hands', count: 12, doubleBoard: false }]);
  const games = migrateSettings({ games: ['nlh', 'plo5'], rotateEvery: 'hands', rotateHands: 7 });
  assert.deepEqual(games.format.map((x) => [x.game, x.unit, x.count]), [['nlh', 'hands', 7], ['plo5', 'hands', 7]]);
  const s = sanitizeSettings({ format: [{ game: 'plo5', unit: 'orbits', count: 3 }] }, DEFAULT_SETTINGS);
  assert.match(stepText(s.format[0]), /, 3 orbits$/);
  assert.match(stepText({ game: 'nlh', unit: 'hands', count: 1, doubleBoard: true }), /double board, 1 hand$/);
  assert.throws(() => sanitizeSettings({ format: [{ game: 'nlh', unit: 'orbits', count: 0 }] }, DEFAULT_SETTINGS), /1 to 50 orbits/);
  assert.throws(() => sanitizeSettings({ format: [{ game: 'nlh', unit: 'hands', count: 501 }] }, DEFAULT_SETTINGS), /1 to 500 hands/);
  assert.equal(sanitizeSettings({ format: [{ game: 'nlh', unit: 'hands', count: 2.5 }] }, DEFAULT_SETTINGS).format[0].count, 2, 'whole hands only');
});
