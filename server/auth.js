// Accounts. Every browser gets a guest identity with a display name (like PokerNow games);
// it can be upgraded to a username + password account to log in from other devices.
// Clubs require a registered account so balances are never tied to a single browser.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { randomId, randomToken, sha256Hex } from './fair-node.js';

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,20}$/;

export function cleanName(name) {
  const n = String(name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (n.length < 1 || n.length > 24) throw new Error('Name must be 1 to 24 characters');
  return n;
}

export class Auth {
  constructor(store) {
    this.store = store;
    this.attempts = new Map();
  }

  get users() { return this.store.data.users; }

  publicUser(u) {
    return u ? { id: u.id, name: u.name, username: u.username || null, guest: !u.username } : null;
  }

  issueToken(user) {
    const token = randomToken();
    this.store.data.sessions[sha256Hex(token)] = { userId: user.id, createdAt: Date.now() };
    this.store.save();
    return token;
  }

  userForToken(token) {
    if (!token || typeof token !== 'string') return null;
    const s = this.store.data.sessions[sha256Hex(token)];
    return s ? this.users[s.userId] || null : null;
  }

  createGuest(name) {
    const user = { id: randomId(), name: cleanName(name), createdAt: Date.now() };
    this.users[user.id] = user;
    this.store.save();
    return { user, token: this.issueToken(user) };
  }

  register(current, { username, password, name }) {
    if (!USERNAME_RE.test(username || '')) throw new Error('Username must be 3 to 20 letters, numbers, dots, dashes or underscores');
    if (typeof password !== 'string' || password.length < 6) throw new Error('Password must be at least 6 characters');
    const key = username.toLowerCase();
    if (this.store.data.usernames[key]) throw new Error('That username is taken');
    let user = current && !current.username ? current : null;
    if (!user) {
      user = { id: randomId(), name: cleanName(name || username), createdAt: Date.now() };
      this.users[user.id] = user;
    } else if (name) {
      user.name = cleanName(name);
    }
    const salt = randomBytes(16).toString('hex');
    user.username = username;
    user.salt = salt;
    user.hash = scryptSync(password, salt, 64).toString('hex');
    this.store.data.usernames[key] = user.id;
    this.store.save();
    return { user, token: this.issueToken(user) };
  }

  login({ username, password }, ip = '') {
    const k = ip + '|' + String(username).toLowerCase();
    const a = this.attempts.get(k) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 10 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 10) throw new Error('Too many attempts, try again in a few minutes');
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
      throw new Error('Wrong username or password');
    }
    this.attempts.delete(k);
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
}
