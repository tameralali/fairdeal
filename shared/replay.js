// Turns a stored hand record into replayer steps: the blinds, every action, each street and run as it
// was dealt, and the result. Each step is a full picture of the table at that moment, so the replayer
// can jump to any step. Cards are shown as the hand history shows them: whatever the record holds for
// this viewer (their own cards, cards shown at showdown, and every card once the seed is revealed).

const STREET_CARDS = { preflop: 0, flop: 3, turn: 4, river: 5 };
const STREETS = ['flop', 'turn', 'river'];
const LABEL = { fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise' };

export function canReplay(rec) {
  return !!rec && Array.isArray(rec.actions) && Array.isArray(rec.posts);
}

// fmt formats an amount for the text of each step.
export function buildReplay(rec, fmt = (a) => String(a)) {
  const boards = rec.dealt?.boards || [];
  const bpr = rec.dealt?.boardsPerRun || 1;
  const nb = boards.length;
  const runs = Math.max(1, Math.round(nb / bpr));
  const shared = rec.dealt?.sharedCount ?? (boards[0]?.length || 0);
  const holes = rec.dealt?.holes || {};
  const ps = rec.players.slice().sort((a, b) => a.seat - b.seat).map((p) => ({
    seat: p.seat, id: p.userId || p.id, name: p.name, stack: p.startStack, bet: 0, folded: false, allIn: false,
    cards: holes[p.seat] || null, tag: '', won: 0,
  }));
  const byId = new Map(ps.map((p) => [p.id, p]));
  let collected = 0;
  let street = 'preflop';
  let shown = 0; // cards showing on each board of the first run
  // cards showing on each board; a later run's boards stay off the table until that run is dealt
  const cut = boards.map(() => 0);
  const steps = [];
  const cuts = (all) => boards.map((b, i) => (all ? b.length : Math.min(cut[i], b.length)));
  const snap = (text, extra = {}) => steps.push({
    text, street, cuts: cuts(extra.final), pot: collected + ps.reduce((s, p) => s + p.bet, 0), actor: null, final: false,
    players: ps.map((p) => ({ ...p })), ...extra,
  });
  const collect = () => {
    for (const p of ps) {
      collected += p.bet;
      p.bet = 0;
      if (!p.folded && !p.allIn) p.tag = '';
    }
  };
  const newCards = (b, name) => boards[b].slice(name === 'flop' ? 0 : STREET_CARDS[name] - 1, STREET_CARDS[name]);
  const deal = (name) => {
    collect();
    street = name;
    shown = Math.max(shown, STREET_CARDS[name]);
    for (let b = 0; b < bpr; b++) cut[b] = shown;
    snap(`${name[0].toUpperCase()}${name.slice(1)}${bpr > 1 ? '' : `: ${newCards(0, name).join(' ')}`}`, { dealt: name });
  };

  // blinds or bomb pot antes
  const posts = rec.posts || [];
  for (const x of posts) {
    const p = byId.get(x.id);
    if (!p) continue;
    p.stack -= x.amt;
    if (x.a === 'ante') collected += x.amt;
    else p.bet += x.amt;
    if (x.allIn) { p.allIn = true; p.tag = 'All-in'; }
  }
  const name = (id) => byId.get(id)?.name || 'Someone';
  if (rec.isBomb) {
    const amt = posts[0]?.amt ?? rec.bombAnte;
    snap(`Bomb pot: everyone antes ${fmt(amt)}`);
  } else {
    const sb = posts.find((x) => x.a === 'sb');
    const bb = posts.find((x) => x.a === 'bb');
    const st = posts.find((x) => x.a === 'st');
    snap([sb && `${name(sb.id)} posts the small blind ${fmt(sb.amt)}`, bb && `${name(bb.id)} posts the big blind ${fmt(bb.amt)}`, st && `${name(st.id)} straddles ${fmt(st.amt + (sb && sb.id === st.id ? sb.amt : 0))}`].filter(Boolean).join(', '));
  }

  for (const x of rec.actions || []) {
    if (x.s !== street) {
      // streets with no betting before this one (a bomb pot starts on the flop)
      for (const s of STREETS.slice(0, STREETS.indexOf(x.s) + 1)) if (STREET_CARDS[s] > shown) deal(s);
    }
    const p = byId.get(x.id);
    if (!p) continue;
    let text = `${p.name} ${x.a === 'fold' ? 'folds' : x.a === 'check' ? 'checks' : x.a === 'call' ? `calls ${fmt(x.to)}` : x.a === 'bet' ? `bets ${fmt(x.to)}` : `raises to ${fmt(x.to)}`}`;
    if (x.a === 'call' || x.a === 'bet' || x.a === 'raise') {
      p.stack -= x.to - p.bet;
      p.bet = x.to;
    }
    if (x.a === 'fold') p.folded = true;
    if (x.allIn) { p.allIn = true; text += ' and is all in'; }
    p.tag = p.allIn ? 'All-in' : LABEL[x.a] || '';
    snap(text, { actor: p.seat });
  }

  // the rest of the board when the hand went to a showdown
  const res = rec.results || {};
  if (!res.uncontested) {
    if (runs <= 1) {
      for (const s of STREETS) if (STREET_CARDS[s] > shown && STREET_CARDS[s] <= (boards[0]?.length || 0)) deal(s);
    } else {
      for (const s of STREETS) if (STREET_CARDS[s] > shown && STREET_CARDS[s] <= shared) deal(s);
      collect();
      // each run is dealt street by street, one run after another; the first street of a run marks it
      for (let r = 0; r < runs; r++) {
        const own = Array.from({ length: bpr }, (_, k) => r * bpr + k);
        for (const b of own) cut[b] = Math.max(cut[b], shared);
        let first = true;
        for (const st of STREETS) {
          if (STREET_CARDS[st] <= shared || STREET_CARDS[st] > (boards[own[0]]?.length || 0)) continue;
          for (const b of own) cut[b] = STREET_CARDS[st];
          street = st;
          snap(`Run ${r + 1} of ${runs}, ${st}${bpr > 1 ? '' : `: ${newCards(own[0], st).join(' ')}`}`, { dealt: first ? 'run' : st, run: r });
          first = false;
        }
      }
      shown = boards[0]?.length || shown;
    }
  }

  // the result
  collect();
  const won = new Map();
  for (const w of res.payouts || []) won.set(w.id, (won.get(w.id) || 0) + w.amount);
  const end = new Map(rec.players.map((p) => [p.userId || p.id, p.endStack]));
  for (const p of ps) {
    p.stack = end.get(p.id) ?? p.stack;
    p.won = won.get(p.id) || 0;
    p.tag = p.won ? `+${fmt(p.won)}` : p.folded ? 'Fold' : p.tag;
  }
  street = 'done';
  shown = Math.max(shown, boards[0]?.length || 0);
  steps.push({
    text: resultText(rec, fmt), street, cuts: cuts(true), pot: (res.pots || []).reduce((s, p) => s + p.amount, 0), actor: null, final: true,
    players: ps.map((p) => ({ ...p })), winners: [...won.keys()].map((id) => byId.get(id)?.seat).filter((x) => x !== undefined),
  });
  return { steps, boards, bpr, runs };
}

// One line per winner: what they won and, at a showdown, with what.
export function resultText(rec, fmt = (a) => String(a)) {
  const res = rec.results || {};
  if (res.uncontested) {
    const w = (res.payouts || [])[0];
    return w ? `${w.name} wins ${fmt(w.amount)}` : 'Hand over';
  }
  const tot = new Map();
  for (const pot of res.pots || []) {
    for (const run of pot.runs || []) {
      for (const w of run.winners || []) {
        const t = tot.get(w.seat) || { name: w.name, amount: 0, hands: new Set() };
        t.amount += w.amount;
        if (w.hand) t.hands.add(w.hand);
        tot.set(w.seat, t);
      }
    }
  }
  const list = [...tot.values()].sort((a, b) => b.amount - a.amount);
  return list.map((t) => `${t.name} wins ${fmt(t.amount)}${t.hands.size === 1 ? ` with ${[...t.hands][0]}` : ''}`).join(', ') || 'Hand over';
}
