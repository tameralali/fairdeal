// Each player's chance of winning when everyone left is all in and the cards are face up, worked out
// in the browser from the cards on the table only (folded cards count as unknown).
import { bestHand } from './evaluator.js';
import { CANONICAL_DECK } from './cards.js';

const cache = new Map();

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// hands: [{ seat, hole }]; boards: the boards of the run being dealt; out: other cards already seen
// (earlier runs, shown folds). Returns Map seat -> percent, each board worth an equal share, ties split.
export function equity(hands, boards, omaha, out = []) {
  const key = JSON.stringify([hands.map((h) => [h.seat, h.hole]), boards, omaha, out]);
  if (cache.has(key)) return cache.get(key);
  const used = new Set([...hands.flatMap((h) => h.hole), ...boards.flat(), ...out]);
  const rest = CANONICAL_DECK.filter((c) => !used.has(c));
  const need = boards.map((b) => Math.max(0, 5 - b.length));
  const total = need.reduce((a, b) => a + b, 0);
  const share = new Map(hands.map((h) => [h.seat, 0]));
  let trials = 0;
  const score = (full) => {
    for (const b of full) {
      let best = -1;
      let winners = [];
      for (const h of hands) {
        const r = bestHand(h.hole, b, omaha);
        const sc = r ? r.score : -1;
        if (sc > best) { best = sc; winners = [h.seat]; } else if (sc === best) winners.push(h.seat);
      }
      for (const w of winners) share.set(w, share.get(w) + 1 / winners.length / full.length);
    }
    trials++;
  };
  if (boards.length === 1 && need[0] <= 2) {
    const b = boards[0];
    if (need[0] === 0) score([b]);
    else if (need[0] === 1) for (const c of rest) score([[...b, c]]);
    else for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) score([[...b, rest[i], rest[j]]]);
  } else {
    // a fixed sample, seeded from the cards, so the numbers do not jump between redraws
    let seed = hash(key) || 1;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const pool = rest.slice();
    const n = omaha ? (boards.length > 1 ? 400 : 700) : 2500;
    for (let t = 0; t < n; t++) {
      for (let i = 0; i < total; i++) {
        const j = i + Math.floor(rnd() * (pool.length - i));
        const x = pool[i]; pool[i] = pool[j]; pool[j] = x;
      }
      let k = 0;
      score(boards.map((b, bi) => { const add = pool.slice(k, k + need[bi]); k += need[bi]; return [...b, ...add]; }));
    }
  }
  const pct = new Map([...share].map(([seat, v]) => [seat, trials ? (v / trials) * 100 : 0]));
  cache.set(key, pct);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return pct;
}
