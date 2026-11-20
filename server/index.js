// HTTP + Socket.io server.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import { Store } from './store.js';
import { Auth } from './auth.js';
import { Clubs } from './clubs.js';
import { TableManager, sanitizeSettings, DEFAULT_SETTINGS } from './table.js';
import { exportKeyFromEnv, keyMatches, readDataDir, importIfNeeded } from './migrate.js';
import { mailerFromEnv, inviteEmail, resetEmail } from './mail.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createServer({ dataDir = process.env.DATA_DIR || path.join(ROOT, 'data'), exportKey = exportKeyFromEnv(), mailer = mailerFromEnv() } = {}) {
  const store = new Store(dataDir);
  const auth = new Auth(store);
  // until someone claims the site, a one-time owner link is made at each start (printed in the log)
  const ownerSetupToken = auth.ownerSetupLink();
  const clubs = new Clubs(store, auth);
  const tables = new TableManager({ store, auth, clubs });
  // one club, The Aquarium: every account is in it and amounts are in dollars and cents
  clubs.ensureMain({ endTables: (id) => tables.endTablesNotIn(id, 2) });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  // After a move (see migrate.js) this copy only forwards visitors to the new address.
  const movedTo = () => store.data.meta?.movedTo || null;
  app.use((req, res, next) => {
    const to = movedTo();
    if (!to || req.path === '/healthz' || req.path === '/api/admin/export') return next();
    if (req.path.startsWith('/api/')) return res.status(410).json({ error: `The Aquarium has moved to ${to}` });
    res.redirect(302, to.replace(/\/+$/, '') + req.originalUrl);
  });
  app.post('/api/admin/export', (req, res) => {
    if (!exportKey) return res.status(404).json({ error: 'Not found' });
    if (!keyMatches(req.get('x-migration-key'), exportKey)) return res.status(403).json({ error: 'Wrong key' });
    const to = String(req.body?.url || '');
    if (to && !/^https?:\/\/[^\s/]+/.test(to)) return res.status(400).json({ error: 'Bad address' });
    store.flush();
    const payload = readDataDir(dataDir);
    if (to && to !== movedTo()) {
      store.data.meta = { ...(store.data.meta || {}), movedTo: to, movedAt: Date.now() };
      store.flush();
      console.log(`Data copied to ${to}. This server now forwards visitors there.`);
      setImmediate(() => io.disconnectSockets(true));
    }
    res.json(payload);
  });
  app.use('/shared', express.static(path.join(ROOT, 'shared')));
  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
  const page = (f) => (req, res) => res.sendFile(path.join(ROOT, 'public', f));
  app.get('/t/:id', page('table.html'));
  app.get(['/club/:id', '/join/:code', '/invite/:token', '/reset/:token', '/admin'], page('index.html'));
  app.get('/verify', page('verify.html'));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));

  const tokenOf = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const api = (fn, { needUser = true } = {}) => async (req, res) => {
    try {
      const user = auth.userForToken(tokenOf(req));
      if (needUser && !user) return res.status(401).json({ error: 'Please sign in again' });
      const out = await fn(req, user, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      if (!res.headersSent) res.status(e.status || 400).json({ error: e.message });
    }
  };
  const viewTable = (req, user) => {
    const t = tables.get(req.params.id);
    if (!t.canView(user)) throw new Error('This table is only open to club members');
    return t;
  };

  // ----- accounts -----
  const inviteOnly = (req, res) => res.status(403).json({ error: 'The Aquarium is invite only. Open the invite link you were sent, or sign in.' });
  app.post('/api/auth/guest', inviteOnly);
  app.post('/api/auth/register', inviteOnly);
  app.post('/api/auth/login', api((req) => {
    const r = auth.login(req.body || {}, req.ip);
    return { token: r.token, user: auth.publicUser(r.user) };
  }, { needUser: false }));
  app.post('/api/auth/logout', api((req) => { auth.logout(tokenOf(req)); return { ok: true }; }));
  app.get('/api/me', api((req, user) => ({ user: auth.publicUser(user), clubId: clubs.mainId(), clubs: clubs.forUser(user.id), tables: [] })));
  app.patch('/api/me', api((req, user) => ({ user: auth.publicUser(auth.rename(user, req.body.name)) })));

  // invite, owner setup and password reset links (no sign-in needed: the link is the key)
  const clubName = (id) => clubs.data[id]?.name || null;
  app.get('/api/links/:token', api((req) => {
    const info = auth.linkInfo(req.params.token);
    return { ...info, club: info.clubId ? clubName(info.clubId) : null, clubId: undefined };
  }, { needUser: false }));
  app.post('/api/links/:token', api((req) => {
    const r = auth.acceptLink(req.params.token, req.body || {}, req.ip);
    clubs.join(r.user.id); // everyone with an account is in the club
    return { token: r.token, user: auth.publicUser(r.user), kind: r.invite.kind, clubId: clubs.mainId() };
  }, { needUser: false }));

  // ----- the join link: anyone with it asks for an account, an admin approves -----
  app.get('/api/join/:token', api((req) => { auth.usableJoinLink(req.params.token); return { club: 'The Aquarium' }; }, { needUser: false }));
  app.post('/api/join/:token', api((req) => {
    const u = auth.requestAccount(req.params.token, req.body || {}, req.ip);
    clubs.changed(clubs.mainId()); // admins on the club page see the request come in
    return { name: u.name, username: u.username };
  }, { needUser: false }));
  app.get('/api/admin/join-link', api((req, user) => {
    auth.requireAdmin(user);
    const j = auth.joinLink();
    return { joinLink: j ? { token: j.token, createdAt: j.createdAt } : null, mail: !!mailer };
  }));
  app.post('/api/admin/join-link', api((req, user) => {
    const j = auth.setJoinLink(user, req.body?.on !== false);
    return { joinLink: j ? { token: j.token, createdAt: j.createdAt } : null };
  }));
  app.post('/api/admin/requests/:id', api((req, user) => {
    const u = auth.decideRequest(user, req.params.id, !!req.body?.approve);
    if (u) clubs.join(u.id);
    clubs.changed(clubs.mainId());
    return { ok: true };
  }));

  // ----- admin: people, invites, roles -----
  const linkUrl = (req, kind, token) => `${req.protocol}://${req.get('host')}/${kind === 'reset' ? 'reset' : 'invite'}/${token}`;
  async function deliver(inv, to, message) {
    if (!to) return { sent: false, error: 'This account has no email address' };
    if (!mailer) return { sent: false, error: null };
    try {
      await mailer.send({ to, ...message });
      inv.sentAt = Date.now();
      inv.sendError = null;
      store.save();
      return { sent: true };
    } catch (e) {
      inv.sendError = String(e.message || e).slice(0, 200);
      store.save();
      console.error('[mail]', inv.sendError);
      return { sent: false, error: 'The email did not go through. Copy the link and send it yourself.' };
    }
  }
  const sendInvite = (req, user, r) => {
    const link = linkUrl(req, 'join', r.token);
    const msg = inviteEmail({ link, inviter: user.name, club: null, name: r.invite.name, expiresAt: r.invite.expiresAt });
    return deliver(r.invite, r.invite.email, msg).then((m) => ({ ...m, link, email: r.invite.email, expiresAt: r.invite.expiresAt }));
  };
  app.get('/api/admin/people', api((req, user) => ({
    ...auth.people(user, clubName), me: auth.publicUser(user), mail: { on: !!mailer, from: mailer?.address || null },
  })));
  app.post('/api/admin/invites', api(async (req, user) => {
    const { email, name, days } = req.body || {};
    return sendInvite(req, user, auth.createInvite(user, { email, name, clubId: null, days }));
  }));
  app.post('/api/admin/invites/:id/renew', api(async (req, user) => sendInvite(req, user, auth.renewInvite(user, req.params.id, req.body?.days))));
  app.post('/api/admin/invites/:id/revoke', api((req, user) => { auth.revokeInvite(user, req.params.id); return { ok: true }; }));
  app.post('/api/admin/users/:id/role', api((req, user) => {
    const u = auth.setRole(user, req.params.id, req.body?.role);
    clubs.join(u.id); // admins manage the club ledger
    return { user: auth.publicUser(u) };
  }));
  app.post('/api/admin/users/:id/access', api((req, user) => {
    const u = auth.setAccess(user, req.params.id, !!req.body?.enabled);
    if (u.disabled) for (const sock of io.sockets.sockets.values()) if (sock.data.user?.id === u.id) sock.disconnect(true);
    return { ok: true };
  }));
  app.post('/api/admin/users/:id/reset', api(async (req, user) => {
    const r = auth.createReset(user, req.params.id);
    const target = auth.users[req.params.id];
    const link = linkUrl(req, 'reset', r.token);
    const m = await deliver(r.invite, target.email, resetEmail({ link, admin: user.name, username: target.username, expiresAt: r.invite.expiresAt }));
    return { ...m, link, email: target.email || null, expiresAt: r.invite.expiresAt };
  }));

  // ----- game presets (admins): saved Start a game settings, shared by the club's admins -----
  const presets = () => (store.data.presets ||= {});
  const presetName = (v) => {
    const n = String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
    if (!n) throw new Error('Give the preset a name');
    return n;
  };
  const presetBody = (body) => {
    const base = { ...structuredClone(DEFAULT_SETTINGS), autoApprove: true, autoStart: true };
    const settings = sanitizeSettings(body.settings || {}, base); // the same checks as starting a game
    return { name: presetName(body.name), tableName: String(body.tableName ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40), settings };
  };
  const listPresets = () => Object.values(presets()).sort((a, b) => a.name.localeCompare(b.name));
  const adminOnly = (user) => { if (!clubs.isManager(clubs.mainId(), user.id)) { const e = new Error('Only admins can save game presets'); e.status = 403; throw e; } };
  app.get('/api/presets', api((req, user) => { adminOnly(user); return { presets: listPresets() }; }));
  app.post('/api/presets', api((req, user) => {
    adminOnly(user);
    const b = presetBody(req.body || {});
    if (Object.values(presets()).some((x) => x.name.toLowerCase() === b.name.toLowerCase())) throw new Error('A preset with that name exists already. Pick it and save over it, or choose another name.');
    if (Object.keys(presets()).length >= 40) throw new Error('That is a lot of presets. Delete one first.');
    const id = Math.random().toString(36).slice(2, 10);
    presets()[id] = { id, ...b, createdBy: user.id, createdAt: Date.now(), updatedAt: Date.now() };
    store.save();
    return { preset: presets()[id], presets: listPresets() };
  }));
  app.put('/api/presets/:id', api((req, user) => {
    adminOnly(user);
    const cur = presets()[req.params.id];
    if (!cur) throw new Error('That preset was deleted');
    const b = presetBody({ name: cur.name, ...(req.body || {}) });
    if (Object.values(presets()).some((x) => x.id !== cur.id && x.name.toLowerCase() === b.name.toLowerCase())) throw new Error('Another preset has that name');
    Object.assign(cur, b, { updatedAt: Date.now(), updatedBy: user.id });
    store.save();
    return { preset: cur, presets: listPresets() };
  }));
  app.delete('/api/presets/:id', api((req, user) => {
    adminOnly(user);
    delete presets()[req.params.id];
    store.save();
    return { presets: listPresets() };
  }));

  // ----- tables -----
  app.post('/api/tables', api((req, user) => ({ id: tables.create(user, req.body || {}).id })));
  app.get('/api/tables/:id', api((req, user) => viewTable(req, user).summary(user.id)));
  // Ends a game from the home page: the hand in progress finishes, then everyone is cashed out.
  app.post('/api/tables/:id/end', api((req, user) => {
    const t = viewTable(req, user);
    t.hostEnd(user);
    return { status: t.status, ending: !!t.endAfterHand };
  }));
  app.get('/api/tables/:id/ledger', api((req, user) => viewTable(req, user).ledgerSummary()));
  app.get('/api/tables/:id/ledger.csv', api((req, user, res) => {
    const t = viewTable(req, user);
    res.type('text/csv').attachment(`ledger-${t.id}.csv`).send(t.ledgerCsv());
  }));
  app.get('/api/tables/:id/hands', api((req, user) => ({ hands: viewTable(req, user).handList(user.id) })));
  app.get('/api/tables/:id/hands/:n', api((req, user) => ({ record: viewTable(req, user).getRecord(req.params.n, user.id) })));
  app.get('/api/tables/:id/hands.json', api((req, user, res) => {
    const t = viewTable(req, user);
    const recs = t.getRecords().map((r) => t.publicRecord(r, user.id));
    res.type('application/json').attachment(`hands-${t.id}.json`).send(JSON.stringify(recs, null, 1));
  }));
  app.get('/api/tables/:id/log.txt', api((req, user, res) => {
    const t = viewTable(req, user);
    const lines = t.store.readLog(t.id).map((e) => `${new Date(e.at).toISOString()}  ${e.kind === 'chat' ? `${e.name}: ` : ''}${e.text}`);
    res.type('text/plain').attachment(`log-${t.id}.txt`).send(lines.join('\n'));
  }));

  // ----- clubs -----
  const clubView = (id, user) => {
    const club = clubs.view(id, user);
    if (auth.isAdmin(user)) club.requests = auth.requests(user); // people asking to join through the join link
    return { club, tables: clubs.role(id, user.id) ? tables.forClub(id, user.id) : [] };
  };
  app.post('/api/clubs', api((req, user) => ({ id: clubs.create(user, req.body || {}).id })));
  app.get('/api/clubs/invite/:code', api((req) => { const c = clubs.lookupInvite(req.params.code); return { id: c.id, name: c.name }; }));
  app.post('/api/clubs/join', api((req, user) => { const r = clubs.joinByCode(user, req.body.code); return { id: r.club.id, status: r.status }; }));
  app.get('/api/clubs/:id', api((req, user) => clubView(req.params.id, user)));
  app.get('/api/clubs/:id/stats', api((req, user) => {
    const v = clubs.view(req.params.id, user);
    if (!v.myStatus || v.myStatus !== 'active') throw new Error('Not a member');
    return { stats: tables.clubStats(req.params.id, user, { game: String(req.query.game || 'all'), seeAll: v.seeAll }) };
  }));
  app.get('/api/tables/:id/stats', api((req, user) => ({ stats: viewTable(req, user).statsView({ scope: String(req.query.scope || 'game'), game: String(req.query.game || 'all') }, user) })));
  app.patch('/api/clubs/:id', api((req, user) => { clubs.updateSettings(user, req.params.id, req.body || {}); return clubView(req.params.id, user); }));
  app.post('/api/clubs/:id/invite', api((req, user) => ({ inviteCode: clubs.regenerateInvite(user, req.params.id) })));
  app.post('/api/clubs/:id/tables', api((req, user) => ({ id: tables.create(user, { ...(req.body || {}), clubId: req.params.id }).id })));
  app.post('/api/clubs/:id/transfer', api((req, user) => { clubs.transfer(user, req.params.id, req.body.toUserId, req.body.amount, req.body.note); return clubView(req.params.id, user); }));
  app.get('/api/clubs/:id/transactions.csv', api((req, user, res) => {
    res.type('text/csv').attachment(`club-ledger-${req.params.id}.csv`).send(clubs.transactionsCsv(req.params.id, user));
  }));
  const memberRoute = (action, fn) => app.post(`/api/clubs/:id/members/:uid/${action}`, api((req, user) => {
    fn(user, req.params.id, req.params.uid, req.body || {});
    return clubView(req.params.id, user);
  }));
  memberRoute('decide', (u, c, m, b) => clubs.decideMember(u, c, m, !!b.approve));
  memberRoute('remove', (u, c, m) => clubs.removeMember(u, c, m));
  memberRoute('role', (u, c, m, b) => clubs.setRole(u, c, m, b.role));
  memberRoute('chips', (u, c, m, b) => clubs.adjustChips(u, c, m, b.amount, b.note));
  memberRoute('credit', (u, c, m, b) => clubs.setCreditLimit(u, c, m, b.limit));
  memberRoute('settle', (u, c, m, b) => clubs.settle(u, c, m, b.note));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ----- realtime -----
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 1e5, pingInterval: 20000, pingTimeout: 25000 });
  io.use((socket, next) => {
    if (movedTo()) return next(new Error('moved'));
    const user = auth.userForToken(socket.handshake.auth?.token);
    if (!user) return next(new Error('auth'));
    socket.data.user = user;
    next();
  });
  // Voice connects browser to browser. STUN lets most home connections find each other; a TURN relay
  // (TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL) carries the audio for networks that block that.
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  if (process.env.TURN_URLS) {
    iceServers.push({
      urls: process.env.TURN_URLS.split(',').map((x) => x.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || undefined, credential: process.env.TURN_CREDENTIAL || undefined,
    });
  }
  io.on('connection', (socket) => {
    const u = socket.data.user;
    let table = null;
    const T = () => { if (!table) throw new Error('Open a table first'); return table; };
    const on = (event, fn) => socket.on(event, (payload, ack) => {
      try {
        const r = fn(payload && typeof payload === 'object' ? payload : {});
        if (typeof ack === 'function') ack({ ok: true, ...(r || {}) });
      } catch (e) {
        if (typeof ack === 'function') ack({ ok: false, error: e.message });
      }
    });
    on('table:join', ({ tableId }) => {
      const t = tables.get(tableId);
      if (table && table !== t) table.leave(socket);
      table = t;
      t.join(socket);
    });
    on('seat:request', (p) => T().requestSeat(u, p));
    on('seat:cancel', () => T().cancelRequest(u));
    on('chips:request', (p) => T().requestChips(u, p.amount));
    on('action', (p) => T().playerAction(u, p));
    on('rit', (p) => T().chooseRuns(u, p.runs));
    on('sitout', (p) => T().setSitOut(u, !!p.value));
    on('standup', () => T().standUp(u));
    on('show', (p) => T().showCards(u, Array.isArray(p.cards) ? p.cards : null));
    on('fair:contribute', (p) => T().contribute(u, p));
    on('chat', (p) => T().chat(u, p.text));
    on('hands:list', () => ({ hands: T().handList(u.id) }));
    on('hand:get', (p) => ({ record: T().getRecord(p.handNumber, u.id) }));
    on('ledger:get', () => ({ ledger: T().ledgerSummary() }));
    on('stats:get', (p) => ({ stats: T().statsView(p, u) }));
    on('host:decide', (p) => T().hostDecide(u, p.requestId, !!p.approve));
    on('host:settings', (p) => T().hostSettings(u, p.settings || {}));
    on('host:start', () => T().hostStart(u));
    on('host:pause', (p) => T().hostPause(u, !!p.value));
    on('host:end', () => T().hostEnd(u));
    on('host:extend', (p) => T().hostExtend(u, p.minutes));
    on('host:clearTime', () => T().hostClearTimeLimit(u));
    on('host:bomb', (p) => T().hostBombNext(u, p.value !== false));
    on('host:kick', (p) => T().hostKick(u, p.userId));
    on('host:away', (p) => T().hostSetAway(u, p.userId));
    on('host:adjust', (p) => T().hostAdjustStack(u, p.userId, p.delta));
    on('host:reveal', () => T().hostRevealNow(u));
    on('voice:join', () => ({ ...T().voiceJoin(socket), iceServers }));
    on('voice:leave', () => T().voiceLeave(socket));
    on('voice:signal', (p) => T().voiceSignal(socket, p));
    on('voice:mute', (p) => T().voiceMute(socket, !!p.muted));
    on('club:watch', (p) => { if (clubs.role(p.clubId, u.id)) socket.join('club:' + p.clubId); });
    socket.on('disconnect', () => { if (table) table.leave(socket); });
  });
  clubs.onChange((clubId) => io.to('club:' + clubId).emit('club:changed', { clubId }));

  return {
    app, server, io, store, auth, clubs, tables, ownerSetupToken, mailer,
    listen(port = Number(process.env.PORT) || 3000) {
      return new Promise((resolve) => server.listen(port, () => resolve(server.address().port)));
    },
    close() {
      store.flush();
      for (const t of tables.tables.values()) {
        for (const k of ['action', 'advance', 'next', 'rit']) clearTimeout(t.timers[k]);
        for (const x of t.timers.session) clearTimeout(x);
      }
      return new Promise((resolve) => {
        io.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataDir = process.env.DATA_DIR || path.join(ROOT, 'data');
  const port = Number(process.env.PORT) || 3000;
  // a new server pulls its data from the old one on first boot (see migrate.js)
  await importIfNeeded({
    dataDir, from: process.env.IMPORT_FROM, key: process.env.MIGRATION_KEY,
    self: process.env.RENDER_EXTERNAL_URL || '', holdPort: port,
  });
  const srv = createServer({ dataDir });
  srv.listen(port).then((p) => {
    console.log(`The Aquarium is running on http://localhost:${p}`);
    console.log(srv.mailer ? `Invites are emailed from ${srv.mailer.address}.` : 'Email is not set up (SMTP_USER and SMTP_PASS): admins copy invite links themselves.');
    if (srv.ownerSetupToken) {
      const base = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${p}`).replace(/\/+$/, '');
      console.log(`This site has no owner yet. Open this link to set it up (it works once): ${base}/invite/${srv.ownerSetupToken}`);
    }
  });
  const shutdown = () => { try { srv.store.flush(); } finally { process.exit(0); } };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
