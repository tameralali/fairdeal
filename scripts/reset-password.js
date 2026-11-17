// Reset a user's password. Stop the server first, or it may overwrite the change.
// Usage: node scripts/reset-password.js <username> <new password>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scryptSync, randomBytes } from 'node:crypto';
import { Store } from '../server/store.js';

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 6) {
  console.error('Usage: node scripts/reset-password.js <username> <new password, at least 6 characters>');
  process.exit(1);
}
const dir = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const store = new Store(dir);
const id = store.data.usernames[username.toLowerCase()];
const user = id && store.data.users[id];
if (!user) {
  console.error(`No account with the username "${username}"`);
  process.exit(1);
}
user.salt = randomBytes(16).toString('hex');
user.hash = scryptSync(password, user.salt, 64).toString('hex');
for (const [key, session] of Object.entries(store.data.sessions)) {
  if (session.userId === id) delete store.data.sessions[key];
}
store.flush();
console.log(`Password updated for ${user.username}. Their other sessions were signed out.`);
