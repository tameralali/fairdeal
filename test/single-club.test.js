// A site from before the single club: two clubs, one in whole chips with a game still running,
// managers, a pending request and a private game. The first start turns it into The Aquarium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.js';
import { Auth } from '../server/auth.js';
import { Store } from '../server/store.js';
import { fmtMoney, parseMoney, moneyInput } from '../shared/money.js';

function oldSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-one-'));
  const store = new Store(dir);
  const auth = new Auth(store);
  const user = (id, name, role) => {
    const u = { id, name, username: name.toLowerCase(), email: `${name.toLowerCase()}@example.com`, createdAt: 1, role };
    auth.setPassword(u, 'secret123');
    store.data.users[id] = u;
    store.data.usernames[u.username] = id;
  };
  user('own', 'Tamer', 'owner');
  user('mgr', 'Omar', undefined);
  user('mem', 'Lina', undefined);
  user('pen', 'Sam', undefined);
  user('new', 'Rami', undefined);
  const m = (userId, role, balance, creditLimit = 0, status = 'active') => ({ userId, role, status, balance, creditLimit, joinedAt: 1 });
  store.data.clubs.aq = {
    id: 'aq', name: 'Thursday club', ownerId: 'own', createdAt: 100, inviteCode: 'ABCDEFGH',
    settings: { decimals: 0, membersSeeLedger: false, allowTransfers: false, requireApproval: true, defaultCreditLimit: 200 },
    members: { own: m('own', 'owner', 1000), mgr: m('mgr', 'manager', -300, 500), mem: m('mem', 'member', 0), pen: m('pen', 'member', 0, 0, 'pending') },
    transactions: [
      { id: 't1', at: 1, type: 'chips_add', userId: 'own', amount: 1500, balanceAfter: 1500 },
      { id: 't2', at: 2, type: 'buyin', userId: 'own', amount: -500, balanceAfter: 1000, tableId: 'live' },
      { id: 't3', at: 3, type: 'credit_limit', userId: 'mgr', amount: 0, balanceAfter: 0, limitFrom: 0, limitTo: 500 },
      { id: 't4', at: 4, type: 'chips_remove', userId: 'mgr', amount: -300, balanceAfter: -300 },
    ],
    announcement: '',
  };
  store.data.clubs.other = {
    id: 'other', name: 'Side club', ownerId: 'mem', createdAt: 200, inviteCode: 'ZZZZZZZZ',
    settings: { decimals: 2, membersSeeLedger: false, allowTransfers: false, requireApproval: true, defaultCreditLimit: 0 },
    members: { mem: m('mem', 'owner', 0) }, transactions: [], announcement: '',
  };
  const settings = { smallBlind: 1, bigBlind: 2, games: ['nlh'], rotateEvery: 'hands', rotateHands: 5 };
  store.data.tables.live = {
    id: 'live', name: 'Running game', clubId: 'aq', ownerId: 'own', createdAt: 300, status: 'running', settings,
    ledger: [{ at: 2, userId: 'own', name: 'Tamer', type: 'buyin', amount: 500 }],
    players: [{ userId: 'own', name: 'Tamer', seat: 0, stack: 640 }],
  };
  store.data.tables.done = { id: 'done', name: 'Last week', clubId: 'aq', ownerId: 'own', createdAt: 250, status: 'ended', settings, ledger: [], players: [] };
  store.data.tables.priv = { id: 'priv', name: 'Private game', clubId: null, ownerId: 'mem', createdAt: 260, status: 'ended', settings, ledger: [{ at: 5, userId: 'mem', name: 'Lina', type: 'buyin', amount: 100 }], players: [] };
  store.flush();
  return dir;
}

test('the first start makes one club in dollars and cents and keeps everyone’s money', async () => {
  const dir = oldSite();
  const srv = createServer({ dataDir: dir, mailer: null });
  const d = srv.store.data;
  assert.equal(d.meta.mainClubId, 'aq', 'the owner’s club becomes The Aquarium');
  const c = d.clubs.aq;
  assert.equal(c.name, 'The Aquarium');
  assert.equal(c.settings.decimals, 2);
  // the running game was ended first: its 640 chips went back to the balance, then everything became cents
  assert.equal(srv.tables.get('live').status, 'ended');
  assert.equal(c.members.own.balance, (1000 + 640) * 100);
  assert.equal(c.members.mgr.balance, -30000);
  assert.equal(c.members.mgr.creditLimit, 50000);
  assert.equal(c.settings.defaultCreditLimit, 20000);
  const t3 = c.transactions.find((t) => t.id === 't3');
  assert.deepEqual([t3.limitFrom, t3.limitTo], [0, 50000]);
  assert.equal(c.transactions.at(-1).type, 'cashout');
  assert.equal(c.transactions.at(-1).balanceAfter, 164000);
  // everyone is in, with roles that follow the site roles
  assert.deepEqual(Object.keys(c.members).sort(), ['mem', 'mgr', 'new', 'own', 'pen']);
  assert.ok(Object.values(c.members).every((x) => x.status === 'active'));
  assert.equal(srv.auth.roleOf(d.users.mgr), 'admin', 'a club manager keeps that power as an admin');
  assert.equal(srv.auth.roleOf(d.users.mem), 'member', 'owning another club does not make anyone an admin');
  assert.equal(srv.clubs.role('aq', 'mgr'), 'manager');
  assert.equal(srv.clubs.role('aq', 'new'), 'member');
  assert.equal(c.members.new.creditLimit, 20000, 'new members get the default credit limit');
  // older games keep the unit they were played in; new ones are in cents
  assert.equal(srv.tables.get('done').decimals, 0);
  assert.equal(srv.tables.get('done').fmt(500), '500');
  const lina = srv.auth.login({ username: 'lina', password: 'secret123' }, '');
  const port = await srv.listen(0);
  const get = (p, token) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { authorization: 'Bearer ' + token } }).then((r) => r.json());
  const me = await get('/api/me', lina.token);
  assert.deepEqual(me.clubs.map((x) => x.id), ['aq'], 'the other club is not shown');
  const view = await get('/api/clubs/aq', lina.token);
  assert.deepEqual(view.tables.map((t) => t.id).sort(), ['done', 'live', 'priv'], 'older private games are listed with the club');
  srv.store.flush();
  await srv.close();

  // a second start changes nothing
  const before = JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).clubs.aq.members);
  const again = createServer({ dataDir: dir, mailer: null });
  assert.equal(JSON.stringify(again.store.data.clubs.aq.members), before);
  assert.equal(again.store.data.clubs.aq.settings.decimals, 2);
  assert.equal(again.tables.get('done').decimals, 0, 'an old game still shows its chips after another restart');
  assert.equal(again.tables.get('priv').decimals, 0);
  const owner = again.auth.users.own;
  const t = again.tables.create(owner, { name: 'Tonight', settings: { smallBlind: 25, bigBlind: 50 } });
  assert.equal(t.decimals, 2);
  assert.equal(t.fmt(2550), '$25.50');
  again.store.flush();
});

test('a brand new site starts with The Aquarium and the owner owns it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-fresh-'));
  const srv = createServer({ dataDir: dir, mailer: null });
  const c = srv.clubs.main();
  assert.equal(c.name, 'The Aquarium');
  assert.equal(c.settings.decimals, 2);
  assert.equal(c.ownerId, null);
  const r = srv.auth.acceptLink(srv.ownerSetupToken, { username: 'tamer', password: 'secret123', name: 'Tamer', email: 't@example.com' }, '');
  srv.clubs.join(r.user.id);
  assert.equal(c.ownerId, r.user.id);
  assert.equal(srv.clubs.role(c.id, r.user.id), 'owner');
  srv.store.flush();
});

test('dollars and cents', () => {
  assert.equal(fmtMoney(123450), '$1,234.50');
  assert.equal(fmtMoney(2500), '$25');
  assert.equal(fmtMoney(2500, 2, 'always'), '$25.00');
  assert.equal(fmtMoney(1), '$0.01');
  assert.equal(fmtMoney(-1250), '-$12.50');
  assert.equal(fmtMoney(0), '$0');
  assert.equal(fmtMoney(500, 0), '500', 'older games in chips');
  assert.equal(parseMoney('$12.50'), 1250);
  assert.equal(parseMoney('1,000'), 100000);
  assert.equal(parseMoney('0.01'), 1);
  assert.equal(parseMoney('.5'), 50);
  assert.ok(Number.isNaN(parseMoney('abc')));
  assert.ok(Number.isNaN(parseMoney('')));
  assert.equal(moneyInput(1250), '12.50');
});
