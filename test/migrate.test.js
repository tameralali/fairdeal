import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as ioc } from 'socket.io-client';
import { createServer } from '../server/index.js';
import { importIfNeeded, writeDataDir } from '../server/migrate.js';

const KEY = 'k'.repeat(40);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function call(base, method, p, body, token, extra = {}) {
  const r = await fetch(base + p, {
    method, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  return { status: r.status, json, location: r.headers.get('location') };
}

test('moving to a new server: data copied, logins keep working, the old copy forwards visitors', { timeout: 60000 }, async () => {
  const oldDir = tmp('aq-old-');
  const newDir = tmp('aq-new-');
  const oldSrv = createServer({ dataDir: oldDir, exportKey: KEY });
  const oldBase = `http://127.0.0.1:${await oldSrv.listen(0)}`;

  // some real data on the old server: an account, a club with chips and credit, a club table, a hand file
  const owner = (await call(oldBase, 'POST', `/api/links/${oldSrv.ownerSetupToken}`, { username: 'tamer', password: 'secret123', name: 'Tamer', email: 'tamer@example.com' })).json;
  const inv = (await call(oldBase, 'POST', '/api/admin/invites', { email: 'omar@example.com', name: 'Omar' }, owner.token)).json;
  const omar = (await call(oldBase, 'POST', `/api/links/${inv.link.split('/').pop()}`, { username: 'omar', password: 'secret123', name: 'Omar' })).json;
  const clubId = (await call(oldBase, 'POST', '/api/clubs', { name: 'The Aquarium' }, owner.token)).json.id;
  const code = (await call(oldBase, 'GET', `/api/clubs/${clubId}`, null, owner.token)).json.club.inviteCode;
  assert.equal((await call(oldBase, 'POST', '/api/clubs/join', { code }, omar.token)).status, 200);
  await call(oldBase, 'POST', `/api/clubs/${clubId}/members/${omar.user.id}/decide`, { approve: true }, owner.token);
  await call(oldBase, 'POST', `/api/clubs/${clubId}/members/${omar.user.id}/chips`, { amount: 2500, note: 'Cash' }, owner.token);
  await call(oldBase, 'POST', `/api/clubs/${clubId}/members/${omar.user.id}/credit`, { limit: 1000 }, owner.token);
  const tableId = (await call(oldBase, 'POST', `/api/clubs/${clubId}/tables`, { name: 'Thursday', settings: { format: [{ game: 'plo4', length: 'orbit', doubleBoard: true }] } }, owner.token)).json.id;
  oldSrv.store.appendHand(tableId, { handNumber: 1, note: 'a hand record' });
  const before = (await call(oldBase, 'GET', `/api/clubs/${clubId}`, null, owner.token)).json.club;

  // the export is locked
  assert.equal((await call(oldBase, 'POST', '/api/admin/export', {}, null, { 'x-migration-key': 'wrong'.repeat(8) })).status, 403);
  const locked = createServer({ dataDir: tmp('aq-locked-'), exportKey: null });
  const lockedBase = `http://127.0.0.1:${await locked.listen(0)}`;
  assert.equal((await call(lockedBase, 'POST', '/api/admin/export', {}, null, { 'x-migration-key': KEY })).status, 404, 'off unless switched on');
  await locked.close();

  // the new server pulls everything on its first boot
  const logs = [];
  const r = await importIfNeeded({ dataDir: newDir, from: oldBase, key: KEY, self: 'https://aquarium.example', log: (m) => logs.push(m) });
  assert.ok(r.imported >= 3, JSON.stringify(r));
  assert.equal(fs.readFileSync(path.join(newDir, 'hands', tableId + '.jsonl'), 'utf8'), fs.readFileSync(path.join(oldDir, 'hands', tableId + '.jsonl'), 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(newDir, 'db.json'), 'utf8')).meta.movedTo, undefined, 'the new copy does not think it moved');

  const newSrv = createServer({ dataDir: newDir, exportKey: null });
  const newBase = `http://127.0.0.1:${await newSrv.listen(0)}`;
  // same accounts and sessions: old tokens and passwords both work
  assert.equal((await call(newBase, 'GET', '/api/me', null, owner.token)).json.user.username, 'tamer');
  const login = await call(newBase, 'POST', '/api/auth/login', { username: 'omar', password: 'secret123' });
  assert.equal(login.status, 200);
  const after = (await call(newBase, 'GET', `/api/clubs/${clubId}`, null, owner.token)).json;
  assert.deepEqual(after.club.members.map((m) => [m.name, m.balance, m.creditLimit]), before.members.map((m) => [m.name, m.balance, m.creditLimit]));
  assert.equal(after.club.transactions.length, before.transactions.length);
  assert.deepEqual(after.tables.map((t) => [t.id, t.name, t.format[0].doubleBoard]), [[tableId, 'Thursday', true]]);

  // the old server now sends people on, refuses writes, and turns sockets away
  const page = await call(oldBase, 'GET', `/club/${clubId}?x=1`);
  assert.equal(page.status, 302);
  assert.equal(page.location, `https://aquarium.example/club/${clubId}?x=1`);
  assert.equal((await call(oldBase, 'POST', '/api/clubs', { name: 'Late' }, owner.token)).status, 410);
  assert.equal((await call(oldBase, 'GET', '/healthz')).status, 200);
  const err = await new Promise((resolve) => {
    const s = ioc(oldBase, { auth: { token: owner.token }, transports: ['websocket'], forceNew: true, reconnection: false });
    s.on('connect_error', (e) => { s.close(); resolve(e.message); });
    s.on('connect', () => { s.close(); resolve('connected'); });
  });
  assert.equal(err, 'moved');

  // a second copy (a retried import) is identical and never carries the forwarding address
  const again = await call(oldBase, 'POST', '/api/admin/export', { url: 'https://aquarium.example' }, null, { 'x-migration-key': KEY });
  assert.equal(again.status, 200);
  assert.equal(JSON.parse(again.json.files['db.json']).meta.movedTo, undefined);

  // later boots of the new server leave its data alone
  assert.deepEqual(await importIfNeeded({ dataDir: newDir, from: oldBase, key: KEY, log: () => {} }), { skipped: 'already has data' });
  assert.throws(() => writeDataDir(tmp('aq-bad-'), { format: 'aquarium-data-v1', files: { 'db.json': '{}', '../evil.txt': 'x' } }), /Unexpected file/);

  await newSrv.close();
  await oldSrv.close();
});

test('the new server answers health checks with a holding page while it waits for the old one', { timeout: 30000 }, async () => {
  const dir = tmp('aq-wait-');
  const holdPort = 30000 + Math.floor(Math.random() * 15000);
  const oldPort = holdPort + 1000;
  const logs = [];
  // nothing is listening at the old address yet, so the import keeps retrying behind a holding page
  const pending = importIfNeeded({ dataDir: dir, from: `http://127.0.0.1:${oldPort}`, key: KEY, holdPort, retryMs: 150, log: (m) => logs.push(m) });
  await new Promise((r) => setTimeout(r, 450));
  const health = await fetch(`http://127.0.0.1:${holdPort}/healthz`);
  assert.equal(health.status, 200);
  const home = await fetch(`http://127.0.0.1:${holdPort}/`);
  assert.equal(home.status, 503);
  assert.match(await home.text(), /moving in/);
  assert.ok(logs.some((l) => /failed/.test(l)));
  assert.equal(fs.existsSync(path.join(dir, 'db.json')), false, 'nothing written until the copy arrives');
  // the old server comes up: the next retry finds it, writes the data and frees the port
  const src = tmp('aq-src-');
  const oldSrv = createServer({ dataDir: src, exportKey: KEY });
  await oldSrv.listen(oldPort);
  await call(`http://127.0.0.1:${oldPort}`, 'POST', `/api/links/${oldSrv.ownerSetupToken}`, { username: 'someone', password: 'secret123', name: 'Someone', email: 'someone@example.com' });
  oldSrv.store.flush();
  const r = await pending;
  assert.ok(r.imported >= 1);
  assert.ok(fs.existsSync(path.join(dir, 'db.json')));
  const app = createServer({ dataDir: dir, exportKey: null });
  assert.equal(await app.listen(holdPort), holdPort, 'the real server takes over the same port');
  await app.close();
  await oldSrv.close();
});
