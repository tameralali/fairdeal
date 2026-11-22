// A game's hand history and replayer in a tab of its own, opened from Open in new tab or from the
// game's summary page. It has no seat, sounds or chat, and it does not join the table: the hands come
// from plain requests. While the game runs it looks for new hands every so often, and as soon as the
// tab is looked at again. /hands, with no game, is the history of every hand of every game of the
// club (hand-history.js looks for new hands there itself).
import { api, ensureIdentity } from './api.js';
import { esc } from './ui.js';
import { applyPrefs } from './cards.js';
import { FairClient } from './fair-client.js';
import { app } from './table-core.js';
import { historyDialog, historyRefresh } from './hand-history.js';

applyPrefs();
const LOOK_EVERY = 12000;
const id = app.tableId;
const tablePath = (p = '') => `/api/tables/${encodeURIComponent(id)}${p}`;

function fatal(msg) {
  document.body.innerHTML = `<div style="display:grid;place-items:center;height:100dvh;padding:24px;text-align:center"><div><h2>${esc(msg)}</h2><p><a href="/">Back to the club</a></p></div></div>`;
}

// The hand history asks for hands the way the table page does, over its connection; here each ask is
// a request instead.
function requestsAsSocket() {
  const answer = (event, payload) => {
    if (event === 'hands:list') return api.get(tablePath('/hands'));
    if (event === 'hand:get') return api.get(tablePath(`/hands/${encodeURIComponent(payload.handNumber)}`));
    return Promise.reject(new Error('Open the table for that'));
  };
  return {
    connected: true,
    timeout: () => ({
      emit: (event, payload, cb) => {
        answer(event, payload || {}).then((r) => cb(null, { ok: true, ...r }), (e) => cb(null, { ok: false, error: e.message }));
      },
    }),
  };
}

function headActions(t) {
  return t.status === 'ended'
    ? `<a class="btn small" href="/g/${encodeURIComponent(id)}">Game summary</a>`
    : `<a class="btn small primary" href="/t/${encodeURIComponent(id)}">Go to the table</a>`;
}

// every hand of every game: the club's list, each hand drawn as its own game
async function everyGame() {
  let me;
  try { me = await ensureIdentity(); } catch (e) { fatal(e.message); return; }
  if (!me.clubId) { fatal('The club is not set up yet'); return; }
  app.me = me.user;
  app.dec = 2;
  app.state = { me: { userId: me.user.id }, table: { id: '', name: 'every game', status: 'ended', settings: {}, clubName: 'The Aquarium' } };
  document.title = 'Hand history, every game | The Aquarium';
  document.querySelector('.hands-loading')?.remove();
  const q = new URLSearchParams(location.search);
  await historyDialog({
    start: q.get('hand'), step: Number(q.get('step')) || 0, view: q.get('view'), who: q.get('who'), sort: q.get('sort'),
    filter: q.get('show'), runs: q.get('runs'), game: q.get('game'), session: q.get('session'),
    club: { id: me.clubId }, page: { actions: '<a class="btn small" href="/">Back to the club</a>' },
  });
}

async function main() {
  if (!id || id === 'hands') { everyGame(); return; }
  let me;
  let t;
  try {
    me = await ensureIdentity();
    t = await api.get(tablePath());
  } catch (e) { fatal(e.message); return; }
  app.me = me.user;
  app.dec = t.decimals || 0;
  app.socket = requestsAsSocket();
  app.fair = new FairClient(id, async () => ({ ok: false }), null);
  app.state = { me: { userId: me.user.id }, table: { id, name: t.name, status: t.status, settings: { feltColor: t.feltColor }, clubName: 'The Aquarium' } };
  document.title = `Hand history, ${t.name} | The Aquarium`;
  document.querySelector('.hands-loading')?.remove();
  const q = new URLSearchParams(location.search);
  const num = (k) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : null);
  await historyDialog({
    start: num('hand'), step: num('step') || 0, view: q.get('view'), who: q.get('who'), sort: q.get('sort'), filter: q.get('show'), runs: q.get('runs'), game: q.get('game'),
    page: { actions: headActions(t) },
  });

  // new hands of a running game join the list
  let last = `${t.status}:${t.handNumber}`;
  const look = async () => {
    if (document.visibilityState !== 'visible' || app.state.table.status === 'ended') return;
    try {
      const x = await api.get(tablePath());
      const key = `${x.status}:${x.handNumber}`;
      if (key === last) return;
      last = key;
      app.state.table.status = x.status;
      historyRefresh();
    } catch { /* try again next time */ }
  };
  setInterval(look, LOOK_EVERY);
  document.addEventListener('visibilitychange', look);
}

main();
