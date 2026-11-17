// Node crypto bindings for the shared fairness module.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { deriveDeckSync, buildEntropy, bombMessage, rollFromBlock } from '../shared/fairness.js';

export const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const hmacSync = (key, msg) => new Uint8Array(createHmac('sha256', key).update(msg, 'utf8').digest());
export const newServerSeed = () => randomBytes(32).toString('hex');
export const randomId = (bytes = 9) => randomBytes(bytes).toString('base64url');
export const randomToken = () => randomBytes(32).toString('hex');

export function newCommitment(handNumber) {
  const serverSeed = newServerSeed();
  return { handNumber, serverSeed, commitment: sha256Hex(serverSeed), contributions: new Map(), createdAt: Date.now() };
}

// Turns a pending commitment plus received contributions into a deck (and bomb roll).
export function settleCommitment(tableId, pending) {
  const contributions = [...pending.contributions.values()];
  const entropy = buildEntropy(tableId, pending.handNumber, contributions.map((c) => c.seed));
  const deck = deriveDeckSync(hmacSync, pending.serverSeed, entropy);
  const bombRoll = rollFromBlock(hmacSync(pending.serverSeed, bombMessage(entropy)));
  return { entropy, deck, bombRoll, contributions };
}
