// Club ledger: members hold chip balances, managers add/remove chips with a note, set per-member
// credit limits (how far below zero a member may buy in), record settlements, and optionally let
// members transfer chips to each other. Club tables draw buy-ins from these balances and return
// chips to them on cash-out. Every movement is a transaction with the resulting balance.
import { randomId } from './fair-node.js';
import { randomBytes } from 'node:crypto';

const ROLES = ['owner', 'manager', 'member'];

function inviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

function cleanClubName(name) {
  const n = String(name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
  if (n.length < 2 || n.length > 40) throw new Error('Club name must be 2 to 40 characters');
  return n;
}

function cleanNote(note) {
  return String(note ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, 140);
}

function toInt(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.floor(n) !== n) throw new Error(`${label} must be a whole number of chips`);
  return n;
}

export class Clubs {
  constructor(store, auth) {
    this.store = store;
    this.auth = auth;
    this.listeners = new Set();
    this.chipsOnTables = () => new Map(); // set by the table manager: clubId -> Map(userId -> chips)
  }

  get data() { return this.store.data.clubs; }
  onChange(fn) { this.listeners.add(fn); }
  changed(clubId) { this.store.save(); for (const fn of this.listeners) fn(clubId); }

  club(id) {
    const c = this.data[id];
    if (!c) throw new Error('Club not found');
    return c;
  }

  activeMember(c, userId) {
    const m = c.members[userId];
    return m && m.status === 'active' ? m : null;
  }

  role(clubId, userId) {
    const c = this.data[clubId];
    const m = c && this.activeMember(c, userId);
    return m ? m.role : null;
  }

  isManager(clubId, userId) {
    const r = this.role(clubId, userId);
    return r === 'owner' || r === 'manager';
  }

  requireManager(c, user) {
    if (!this.isManager(c.id, user.id)) throw new Error('Only the club owner or a manager can do that');
  }

  requireRegistered(user) {
    if (!user.username) throw new Error('Create an account with a username and password first, so your club balance is never tied to one browser');
  }

  nameOf(userId) {
    return this.auth.users[userId]?.name || 'Unknown';
  }

  forUser(userId) {
    return Object.values(this.data)
      .filter((c) => c.members[userId])
      .map((c) => {
        const m = c.members[userId];
        return { id: c.id, name: c.name, role: m.role, status: m.status, balance: m.status === 'active' ? m.balance : null, decimals: c.settings.decimals };
      });
  }

  create(user, { name, decimals }) {
    this.requireRegistered(user);
    const id = randomId(6);
    const c = {
      id,
      name: cleanClubName(name),
      ownerId: user.id,
      createdAt: Date.now(),
      inviteCode: inviteCode(),
      settings: { decimals: Number(decimals) === 2 ? 2 : 0, membersSeeLedger: false, allowTransfers: false, requireApproval: true, defaultCreditLimit: 0 },
      members: { [user.id]: { userId: user.id, role: 'owner', status: 'active', balance: 0, creditLimit: 0, joinedAt: Date.now() } },
      transactions: [],
      announcement: '',
    };
    this.data[id] = c;
    this.changed(id);
    return c;
  }

  lookupInvite(code) {
    const c = Object.values(this.data).find((x) => x.inviteCode === String(code || '').toUpperCase().trim());
    if (!c) throw new Error('That invite code is not valid');
    return c;
  }

  joinByCode(user, code) {
    this.requireRegistered(user);
    const c = this.lookupInvite(code);
    const existing = c.members[user.id];
    if (existing && existing.status === 'active') return { club: c, status: 'active' };
    const status = c.settings.requireApproval ? 'pending' : 'active';
    c.members[user.id] = {
      userId: user.id, role: 'member', status, balance: 0,
      creditLimit: c.settings.defaultCreditLimit || 0, requestedAt: Date.now(), joinedAt: status === 'active' ? Date.now() : null,
    };
    this.changed(c.id);
    return { club: c, status };
  }

  decideMember(actor, clubId, userId, approve) {
    const c = this.club(clubId);
    this.requireManager(c, actor);
    const m = c.members[userId];
    if (!m || m.status !== 'pending') throw new Error('No pending request from that player');
    if (approve) { m.status = 'active'; m.joinedAt = Date.now(); }
    else delete c.members[userId];
    this.changed(clubId);
  }

  removeMember(actor, clubId, userId) {
    const c = this.club(clubId);
    this.requireManager(c, actor);
    const m = c.members[userId];
    if (!m) throw new Error('Not a member');
    if (m.role === 'owner') throw new Error('The owner cannot be removed');
    if (m.balance !== 0) throw new Error('Settle the member’s balance to zero before removing them');
    if ((this.chipsOnTables().get(clubId)?.get(userId) || 0) > 0) throw new Error('That member is seated at a club table');
    delete c.members[userId];
    this.changed(clubId);
  }

  setRole(actor, clubId, userId, role) {
    const c = this.club(clubId);
    if (c.ownerId !== actor.id) throw new Error('Only the owner can change roles');
    if (!ROLES.includes(role) || role === 'owner') throw new Error('Role must be manager or member');
    const m = this.activeMember(c, userId);
    if (!m || m.role === 'owner') throw new Error('Not an active member');
    m.role = role;
    this.changed(clubId);
  }

  // Core ledger write. amount is signed: positive adds to the member's balance.
  tx(c, { type, userId, amount, by = null, note = '', table = null }) {
    const m = c.members[userId];
    m.balance += amount;
    const t = {
      id: randomId(6), at: Date.now(), type, userId, amount, balanceAfter: m.balance,
      byId: by ? by.id : null, note: cleanNote(note), tableId: table?.id || null, tableName: table?.name || null,
    };
    c.transactions.push(t);
    return t;
  }

  adjustChips(actor, clubId, userId, amount, note) {
    const c = this.club(clubId);
    this.requireManager(c, actor);
    amount = toInt(amount, 'Amount');
    if (amount === 0) throw new Error('Amount cannot be zero');
    if (!this.activeMember(c, userId)) throw new Error('Not an active member');
    const t = this.tx(c, { type: amount > 0 ? 'chips_add' : 'chips_remove', userId, amount, by: actor, note });
    this.changed(clubId);
    return t;
  }

  setCreditLimit(actor, clubId, userId, limit) {
    const c = this.club(clubId);
    this.requireManager(c, actor);
    limit = toInt(limit, 'Credit limit');
    if (limit < 0) throw new Error('Credit limit cannot be negative');
    const m = this.activeMember(c, userId);
    if (!m) throw new Error('Not an active member');
    const before = m.creditLimit;
    m.creditLimit = limit;
    this.tx(c, { type: 'credit_limit', userId, amount: 0, by: actor, note: `Credit limit ${before} -> ${limit}` });
    this.changed(clubId);
  }

  settle(actor, clubId, userId, note) {
    const c = this.club(clubId);
    this.requireManager(c, actor);
    const m = this.activeMember(c, userId);
    if (!m) throw new Error('Not an active member');
    if (m.balance === 0) throw new Error('Balance is already zero');
    const t = this.tx(c, { type: 'settlement', userId, amount: -m.balance, by: actor, note: note || (m.balance < 0 ? 'Debt settled' : 'Paid out') });
    this.changed(clubId);
    return t;
  }

  transfer(actor, clubId, toUserId, amount, note) {
    const c = this.club(clubId);
    if (!c.settings.allowTransfers) throw new Error('Transfers between members are turned off in this club');
    const from = this.activeMember(c, actor.id);
    const to = this.activeMember(c, toUserId);
    if (!from || !to) throw new Error('Both players must be active members');
    if (actor.id === toUserId) throw new Error('Pick another member');
    amount = toInt(amount, 'Amount');
    if (amount <= 0) throw new Error('Amount must be positive');
    if (from.balance < amount) throw new Error('You can only transfer chips you have (credit cannot be transferred)');
    this.tx(c, { type: 'transfer_out', userId: actor.id, amount: -amount, by: actor, note: `To ${this.nameOf(toUserId)}${note ? ': ' + cleanNote(note) : ''}` });
    this.tx(c, { type: 'transfer_in', userId: toUserId, amount, by: actor, note: `From ${this.nameOf(actor.id)}${note ? ': ' + cleanNote(note) : ''}` });
    this.changed(clubId);
  }

  updateSettings(actor, clubId, input) {
    const c = this.club(clubId);
    this.requireManager(c, actor);
    if (input.name !== undefined) c.name = cleanClubName(input.name);
    if (input.announcement !== undefined) c.announcement = cleanNote(input.announcement);
    const s = c.settings;
    for (const k of ['membersSeeLedger', 'allowTransfers', 'requireApproval']) if (input[k] !== undefined) s[k] = !!input[k];
    if (input.defaultCreditLimit !== undefined) {
      const v = toInt(input.defaultCreditLimit, 'Default credit limit');
      if (v < 0) throw new Error('Default credit limit cannot be negative');
      s.defaultCreditLimit = v;
    }
    if (input.decimals !== undefined) {
      const used = c.transactions.some((t) => t.amount !== 0);
      const d = Number(input.decimals) === 2 ? 2 : 0;
      if (d !== s.decimals && used) throw new Error('Chip display cannot change after chips have moved');
      s.decimals = d;
    }
    this.changed(clubId);
  }

  regenerateInvite(actor, clubId) {
    const c = this.club(clubId);
    this.requireManager(c, actor);
    c.inviteCode = inviteCode();
    this.changed(clubId);
    return c.inviteCode;
  }

  // ----- hooks used by club tables -----
  available(clubId, userId) {
    const c = this.club(clubId);
    const m = this.activeMember(c, userId);
    if (!m) return 0;
    return m.balance + m.creditLimit;
  }

  buyIn(clubId, userId, amount, table) {
    const c = this.club(clubId);
    const m = this.activeMember(c, userId);
    if (!m) throw new Error('Only active club members can play at club tables');
    const avail = m.balance + m.creditLimit;
    if (amount > avail) throw new Error(`Not enough club chips: you have ${Math.max(0, avail)} available (balance plus credit)`);
    this.tx(c, { type: 'buyin', userId, amount: -amount, table });
    this.changed(clubId);
  }

  cashOut(clubId, userId, amount, table) {
    const c = this.data[clubId];
    if (!c || !c.members[userId]) return;
    this.tx(c, { type: 'cashout', userId, amount, table });
    this.changed(clubId);
  }

  // ----- views -----
  memberStats(c) {
    const stats = {};
    for (const t of c.transactions) {
      const s = (stats[t.userId] ||= { buyIns: 0, cashOuts: 0 });
      if (t.type === 'buyin') s.buyIns += -t.amount;
      if (t.type === 'cashout') s.cashOuts += t.amount;
    }
    return stats;
  }

  view(clubId, viewer) {
    const c = this.club(clubId);
    const me = c.members[viewer.id];
    if (!me || me.status !== 'active') {
      return { id: c.id, name: c.name, myStatus: me ? me.status : null };
    }
    const manager = me.role === 'owner' || me.role === 'manager';
    const seeAll = manager || c.settings.membersSeeLedger;
    const onTables = this.chipsOnTables().get(c.id) || new Map();
    const stats = this.memberStats(c);
    const members = Object.values(c.members)
      .filter((m) => m.status === 'active')
      .map((m) => {
        const base = { userId: m.userId, name: this.nameOf(m.userId), role: m.role, joinedAt: m.joinedAt };
        if (!seeAll && m.userId !== viewer.id) return base;
        const st = stats[m.userId] || { buyIns: 0, cashOuts: 0 };
        const live = onTables.get(m.userId) || 0;
        return {
          ...base, balance: m.balance, creditLimit: m.creditLimit, available: m.balance + m.creditLimit,
          onTables: live, buyIns: st.buyIns, cashOuts: st.cashOuts, net: st.cashOuts + live - st.buyIns,
        };
      })
      .sort((a, b) => (ROLES.indexOf(a.role) - ROLES.indexOf(b.role)) || a.name.localeCompare(b.name));
    const txs = (seeAll ? c.transactions : c.transactions.filter((t) => t.userId === viewer.id))
      .slice(-500)
      .reverse()
      .map((t) => ({ ...t, name: this.nameOf(t.userId), byName: t.byId ? this.nameOf(t.byId) : null }));
    const out = {
      id: c.id, name: c.name, ownerId: c.ownerId, createdAt: c.createdAt, announcement: c.announcement,
      settings: { ...c.settings }, myRole: me.role, myStatus: 'active', isManager: manager, seeAll,
      me: members.find((m) => m.userId === viewer.id), members, transactions: txs,
    };
    if (seeAll) {
      const active = Object.values(c.members).filter((m) => m.status === 'active');
      out.totals = {
        balances: active.reduce((s, m) => s + m.balance, 0),
        owed: active.reduce((s, m) => s + Math.min(0, m.balance), 0),
        held: active.reduce((s, m) => s + Math.max(0, m.balance), 0),
        onTables: [...onTables.values()].reduce((s, v) => s + v, 0),
      };
    }
    if (manager) {
      out.inviteCode = c.inviteCode;
      out.pending = Object.values(c.members).filter((m) => m.status === 'pending').map((m) => ({ userId: m.userId, name: this.nameOf(m.userId), requestedAt: m.requestedAt }));
    }
    return out;
  }

  transactionsCsv(clubId, viewer) {
    const v = this.view(clubId, viewer);
    if (!v.transactions) throw new Error('Not a member');
    const d = v.settings.decimals;
    const amt = (x) => (d ? (x / 100).toFixed(2) : String(x));
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = [['time', 'member', 'type', 'amount', 'balance_after', 'by', 'table', 'note']];
    for (const t of v.transactions.slice().reverse()) {
      rows.push([new Date(t.at).toISOString(), t.name, t.type, amt(t.amount), amt(t.balanceAfter), t.byName || '', t.tableName || '', t.note || '']);
    }
    return rows.map((r) => r.map(esc).join(',')).join('\n');
  }
}
