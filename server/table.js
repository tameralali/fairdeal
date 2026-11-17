// Table: seats, host controls, hand lifecycle, timers, ledger and the fairness commit/reveal cycle.
import { randomInt } from 'node:crypto';
import { Hand } from './engine/hand.js';
import { GAME_TYPES } from '../shared/cards.js';
import { isValidContribution, FAIRNESS_VERSION } from '../shared/fairness.js';
import { newCommitment, settleCommitment, randomId } from './fair-node.js';
import { cleanName } from './auth.js';

export const DELAYS = {
  street: 700, runoutFirst: 1800, runout: 1300, showdown: 900,
  afterUncontested: 2500, afterShowdown: 5000, perExtraRun: 1500,
  rit: 15000, autoAct: 400,
};

export const DEFAULT_SETTINGS = {
  games: ['nlh'],
  rotateEvery: 'orbit',
  rotateHands: 10,
  smallBlind: 5,
  bigBlind: 10,
  minBuyIn: 0,
  maxBuyIn: 0,
  maxPlayers: 9,
  decisionSeconds: 30,
  timeBankSeconds: 60,
  autoApprove: false,
  bombPot: { mode: 'off', every: 10, percent: 10, anteBB: 2, game: 'current' },
  rit: { enabled: true, maxRuns: 4 },
  sessionMinutes: 0,
  revealPolicy: 'hand',
  feltColor: '#1d6b48',
  decimals: 0,
  spectatorChat: true,
  autoStart: false,
};

const fail = (m) => { throw new Error(m); };
function intIn(v, lo, hi, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < lo || n > hi) fail(`${label} must be a whole number from ${lo} to ${hi}`);
  return n;
}
function numIn(v, lo, hi, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) fail(`${label} must be between ${lo} and ${hi}`);
  return Math.round(n * 100) / 100;
}

export function sanitizeSettings(input = {}, current = DEFAULT_SETTINGS, ctx = {}) {
  const s = structuredClone(current);
  const has = (k) => input[k] !== undefined && input[k] !== null;
  if (has('games')) {
    const g = [...new Set([].concat(input.games))].filter((x) => GAME_TYPES[x]);
    if (!g.length) fail('Pick at least one game');
    s.games = g;
  }
  if (has('rotateEvery')) s.rotateEvery = input.rotateEvery === 'hands' ? 'hands' : 'orbit';
  if (has('rotateHands')) s.rotateHands = intIn(input.rotateHands, 1, 200, 'Hands per game');
  if (has('smallBlind')) s.smallBlind = intIn(input.smallBlind, 1, 1e12, 'Small blind');
  if (has('bigBlind')) s.bigBlind = intIn(input.bigBlind, 1, 1e12, 'Big blind');
  if (s.smallBlind > s.bigBlind) fail('The small blind cannot be bigger than the big blind');
  if (has('minBuyIn')) s.minBuyIn = intIn(input.minBuyIn, 0, 1e13, 'Minimum buy-in');
  if (has('maxBuyIn')) s.maxBuyIn = intIn(input.maxBuyIn, 0, 1e13, 'Maximum buy-in');
  if (s.maxBuyIn && s.minBuyIn > s.maxBuyIn) fail('The minimum buy-in is above the maximum');
  if (has('maxPlayers')) s.maxPlayers = intIn(input.maxPlayers, 2, 10, 'Seats');
  if (has('decisionSeconds')) s.decisionSeconds = intIn(input.decisionSeconds, 5, 600, 'Decision time');
  if (has('timeBankSeconds')) s.timeBankSeconds = intIn(input.timeBankSeconds, 0, 3600, 'Time bank');
  for (const k of ['autoApprove', 'spectatorChat', 'autoStart']) if (has(k)) s[k] = !!input[k];
  if (has('bombPot')) {
    const b = input.bombPot;
    s.bombPot = {
      mode: ['off', 'every', 'percent'].includes(b.mode) ? b.mode : s.bombPot.mode,
      every: b.every !== undefined ? intIn(b.every, 2, 1000, 'Bomb pot frequency (hands)') : s.bombPot.every,
      percent: b.percent !== undefined ? numIn(b.percent, 1, 100, 'Bomb pot chance (%)') : s.bombPot.percent,
      anteBB: b.anteBB !== undefined ? numIn(b.anteBB, 0.5, 100, 'Bomb pot size (big blinds)') : s.bombPot.anteBB,
      game: ['current', ...Object.keys(GAME_TYPES)].includes(b.game) ? b.game : s.bombPot.game,
    };
  }
  if (has('rit')) {
    const r = input.rit;
    s.rit = {
      enabled: r.enabled !== undefined ? !!r.enabled : s.rit.enabled,
      maxRuns: r.maxRuns !== undefined ? intIn(r.maxRuns, 2, 4, 'Maximum runs') : s.rit.maxRuns,
    };
  }
  if (has('sessionMinutes')) s.sessionMinutes = intIn(input.sessionMinutes, 0, 24 * 60, 'Time limit (minutes)');
  if (has('revealPolicy')) s.revealPolicy = input.revealPolicy === 'session' ? 'session' : 'hand';
  if (has('feltColor')) {
    if (!/^#[0-9a-fA-F]{6}$/.test(input.feltColor)) fail('Felt color must be a hex color like #1d6b48');
    s.feltColor = input.feltColor.toLowerCase();
  }
  if (has('decimals')) s.decimals = Number(input.decimals) === 2 ? 2 : 0;
  const games = [...s.games, s.bombPot.game].filter((g) => g !== 'current');
  const cap = Math.min(...games.map((g) => GAME_TYPES[g].maxPlayers));
  if (s.maxPlayers > cap) fail(`PLO5 deals five cards to everyone, so a table that uses it can have at most ${cap} seats`);
  if (ctx.highestSeat !== undefined && ctx.highestSeat >= 0 && s.maxPlayers <= ctx.highestSeat) fail('Someone is sitting in a seat you are removing');
  return s;
}

const TIMES = ['', 'once', 'twice', 'three times', 'four times'];

export class Table {
  constructor(manager, data) {
    this.manager = manager;
    this.id = data.id;
    this.name = data.name;
    this.clubId = data.clubId || null;
    this.ownerId = data.ownerId;
    this.createdAt = data.createdAt || Date.now();
    this.settings = data.settings;
    this.status = data.status || 'waiting';
    this.paused = !!data.paused;
    this.handNumber = data.handNumber || 0;
    this.buttonSeat = data.buttonSeat ?? null;
    this.revealedThrough = data.revealedThrough || 0;
    this.session = data.session || { startedAt: null, endsAt: null };
    this.rotation = data.rotation || { index: 0, seen: [], count: 0 };
    this.handsSinceBomb = data.handsSinceBomb || 0;
    this.ledger = data.ledger || [];
    this.requests = data.requests || [];
    this.endedAt = data.endedAt || null;
    this.players = new Map();
    this.seats = Array(10).fill(null);
    for (const p of data.players || []) {
      this.players.set(p.userId, { sittingOut: false, sitOutNext: false, away: false, leaveAfterHand: false, kicked: false, pendingChips: 0, ...p });
      this.seats[p.seat] = p.userId;
    }
    this.hand = null;
    this.lastHand = null;
    this.handMeta = null;
    this.turn = null;
    this.ritDeadline = null;
    this.timers = { session: [] };
    this.sockets = new Set();
    this.logEntries = null;
    this.logSeq = data.logSeq || 0;
    this.pendingLog = [];
    this.records = null;
    this.chatTimes = new Map();
    this.bombNext = false;
    this.endAfterHand = false;
    this.broadcastQueued = false;
    this.fair = { pending: newCommitment(this.handNumber + 1) };
  }

  get store() { return this.manager.store; }
  get clubs() { return this.manager.clubs; }
  get decimals() {
    if (this.clubId) return this.clubs.data[this.clubId]?.settings.decimals || 0;
    return this.settings.decimals || 0;
  }
  fmt(a) {
    const d = this.decimals;
    return (d ? a / 100 : a).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  isHost(userId) {
    return userId === this.ownerId || (!!this.clubId && this.clubs.isManager(this.clubId, userId));
  }
  requireHost(user) { if (!this.isHost(user.id)) fail('Only the host can do that'); }
  canView(user) {
    if (!this.clubId) return true;
    return !!this.clubs.role(this.clubId, user.id);
  }
  assertOpen() { if (this.status === 'ended') fail('This game has ended'); }
  isConnected(userId) {
    for (const s of this.sockets) if (s.data.user.id === userId) return true;
    return false;
  }
  inHand(userId) {
    return !!(this.hand && this.hand.phase !== 'done' && this.hand.byId(userId));
  }
  currentChips(p) {
    if (this.inHand(p.userId)) {
      const hp = this.hand.byId(p.userId);
      return hp.stack + hp.committed;
    }
    return p.stack;
  }
  safe(fn) {
    return (...args) => {
      try { fn.apply(this, args); } catch (e) { console.error(`[table ${this.id}]`, e); this.log(`Server error: ${e.message}`, 'error'); }
    };
  }

  // ---------- logging, broadcast, persistence ----------
  loadLog() {
    if (!this.logEntries) {
      this.logEntries = this.store.readLog(this.id).slice(-1500);
      if (this.logEntries.length) this.logSeq = Math.max(this.logSeq, this.logEntries[this.logEntries.length - 1].id);
    }
    return this.logEntries;
  }

  log(text, kind = 'info', extra = {}) {
    this.loadLog();
    const e = { id: ++this.logSeq, at: Date.now(), kind, text, hand: this.hand && this.hand.phase !== 'done' ? this.hand.number : null, ...extra };
    this.logEntries.push(e);
    if (this.logEntries.length > 2000) this.logEntries.splice(0, 500);
    this.store.appendLog(this.id, e);
    this.pendingLog.push(e);
    if (this.handMeta && this.hand && kind !== 'chat') this.handMeta.logLines.push(text);
    this.broadcast();
  }

  broadcast() {
    if (this.broadcastQueued) return;
    this.broadcastQueued = true;
    setImmediate(() => {
      this.broadcastQueued = false;
      const logs = this.pendingLog;
      this.pendingLog = [];
      for (const s of this.sockets) {
        if (logs.length) s.emit('log', logs);
        s.emit('state', this.stateFor(s.data.user.id));
      }
    });
  }

  emitAll(event, payload) { for (const s of this.sockets) s.emit(event, payload); }
  emitTo(userId, event, payload) { for (const s of this.sockets) if (s.data.user.id === userId) s.emit(event, payload); }

  snapshot() {
    this.store.data.tables[this.id] = {
      id: this.id, name: this.name, clubId: this.clubId, ownerId: this.ownerId, createdAt: this.createdAt,
      settings: this.settings, status: this.status, paused: this.paused, handNumber: this.handNumber,
      buttonSeat: this.buttonSeat, revealedThrough: this.revealedThrough, session: this.session,
      rotation: this.rotation, handsSinceBomb: this.handsSinceBomb, ledger: this.ledger,
      requests: this.requests, endedAt: this.endedAt, logSeq: this.logSeq,
      players: [...this.players.values()].map((p) => ({
        userId: p.userId, name: p.name, seat: p.seat, stack: p.stack, sittingOut: p.sittingOut,
        timeBank: p.timeBank, joinedAt: p.joinedAt,
      })),
    };
    this.store.save();
  }

  getRecords() {
    if (!this.records) this.records = this.store.readHands(this.id);
    return this.records;
  }

  // ---------- sockets ----------
  join(socket) {
    if (!this.canView(socket.data.user)) fail('This table is only open to club members');
    this.sockets.add(socket);
    socket.emit('log:reset', this.loadLog().slice(-400));
    socket.emit('state', this.stateFor(socket.data.user.id));
    this.broadcast();
  }
  leave(socket) {
    this.sockets.delete(socket);
    this.broadcast();
    // a disconnected player in a run-it choice defaults to once
    if (this.hand && this.hand.phase === 'rit') this.afterHandChange();
  }

  // ---------- seats and chips ----------
  checkBuyIn(amount, current = 0) {
    const s = this.settings;
    if (!Number.isInteger(amount) || amount <= 0) fail('Enter a positive amount');
    if (s.minBuyIn && current === 0 && amount < s.minBuyIn) fail(`Minimum buy-in is ${this.fmt(s.minBuyIn)}`);
    if (s.maxBuyIn && current + amount > s.maxBuyIn) fail(`Maximum stack is ${this.fmt(s.maxBuyIn)}${current ? ` (you have ${this.fmt(current)})` : ''}`);
  }

  requestSeat(user, { seat, buyIn, name }) {
    this.assertOpen();
    seat = Number(seat);
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.settings.maxPlayers) fail('That seat does not exist');
    if (this.seats[seat]) fail('That seat is taken');
    if (this.players.has(user.id)) fail('You are already seated');
    const nick = cleanName(name || user.name);
    for (const p of this.players.values()) if (p.name.toLowerCase() === nick.toLowerCase()) fail('Someone at the table already uses that name');
    buyIn = Number(buyIn);
    this.checkBuyIn(buyIn);
    if (this.clubId) {
      if (!this.clubs.role(this.clubId, user.id)) fail('Only club members can sit at this table');
      const avail = this.clubs.available(this.clubId, user.id);
      if (buyIn > avail) fail(`You have ${this.fmt(Math.max(0, avail))} club chips available`);
    }
    this.requests = this.requests.filter((r) => r.userId !== user.id || r.type !== 'seat');
    if (this.isHost(user.id) || this.settings.autoApprove) {
      this.seatPlayer(user.id, nick, seat, buyIn, null);
      return { seated: true };
    }
    this.requests.push({ id: randomId(5), type: 'seat', userId: user.id, name: nick, seat, amount: buyIn, at: Date.now() });
    this.emitHosts('request', { name: nick, type: 'seat', amount: this.fmt(buyIn) });
    this.snapshot();
    this.broadcast();
    return { pending: true };
  }

  emitHosts(event, payload) {
    for (const s of this.sockets) if (this.isHost(s.data.user.id)) s.emit(event, payload);
  }

  seatPlayer(userId, name, seat, amount, approvedBy) {
    if (this.seats[seat]) fail('That seat is taken');
    if (this.players.has(userId)) fail('Already seated');
    if (this.clubId) this.clubs.buyIn(this.clubId, userId, amount, this);
    const p = {
      userId, name, seat, stack: amount, sittingOut: false, sitOutNext: false, away: false,
      leaveAfterHand: false, kicked: false, pendingChips: 0, timeBank: this.settings.timeBankSeconds, joinedAt: Date.now(),
    };
    this.players.set(userId, p);
    this.seats[seat] = userId;
    this.ledgerAdd(p, 'buyin', amount, approvedBy ? `approved by ${approvedBy}` : '');
    this.log(approvedBy
      ? `The host approved ${name} in seat ${seat + 1} with a stack of ${this.fmt(amount)}`
      : `${name} sat in seat ${seat + 1} with a stack of ${this.fmt(amount)}`, 'seat');
    this.snapshot();
    this.maybeStartHand();
  }

  ledgerAdd(p, type, amount, note = '') {
    this.ledger.push({ at: Date.now(), userId: p.userId, name: p.name, type, amount, note });
  }

  requestChips(user, amount) {
    this.assertOpen();
    const p = this.players.get(user.id);
    if (!p) fail('Sit down first');
    amount = Number(amount);
    if (!Number.isInteger(amount) || amount <= 0) fail('Enter a positive amount');
    const s = this.settings;
    if (s.maxBuyIn && p.stack + p.pendingChips + amount > s.maxBuyIn) {
      fail(`Maximum stack is ${this.fmt(s.maxBuyIn)}; you can add up to ${this.fmt(Math.max(0, s.maxBuyIn - p.stack - p.pendingChips))}`);
    }
    if (this.clubId) {
      const avail = this.clubs.available(this.clubId, user.id) - p.pendingChips;
      if (amount > avail) fail(`You have ${this.fmt(Math.max(0, avail))} club chips available`);
    }
    if (this.isHost(user.id) || s.autoApprove) {
      this.queueChips(p, amount, null);
      return { added: true };
    }
    this.requests = this.requests.filter((r) => !(r.userId === user.id && r.type === 'chips'));
    this.requests.push({ id: randomId(5), type: 'chips', userId: user.id, name: p.name, seat: p.seat, amount, at: Date.now() });
    this.emitHosts('request', { name: p.name, type: 'chips', amount: this.fmt(amount) });
    this.snapshot();
    this.broadcast();
    return { pending: true };
  }

  queueChips(p, amount, approvedBy) {
    if (this.inHand(p.userId)) {
      p.pendingChips += amount;
      this.log(`${p.name} will add ${this.fmt(amount)} after this hand`, 'chips');
    } else {
      this.applyChips(p, amount, approvedBy);
    }
    this.snapshot();
    this.broadcast();
  }

  applyChips(p, amount, approvedBy) {
    if (this.clubId) this.clubs.buyIn(this.clubId, p.userId, amount, this);
    p.stack += amount;
    this.ledgerAdd(p, 'buyin', amount, approvedBy ? `approved by ${approvedBy}` : 'add-on');
    this.log(`${p.name} added ${this.fmt(amount)} (stack ${this.fmt(p.stack)})`, 'chips');
    this.maybeStartHand();
  }

  cancelRequest(user) {
    this.requests = this.requests.filter((r) => r.userId !== user.id);
    this.snapshot();
    this.broadcast();
  }

  standUp(user) {
    const p = this.players.get(user.id);
    if (!p) fail('You are not seated');
    this.requests = this.requests.filter((r) => r.userId !== user.id);
    if (this.inHand(p.userId)) {
      p.leaveAfterHand = true;
      this.log(`${p.name} will stand up after this hand`, 'seat');
      this.afterHandChange();
    } else {
      this.removePlayer(p, 'stood up');
    }
  }

  removePlayer(p, reason) {
    const amount = p.stack;
    this.seats[p.seat] = null;
    this.players.delete(p.userId);
    this.ledgerAdd(p, 'cashout', amount, reason);
    if (this.clubId) this.clubs.cashOut(this.clubId, p.userId, amount, this);
    this.requests = this.requests.filter((r) => r.userId !== p.userId);
    const verb = reason === 'kicked' ? 'was removed by the host' : reason === 'game ended' ? 'cashed out' : 'stood up';
    this.log(`${p.name} ${verb} with a stack of ${this.fmt(amount)}`, 'seat');
    this.snapshot();
    this.broadcast();
  }

  setSitOut(user, value) {
    const p = this.players.get(user.id);
    if (!p) fail('You are not seated');
    if (value) {
      if (this.inHand(p.userId)) p.sitOutNext = true;
      else p.sittingOut = true;
      this.log(`${p.name} is sitting out`, 'seat');
    } else {
      const was = p.sittingOut || p.sitOutNext;
      p.sittingOut = false;
      p.sitOutNext = false;
      p.away = false;
      if (was) this.log(`${p.name} is back`, 'seat');
      this.maybeStartHand();
    }
    this.snapshot();
    this.broadcast();
  }

  // ---------- host controls ----------
  hostDecide(host, requestId, approve) {
    this.requireHost(host);
    const r = this.requests.find((x) => x.id === requestId);
    if (!r) fail('That request is no longer pending');
    this.requests = this.requests.filter((x) => x.id !== requestId);
    if (!approve) {
      this.emitTo(r.userId, 'toast', { text: r.type === 'seat' ? 'Your seat request was declined' : 'Your chip request was declined' });
      this.snapshot();
      this.broadcast();
      return;
    }
    if (r.type === 'seat') {
      if (this.seats[r.seat]) fail('That seat was taken in the meantime');
      this.seatPlayer(r.userId, r.name, r.seat, r.amount, host.name);
    } else {
      const p = this.players.get(r.userId);
      if (!p) fail('That player has left');
      this.queueChips(p, r.amount, host.name);
    }
    this.broadcast();
  }

  hostKick(host, userId) {
    this.requireHost(host);
    const p = this.players.get(userId);
    if (!p) fail('Not seated');
    if (this.inHand(userId)) {
      p.leaveAfterHand = true;
      p.kicked = true;
      this.log(`The host will remove ${p.name} after this hand`, 'seat');
      this.afterHandChange();
    } else {
      this.removePlayer(p, 'kicked');
    }
  }

  hostSetAway(host, userId) {
    this.requireHost(host);
    const p = this.players.get(userId);
    if (!p) fail('Not seated');
    if (this.inHand(userId)) p.sitOutNext = true;
    else p.sittingOut = true;
    this.log(`The host set ${p.name} to sitting out`, 'seat');
    this.snapshot();
    this.broadcast();
  }

  hostAdjustStack(host, userId, delta) {
    this.requireHost(host);
    if (this.clubId) fail('Club table stacks come from member balances: credit the member in the club ledger and they can add chips');
    const p = this.players.get(userId);
    if (!p) fail('Not seated');
    delta = Number(delta);
    if (!Number.isInteger(delta) || delta === 0) fail('Enter a non-zero whole amount');
    if (this.inHand(userId)) fail('Wait until the hand is over');
    if (p.stack + delta < 0) fail('Stack cannot go below zero');
    p.stack += delta;
    this.ledgerAdd(p, 'adjust', delta, `by ${host.name}`);
    this.log(`The host ${delta > 0 ? 'added' : 'removed'} ${this.fmt(Math.abs(delta))} ${delta > 0 ? 'to' : 'from'} ${p.name}'s stack (now ${this.fmt(p.stack)})`, 'chips');
    this.snapshot();
    this.maybeStartHand();
    this.broadcast();
  }

  hostStart(host) {
    this.requireHost(host);
    this.assertOpen();
    if (this.status === 'running') return;
    this.startSession();
    this.log('The game has started', 'game');
    this.maybeStartHand();
  }

  startSession() {
    this.status = 'running';
    this.paused = false;
    this.session.startedAt = Date.now();
    this.session.endsAt = this.settings.sessionMinutes ? Date.now() + this.settings.sessionMinutes * 60000 : null;
    this.scheduleSession();
    this.snapshot();
    this.broadcast();
  }

  hostPause(host, value) {
    this.requireHost(host);
    this.paused = !!value;
    this.log(value ? (this.hand && this.hand.phase !== 'done' ? 'The host paused the game; it will stop after this hand' : 'The host paused the game') : 'The host resumed the game', 'game');
    this.snapshot();
    if (!value) this.maybeStartHand();
    this.broadcast();
  }

  hostEnd(host) {
    this.requireHost(host);
    this.endGame('host');
  }

  hostExtend(host, minutes) {
    this.requireHost(host);
    this.assertOpen();
    minutes = intIn(minutes, -600, 600, 'Minutes');
    const base = this.session.endsAt || Date.now();
    this.session.endsAt = Math.max(Date.now() + 60000, base + minutes * 60000);
    this.endAfterHand = false;
    this.scheduleSession();
    const left = Math.round((this.session.endsAt - Date.now()) / 60000);
    this.log(`The host changed the time limit: ${left} minute${left === 1 ? '' : 's'} left`, 'game');
    this.snapshot();
    this.broadcast();
  }

  hostClearTimeLimit(host) {
    this.requireHost(host);
    this.session.endsAt = null;
    this.settings.sessionMinutes = 0;
    this.endAfterHand = false;
    this.scheduleSession();
    this.log('The host removed the time limit', 'game');
    this.snapshot();
    this.broadcast();
  }

  hostBombNext(host, value = true) {
    this.requireHost(host);
    this.bombNext = !!value;
    this.log(value ? 'The host called a bomb pot for the next hand' : 'The host cancelled the bomb pot', 'game');
    this.broadcast();
  }

  hostRevealNow(host) {
    this.requireHost(host);
    const last = this.getRecords().at(-1);
    if (!last) fail('No completed hands yet');
    this.reveal(last.handNumber);
    this.log(`The host revealed the shuffle seeds for all hands through #${last.handNumber}`, 'fair');
  }

  hostSettings(host, input) {
    this.requireHost(host);
    this.assertOpen();
    let highestSeat = -1;
    for (const p of this.players.values()) highestSeat = Math.max(highestSeat, p.seat);
    if (input.decimals !== undefined && Number(input.decimals) !== this.settings.decimals && this.ledger.length) {
      fail('Chip display can only change before anyone buys in');
    }
    const before = this.settings;
    const next = sanitizeSettings(input, before, { highestSeat });
    const changes = describeChanges(before, next, (a) => this.fmt(a));
    this.settings = next;
    if (JSON.stringify(before.games) !== JSON.stringify(next.games)) this.rotation = { index: 0, seen: [], count: 0 };
    if (before.sessionMinutes !== next.sessionMinutes && this.status === 'running') {
      this.session.endsAt = next.sessionMinutes ? (this.session.startedAt || Date.now()) + next.sessionMinutes * 60000 : null;
      if (this.session.endsAt && this.session.endsAt < Date.now() + 60000) this.session.endsAt = Date.now() + 60000;
      this.scheduleSession();
    }
    if (input.name !== undefined) {
      const n = String(input.name).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
      if (n && n !== this.name) { changes.push(`table name: ${n}`); this.name = n; }
    }
    if (before.revealPolicy === 'session' && next.revealPolicy === 'hand') {
      const last = this.getRecords().at(-1);
      if (last) this.reveal(last.handNumber);
    }
    if (changes.length) this.log(`The host updated the game (applies from the next hand): ${changes.join('; ')}`, 'game');
    this.snapshot();
    this.broadcast();
    this.maybeStartHand();
  }

  // ---------- session clock ----------
  scheduleSession() {
    for (const t of this.timers.session) clearTimeout(t);
    this.timers.session = [];
    if (this.status !== 'running' || !this.session.endsAt) return;
    const left = this.session.endsAt - Date.now();
    for (const m of [30, 10, 5, 1]) {
      const at = left - m * 60000;
      if (at > 0) this.timers.session.push(setTimeout(this.safe(() => this.log(`${m} minute${m > 1 ? 's' : ''} left in this game`, 'game')), at));
    }
    this.timers.session.push(setTimeout(this.safe(() => this.onSessionTime()), Math.max(0, left)));
  }

  onSessionTime() {
    if (this.status !== 'running') return;
    if (this.hand && this.hand.phase !== 'done') {
      this.endAfterHand = 'time';
      this.log('Time is up: this is the last hand', 'game');
      this.broadcast();
    } else {
      this.endGame('time');
    }
  }

  endGame(reason) {
    if (this.status === 'ended') return;
    if (this.hand && this.hand.phase !== 'done') {
      this.endAfterHand = reason;
      this.log('The game will end after this hand', 'game');
      this.broadcast();
      return;
    }
    for (const k of ['action', 'advance', 'next', 'rit']) { clearTimeout(this.timers[k]); this.timers[k] = null; }
    for (const t of this.timers.session) clearTimeout(t);
    this.timers.session = [];
    this.status = 'ended';
    this.endedAt = Date.now();
    this.endAfterHand = false;
    for (const p of [...this.players.values()]) this.removePlayer(p, 'game ended');
    this.requests = [];
    const last = this.getRecords().at(-1);
    if (last) this.reveal(last.handNumber);
    this.log(reason === 'time' ? 'Time is up. The game has ended.' : 'The game has ended.', 'game');
    this.snapshot();
    this.broadcast();
  }

  // ---------- fairness ----------
  contribute(user, { handNumber, commitment, seed }) {
    const pend = this.fair.pending;
    if (!pend || pend.handNumber !== handNumber || pend.commitment !== commitment) return { stale: true };
    const p = this.players.get(user.id);
    if (!p) return { notSeated: true };
    if (!isValidContribution(seed)) fail('Invalid contribution');
    if (pend.contributions.has(user.id)) return { already: true };
    pend.contributions.set(user.id, { userId: user.id, name: p.name, seat: p.seat, seed });
    this.broadcast();
    return { ok: true };
  }

  reveal(through) {
    if (through <= this.revealedThrough) return;
    this.revealedThrough = through;
    this.emitAll('hands:revealed', { through });
    this.snapshot();
    this.broadcast();
  }

  publicRecord(rec, viewerId) {
    const revealed = rec.handNumber <= this.revealedThrough;
    const out = structuredClone(rec);
    out.revealed = revealed;
    if (!revealed) {
      out.fairness.serverSeed = null;
      out.fairness.deck = null;
      const visible = {};
      for (const p of rec.players) if (p.shown || p.userId === viewerId) visible[p.seat] = rec.dealt.holes[p.seat];
      out.dealt.holes = visible;
    }
    return out;
  }

  handList(viewerId) {
    return this.getRecords().slice(-400).reverse().map((r) => {
      const me = r.players.find((p) => p.userId === viewerId);
      const pot = (r.results?.pots || []).reduce((s, p) => s + p.amount, 0);
      return {
        handNumber: r.handNumber, at: r.startedAt, gameType: r.gameType, isBomb: r.isBomb, runCount: r.runCount,
        pot, winners: [...new Set((r.results?.payouts || []).map((w) => w.name))], revealed: r.handNumber <= this.revealedThrough,
        myNet: me ? me.net : null, commitment: r.fairness.commitment,
      };
    });
  }

  getRecord(handNumber, viewerId) {
    const r = this.getRecords().find((x) => x.handNumber === Number(handNumber));
    if (!r) fail('Hand not found');
    return this.publicRecord(r, viewerId);
  }

  // ---------- hand lifecycle ----------
  eligiblePlayers() {
    return [...this.players.values()]
      .filter((p) => !p.sittingOut && !p.leaveAfterHand && p.stack > 0)
      .sort((a, b) => a.seat - b.seat);
  }

  maybeStartHand() {
    if (this.status !== 'running' || this.paused || this.timers.next) return;
    if (this.hand && this.hand.phase !== 'done') return;
    this.startHand();
    this.broadcast();
  }

  pickButton(eligible) {
    if (this.buttonSeat === null || this.buttonSeat === undefined) return eligible[randomInt(eligible.length)].seat;
    const after = eligible.find((p) => p.seat > this.buttonSeat);
    return (after || eligible[0]).seat;
  }

  pickGame() {
    const games = this.settings.games;
    if (games.length === 1) return games[0];
    const btnUser = this.seats[this.buttonSeat];
    let switched = false;
    if (this.settings.rotateEvery === 'orbit') {
      if (this.rotation.seen.includes(btnUser)) {
        this.rotation.index = (this.rotation.index + 1) % games.length;
        this.rotation.seen = [];
        switched = true;
      }
      this.rotation.seen.push(btnUser);
    } else {
      if (this.rotation.count >= this.settings.rotateHands) {
        this.rotation.index = (this.rotation.index + 1) % games.length;
        this.rotation.count = 0;
        switched = true;
      }
      this.rotation.count++;
    }
    const g = games[this.rotation.index % games.length];
    if (switched) this.log(`Switching to ${GAME_TYPES[g].name}`, 'game');
    return g;
  }

  rotationInfo() {
    const games = this.settings.games;
    if (games.length < 2) return null;
    const current = games[this.rotation.index % games.length];
    const next = games[(this.rotation.index + 1) % games.length];
    let left;
    if (this.settings.rotateEvery === 'orbit') {
      const active = this.eligiblePlayers().map((p) => p.userId);
      left = active.filter((u) => !this.rotation.seen.includes(u)).length;
    } else {
      left = Math.max(0, this.settings.rotateHands - this.rotation.count);
    }
    return { current, next, handsLeft: left, every: this.settings.rotateEvery };
  }

  startHand() {
    clearTimeout(this.timers.next);
    this.timers.next = null;
    for (const p of this.players.values()) {
      if (p.sitOutNext) { p.sittingOut = true; p.sitOutNext = false; }
    }
    const eligible = this.eligiblePlayers();
    if (eligible.length < 2) return false;
    try {
      this.buttonSeat = this.pickButton(eligible);
      let gameType = this.pickGame();
      const pend = this.fair.pending;
      const settled = settleCommitment(this.id, pend);
      const s = this.settings;
      const bp = s.bombPot;
      const bomb = { mode: bp.mode, reason: null };
      if (bp.mode === 'percent') { bomb.percent = bp.percent; bomb.roll = settled.bombRoll; }
      if (bp.mode === 'every') bomb.every = bp.every;
      if (this.bombNext) bomb.reason = 'manual';
      else if (bp.mode === 'every' && this.handsSinceBomb + 1 >= bp.every) bomb.reason = 'every';
      else if (bp.mode === 'percent' && settled.bombRoll < bp.percent) bomb.reason = 'percent';
      let bombAnte = 0;
      if (bomb.reason) {
        bombAnte = Math.max(1, Math.round(bp.anteBB * s.bigBlind));
        this.bombNext = false;
        this.handsSinceBomb = 0;
        if (bp.game !== 'current') gameType = bp.game;
      } else {
        this.handsSinceBomb++;
      }
      const number = pend.handNumber;
      const hand = new Hand({
        number, gameType, buttonSeat: this.buttonSeat, smallBlind: s.smallBlind, bigBlind: s.bigBlind,
        deck: settled.deck, bombAnte, ritMax: s.rit.enabled ? s.rit.maxRuns : 1, fmt: (a) => this.fmt(a),
        players: eligible.map((p) => ({ id: p.userId, seat: p.seat, name: p.name, stack: p.stack })),
      });
      this.handNumber = number;
      this.handMeta = {
        startedAt: Date.now(), commitment: pend.commitment, serverSeed: pend.serverSeed, entropy: settled.entropy,
        contributions: settled.contributions, deck: settled.deck, bomb, logLines: [],
      };
      this.hand = hand;
      this.lastHand = null;
      this.fair.pending = newCommitment(number + 1);
      hand.start();
      this.snapshot();
      this.afterHandChange();
      return true;
    } catch (e) {
      console.error(`[table ${this.id}] could not start hand`, e);
      this.paused = true;
      this.log(`Could not start the hand (${e.message}). The game is paused.`, 'error');
      return false;
    }
  }

  afterHandChange() {
    const hand = this.hand;
    if (!hand) return;
    for (const ev of hand.drainEvents()) this.log(ev.text, ev.kind);
    if (hand.phase === 'done') return this.finishHand();
    const actor = hand.actor();
    if (actor) {
      const leaving = this.players.get(actor.id)?.leaveAfterHand;
      if (!this.turn || this.turn.seat !== actor.seat || this.turn.version !== hand.version || (leaving && !this.turn.auto)) this.startTurn(actor);
    } else if (this.turn) {
      clearTimeout(this.timers.action);
      this.turn = null;
    }
    if (hand.phase === 'rit') {
      for (const id of hand.rit.eligible) {
        const p = this.players.get(id);
        if (!hand.rit.choices.has(id) && (!p || p.leaveAfterHand || !this.isConnected(id))) {
          hand.setRitChoice(id, 1);
          if (hand.phase !== 'rit') return this.afterHandChange();
        }
      }
      if (!this.timers.rit) {
        this.ritDeadline = Date.now() + DELAYS.rit;
        this.timers.rit = setTimeout(this.safe(() => {
          this.timers.rit = null;
          if (this.hand === hand && hand.phase === 'rit') { hand.resolveRit(); this.afterHandChange(); }
        }), DELAYS.rit);
      }
    } else if (this.timers.rit) {
      clearTimeout(this.timers.rit);
      this.timers.rit = null;
      this.ritDeadline = null;
    }
    if (hand.pending && !this.timers.advance) {
      let delay = DELAYS.street;
      if (hand.pending === 'runout') delay = (hand.runCount === 1 && hand.board.length === hand.sharedCount) || (hand.runs && hand.runIndex === 0 && hand.runs[0].length === hand.sharedCount) ? DELAYS.runoutFirst : DELAYS.runout;
      if (hand.pending === 'showdown') delay = DELAYS.showdown;
      this.timers.advance = setTimeout(this.safe(() => {
        this.timers.advance = null;
        if (this.hand !== hand) return;
        hand.advance();
        this.afterHandChange();
      }), delay);
    }
    this.broadcast();
  }

  startTurn(actor) {
    clearTimeout(this.timers.action);
    const p = this.players.get(actor.id);
    const now = Date.now();
    const hand = this.hand;
    if (!p || p.leaveAfterHand) {
      this.turn = { seat: actor.seat, userId: actor.id, deadline: now + DELAYS.autoAct, usingBank: false, version: hand.version, auto: true };
      this.timers.action = setTimeout(this.safe(() => this.autoAct(actor.id, false)), DELAYS.autoAct);
      return;
    }
    const ms = this.settings.decisionSeconds * 1000;
    this.turn = { seat: actor.seat, userId: actor.id, startedAt: now, deadline: now + ms, usingBank: false, version: hand.version };
    this.timers.action = setTimeout(this.safe(() => this.onTurnTimeout()), ms);
  }

  onTurnTimeout() {
    const t = this.turn;
    const hand = this.hand;
    if (!t || !hand) return;
    const actor = hand.actor();
    if (!actor || actor.id !== t.userId) return;
    const p = this.players.get(t.userId);
    if (!t.usingBank && p && this.settings.timeBankSeconds > 0 && p.timeBank >= 1) {
      t.usingBank = true;
      t.bankStartedAt = Date.now();
      t.deadline = Date.now() + p.timeBank * 1000;
      this.timers.action = setTimeout(this.safe(() => this.onTurnTimeout()), p.timeBank * 1000);
      this.broadcast();
      return;
    }
    if (t.usingBank && p) p.timeBank = 0;
    this.autoAct(t.userId, true);
  }

  autoAct(userId, timedOut) {
    const hand = this.hand;
    const actor = hand && hand.actor();
    if (!actor || actor.id !== userId) return;
    const legal = hand.legalActions(userId);
    const p = this.players.get(userId);
    if (timedOut && p && !p.leaveAfterHand) {
      p.sitOutNext = true;
      p.away = true;
      this.log(`${p.name} ran out of time and will sit out next hand`, 'seat');
    }
    this.turn = null;
    hand.act(userId, { type: legal.canCheck ? 'check' : 'fold' });
    this.afterHandChange();
  }

  playerAction(user, action) {
    const hand = this.hand;
    if (!hand || hand.phase === 'done') fail('No hand in progress');
    const actor = hand.actor();
    if (!actor || actor.id !== user.id) fail('It is not your turn');
    const t = this.turn;
    const p = this.players.get(user.id);
    if (t && t.usingBank && p) p.timeBank = Math.max(0, p.timeBank - (Date.now() - t.bankStartedAt) / 1000);
    const type = String(action?.type || '');
    const to = action?.to !== undefined ? Number(action.to) : undefined;
    hand.act(user.id, { type, to });
    clearTimeout(this.timers.action);
    this.turn = null;
    this.afterHandChange();
  }

  chooseRuns(user, runs) {
    const hand = this.hand;
    if (!hand || hand.phase !== 'rit') fail('Nothing to choose right now');
    hand.setRitChoice(user.id, runs);
    this.afterHandChange();
  }

  showCards(user) {
    const hand = this.hand || this.lastHand;
    if (!hand || hand.phase !== 'done') fail('You can show your cards once the hand is over');
    if (hand.showCards(user.id)) {
      for (const ev of hand.drainEvents()) this.log(ev.text, ev.kind);
      const rec = this.getRecords().find((r) => r.handNumber === hand.number);
      if (rec) { const pr = rec.players.find((x) => x.userId === user.id); if (pr) pr.shown = true; }
      this.broadcast();
    }
  }

  finishHand() {
    const hand = this.hand;
    const meta = this.handMeta;
    for (const k of ['action', 'advance', 'rit']) { clearTimeout(this.timers[k]); this.timers[k] = null; }
    this.turn = null;
    this.ritDeadline = null;
    for (const hp of hand.players) {
      const p = this.players.get(hp.id);
      if (p) p.stack = hp.stack;
    }
    const rec = this.buildRecord(hand, meta);
    this.getRecords().push(rec);
    this.store.appendHand(this.id, rec);
    this.hand = null;
    this.lastHand = hand;
    if (this.settings.revealPolicy === 'hand') this.reveal(hand.number);
    for (const p of [...this.players.values()]) {
      if (p.leaveAfterHand) { this.removePlayer(p, p.kicked ? 'kicked' : 'stood up'); continue; }
      if (p.pendingChips > 0) {
        const amt = p.pendingChips;
        p.pendingChips = 0;
        try { this.applyChips(p, amt, null); } catch (e) { this.log(`${p.name} could not add chips: ${e.message}`, 'chips'); }
      }
      if (p.stack === 0 && !p.sittingOut) this.log(`${p.name} is out of chips`, 'seat');
    }
    this.snapshot();
    if (this.endAfterHand || (this.session.endsAt && Date.now() >= this.session.endsAt && this.status === 'running')) {
      this.endGame(this.endAfterHand || 'time');
      return;
    }
    const delay = hand.results.uncontested ? DELAYS.afterUncontested : DELAYS.afterShowdown + (hand.runCount - 1) * DELAYS.perExtraRun;
    this.timers.next = setTimeout(this.safe(() => { this.timers.next = null; this.maybeStartHand(); }), delay);
    this.broadcast();
  }

  buildRecord(hand, meta) {
    const d = hand.recordData();
    const holes = {};
    for (const p of d.players) holes[p.seat] = p.hole;
    const results = d.results;
    return {
      v: 1,
      tableId: this.id,
      tableName: this.name,
      handNumber: hand.number,
      startedAt: meta.startedAt,
      endedAt: Date.now(),
      gameType: d.gameType,
      isBomb: d.isBomb,
      bombAnte: d.bombAnte,
      bomb: meta.bomb,
      buttonSeat: d.buttonSeat,
      smallBlind: d.smallBlind,
      bigBlind: d.bigBlind,
      decimals: this.decimals,
      players: d.players.map((p) => ({
        seat: p.seat, userId: p.id, name: p.name, startStack: p.startStack, endStack: p.endStack,
        net: p.endStack - p.startStack, shown: p.shown, folded: p.folded,
      })),
      fairness: {
        version: FAIRNESS_VERSION,
        commitment: meta.commitment,
        serverSeed: meta.serverSeed,
        entropy: meta.entropy,
        contributions: meta.contributions.map((c) => ({ seat: c.seat, name: c.name, userId: c.userId, seed: c.seed })),
        deck: meta.deck,
      },
      dealt: { ...d.dealt, holes },
      runCount: d.runCount,
      results: {
        uncontested: results.uncontested,
        boards: results.boards,
        payouts: results.payouts,
        pots: results.pots.map((p) => ({
          amount: p.amount,
          uncontested: !!p.uncontested,
          runs: p.runs.map((r) => ({ run: r.run, amount: r.amount, winners: r.winners.map((w) => ({ seat: w.seat, name: w.name, amount: w.amount, hand: w.hand, cards: w.cards })) })),
        })),
        handNames: results.handNames || null,
      },
      log: meta.logLines,
    };
  }

  // ---------- chat ----------
  chat(user, text) {
    text = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
    if (!text) return;
    const seated = this.players.get(user.id);
    if (!seated && !this.settings.spectatorChat && !this.isHost(user.id)) fail('Spectator chat is turned off');
    const last = this.chatTimes.get(user.id) || 0;
    if (Date.now() - last < 600) fail('Slow down');
    this.chatTimes.set(user.id, Date.now());
    this.log(text, 'chat', { userId: user.id, name: seated ? seated.name : user.name, spectator: !seated });
  }

  // ---------- ledger ----------
  ledgerSummary() {
    const rows = new Map();
    for (const e of this.ledger) {
      const r = rows.get(e.userId) || { userId: e.userId, name: e.name, buyIn: 0, buyOut: 0, stack: 0, seated: false, firstAt: e.at, lastAt: e.at };
      r.name = e.name;
      r.lastAt = e.at;
      if (e.type === 'buyin') r.buyIn += e.amount;
      else if (e.type === 'cashout') r.buyOut += e.amount;
      else if (e.type === 'adjust') { if (e.amount >= 0) r.buyIn += e.amount; else r.buyOut -= e.amount; }
      rows.set(e.userId, r);
    }
    for (const p of this.players.values()) {
      const r = rows.get(p.userId);
      if (r) { r.seated = true; r.stack = this.currentChips(p); }
    }
    const list = [...rows.values()].map((r) => ({ ...r, net: r.buyOut + r.stack - r.buyIn }));
    return { decimals: this.decimals, rows: list, entries: this.ledger.slice(-1000), clubId: this.clubId };
  }

  ledgerCsv() {
    const { rows } = this.ledgerSummary();
    const d = this.decimals;
    const amt = (x) => (d ? (x / 100).toFixed(2) : String(x));
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const out = [['player', 'buy_in', 'buy_out', 'stack', 'net', 'first_seen', 'last_seen']];
    for (const r of rows) out.push([r.name, amt(r.buyIn), amt(r.buyOut), amt(r.stack), amt(r.net), new Date(r.firstAt).toISOString(), new Date(r.lastAt).toISOString()]);
    out.push([]);
    out.push(['time', 'player', 'type', 'amount', 'note']);
    for (const e of this.ledger) out.push([new Date(e.at).toISOString(), e.name, e.type, amt(e.amount), e.note || '']);
    return out.map((r) => r.map(esc).join(',')).join('\n');
  }

  // ---------- views ----------
  waitingReason() {
    if (this.status === 'ended') return 'This game has ended';
    if (this.status === 'waiting') return 'Waiting for the host to start the game';
    if (this.hand && this.hand.phase !== 'done') return null;
    if (this.paused) return 'The game is paused';
    if (this.eligiblePlayers().length < 2 && !this.timers.next) return 'Waiting for players';
    return null;
  }

  summary(viewerId) {
    const seated = [...this.players.values()];
    return {
      id: this.id, name: this.name, clubId: this.clubId, status: this.status, paused: this.paused,
      players: seated.length, maxPlayers: this.settings.maxPlayers, games: this.settings.games,
      smallBlind: this.settings.smallBlind, bigBlind: this.settings.bigBlind, decimals: this.decimals,
      createdAt: this.createdAt, handNumber: this.handNumber, endsAt: this.session.endsAt,
      seated: viewerId ? this.players.has(viewerId) : undefined, isHost: viewerId ? this.isHost(viewerId) : undefined,
      names: seated.map((p) => p.name),
    };
  }

  stateFor(userId) {
    const me = this.players.get(userId);
    const hand = this.hand || this.lastHand;
    const isHost = this.isHost(userId);
    const pend = this.fair.pending;
    let handState = null;
    if (hand) {
      handState = hand.publicState(userId);
      handState.turn = this.hand && this.turn ? {
        seat: this.turn.seat, deadline: this.turn.deadline, usingBank: this.turn.usingBank,
        total: this.turn.usingBank ? Math.max(1000, this.turn.deadline - this.turn.bankStartedAt) : this.turn.auto ? DELAYS.autoAct : this.settings.decisionSeconds * 1000,
      } : null;
      handState.ritDeadline = this.ritDeadline;
      handState.bombReason = this.handMeta && this.handMeta.bomb ? this.handMeta.bomb.reason : null;
      handState.canShow = !!(hand.phase === 'done' && hand.byId(userId) && !hand.byId(userId).shown);
    }
    const seats = [];
    for (let i = 0; i < this.settings.maxPlayers; i++) {
      const uid = this.seats[i];
      const p = uid && this.players.get(uid);
      seats.push(p ? {
        seat: i, userId: p.userId, name: p.name, stack: p.stack, sittingOut: p.sittingOut, sitOutNext: p.sitOutNext,
        leaving: p.leaveAfterHand, connected: this.isConnected(uid), timeBank: Math.floor(p.timeBank),
        isHost: this.isHost(uid), pendingChips: p.pendingChips, away: p.away,
      } : null);
    }
    let clubAvailable = null;
    let clubName = null;
    if (this.clubId) {
      clubName = this.clubs.data[this.clubId]?.name || null;
      if (this.clubs.role(this.clubId, userId)) clubAvailable = this.clubs.available(this.clubId, userId);
    }
    return {
      serverNow: Date.now(),
      table: {
        id: this.id, name: this.name, clubId: this.clubId, clubName, status: this.status, paused: this.paused,
        handNumber: this.handNumber, ownerId: this.ownerId, settings: this.settings, decimals: this.decimals,
        session: this.session, endAfterHand: !!this.endAfterHand, revealedThrough: this.revealedThrough,
        createdAt: this.createdAt, endedAt: this.endedAt, waiting: this.waitingReason(), bombNext: this.bombNext,
        rotation: this.rotationInfo(), handsSinceBomb: this.handsSinceBomb,
      },
      me: {
        userId, isHost, seat: me ? me.seat : null, seated: !!me,
        sittingOut: me ? me.sittingOut : false, sitOutNext: me ? me.sitOutNext : false, leaving: me ? me.leaveAfterHand : false,
        pendingChips: me ? me.pendingChips : 0, requests: this.requests.filter((r) => r.userId === userId), clubAvailable,
      },
      seats,
      hand: handState,
      fairness: { handNumber: pend.handNumber, commitment: pend.commitment, contributions: pend.contributions.size, iContributed: pend.contributions.has(userId) },
      requests: isHost ? this.requests : null,
    };
  }
}

function describeChanges(a, b, fmt) {
  const out = [];
  const name = (g) => GAME_TYPES[g]?.short || g;
  if (JSON.stringify(a.games) !== JSON.stringify(b.games)) out.push(`games: ${b.games.map(name).join(' / ')}`);
  if (b.games.length > 1 && (a.rotateEvery !== b.rotateEvery || a.rotateHands !== b.rotateHands)) out.push(`rotate every ${b.rotateEvery === 'orbit' ? 'orbit' : b.rotateHands + ' hands'}`);
  if (a.smallBlind !== b.smallBlind || a.bigBlind !== b.bigBlind) out.push(`blinds ${fmt(b.smallBlind)}/${fmt(b.bigBlind)}`);
  if (a.minBuyIn !== b.minBuyIn || a.maxBuyIn !== b.maxBuyIn) out.push(`buy-in ${b.minBuyIn ? fmt(b.minBuyIn) : 'any'} to ${b.maxBuyIn ? fmt(b.maxBuyIn) : 'any'}`);
  if (a.maxPlayers !== b.maxPlayers) out.push(`${b.maxPlayers} seats`);
  if (a.decisionSeconds !== b.decisionSeconds) out.push(`decision time ${b.decisionSeconds}s`);
  if (a.timeBankSeconds !== b.timeBankSeconds) out.push(`time bank ${b.timeBankSeconds}s`);
  if (JSON.stringify(a.bombPot) !== JSON.stringify(b.bombPot)) {
    const bp = b.bombPot;
    out.push(bp.mode === 'off' ? 'bomb pots off' : `bomb pots ${bp.mode === 'every' ? `every ${bp.every} hands` : `${bp.percent}% of hands`}, ${bp.anteBB} BB each${bp.game !== 'current' ? `, played as ${name(bp.game)}` : ''}`);
  }
  if (JSON.stringify(a.rit) !== JSON.stringify(b.rit)) out.push(b.rit.enabled ? `run it up to ${TIMES[b.rit.maxRuns]}` : 'run it more than once: off');
  if (a.sessionMinutes !== b.sessionMinutes) out.push(b.sessionMinutes ? `time limit ${b.sessionMinutes} minutes` : 'no time limit');
  if (a.revealPolicy !== b.revealPolicy) out.push(b.revealPolicy === 'hand' ? 'shuffle seeds revealed after every hand' : 'shuffle seeds revealed when the game ends');
  if (a.autoApprove !== b.autoApprove) out.push(b.autoApprove ? 'seat requests approved automatically' : 'host approves seat requests');
  if (a.feltColor !== b.feltColor) out.push('felt color');
  if (a.spectatorChat !== b.spectatorChat) out.push(b.spectatorChat ? 'spectator chat on' : 'spectator chat off');
  return out;
}

export class TableManager {
  constructor({ store, auth, clubs }) {
    this.store = store;
    this.auth = auth;
    this.clubs = clubs;
    this.tables = new Map();
    clubs.chipsOnTables = () => this.chipsOnTablesByClub();
    for (const snap of Object.values(store.data.tables)) {
      try {
        const t = new Table(this, snap);
        this.tables.set(t.id, t);
        if (t.status === 'running') {
          let any = false;
          for (const p of t.players.values()) { if (!p.sittingOut) any = true; p.sittingOut = true; }
          if (any) t.log('The server restarted. Seated players were set to sitting out; click "I’m back" to continue.', 'game');
          t.scheduleSession();
          if (t.session.endsAt && Date.now() >= t.session.endsAt) t.endGame('time');
        }
      } catch (e) {
        console.error('could not restore table', snap.id, e);
      }
    }
  }

  create(user, { name, clubId, settings }) {
    let base = structuredClone(DEFAULT_SETTINGS);
    if (clubId) {
      if (!this.clubs.isManager(clubId, user.id)) fail('Only club managers can open club tables');
      base.autoApprove = true;
      base.autoStart = true;
    }
    const s = sanitizeSettings(settings || {}, base);
    const n = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || `${user.name}'s game`;
    const t = new Table(this, { id: randomId(7), name: n, clubId: clubId || null, ownerId: user.id, settings: s });
    this.tables.set(t.id, t);
    if (clubId || s.autoStart) t.startSession();
    t.log(`${user.name} created the table`, 'game');
    t.snapshot();
    return t;
  }

  get(id) {
    const t = this.tables.get(id);
    if (!t) fail('Table not found');
    return t;
  }

  forClub(clubId, viewerId) {
    return [...this.tables.values()].filter((t) => t.clubId === clubId).sort((a, b) => b.createdAt - a.createdAt).map((t) => t.summary(viewerId));
  }

  forUser(userId) {
    return [...this.tables.values()]
      .filter((t) => !t.clubId && (t.ownerId === userId || t.players.has(userId) || t.ledger.some((e) => e.userId === userId)))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30)
      .map((t) => t.summary(userId));
  }

  chipsOnTablesByClub() {
    const out = new Map();
    for (const t of this.tables.values()) {
      if (!t.clubId) continue;
      if (!out.has(t.clubId)) out.set(t.clubId, new Map());
      const m = out.get(t.clubId);
      for (const p of t.players.values()) m.set(p.userId, (m.get(p.userId) || 0) + t.currentChips(p));
    }
    return out;
  }
}
