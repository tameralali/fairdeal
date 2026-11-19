// The stats table and what each number means, shared by the table page and the club page.
import { esc } from './ui.js';
import { GAME_TYPES } from '/shared/cards.js';

const gameShort = (g) => GAME_TYPES[g]?.short || g;

// What each number means. opp names the count of chances behind a percentage.
export const STATS = [
  { k: 'vpip', label: 'VPIP', name: 'Voluntarily put money in the pot', group: 'Before the flop', opp: 'pfOpp', help: 'How often a player calls or raises before the flop. Posting a blind does not count.' },
  { k: 'pfr', label: 'PFR', name: 'Preflop raise', group: 'Before the flop', opp: 'pfOpp', help: 'How often a player raises before the flop.' },
  { k: 'threeBet', label: '3-bet', name: 'Three-bet', group: 'Before the flop', opp: 'threeBetOpp', help: 'How often a player re-raises when facing a single raise before the flop.' },
  { k: 'foldTo3Bet', label: 'Fold to 3-bet', name: 'Fold to a three-bet', group: 'Before the flop', opp: 'foldTo3BetOpp', help: 'How often a player who made the first raise folds when someone re-raises.' },
  { k: 'ats', label: 'ATS', name: 'Attempt to steal', group: 'Before the flop', opp: 'atsOpp', help: 'How often a player raises first in from the cutoff, the button or the small blind when everyone before them folded.' },
  { k: 'foldToSteal', label: 'Fold to steal', name: 'Fold to a steal', group: 'Before the flop', opp: 'foldToStealOpp', help: 'How often a player in the blinds folds to a steal attempt.' },
  { k: 'af', label: 'AF', name: 'Aggression factor', group: 'After the flop', ratio: true, help: 'Bets and raises divided by calls after the flop. Above 2 is aggressive, below 1 is passive.' },
  { k: 'afq', label: 'AFq', name: 'Aggression frequency', group: 'After the flop', opp: 'afqOpp', help: 'The share of a player’s actions after the flop that are bets or raises. Calls and folds count as actions.' },
  { k: 'cbet', label: 'C-bet', name: 'Continuation bet', group: 'After the flop', opp: 'cbetOpp', help: 'How often the last raiser before the flop bets the flop when nobody bet before them.' },
  { k: 'foldToCbet', label: 'Fold to c-bet', name: 'Fold to a continuation bet', group: 'After the flop', opp: 'foldToCbetOpp', help: 'How often a player folds the first time they face a continuation bet.' },
  { k: 'wtsd', label: 'WTSD', name: 'Went to showdown', group: 'After the flop', opp: 'sawFlop', help: 'Of the hands where a player saw the flop, how often they went all the way to a showdown.' },
  { k: 'wsd', label: 'W$SD', name: 'Won money at showdown', group: 'After the flop', opp: 'showdowns', help: 'How often a player wins at least part of the pot when they go to a showdown.' },
  { k: 'wwsf', label: 'WWSF', name: 'Won when saw the flop', group: 'After the flop', opp: 'sawFlop', help: 'How often a player who saw the flop won at least part of the pot, with or without a showdown.' },
];
const RESULTS_HELP = [
  ['Hands', 'Hands dealt in, bomb pots included.'],
  ['Net', 'Money won or lost in these hands.'],
  ['bb/100', 'Big blinds won per 100 hands, so results at different stakes can be compared.'],
];

export const pct = (v) => (v === null || v === undefined ? '-' : `${Math.round(v)}`);
export function afText(r) {
  if (r.af !== null && r.af !== undefined) return r.af.toFixed(1);
  return r.afBets > 0 ? '∞' : '-';
}
export const val = (r, s) => (s.ratio ? afText(r) : pct(r[s.k]));
export const tip = (r, s) => {
  if (s.ratio) return `${s.name}: ${r.afBets} bets or raises, ${r.afCalls} calls after the flop`;
  const n = r[s.opp] || 0;
  return r[s.k] === null || r[s.k] === undefined ? `${s.name}: no chances yet` : `${s.name}: ${r[s.k]}% of ${n} chance${n === 1 ? '' : 's'}`;
};
export const signedMoney = (fmt, n) => (n === null || n === undefined ? '<span class="faint">-</span>' : `<span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${n > 0 ? '+' : ''}${fmt(n)}</span>`);

export function gameSeg(games, cur) {
  const opts = [['all', 'All games'], ...games.map((g) => [g.id, gameShort(g.id)])];
  return `<div class="seg" data-game role="group" aria-label="Game">${opts.map(([v, l]) => `<button type="button" data-v="${esc(v)}" class="${v === cur ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
}

// fmt formats money; rows open a player sheet when the page listens for data-player-sheet.
export function statsTable(st, { me, fmt, rowAttr = 'data-player-sheet' }) {
  if (!st.players.length) return '<p class="muted">No hands played yet.</p>';
  const groups = [...new Set(STATS.map((s) => s.group))];
  return `<div class="stats-scroll"><table class="data stats-table">
    <thead>
      <tr class="grp"><th></th><th></th>${groups.map((g) => `<th colspan="${STATS.filter((s) => s.group === g).length}">${esc(g)}</th>`).join('')}<th colspan="2">Results</th></tr>
      <tr><th class="who">Player</th><th class="n">Hands</th>${STATS.map((s) => `<th class="n" title="${esc(`${s.name}. ${s.help}`)}">${esc(s.label)}</th>`).join('')}<th class="n">Net</th><th class="n">bb/100</th></tr>
    </thead>
    <tbody>${st.players.map((r) => `<tr class="${rowAttr ? 'hand-row ' : ''}${r.userId === me ? 'mine' : ''}" ${rowAttr ? `${rowAttr}="${esc(r.userId)}" tabindex="0"` : ''}>
      <td class="who">${esc(r.name)}</td><td class="n">${r.hands}</td>
      ${STATS.map((s) => `<td class="n" title="${esc(tip(r, s))}">${val(r, s)}</td>`).join('')}
      <td class="n">${signedMoney(fmt, r.net)}</td><td class="n">${r.bb100 === null ? '<span class="faint">-</span>' : r.bb100.toFixed(1)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

export function glossaryHTML() {
  return `<details class="glossary"><summary>What the numbers mean</summary>
    <dl>${STATS.map((s) => `<div><dt>${esc(s.label)}</dt><dd><b>${esc(s.name)}.</b> ${esc(s.help)}</dd></div>`).join('')}
    ${RESULTS_HELP.map(([a, b]) => `<div><dt>${esc(a)}</dt><dd>${esc(b)}</dd></div>`).join('')}</dl>
    <p class="hint">Percentages are of the chances a player had, shown when you point at a number. Bomb pots have no betting before the flop, so they only count toward the numbers after the flop. On each seat: VPIP / PFR / AF, then hands.</p>
  </details>`;
}

