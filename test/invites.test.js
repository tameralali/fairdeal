import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as ioc } from 'socket.io-client';
import { createServer } from '../server/index.js';

const sent = [];
let failNext = false;
const fakeMailer = {
  address: 'tamer@gmail.example',
  async send(msg) {
    if (failNext) { failNext = false; throw new Error('Invalid login: 535 Username and Password not accepted'); }
    sent.push(msg);
  },
};

let srv, url, dir, owner;
const tok = (link) => link.split('/').pop();

async function call(method, p, body, token) {
  const r = await fetch(url + p, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-inv-'));
  srv = createServer({ dataDir: dir, mailer: fakeMailer });
  url = `http://127.0.0.1:${await srv.listen(0)}`;
});
after(async () => { await srv.close(); });

test('nobody gets in without an account: guests, open sign-up and anonymous calls are refused', async () => {
  assert.equal((await call('POST', '/api/auth/guest', { name: 'Walk-in' })).status, 403);
  assert.equal((await call('POST', '/api/auth/register', { username: 'walkin', password: 'secret123' })).status, 403);
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('POST', '/api/tables', {})).status, 401);
  assert.equal((await call('GET', '/api/links/' + 'f'.repeat(64))).status, 410, 'made-up links do nothing');
  const err = await new Promise((resolve) => {
    const s = ioc(url, { auth: { token: 'nope' }, transports: ['websocket'], forceNew: true, reconnection: false });
    s.on('connect_error', (e) => { s.close(); resolve(e.message); });
    s.on('connect', () => { s.close(); resolve('connected'); });
  });
  assert.equal(err, 'auth');
});

test('the owner setup link makes the owner once', async () => {
  const info = await call('GET', `/api/links/${srv.ownerSetupToken}`);
  assert.equal(info.kind, 'owner');
  const bad = await call('POST', `/api/links/${srv.ownerSetupToken}`, { username: 'timzzz17', password: 'short', name: 'Tamer', email: 'tamer@example.com' });
  assert.match(bad.error, /at least 8/);
  owner = await call('POST', `/api/links/${srv.ownerSetupToken}`, { username: 'timzzz17', password: 'secret123', name: 'Tamer', email: 'Tamer@Example.com' });
  assert.equal(owner.status, 200);
  assert.equal(owner.user.role, 'owner');
  assert.equal(owner.user.email, 'tamer@example.com');
  assert.equal((await call('POST', `/api/links/${srv.ownerSetupToken}`, { username: 'other', password: 'secret123', name: 'X', email: 'x@example.com' })).status, 410, 'works once');
  // a restart with an owner in place prints no setup link
  srv.store.flush();
  const again = createServer({ dataDir: dir, mailer: null });
  assert.equal(again.ownerSetupToken, null);
});

test('an existing account can claim the owner setup link (sites that had accounts before)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-claim-'));
  const s1 = createServer({ dataDir: d, mailer: null });
  // an account made before the site was invite only
  const u = { id: 'legacy1', name: 'Old Timer', username: 'oldtimer', createdAt: Date.now() };
  s1.auth.setPassword(u, 'secret123');
  s1.store.data.users[u.id] = u;
  s1.store.data.usernames.oldtimer = u.id;
  const base = `http://127.0.0.1:${await s1.listen(0)}`;
  const claim = await fetch(`${base}/api/links/${s1.ownerSetupToken}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ existing: { username: 'oldtimer', password: 'secret123' } }),
  }).then((r) => r.json());
  assert.equal(claim.user.role, 'owner');
  assert.equal(claim.user.id, 'legacy1');
  await s1.close();
});

test('admins invite by email; the link works once, for that email, and can add the person to a club', async () => {
  const club = await call('POST', '/api/clubs', { name: 'The Aquarium' }, owner.token);
  const inv = await call('POST', '/api/admin/invites', { email: 'Omar@Example.com', name: 'Omar', clubId: club.id, days: 7 }, owner.token);
  assert.equal(inv.status, 200);
  assert.equal(inv.sent, true);
  const mail = sent.at(-1);
  assert.equal(mail.to, 'omar@example.com');
  assert.match(mail.subject, /Tamer invited you to The Aquarium/);
  assert.ok(mail.text.includes(inv.link) && mail.html.includes(inv.link), 'the email carries the link');
  assert.match(mail.text, /to the club “The Aquarium”/);
  assert.match(inv.link, /\/invite\/[0-9a-f]{64}$/);

  const info = await call('GET', `/api/links/${tok(inv.link)}`);
  assert.deepEqual([info.kind, info.email, info.invitedBy, info.club, info.name], ['join', 'omar@example.com', 'Tamer', 'The Aquarium', 'Omar']);
  assert.match((await call('POST', `/api/links/${tok(inv.link)}`, { username: 'o', password: 'secret123' })).error, /Username/);
  const omar = await call('POST', `/api/links/${tok(inv.link)}`, { username: 'omar', password: 'secret123', name: 'Omar', email: 'someone-else@example.com' });
  assert.equal(omar.status, 200);
  assert.equal(omar.user.email, 'omar@example.com', 'the email comes from the invite, not the form');
  assert.equal(omar.user.role, 'member');
  assert.equal((await call('POST', `/api/links/${tok(inv.link)}`, { username: 'omar2', password: 'secret123' })).status, 410, 'works once');
  const me = await call('GET', '/api/me', null, omar.token);
  assert.deepEqual(me.clubs.map((c) => [c.name, c.status]), [['The Aquarium', 'active']], 'joined the club straight away');

  assert.match((await call('POST', '/api/admin/invites', { email: 'omar@example.com' }, owner.token)).error, /already has an account/);
  assert.match((await call('POST', '/api/admin/invites', { email: 'not an email' }, owner.token)).error, /valid email/);
  assert.equal((await call('POST', '/api/admin/invites', { email: 'lina@example.com' }, omar.token)).status, 403, 'members cannot invite');
  const people = await call('GET', '/api/admin/people', null, owner.token);
  const row = people.invites.find((i) => i.email === 'omar@example.com');
  assert.deepEqual([row.status, row.usedBy, row.createdBy, row.club], ['used', 'Omar', 'Tamer', 'The Aquarium']);
  assert.equal(people.users.find((u) => u.username === 'omar').invitedBy, 'Tamer');
  assert.deepEqual(people.mail, { on: true, from: 'tamer@gmail.example' });
});

test('a new link replaces the old one; cancelled and expired links stop working', async () => {
  const a = await call('POST', '/api/admin/invites', { email: 'lina@example.com', name: 'Lina' }, owner.token);
  const again = await call('POST', `/api/admin/invites/${(await call('GET', '/api/admin/people', null, owner.token)).invites.find((i) => i.email === 'lina@example.com').id}/renew`, { days: 3 }, owner.token);
  assert.equal(again.sent, true);
  assert.notEqual(tok(again.link), tok(a.link));
  assert.equal((await call('GET', `/api/links/${tok(a.link)}`)).status, 410, 'old link is dead');
  assert.equal((await call('GET', `/api/links/${tok(again.link)}`)).kind, 'join');
  const id = (await call('GET', '/api/admin/people', null, owner.token)).invites.find((i) => i.email === 'lina@example.com').id;
  await call('POST', `/api/admin/invites/${id}/revoke`, {}, owner.token);
  assert.equal((await call('GET', `/api/links/${tok(again.link)}`)).status, 410, 'cancelled');

  const b = await call('POST', '/api/admin/invites', { email: 'sam@example.com', name: 'Sam', days: 1 }, owner.token);
  const inv = Object.values(srv.store.data.invites).find((i) => i.email === 'sam@example.com' && !i.revokedAt);
  inv.expiresAt = Date.now() - 1000;
  assert.equal((await call('GET', `/api/links/${tok(b.link)}`)).status, 410, 'expired');
  assert.equal((await call('GET', '/api/admin/people', null, owner.token)).invites.find((i) => i.email === 'sam@example.com').status, 'expired');
});

test('when the email fails the admin still gets the link to send by hand', async () => {
  failNext = true;
  const r = await call('POST', '/api/admin/invites', { email: 'rami@example.com', name: 'Rami' }, owner.token);
  assert.equal(r.status, 200);
  assert.equal(r.sent, false);
  assert.match(r.error, /did not go through/);
  assert.match(r.link, /\/invite\//);
  const row = (await call('GET', '/api/admin/people', null, owner.token)).invites.find((i) => i.email === 'rami@example.com');
  assert.match(row.sendError, /535/);
  assert.equal((await call('POST', `/api/links/${tok(r.link)}`, { username: 'rami', password: 'secret123' })).status, 200);
});

test('the owner makes admins; admins invite and reset members; only the owner manages admins and access', async () => {
  const login = (u, p = 'secret123') => call('POST', '/api/auth/login', { username: u, password: p });
  const omar = await login('omar');
  const rami = await login('rami');
  const people = await call('GET', '/api/admin/people', null, owner.token);
  const idOf = (u) => people.users.find((x) => x.username === u).id;
  assert.equal((await call('POST', `/api/admin/users/${idOf('rami')}/role`, { role: 'admin' }, omar.token)).status, 403);
  assert.equal((await call('POST', `/api/admin/users/${idOf('omar')}/role`, { role: 'admin' }, owner.token)).user.role, 'admin');
  assert.equal((await call('GET', '/api/me', null, omar.token)).user.role, 'admin');

  // an admin invites
  const inv = await call('POST', '/api/admin/invites', { email: 'nadia@example.com', name: 'Nadia' }, omar.token);
  assert.equal(inv.sent, true);
  assert.match(sent.at(-1).subject, /Omar invited you/);
  // but cannot change roles, turn access off, or reset the owner
  assert.equal((await call('POST', `/api/admin/users/${idOf('rami')}/role`, { role: 'admin' }, omar.token)).status, 403);
  assert.equal((await call('POST', `/api/admin/users/${idOf('rami')}/access`, { enabled: false }, omar.token)).status, 403);
  assert.equal((await call('POST', `/api/admin/users/${idOf('timzzz17')}/reset`, {}, omar.token)).status, 403);
  assert.equal((await call('POST', `/api/admin/users/${idOf('timzzz17')}/role`, { role: 'member' }, owner.token)).status, 400, 'the owner stays the owner');

  // reset a member's password by email
  const reset = await call('POST', `/api/admin/users/${idOf('rami')}/reset`, {}, omar.token);
  assert.equal(reset.sent, true);
  assert.equal(sent.at(-1).to, 'rami@example.com');
  assert.match(reset.link, /\/reset\/[0-9a-f]{64}$/);
  const rinfo = await call('GET', `/api/links/${tok(reset.link)}`);
  assert.deepEqual([rinfo.kind, rinfo.username], ['reset', 'rami']);
  const done = await call('POST', `/api/links/${tok(reset.link)}`, { password: 'brand-new-pass' });
  assert.equal(done.status, 200);
  assert.equal((await call('GET', '/api/me', null, rami.token)).status, 401, 'other sessions are signed out');
  assert.equal((await login('rami')).status, 401, 'old password no longer works');
  assert.equal((await login('rami', 'brand-new-pass')).status, 200);
  assert.equal((await call('POST', `/api/links/${tok(reset.link)}`, { password: 'another-pass' })).status, 410, 'works once');

  // the owner turns access off and on
  const rami2 = await login('rami', 'brand-new-pass');
  assert.equal((await call('POST', `/api/admin/users/${idOf('rami')}/access`, { enabled: false }, owner.token)).status, 200);
  assert.equal((await call('GET', '/api/me', null, rami2.token)).status, 401);
  assert.match((await login('rami', 'brand-new-pass')).error, /turned off/);
  assert.equal((await call('POST', `/api/admin/users/${idOf('rami')}/access`, { enabled: true }, owner.token)).status, 200);
  assert.equal((await login('rami', 'brand-new-pass')).status, 200);
  assert.equal((await call('POST', `/api/admin/users/${idOf('timzzz17')}/access`, { enabled: false }, owner.token)).status, 400);

  // demoted admins lose admin powers
  await call('POST', `/api/admin/users/${idOf('omar')}/role`, { role: 'member' }, owner.token);
  assert.equal((await call('POST', '/api/admin/invites', { email: 'zaid@example.com' }, omar.token)).status, 403);
});

test('sign-ins from before the site was invite only no longer work', async () => {
  const guest = { id: 'guest1', name: 'Old guest', createdAt: Date.now() };
  srv.store.data.users[guest.id] = guest;
  const token = srv.auth.issueToken(guest);
  assert.equal((await call('GET', '/api/me', null, token)).status, 401);
});
