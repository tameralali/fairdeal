// Small JSON-file persistence layer. db.json holds users, sessions, clubs and table snapshots;
// hand records and table logs are append-only JSON-lines files so they never need rewriting.
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.handsDir = path.join(dir, 'hands');
    this.logsDir = path.join(dir, 'logs');
    fs.mkdirSync(this.handsDir, { recursive: true });
    fs.mkdirSync(this.logsDir, { recursive: true });
    this.file = path.join(dir, 'db.json');
    this.data = { users: {}, usernames: {}, sessions: {}, clubs: {}, tables: {}, meta: { createdAt: Date.now() } };
    if (fs.existsSync(this.file)) {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...loaded };
    }
    this.timer = null;
    this.logBuffers = new Map();
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 250);
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
    for (const [tableId, lines] of this.logBuffers) {
      if (lines.length) fs.appendFileSync(path.join(this.logsDir, tableId + '.jsonl'), lines.join('\n') + '\n');
    }
    this.logBuffers.clear();
  }

  appendHand(tableId, record) {
    fs.appendFileSync(path.join(this.handsDir, tableId + '.jsonl'), JSON.stringify(record) + '\n');
  }

  readHands(tableId) {
    const f = path.join(this.handsDir, tableId + '.jsonl');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  appendLog(tableId, entry) {
    if (!this.logBuffers.has(tableId)) this.logBuffers.set(tableId, []);
    this.logBuffers.get(tableId).push(JSON.stringify(entry));
    this.save();
  }

  readLog(tableId) {
    const f = path.join(this.logsDir, tableId + '.jsonl');
    const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
    const buffered = this.logBuffers.get(tableId) || [];
    return lines.concat(buffered).map((l) => JSON.parse(l));
  }
}
