// What keeps the site going when something goes wrong: a damaged save, a hand file cut off mid-line,
// a failed write, a step lost to an error in the middle of a hand, and the memory a finished game holds.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as ioc } from 'socket.io-client';
import { createServer } from '../server/index.js';
import { Store } from '../server/store.js';
import { DELAYS } from '../server/table.js';

Object.assign(DELAYS, { street: 2, runoutFirst: 2, runout: 2, runBreak: 2, rebuy: 20, showdown: 2, afterUncontested: 10, afterShowdown: 10, perExtraRun: 2, rit: 250, autoAct: 10, away: 150 });

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, label = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await wait(20); }
  throw new Error('timed out waiting for ' + label);
}

test('a damaged db.json starts from the hourly backup, and the damaged file is kept', () => {
  const dir = tmp('aq-db-');
  const s1 = new Store(dir);
  s1.data.users.u1 = { id: 'u1', name: 'Tamer' };
  s1.flush(); // the first save keeps no backup yet (there was no file)
  s1.backedUpAt = 0;
  s1.data.users.u2 = { id: 'u2', name: 'Omar' };
  s1.flush(); // copies the first save to db.json.bak, then writes the second
  assert.ok(fs.existsSync(path.join(dir, 'db.json.bak')));
  fs.writeFileSync(path.join(dir, 'db.json'), '{"users": {"u1": {"id": "u1"'); // cut off mid-write
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const s2 = new Store(dir);
    assert.deepEqual(Object.keys(s2.data.users), ['u1'], 'started from the backup');
  } finally { console.error = orig; }
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('db.json.damaged-')), 'the damaged file is kept');
  assert.ok(errors.some((e) => /could not be read/.test(e)));

  const bare = tmp('aq-db2-');
  fs.writeFileSync(path.join(bare, 'db.json'), 'not json');
  console.error = () => {};
  try { assert.throws(() => new Store(bare), /no backup/); } finally { console.error = orig; }
});

test('a hand file cut off mid-line: the damaged line is skipped and the next hand goes on a line of its own', () => {
  const dir = tmp('aq-lines-');
  const s = new Store(dir);
  s.appendHand('t1', { handNumber: 1, players: [] });
  fs.appendFileSync(path.join(dir, 'hands', 't1.jsonl'), '{"handNumber": 2, "players": [');
  const s2 = new Store(dir); // a new run
  const orig = console.error;
  console.error = () => {};
  try {
    s2.appendHand('t1', { handNumber: 3, players: [] });
    assert.deepEqual(s2.readHands('t1').map((r) => r.handNumber), [1, 3]);
    s2.appendLog('t1', { id: 1, text: 'one' });
    s2.flush();
    fs.appendFileSync(path.join(dir, 'logs', 't1.jsonl'), '{"id": 2, "te');
    const s3 = new Store(dir);
    s3.appendLog('t1', { id: 3, text: 'three' });
    s3.flush();
    assert.deepEqual(s3.readLog('t1').map((e) => e.id), [1, 3]);
  } finally { console.error = orig; }
});

test('a save that fails is tried again instead of stopping the server', async () => {
  const s = new Store(tmp('aq-fail-'));
  const real = s.flush.bind(s);
  let fails = 2;
  s.flush = () => { if (fails-- > 0) throw new Error('ENOSPC: no space left on device'); real(); };
  const orig = console.error;
  const errors = [];
  console.error = (...a) => errors.push(String(a[1]?.message || a[0]));
  try {
    s.data.meta.x = 1;
    s.save();
    await until(() => fs.existsSync(path.join(s.dir, 'db.json')), 3000, 'the save to go through');
  } finally { console.error = orig; }
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'db.json'), 'utf8')).meta.x, 1);
  assert.equal(errors.filter((e) => /ENOSPC/.test(e)).length, 2);
});

// a running game for the next tests
let srv, url, owner, tableId;
const sockets = [];
function connect(token) {
  return new Promise((resolve, reject) => {
    const s = ioc(url, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(s);
    s.on('connect_error', reject);
    s.on('connect', () => s.emit('table:join', { tableId }, (ack) => (ack.ok ? resolve(s) : reject(new Error(ack.error)))));
  });
}
const emit = (s, ev, p) => new Promise((resolve) => s.emit(ev, p, resolve));
async function call(method, p, body, token) {
  const r = await fetch(url + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}

before(async () => {
  srv = createServer({ dataDir: tmp('aq-res-'), mailer: null });
  url = `http://127.0.0.1:${await srv.listen(0)}`;
  owner = await call('POST', `/api/links/${srv.ownerSetupToken}`, { username: 'tamer', password: 'secret123', name: 'Tamer', email: 't@example.com' });
});
after(async () => { for (const s of sockets) s.close(); await srv.close(); });

test('a hand whose next step was lost is moved on by the watchdog; so is a game that stopped dealing', async () => {
  const inv = await call('POST', '/api/admin/invites', { email: 'omar@example.com', name: 'Omar' }, owner.token);
  const omar = await call('POST', `/api/links/${inv.link.split('/').pop()}`, { username: 'omar', password: 'secret123', name: 'Omar' });
  for (const m of [owner, omar]) await call('POST', `/api/clubs/${owner.clubId}/members/${m.user.id}/chips`, { amount: 100000, note: 'Cash' }, owner.token);
  ({ id: tableId } = await call('POST', '/api/tables', { settings: { autoApprove: true, decisionSeconds: 20 } }, owner.token));
  const a = await connect(owner.token);
  const b = await connect(omar.token);
  assert.ok((await emit(a, 'seat:request', { seat: 0, buyIn: 5000 })).ok);
  assert.ok((await emit(b, 'seat:request', { seat: 1, buyIn: 5000 })).ok);
  assert.ok((await emit(a, 'host:start', {})).ok);
  const t = srv.tables.get(tableId);
  await until(() => t.hand && t.hand.phase !== 'done' && t.turn, 5000, 'a hand');

  // the step that would move the hand on is lost (as if an error had stopped it)
  const n = t.hand.number;
  clearTimeout(t.timers.action);
  t.timers.action = null;
  t.turn = null;
  const orig = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  try {
    t.watchdog();
    assert.equal(t.turn, null, 'seen once: left alone');
    t.watchdog();
    assert.ok(t.turn && t.timers.action, 'seen twice: the turn starts again');
    assert.equal(t.hand.number, n);
    // a clock that went off without effect counts too
    t.turn.deadline = Date.now() - 20000;
    t.watchdog();
    t.watchdog();
    assert.ok(t.turn.deadline > Date.now(), 'an overdue turn gets a new clock');

    // play the hand out, then lose the timer that deals the next one (a longer pause between hands
    // here, to catch it)
    DELAYS.afterUncontested = DELAYS.afterShowdown = 3000;
    const actor = () => t.hand?.actor();
    await until(async () => {
      if (!t.hand || t.hand.phase === 'done' || t.hand.number > n) return true;
      const who = actor();
      if (who) {
        const legal = t.hand.legalActions(who.id);
        const ack = await emit(who.id === owner.user.id ? a : b, 'action', { type: legal.canCheck ? 'check' : 'fold' });
        if (!ack.ok) orig('fold refused', ack.error, JSON.stringify(legal));
      } else if (process.env.DEBUG_TEST) orig('no actor', t.hand.phase, t.hand.pending, Object.keys(t.timers).filter((k) => t.timers[k] && k !== 'session'));
      return false;
    }, 5000, 'the hand to end');
    await until(() => !!t.timers.next, 3000, 'the next hand to be on its way');
    clearTimeout(t.timers.next);
    t.timers.next = null;
    DELAYS.afterUncontested = DELAYS.afterShowdown = 10;
    t.watchdog();
    assert.ok(!t.hand || t.hand.number === n, 'seen once: left alone');
    t.watchdog();
    await until(() => t.hand && t.hand.number > n && t.hand.phase !== 'done', 3000, 'the next hand');
  } finally { console.error = orig; }
  assert.ok(errors.some((e) => /moving it on/.test(e)), 'what happened is in the server log');

  // a game that is fine is never touched
  const before = t.hand.number;
  const turn = t.turn;
  for (let i = 0; i < 4; i++) t.watchdog();
  assert.equal(t.turn, turn);
  assert.equal(t.hand.number, before);
});

test('one player whose table cannot be sent does not stop the others getting theirs', async () => {
  const t = srv.tables.get(tableId);
  const got = [];
  const watcher = await connect(owner.token);
  watcher.on('state', (s) => got.push(s.table.handNumber));
  await wait(100);
  got.length = 0;
  const real = t.stateFor.bind(t);
  const orig = console.error;
  console.error = () => {};
  try {
    let first = true;
    t.stateFor = (uid) => { if (first) { first = false; throw new Error('boom'); } return real(uid); };
    t.broadcast();
    await until(() => got.length > 0, 2000, 'a state for the others');
  } finally { t.stateFor = real; console.error = orig; }
});

test('a finished game lets its hands go from memory after a while and reads them again when opened', async () => {
  const t = srv.tables.get(tableId);
  const [a, b] = sockets;
  assert.ok((await emit(a, 'host:end', {})).ok);
  // the game ends once the hand being played is over
  await until(async () => {
    if (t.status === 'ended') return true;
    const who = t.hand?.phase !== 'done' && t.hand?.actor();
    if (who) await emit(who.id === owner.user.id ? a : b, 'action', { type: t.hand.legalActions(who.id).canCheck ? 'check' : 'fold' });
    return false;
  }, 10000, 'the game to end');
  for (const s of sockets) s.close();
  await until(() => t.sockets.size === 0, 2000, 'everyone to leave');
  const count = t.getRecords().length;
  assert.ok(count > 0);
  t.release(60000);
  assert.ok(t.records, 'opened a moment ago: kept');
  t.recordsUsedAt = Date.now() - 120000;
  t.release(60000);
  assert.equal(t.records, null, 'let go');
  assert.equal(t.getRecords().length, count, 'read again from disk');
  const { hands } = await call('GET', `/api/tables/${tableId}/hands`, null, owner.token);
  assert.equal(hands.length, count);
});

test('after a restart, players are dealt in again as their page reconnects; someone not back stays away', async () => {
  const dir = tmp('aq-restart-');
  let s1 = createServer({ dataDir: dir, mailer: null });
  let base = `http://127.0.0.1:${await s1.listen(0)}`;
  const req = async (m, p, b, tok) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined });
    const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
  };
  const own = await req('POST', `/api/links/${s1.ownerSetupToken}`, { username: 'host', password: 'secret123', name: 'Host', email: 'h@example.com' });
  const people = [own];
  for (const n of ['Bea', 'Cyd']) {
    const inv = await req('POST', '/api/admin/invites', { email: `${n}@example.com`, name: n }, own.token);
    people.push(await req('POST', `/api/links/${inv.link.split('/').pop()}`, { username: n.toLowerCase(), password: 'secret123', name: n }));
  }
  for (const m of people) await req('POST', `/api/clubs/${own.clubId}/members/${m.user.id}/chips`, { amount: 100000, note: 'Cash' }, own.token);
  const { id } = await req('POST', '/api/tables', { settings: { autoApprove: true, decisionSeconds: 20 } }, own.token);
  const open = (tok) => new Promise((resolve, reject) => {
    const s = ioc(base, { auth: { token: tok }, transports: ['websocket'], forceNew: true, reconnection: false });
    s.on('connect_error', reject);
    s.on('connect', () => s.emit('table:join', { tableId: id }, (ack) => (ack.ok ? resolve(s) : reject(new Error(ack.error)))));
  });
  let socks = [];
  let s2 = null;
  try {
  for (const m of people) socks.push(await open(m.token));
  for (const [i, s] of socks.entries()) assert.ok((await emit(s, 'seat:request', { seat: i, buyIn: 5000 })).ok);
  assert.ok((await emit(socks[0], 'host:start', {})).ok);
  await until(() => { const h = s1.tables.get(id).hand; return h && h.phase !== 'done'; }, 5000, 'a hand');
  const stacks = Object.fromEntries([...s1.tables.get(id).players.values()].map((p) => [p.userId, p.stack]));

  // a deploy: the server stops in the middle of the hand and starts again
  for (const s of socks) s.close();
  s1.store.flush();
  await s1.close();
  s1 = null;
  s2 = createServer({ dataDir: dir, mailer: null });
  base = `http://127.0.0.1:${await s2.listen(0)}`;
  const t = s2.tables.get(id);
  assert.ok([...t.players.values()].every((p) => p.sittingOut), 'everyone sits out until they are back');
  assert.deepEqual(Object.fromEntries([...t.players.values()].map((p) => [p.userId, p.stack])), stacks, 'the hand was called off');
  assert.ok(t.loadLog().some((e) => /server restarted/.test(e.text)));
  // two of the three pages reconnect
  socks = [await open(people[0].token), await open(people[1].token)];
  const [hostP, beaP, cyP] = people.map((m) => t.players.get(m.user.id));
  assert.deepEqual([hostP.sittingOut, beaP.sittingOut, cyP.sittingOut], [false, false, true]);
  await until(() => t.hand && t.hand.phase !== 'done', 5000, 'a new hand with the two who are back');
  assert.deepEqual(t.hand.players.map((p) => p.id).sort(), [people[0].user.id, people[1].user.id].sort());
  // reconnecting again later changes nothing for those already back; and long after a restart a
  // player has to press I'm back themselves
  cyP.backOnReturn = Date.now() - 20 * 60000;
  socks.push(await open(people[2].token));
  assert.equal(cyP.sittingOut, true, 'too long after the restart');
  } finally {
    for (const s of socks) s.close();
    if (s1) await s1.close();
    if (s2) await s2.close();
  }
});
