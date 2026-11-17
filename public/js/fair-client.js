// Browser side of provable fairness:
//  - adds this browser's random contribution to each upcoming deal,
//  - remembers the commitment it saw before the deal, its own hole cards and the boards,
//  - once the server reveals a hand's seed, re-derives the deck locally and checks everything.
import { verifyHandRecord, webCryptoAdapter } from '/shared/fairness.js';

const crypto = webCryptoAdapter();
const MAX_HANDS = 600;

function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export class FairClient {
  constructor(tableId, emit, onVerified) {
    this.tableId = tableId;
    this.emit = emit;
    this.onVerified = onVerified;
    this.key = 'fd:fair:' + tableId;
    this.data = this.load();
    this.contributing = null;
    this.verifying = new Set();
  }

  load() {
    try { return JSON.parse(localStorage.getItem(this.key) || '{"hands":{}}'); }
    catch { return { hands: {} }; }
  }

  save() {
    const nums = Object.keys(this.data.hands).map(Number).sort((a, b) => a - b);
    while (nums.length > MAX_HANDS) delete this.data.hands[nums.shift()];
    try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch { /* quota */ }
  }

  rec(n) { return (this.data.hands[n] ||= {}); }
  result(n) { return this.data.hands[n]?.result || null; }
  observed(n) { return this.data.hands[n] || null; }

  onState(s) {
    const f = s.fairness;
    if (f && f.commitment) {
      const r = this.rec(f.handNumber);
      if (!r.commitment) { r.commitment = f.commitment; this.save(); }
      if (s.me.seated && !f.iContributed && this.contributing !== f.commitment) {
        this.contributing = f.commitment;
        const seed = randomHex(16);
        this.emit('fair:contribute', { handNumber: f.handNumber, commitment: f.commitment, seed }).then((ack) => {
          if (ack && ack.ok && !ack.stale && !ack.notSeated && !ack.already) {
            this.rec(f.handNumber).seed = seed;
            this.save();
          }
        });
      }
    }
    const h = s.hand;
    if (h) {
      const r = this.rec(h.number);
      const me = h.players.find((p) => p.id === s.me.userId);
      let changed = false;
      if (me && me.hole && me.hole.length) {
        if (JSON.stringify(r.myHole) !== JSON.stringify(me.hole)) { r.myHole = me.hole; r.mySeat = me.seat; changed = true; }
      }
      const boards = h.runs ? h.runs : [h.board];
      if (boards.some((b) => b.length) && JSON.stringify(r.boards) !== JSON.stringify(boards)) { r.boards = boards; changed = true; }
      if (changed) this.save();
    }
  }

  async verify(record) {
    const o = this.observed(record.handNumber) || {};
    const observed = {};
    if (o.commitment) observed.commitment = o.commitment;
    if (o.seed) observed.mySeed = o.seed;
    if (o.myHole) { observed.myHole = o.myHole; observed.mySeat = o.mySeat; }
    if (o.boards) observed.boards = o.boards;
    const res = await verifyHandRecord(record, crypto, observed);
    if (!res.pending) {
      this.rec(record.handNumber).result = { ok: res.ok, at: Date.now(), checks: res.checks.length };
      this.save();
    }
    return res;
  }

  // Verify every hand this browser watched, up to `through`, that is not verified yet.
  async onRevealed(through, fetchRecord) {
    const todo = Object.keys(this.data.hands).map(Number)
      .filter((n) => n <= through && !this.data.hands[n].result && (this.data.hands[n].boards || this.data.hands[n].myHole) && !this.verifying.has(n))
      .sort((a, b) => a - b)
      .slice(-60);
    for (const n of todo) {
      this.verifying.add(n);
      try {
        const record = await fetchRecord(n);
        if (record && record.revealed) {
          const res = await this.verify(record);
          this.onVerified && this.onVerified(n, res);
        }
      } catch { /* hand may be from before this browser joined */ }
      this.verifying.delete(n);
    }
  }
}
