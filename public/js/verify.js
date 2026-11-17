// Standalone verifier. Uses only /shared/fairness.js and the browser's WebCrypto.
import { verifyHandRecord, webCryptoAdapter } from '/shared/fairness.js';
import { GAME_TYPES } from '/shared/cards.js';
import { cardHTML, prefs, applyPrefs } from './cards.js';
import { sealSVG } from './seal.js';
import { esc, $, toast } from './ui.js';

const BRAND_HEX = '6f3ac1d0a85c2e94b7f1036d4e5a9c8b21f0e7d6c5b4a39281706f5e4d3c2b1a';
const wc = webCryptoAdapter();
const out = $('#out');
applyPrefs(document.body);
$('#brand').innerHTML = `${sealSVG(BRAND_HEX, 30, 'The Aquarium')}<span>The <b>Aquarium</b></span>`;

function token() { try { return localStorage.getItem('fd:token'); } catch { return null; } }
function observedFor(rec) {
  try {
    const d = JSON.parse(localStorage.getItem('fd:fair:' + rec.tableId) || '{}');
    const o = d.hands && d.hands[rec.handNumber];
    if (!o) return {};
    const obs = {};
    if (o.commitment) obs.commitment = o.commitment;
    if (o.seed) obs.mySeed = o.seed;
    if (o.myHole) { obs.myHole = o.myHole; obs.mySeat = o.mySeat; }
    if (o.boards) obs.boards = o.boards;
    return obs;
  } catch { return {}; }
}

async function getJSON(path) {
  const t = token();
  const r = await fetch(path, { headers: t ? { authorization: 'Bearer ' + t } : {} });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Could not load (${r.status})`);
  return j;
}

let results = [];

async function check(records) {
  records = [].concat(records).filter((r) => r && r.fairness && r.dealt);
  if (!records.length) { toast('No hand records found in that data', 'error'); return; }
  out.innerHTML = '<p class="muted">Checking…</p>';
  results = [];
  for (const rec of records) {
    const obs = observedFor(rec);
    const res = await verifyHandRecord(rec, wc, obs);
    const seedHash = rec.fairness.serverSeed ? await wc.sha256Hex(rec.fairness.serverSeed) : null;
    results.push({ rec, res, seedHash, obs });
  }
  if (results.length === 1) { out.innerHTML = detail(results[0]); return; }
  const ok = results.filter((x) => x.res.ok).length;
  const pending = results.filter((x) => x.res.pending).length;
  out.innerHTML = `<section class="panel"><div class="result-head"><h2>${ok} of ${results.length - pending} revealed hands passed</h2>${pending ? `<span class="muted">${pending} still sealed until the game ends</span>` : ''}</div>
    <table class="data"><thead><tr><th>Hand</th><th>Game</th><th>Checks</th><th>Result</th></tr></thead><tbody>
    ${results.map((x, i) => `<tr class="sum-row hand-row" data-i="${i}"><td class="num">#${x.rec.handNumber}</td><td>${esc(GAME_TYPES[x.rec.gameType]?.short || x.rec.gameType)}${x.rec.isBomb ? ' bomb pot' : ''}${x.rec.runCount > 1 ? `, ran ${x.rec.runCount}×` : ''}</td>
      <td class="muted">${x.res.checks.length}</td><td>${x.res.pending ? '<span class="vbadge wait">Sealed</span>' : x.res.ok ? '<span class="vbadge ok">&#10003; Passed</span>' : '<span class="vbadge bad">&#10007; Failed</span>'}</td></tr>`).join('')}
    </tbody></table><p class="hint">Click a hand to see its deck and every check.</p></section><div id="one"></div>`;
}

function detail({ rec, res, seedHash, obs }) {
  const f = rec.fairness;
  const usedCount = res.deal ? res.deal.cardsUsed : 0;
  const nameOf = (seat) => rec.players.find((p) => p.seat === Number(seat))?.name || `Seat ${Number(seat) + 1}`;
  return `<section class="panel">
    <div class="result-head">${res.pending ? sealSVG(f.commitment, 56) : sealSVG(seedHash, 56)}
      <div><h2>Hand #${rec.handNumber} ${res.pending ? 'is still sealed' : res.ok ? 'passed every check' : 'failed a check'}</h2>
      <span class="muted">${esc(rec.tableName || rec.tableId)}, ${esc(GAME_TYPES[rec.gameType]?.name || rec.gameType)}${rec.isBomb ? ', bomb pot' : ''}, ${new Date(rec.startedAt).toLocaleString()}</span></div></div>
    <div class="vgrid">
      <div>
        <h3 class="section-title">Checks</h3>
        <ul class="checks">${res.checks.map((c) => `<li class="${c.ok ? 'okc' : 'badc'}"><span class="i">${c.ok ? '&#10003;' : '&#10007;'}</span><span>${esc(c.label)}</span></li>`).join('')}</ul>
        ${obs.commitment ? '' : '<p class="hint">Open this page in the browser you played from to also check the seal you saw before the deal and your own cards.</p>'}
        <h3 class="section-title">Seals</h3>
        <div class="seal-pair">
          <figure>${sealSVG(obs.commitment || f.commitment, 72)}<figcaption>${obs.commitment ? 'Seen by your browser before the deal' : 'Published before the deal'}</figcaption></figure>
          <figure>${seedHash ? sealSVG(seedHash, 72) : sealSVG('', 72)}<figcaption>${seedHash ? 'SHA-256 of the revealed seed' : 'Not revealed yet'}</figcaption></figure>
        </div>
        <h3 class="section-title">Inputs</h3>
        <p class="hexline">Commitment: ${esc(f.commitment)}</p>
        <p class="hexline">Server seed: ${esc(f.serverSeed || 'not revealed yet')}</p>
        <p class="hexline">Player inputs: ${(f.contributions || []).map((c) => `${esc(c.name)}: ${esc(c.seed)}`).join('<br>') || 'none'}</p>
        <p class="hexline">Entropy string: ${esc(f.entropy)}</p>
      </div>
      <div>
        ${res.deal ? `<h3 class="section-title">Who got which card</h3>
          <table class="data"><tbody>${Object.entries(res.deal.holes).map(([seat, cards]) => `<tr><td>${esc(nameOf(seat))}</td><td><span class="mini-cards">${cards.map((c) => cardHTML(c)).join('')}</span></td></tr>`).join('')}
          ${res.deal.boards.map((b, i) => `<tr><td>${res.deal.boards.length > 1 ? `Board, run ${i + 1}` : 'Board'}</td><td><span class="mini-cards">${b.map((c) => cardHTML(c)).join('') || '<span class="faint">none</span>'}</span></td></tr>`).join('')}</tbody></table>
          <h3 class="section-title">Deck order after the shuffle</h3>
          <div class="deck">${res.deck.map((c, i) => `<figure class="${i < usedCount ? 'used' : ''}">${cardHTML(c)}<figcaption>${i + 1}</figcaption></figure>`).join('')}</div>
          <p class="hint">Outlined cards were dealt, in order from position 1: hole cards one at a time starting left of the button, then the board, then any extra runs.</p>` : ''}
      </div>
    </div>
  </section>`;
}

out.addEventListener('click', (e) => {
  const row = e.target.closest('[data-i]');
  if (!row) return;
  $('#one').innerHTML = detail(results[Number(row.dataset.i)]);
  $('#one').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('#fetch').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const table = f.table.value.trim();
  if (!f.hand.value) return toast('Enter a hand number, or use Check every hand', 'error');
  try { const j = await getJSON(`/api/tables/${encodeURIComponent(table)}/hands/${Number(f.hand.value)}`); await check(j.record); }
  catch (x) { toast(x.message, 'error'); }
});
document.querySelector('[data-all]').addEventListener('click', async () => {
  const table = $('#fetch').elements.table.value.trim();
  if (!table) return toast('Enter the table ID', 'error');
  try { await check(await getJSON(`/api/tables/${encodeURIComponent(table)}/hands.json`)); }
  catch (x) { toast(x.message, 'error'); }
});
const fromText = (text) => {
  try { check(JSON.parse(text)); } catch { toast('That is not valid JSON', 'error'); }
};
$('#checkPaste').addEventListener('click', () => fromText($('#paste').value));
$('#file').addEventListener('change', async (e) => { const file = e.target.files[0]; if (file) fromText(await file.text()); });
const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => { e.preventDefault(); drop.classList.remove('over'); const file = e.dataTransfer.files[0]; if (file) fromText(await file.text()); });

const q = new URLSearchParams(location.search);
if (q.get('table')) {
  $('#fetch').elements.table.value = q.get('table');
  if (q.get('hand')) {
    $('#fetch').elements.hand.value = q.get('hand');
    getJSON(`/api/tables/${encodeURIComponent(q.get('table'))}/hands/${Number(q.get('hand'))}`).then((j) => check(j.record)).catch((x) => toast(x.message, 'error'));
  }
}
void prefs;
