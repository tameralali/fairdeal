// Shared state for the table page modules.
import { fmtChips, parseChips, toInput } from './api.js';
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

export const fmt = (a) => fmtChips(a, app.dec);
export const parse = (v) => parseChips(v, app.dec);
export const inp = (a) => toInput(a, app.dec);
export const gameShort = (g) => GAME_TYPES[g]?.short || g;
export const gameName = (g) => GAME_TYPES[g]?.name || g;
export const now = () => Date.now() + app.offset;
