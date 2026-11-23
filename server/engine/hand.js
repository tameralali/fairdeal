// One hand of poker: blinds or bomb-pot antes, dealing, NL/PL betting, side pots,
// one or two boards, all-in runouts run 1 to 4 times, showdown and payouts.
// Pure state machine: the Table drives timing by calling advance() when `pending` is set.
//
// Boards: before any split there are `bpr` boards (1, or 2 for double board). When an all-in is
// run k times, every board is copied k times, so there are k * bpr boards; board index
// i belongs to run floor(i / bpr) and is board (i % bpr) + 1 of that run. Every pot is split evenly
// across all boards. `placements` records, for each deck card dealt after the hole cards, which
// board(s) it landed on, so anyone can rebuild every board from the shuffled deck.

import { gameInfo, SUIT_SYMBOLS } from '../../shared/cards.js';
import { bestHand } from '../../shared/evaluator.js';

export function pretty(card) {
  const r = card[0] === 'T' ? '10' : card[0];
  return r + SUIT_SYMBOLS[card[1]];
}
const prettyList = (cards) => cards.map(pretty).join(', ');

export function splitEven(amount, n) {
  const base = Math.floor(amount / n);
  const rem = amount - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

// Main pot and side pots from each player's total contribution this hand.
export function buildPots(players) {
  const contrib = players.map((p) => ({ id: p.id, amt: p.committed, live: !p.folded }));
  const levels = [...new Set(contrib.filter((c) => c.live && c.amt > 0).map((c) => c.amt))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const c of contrib) amount += Math.max(0, Math.min(c.amt, level) - prev);
    const eligible = contrib.filter((c) => c.live && c.amt >= level).map((c) => c.id);
    if (amount > 0) {
      const last = pots[pots.length - 1];
      if (last && sameSet(last.eligible, eligible)) last.amount += amount;
      else pots.push({ amount, eligible });
    }
    prev = level;
  }
  const total = contrib.reduce((s, c) => s + c.amt, 0);
  const counted = pots.reduce((s, p) => s + p.amount, 0);
  if (total > counted && pots.length) pots[pots.length - 1].amount += total - counted;
  return pots;
}

const TIMES = ['once', 'once', 'twice', 'three times', 'four times'];
const STREET_OF = { 3: 'flop', 4: 'turn', 5: 'river' };

export class Hand {
  constructor(opts) {
    const {
      number, gameType, players, buttonSeat, smallBlind, bigBlind, deck,
      bombAnte = 0, ritMax = 1, fmt = String, doubleBoard = false, straddleIds = [], legacyDoubleRuns = false,
    } = opts;
    this.straddleIds = straddleIds;
    this.straddleIdx = null;
    this.number = number;
    this.game = gameInfo(gameType);
    this.gameType = this.game.id;
    this.limit = this.game.limit;
    this.omaha = this.game.omaha;
    this.sb = smallBlind;
    this.bb = bigBlind;
    this.isBomb = bombAnte > 0;
    this.bombAnte = bombAnte;
    // Two boards already split the pot two ways, so a double board hand (bomb pot or not) runs once.
    // Hands played before that rule could run more than once: legacyDoubleRuns deals one of those again,
    // so the checks on old hand records can still be tried.
    this.ritMax = doubleBoard && !legacyDoubleRuns ? 1 : Math.max(1, Math.min(4, ritMax | 0));
    this.fmt = fmt;
    this.deck = deck;
    this.deckPtr = 0;
    this.bpr = doubleBoard ? 2 : 1;
    this.players = players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((p) => ({
        id: p.id, seat: p.seat, name: p.name, stack: p.stack, startStack: p.stack,
        hole: [], folded: false, allIn: false, bet: 0, committed: 0,
        hasActed: false, actedAtLevel: 0, lastAction: null, shown: false, showIdx: [],
      }));
    this.n = this.players.length;
    if (this.n < 2) throw new Error('need at least two players');
    if (this.n * this.game.holeCount + 5 * this.bpr > deck.length) throw new Error('too many players for this game');
    this.btnIdx = this.players.findIndex((p) => p.seat === buttonSeat);
    if (this.btnIdx < 0) throw new Error('button must be on a dealt-in player');
    if (this.n === 2) { this.sbIdx = this.btnIdx; this.bbIdx = (this.btnIdx + 1) % 2; }
    else { this.sbIdx = (this.btnIdx + 1) % this.n; this.bbIdx = (this.btnIdx + 2) % this.n; }
    this.boards = Array.from({ length: this.bpr }, () => []);
    this.placements = [];
    this.runCount = 1;
    this.splitAt = null;
    this.runIndex = 0;
    this.street = 'preflop';
    this.phase = 'init'; // betting | pending | rit | runout | done
    this.pending = null; // next-street | runout | showdown
    this.actions = []; // every betting action, for hand history and player stats
    this.posts = []; // blinds and bomb pot antes, for the replayer
    this.currentBet = 0;
    this.minRaise = bigBlind;
    this.lastAggressorId = null;
    this.actorIndex = -1;
    this.dealOrder = [];
    this.events = [];
    this.results = null;
    this.rit = null;
    this.version = 0;
  }

  // ---------- helpers ----------
  log(text, kind = 'hand') { this.events.push({ text, kind }); }
  drainEvents() { const e = this.events; this.events = []; return e; }
  byId(id) { return this.players.find((p) => p.id === id); }
  get live() { return this.players.filter((p) => !p.folded); }
  get board() { return this.boards[0]; }
  potTotal() { return this.players.reduce((s, p) => s + p.committed, 0); }
  collectedPot() { return this.players.reduce((s, p) => s + p.committed - p.bet, 0); }
  draw() {
    if (this.deckPtr >= this.deck.length) throw new Error('deck exhausted');
    return this.deck[this.deckPtr++];
  }
  boardLabel(i) {
    const run = Math.floor(i / this.bpr);
    const side = i % this.bpr;
    if (this.runCount > 1 && this.bpr > 1) return `run ${run + 1} board ${side + 1}`;
    if (this.runCount > 1) return `run ${run + 1}`;
    if (this.bpr > 1) return `board ${side + 1}`;
    return '';
  }
  actor() { return this.phase === 'betting' && this.actorIndex >= 0 ? this.players[this.actorIndex] : null; }
  needsToAct(p) { return !p.folded && !p.allIn && (!p.hasActed || p.bet < this.currentBet); }
  nextActorFrom(idx) {
    for (let k = 1; k <= this.n; k++) {
      const i = (idx + k) % this.n;
      if (this.needsToAct(this.players[i])) return i;
    }
    return -1;
  }
  orderFromButton(ids) {
    const pos = (id) => {
      const i = this.players.findIndex((p) => p.id === id);
      return (i - this.btnIdx - 1 + this.n) % this.n;
    };
    return ids.slice().sort((a, b) => pos(a) - pos(b));
  }

  // ---------- start ----------
  start() {
    const btn = this.players[this.btnIdx];
    const tags = [this.isBomb && 'BOMB POT', this.bpr > 1 && 'DOUBLE BOARD'].filter(Boolean).join(', ');
    this.log(`-- starting hand #${this.number} (${tags ? tags + ', ' : ''}${this.game.name}) (dealer: ${btn.name}) --`, 'hand-start');
    this.log('Player stacks: ' + this.players.map((p) => `#${p.seat + 1} ${p.name} (${this.fmt(p.stack)})`).join(' | '), 'stacks');
    if (this.isBomb) {
      for (const p of this.players) {
        const amt = Math.min(p.stack, this.bombAnte);
        p.stack -= amt;
        p.committed += amt;
        if (p.stack === 0) p.allIn = true;
        this.posts.push({ id: p.id, a: 'ante', amt, allIn: !!p.allIn });
        this.log(`${p.name} posts a bomb pot ante of ${this.fmt(amt)}${p.allIn ? ' and is all in' : ''}`);
      }
    } else {
      this.postBlind(this.sbIdx, this.sb, 'small blind', 'sb');
      this.postBlind(this.bbIdx, this.bb, 'big blind', 'bb');
      this.currentBet = this.bb;
      this.minRaise = this.bb;
      // A straddle: the player under the gun, if they asked to, posts twice the big blind before the deal.
      // It is a live blind: action starts after them, and they act last before the flop, with the option
      // to raise when nobody else has. Heads-up the player under the gun is the button, who has already
      // posted the small blind: they put in the rest of twice the big blind (a button straddle), and the
      // big blind acts first. Only with more than the straddle behind.
      const utg = (this.bbIdx + 1) % this.n;
      const sp = this.players[utg];
      const more = 2 * this.bb - sp.bet;
      if (this.straddleIds.includes(sp.id) && more > 0 && sp.stack > more) {
        this.postBlind(utg, more, 'straddle', 'st', sp.bet > 0 ? `straddles to ${this.fmt(2 * this.bb)}` : null);
        sp.lastAction = 'Straddle';
        this.straddleIdx = utg;
        this.currentBet = 2 * this.bb;
        this.minRaise = 2 * this.bb;
      }
    }
    this.dealHoles();
    if (this.isBomb) {
      this.dealStreet();
      this.startBettingRound();
    } else {
      this.street = 'preflop';
      this.beginRound(this.straddleIdx ?? this.bbIdx);
    }
    this.version++;
  }

  // text: what the log says in place of "posts a <label> of <amount>"
  postBlind(idx, amount, label, a, text = null) {
    const p = this.players[idx];
    const amt = Math.min(p.stack, amount);
    p.stack -= amt;
    p.bet += amt;
    p.committed += amt;
    if (p.stack === 0) p.allIn = true;
    this.posts.push({ id: p.id, a, amt, allIn: !!p.allIn });
    this.log(`${p.name} ${text || `posts a ${label} of ${this.fmt(amt)}`}${p.allIn ? ' and is all in' : ''}`);
  }

  dealHoles() {
    const order = [];
    for (let k = 1; k <= this.n; k++) order.push((this.btnIdx + k) % this.n);
    this.dealOrder = order.map((i) => this.players[i].seat);
    for (let r = 0; r < this.game.holeCount; r++) {
      for (const i of order) this.players[i].hole.push(this.draw());
    }
  }

  // Deals the next street onto boards [first, first + bpr): board 1 gets its cards, then board 2.
  dealStreetOnto(first) {
    const len = this.boards[first].length;
    if (len >= 5) return;
    const n = len === 0 ? 3 : 1;
    const before = [];
    const dealt = [];
    for (let b = first; b < first + this.bpr; b++) {
      before.push(prettyList(this.boards[b]));
      const got = [];
      for (let i = 0; i < n; i++) {
        const c = this.draw();
        this.boards[b].push(c);
        this.placements.push([b]);
        got.push(c);
      }
      dealt.push(got);
    }
    const name = STREET_OF[this.boards[first].length];
    const parts = dealt.map((got, k) => {
      const label = this.boardLabel(first + k);
      const text = n === 3 ? `[${prettyList(got)}]` : `${before[k]} [${prettyList(got)}]`;
      return label ? `${label}: ${text}` : text;
    });
    const head = name[0].toUpperCase() + name.slice(1);
    if (this.runCount > 1 && this.bpr === 1) this.log(`${this.boardLabel(first).replace(/^r/, 'R')} ${name}: ${n === 3 ? `[${prettyList(dealt[0])}]` : `${before[0]} [${prettyList(dealt[0])}]`}`, 'board');
    else this.log(`${head}: ${parts.join(' | ')}`, 'board');
    return name;
  }

  dealStreet() {
    const name = this.dealStreetOnto(0);
    if (name) this.street = name;
  }

  startBettingRound() {
    for (const p of this.players) {
      p.bet = 0;
      p.hasActed = false;
      p.actedAtLevel = 0;
      if (!p.folded && !p.allIn) p.lastAction = null;
    }
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.lastAggressorId = null;
    this.beginRound(this.btnIdx);
  }

  beginRound(fromIdx) {
    this.phase = 'betting';
    this.actorIndex = -1;
    if (this.live.length === 1) return this.finishUncontested(this.live[0]);
    if (this.isRoundComplete()) return this.endBettingRound();
    this.actorIndex = this.nextActorFrom(fromIdx);
    if (this.actorIndex < 0) return this.endBettingRound();
  }

  isRoundComplete() {
    const live = this.live;
    const canAct = live.filter((p) => !p.allIn);
    if (canAct.length === 0) return true;
    if (canAct.length === 1) {
      const p = canAct[0];
      const maxOther = Math.max(0, ...live.filter((q) => q !== p).map((q) => q.bet));
      return p.bet >= maxOther;
    }
    return canAct.every((p) => p.hasActed && p.bet === this.currentBet);
  }

  // ---------- actions ----------
  legalActions(id) {
    const p = this.actor();
    if (!p || p.id !== id) return null;
    const toCall = Math.min(this.currentBet - p.bet, p.stack);
    const canCheck = this.currentBet === p.bet;
    const othersCanAct = this.players.some((q) => q !== p && !q.folded && !q.allIn);
    const reopened = !p.hasActed || this.currentBet - p.actedAtLevel >= this.minRaise;
    const canRaise = othersCanAct && reopened && p.stack > toCall;
    const allInTo = p.bet + p.stack;
    let minTo = this.currentBet + this.minRaise;
    let maxTo = allInTo;
    const potTotal = this.potTotal();
    if (this.limit === 'pl') {
      const potAfterCall = potTotal + (this.currentBet - p.bet);
      maxTo = Math.min(allInTo, this.currentBet + potAfterCall);
    }
    if (minTo > allInTo) minTo = allInTo;
    if (maxTo < minTo) maxTo = minTo;
    return {
      toCall, canCheck, canCall: toCall > 0, canRaise, minTo, maxTo, allInTo,
      isBet: this.currentBet === 0, currentBet: this.currentBet, myBet: p.bet, stack: p.stack,
      potTotal, limit: this.limit, bigBlind: this.bb,
    };
  }

  act(id, action) {
    const legal = this.legalActions(id);
    if (!legal) throw new Error('It is not your turn');
    const idx = this.actorIndex;
    const p = this.players[idx];
    let type = action.type;
    let kind = type; // fold, check, call, bet or raise, as recorded
    if (type === 'call' && !legal.canCall) type = 'check';
    if (type === 'check' && !legal.canCheck) throw new Error('You cannot check, there is a bet to call');
    if ((type === 'bet' || type === 'raise' || type === 'allin') && !legal.canRaise) {
      if (type === 'allin' && legal.canCall) type = 'call';
      else throw new Error('Raising is not allowed here');
    }
    switch (type) {
      case 'fold':
        p.folded = true;
        p.lastAction = 'Fold';
        this.log(`${p.name} folds`);
        break;
      case 'check':
        kind = 'check';
        p.hasActed = true;
        p.actedAtLevel = this.currentBet;
        p.lastAction = 'Check';
        this.log(`${p.name} checks`);
        break;
      case 'call': {
        kind = 'call';
        const amt = legal.toCall;
        p.stack -= amt;
        p.bet += amt;
        p.committed += amt;
        if (p.stack === 0) p.allIn = true;
        p.hasActed = true;
        p.actedAtLevel = this.currentBet;
        p.lastAction = p.allIn ? 'All-in' : 'Call';
        this.log(`${p.name} calls ${this.fmt(p.bet)}${p.allIn ? ' and is all in' : ''}`);
        break;
      }
      case 'bet':
      case 'raise':
      case 'allin': {
        let to = type === 'allin' ? legal.maxTo : Math.floor(Number(action.to ?? action.amount));
        if (!Number.isFinite(to)) throw new Error('Invalid amount');
        if (to > legal.maxTo) to = legal.maxTo;
        if (to < legal.minTo) to = legal.minTo;
        if (to <= this.currentBet) throw new Error('Raise must be larger than the current bet');
        const add = to - p.bet;
        const raiseSize = to - this.currentBet;
        const wasBet = this.currentBet === 0;
        kind = wasBet ? 'bet' : 'raise';
        p.stack -= add;
        p.bet = to;
        p.committed += add;
        if (p.stack === 0) p.allIn = true;
        if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
        this.currentBet = to;
        this.lastAggressorId = p.id;
        p.hasActed = true;
        p.actedAtLevel = to;
        p.lastAction = p.allIn ? 'All-in' : wasBet ? 'Bet' : 'Raise';
        this.log(wasBet
          ? `${p.name} bets ${this.fmt(to)}${p.allIn ? ' and is all in' : ''}`
          : `${p.name} raises to ${this.fmt(to)}${p.allIn ? ' and is all in' : ''}`);
        break;
      }
      default:
        throw new Error('Unknown action');
    }
    this.actions.push({ s: this.street, id: p.id, a: kind, to: p.bet, allIn: !!p.allIn });
    this.afterAction(idx);
    this.version++;
  }

  afterAction(idx) {
    const live = this.live;
    if (live.length === 1) return this.finishUncontested(live[0]);
    if (this.isRoundComplete()) return this.endBettingRound();
    this.actorIndex = this.nextActorFrom(idx);
    if (this.actorIndex < 0) return this.endBettingRound();
  }

  returnUncalled() {
    let top = -1, topIdx = -1, second = 0;
    this.players.forEach((p, i) => {
      if (p.bet > top) { second = Math.max(second, top); top = p.bet; topIdx = i; }
      else if (p.bet > second) second = p.bet;
    });
    if (topIdx >= 0 && top > second) {
      const refund = top - second;
      const p = this.players[topIdx];
      p.bet -= refund;
      p.committed -= refund;
      p.stack += refund;
      if (p.stack > 0) p.allIn = false;
      this.log(`Uncalled bet of ${this.fmt(refund)} returned to ${p.name}`);
    }
  }

  endBettingRound() {
    this.returnUncalled();
    for (const p of this.players) p.bet = 0;
    this.actorIndex = -1;
    const canAct = this.live.filter((p) => !p.allIn);
    if (this.boards[0].length === 5 || this.street === 'river') {
      this.phase = 'pending';
      this.pending = 'showdown';
      return;
    }
    if (canAct.length <= 1) return this.beginAllInRunout();
    this.phase = 'pending';
    this.pending = 'next-street';
  }

  // Shows every card of a player's hand (at showdown).
  showAll(p) {
    p.shown = true;
    p.showIdx = p.hole.map((_, i) => i);
  }

  revealLive() {
    for (const p of this.live) {
      if (!p.shown) {
        this.showAll(p);
        this.log(`${p.name} shows [${prettyList(p.hole)}]`, 'show');
      }
    }
  }

  // Everyone left is all in (or only one player has chips) before the river.
  // When running it more than once is possible, players vote first, while the hands are still face down.
  beginAllInRunout() {
    const need = this.bpr * (5 - this.boards[0].length);
    const remaining = this.deck.length - this.deckPtr;
    const maxRuns = Math.min(this.ritMax, Math.floor(remaining / need));
    if (maxRuns >= 2) {
      this.phase = 'rit';
      this.pending = null;
      this.rit = { max: maxRuns, eligible: this.live.map((p) => p.id), choices: new Map(), result: null };
      this.log(`Everyone is all in. Picking how many times to run it (up to ${TIMES[maxRuns]}): it runs more than once only if everyone picks the same number.`, 'rit');
      return;
    }
    this.revealLive();
    this.enterRunout(1);
  }

  // The players in the all-in pick in the open: everyone sees every pick and anyone may change theirs
  // until it is decided. runs: 1 to the most allowed, or 'any' to go with whatever the others pick.
  setRitChoice(id, runs) {
    if (this.phase !== 'rit') throw new Error('There is no vote right now');
    if (!this.rit.eligible.includes(id)) throw new Error('You are not in this all-in');
    const pick = runs === 'any' ? 'any' : Math.max(1, Math.min(this.rit.max, Math.floor(Number(runs)) || 1));
    this.rit.choices.set(id, pick);
    this.version++;
    const k = this.ritAgreement();
    if (k !== null) this.resolveRit(k);
  }

  // What the players in ids agree on, or null while they have not. A pick of once settles it at once.
  // Otherwise everyone has to have picked the same number; going with the others agrees with any
  // number, and if that is all anyone picked, it runs the most allowed.
  ritAgreement(ids = this.rit.eligible) {
    const picks = ids.map((id) => this.rit.choices.get(id));
    if (picks.includes(1)) return 1;
    if (!ids.length || picks.includes(undefined)) return null;
    const nums = picks.filter((x) => x !== 'any');
    if (!nums.length) return this.rit.max;
    return nums.every((x) => x === nums[0]) ? nums[0] : null;
  }

  // Ends the vote with k runs; with k left out (time is up), what everyone agrees on, or once.
  resolveRit(k = null) {
    if (this.phase !== 'rit') return;
    if (k === null) k = this.ritAgreement() ?? 1;
    this.rit.result = k;
    const word = (x) => (x === undefined ? 'no pick' : x === 'any' ? 'any number' : TIMES[x]);
    const picked = this.rit.eligible.map((id) => this.rit.choices.get(id));
    const picks = this.rit.eligible.map((id, i) => `${this.byId(id).name} ${word(picked[i])}`).join(', ');
    const why = k === 1 && !picked.includes(1) ? 'No agreement, so it runs once.' : `Running it ${TIMES[k]}.`;
    this.log(`Run it: ${picks}. ${why}`, 'rit');
    this.revealLive();
    this.enterRunout(k);
    this.version++;
  }

  enterRunout(k) {
    this.runCount = k;
    this.splitAt = this.boards[0].length;
    if (k > 1) {
      const base = this.boards.map((b) => b.slice());
      this.boards = [];
      for (let r = 0; r < k; r++) for (let b = 0; b < this.bpr; b++) this.boards.push(base[b].slice());
      // cards already on the table are shared by every run: they were placed on all copies
      this.placements = this.placements.map((t) => t.flatMap((b) => Array.from({ length: k }, (_, r) => b + r * this.bpr)));
    }
    this.runIndex = 0;
    this.phase = 'runout';
    this.pending = 'runout';
  }

  runoutStep() {
    const first = this.runIndex * this.bpr;
    const name = this.dealStreetOnto(first);
    if (this.runCount === 1 && name) this.street = name;
    if (this.boards[first].length >= 5) this.runIndex++;
    this.pending = this.runIndex >= this.runCount ? 'showdown' : 'runout';
  }

  // Called by the table after a delay whenever `pending` is set.
  advance() {
    const step = this.pending;
    if (!step) return;
    this.pending = null;
    if (step === 'next-street') {
      this.dealStreet();
      this.startBettingRound();
    } else if (step === 'runout') {
      this.runoutStep();
    } else if (step === 'showdown') {
      this.showdown();
    }
    this.version++;
  }

  // ---------- endings ----------
  finishUncontested(winner) {
    this.returnUncalled();
    for (const p of this.players) p.bet = 0;
    const pot = this.potTotal();
    winner.stack += pot;
    this.results = {
      uncontested: true,
      boards: this.boards.map((b) => b.slice()),
      pots: [{ amount: pot, eligible: [winner.id], uncontested: true, runs: [{ b: 0, run: 0, side: 0, amount: pot, winners: [{ id: winner.id, seat: winner.seat, name: winner.name, amount: pot, hand: null, cards: null }] }] }],
      payouts: [{ id: winner.id, seat: winner.seat, name: winner.name, amount: pot }],
    };
    this.log(`${winner.name} collected ${this.fmt(pot)} from pot`, 'win');
    this.finish();
  }

  showdown() {
    const live = this.live;
    let start = this.lastAggressorId ? this.players.findIndex((p) => p.id === this.lastAggressorId) : -1;
    if (start < 0 || this.players[start].folded) {
      start = -1;
      for (let k = 1; k <= this.n; k++) {
        const i = (this.btnIdx + k) % this.n;
        if (!this.players[i].folded) { start = i; break; }
      }
    }
    const boards = this.boards;
    for (let k = 0; k < this.n; k++) {
      const p = this.players[(start + k) % this.n];
      if (p.folded || p.shown) continue;
      this.showAll(p);
      const h = bestHand(p.hole, boards[0], this.omaha);
      this.log(`${p.name} shows [${prettyList(p.hole)}]${h && boards.length === 1 ? ` (${h.name})` : ''}`, 'show');
    }
    const pots = buildPots(this.players);
    const evals = boards.map((b) => {
      const m = new Map();
      for (const p of live) m.set(p.id, bestHand(p.hole, b, this.omaha));
      return m;
    });
    const payouts = new Map();
    const potResults = [];
    pots.forEach((pot, pi) => {
      const potLabel = pots.length === 1 ? 'the pot' : pi === 0 ? 'the main pot' : `side pot ${pi}`;
      if (pot.eligible.length === 1) {
        // Only one player can win this pot (everyone else who paid into it folded): it is not split by board.
        const id = pot.eligible[0];
        const p = this.byId(id);
        payouts.set(id, (payouts.get(id) || 0) + pot.amount);
        this.log(`${p.name} collected ${this.fmt(pot.amount)} from ${potLabel}`, 'win');
        potResults.push({ amount: pot.amount, eligible: pot.eligible, uncontested: true, runs: [{ b: 0, run: 0, side: 0, amount: pot.amount, winners: [{ id, seat: p.seat, name: p.name, amount: pot.amount, hand: null, cards: null }] }] });
        return;
      }
      const portions = splitEven(pot.amount, boards.length);
      const runs = boards.map((b, k) => {
        const ev = evals[k];
        let best = -1;
        for (const id of pot.eligible) best = Math.max(best, ev.get(id).score);
        const winners = this.orderFromButton(pot.eligible.filter((id) => ev.get(id).score === best));
        const shares = splitEven(portions[k], winners.length);
        const ws = winners.map((id, i) => {
          payouts.set(id, (payouts.get(id) || 0) + shares[i]);
          const p = this.byId(id);
          const e = ev.get(id);
          return { id, seat: p.seat, name: p.name, amount: shares[i], hand: e.name, cards: e.cards };
        });
        const where = this.boardLabel(k);
        for (const w of ws) {
          if (w.amount > 0) this.log(`${w.name} collected ${this.fmt(w.amount)} from ${potLabel}${where ? ` on ${where}` : ''} with ${w.hand}`, 'win');
        }
        return { b: k, run: Math.floor(k / this.bpr), side: k % this.bpr, amount: portions[k], winners: ws };
      });
      potResults.push({ amount: pot.amount, eligible: pot.eligible, runs });
    });
    for (const [id, amt] of payouts) this.byId(id).stack += amt;
    const handNames = boards.map((b, k) => Object.fromEntries(live.map((p) => [p.seat, evals[k].get(p.id).name])));
    this.results = {
      uncontested: false,
      boards: boards.map((b) => b.slice()),
      pots: potResults,
      payouts: [...payouts].map(([id, amount]) => { const p = this.byId(id); return { id, seat: p.seat, name: p.name, amount }; }),
      handNames,
    };
    this.finish();
  }

  finish() {
    this.phase = 'done';
    this.pending = null;
    this.actorIndex = -1;
    this.log(`-- ending hand #${this.number} --`, 'hand-end');
  }

  // After the hand a player may show any of their cards: idxs lists which (all of them when left out).
  showCards(id, idxs = null) {
    const p = this.byId(id);
    if (!p || this.phase !== 'done' || p.shown) return false;
    const want = (Array.isArray(idxs) ? idxs : p.hole.map((_, i) => i))
      .map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < p.hole.length && !p.showIdx.includes(i));
    if (!want.length) return false;
    p.showIdx = [...p.showIdx, ...new Set(want)].sort((a, b) => a - b);
    if (p.showIdx.length === p.hole.length) p.shown = true;
    const cards = [...new Set(want)].sort((a, b) => a - b).map((i) => p.hole[i]);
    this.log(`${p.name} shows ${cards.length === 1 ? pretty(cards[0]) : `[${prettyList(cards)}]`}`, 'show');
    this.version++;
    return true;
  }

  // What others may see of a player's cards: all of them, the ones shown, or none.
  visibleHole(p, viewerId) {
    if (p.id === viewerId || p.shown) return p.hole.slice();
    if (p.showIdx.length) return p.hole.map((c, i) => (p.showIdx.includes(i) ? c : null));
    return null;
  }

  // ---------- views ----------
  publicState(viewerId) {
    const actor = this.actor();
    return {
      number: this.number,
      gameType: this.gameType,
      limit: this.limit,
      isBomb: this.isBomb,
      bombAnte: this.bombAnte,
      doubleBoard: this.bpr > 1,
      boardsPerRun: this.bpr,
      buttonSeat: this.players[this.btnIdx].seat,
      sbSeat: this.isBomb ? null : this.players[this.sbIdx].seat,
      bbSeat: this.isBomb ? null : this.players[this.bbIdx].seat,
      straddleSeat: this.straddleIdx === null ? null : this.players[this.straddleIdx].seat,
      street: this.street,
      phase: this.phase,
      board: this.boards[0].slice(),
      boards: this.boards.map((b) => b.slice()),
      runCount: this.runCount,
      sharedCount: this.splitAt,
      pot: this.collectedPot(),
      potTotal: this.potTotal(),
      currentBet: this.currentBet,
      players: this.players.map((p) => ({
        seat: p.seat, id: p.id, stack: p.stack, bet: p.bet, committed: p.committed,
        folded: p.folded, allIn: p.allIn, lastAction: p.lastAction, shown: p.shown, showIdx: p.showIdx.slice(),
        holeCount: p.hole.length,
        hole: this.visibleHole(p, viewerId),
      })),
      actorSeat: actor ? actor.seat : null,
      legal: actor && actor.id === viewerId ? this.legalActions(viewerId) : null,
      rit: this.phase === 'rit' || (this.rit && this.rit.result) ? {
        max: this.rit.max,
        eligibleSeats: this.rit.eligible.map((id) => this.byId(id).seat),
        chosenSeats: [...this.rit.choices.keys()].map((id) => this.byId(id).seat),
        // every pick is open to the whole table
        picks: this.rit.eligible.map((id) => ({ seat: this.byId(id).seat, pick: this.rit.choices.get(id) ?? null })),
        myChoice: this.rit.choices.get(viewerId) ?? null,
        canChoose: this.phase === 'rit' && this.rit.eligible.includes(viewerId),
        result: this.rit.result,
      } : null,
      results: this.results,
    };
  }

  recordData() {
    return {
      gameType: this.gameType,
      isBomb: this.isBomb,
      bombAnte: this.bombAnte,
      doubleBoard: this.bpr > 1,
      buttonSeat: this.players[this.btnIdx].seat,
      smallBlind: this.sb,
      bigBlind: this.bb,
      players: this.players.map((p) => ({
        seat: p.seat, id: p.id, name: p.name, startStack: p.startStack, endStack: p.stack,
        hole: p.hole.slice(), shown: p.shown, showIdx: p.showIdx.slice(), folded: p.folded,
      })),
      dealt: {
        dealOrder: this.dealOrder.slice(),
        holeCount: this.game.holeCount,
        boardsPerRun: this.bpr,
        runCount: this.runCount,
        sharedCount: this.splitAt ?? this.boards[0].length,
        boards: this.boards.map((b) => b.slice()),
        placements: this.placements.map((t) => t.slice()),
      },
      runCount: this.runCount,
      actions: this.actions.map((x) => ({ ...x })),
      posts: this.posts.map((x) => ({ ...x })),
      results: this.results,
    };
  }
}
