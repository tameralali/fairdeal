// Card rendering and per-player appearance preferences (stored in this browser only).
const PKEY = 'fd:prefs';

export const DEFAULT_PREFS = {
  deck: 'big',        // big | classic
  fourColor: false,
  back: 'oxblood',    // oxblood | navy | forest | slate | brass
  felt: '',           // '' = use the table's felt color
  sound: true,
  autoRun: 'ask',     // ask | once | max
  handStrength: true,
  verifyNotes: true,
};

export const FELTS = [
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
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PKEY) || '{}') }; }
  catch { return { ...DEFAULT_PREFS }; }
}

export const prefs = load();

export function savePrefs(next) {
  Object.assign(prefs, next);
  try { localStorage.setItem(PKEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  applyPrefs();
}

export function applyPrefs(root = document.documentElement) {
  root.dataset.deck = prefs.deck;
  root.dataset.four = prefs.fourColor ? '1' : '0';
  root.dataset.back = prefs.back;
}

export const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RANK_WORD = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: 'Ten' };
const SUIT_WORD = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };

export function rankLabel(card) {
  return card[0] === 'T' ? '10' : card[0];
}

export function cardHTML(card, cls = '') {
  const r = rankLabel(card);
  const s = card[1];
  const word = `${RANK_WORD[card[0]] || r} of ${SUIT_WORD[s]}`;
  return `<span class="card face s-${s} ${cls}" role="img" aria-label="${word}"><span class="ci"><b class="${r === '10' ? 'r10' : ''}">${r}</b><i>${SUIT[s]}</i></span><span class="cp">${SUIT[s]}</span></span>`;
}

export function backHTML(cls = '') {
  return `<span class="card back ${cls}" role="img" aria-label="face-down card"></span>`;
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
