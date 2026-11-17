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

import { CANONICAL_DECK } from './cards.js';

export const FAIRNESS_VERSION = 'aquarium-v1';
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

export function shuffleWith(next) {
  const deck = CANONICAL_DECK.slice();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = uniformInt(next, i + 1);
    const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  return deck;
}

export function blockMessage(entropy, counter) {
  return `${entropy}|${counter}`;
}

// Synchronous derivation (server). hmacSync(key, message) -> Uint8Array(32)
export function deriveDeckSync(hmacSync, serverSeed, entropy) {
  let counter = 0;
  let block = null;
  let off = 32;
  const next = () => {
    if (off >= 32) { block = hmacSync(serverSeed, blockMessage(entropy, counter++)); off = 0; }
    const v = uint32At(block, off);
    off += 4;
    return v;
  };
  return shuffleWith(next);
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

// Asynchronous derivation (browser WebCrypto). Produces the identical deck.
export async function deriveDeckAsync(hmacAsync, serverSeed, entropy) {
  let n = 12;
  for (;;) {
    const blocks = await Promise.all(Array.from({ length: n }, (_, i) => hmacAsync(serverSeed, blockMessage(entropy, i))));
    try {
      return shuffleWith(streamFromBlocks(blocks));
    } catch (e) {
      if (e instanceof NeedMoreBlocks) { n *= 2; continue; }
      throw e;
    }
  }
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

// Full verification of a revealed hand record.
// observed (optional, from the player's own browser): { commitment, mySeed, mySeat, myHole, boards }
export async function verifyHandRecord(record, crypto, observed = {}) {
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
  if (record.bomb && record.bomb.mode === 'percent' && record.bomb.reason !== 'manual') {
    const block = await crypto.hmac(f.serverSeed, bombMessage(entropy));
    const roll = rollFromBlock(block);
    const shouldBomb = roll < record.bomb.percent;
    add(`Bomb pot roll ${roll.toFixed(4)} vs ${record.bomb.percent}% threshold`, roll === record.bomb.roll && shouldBomb === !!record.isBomb);
  }
  return { ok: checks.every((c) => c.ok), checks, deck, deal, entropy };
}
