// Card model shared by the server, the browser client and the standalone verifier.
// A card is a two-character string: rank (23456789TJQKA) + suit (c d h s), e.g. "As", "Td", "7c".

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';

// Canonical (unshuffled) deck order used as the starting point of every shuffle:
// 2c 2d 2h 2s 3c 3d 3h 3s ... Ac Ad Ah As
export const CANONICAL_DECK = (() => {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  return deck;
})();

export const SUIT_SYMBOLS = { c: '♣', d: '♦', h: '♥', s: '♠' };
export const SUIT_NAMES = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };

export function rankValue(card) {
  return RANKS.indexOf(card[0]) + 2;
}

export function isCard(c) {
  return typeof c === 'string' && c.length === 2 && RANKS.includes(c[0]) && SUITS.includes(c[1]);
}

// Supported games. maxPlayers is limited by the 52-card deck (PLO5 needs 5 cards per player).
export const GAME_TYPES = {
  nlh: { id: 'nlh', name: "No Limit Texas Hold'em", short: 'NLH', holeCount: 2, limit: 'nl', omaha: false, maxPlayers: 10 },
  plo4: { id: 'plo4', name: 'Pot Limit Omaha', short: 'PLO', holeCount: 4, limit: 'pl', omaha: true, maxPlayers: 10 },
  plo5: { id: 'plo5', name: 'Pot Limit Omaha (5 cards)', short: 'PLO5', holeCount: 5, limit: 'pl', omaha: true, maxPlayers: 9 },
};

export function gameInfo(id) {
  return GAME_TYPES[id] || GAME_TYPES.nlh;
}
