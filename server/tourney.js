// Tourney games. A table is set up as a tourney when everyone buys in for the same amount, a set
// number of times at most, and the blinds go up on a clock. The game is over when one player has every
// chip, when its time runs out, or when the host ends it.
//
// Two ways to pay, chosen when the game is set up:
//   chips: chips are cash, as in the cash game. Each player cashes out the chips they hold, so the
//          player who ends with every chip takes the whole pool.
//   place: the buy-ins make a prize pool, paid by finishing place (a split such as 65/35). Players
//          are put out in order; when the game ends early, those still in are placed by their stacks.
//
// Chips are the same units as money at the table (a 500.00 buy-in is a 500.00 stack), in both ways.

export const DEFAULT_TOURNEY = {
  on: false,
  buyIn: 0, // the one buy-in, which is also the starting stack
  buyIns: 1, // the most times a player can buy in (1: no rebuys), or 0 for no limit
  lastRebuyLevel: 0, // buying in (sitting down or rebuying) is open through this level; 0: all game
  levelMinutes: 15,
  levels: [], // [small blind, big blind] for each level, the first being where the game starts
  pay: 'chips', // 'chips' or 'place'
  split: [65, 35], // for pay by place: the percentage each place gets, 1st first
};

// How long a minute is. Tests make it shorter.
export const TOURNEY_TIME = { minute: 60000 };

// Standard steps: about one and a half times the level before, in round numbers of the first big
// blind (0.25/0.50, 0.50/1, 0.75/1.50, 1/2, 1.50/3, 2/4, 3/6, ...).
export const STEP_TIMES = [1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 30, 40, 60, 80, 100, 120, 160, 200, 300, 400];
export function standardLevels(sb, bb) {
  return STEP_TIMES.map((k) => [Math.max(1, Math.round(sb * k)), bb * k]);
}

export const MAX_LEVELS = 40;
export const MAX_PLACES = 10;

const fail = (m) => { throw new Error(m); };
const whole = (v, lo, hi, label) => {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < lo || n > hi) fail(`${label} must be a whole number from ${lo} to ${hi}`);
  return n;
};

// Checks a tourney setup sent from a form. A value only has to be right while the tourney is on:
// with it off, an odd value keeps the one from before.
export function cleanTourney(input, current, fmtAmount = (a) => String(a)) {
  const t = { ...DEFAULT_TOURNEY, ...structuredClone(current || {}) };
  if (input === undefined || input === null) return t;
  if (input.on !== undefined) t.on = !!input.on;
  const take = (k, check) => {
    if (input[k] === undefined || input[k] === null) return;
    if (t.on) t[k] = check(input[k]);
    else { try { t[k] = check(input[k]); } catch { /* kept */ } }
  };
  take('buyIn', (v) => whole(v, 1, 1e13, 'The tourney buy-in'));
  take('buyIns', (v) => whole(v, 0, 100, 'Buy-ins per player'));
  take('lastRebuyLevel', (v) => whole(v, 0, MAX_LEVELS, 'The last level to buy in'));
  take('levelMinutes', (v) => whole(v, 1, 240, 'Minutes per level'));
  take('pay', (v) => (v === 'place' ? 'place' : v === 'chips' ? 'chips' : fail('Pick how the tourney pays')));
  take('levels', (v) => {
    if (!Array.isArray(v) || !v.length) fail('Add at least one blind level');
    if (v.length > MAX_LEVELS) fail(`A tourney can have at most ${MAX_LEVELS} blind levels`);
    return v.map((x, i) => {
      if (!Array.isArray(x) || x.length !== 2) fail(`Blind level ${i + 1} needs a small and a big blind`);
      const sb = whole(x[0], 1, 1e12, `The small blind at level ${i + 1}`);
      const bb = whole(x[1], 1, 1e12, `The big blind at level ${i + 1}`);
      if (sb > bb) fail(`At level ${i + 1} the small blind is bigger than the big blind (${fmtAmount(sb)}/${fmtAmount(bb)})`);
      return [sb, bb];
    });
  });
  take('split', (v) => {
    if (!Array.isArray(v) || !v.length) fail('Say how the prize pool is split, such as 65/35');
    if (v.length > MAX_PLACES) fail(`The prize pool can be split between ${MAX_PLACES} places at most`);
    const parts = v.map((x) => Number(x));
    if (parts.some((x) => !Number.isFinite(x) || x <= 0)) fail('Each place in the split needs a share above 0');
    const sum = Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100;
    if (sum !== 100) fail(`The split has to add up to 100 (it adds up to ${sum})`);
    return parts.map((x) => Math.round(x * 100) / 100);
  });
  if (t.on && !t.buyIn) fail('Enter the tourney buy-in');
  return t;
}

// What each paid place gets from the pool, 1st first. With fewer players than paid places, the shares
// of the places that exist are scaled up so the whole pool is paid; what rounding leaves goes to 1st.
export function payouts(pool, split, players) {
  const parts = split.slice(0, Math.max(1, Math.min(split.length, players)));
  const sum = parts.reduce((a, b) => a + b, 0);
  const out = parts.map((p) => Math.floor((pool * p) / sum));
  out[0] += pool - out.reduce((a, b) => a + b, 0);
  return out;
}

export function ordinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${s}`;
}

// Where a tourney stands while it is played (kept with the table).
export const newTourneyState = () => ({ level: 0, levelEndsAt: null, levelLeft: null, entries: {}, out: [], pool: 0, places: null });
