// Picking and ordering hands, the same way in a game's own hand history, in the history of every game
// and in the Hands tab of the home page. A hand is one entry of a hand list (handList on the server,
// or handView for every game, which adds its tableId).

export const SORTS = [['new', 'Newest first'], ['old', 'Oldest first'], ['pot', 'Biggest pots'], ['won', 'Biggest wins'], ['lost', 'Biggest losses']];

const SHOWS = [['all', 'All hands'], ['showdown', 'Showdowns'], ['allin', 'All-ins'], ['bomb', 'Bomb pots'], ['two', 'Two boards'], ['straddle', 'Straddled'], ['bounty', '7-2 paid']];
const IS = {
  showdown: (h) => h.showdown, allin: (h) => h.allIn, bomb: (h) => h.isBomb, two: (h) => h.doubleBoard,
  straddle: (h) => h.straddle, bounty: (h) => !!h.bounty,
};
export const isShow = (k) => SHOWS.some(([x]) => x === k);

// The kinds of hand to show that these hands have: a kind none of them is stays off the list.
export const showChoices = (all) => SHOWS.filter(([k]) => k === 'all' || all.some(IS[k]));

// How many times the hands were run, once some hand was run more than once.
export function runChoices(all) {
  const counts = [...new Set(all.map((h) => h.runCount || 1))].sort((a, b) => a - b);
  if (!counts.some((n) => n > 1)) return [];
  const word = { 1: 'Once', 2: 'Twice' };
  return [['any', 'Any'], ['more', 'More than once'], ...counts.map((n) => [String(n), word[n] || `${n} times`])];
}
export const isRuns = (k) => k === 'any' || k === 'more' || /^[1-9]$/.test(String(k));

// One hand's key: its number in a game's own history, the game and the number across every game.
export const handKey = (h) => (h.tableId ? `${h.tableId}.${h.handNumber}` : String(h.handNumber));

// v: { session, who, sort, filter, runs, game }. who is a player's id (their result decides wins and
// losses) or empty for everyone (the biggest single win or loss in each hand).
export function pickHands(all, v) {
  let out = all.filter((h) => {
    if (v.session && v.session !== 'all' && h.tableId !== v.session) return false;
    if (v.game && v.game !== 'all' && h.gameType !== v.game) return false;
    if (v.who && h.nets[v.who] === undefined) return false;
    if (v.runs && v.runs !== 'any') {
      const n = h.runCount || 1;
      if (v.runs === 'more' ? n < 2 : n !== Number(v.runs)) return false;
    }
    if (v.filter && v.filter !== 'all' && IS[v.filter] && !IS[v.filter](h)) return false;
    return true;
  });
  const net = (h) => resultOf(h, v.who, v.sort);
  const newer = (a, b) => (b.at || 0) - (a.at || 0) || b.handNumber - a.handNumber;
  if (v.sort === 'old') out.sort((a, b) => newer(b, a));
  else if (v.sort === 'pot') out.sort((a, b) => b.pot - a.pot || newer(a, b));
  else if (v.sort === 'won') out = out.filter((h) => net(h) > 0).sort((a, b) => net(b) - net(a) || newer(a, b));
  else if (v.sort === 'lost') out = out.filter((h) => net(h) < 0).sort((a, b) => net(a) - net(b) || newer(a, b));
  else out.sort(newer);
  return out;
}

// A player's result in a hand; for everyone, the biggest single loss when sorting by losses, else the
// biggest single win.
export function resultOf(h, who, sort) {
  if (who) return h.nets[who];
  const vals = Object.values(h.nets || {});
  return sort === 'lost' ? Math.min(0, ...vals) : Math.max(0, ...vals);
}

// Who won the most in a hand, and how much: [id, amount], or null when nobody won anything.
export function topWinner(h) {
  const [id, amt] = Object.entries(h.nets || {}).sort((a, b) => b[1] - a[1])[0] || [];
  return id && amt > 0 ? [id, amt] : null;
}
