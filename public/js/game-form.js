// Game settings shared by "Start a game" and the host's Options at the table: the format (which games,
// in what order, for how long, on one board or two), bomb pots, and the pop-out that creates a table.
import { api, parseChips, toInput } from './api.js';
import { esc, dialog, toast } from './ui.js';
import { GAME_TYPES } from '/shared/cards.js';

export const MAX_STEPS = 8;
const LAST_KEY = 'aq:lastGame';

const step = (game, length = 'orbit', doubleBoard = false) => ({ game, length, doubleBoard });
export const PRESETS = [
  { id: 'mix-orbit', label: 'PLO and NLH, an orbit each', format: [step('plo4'), step('nlh')] },
  { id: 'mix-10', label: 'PLO and NLH, 10 hands each', format: [step('plo4', 10), step('nlh', 10)] },
  { id: 'nlh', label: 'NLH only', format: [step('nlh')] },
  { id: 'plo', label: 'PLO only', format: [step('plo4')] },
  { id: 'three', label: 'PLO, PLO5 and NLH', format: [step('plo4'), step('plo5'), step('nlh')] },
];
export const DEFAULT_FORMAT = PRESETS[0].format;

export const gameShort = (g) => GAME_TYPES[g]?.short || g;

// Same rule as the server: everyone's hole cards plus five cards per board must fit in one deck.
export function capacityFor(game, doubleBoard) {
  const g = GAME_TYPES[game];
  return Math.min(10, g.maxPlayers, Math.floor((52 - 5 * (doubleBoard ? 2 : 1)) / g.holeCount));
}

export function seatCap(format, bombPot) {
  const combos = format.map((x) => [x.game, x.doubleBoard]);
  if (bombPot && bombPot.mode !== 'off') {
    for (const x of format) combos.push([bombPot.game === 'current' ? x.game : bombPot.game, x.doubleBoard || bombPot.doubleBoard]);
  }
  let cap = 10;
  let why = '';
  for (const [g, db] of combos) {
    const c = capacityFor(g, db);
    if (c < cap) { cap = c; why = `${gameShort(g)}${db ? ' on two boards' : ''} can be dealt to ${c} players at most.`; }
  }
  return { cap, why };
}

const lenText = (len) => (len === 'orbit' ? 'one orbit' : `${len} hand${len === 1 ? '' : 's'}`);
export function stepLabel(s) { return `${gameShort(s.game)}${s.doubleBoard ? ' double board' : ''}`; }
export function formatSentence(format) {
  if (format.length === 1) return `Every hand is ${stepLabel(format[0])}.`;
  return `Plays ${format.map((s) => `${stepLabel(s)} for ${lenText(s.length)}`).join(', then ')}, then starts again from the top.`;
}
// Name of board i when a hand has `total` boards, `bpr` per run (1, or 2 for double board).
export function boardName(i, bpr, total) {
  const runs = Math.max(1, Math.round(total / bpr));
  const run = Math.floor(i / bpr);
  const side = i % bpr;
  if (runs > 1 && bpr > 1) return `Run ${run + 1}, board ${side + 1}`;
  if (runs > 1) return `Run ${run + 1}`;
  if (bpr > 1) return `Board ${side + 1}`;
  return '';
}

export function formatShort(format) {
  if (!format || !format.length) return '';
  const parts = format.map((s) => `${gameShort(s.game)}${s.doubleBoard ? ' DB' : ''}`);
  return parts.filter((p, i) => parts.indexOf(p) === i).join(' / ');
}

// ---------- segmented buttons ----------
export const seg = (name, options, value) => `<div class="seg" data-seg="${name}">${options.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(v) === String(value) ? 'on' : ''}">${l}</button>`).join('')}</div><input type="hidden" name="${name}" value="${esc(value)}">`;

export function bindSegs(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-seg] button');
    if (!b) return;
    const sg = b.closest('[data-seg]');
    sg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    const input = root.querySelector(`input[name="${sg.dataset.seg}"]`);
    if (input) { input.value = b.dataset.v; input.dispatchEvent(new Event('change', { bubbles: true })); }
  });
}

// ---------- format editor ----------
const gameOptions = (cur) => Object.values(GAME_TYPES).map((g) => `<option value="${g.id}" ${g.id === cur ? 'selected' : ''}>${esc(g.short)}: ${esc(g.name)}</option>`).join('');

function stepRow(s, i, n) {
  const orbit = s.length === 'orbit';
  return `<li class="fstep" data-step>
    <span class="fstep-n" aria-hidden="true">${i + 1}</span>
    <select data-f="game" aria-label="Game for step ${i + 1}">${gameOptions(s.game)}</select>
    <span class="fstep-for">for</span>
    <select data-f="len" aria-label="How long step ${i + 1} lasts"><option value="orbit" ${orbit ? 'selected' : ''}>one orbit</option><option value="hands" ${orbit ? '' : 'selected'}>a number of hands</option></select>
    <input data-f="hands" type="number" min="1" max="500" step="1" value="${orbit ? 10 : s.length}" aria-label="Hands in step ${i + 1}" class="${orbit ? 'hidden' : ''}">
    <label class="fstep-db"><input type="checkbox" data-f="db" ${s.doubleBoard ? 'checked' : ''}><span>Double board</span></label>
    <button type="button" class="btn tiny ghost" data-step-remove ${n === 1 ? 'disabled' : ''} aria-label="Remove step ${i + 1}">Remove</button>
  </li>`;
}

export function formatEditorHTML(format) {
  return `<div class="fmt" data-format>
    <div class="fmt-presets" role="group" aria-label="Quick formats">${PRESETS.map((p) => `<button type="button" class="fmt-chip" data-preset="${p.id}">${esc(p.label)}</button>`).join('')}</div>
    <ol class="fmt-steps" data-steps>${format.map((s, i) => stepRow(s, i, format.length)).join('')}</ol>
    <div class="fmt-foot"><button type="button" class="btn small" data-step-add>Add a game</button><p class="hint" data-format-sentence></p></div>
  </div>`;
}

export function readFormat(root) {
  return [...root.querySelectorAll('[data-step]')].map((li) => {
    const len = li.querySelector('[data-f=len]').value;
    const hands = Math.floor(Number(li.querySelector('[data-f=hands]').value));
    return {
      game: li.querySelector('[data-f=game]').value,
      length: len === 'orbit' ? 'orbit' : hands,
      doubleBoard: li.querySelector('[data-f=db]').checked,
    };
  });
}

export function bindFormatEditor(root, onChange = () => {}) {
  const wrap = root.querySelector('[data-format]');
  const list = wrap.querySelector('[data-steps]');
  const sentence = wrap.querySelector('[data-format-sentence]');
  const update = () => {
    const f = readFormat(root);
    const bad = f.find((s) => s.length !== 'orbit' && !(s.length >= 1 && s.length <= 500));
    sentence.textContent = bad ? 'Each step needs between 1 and 500 hands.' : formatSentence(f);
    wrap.querySelector('[data-step-add]').disabled = f.length >= MAX_STEPS;
    onChange(f);
  };
  const draw = (f) => { list.innerHTML = f.map((s, i) => stepRow(s, i, f.length)).join(''); update(); };
  wrap.addEventListener('click', (e) => {
    const p = e.target.closest('[data-preset]');
    if (p) return draw(structuredClone(PRESETS.find((x) => x.id === p.dataset.preset).format));
    if (e.target.closest('[data-step-add]')) {
      const f = readFormat(root);
      if (f.length >= MAX_STEPS) return;
      const used = new Set(f.map((s) => s.game));
      const game = ['nlh', 'plo4', 'plo5'].find((g) => !used.has(g)) || 'nlh';
      f.push({ game, length: f.at(-1)?.length ?? 'orbit', doubleBoard: false });
      draw(f);
      list.lastElementChild?.querySelector('select')?.focus();
      return;
    }
    const rm = e.target.closest('[data-step-remove]');
    if (rm) {
      const f = readFormat(root);
      const i = [...list.children].indexOf(rm.closest('[data-step]'));
      if (f.length > 1 && i >= 0) { f.splice(i, 1); draw(f); }
    }
  });
  wrap.addEventListener('change', (e) => {
    if (e.target.matches('[data-f=len]')) {
      const hands = e.target.closest('[data-step]').querySelector('[data-f=hands]');
      hands.classList.toggle('hidden', e.target.value === 'orbit');
      if (e.target.value !== 'orbit') hands.focus();
    }
    update();
  });
  wrap.addEventListener('input', update);
  update();
}

// ---------- bomb pots ----------
export function bombFieldsHTML(bp) {
  const opt = (v, l) => `<option value="${v}" ${v === bp.game ? 'selected' : ''}>${esc(l)}</option>`;
  return `<div class="stack" data-bomb>
    <div>${seg('bombMode', [['off', 'Off'], ['every', 'Every few hands'], ['percent', 'Random chance']], bp.mode)}</div>
    <div class="field-grid">
      <label data-bshow="every"><span class="lbl">Every this many hands</span><input name="bombEvery" type="number" min="2" max="1000" value="${bp.every}"></label>
      <label data-bshow="percent"><span class="lbl">Chance each hand (%)</span><input name="bombPercent" type="number" min="1" max="100" step="0.5" value="${bp.percent}"></label>
      <label><span class="lbl">Ante (big blinds)</span><input name="bombAnte" type="number" min="0.5" max="100" step="0.5" value="${bp.anteBB}"></label>
      <label><span class="lbl">Play bomb pots as</span><select name="bombGame">${opt('current', 'Current game')}${Object.values(GAME_TYPES).map((g) => opt(g.id, g.short)).join('')}</select></label>
    </div>
    <label class="check"><input type="checkbox" name="bombDouble" ${bp.doubleBoard ? 'checked' : ''}> Deal bomb pots on two boards<small>Double board: the pot is split between the two boards.</small></label>
  </div>`;
}

export function bindBombFields(root) {
  const show = () => {
    const m = root.querySelector('input[name=bombMode]').value;
    root.querySelectorAll('[data-bshow]').forEach((el) => el.classList.toggle('hidden', el.dataset.bshow !== m));
  };
  root.addEventListener('change', show);
  show();
}

export function readBomb(root) {
  const v = (n) => root.querySelector(`[name=${n}]`);
  return {
    mode: v('bombMode').value, every: Number(v('bombEvery').value), percent: Number(v('bombPercent').value),
    anteBB: Number(v('bombAnte').value), game: v('bombGame').value, doubleBoard: v('bombDouble').checked,
  };
}

export const ritText = 'When everyone is all in before the river, the players in the hand get 15 seconds to vote, before any cards are turned over. Any vote for once wins; otherwise the lowest vote is used. Only votes that come in count, and no votes means once.';

// Seats select limited to what the format can deal.
export function fitSeats(select, format, bombPot, hintEl) {
  const { cap, why } = seatCap(format, bombPot);
  const cur = Math.min(Number(select.value) || 8, cap);
  select.innerHTML = Array.from({ length: cap - 1 }, (_, i) => i + 2).map((n) => `<option ${n === cur ? 'selected' : ''}>${n}</option>`).join('');
  if (hintEl) hintEl.textContent = cap < 10 ? why : '';
}

// ---------- start a game ----------
function loadLast() { try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch { return null; } }
function saveLast(v) { try { localStorage.setItem(LAST_KEY, JSON.stringify(v)); } catch { /* storage blocked */ } }

// clubs: clubs the user manages [{ id, name, decimals }]; clubId: the club to start in by default.
export function startGameDialog({ user, clubs = [], clubId = null }) {
  const last = loadLast();
  const s = last?.settings || {};
  const targets = [...clubs.map((c) => ({ id: c.id, label: c.name, decimals: c.decimals, club: true })), { id: '', label: 'Private table', decimals: null, club: false }];
  let target = targets.find((t) => t.id === (clubId ?? last?.target)) || targets[0];
  let dec = target.club ? target.decimals : (s.decimals ?? 0);
  const sameDec = last && last.decimals === dec;
  const stake = (k, d) => (sameDec && s[k] !== undefined ? toInput(s[k], dec) : d);
  const format = Array.isArray(s.format) && s.format.length ? s.format : structuredClone(DEFAULT_FORMAT);
  const bp = { mode: 'off', every: 10, percent: 10, anteBB: 2, game: 'current', doubleBoard: false, ...(s.bombPot || {}) };
  const rit = s.rit || { enabled: true, maxRuns: 4 };
  const ritVal = rit.enabled ? rit.maxRuns : 1;
  const lengths = [[0, 'No limit'], [60, '1 hour'], [90, '1 hour 30'], [120, '2 hours'], [150, '2 hours 30'], [180, '3 hours'], [240, '4 hours'], [300, '5 hours'], [360, '6 hours']];
  const minutes = s.sessionMinutes || 0;
  if (!lengths.some(([m]) => m === minutes)) lengths.push([minutes, `${minutes} minutes`]);
  const opt = (v, l, cur) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`;

  const dlg = dialog({
    title: 'Start a game', className: 'wide start-game',
    body: `<form id="startform" class="sg" autocomplete="off" novalidate>
      <section class="sg-sec">
        <div class="sg-where">
          ${targets.length > 1 ? `<div><span class="lbl">Where</span>${seg('target', targets.map((t) => [t.id, esc(t.label)]), target.id)}</div>` : '<input type="hidden" name="target" value="">'}
          <label class="grow"><span class="lbl">Table name</span><input name="tname" type="text" maxlength="40" placeholder="${esc(target.club ? 'Main game' : `${user.name}'s game`)}" value="${esc(last?.name || '')}"></label>
        </div>
        <p class="hint" data-where-hint></p>
      </section>
      <section class="sg-sec">
        <h3>Format</h3>
        ${formatEditorHTML(format)}
      </section>
      <section class="sg-sec sg-cols">
        <div>
          <h3>Stakes and seats</h3>
          <div class="field-grid">
            <label data-dec-row><span class="lbl">Chip amounts</span><select name="decimals">${opt(0, 'Whole chips (5/10)', dec)}${opt(2, 'Two decimals (0.25/0.50)', dec)}</select></label>
            <label><span class="lbl">Small blind</span><input name="sb" type="number" inputmode="decimal" step="any" min="0" value="${stake('smallBlind', dec ? '0.25' : '5')}"></label>
            <label><span class="lbl">Big blind</span><input name="bb" type="number" inputmode="decimal" step="any" min="0" value="${stake('bigBlind', dec ? '0.50' : '10')}"></label>
            <label><span class="lbl">Minimum buy-in</span><input name="min" type="number" inputmode="decimal" step="any" min="0" placeholder="Any" value="${s.minBuyIn && sameDec ? toInput(s.minBuyIn, dec) : ''}"></label>
            <label><span class="lbl">Maximum stack</span><input name="max" type="number" inputmode="decimal" step="any" min="0" placeholder="Any" value="${s.maxBuyIn && sameDec ? toInput(s.maxBuyIn, dec) : ''}"></label>
            <label><span class="lbl">Seats</span><select name="seats"><option selected>${s.maxPlayers || 8}</option></select></label>
          </div>
          <p class="hint" data-seat-hint></p>
        </div>
        <div>
          <h3>Clock</h3>
          <div class="field-grid">
            <label><span class="lbl">Seconds to act</span><input name="decisionSeconds" type="number" min="5" max="600" value="${s.decisionSeconds || 30}"></label>
            <label><span class="lbl">Time bank (seconds)</span><input name="timeBankSeconds" type="number" min="0" max="3600" value="${s.timeBankSeconds ?? 60}"></label>
            <label><span class="lbl">Game length</span><select name="sessionMinutes">${lengths.map(([m, l]) => opt(m, l, minutes)).join('')}</select></label>
          </div>
          <p class="hint">When the game length runs out, the hand in progress finishes and everyone is cashed out.</p>
        </div>
      </section>
      <section class="sg-sec">
        <h3>Bomb pots</h3>
        ${bombFieldsHTML(bp)}
      </section>
      <section class="sg-sec sg-cols">
        <div>
          <h3>All in</h3>
          <label><span class="lbl">Run it</span><select name="rit">${opt(4, 'Up to four times', ritVal)}${opt(3, 'Up to three times', ritVal)}${opt(2, 'Up to twice', ritVal)}${opt(1, 'Once only', ritVal)}</select></label>
          <p class="hint">${esc(ritText)}</p>
        </div>
        <div>
          <h3>Seating and shuffle checks</h3>
          <div class="stack-sm">
            <label class="check"><input type="checkbox" name="autoApprove"> Seat players and approve rebuys automatically<small>Leave off to approve every buy-in yourself.</small></label>
            <label class="check"><input type="checkbox" name="autoStart"> Deal as soon as two players sit down<small>Off: the game waits until you press Start.</small></label>
            <label class="check"><input type="checkbox" name="revealSession" ${s.revealPolicy === 'session' ? 'checked' : ''}> Keep folded cards private until the game ends<small>Off: each hand's seed is revealed right after it and every browser checks it.</small></label>
          </div>
        </div>
      </section>
      <p class="bad hidden" data-err role="alert"></p>
    </form>`,
    foot: '<button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-create>Start game</button>',
  });
  const form = dlg.$('#startform');
  const el = (n) => form.elements.namedItem(n);
  bindSegs(form);
  bindBombFields(form);
  const refit = () => fitSeats(el('seats'), readFormat(form), readBomb(form), dlg.$('[data-seat-hint]'));
  bindFormatEditor(form, refit);
  form.addEventListener('change', (e) => { if (e.target.closest('[data-bomb]')) refit(); });

  const applyTarget = (first) => {
    target = targets.find((t) => t.id === el('target').value) || targets[0];
    const club = target.club;
    dlg.$('[data-dec-row]').classList.toggle('hidden', club);
    const nextDec = club ? target.decimals : Number(el('decimals').value);
    if (!first && nextDec !== dec) {
      el('sb').value = nextDec ? '0.25' : '5';
      el('bb').value = nextDec ? '0.50' : '10';
      el('min').value = '';
      el('max').value = '';
    }
    dec = nextDec;
    dlg.$('[data-where-hint]').textContent = club
      ? 'Members buy in from their club balance (plus any credit) and cash out back into it.'
      : 'A private table keeps its own ledger. You approve seats unless you turn on automatic seating.';
    el('tname').placeholder = club ? 'Main game' : `${user.name}'s game`;
    if (first) {
      el('autoApprove').checked = s.autoApprove ?? club;
      el('autoStart').checked = s.autoStart ?? club;
    }
  };
  form.addEventListener('change', (e) => {
    if (e.target.name === 'target') applyTarget(false);
    if (e.target.name === 'decimals') {
      const two = e.target.value === '2';
      dec = two ? 2 : 0;
      el('sb').value = two ? '0.25' : '5';
      el('bb').value = two ? '0.50' : '10';
    }
  });
  applyTarget(true);
  refit();

  const err = dlg.$('[data-err]');
  const showErr = (m) => { err.textContent = m; err.classList.remove('hidden'); err.scrollIntoView({ block: 'nearest' }); };
  dlg.$('[data-create]').addEventListener('click', async (e) => {
    err.classList.add('hidden');
    const P = (n) => parseChips(el(n).value, dec);
    const fmt = readFormat(form);
    if (fmt.some((x) => x.length !== 'orbit' && !(x.length >= 1 && x.length <= 500))) return showErr('Each step of the format needs between 1 and 500 hands.');
    const sb = P('sb');
    const bb = P('bb');
    if (!(sb > 0) || !(bb > 0)) return showErr('Enter the blinds.');
    const runs = Number(el('rit').value);
    const settings = {
      format: fmt,
      smallBlind: sb, bigBlind: bb,
      minBuyIn: el('min').value ? P('min') : 0, maxBuyIn: el('max').value ? P('max') : 0,
      maxPlayers: Number(el('seats').value),
      bombPot: readBomb(form),
      rit: { enabled: runs > 1, maxRuns: Math.max(2, runs) },
      decisionSeconds: Number(el('decisionSeconds').value), timeBankSeconds: Number(el('timeBankSeconds').value),
      sessionMinutes: Number(el('sessionMinutes').value),
      autoApprove: el('autoApprove').checked, autoStart: el('autoStart').checked,
      revealPolicy: el('revealSession').checked ? 'session' : 'hand',
    };
    if (!target.club) settings.decimals = dec;
    const name = el('tname').value.trim();
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = target.club
        ? await api.post(`/api/clubs/${encodeURIComponent(target.id)}/tables`, { name: name || 'Main game', settings })
        : await api.post('/api/tables', { name, settings });
      saveLast({ target: target.id, decimals: dec, name, settings });
      location.href = '/t/' + r.id;
    } catch (x) {
      btn.disabled = false;
      showErr(x.message);
    }
  });
  return dlg;
}

