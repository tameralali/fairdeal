// Provably fair dealing (commit, contribute, reveal).
//
// 1. Before a hand, the server picks a secret serverSeed (32 random bytes, hex) and publishes
//    commitment = SHA-256(serverSeed). It cannot change the seed afterwards without breaking the hash.
// 2. Every seated player's browser sends a random contribution (hex) after seeing the commitment.
//    The server cannot know these when it commits, so it cannot pick a seed that favours anyone.
// 3. entropy = "<protocol version>|<tableId>|<handNumber>|<contributions sorted alphabetically, comma separated>"
//    where the protocol version is stored with every hand record (currently "aquarium-v1").
//    Sorting makes the order independent of the server.
// 4. A byte stream is produced with HMAC-SHA256(key = serverSeed, message = entropy + "|" + counter)
//    for counter = 0, 1, 2 ... Each 32-byte block yields eight big-endian unsigned 32-bit integers.
// 5. The canonical deck (2c 2d 2h 2s 3c ... As) is shuffled with Fisher-Yates from the top index down,
//    drawing an unbiased index with rejection sampling.
// 6. Cards are dealt from the top of the shuffled deck: hole cards one at a time, starting left of the
//    button, then community cards in order. No burn cards. When a hand is run more than once, each
//    extra run continues from the next card in the deck.
// 7. After the hand (or the session, depending on the table setting) the serverSeed is revealed and anyone
//    can recompute every card.
//
// This module has no platform dependencies: crypto is passed in, so the exact same code runs on the
// server (node:crypto) and in the browser verifier (WebCrypto).
//
// Version 2 ("aquarium-v2", tables where folded cards stay hidden) seals every card on its own, so a
// hand can be checked without showing the cards that were folded:
// 1. Before the hand the server shuffles a base deck from its secret seed alone, and seals each base
//    position i with leaf_i = SHA-256("aquarium-v2|leaf|i|card|salt_i"), salt_i a secret 128-bit value.
//    It also picks a secret key and publishes
//    commitment = SHA-256("aquarium-v2|commit|leaf_0,...,leaf_51|SHA-256(key)").
// 2. Players add their random inputs, as in version 1.
// 3. The positions are shuffled with HMAC-SHA256(key, entropy + "|" + counter) (Fisher-Yates over
//    0..51, same draw rule as the deck), and the card dealt at deck position j is base[position[j]].
//    The server could not know the players' inputs when it sealed the deck, so it cannot steer cards.
// 4. After the hand the server reveals the key and opens (index, card, salt) for every card that was
//    seen or never dealt: the boards, cards players showed, and the rest of the deck. For folded cards
//    it publishes only the leaf. Each player's own cards are opened to that player alone.
// 5. Anyone rebuilds the commitment from the openings and leaves, recomputes the positions and checks
//    that every opened card sits where the record says it was dealt. A folded card is never opened.

import { CANONICAL_DECK } from './cards.js';

export const FAIRNESS_VERSION = 'aquarium-v1';
export const FAIRNESS_V2 = 'aquarium-v2';
const SEED_RE = /^[0-9a-f]{16,64}$/;

export function isValidContribution(seed) {
  return typeof seed === 'string' && SEED_RE.test(seed);
}

export function buildEntropy(tableId, handNumber, seeds, version = FAIRNESS_VERSION) {
  const sorted = [...seeds].sort();
  return `${version}|${tableId}|${handNumber}|${sorted.join(',')}`;
}

export class NeedMoreBlocks extends Error {}

function uint32At(block, offset) {
  return ((block[offset] << 24) | (block[offset + 1] << 16) | (block[offset + 2] << 8) | block[offset + 3]) >>> 0;
}

// Unbiased integer in [0, n) using rejection sampling on 32-bit draws.
export function uniformInt(next, n) {
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    const r = next();
    if (r < limit) return r % n;
  }
}

export function shuffleWith(next, items = CANONICAL_DECK) {
  const deck = items.slice();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = uniformInt(next, i + 1);
    const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  return deck;
}

export function blockMessage(entropy, counter) {
  return `${entropy}|${counter}`;
}

function syncStream(hmacSync, key, message) {
  let counter = 0;
  let block = null;
  let off = 32;
  return () => {
    if (off >= 32) { block = hmacSync(key, message(counter++)); off = 0; }
    const v = uint32At(block, off);
    off += 4;
    return v;
  };
}

// Synchronous derivation (server). hmacSync(key, message) -> Uint8Array(32)
export function deriveDeckSync(hmacSync, serverSeed, entropy) {
  return shuffleWith(syncStream(hmacSync, serverSeed, (c) => blockMessage(entropy, c)));
}

function streamFromBlocks(blocks) {
  let bi = 0;
  let off = 0;
  return () => {
    if (bi >= blocks.length) throw new NeedMoreBlocks('need more entropy blocks');
    const v = uint32At(blocks[bi], off);
    off += 4;
    if (off >= 32) { off = 0; bi++; }
    return v;
  };
}

async function shuffleAsync(hmacAsync, key, message, items) {
  let n = 12;
  for (;;) {
    const blocks = await Promise.all(Array.from({ length: n }, (_, i) => hmacAsync(key, message(i))));
    try {
      return shuffleWith(streamFromBlocks(blocks), items);
    } catch (e) {
      if (e instanceof NeedMoreBlocks) { n *= 2; continue; }
      throw e;
    }
  }
}

// Asynchronous derivation (browser WebCrypto). Produces the identical deck.
export function deriveDeckAsync(hmacAsync, serverSeed, entropy) {
  return shuffleAsync(hmacAsync, serverSeed, (c) => blockMessage(entropy, c), CANONICAL_DECK);
}

// ---------- version 2: every card sealed on its own ----------
const INDICES = Array.from({ length: 52 }, (_, i) => i);
const hex = (bytes, n = bytes.length) => [...bytes.slice(0, n)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const leafMessage = (i, card, salt) => `${FAIRNESS_V2}|leaf|${i}|${card}|${salt}`;
export const commitMessage = (leaves, keyHash) => `${FAIRNESS_V2}|commit|${leaves.join(',')}|${keyHash}`;

// Server side, before the hand: the sealed base deck. sha256Hex(string) -> hex.
export function sealDeckV2(hmacSync, sha256Hex, serverSeed) {
  const base = shuffleWith(syncStream(hmacSync, serverSeed, (c) => `${FAIRNESS_V2}|base|${c}`));
  const salts = INDICES.map((i) => hex(hmacSync(serverSeed, `${FAIRNESS_V2}|salt|${i}`), 16));
  const leaves = INDICES.map((i) => sha256Hex(leafMessage(i, base[i], salts[i])));
  const key = hex(hmacSync(serverSeed, `${FAIRNESS_V2}|key`));
  const keyHash = sha256Hex(key);
  return { base, salts, leaves, key, keyHash, commitment: sha256Hex(commitMessage(leaves, keyHash)) };
}

// Where each deck position's card comes from in the base deck, once the players' inputs are in.
export function positionsSync(hmacSync, key, entropy) {
  return shuffleWith(syncStream(hmacSync, key, (c) => blockMessage(entropy, c)), INDICES);
}
export function positionsAsync(hmacAsync, key, entropy) {
  return shuffleAsync(hmacAsync, key, (c) => blockMessage(entropy, c), INDICES);
}

// Deck positions of each seat's hole cards, of the boards, and of the cards nobody was dealt.
export function dealPositions(dealt) {
  const n = dealt.dealOrder.length;
  const seats = {};
  dealt.dealOrder.forEach((seat, k) => { seats[seat] = Array.from({ length: dealt.holeCount }, (_, r) => r * n + k); });
  const holes = n * dealt.holeCount;
  const boardCount = Array.isArray(dealt.placements) ? dealt.placements.length : 0;
  const board = Array.from({ length: boardCount }, (_, k) => holes + k);
  const undealt = [];
  for (let j = holes + boardCount; j < 52; j++) undealt.push(j);
  return { seats, board, undealt };
}

// Random bomb pot decision (only used when the table's bomb pot mode is "percent").
// roll = first 32-bit integer of HMAC(serverSeed, entropy + "|bomb") scaled to [0, 100).
export function bombMessage(entropy) {
  return `${entropy}|bomb`;
}

export function rollFromBlock(block) {
  return Math.floor((uint32At(block, 0) / 0x100000000) * 1000000) / 10000; // 4 decimals
}

// Rebuilds who got which card from a shuffled deck.
// dealt = { dealOrder: [seat...], holeCount, boards: [[cards]...], placements: [[boardIndex...]...] }
// placements lists, for every deck card dealt after the hole cards, the board(s) it went to
// (a card dealt before a hand is run more than once belongs to every run's copy of that board).
// Older records have no placements: one board per run sharing its first sharedCount cards.
export function reconstructDeal(deck, dealt) {
  let p = 0;
  const holes = {};
  for (const seat of dealt.dealOrder) holes[seat] = [];
  for (let r = 0; r < dealt.holeCount; r++) {
    for (const seat of dealt.dealOrder) holes[seat].push(deck[p++]);
  }
  if (Array.isArray(dealt.placements)) {
    const boards = dealt.boards.map(() => []);
    for (const targets of dealt.placements) {
      const c = deck[p++];
      for (const b of targets) (boards[b] ||= []).push(c);
    }
    return { holes, boards, cardsUsed: p };
  }
  const shared = deck.slice(p, p + dealt.sharedCount);
  p += dealt.sharedCount;
  const boards = dealt.boards.map((b) => {
    const extra = Math.max(0, b.length - dealt.sharedCount);
    const run = shared.concat(deck.slice(p, p + extra));
    p += extra;
    return run;
  });
  return { holes, boards, cardsUsed: p };
}

function sameCards(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// WebCrypto adapter (browser, and Node 20+ which exposes globalThis.crypto.subtle).
export function webCryptoAdapter(subtle = globalThis.crypto.subtle) {
  const enc = new TextEncoder();
  const keyCache = new Map();
  const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return {
    async sha256Hex(str) {
      return toHex(await subtle.digest('SHA-256', enc.encode(str)));
    },
    async hmac(key, msg) {
      let k = keyCache.get(key);
      if (!k) {
        k = await subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        keyCache.set(key, k);
      }
      return new Uint8Array(await subtle.sign('HMAC', k, enc.encode(msg)));
    },
  };
}

function bombCheck(record, add, roll) {
  const b = record.bomb;
  if (!b || !(b.mode === 'percent' || b.mode === 'both') || b.reason === 'manual') return;
  const fair = b.reason === 'every' ? true : (roll < b.percent) === !!record.isBomb;
  add(`Bomb pot roll ${roll.toFixed(4)} vs ${b.percent}% threshold`, roll === b.roll && fair);
}

// Full verification of a revealed hand record.
// observed (optional, from the player's own browser): { commitment, mySeed, mySeat, myHole, boards }
export async function verifyHandRecord(record, crypto, observed = {}) {
  if ((record.fairness || {}).version === FAIRNESS_V2) return verifyV2(record, crypto, observed);
  const checks = [];
  const add = (label, ok, detail = '') => checks.push({ label, ok: !!ok, detail });
  const f = record.fairness || {};
  if (!f.serverSeed) {
    return { ok: false, pending: true, checks: [{ label: 'Server seed not revealed yet', ok: false, detail: 'It is revealed according to the table setting.' }] };
  }
  const hash = await crypto.sha256Hex(f.serverSeed);
  add('SHA-256 of the revealed server seed equals the commitment published before the deal', hash === f.commitment, hash);
  if (observed.commitment) {
    add('Commitment matches the one your browser saw before the deal', observed.commitment === f.commitment);
  }
  const seeds = (f.contributions || []).map((c) => c.seed);
  const entropy = buildEntropy(record.tableId, record.handNumber, seeds, f.version || FAIRNESS_VERSION);
  add('Entropy string rebuilt from the player contributions', entropy === f.entropy);
  if (observed.mySeed) {
    add('Your browser’s contribution was included', seeds.includes(observed.mySeed));
  }
  const deck = await deriveDeckAsync(crypto.hmac, f.serverSeed, entropy);
  if (Array.isArray(f.deck)) add('Recomputed deck order matches the published deck', sameCards(deck, f.deck));
  const deal = reconstructDeal(deck, record.dealt);
  let holesOk = true;
  for (const [seat, cards] of Object.entries(record.dealt.holes || {})) {
    if (cards && !sameCards(cards, deal.holes[seat])) holesOk = false;
  }
  add('Every player’s hole cards came off the deck in dealing order', holesOk);
  let boardsOk = record.dealt.boards.length === deal.boards.length;
  record.dealt.boards.forEach((b, i) => { if (!sameCards(b, deal.boards[i])) boardsOk = false; });
  add(record.dealt.boards.length > 1 ? `All ${record.dealt.boards.length} boards came off the deck in order` : 'The board came off the deck in order', boardsOk);
  if (observed.myHole && observed.mySeat !== undefined && observed.mySeat !== null) {
    add('The hole cards you were shown match the recomputed deal', sameCards(observed.myHole, deal.holes[observed.mySeat]));
  }
  if (Array.isArray(observed.boards) && observed.boards.length) {
    let ok = true;
    observed.boards.forEach((b, i) => {
      const full = deal.boards[i] || [];
      if (!sameCards(b, full.slice(0, b.length))) ok = false;
    });
    add('The boards you were shown match the recomputed deal', ok);
  }
  if (record.bomb && (record.bomb.mode === 'percent' || record.bomb.mode === 'both') && record.bomb.reason !== 'manual') {
    bombCheck(record, add, rollFromBlock(await crypto.hmac(f.serverSeed, bombMessage(entropy))));
  }
  return { ok: checks.every((c) => c.ok), checks, deck, deal, entropy, rebuilt: hash };
}

// Version 2: only seen and undealt cards are opened; folded cards stay sealed.
async function verifyV2(record, crypto, observed) {
  const checks = [];
  const add = (label, ok, detail = '') => checks.push({ label, ok: !!ok, detail });
  const f = record.fairness || {};
  if (!f.key) {
    return { ok: false, pending: true, checks: [{ label: 'The cards have not been opened yet', ok: false, detail: 'They are opened when the hand ends.' }] };
  }
  const opened = new Map();
  for (const o of [...(f.openings || []), ...(f.myOpenings || [])]) opened.set(o.i, o);
  const leaves = [];
  let leavesOk = true;
  for (let i = 0; i < 52; i++) {
    const o = opened.get(i);
    if (o) leaves.push(await crypto.sha256Hex(leafMessage(i, o.c, o.s)));
    else if (f.sealed && typeof f.sealed[i] === 'string') leaves.push(f.sealed[i]);
    else { leavesOk = false; leaves.push(''); }
  }
  const keyHash = await crypto.sha256Hex(f.key);
  const rebuilt = await crypto.sha256Hex(commitMessage(leaves, keyHash));
  add('Every card’s seal is accounted for', leavesOk);
  add('The opened cards and sealed cards rebuild the commitment published before the deal', leavesOk && rebuilt === f.commitment, rebuilt);
  if (observed.commitment) add('Commitment matches the one your browser saw before the deal', observed.commitment === f.commitment);
  const seeds = (f.contributions || []).map((c) => c.seed);
  const entropy = buildEntropy(record.tableId, record.handNumber, seeds, FAIRNESS_V2);
  add('Entropy string rebuilt from the player contributions', entropy === f.entropy);
  if (observed.mySeed) add('Your browser’s contribution was included', seeds.includes(observed.mySeed));
  const pos = await positionsAsync(crypto.hmac, f.key, entropy);
  const deck = pos.map((i) => (opened.has(i) ? opened.get(i).c : null));
  const cards = [...opened.values()].map((o) => o.c);
  add('No card was opened twice', new Set(cards).size === cards.length && cards.every((c) => CANONICAL_DECK.includes(c)));
  const deal = reconstructDeal(deck, record.dealt);
  const at = dealPositions(record.dealt);
  add('Every card nobody was dealt was opened', at.undealt.every((j) => deck[j] !== null));
  let boardsOk = record.dealt.boards.length === deal.boards.length;
  record.dealt.boards.forEach((b, i) => { if (!sameCards(b, deal.boards[i])) boardsOk = false; });
  add(record.dealt.boards.length > 1 ? `All ${record.dealt.boards.length} boards came off the sealed deck in order` : 'The board came off the sealed deck in order', boardsOk);
  let shownOk = true;
  for (const [seat, list] of Object.entries(record.dealt.holes || {})) {
    (list || []).forEach((c, k) => { if (c && deal.holes[seat]?.[k] !== c) shownOk = false; });
  }
  add('Every card that was shown came off the sealed deck where it was dealt', shownOk);
  if (observed.myHole && observed.mySeat !== undefined && observed.mySeat !== null) {
    add('Your own hole cards came off the sealed deck where they were dealt', sameCards(observed.myHole, deal.holes[observed.mySeat]));
  }
  if (Array.isArray(observed.boards) && observed.boards.length) {
    let ok = true;
    observed.boards.forEach((b, i) => { if (!sameCards(b, (deal.boards[i] || []).slice(0, b.length))) ok = false; });
    add('The boards you were shown match the opened cards', ok);
  }
  bombCheck(record, add, rollFromBlock(await crypto.hmac(f.key, bombMessage(entropy))));
  const hidden = deck.filter((c) => c === null).length;
  return { ok: checks.every((c) => c.ok), checks, deck, deal, entropy, rebuilt, hidden };
}
