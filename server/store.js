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
    this.backup = this.file + '.bak';
    this.data = { users: {}, usernames: {}, sessions: {}, clubs: {}, tables: {}, meta: { createdAt: Date.now() } };
    const loaded = this.load();
    if (loaded) this.data = { ...this.data, ...loaded };
    this.timer = null;
    this.backedUpAt = 0;
    this.logBuffers = new Map();
  }

  // db.json, or, if it cannot be read, the copy kept beside it (at most an hour older). The damaged
  // file is kept under another name so nothing is lost.
  load() {
    if (!fs.existsSync(this.file)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      console.error(`[store] ${this.file} could not be read (${e.message}); trying the backup`);
      const kept = `${this.file}.damaged-${Date.now()}`;
      fs.renameSync(this.file, kept);
      if (!fs.existsSync(this.backup)) throw new Error(`db.json could not be read and there is no backup (kept as ${kept})`);
      const data = JSON.parse(fs.readFileSync(this.backup, 'utf8'));
      console.error(`[store] started from ${this.backup}; the damaged file is ${kept}`);
      return data;
    }
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // a full disk or a passing error must not stop the server: the next change tries again
      try { this.flush(); } catch (e) { console.error('[store] could not save', e); this.save(); }
    }, 250);
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    // once an hour the last good copy is kept beside it, to start from if db.json is ever damaged
    if (Date.now() - this.backedUpAt > 3600000 && fs.existsSync(this.file)) {
      fs.copyFileSync(this.file, this.backup);
      this.backedUpAt = Date.now();
    }
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
    for (const [tableId, lines] of this.logBuffers) {
      if (lines.length) this.append(path.join(this.logsDir, tableId + '.jsonl'), lines.join('\n') + '\n');
      this.logBuffers.delete(tableId); // one by one, so a failure part way does not write any twice
    }
  }

  // One line of a JSON-lines file. A line cut short (the server stopped while writing it) is skipped
  // rather than failing the whole file.
  static parseLine(line, file) {
    try { return JSON.parse(line); }
    catch { console.error(`[store] skipped a damaged line in ${file}`); return null; }
  }

  // Adds lines to a JSON-lines file. The first time in a run, a last line left unfinished by a stop
  // mid-write is closed off first, so the new lines are not joined onto it.
  append(file, text) {
    this.checked ||= new Set();
    if (!this.checked.has(file)) {
      this.checked.add(file);
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const { size } = fs.fstatSync(fd);
          const last = Buffer.alloc(1);
          if (size > 0 && fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10) text = '\n' + text;
        } finally { fs.closeSync(fd); }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    fs.appendFileSync(file, text);
  }

  appendHand(tableId, record) {
    this.append(path.join(this.handsDir, tableId + '.jsonl'), JSON.stringify(record) + '\n');
  }

  // A later change to a stored hand (cards shown after it ended) is appended as a patch line.
  appendHandPatch(tableId, handNumber, patch) {
    this.append(path.join(this.handsDir, tableId + '.jsonl'), JSON.stringify({ patchOf: handNumber, ...patch }) + '\n');
  }

  // Deletes a table's hands and log for good.
  removeTableFiles(tableId) {
    for (const dir of [this.handsDir, this.logsDir]) {
      const f = path.join(dir, tableId + '.jsonl');
      fs.rmSync(f, { force: true });
      this.checked?.delete(f);
    }
    this.logBuffers.delete(tableId);
  }

  readHands(tableId) {
    const f = path.join(this.handsDir, tableId + '.jsonl');
    if (!fs.existsSync(f)) return [];
    const out = [];
    const byNumber = new Map();
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      const r = Store.parseLine(line, f);
      if (!r) continue;
      if (r.patchOf !== undefined) {
        const rec = byNumber.get(r.patchOf);
        for (const [userId, sh] of Object.entries(r.shows || {})) {
          const p = rec?.players.find((x) => x.userId === userId);
          if (p) { p.shown = sh.shown; p.showIdx = sh.showIdx; }
        }
        // a 7-2 bounty claimed by showing after the hand: who paid, and everyone's stacks after it
        if (r.bounty && rec) rec.bounty = r.bounty;
        for (const [userId, v] of Object.entries(r.nets || {})) {
          const p = rec?.players.find((x) => x.userId === userId);
          if (p) { p.endStack = v.endStack; p.net = v.net; }
        }
        continue;
      }
      out.push(r);
      byNumber.set(r.handNumber, r);
    }
    return out;
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
    return lines.concat(buffered).map((l) => Store.parseLine(l, f)).filter(Boolean);
  }
}
