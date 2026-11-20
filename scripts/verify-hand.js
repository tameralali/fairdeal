// Check hands on your own computer, without anything from the site that dealt them.
//
// At the table: Hands, pick a hand, Details, Download this hand. Then, in a copy of this code
// (on GitHub: Code, then Download ZIP; nothing to install apart from Node.js 20 or newer), run:
//
//   node scripts/verify-hand.js hand-<table>-<number>.json
//   node scripts/verify-hand.js hand-<table>-<number>.json --seal <fingerprint copied before the deal>
//
// It runs the same checks as the browser does, with the code in shared/fairness.js and Node's
// built-in cryptography. Several files at once work too. It exits with 1 if any hand fails.
import { readFileSync } from 'node:fs';
import { verifyHandRecord, webCryptoAdapter } from '../shared/fairness.js';

const USAGE = 'Usage: node scripts/verify-hand.js <hand file> [more hand files] [--seal <fingerprint copied at the table before the deal>]';

const argv = process.argv.slice(2);
const files = [];
let seal = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--seal') seal = String(argv[++i] || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  else if (argv[i] === '-h' || argv[i] === '--help') { console.log(USAGE); process.exit(0); }
  else files.push(argv[i]);
}
if (!files.length) { console.error(USAGE); process.exit(2); }
if (seal !== null && seal.length !== 64) {
  console.error('The seal is the 64-character fingerprint you get from Copy fingerprint in the seal at the top of the table.');
  process.exit(2);
}

const records = [];
for (const file of files) {
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error(`Could not read ${file}: ${e.message}`); process.exit(2); }
  const found = [].concat(data && data.record ? data.record : data).filter((r) => r && r.fairness && r.dealt);
  if (!found.length) { console.error(`${file} has no hands in it. Use the file from Download this hand.`); process.exit(2); }
  records.push(...found);
}
if (seal && records.length > 1) { console.error('--seal is for one hand at a time: give it a single hand file.'); process.exit(2); }

const wc = webCryptoAdapter();
const mark = (ok) => (ok ? '✓' : '✗');
let passed = 0;
let failed = 0;
let closed = 0;
for (const rec of records) {
  const res = await verifyHandRecord(rec, wc, seal ? { commitment: seal } : {});
  const when = rec.startedAt ? new Date(rec.startedAt).toLocaleString() : '';
  console.log(`\nHand #${rec.handNumber}${rec.tableName ? ` at ${rec.tableName}` : ''}${when ? `, ${when}` : ''}`);
  console.log(`  Seal published before the deal: ${rec.fairness.commitment}`);
  if (res.pending) {
    closed++;
    console.log(`  Not opened yet: ${res.checks[0].detail || res.checks[0].label}`);
    continue;
  }
  for (const c of res.checks) console.log(`  ${mark(c.ok)} ${c.label.replace('the one your browser saw before the deal', 'the fingerprint you copied before the deal')}`);
  if (res.deal) {
    const name = (seat) => ((rec.players || []).find((p) => p.seat === Number(seat)) || {}).name || `Seat ${Number(seat) + 1}`;
    console.log('  Rebuilt deal:');
    for (const [seat, cards] of Object.entries(res.deal.holes)) console.log(`    ${name(seat)}: ${cards.map((c) => c || '??').join(' ')}`);
    res.deal.boards.forEach((b, i) => console.log(`    ${res.deal.boards.length > 1 ? `Board ${i + 1}` : 'Board'}: ${b.map((c) => c || '??').join(' ') || 'none'}`));
    if (res.hidden) console.log(`    ?? is a folded card that stays sealed (${res.hidden} in this hand). Its seal is still part of the check.`);
  }
  if (res.ok) passed++; else failed++;
  console.log(`  ${res.ok ? 'Passed every check' : 'FAILED: see the checks marked ✗'}`);
}

const total = passed + failed;
const tail = closed ? ` ${closed} hand${closed === 1 ? ' is' : 's are'} not opened yet.` : '';
if (failed) console.log(`\n${total === 1 ? 'The hand' : `${failed} of ${total} hands`} failed a check.${tail}`);
else if (total) console.log(`\n${total === 1 ? 'The hand' : `All ${total} hands`} passed every check.${tail}`);
else console.log(`\nNothing to check yet.${tail}`);
if (total && !seal) console.log('Compare each seal above with the one you saw at the table, or pass it with --seal to have it checked.');
process.exit(failed ? 1 : 0);
