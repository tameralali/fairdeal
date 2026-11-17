// Poker hand evaluator for Hold'em (best 5 of 7) and Omaha (exactly 2 hole + 3 board).
// Scores are integers: higher is better. category occupies bits 20+, ranks fill 4-bit slots below.

import { RANKS, SUITS } from './cards.js';

const RANK_OF = {};
const SUIT_OF = {};
for (let i = 0; i < RANKS.length; i++) RANK_OF[RANKS[i]] = i + 2;
for (let i = 0; i < SUITS.length; i++) SUIT_OF[SUITS[i]] = i;

const NAMES = [null, null, 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const PLURAL = [null, null, 'Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];

export const CATEGORY_NAMES = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
];

const R = new Int32Array(5);
const S = new Int32Array(5);
const GR = new Int32Array(5);
const GC = new Int32Array(5);

// Scores the five cards currently loaded in R (ranks) and S (suits). Sorts R in place.
function scoreLoaded() {
  for (let i = 1; i < 5; i++) {
    const v = R[i];
    let j = i - 1;
    while (j >= 0 && R[j] < v) { R[j + 1] = R[j]; j--; }
    R[j + 1] = v;
  }
  const flush = S[0] === S[1] && S[0] === S[2] && S[0] === S[3] && S[0] === S[4];
  let distinct = 1;
  for (let i = 1; i < 5; i++) if (R[i] !== R[i - 1]) distinct++;
  if (distinct === 5) {
    let high = 0;
    if (R[0] - R[4] === 4) high = R[0];
    else if (R[0] === 14 && R[1] === 5) high = 5; // wheel A-2-3-4-5
    if (high) return ((flush ? 8 : 4) << 20) | (high << 16);
    const base = ((flush ? 5 : 0) << 20);
    return base | (R[0] << 16) | (R[1] << 12) | (R[2] << 8) | (R[3] << 4) | R[4];
  }
  if (flush) return (5 << 20) | (R[0] << 16) | (R[1] << 12) | (R[2] << 8) | (R[3] << 4) | R[4];
  // group equal ranks (adjacent after sort), then order groups by size (stable keeps rank order)
  let g = 0;
  for (let i = 0; i < 5;) {
    let j = i;
    while (j < 5 && R[j] === R[i]) j++;
    GR[g] = R[i]; GC[g] = j - i; g++;
    i = j;
  }
  for (let i = 1; i < g; i++) {
    const c = GC[i], r = GR[i];
    let j = i - 1;
    while (j >= 0 && GC[j] < c) { GC[j + 1] = GC[j]; GR[j + 1] = GR[j]; j--; }
    GC[j + 1] = c; GR[j + 1] = r;
  }
  if (GC[0] === 4) return (7 << 20) | (GR[0] << 16) | (GR[1] << 12);
  if (GC[0] === 3 && GC[1] === 2) return (6 << 20) | (GR[0] << 16) | (GR[1] << 12);
  if (GC[0] === 3) return (3 << 20) | (GR[0] << 16) | (GR[1] << 12) | (GR[2] << 8);
  if (GC[0] === 2 && GC[1] === 2) return (2 << 20) | (GR[0] << 16) | (GR[1] << 12) | (GR[2] << 8);
  return (1 << 20) | (GR[0] << 16) | (GR[1] << 12) | (GR[2] << 8) | (GR[3] << 4);
}

export function score5(cards) {
  for (let i = 0; i < 5; i++) { R[i] = RANK_OF[cards[i][0]]; S[i] = SUIT_OF[cards[i][1]]; }
  return scoreLoaded();
}

export function categoryOf(score) {
  return score >> 20;
}

export function handName(score) {
  const c = score >> 20;
  const a = (score >> 16) & 15;
  const b = (score >> 12) & 15;
  switch (c) {
    case 8: return a === 14 ? 'Royal Flush' : `Straight Flush, ${NAMES[a]} high`;
    case 7: return `Four of a Kind, ${PLURAL[a]}`;
    case 6: return `Full House, ${PLURAL[a]} full of ${PLURAL[b]}`;
    case 5: return `Flush, ${NAMES[a]} high`;
    case 4: return `Straight, ${NAMES[a]} high`;
    case 3: return `Three of a Kind, ${PLURAL[a]}`;
    case 2: return `Two Pair, ${PLURAL[a]} and ${PLURAL[b]}`;
    case 1: return `Pair of ${PLURAL[a]}`;
    default: return `${NAMES[a]} High`;
  }
}

// Best hand for a player. Hold'em: any 5 of hole+board. Omaha: exactly 2 hole + 3 board.
// Returns { score, name, cards, category } or null if not enough cards.
export function bestHand(hole, board, omaha) {
  const hr = hole.map((c) => RANK_OF[c[0]]);
  const hs = hole.map((c) => SUIT_OF[c[1]]);
  const br = board.map((c) => RANK_OF[c[0]]);
  const bs = board.map((c) => SUIT_OF[c[1]]);
  let best = -1;
  let combo = null;
  if (omaha) {
    if (hole.length < 2 || board.length < 3) return null;
    for (let i = 0; i < hole.length; i++) {
      for (let j = i + 1; j < hole.length; j++) {
        for (let a = 0; a < board.length; a++) {
          for (let b = a + 1; b < board.length; b++) {
            for (let c = b + 1; c < board.length; c++) {
              R[0] = hr[i]; R[1] = hr[j]; R[2] = br[a]; R[3] = br[b]; R[4] = br[c];
              S[0] = hs[i]; S[1] = hs[j]; S[2] = bs[a]; S[3] = bs[b]; S[4] = bs[c];
              const sc = scoreLoaded();
              if (sc > best) { best = sc; combo = [hole[i], hole[j], board[a], board[b], board[c]]; }
            }
          }
        }
      }
    }
  } else {
    const all = hole.concat(board);
    const ar = hr.concat(br);
    const as = hs.concat(bs);
    const n = all.length;
    if (n < 5) return null;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        for (let c = b + 1; c < n; c++) {
          for (let d = c + 1; d < n; d++) {
            for (let e = d + 1; e < n; e++) {
              R[0] = ar[a]; R[1] = ar[b]; R[2] = ar[c]; R[3] = ar[d]; R[4] = ar[e];
              S[0] = as[a]; S[1] = as[b]; S[2] = as[c]; S[3] = as[d]; S[4] = as[e];
              const sc = scoreLoaded();
              if (sc > best) { best = sc; combo = [all[a], all[b], all[c], all[d], all[e]]; }
            }
          }
        }
      }
    }
  }
  return { score: best, name: handName(best), cards: combo, category: best >> 20 };
}
