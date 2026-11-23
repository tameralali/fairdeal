// Game settings shared by "Start a game" and the host's Options at the table: the format (which games,
// in what order, for how long, on one board or two), bomb pots, and the pop-out that creates a table.
import { api, parseChips, toInput } from './api.js';
import { esc, dialog, toast, confirmDialog } from './ui.js';
import { GAME_TYPES } from '/shared/cards.js';

export const MAX_STEPS = 8;
const LAST_KEY = 'aq:lastGame';

// A game started from a preset is named for its night, the way the group says it: "Sunday 22 Nov
// floppies", by the starter's own clock. A name like that kept from an earlier game moves to today.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const datedName = (d = new Date()) => `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]} floppies`;
const DATED = new RegExp(`^(${DAY_NAMES.join('|')}) \\d{1,2} (${MONTH_NAMES.join('|')}) floppies$`);
export const isDatedName = (n) => DATED.test(String(n || '').trim());

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
// A bomb pot can come on a schedule (every N hands), by chance (a percentage of hands), or both: then it
// comes at least every N hands, and the chance can bring one sooner.
export function bombFieldsHTML(bp) {
  const opt = (v, l) => `<option value="${v}" ${v === bp.game ? 'selected' : ''}>${esc(l)}</option>`;
  const every = bp.mode === 'every' || bp.mode === 'both';
  const chance = bp.mode === 'percent' || bp.mode === 'both';
  return `<div class="stack" data-bomb>
    <div class="bomb-rules">
      <div class="bomb-rule"><label class="check inline-check"><input type="checkbox" name="bombEveryOn" ${every ? 'checked' : ''}> Every</label>
        <input name="bombEvery" type="number" inputmode="numeric" min="2" max="1000" value="${bp.every}" aria-label="Bomb pot every this many hands"><span>hands</span></div>
      <div class="bomb-rule"><label class="check inline-check"><input type="checkbox" name="bombChanceOn" ${chance ? 'checked' : ''}> Random chance of</label>
        <input name="bombPercent" type="number" inputmode="decimal" min="1" max="100" step="0.5" value="${bp.percent}" aria-label="Chance of a bomb pot each hand, in percent"><span>% each hand</span></div>
    </div>
    <div class="field-grid" data-bomb-more>
      <label><span class="lbl">Bomb pot size, in big blinds</span><input name="bombAnte" type="number" inputmode="decimal" min="0.5" max="100" step="0.5" value="${bp.anteBB}"></label>
      <label><span class="lbl">Play bomb pots as</span><select name="bombGame">${opt('current', 'Current game')}${Object.values(GAME_TYPES).map((g) => opt(g.id, g.short)).join('')}</select></label>
    </div>
    <label class="check" data-bomb-more><input type="checkbox" name="bombDouble" ${bp.doubleBoard ? 'checked' : ''}> Deal bomb pots on two boards<small>Double board: the pot is split between the two boards.</small></label>
    <p class="hint" data-bomb-hint></p>
  </div>`;
}

export function readBomb(root) {
  const v = (n) => root.querySelector(`[name=${n}]`);
  const every = v('bombEveryOn').checked;
  const chance = v('bombChanceOn').checked;
  return {
    mode: every && chance ? 'both' : every ? 'every' : chance ? 'percent' : 'off',
    every: Number(v('bombEvery').value), percent: Number(v('bombPercent').value),
    anteBB: Number(v('bombAnte').value), game: v('bombGame').value, doubleBoard: v('bombDouble').checked,
  };
}

export function bindBombFields(root) {
  const show = () => {
    const b = readBomb(root);
    root.querySelector('[name=bombEvery]').disabled = !(b.mode === 'every' || b.mode === 'both');
    root.querySelector('[name=bombPercent]').disabled = !(b.mode === 'percent' || b.mode === 'both');
    // the size and the game only matter once there are bomb pots
    root.querySelectorAll('[data-bomb-more]').forEach((el) => el.classList.toggle('hidden', b.mode === 'off'));
    const hint = root.querySelector('[data-bomb-hint]');
    if (hint) {
      const size = b.anteBB > 0 ? ` Each player puts in ${b.anteBB} big blind${b.anteBB === 1 ? '' : 's'} before the flop; other hands have no ante.` : '';
      hint.textContent = b.mode === 'off' ? 'No bomb pots, unless the host calls one for the next hand. There is no ante.'
        : (b.mode === 'both' ? `A bomb pot at least every ${b.every} hands, and each other hand has a ${b.percent}% chance of being one.`
          : b.mode === 'every' ? `A bomb pot every ${b.every} hands.` : `Each hand has a ${b.percent}% chance of being a bomb pot.`) + size;
    }
  };
  root.addEventListener('change', (e) => { if (e.target.closest('[data-bomb]')) show(); });
  root.addEventListener('input', (e) => { if (e.target.closest('[data-bomb]')) show(); });
  show();
}

// ---------- tourney ----------
// A tourney: everyone buys in for the same amount, which is their starting stack, a set number of
// times at most, and the blinds go up on a clock (server/tourney.js has the rules). Standard steps
// are about one and a half times the level before, as on the server.
const STEP_TIMES = [1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 30, 40, 60, 80, 100, 120, 160, 200, 300, 400];
export const standardLevels = (sb, bb) => STEP_TIMES.map((k) => [Math.max(1, Math.round(sb * k)), bb * k]);
export const LEVEL_MINUTES = [5, 10, 12, 15, 20, 25, 30, 40, 45, 60];
const BUY_INS = [[1, '1, no rebuys'], [2, '2'], [3, '3'], [4, '4'], [5, '5'], [0, 'No limit']];
const DEFAULT_SPLIT = [65, 35];

// "0.25/0.50" for a level; whole amounts without their .00
function levelText([a, b], toIn) {
  const short = (c) => { const x = toIn(c); return x.endsWith('.00') ? x.slice(0, -3) : x; };
  return `${short(a)}/${short(b)}`;
}
export const levelsText = (levels, toIn) => levels.map((l) => levelText(l, toIn)).join('\n');

// The blind levels from the box, one a line ("0.25/0.50"), as [[sb, bb], ...], or { error }.
export function readLevels(text, parse) {
  const lines = String(text || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return { error: 'Add the blind levels, one a line, like 0.25/0.50.' };
  if (lines.length > 40) return { error: 'A tourney can have at most 40 blind levels.' };
  const out = [];
  for (const [i, line] of lines.entries()) {
    const m = line.match(/^([\d.,]+)\s*\/\s*([\d.,]+)$/);
    const sb = m ? parse(m[1]) : NaN;
    const bb = m ? parse(m[2]) : NaN;
    if (!(sb > 0) || !(bb > 0)) return { error: `Level ${i + 1} should look like 0.25/0.50 (small blind/big blind).` };
    if (sb > bb) return { error: `At level ${i + 1} the small blind is bigger than the big blind.` };
    out.push([sb, bb]);
  }
  return { levels: out };
}

// The split from "65/35", or { error }.
function readSplit(text) {
  const parts = String(text || '').split(/[\s/,%]+/).filter(Boolean).map(Number);
  if (!parts.length || parts.some((x) => !(x > 0))) return { error: 'Write the split by place like 65/35.' };
  const sum = Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100;
  if (sum !== 100) return { error: `The split by place has to add up to 100 (it adds up to ${sum}).` };
  if (parts.length > 10) return { error: 'The prize pool can be split between 10 places at most.' };
  return { split: parts };
}

// The fields. t: the tourney settings; money(name, value): an amount box; toIn: amount to box text;
// locked: a game under way keeps its buy-in and how it pays.
export function tourneyFieldsHTML(t, { money, toIn, locked = false }) {
  const opt = (v, l, cur) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`;
  const minutes = LEVEL_MINUTES.includes(t.levelMinutes) ? LEVEL_MINUTES : [...LEVEL_MINUTES, t.levelMinutes].sort((a, b) => a - b);
  const lastOpts = [[0, 'Any level'], ...Array.from({ length: 12 }, (_, i) => [i + 1, `Level ${i + 1}`])];
  if (t.lastRebuyLevel > 12) lastOpts.push([t.lastRebuyLevel, `Level ${t.lastRebuyLevel}`]);
  const buyIns = BUY_INS.some(([v]) => v === t.buyIns) ? BUY_INS : [...BUY_INS, [t.buyIns, String(t.buyIns)]];
  const split = (t.split && t.split.length ? t.split : DEFAULT_SPLIT).join('/');
  return `<div class="stack" data-tourney-fields>
      <div class="field-grid">
        <label><span class="lbl">Buy-in</span>${locked ? `<input type="text" value="${esc(toIn(t.buyIn))}" disabled>` : money('tBuyIn', t.buyIn ? toIn(t.buyIn) : '')}</label>
        <label><span class="lbl">Buy-ins per player</span><select name="tBuyIns">${buyIns.map(([v, l]) => opt(v, l, t.buyIns)).join('')}</select></label>
        <label><span class="lbl">Buying in closes after</span><select name="tLastLevel">${lastOpts.map(([v, l]) => opt(v, l, t.lastRebuyLevel)).join('')}</select></label>
        <label><span class="lbl">Minutes per level</span><select name="tMinutes">${minutes.map((m) => opt(m, `${m} minutes`, t.levelMinutes)).join('')}</select></label>
        <label><span class="lbl">Pays</span><select name="tPay" ${locked ? 'disabled' : ''}>${opt('chips', 'Chips are cash', t.pay)}${opt('place', 'By place', t.pay)}</select></label>
        <label data-split class="${t.pay === 'place' ? '' : 'hidden'}"><span class="lbl">Split by place (%)</span><input name="tSplit" type="text" inputmode="decimal" autocomplete="off" value="${esc(split)}" placeholder="65/35"></label>
      </div>
      <div class="t-levels">
        <label class="grow"><span class="lbl">Blind levels, one a line</span><textarea name="tLevels" rows="7" spellcheck="false">${esc(levelsText(t.levels || [], toIn))}</textarea></label>
        <button type="button" class="btn small" data-std-levels>Standard steps from the first level</button>
      </div>
      <p class="hint" data-tourney-hint></p>
    </div>`;
}

// Reads the fields into tourney settings, or { error }. parse: box text to an amount.
export function readTourney(root, parse, { locked = false } = {}) {
  const v = (n) => root.querySelector(`[name=${n}]`);
  const lv = readLevels(v('tLevels').value, parse);
  if (lv.error) return { error: lv.error };
  const t = {
    on: true, buyIns: Number(v('tBuyIns').value), lastRebuyLevel: Number(v('tLastLevel').value),
    levelMinutes: Number(v('tMinutes').value), levels: lv.levels,
  };
  if (!locked) {
    t.buyIn = parse(v('tBuyIn').value);
    if (!(t.buyIn > 0)) return { error: 'Enter the tourney buy-in, like 500.' };
    t.pay = v('tPay').value;
  }
  if ((locked ? v('tPay').value : t.pay) === 'place') {
    const sp = readSplit(v('tSplit').value);
    if (sp.error) return { error: sp.error };
    t.split = sp.split;
  }
  return { tourney: t };
}

// Keeps the hint, the split box and the standard steps button up to date.
export function bindTourneyFields(root, { parse, toIn, fmt }) {
  const box = root.querySelector('[data-tourney-fields]');
  if (!box) return;
  const v = (n) => root.querySelector(`[name=${n}]`);
  const show = () => {
    const pay = v('tPay').value;
    root.querySelector('[data-split]').classList.toggle('hidden', pay !== 'place');
    const lv = readLevels(v('tLevels').value, parse);
    const buyIns = Number(v('tBuyIns').value);
    const last = Number(v('tLastLevel').value);
    const bits = [];
    if (!lv.error) bits.push(`${lv.levels.length} levels of ${v('tMinutes').value} minutes, from ${levelText(lv.levels[0], toIn)} to ${levelText(lv.levels.at(-1), toIn)}; the blinds go up between hands.`);
    bits.push(buyIns === 1 ? 'No rebuys.' : `${buyIns ? `Up to ${buyIns} buy-ins each` : 'Rebuys without a limit'}, ${last ? `until level ${last} ends` : 'all game'}.`);
    bits.push(pay === 'place' ? `The buy-ins make a prize pool, paid ${v('tSplit').value || '65/35'} by place.` : 'Chips are cash: everyone cashes out the chips they hold.');
    bits.push('It ends when one player has every chip.');
    root.querySelector('[data-tourney-hint]').textContent = bits.join(' ');
  };
  box.addEventListener('input', show);
  box.addEventListener('change', show);
  box.querySelector('[data-std-levels]').addEventListener('click', () => {
    const lv = readLevels(v('tLevels').value, parse);
    const first = lv.error ? null : lv.levels[0];
    const ta = v('tLevels');
    if (!first) { toast('Put the first level on the first line, like 0.25/0.50', 'error'); ta.focus(); return; }
    ta.value = levelsText(standardLevels(first[0], first[1]), toIn);
    show();
  });
  show();
  return show;
}

// ---------- seating rules ----------
export const RATHOLE = [[0, 'Off'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours'], [-1, 'The rest of the game']];
export const ratholeHint = 'A player who stands up and sits back down within this time has to bring at least the stack they left with, even above the maximum.';
export const FOLDED = [
  ['hidden', 'Hidden for good'],
  ['hand', 'Shown after each hand'],
  ['session', 'Shown when the game ends'],
];
export const foldedHint = {
  hidden: 'After a hand, players choose which of their cards to show, one or all. Every card is sealed on its own: the boards, shown cards and undealt cards are opened and checked, folded cards never are, and each player checks their own cards privately.',
  hand: 'Each hand’s seed is revealed right after it and every browser checks the whole deck, folded cards included.',
  session: 'Folded cards stay private while you play. Every seed is revealed and checked when the game ends.',
};
// Minimum players select limited to the seats.
export function fitMinPlayers(select, seats) {
  const cur = Math.min(Number(select.value) || 2, seats);
  select.innerHTML = Array.from({ length: seats - 1 }, (_, i) => i + 2).map((n) => `<option value="${n}" ${n === cur ? 'selected' : ''}>${n === 2 ? '2 (deal right away)' : n}</option>`).join('');
}

// What ending a game does, for the confirm at the table and on the home page.
export const endGameText = (policy) => `The hand in progress finishes, then everyone is cashed out to their club balance${policy === 'session' ? ' and every seed is revealed' : ''}. The game moves to Past games.`;

export const ritText = "When everyone is all in before the river, the players in the hand pick how many times to run it, before any cards are turned over, and see each other's picks. If they all pick the same number, it runs that many times straight away; a pick of once settles it at once. If the picks still differ 8 seconds after everyone has picked, or the vote is still open after 20 seconds, it runs once.";

// Seats select limited to what the format can deal.
export function fitSeats(select, format, bombPot, hintEl) {
  const { cap, why } = seatCap(format, bombPot);
  const cur = Math.min(Number(select.value) || 8, cap);
  select.innerHTML = Array.from({ length: cap - 1 }, (_, i) => i + 2).map((n) => `<option ${n === cur ? 'selected' : ''}>${n}</option>`).join('');
  if (hintEl) hintEl.textContent = cap < 10 ? why : '';
}

// ---------- start a game ----------
function loadLast() {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
    // the time bank used to be 60 seconds by default, which was too long: games saved with it start at 20
    if (v && v.settings && !v.bank20) { if (v.settings.timeBankSeconds === 60) v.settings.timeBankSeconds = 20; v.bank20 = true; }
    return v;
  } catch { return null; }
}
function saveLast(v) { try { localStorage.setItem(LAST_KEY, JSON.stringify(v)); } catch { /* storage blocked */ } }

const LENGTHS = [[0, 'No limit'], [60, '1 hour'], [90, '1 hour 30'], [120, '2 hours'], [150, '2 hours 30'], [180, '3 hours'], [240, '4 hours'], [300, '5 hours'], [360, '6 hours']];

// The form, filled from saved settings. values: { name, settings } with amounts in cents.
function startFormHTML(values, presets, activeId) {
  const s = values.settings || {};
  const dec = 2;
  const amt = (k, d) => (s[k] !== undefined && s[k] !== null ? toInput(s[k], dec) : d);
  const format = normFormat(s.format) || structuredClone(DEFAULT_FORMAT);
  const bp = { mode: 'off', every: 10, percent: 10, anteBB: 2, game: 'current', doubleBoard: false, ...(s.bombPot || {}) };
  const rit = s.rit || { enabled: true, maxRuns: 4 };
  const ritVal = rit.enabled ? rit.maxRuns : 1;
  const minutes = s.sessionMinutes || 0;
  const lengths = LENGTHS.some(([m]) => m === minutes) ? LENGTHS : [...LENGTHS, [minutes, `${minutes} minutes`]];
  const rat = s.ratholeMinutes ?? 0;
  const rats = RATHOLE.some(([m]) => m === rat) ? RATHOLE : [...RATHOLE, [rat, `${rat} minutes`]];
  const folded = s.revealPolicy || 'hidden';
  const tour = { on: false, buyIn: 0, buyIns: 1, lastRebuyLevel: 0, levelMinutes: 15, pay: 'chips', split: [65, 35], ...(s.tourney || {}) };
  if (!tour.levels || !tour.levels.length) tour.levels = standardLevels(s.smallBlind || 25, s.bigBlind || 50);
  const opt = (v, l, cur) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`;
  const money = (name, value, placeholder = '') => `<span class="money"><input name="${name}" type="text" inputmode="decimal" autocomplete="off" placeholder="${placeholder}" value="${value}"></span>`;
  const active = presets.find((p) => p.id === activeId);
  return `<form id="startform" class="sg" autocomplete="off" novalidate>
      <section class="sg-sec preset-bar">
        <div class="preset-head"><h3>Presets</h3><span class="hint">${presets.length ? 'Pick one to fill in everything below. Admins share them.' : 'Save these settings as a preset and next time it is one click.'}</span></div>
        ${presets.length ? `<div class="preset-list" role="group" aria-label="Presets">${presets.map((p) => `<button type="button" class="fmt-chip ${p.id === activeId ? 'on' : ''}" data-preset-use="${esc(p.id)}" aria-pressed="${p.id === activeId}">${esc(p.name)}</button>`).join('')}</div>` : ''}
        <div class="preset-actions">
          ${active ? `<button type="button" class="btn small" data-preset-save>Save changes to “${esc(active.name)}”</button><button type="button" class="btn small ghost" data-preset-delete>Delete “${esc(active.name)}”</button>` : ''}
          <button type="button" class="btn small ${active ? 'ghost' : ''}" data-preset-new>Save as a new preset</button>
        </div>
      </section>
      <section class="sg-sec">
        <label class="grow"><span class="lbl">Table name</span><input name="tname" type="text" maxlength="40" placeholder="Main game" value="${esc(values.name || '')}"></label>
        <p class="hint">Players buy in from their club balance (plus any credit) and cash out back into it.</p>
      </section>
      <section class="sg-sec">
        <div class="sg-kind"><h3>Game</h3>${seg('kind', [['cash', 'Cash game'], ['tourney', 'Tourney']], tour.on ? 'tourney' : 'cash')}</div>
        <div class="${tour.on ? '' : 'hidden'}" data-tourney-sec>${tourneyFieldsHTML(tour, { money: (n, v) => money(n, v), toIn: (c) => toInput(c, dec) })}</div>
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
            <label data-cash-only><span class="lbl">Small blind</span>${money('sb', amt('smallBlind', '0.25'))}</label>
            <label data-cash-only><span class="lbl">Big blind</span>${money('bb', amt('bigBlind', '0.50'))}</label>
            <label data-cash-only><span class="lbl">Minimum buy-in</span>${money('min', s.minBuyIn && !tour.on ? toInput(s.minBuyIn, dec) : '', 'Any')}</label>
            <label data-cash-only><span class="lbl">Maximum stack</span>${money('max', s.maxBuyIn && !tour.on ? toInput(s.maxBuyIn, dec) : '', 'Any')}</label>
            <label><span class="lbl">Seats</span><select name="seats"><option selected>${s.maxPlayers || 8}</option></select></label>
            <label><span class="lbl">Players to start</span><select name="minPlayers"><option value="${s.minPlayers || 2}" selected>${s.minPlayers || 2}</option></select></label>
          </div>
          <p class="hint" data-seat-hint></p>
          <p class="hint">The first hand waits until this many players are in. After that, play goes on with two or more.</p>
        </div>
        <div>
          <h3>Clock</h3>
          <div class="field-grid">
            <label><span class="lbl">Seconds to act</span><input name="decisionSeconds" type="number" min="5" max="600" value="${s.decisionSeconds || 30}"></label>
            <label><span class="lbl">Time banks per player</span><input name="timeBanks" type="number" min="0" max="20" value="${s.timeBanks ?? 3}"></label>
            <label><span class="lbl">One back every (hands)</span><input name="timeBankRefill" type="number" min="0" max="500" value="${s.timeBankRefill ?? 15}"></label>
            <label><span class="lbl">Game length</span><select name="sessionMinutes">${lengths.map(([m, l]) => opt(m, l, minutes)).join('')}</select></label>
          </div>
          <p class="hint">Each time bank is 30 more seconds: on your turn, Extra time (or T) uses one, and you can use more than one in a hand. Each player gets one back every so many hands, up to the number they started with (0: never). When the game length runs out, the hand in progress finishes and everyone is cashed out.</p>
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
        <div data-cash-only>
          <h3>Coming back</h3>
          <label><span class="lbl">Rathole time</span><select name="rathole">${rats.map(([m, l]) => opt(m, l, rat)).join('')}</select></label>
          <p class="hint">${esc(ratholeHint)}</p>
        </div>
      </section>
      <section class="sg-sec sg-cols">
        <div>
          <h3>Straddle</h3>
          <label class="check"><input type="checkbox" name="straddle" ${s.straddle ? 'checked' : ''}> Allow a straddle<small>The player under the gun can post twice the big blind before the deal, and acts last before the flop. Each player turns it on for themselves.</small></label>
        </div>
        <div>
          <h3>7-2 game</h3>
          <label><span class="lbl">Bounty from each player</span>${money('s72', s.sevenDeuce ? toInput(s.sevenDeuce, dec) : '', 'Off')}</label>
          <p class="hint">Win a Hold’em hand holding 7-2 and show both cards, and everyone else dealt in pays you this. Leave it empty for no 7-2 game.</p>
        </div>
      </section>
      <section class="sg-sec sg-cols">
        <div>
          <h3>Folded cards</h3>
          <label><span class="lbl">Folded cards are</span><select name="folded">${FOLDED.map(([v, l]) => opt(v, l, folded)).join('')}</select></label>
          <p class="hint" data-folded-hint>${esc(foldedHint[folded])}</p>
        </div>
        <div>
          <h3>Seating</h3>
          <div class="stack-sm">
            <label class="check"><input type="checkbox" name="autoApprove" ${s.autoApprove ?? true ? 'checked' : ''}> Seat players and approve rebuys automatically<small>Leave off to approve every buy-in yourself.</small></label>
            <label class="check"><input type="checkbox" name="autoStart" ${s.autoStart ?? true ? 'checked' : ''}> Start dealing on its own<small>Off: the game waits until you press Start.</small></label>
          </div>
        </div>
      </section>
      <p class="bad hidden" data-err role="alert"></p>
    </form>`;
}

// Reads the form into { name, settings } (cents), or { error }.
function readStartForm(form) {
  const el = (n) => form.elements.namedItem(n);
  const P = (n) => parseChips(el(n).value, 2);
  const fmt = readFormat(form);
  const bad = formatProblem(fmt);
  if (bad) return { error: bad };
  const tourneyOn = el('kind').value === 'tourney';
  let tourney = { on: false };
  let sb;
  let bb;
  if (tourneyOn) {
    const t = readTourney(form, (x) => parseChips(x, 2));
    if (t.error) return { error: t.error };
    tourney = t.tourney;
    [sb, bb] = tourney.levels[0];
  } else {
    sb = P('sb');
    bb = P('bb');
    if (!(sb > 0) || !(bb > 0)) return { error: 'Enter the blinds in dollars, like 0.25 and 0.50.' };
    if (bb < sb) return { error: 'The big blind should be at least the small blind.' };
    for (const k of ['min', 'max']) if (el(k).value.trim() && !(P(k) > 0)) return { error: `Enter the ${k === 'min' ? 'minimum buy-in' : 'maximum stack'} in dollars, or leave it empty.` };
  }
  if (el('s72').value.trim() && !(P('s72') > 0)) return { error: 'Enter the 7-2 bounty in dollars, or leave it empty for no 7-2 game.' };
  const runs = Number(el('rit').value);
  return {
    name: el('tname').value.trim(),
    settings: {
      format: fmt,
      smallBlind: sb, bigBlind: bb, tourney,
      minBuyIn: tourneyOn ? tourney.buyIn : el('min').value.trim() ? P('min') : 0, maxBuyIn: tourneyOn ? tourney.buyIn : el('max').value.trim() ? P('max') : 0,
      maxPlayers: Number(el('seats').value), minPlayers: Number(el('minPlayers').value),
      bombPot: readBomb(form),
      rit: { enabled: runs > 1, maxRuns: Math.max(2, runs) },
      decisionSeconds: Number(el('decisionSeconds').value), timeBanks: Number(el('timeBanks').value), timeBankRefill: Number(el('timeBankRefill').value),
      sessionMinutes: Number(el('sessionMinutes').value), ratholeMinutes: tourneyOn ? 0 : Number(el('rathole').value),
      autoApprove: el('autoApprove').checked, autoStart: el('autoStart').checked,
      straddle: el('straddle').checked, sevenDeuce: el('s72').value.trim() ? P('s72') : 0,
      revealPolicy: el('folded').value,
    },
  };
}

function askPresetName(defaultName) {
  return new Promise((resolve) => {
    let done = false;
    const d = dialog({
      title: 'Save as a preset', className: 'narrow',
      body: `<form class="stack" data-pname><label><span class="lbl">Preset name</span><input name="pname" maxlength="40" value="${esc(defaultName)}" required></label>
        <p class="hint">Every admin can start a game from it.</p></form>`,
      foot: '<button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-ok>Save preset</button>',
      onClose: () => { if (!done) resolve(null); },
    });
    const ok = () => { const v = d.$('[name=pname]').value.trim(); if (!v) return; done = true; resolve(v); d.close(); };
    d.$('[data-ok]').addEventListener('click', ok);
    d.$('[data-pname]').addEventListener('submit', (e) => { e.preventDefault(); ok(); });
    setTimeout(() => d.$('[name=pname]').select(), 30);
  });
}

// Opens a new game in the club, in dollars and cents. presetId: start from that preset.
export async function startGameDialog({ user, presetId = null } = {}) {
  let presets = [];
  try { presets = (await api.get('/api/presets')).presets; } catch { /* members have no presets */ }
  const last = loadLast();
  let activeId = presetId && presets.some((p) => p.id === presetId) ? presetId : null;
  const fromPreset = (p) => ({ name: datedName(), settings: structuredClone(p.settings) });
  const dlg = dialog({
    title: 'Start a game', className: 'wide start-game', body: '',
    foot: '<button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-create>Start game</button>',
  });
  let form;
  const err = () => dlg.$('[data-err]');
  const showErr = (m) => { const e = err(); e.textContent = m; e.classList.remove('hidden'); e.scrollIntoView({ block: 'nearest' }); };
  const draw = (values) => {
    dlg.setBody(startFormHTML(values, presets, activeId));
    form = dlg.$('#startform');
    const el = (n) => form.elements.namedItem(n);
    bindSegs(form);
    bindBombFields(form);
    bindTourneyFields(form, { parse: (x) => parseChips(x, 2), toIn: (c) => toInput(c, 2) });
    const kind = () => {
      const on = el('kind').value === 'tourney';
      dlg.$('[data-tourney-sec]').classList.toggle('hidden', !on);
      form.querySelectorAll('[data-cash-only]').forEach((x) => x.classList.toggle('hidden', on));
      // a tourney's first level starts from the cash game's blinds when the levels are still the standard ones
      if (on) {
        const ta = el('tLevels');
        const sbv = parseChips(el('sb').value, 2);
        const bbv = parseChips(el('bb').value, 2);
        if (sbv > 0 && bbv >= sbv && !ta.dataset.touched) { ta.value = levelsText(standardLevels(sbv, bbv), (c) => toInput(c, 2)); ta.dispatchEvent(new Event('input', { bubbles: true })); }
      }
    };
    el('tLevels').addEventListener('input', (e) => { if (e.isTrusted) e.target.dataset.touched = '1'; });
    if (values.settings?.tourney?.on) el('tLevels').dataset.touched = '1';
    el('kind').addEventListener('change', kind);
    kind();
    const refit = () => {
      fitSeats(el('seats'), readFormat(form), readBomb(form), dlg.$('[data-seat-hint]'));
      fitMinPlayers(el('minPlayers'), Number(el('seats').value));
    };
    bindFormatEditor(form, refit);
    form.addEventListener('change', (e) => {
      if (e.target.closest('[data-bomb]') || e.target.name === 'seats') refit();
      if (e.target.name === 'folded') dlg.$('[data-folded-hint]').textContent = foldedHint[e.target.value];
    });
    refit();
    if (values.settings?.minPlayers) { el('minPlayers').value = String(Math.min(values.settings.minPlayers, Number(el('seats').value))); }
  };
  const start = activeId ? fromPreset(presets.find((p) => p.id === activeId)) : { name: isDatedName(last?.name) ? datedName() : last?.name || '', settings: last?.decimals === 2 ? last.settings : {} };
  draw(start);

  dlg.el.addEventListener('click', async (e) => {
    const use = e.target.closest('[data-preset-use]');
    if (use) {
      activeId = use.dataset.presetUse;
      draw(fromPreset(presets.find((p) => p.id === activeId)));
      dlg.body.scrollTop = 0;
      return;
    }
    if (e.target.closest('[data-preset-new]') || e.target.closest('[data-preset-save]')) {
      const v = readStartForm(form);
      if (v.error) return showErr(v.error);
      const saving = e.target.closest('[data-preset-save]');
      try {
        let r;
        if (saving) {
          const cur = presets.find((p) => p.id === activeId);
          r = await api.req('PUT', `/api/presets/${encodeURIComponent(activeId)}`, { name: cur.name, tableName: v.name, settings: v.settings });
          toast(`Saved “${cur.name}”`);
        } else {
          const name = await askPresetName(v.name && !isDatedName(v.name) ? v.name : 'Main game');
          if (!name) return;
          r = await api.post('/api/presets', { name, tableName: v.name, settings: v.settings });
          toast(`Saved “${name}”`);
        }
        presets = r.presets;
        activeId = r.preset.id;
        draw({ name: v.name, settings: r.preset.settings });
      } catch (x) { showErr(x.message); }
      return;
    }
    if (e.target.closest('[data-preset-delete]')) {
      const cur = presets.find((p) => p.id === activeId);
      if (!cur || !(await confirmDialog(`“${cur.name}” is deleted for every admin. Games already started are not changed.`, { title: 'Delete this preset?', ok: 'Delete preset', danger: true }))) return;
      try {
        const v = readStartForm(form);
        presets = (await api.req('DELETE', `/api/presets/${encodeURIComponent(cur.id)}`)).presets;
        activeId = null;
        draw(v.error ? fromPreset(cur) : v);
        toast('Preset deleted');
      } catch (x) { showErr(x.message); }
      return;
    }
    if (e.target.closest('[data-create]')) {
      err().classList.add('hidden');
      const v = readStartForm(form);
      if (v.error) return showErr(v.error);
      const btn = e.target.closest('[data-create]');
      btn.disabled = true;
      // The new game opens in its own tab, like games on the club page, and this tab stays on the club.
      // The tab is opened now, while the click still counts, and pointed at the game once it exists.
      const tab = window.open('', '_blank');
      try {
        const r = await api.post('/api/tables', { name: v.name || 'Main game', settings: v.settings });
        saveLast({ decimals: 2, name: v.name, settings: v.settings });
        if (tab) { tab.location.href = '/t/' + r.id; dlg.close(); } else location.href = '/t/' + r.id;
      } catch (x) {
        if (tab) tab.close();
        btn.disabled = false;
        showErr(x.message);
      }
    }
  });
  return dlg;
}
