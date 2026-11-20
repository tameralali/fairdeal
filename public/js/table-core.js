// Shared state for the table page modules.
import { fmtMoney, parseMoney, moneyInput } from '/shared/money.js';
import { toast } from './ui.js';
import { GAME_TYPES } from '/shared/cards.js';

export const app = {
  tableId: decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || ''),
  state: null,
  offset: 0,
  socket: null,
  me: null,
  dec: 0,
  logs: [],
  fair: null,
  portrait: false,
  actionKey: null,
  seen: new Set(),
  seenHand: null,
  bubbles: new Map(),
  bubbleTimer: null,
  render: () => {},
};

export function emit(event, payload = {}, { quiet = false } = {}) {
  return new Promise((resolve) => {
    if (!app.socket || !app.socket.connected) {
      if (!quiet) toast('Reconnecting, try again in a moment', 'error');
      resolve({ ok: false });
      return;
    }
    app.socket.timeout(10000).emit(event, payload, (err, ack) => {
      if (err) { if (!quiet) toast('The server did not answer, try again', 'error'); return resolve({ ok: false }); }
      if (ack && !ack.ok && ack.error && !quiet) toast(ack.error, 'error');
      resolve(ack || { ok: false });
    });
  });
}

// at the table amounts keep their cents, as on a chip count: $25.00, $0.50, $1,216.90
// at the table amounts show without the dollar sign, as on PokerNow
export const fmt = (a) => fmtMoney(a, app.dec, 'always', '');
// in ledgers and lists the cents stay ($25.00) so amounts line up
export const fmtC = (a) => fmtMoney(a, app.dec, 'always', '');
export const parse = (v) => parseMoney(v, app.dec);
export const inp = (a) => moneyInput(a, app.dec);
export const gameShort = (g) => GAME_TYPES[g]?.short || g;
export const gameName = (g) => GAME_TYPES[g]?.name || g;
export const now = () => Date.now() + app.offset;
