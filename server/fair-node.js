// Node crypto bindings for the shared fairness module.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  deriveDeckSync, buildEntropy, bombMessage, rollFromBlock, FAIRNESS_VERSION, FAIRNESS_V2,
  sealDeckV2, positionsSync, dealPositions,
} from '../shared/fairness.js';

export const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const hmacSync = (key, msg) => new Uint8Array(createHmac('sha256', key).update(msg, 'utf8').digest());
export const newServerSeed = () => randomBytes(32).toString('hex');
export const randomId = (bytes = 9) => randomBytes(bytes).toString('base64url');
export const randomToken = () => randomBytes(32).toString('hex');

// The seal published before a hand. Version 2 seals every card on its own, so folded cards can stay
// hidden while the rest of the hand is checked.
export function newCommitment(handNumber, version = FAIRNESS_VERSION) {
  const serverSeed = newServerSeed();
  const base = { version, handNumber, serverSeed, contributions: new Map(), createdAt: Date.now() };
  if (version !== FAIRNESS_V2) return { ...base, commitment: sha256Hex(serverSeed) };
  const sealed = sealDeckV2(hmacSync, sha256Hex, serverSeed);
  return { ...base, commitment: sealed.commitment, v2: sealed };
}

// Turns a pending commitment plus received contributions into a deck (and bomb roll).
export function settleCommitment(tableId, pending) {
  const contributions = [...pending.contributions.values()];
  const version = pending.version || FAIRNESS_VERSION;
  const entropy = buildEntropy(tableId, pending.handNumber, contributions.map((c) => c.seed), version);
  if (version === FAIRNESS_V2) {
    const { base, key } = pending.v2;
    const positions = positionsSync(hmacSync, key, entropy);
    const deck = positions.map((i) => base[i]);
    return { entropy, deck, bombRoll: rollFromBlock(hmacSync(key, bombMessage(entropy))), contributions };
  }
  const deck = deriveDeckSync(hmacSync, pending.serverSeed, entropy);
  const bombRoll = rollFromBlock(hmacSync(pending.serverSeed, bombMessage(entropy)));
  return { entropy, deck, bombRoll, contributions };
}

// The opened and sealed cards of a finished version 2 hand, for one viewer: the boards, shown cards
// and undealt cards for everyone, and the viewer's own hole cards for them alone.
// shownBySeat: { seat: [indexes of that seat's hole cards that were shown] }
export function openV2(serverSeed, key, entropy, dealt, shownBySeat, viewerSeat = null) {
  const sealed = sealDeckV2(hmacSync, sha256Hex, serverSeed);
  const positions = positionsSync(hmacSync, key, entropy);
  const at = dealPositions(dealt);
  const open = new Set([...at.board, ...at.undealt]);
  for (const [seat, idxs] of Object.entries(shownBySeat || {})) {
    for (const k of idxs) if (at.seats[seat] && at.seats[seat][k] !== undefined) open.add(at.seats[seat][k]);
  }
  const mine = viewerSeat !== null && at.seats[viewerSeat] ? at.seats[viewerSeat] : [];
  const opening = (j) => { const i = positions[j]; return { i, c: sealed.base[i], s: sealed.salts[i] }; };
  const openings = [...open].sort((a, b) => a - b).map(opening);
  const myOpenings = mine.filter((j) => !open.has(j)).map(opening);
  const shown = new Set([...openings, ...myOpenings].map((o) => o.i));
  const hidden = {};
  for (let i = 0; i < 52; i++) if (!shown.has(i)) hidden[i] = sealed.leaves[i];
  return { openings, myOpenings, sealed: hidden };
}
