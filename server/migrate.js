// Moving the app to a new server, for example a new Render address.
//
// The old server runs with MIGRATION_EXPORT=on and a MIGRATION_KEY. It hands a copy of its whole data
// folder to a caller that presents the key, and from that moment sends every visitor on to the new
// address, so nothing is written to the old copy after it was taken.
// The new server runs with IMPORT_FROM=<old server URL> and the same MIGRATION_KEY. On its first boot,
// while its data folder is still empty, it shows a short "moving in" page, pulls the copy, writes it to
// disk and then starts normally. Once its data folder has a db.json it never imports again.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const FORMAT = 'aquarium-data-v1';
const SAFE_NAME = /^(db\.json|(hands|logs)\/[A-Za-z0-9_-]+\.jsonl)$/;

export function exportKeyFromEnv(env = process.env) {
  const key = env.MIGRATION_KEY || '';
  return env.MIGRATION_EXPORT === 'on' && key.length >= 24 ? key : null;
}

export function keyMatches(given, key) {
  if (!given || !key) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(key)).digest();
  return crypto.timingSafeEqual(a, b);
}

function withoutMove(dbText) {
  const db = JSON.parse(dbText);
  if (db.meta) delete db.meta.movedTo;
  return JSON.stringify(db);
}

// Everything in the data folder: db.json plus every table's hands and log files.
export function readDataDir(dataDir) {
  const files = {};
  const db = path.join(dataDir, 'db.json');
  if (fs.existsSync(db)) files['db.json'] = withoutMove(fs.readFileSync(db, 'utf8'));
  for (const sub of ['hands', 'logs']) {
    const dir = path.join(dataDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const name = `${sub}/${f}`;
      if (SAFE_NAME.test(name)) files[name] = fs.readFileSync(path.join(dir, f), 'utf8');
    }
  }
  return { format: FORMAT, exportedAt: Date.now(), files };
}

// Writes an export into an empty data folder. db.json goes last, so a folder with a db.json is complete.
export function writeDataDir(dataDir, payload) {
  if (!payload || payload.format !== FORMAT || !payload.files || typeof payload.files !== 'object') throw new Error('That is not an Aquarium data export');
  const names = Object.keys(payload.files);
  if (!names.includes('db.json')) throw new Error('The export has no db.json');
  for (const n of names) {
    if (!SAFE_NAME.test(n)) throw new Error(`Unexpected file in the export: ${n}`);
    if (typeof payload.files[n] !== 'string') throw new Error(`Bad contents for ${n}`);
  }
  const db = withoutMove(payload.files['db.json']);
  for (const sub of ['hands', 'logs']) fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  for (const n of names) if (n !== 'db.json') fs.writeFileSync(path.join(dataDir, n), payload.files[n]);
  const tmp = path.join(dataDir, 'db.json.tmp');
  fs.writeFileSync(tmp, db);
  fs.renameSync(tmp, path.join(dataDir, 'db.json'));
  return names.length;
}

const holdingPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5"><title>The Aquarium</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#191512;color:#ece5d8;font:18px/1.5 system-ui,sans-serif;text-align:center;padding:24px}p{color:#a89a88}</style>
</head><body><div><h1>The Aquarium is moving in</h1><p>Your games and balances are on their way to this address. This page reloads by itself.</p></div></body></html>`;

// On the new server: pull the old server's data into an empty data folder before the app starts.
// holdPort: answer on that port while importing (health checks pass, visitors see the holding page).
export async function importIfNeeded({ dataDir, from, key, self = '', holdPort = null, retryMs = 10000, log = console.log }) {
  if (!from) return { skipped: 'no IMPORT_FROM' };
  if (fs.existsSync(path.join(dataDir, 'db.json'))) {
    log('Import skipped: this server already has its data.');
    return { skipped: 'already has data' };
  }
  if (!key) throw new Error('IMPORT_FROM is set but MIGRATION_KEY is missing');
  fs.mkdirSync(dataDir, { recursive: true });
  let holding = null;
  if (holdPort !== null && holdPort !== undefined) {
    holding = http.createServer((req, res) => {
      if (req.url.startsWith('/healthz')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"moving":true}'); return; }
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5' });
      res.end(holdingPage);
    });
    await new Promise((resolve) => holding.listen(holdPort, resolve));
  }
  const url = from.replace(/\/+$/, '') + '/api/admin/export';
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-migration-key': key },
        body: JSON.stringify({ url: self }),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 200)}`);
      const count = writeDataDir(dataDir, JSON.parse(text));
      log(`Imported ${count} files from ${from}.`);
      if (holding) {
        holding.closeAllConnections?.();
        await new Promise((resolve) => holding.close(resolve));
      }
      return { imported: count };
    } catch (e) {
      log(`Import attempt ${attempt} from ${from} failed: ${e.message}. Trying again in ${Math.round(retryMs / 1000)}s.`);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}
