// Player statistics from hand records: the numbers players watch at the table (VPIP, PFR, 3-bet,
// steals, aggression, c-bets, showdown rates) and their results. Each hand is reduced once to a
// small set of counts per player; a player's stats are sums of those counts.
//
// Bomb pots have no preflop betting, so they count toward hands, results and postflop stats only.
// Hands recorded before actions were logged count toward hands and results only.

import { FAIRNESS_V2 } from '../shared/fairness.js';

const POSTFLOP = new Set(['flop', 'turn', 'river']);
const isRaise = (a) => a === 'raise' || a === 'bet';

// Counts kept for each player in each hand. *Opp is how often the player had the chance.
export const KEYS = [
  'h', 'net', 'netBB', 'won', 'pfOpp', 'vpip', 'pfr', 'tbOpp', 'tb', 'f3Opp', 'f3', 'stOpp', 'st', 'fsOpp', 'fs',
  'cbOpp', 'cb', 'fcbOpp', 'fcb', 'agg', 'calls', 'folds', 'sawFlop', 'wtsd', 'wsd', 'wwsf',
];

function blank() {
  const o = {};
  for (const k of KEYS) o[k] = 0;
  o.best = 0;
  return o;
}

// One hand: { gameType, isBomb, at, players: { [userId]: counts } }. scale turns the hand's amounts
// into cents (100 for hands played in whole chips, where a chip counts as a dollar).
export function handLines(rec, scale = 1) {
  const out = { gameType: rec.gameType, isBomb: !!rec.isBomb, at: rec.startedAt || 0, players: {} };
  const bb = rec.bigBlind || 1;
  const won = new Map();
  for (const p of rec.results?.payouts || []) won.set(p.id, (won.get(p.id) || 0) + p.amount);
  const L = (id) => (out.players[id] ||= blank());
  const pid = (p) => p.userId || p.id;
  for (const p of rec.players) {
    const l = L(pid(p));
    l.h = 1;
    l.net = (p.endStack - p.startStack) * scale;
    l.netBB = (p.endStack - p.startStack) / bb;
    l.best = Math.max(0, l.net);
    l.won = (won.get(pid(p)) || 0) > 0 ? 1 : 0;
  }
  const actions = rec.actions;
  if (!Array.isArray(actions)) return out;

  // positions: dealing order starts left of the button
  const bySeat = rec.players.slice().sort((a, b) => a.seat - b.seat);
  const n = bySeat.length;
  const btn = Math.max(0, bySeat.findIndex((p) => p.seat === rec.buttonSeat));
  const at = (k) => pid(bySeat[((btn + k) % n + n) % n]);
  const sb = n === 2 ? at(0) : at(1);
  const bbId = n === 2 ? at(1) : at(2);
  const steal = new Set([at(0), sb]);
  if (n >= 4) steal.add(at(-1));

  const foldedPre = new Set();
  let pfAggressor = null;
  if (!rec.isBomb) {
    let raises = 0;
    let opener = null;
    let voluntary = false;
    let stealer = null;
    let stealAnswered = false;
    const acted = new Set();
    for (const x of actions.filter((a) => a.s === 'preflop')) {
      const l = L(x.id);
      const first = !acted.has(x.id);
      acted.add(x.id);
      if (first) {
        l.pfOpp = 1;
        if (!voluntary && raises === 0 && steal.has(x.id)) {
          l.stOpp = 1;
          if (isRaise(x.a)) l.st = 1;
        }
      }
      if (raises === 1 && x.id !== opener && !l.tbOpp) {
        l.tbOpp = 1;
        if (isRaise(x.a)) l.tb = 1;
        if (stealer && !stealAnswered && (x.id === sb || x.id === bbId)) {
          l.fsOpp = 1;
          if (x.a === 'fold') l.fs = 1;
        }
      }
      if (raises === 2 && x.id === opener && !l.f3Opp) {
        l.f3Opp = 1;
        if (x.a === 'fold') l.f3 = 1;
      }
      if (x.a === 'call' || isRaise(x.a)) {
        l.vpip = 1;
        if (x.id !== stealer) { if (stealer) stealAnswered = true; voluntary = true; }
      }
      if (isRaise(x.a)) {
        l.pfr = 1;
        raises++;
        if (raises === 1) {
          opener = x.id;
          if (l.st) stealer = x.id;
        }
        pfAggressor = x.id;
      }
      if (x.a === 'fold') foldedPre.add(x.id);
    }
  }

  // flop: continuation bets by the preflop raiser, and how the others answered them
  if (pfAggressor) {
    let bet = false;
    let cbet = false;
    let raised = false;
    let aggressorActed = false;
    const faced = new Set();
    for (const x of actions.filter((a) => a.s === 'flop')) {
      const l = L(x.id);
      if (x.id === pfAggressor && !aggressorActed) {
        aggressorActed = true;
        if (!bet) {
          l.cbOpp = 1;
          if (x.a === 'bet') { l.cb = 1; cbet = true; }
        }
      } else if (cbet && !raised && x.id !== pfAggressor && !faced.has(x.id)) {
        faced.add(x.id);
        l.fcbOpp = 1;
        if (x.a === 'fold') l.fcb = 1;
      }
      if (isRaise(x.a)) {
        if (cbet && x.id !== pfAggressor) raised = true;
        bet = true;
      }
    }
  }

  // after the flop: aggression, and how far each player went
  const foldedAny = new Set();
  for (const x of actions) {
    if (x.a === 'fold') foldedAny.add(x.id);
    if (!POSTFLOP.has(x.s)) continue;
    const l = L(x.id);
    if (isRaise(x.a)) l.agg++;
    else if (x.a === 'call') l.calls++;
    else if (x.a === 'fold') l.folds++;
  }
  const flopDealt = (rec.dealt?.boards?.[0]?.length || 0) >= 3;
  const showdown = !rec.results?.uncontested;
  for (const p of rec.players) {
    const l = L(pid(p));
    l.sawFlop = flopDealt && (rec.isBomb || !foldedPre.has(pid(p))) ? 1 : 0;
    if (!l.sawFlop) continue;
    l.wtsd = showdown && !foldedAny.has(pid(p)) ? 1 : 0;
    l.wsd = l.wtsd && l.won ? 1 : 0;
    l.wwsf = l.won;
  }
  return out;
}

// Adds hands up for each player. lines: handLines results; game: 'all' or a game id.
export function aggregate(lines, game = 'all') {
  const tot = new Map();
  for (const line of lines) {
    if (game !== 'all' && line.gameType !== game) continue;
    for (const [id, l] of Object.entries(line.players)) {
      let t = tot.get(id);
      if (!t) { t = blank(); tot.set(id, t); }
      for (const k of KEYS) t[k] += l[k];
      t.best = Math.max(t.best, l.best);
    }
  }
  return tot;
}

const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);

// The numbers shown to players, with the sample behind each one.
export function summarize(t) {
  return {
    hands: t.h,
    vpip: pct(t.vpip, t.pfOpp), pfr: pct(t.pfr, t.pfOpp), pfOpp: t.pfOpp,
    threeBet: pct(t.tb, t.tbOpp), threeBetOpp: t.tbOpp,
    foldTo3Bet: pct(t.f3, t.f3Opp), foldTo3BetOpp: t.f3Opp,
    ats: pct(t.st, t.stOpp), atsOpp: t.stOpp,
    foldToSteal: pct(t.fs, t.fsOpp), foldToStealOpp: t.fsOpp,
    af: t.calls ? Math.round((10 * t.agg) / t.calls) / 10 : null, afBets: t.agg, afCalls: t.calls,
    afq: pct(t.agg, t.agg + t.calls + t.folds), afqOpp: t.agg + t.calls + t.folds,
    cbet: pct(t.cb, t.cbOpp), cbetOpp: t.cbOpp,
    foldToCbet: pct(t.fcb, t.fcbOpp), foldToCbetOpp: t.fcbOpp,
    sawFlop: t.sawFlop,
    wtsd: pct(t.wtsd, t.sawFlop), wsd: pct(t.wsd, t.wtsd), showdowns: t.wtsd,
    wwsf: pct(t.wwsf, t.sawFlop),
    handsWon: t.won, net: t.net, bb100: t.h ? Math.round((1000 * t.netBB) / t.h) / 10 : null, best: t.best,
  };
}

// What the list of every hand in the club needs from one hand, amounts in cents (scale as for
// handLines). Each player's hole cards are kept as one string ('AsKd') so a viewer can be given the
// ones they may see (handView), the same ones the game's own hand history shows them.
export function handSummary(rec, scale = 1) {
  return {
    handNumber: rec.handNumber, at: rec.startedAt || 0, gameType: rec.gameType, isBomb: !!rec.isBomb,
    runCount: rec.runCount || 1, doubleBoard: !!rec.doubleBoard,
    pot: (rec.results?.pots || []).reduce((sum, p) => sum + p.amount, 0) * scale,
    showdown: !rec.results?.uncontested, allIn: (rec.actions || []).some((a) => a.allIn),
    straddle: (rec.posts || []).some((p) => p.a === 'st'), replay: Array.isArray(rec.actions),
    bounty: rec.bounty ? { userId: rec.bounty.userId, total: rec.bounty.total * scale } : null,
    sealed: rec.fairness?.version === FAIRNESS_V2,
    players: rec.players.map((p) => ({
      id: p.userId || p.id, net: (p.endStack - p.startStack) * scale,
      holes: (rec.dealt?.holes?.[p.seat] || []).join(''), shown: !!p.shown, showIdx: p.showIdx?.length ? p.showIdx.slice() : null,
    })),
  };
}

// One hand of handSummary for one viewer: their own cards, cards a player showed (only those of a
// partial show), and every card once the game has opened its deck (open), as visibleHoles does.
export function handView(s, tableId, viewerId, open) {
  const nets = {};
  const cards = {};
  for (const p of s.players) {
    nets[p.id] = p.net;
    if (!p.holes) continue;
    const all = p.holes.match(/../g);
    if (open || p.id === viewerId || p.shown) cards[p.id] = all;
    else if (p.showIdx) cards[p.id] = all.map((c, i) => (p.showIdx.includes(i) ? c : null));
  }
  return {
    tableId, handNumber: s.handNumber, at: s.at, gameType: s.gameType, isBomb: s.isBomb, runCount: s.runCount, doubleBoard: s.doubleBoard,
    pot: s.pot, showdown: s.showdown, allIn: s.allIn, straddle: s.straddle, replay: s.replay, bounty: s.bounty,
    revealed: s.sealed || open, nets, cards,
  };
}

// Hands played in whole chips count a chip as a dollar: 100 cents.
const scaleOf = (rec, table) => ((rec.decimals ?? table.decimals) ? 1 : 100);

// Keeps each hand's counts in memory, per table, so stats stay cheap to serve while a game runs,
// along with each hand's summary for the list of every hand. Tables whose hands are not loaded are
// read from disk once; their counts and summaries are kept, not the hands.
export class StatsBook {
  constructor() {
    this.byTable = new Map(); // tableId -> { count, lines, sums, names }
    this.version = 0;
  }

  entry(table) {
    let c = this.byTable.get(table.id);
    const loaded = table.records; // set once a table has played or been browsed since the server started
    if (c && !loaded) return c;
    const list = loaded || table.store.readHands(table.id);
    if (!c || c.count > list.length) c = { count: 0, lines: [], sums: [], names: new Map() };
    for (let i = c.count; i < list.length; i++) {
      const r = list[i];
      c.lines.push({ ...handLines(r, scaleOf(r, table)), tableId: table.id });
      c.sums.push(handSummary(r, scaleOf(r, table)));
      for (const p of r.players) c.names.set(p.userId || p.id, p.name);
    }
    c.count = list.length;
    this.byTable.set(table.id, c);
    return c;
  }

  linesFor(table) { return this.entry(table).lines; }

  summariesFor(table) { return this.entry(table).sums; }

  added() { this.version++; }

  // A hand already counted changed (cards shown after it, a 7-2 bounty claimed by showing them):
  // its counts and summary are worked out again from the changed record.
  changed(table, rec) {
    const c = this.byTable.get(table.id);
    const i = c ? c.sums.findIndex((x) => x.handNumber === rec.handNumber) : -1;
    if (i >= 0) {
      c.lines[i] = { ...handLines(rec, scaleOf(rec, table)), tableId: table.id };
      c.sums[i] = handSummary(rec, scaleOf(rec, table));
    }
    this.version++;
  }

  clear() { this.byTable.clear(); this.version++; }
}

// Stats rows for everyone in the given hands. nameOf(userId) gives the display name.
export function statsRows(lines, game, nameOf) {
  return [...aggregate(lines, game).entries()]
    .map(([userId, t]) => ({ userId, name: nameOf(userId), ...summarize(t) }))
    .filter((r) => r.hands > 0)
    .sort((a, b) => b.hands - a.hands || a.name.localeCompare(b.name));
}

export function gamesIn(lines) {
  const seen = new Map();
  for (const l of lines) seen.set(l.gameType, (seen.get(l.gameType) || 0) + 1);
  return [...seen.entries()].map(([id, hands]) => ({ id, hands })).sort((a, b) => b.hands - a.hands);
}
