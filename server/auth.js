// Accounts on an invite-only site. Nobody gets in without an account, and an account can only be
// created from an invite link that an admin sent to one email address, or from the one-time owner
// setup link the server prints in its log until the site has an owner.
//
// Roles: the owner (one person) makes and removes admins and can turn anyone's access off. Admins
// invite people and send password reset links to members. Everyone else is a member.
// Invite and reset links work once and expire. Only a hash of each link's token is stored.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { randomId, randomToken, sha256Hex } from './fair-node.js';

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,20}$/;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const DAY = 86400000;
export const INVITE_DAYS = [1, 3, 7, 14, 30];

export function cleanName(name) {
  const n = String(name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (n.length < 1 || n.length > 24) throw new Error('Name must be 1 to 24 characters');
  return n;
}

export function cleanEmail(email) {
  const e = String(email ?? '').trim().toLowerCase();
  if (e.length > 120 || !EMAIL_RE.test(e)) throw new Error('Enter a valid email address');
  return e;
}

const fail = (m, status = 400) => { const e = new Error(m); e.status = status; throw e; };

export class Auth {
  constructor(store) {
    this.store = store;
    this.attempts = new Map();
    store.data.invites ||= {};
    store.data.emails ||= {};
    for (const u of Object.values(this.users)) if (u.email) store.data.emails[u.email] = u.id;
  }

  get users() { return this.store.data.users; }
  get invites() { return this.store.data.invites; }

  roleOf(u) { return u?.role === 'owner' || u?.role === 'admin' ? u.role : 'member'; }
  isOwner(u) { return !!u && this.roleOf(u) === 'owner'; }
  isAdmin(u) { return !!u && this.roleOf(u) !== 'member'; }
  owner() { return Object.values(this.users).find((u) => u.role === 'owner' && !u.disabled) || null; }

  publicUser(u) {
    return u ? { id: u.id, name: u.name, username: u.username || null, email: u.email || null, role: this.roleOf(u) } : null;
  }

  issueToken(user) {
    const token = randomToken();
    this.store.data.sessions[sha256Hex(token)] = { userId: user.id, createdAt: Date.now() };
    this.store.save();
    return token;
  }

  // Only real accounts that are switched on. Name-only guests from before the site was invite-only
  // no longer get in.
  userForToken(token) {
    if (!token || typeof token !== 'string') return null;
    const s = this.store.data.sessions[sha256Hex(token)];
    const u = s && this.users[s.userId];
    if (!u || !u.username || u.disabled) return null;
    if (!u.lastSeenAt || Date.now() - u.lastSeenAt > 60000) { u.lastSeenAt = Date.now(); this.store.save(); }
    return u;
  }

  endSessions(userId, keep = null) {
    for (const [h, s] of Object.entries(this.store.data.sessions)) if (s.userId === userId && h !== keep) delete this.store.data.sessions[h];
  }

  checkUsername(username) {
    if (!USERNAME_RE.test(username || '')) fail('Username must be 3 to 20 letters, numbers, dots, dashes or underscores');
    if (this.store.data.usernames[username.toLowerCase()]) fail('That username is taken');
  }

  checkPassword(password) {
    if (typeof password !== 'string' || password.length < 8) fail('Password must be at least 8 characters');
    if (password.length > 200) fail('That password is too long');
  }

  setPassword(user, password) {
    this.checkPassword(password);
    user.salt = randomBytes(16).toString('hex');
    user.hash = scryptSync(password, user.salt, 64).toString('hex');
  }

  login({ username, password }, ip = '') {
    const k = ip + '|' + String(username).toLowerCase();
    const a = this.attempts.get(k) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 10 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 10) fail('Too many attempts, try again in a few minutes', 429);
    const id = this.store.data.usernames[String(username || '').toLowerCase()];
    const user = id && this.users[id];
    let ok = false;
    if (user && user.hash) {
      const h = scryptSync(String(password || ''), user.salt, 64);
      ok = timingSafeEqual(h, Buffer.from(user.hash, 'hex'));
    }
    if (!ok) {
      a.n++;
      this.attempts.set(k, a);
      fail('Wrong username or password', 401);
    }
    this.attempts.delete(k);
    if (user.disabled) fail('This account has been turned off. Ask the owner of The Aquarium.', 403);
    return { user, token: this.issueToken(user) };
  }

  logout(token) {
    delete this.store.data.sessions[sha256Hex(token)];
    this.store.save();
  }

  rename(user, name) {
    user.name = cleanName(name);
    this.store.save();
    return user;
  }

  // ---------- invites and links ----------
  status(inv) {
    if (inv.revokedAt) return 'revoked';
    if (inv.usedAt) return 'used';
    if (Date.now() > inv.expiresAt) return 'expired';
    return 'pending';
  }

  newLink(fields, days) {
    const token = randomToken();
    const now = Date.now();
    const inv = { id: randomId(8), tokenHash: sha256Hex(token), createdAt: now, expiresAt: now + days * DAY, ...fields };
    this.invites[inv.id] = inv;
    this.store.save();
    return { invite: inv, token };
  }

  linkForToken(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const h = sha256Hex(token);
    return Object.values(this.invites).find((i) => i.tokenHash === h) || null;
  }

  usableLink(token) {
    const inv = this.linkForToken(token);
    if (!inv || this.status(inv) !== 'pending') fail('This link has expired or was already used. Ask an admin for a new one.', 410);
    return inv;
  }

  requireAdmin(user) { if (!this.isAdmin(user)) fail('Only admins can do that', 403); }
  requireOwner(user) { if (!this.isOwner(user)) fail('Only the owner can do that', 403); }

  inviteDays(days) {
    const d = Number(days || 7);
    return INVITE_DAYS.includes(d) ? d : 7;
  }

  createInvite(admin, { email, name, clubId = null, days }) {
    this.requireAdmin(admin);
    email = cleanEmail(email);
    if (this.store.data.emails[email]) fail('Someone already has an account with that email');
    const nm = name ? cleanName(name) : null;
    for (const i of Object.values(this.invites)) {
      if (i.kind === 'join' && i.email === email && this.status(i) === 'pending') i.revokedAt = Date.now();
    }
    return this.newLink({ kind: 'join', email, name: nm, clubId: clubId || null, createdBy: admin.id }, this.inviteDays(days));
  }

  // A fresh link for an invite that was not used yet (the old link stops working).
  renewInvite(admin, id, days) {
    this.requireAdmin(admin);
    const inv = this.invites[id];
    if (!inv || inv.kind !== 'join') fail('Invite not found', 404);
    if (inv.usedAt) fail('That invite was already used');
    if (this.store.data.emails[inv.email]) fail('Someone already has an account with that email');
    const token = randomToken();
    inv.tokenHash = sha256Hex(token);
    inv.revokedAt = null;
    inv.expiresAt = Date.now() + this.inviteDays(days) * DAY;
    inv.renewedAt = Date.now();
    this.store.save();
    return { invite: inv, token };
  }

  revokeInvite(admin, id) {
    this.requireAdmin(admin);
    const inv = this.invites[id];
    if (!inv) fail('Invite not found', 404);
    if (this.status(inv) === 'pending') { inv.revokedAt = Date.now(); this.store.save(); }
    return inv;
  }

  createReset(actor, userId) {
    this.requireAdmin(actor);
    const target = this.users[userId];
    if (!target || !target.username) fail('No such account', 404);
    if (this.isAdmin(target) && !this.isOwner(actor) && target.id !== actor.id) fail('Only the owner can reset an admin’s password', 403);
    if (target.disabled) fail('Turn this account back on first');
    for (const i of Object.values(this.invites)) {
      if (i.kind === 'reset' && i.userId === target.id && this.status(i) === 'pending') i.revokedAt = Date.now();
    }
    return this.newLink({ kind: 'reset', userId: target.id, email: target.email || null, createdBy: actor.id }, 3);
  }

  // While the site has no owner, a new setup link is made at each start and printed in the log.
  ownerSetupLink() {
    if (this.owner()) return null;
    for (const i of Object.values(this.invites)) if (i.kind === 'owner' && this.status(i) === 'pending') i.revokedAt = Date.now();
    return this.newLink({ kind: 'owner', createdBy: null }, 30).token;
  }

  linkInfo(token) {
    const inv = this.usableLink(token);
    const by = inv.createdBy ? this.users[inv.createdBy] : null;
    const target = inv.userId ? this.users[inv.userId] : null;
    return {
      kind: inv.kind, email: inv.email || null, name: inv.name || target?.name || null,
      username: target?.username || null, invitedBy: by ? by.name : null, clubId: inv.clubId || null, expiresAt: inv.expiresAt,
    };
  }

  // Uses a link: a join invite creates an account for its email; the owner link creates the owner's
  // account or makes an existing account the owner; a reset link sets a new password.
  acceptLink(token, body = {}, ip = '') {
    const inv = this.usableLink(token);
    const now = Date.now();
    let user;
    if (inv.kind === 'reset') {
      user = this.users[inv.userId];
      if (!user || user.disabled) fail('This account is not available', 410);
      this.setPassword(user, body.password);
      this.endSessions(user.id);
    } else if (inv.kind === 'owner' && body.existing) {
      user = this.login(body.existing, ip).user;
    } else {
      const email = inv.kind === 'join' ? inv.email : cleanEmail(body.email);
      if (this.store.data.emails[email]) fail('Someone already has an account with that email');
      this.checkUsername(body.username);
      this.checkPassword(body.password);
      const name = cleanName(body.name || inv.name || body.username);
      user = { id: randomId(), name, username: body.username, email, createdAt: now, invitedBy: inv.createdBy || null };
      this.setPassword(user, body.password);
      this.users[user.id] = user;
      this.store.data.usernames[body.username.toLowerCase()] = user.id;
      this.store.data.emails[email] = user.id;
    }
    if (inv.kind === 'owner') {
      if (this.owner() && this.owner().id !== user.id) fail('This site already has an owner', 409);
      user.role = 'owner';
      user.disabled = false;
    }
    inv.usedAt = now;
    inv.usedBy = user.id;
    this.store.save();
    return { user, invite: inv, token: this.issueToken(user) };
  }

  // ---------- people ----------
  setRole(owner, userId, role) {
    this.requireOwner(owner);
    const u = this.users[userId];
    if (!u || !u.username) fail('No such account', 404);
    if (u.role === 'owner') fail('The owner stays the owner');
    if (role !== 'admin' && role !== 'member') fail('Role must be admin or member');
    if (role === 'admin') u.role = 'admin'; else delete u.role;
    this.store.save();
    return u;
  }

  setAccess(owner, userId, enabled) {
    this.requireOwner(owner);
    const u = this.users[userId];
    if (!u || !u.username) fail('No such account', 404);
    if (u.role === 'owner') fail('The owner’s access cannot be turned off');
    if (enabled) delete u.disabled;
    else { u.disabled = true; this.endSessions(u.id); }
    this.store.save();
    return u;
  }

  people(viewer, clubName = () => null) {
    this.requireAdmin(viewer);
    const nameOf = (id) => (id && this.users[id] ? this.users[id].name : null);
    const users = Object.values(this.users)
      .filter((u) => u.username)
      .map((u) => ({
        id: u.id, name: u.name, username: u.username, email: u.email || null, role: this.roleOf(u), disabled: !!u.disabled,
        createdAt: u.createdAt, lastSeenAt: u.lastSeenAt || null, invitedBy: nameOf(u.invitedBy),
      }))
      .sort((a, b) => ['owner', 'admin', 'member'].indexOf(a.role) - ['owner', 'admin', 'member'].indexOf(b.role) || a.name.localeCompare(b.name));
    const invites = Object.values(this.invites)
      .filter((i) => i.kind === 'join')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 200)
      .map((i) => ({
        id: i.id, email: i.email, name: i.name, status: this.status(i), createdAt: i.createdAt, expiresAt: i.expiresAt,
        createdBy: nameOf(i.createdBy), usedBy: nameOf(i.usedBy), usedAt: i.usedAt || null, club: i.clubId ? clubName(i.clubId) : null,
        sentAt: i.sentAt || null, sendError: i.sendError || null,
      }));
    return { users, invites };
  }
}
