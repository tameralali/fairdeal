// Game settings shared by "Start a game" and the host's Options at the table: the format (which games,
// in what order, for how long, on one board or two), bomb pots, and the pop-out that creates a table.
import { api, parseChips, toInput } from './api.js';
import { esc, dialog, toast } from './ui.js';
import { GAME_TYPES } from '/shared/cards.js';

export const MAX_STEPS = 8;
const LAST_KEY = 'aq:lastGame';

// A step of the format plays one game for a number of orbits or a number of hands.
const step = (game, unit = 'orbits', count = 1, doubleBoard = false) => ({ game, unit, count, doubleBoard });
export const MAX_COUNT = { orbits: 50, hands: 500 };
export const PRESETS = [
  { id: 'mix-orbit', label: 'PLO and NLH, an orbit each', format: [step('plo4'), step('nlh')] },
  { id: 'mix-2', label: 'PLO and NLH, 2 orbits each', format: [step('plo4', 'orbits', 2), step('nlh', 'orbits', 2)] },
  { id: 'mix-10', label: 'PLO and NLH, 10 hands each', format: [step('plo4', 'hands', 10), step('nlh', 'hands', 10)] },
  { id: 'nlh', label: 'NLH only', format: [step('nlh')] },
  { id: 'plo', label: 'PLO only', format: [step('plo4')] },
  { id: 'three', label: 'PLO, PLO5 and NLH', format: [step('plo4'), step('plo5'), step('nlh')] },
];

// Older saved formats said length: 'orbit' or a number of hands.
export function normStep(x) {
  if (x && x.unit === undefined && x.length !== undefined) {
    return x.length === 'orbit' ? step(x.game, 'orbits', 1, !!x.doubleBoard) : step(x.game, 'hands', Number(x.length) || 10, !!x.doubleBoard);
  }
  return step(x?.game || 'nlh', x?.unit === 'hands' ? 'hands' : 'orbits', Number(x?.count) || 1, !!x?.doubleBoard);
}
export const normFormat = (f) => (Array.isArray(f) && f.length ? f.map(normStep) : null);
const stepOk = (x) => Number.isInteger(x.count) && x.count >= 1 && x.count <= MAX_COUNT[x.unit];
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

export const lenText = (s) => `${s.count} ${s.unit === 'hands' ? 'hand' : 'orbit'}${s.count === 1 ? '' : 's'}`;
export function stepLabel(s) { return `${gameShort(s.game)}${s.doubleBoard ? ' double board' : ''}`; }
export function formatSentence(format) {
  if (format.length === 1) return `Every hand is ${stepLabel(format[0])}.`;
  return `Plays ${format.map((s) => `${stepLabel(s)} for ${lenText(s)}`).join(', then ')}, then starts again from the top.`;
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
  const hands = s.unit === 'hands';
  return `<li class="fstep" data-step>
    <span class="fstep-n" aria-hidden="true">${i + 1}</span>
    <select data-f="game" aria-label="Game for step ${i + 1}">${gameOptions(s.game)}</select>
    <span class="fstep-len">
      <span class="fstep-for">for</span>
      <input data-f="count" type="number" inputmode="numeric" min="1" max="${MAX_COUNT[s.unit]}" step="1" value="${s.count}" aria-label="How many ${hands ? 'hands' : 'orbits'} in step ${i + 1}">
      <select data-f="unit" aria-label="Orbits or hands for step ${i + 1}"><option value="orbits" ${hands ? '' : 'selected'}>${s.count === 1 ? 'orbit' : 'orbits'}</option><option value="hands" ${hands ? 'selected' : ''}>${s.count === 1 ? 'hand' : 'hands'}</option></select>
    </span>
    <label class="fstep-db"><input type="checkbox" data-f="db" ${s.doubleBoard ? 'checked' : ''}><span>Double board</span></label>
    <button type="button" class="btn tiny ghost" data-step-remove ${n === 1 ? 'disabled' : ''} aria-label="Remove step ${i + 1}">Remove</button>
  </li>`;
}

export function formatEditorHTML(format) {
  format = normFormat(format) || structuredClone(DEFAULT_FORMAT);
  return `<div class="fmt" data-format>
    <div class="fmt-presets" role="group" aria-label="Quick formats">${PRESETS.map((p) => `<button type="button" class="fmt-chip" data-preset="${p.id}">${esc(p.label)}</button>`).join('')}</div>
    <ol class="fmt-steps" data-steps>${format.map((s, i) => stepRow(s, i, format.length)).join('')}</ol>
    <div class="fmt-foot"><button type="button" class="btn small" data-step-add>Add a game</button><p class="hint" data-format-sentence></p></div>
  </div>`;
}

export function readFormat(root) {
  return [...root.querySelectorAll('[data-step]')].map((li) => ({
    game: li.querySelector('[data-f=game]').value,
    unit: li.querySelector('[data-f=unit]').value === 'hands' ? 'hands' : 'orbits',
    count: Number(li.querySelector('[data-f=count]').value),
    doubleBoard: li.querySelector('[data-f=db]').checked,
  }));
}

// Message for the first step whose count is out of range, or ''.
export function formatProblem(f) {
  const i = f.findIndex((x) => !stepOk(x));
  if (i < 0) return '';
  const x = f[i];
  return `Step ${i + 1} needs between 1 and ${MAX_COUNT[x.unit]} ${x.unit}.`;
}

export function bindFormatEditor(root, onChange = () => {}) {
  const wrap = root.querySelector('[data-format]');
  const list = wrap.querySelector('[data-steps]');
  const sentence = wrap.querySelector('[data-format-sentence]');
  const update = () => {
    const f = readFormat(root);
    const bad = formatProblem(f);
    sentence.textContent = bad || formatSentence(f);
    sentence.classList.toggle('bad', !!bad);
    // the unit names follow the count: 1 orbit, 2 orbits
    for (const li of list.querySelectorAll('[data-step]')) {
      const n = Number(li.querySelector('[data-f=count]').value);
      const unit = li.querySelector('[data-f=unit]');
      unit.options[0].textContent = n === 1 ? 'orbit' : 'orbits';
      unit.options[1].textContent = n === 1 ? 'hand' : 'hands';
      li.querySelector('[data-f=count]').max = MAX_COUNT[unit.value];
    }
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
      const last = f.at(-1);
      f.push(step(game, last?.unit || 'orbits', stepOk(last || {}) ? last.count : 1, false));
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
  wrap.addEventListener('change', update);
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

// Opens a new game in the club. Amounts are in dollars and cents.
export function startGameDialog({ user }) {
  const last = loadLast();
  const s = last?.settings || {};
  const dec = 2;
  const sameDec = last && last.decimals === dec;
  const stake = (k, d) => (sameDec && s[k] !== undefined ? toInput(s[k], dec) : d);
  const format = normFormat(s.format) || structuredClone(DEFAULT_FORMAT);
  const bp = { mode: 'off', every: 10, percent: 10, anteBB: 2, game: 'current', doubleBoard: false, ...(s.bombPot || {}) };
  const rit = s.rit || { enabled: true, maxRuns: 4 };
  const ritVal = rit.enabled ? rit.maxRuns : 1;
  const lengths = [[0, 'No limit'], [60, '1 hour'], [90, '1 hour 30'], [120, '2 hours'], [150, '2 hours 30'], [180, '3 hours'], [240, '4 hours'], [300, '5 hours'], [360, '6 hours']];
  const minutes = s.sessionMinutes || 0;
  if (!lengths.some(([m]) => m === minutes)) lengths.push([minutes, `${minutes} minutes`]);
  const opt = (v, l, cur) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`;
  const money = (name, value, placeholder = '') => `<span class="money"><input name="${name}" type="text" inputmode="decimal" autocomplete="off" placeholder="${placeholder}" value="${value}"></span>`;

  const dlg = dialog({
    title: 'Start a game', className: 'wide start-game',
    body: `<form id="startform" class="sg" autocomplete="off" novalidate>
      <section class="sg-sec">
        <label class="grow"><span class="lbl">Table name</span><input name="tname" type="text" maxlength="40" placeholder="Main game" value="${esc(last?.name || '')}"></label>
        <p class="hint">Players buy in from their club balance (plus any credit) and cash out back into it.</p>
      </section>
      <section class="sg-sec">
        <h3>Format</h3>
        ${formatEditorHTML(format)}
        <p class="hint">An orbit ends when the button has gone around the table once.</p>
      </section>
      <section class="sg-sec sg-cols">
        <div>
          <h3>Stakes and seats</h3>
          <div class="field-grid">
            <label><span class="lbl">Small blind</span>${money('sb', stake('smallBlind', '0.25'))}</label>
            <label><span class="lbl">Big blind</span>${money('bb', stake('bigBlind', '0.50'))}</label>
            <label><span class="lbl">Minimum buy-in</span>${money('min', s.minBuyIn && sameDec ? toInput(s.minBuyIn, dec) : '', 'Any')}</label>
            <label><span class="lbl">Maximum stack</span>${money('max', s.maxBuyIn && sameDec ? toInput(s.maxBuyIn, dec) : '', 'Any')}</label>
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
            <label class="check"><input type="checkbox" name="autoApprove" ${s.autoApprove ?? true ? 'checked' : ''}> Seat players and approve rebuys automatically<small>Leave off to approve every buy-in yourself.</small></label>
            <label class="check"><input type="checkbox" name="autoStart" ${s.autoStart ?? true ? 'checked' : ''}> Deal as soon as two players sit down<small>Off: the game waits until you press Start.</small></label>
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
  refit();

  const err = dlg.$('[data-err]');
  const showErr = (m) => { err.textContent = m; err.classList.remove('hidden'); err.scrollIntoView({ block: 'nearest' }); };
  dlg.$('[data-create]').addEventListener('click', async (e) => {
    err.classList.add('hidden');
    const P = (n) => parseChips(el(n).value, dec);
    const fmt = readFormat(form);
    const bad = formatProblem(fmt);
    if (bad) return showErr(bad);
    const sb = P('sb');
    const bb = P('bb');
    if (!(sb > 0) || !(bb > 0)) return showErr('Enter the blinds in dollars, like 0.25 and 0.50.');
    if (bb < sb) return showErr('The big blind should be at least the small blind.');
    for (const k of ['min', 'max']) if (el(k).value.trim() && !(P(k) > 0)) return showErr(`Enter the ${k === 'min' ? 'minimum buy-in' : 'maximum stack'} in dollars, or leave it empty.`);
    const runs = Number(el('rit').value);
    const settings = {
      format: fmt,
      smallBlind: sb, bigBlind: bb,
      minBuyIn: el('min').value.trim() ? P('min') : 0, maxBuyIn: el('max').value.trim() ? P('max') : 0,
      maxPlayers: Number(el('seats').value),
      bombPot: readBomb(form),
      rit: { enabled: runs > 1, maxRuns: Math.max(2, runs) },
      decisionSeconds: Number(el('decisionSeconds').value), timeBankSeconds: Number(el('timeBankSeconds').value),
      sessionMinutes: Number(el('sessionMinutes').value),
      autoApprove: el('autoApprove').checked, autoStart: el('autoStart').checked,
      revealPolicy: el('revealSession').checked ? 'session' : 'hand',
    };
    const name = el('tname').value.trim();
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api.post('/api/tables', { name: name || 'Main game', settings });
      saveLast({ decimals: dec, name, settings });
      location.href = '/t/' + r.id;
    } catch (x) {
      btn.disabled = false;
      showErr(x.message);
    }
  });
  return dlg;
}
