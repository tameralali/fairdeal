// Card rendering and per-player appearance preferences (stored in this browser only).
const PKEY = 'fd:prefs';

export const DEFAULT_PREFS = {
  deck: 'big',        // big | classic
  colors: 'four',     // four: spades black, hearts red, diamonds blue, clubs green; two: red and black
  back: 'oxblood',    // oxblood | navy | forest | slate | brass
  felt: '',           // '' = use the table's felt color
  sound: true,         // a call when it is my turn
  tableSounds: true,   // chips for bets, folds, checks, cards dealt, the pot won
  autoRun: 'ask',     // ask | once | any (go with whatever number the others pick)
  handStrength: true,
  verifyNotes: true,
};

export const FELTS = [
  { id: '#507a4e', name: 'Green' },
  { id: '#1d6b48', name: 'Club green' },
  { id: '#1b5e63', name: 'Teal' },
  { id: '#23446b', name: 'Navy' },
  { id: '#5c2230', name: 'Burgundy' },
  { id: '#4a3266', name: 'Plum' },
  { id: '#3a3d40', name: 'Graphite' },
  { id: '#6b4a24', name: 'Tobacco' },
];

export const BACKS = [
  { id: 'oxblood', name: 'Oxblood' },
  { id: 'navy', name: 'Navy' },
  { id: 'forest', name: 'Forest' },
  { id: 'slate', name: 'Slate' },
  { id: 'brass', name: 'Brass' },
];

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(PKEY) || '{}');
    // the old two-colour default is replaced by a choice that starts at four colours
    delete saved.fourColor;
    // the run-it vote needs agreement now: always picking the most becomes going with the others
    if (saved.autoRun === 'max') saved.autoRun = 'any';
    return { ...DEFAULT_PREFS, ...saved };
  } catch { return { ...DEFAULT_PREFS }; }
}

export const prefs = load();

export function savePrefs(next) {
  Object.assign(prefs, next);
  try { localStorage.setItem(PKEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  applyPrefs();
}

export function applyPrefs(root = document.documentElement) {
  root.dataset.deck = prefs.deck;
  root.dataset.four = prefs.colors === 'two' ? '0' : '1';
  root.dataset.back = prefs.back;
}

export const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RANK_WORD = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: 'Ten' };
const SUIT_WORD = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };

export function rankLabel(card) {
  return card[0] === 'T' ? '10' : card[0];
}

// The four suits, drawn once and reused by every card so they look the same on every device.
const SUIT_SPRITE = `<svg id="suit-sprite" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<symbol id="su-h" viewBox="0 0 100 100"><path d="M50 92C46 85 36 77 25 67C11 54 3 44 3 30C3 15 14 5 27.5 5C37.5 5 45.5 11 50 20C54.5 11 62.5 5 72.5 5C86 5 97 15 97 30C97 44 89 54 75 67C64 77 54 85 50 92Z"/></symbol>
<symbol id="su-d" viewBox="0 0 100 100"><path d="M50 2C59.4 19 71.6 35 86.7 50C71.6 65 59.4 81 50 98C40.6 81 28.4 65 13.3 50C28.4 35 40.6 19 50 2Z"/></symbol>
<symbol id="su-s" viewBox="0 0 100 100"><path d="M50 3C56.1 15 66.5 25 76.1 34C85.7 43 90.9 52 90.9 63C90.9 76 82.2 85 71.8 85C64.4 85 57.8 80.5 53.9 73.5C54.8 83 58.7 90.5 66.5 96L33.5 96C41.3 90.5 45.2 83 46.1 73.5C42.2 80.5 35.6 85 28.2 85C17.8 85 9.1 76 9.1 63C9.1 52 14.3 43 23.9 34C33.5 25 43.9 15 50 3Z"/></symbol>
<symbol id="su-c" viewBox="0 0 100 100"><circle cx="50" cy="27" r="21"/><circle cx="26" cy="59" r="21"/><circle cx="74" cy="59" r="21"/><path d="M38 38H62L60 66H40Z"/><path d="M46.5 60C46.5 78 43 88 32 96H68C57 88 53.5 78 53.5 60Z"/></symbol>
</defs></svg>`;
if (typeof document !== 'undefined' && document.body && !document.getElementById('suit-sprite')) document.body.insertAdjacentHTML('afterbegin', SUIT_SPRITE);
const pip = (s, cls) => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#su-${s}"/></svg>`;

// style: extra inline style, e.g. the place of a card in a fanned hand
export function cardHTML(card, cls = '', style = '') {
  const r = rankLabel(card);
  const s = card[1];
  const word = `${RANK_WORD[card[0]] || r} of ${SUIT_WORD[s]}`;
  return `<span class="card face s-${s} ${cls}" role="img" aria-label="${word}"${style ? ` style="${style}"` : ''}><span class="ci"><b class="${r === '10' ? 'r10' : ''}">${r}</b>${pip(s, 'su')}</span>${pip(s, 'cp')}</span>`;
}

export function backHTML(cls = '', style = '') {
  return `<span class="card back ${cls}" role="img" aria-label="face-down card"${style ? ` style="${style}"` : ''}></span>`;
}

// What a hand makes, short, the way it is labelled on the table: "Two pair (5,4)", "Flush".
const R1 = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10' };
const rk = (v) => R1[v] || String(v);
const KINDS = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
// brief: just the kind of hand, for a label that names a hand on each of two boards
export function shortHandName(score, brief = false) {
  const c = score >> 20;
  const a = (score >> 16) & 15;
  const b = (score >> 12) & 15;
  if (brief) return c === 8 && a === 14 ? 'Royal flush' : KINDS[c];
  switch (c) {
    case 8: return a === 14 ? 'Royal flush' : `Straight flush (${rk(a)} high)`;
    case 7: return `Four of a kind (${rk(a)})`;
    case 6: return `Full house (${rk(a)},${rk(b)})`;
    case 5: return 'Flush';
    case 4: return `Straight (${rk(a)} high)`;
    case 3: return `Three of a kind (${rk(a)})`;
    case 2: return `Two pair (${rk(a)},${rk(b)})`;
    case 1: return `Pair (${rk(a)})`;
    default: return `High card (${rk(a)})`;
  }
}

export function slotHTML(cls = '') {
  return `<span class="card slot ${cls}" aria-hidden="true"></span>`;
}

// Colours suit symbols inside log text such as "A♥, 10♣".
export function suitText(html) {
  return html.replace(/(10|[2-9AKQJ])([♠♥♦♣])/g, (m, r, s) => {
    const k = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' }[s];
    return `<span class="ts s-${k}">${r}${s}</span>`;
  });
}
