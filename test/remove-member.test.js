// Taking someone out of The Aquarium: who can, what happens to their balance, their seat and their
// sign-in, that a restart keeps them out, and that turning their access back on brings them back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as ioc } from 'socket.io-client';
import { createServer } from '../server/index.js';

let srv, url, dir, owner, clubId;
const sockets = [];

async function call(method, p, body, token) {
  const r = await fetch(url + p, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

let seq = 0;
async function member(name) {
  seq++;
  const inv = await call('POST', '/api/admin/invites', { email: `${name.toLowerCase()}${seq}@example.com`, name }, owner.token);
  const m = await call('POST', `/api/links/${inv.link.split('/').pop()}`, { username: `${name.toLowerCase()}_${seq}`, password: 'secret123', name });
  assert.equal(m.status, 200, m.error);
  return m;
}
const clubOf = async (token) => (await call('GET', `/api/clubs/${clubId}`, null, token)).club;
const remove = (who, token, settle) => call('POST', `/api/clubs/${clubId}/members/${who.user.id}/remove`, settle ? { settle: true } : {}, token);
const login = (m) => call('POST', '/api/auth/login', { username: m.user.username, password: 'secret123' });

function connect(token, tableId) {
  return new Promise((resolve, reject) => {
    const s = ioc(url, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(s);
    s.on('connect_error', reject);
    s.on('connect', () => s.emit('table:join', { tableId }, (ack) => (ack.ok ? resolve(s) : reject(new Error(ack.error)))));
  });
}
const emit = (s, ev, payload) => new Promise((resolve) => s.emit(ev, payload, resolve));

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-remove-'));
  srv = createServer({ dataDir: dir, mailer: null });
  url = `http://127.0.0.1:${await srv.listen(0)}`;
  owner = await call('POST', `/api/links/${srv.ownerSetupToken}`, { username: 'tamer', password: 'secret123', name: 'Tamer', email: 'tamer@example.com' });
  clubId = owner.clubId;
});
after(async () => { for (const s of sockets) s.close(); await srv.close(); });

test('removing a member: the balance is settled on the ledger, they are signed out and off the list', async () => {
  const lina = await member('Lina');
  await call('POST', `/api/clubs/${clubId}/members/${lina.user.id}/chips`, { amount: 5000, note: 'Cash' }, owner.token);
  const refused = await remove(lina, owner.token);
  assert.equal(refused.status, 400);
  assert.match(refused.error, /Settle/, 'a balance is not settled without saying so');
  assert.ok((await clubOf(owner.token)).members.some((m) => m.userId === lina.user.id), 'still there');

  const ok = await remove(lina, owner.token, true);
  assert.equal(ok.status, 200, ok.error);
  const c = await clubOf(owner.token);
  assert.ok(!c.members.some((m) => m.userId === lina.user.id), 'off the balances list');
  const settled = c.transactions.find((t) => t.userId === lina.user.id && t.type === 'settlement');
  assert.equal(settled.amount, -5000);
  assert.equal(settled.balanceAfter, 0);
  assert.equal(settled.note, 'Paid out on removal');
  assert.equal(c.totals.held, 0, 'the club no longer holds money for them');
  assert.equal((await call('GET', '/api/me', null, lina.token)).status, 401, 'signed out');
  assert.match((await login(lina)).error, /turned off/);

  const people = await call('GET', '/api/admin/people', null, owner.token);
  const row = people.users.find((u) => u.id === lina.user.id);
  assert.deepEqual([row.removed, row.disabled], [true, true]);
  const again = await call('POST', '/api/admin/invites', { email: lina.user.email }, owner.token);
  assert.match(again.error, /access off.*People page/, 'inviting them again says how to bring them back');
});

test('someone who owes the club is settled as a debt paid', async () => {
  const sam = await member('Sam');
  await call('POST', `/api/clubs/${clubId}/members/${sam.user.id}/chips`, { amount: -2500, note: 'Took cash' }, owner.token);
  assert.equal((await remove(sam, owner.token, true)).status, 200);
  const t = (await clubOf(owner.token)).transactions.find((x) => x.userId === sam.user.id && x.type === 'settlement');
  assert.deepEqual([t.amount, t.balanceAfter, t.note], [2500, 0, 'Debt settled on removal']);
});

test('who can remove whom', async () => {
  const omar = await member('Omar');
  const rami = await member('Rami');
  const zaid = await member('Zaid');
  const nadia = await member('Nadia');
  await call('POST', `/api/admin/users/${omar.user.id}/role`, { role: 'admin' }, owner.token);
  await call('POST', `/api/admin/users/${rami.user.id}/role`, { role: 'admin' }, owner.token);
  assert.match((await remove(nadia, zaid.token)).error, /owner or a manager/, 'members cannot remove anyone');
  assert.match((await remove(rami, omar.token)).error, /Only the owner can remove an admin/);
  assert.match((await remove(omar, omar.token)).error, /cannot remove yourself/);
  assert.match((await remove(owner, omar.token)).error, /owner cannot be removed/);
  assert.match((await remove(owner, owner.token)).error, /owner cannot be removed/);
  assert.equal((await remove(nadia, omar.token)).status, 200, 'an admin removes a member');
  assert.equal((await remove(rami, owner.token)).status, 200, 'the owner removes an admin');
  assert.equal((await call('GET', '/api/me', null, rami.token)).status, 401);
  assert.match((await remove(nadia, owner.token)).error, /Not a member/, 'only once');
});

test('someone with chips in a game is taken off the table first; an empty seat goes with them', async () => {
  const host = (await call('GET', '/api/me', null, owner.token));
  await call('POST', `/api/clubs/${clubId}/members/${host.user.id}/chips`, { amount: 100000, note: 'Cash' }, owner.token);
  const yara = await member('Yara');
  await call('POST', `/api/clubs/${clubId}/members/${yara.user.id}/chips`, { amount: 10000, note: 'Cash' }, owner.token);
  const { id } = await call('POST', '/api/tables', { settings: { autoApprove: true, smallBlind: 10, bigBlind: 20 } }, owner.token);
  const ys = await connect(yara.token, id);
  const sat = await emit(ys, 'seat:request', { seat: 3, buyIn: 4000 });
  assert.ok(sat.ok, sat.error);
  const t = srv.tables.get(id);
  assert.ok(t.players.has(yara.user.id), 'seated');
  const blocked = await remove(yara, owner.token, true);
  assert.match(blocked.error, /Yara is sitting in a game/);

  // with nothing left on the table, removing her clears the seat too, and her socket is closed
  t.players.get(yara.user.id).stack = 0;
  const gone = new Promise((resolve) => ys.on('disconnect', resolve));
  assert.equal((await remove(yara, owner.token, true)).status, 200);
  assert.ok(!t.players.has(yara.user.id), 'off the table');
  assert.ok(t.seats.every((s) => !s || s.userId !== yara.user.id));
  await gone;
});

test('a restart keeps removed people out; turning access back on brings them back with a zero balance', async () => {
  const kai = await member('Kai');
  await call('POST', `/api/clubs/${clubId}/members/${kai.user.id}/chips`, { amount: 700, note: 'Cash' }, owner.token);
  assert.equal((await remove(kai, owner.token, true)).status, 200);
  srv.store.flush();
  await srv.close();
  srv = createServer({ dataDir: dir, mailer: null });
  url = `http://127.0.0.1:${await srv.listen(0)}`;
  assert.ok(!(await clubOf(owner.token)).members.some((m) => m.userId === kai.user.id), 'still out after a restart');
  assert.match((await login(kai)).error, /turned off/);
  // a role change does not bring them back either
  await call('POST', `/api/admin/users/${kai.user.id}/role`, { role: 'admin' }, owner.token);
  await call('POST', `/api/admin/users/${kai.user.id}/role`, { role: 'member' }, owner.token);
  assert.ok(!(await clubOf(owner.token)).members.some((m) => m.userId === kai.user.id));

  assert.equal((await call('POST', `/api/admin/users/${kai.user.id}/access`, { enabled: true }, owner.token)).status, 200);
  const back = (await clubOf(owner.token)).members.find((m) => m.userId === kai.user.id);
  assert.ok(back, 'back on the list');
  assert.equal(back.balance, 0);
  const k2 = await login(kai);
  assert.equal(k2.status, 200);
  const me = await call('GET', '/api/me', null, k2.token);
  assert.deepEqual(me.clubs.map((c) => c.status), ['active']);
  const people = await call('GET', '/api/admin/people', null, owner.token);
  assert.equal(people.users.find((u) => u.id === kai.user.id).removed, false);
});
