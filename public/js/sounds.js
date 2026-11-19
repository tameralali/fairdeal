// Table sounds, made in the browser with Web Audio, so there are no sound files to load: a call when
// it is your turn, chips for bets and calls (more of them for a raise or an all-in), a card slid away
// for a fold, two knocks for a check, a flick for each card dealt, and the pot pushed to a winner.
// Browsers only let a page make sound after a tap or a key press on it, so the first one switches
// sound on.
let ctx = null;
let out = null;
let noise = null;

function audio() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  // everything goes through a soft limiter, so sounds that overlap never clip
  const limit = ctx.createDynamicsCompressor();
  limit.threshold.value = -12;
  limit.knee.value = 10;
  limit.ratio.value = 8;
  limit.attack.value = 0.002;
  limit.release.value = 0.12;
  out = ctx.createGain();
  out.gain.value = 0.85;
  out.connect(limit).connect(ctx.destination);
  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

// Called on every tap and key press: starts the sound once the browser allows it.
export function unlockSound() {
  const a = audio();
  if (a && a.state === 'suspended') a.resume().catch(() => {});
}

// A burst of filtered noise: clicks, slides and flicks.
function burst(t, { dur = 0.03, freq = 3000, q = 1.2, gain = 0.2, type = 'bandpass', to = null, attack = 0.002 }) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random() * 0.8, dur + 0.05);
}

// A tone that starts quickly and dies away; drop bends it down, for a knock.
function tone(t, { freq, dur = 0.4, gain = 0.15, type = 'sine', drop = null, attack = 0.004 }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (drop) o.frequency.exponentialRampToValueAtTime(drop, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
}

// One clay chip landing on another: a bright click with a short ring.
function chip(t, level = 1) {
  const f = 2400 + Math.random() * 2800;
  burst(t, { dur: 0.016 + Math.random() * 0.014, freq: f, q: 2.6, gain: 1 * level });
  tone(t, { freq: f * (0.92 + Math.random() * 0.2), dur: 0.04, gain: 0.09 * level, type: 'triangle' });
}

function chips(t, n, spread) {
  let at = t;
  for (let i = 0; i < n; i++) {
    chip(at, Math.max(0.35, 1 - i * (0.6 / n)));
    at += spread * (0.6 + Math.random() * 0.8);
  }
}

const SOUNDS = {
  // your turn: two soft mallet notes going up
  turn(t) {
    [[0, 659.25], [0.14, 987.77]].forEach(([d, f]) => {
      tone(t + d, { freq: f, dur: 0.6, gain: 0.17 });
      tone(t + d, { freq: f * 2, dur: 0.22, gain: 0.035 });
      tone(t + d, { freq: f * 3.9, dur: 0.09, gain: 0.02 });
    });
  },
  // a bet or a call: a few chips into the pot
  chips(t) { chips(t, 3 + Math.floor(Math.random() * 2), 0.04); },
  // a raise or an all-in: a stack pushed in
  bigchips(t) {
    burst(t, { dur: 0.2, freq: 1700, q: 0.7, gain: 0.13, to: 900, attack: 0.03 });
    chips(t + 0.03, 8, 0.03);
  },
  // a fold: the cards slid away across the felt
  fold(t) { burst(t, { dur: 0.3, freq: 2600, q: 0.75, gain: 0.34, to: 650, attack: 0.035 }); },
  // a check: two knocks on the table
  check(t) {
    [0, 0.12].forEach((d) => {
      tone(t + d, { freq: 175, drop: 80, dur: 0.1, gain: 0.34 });
      burst(t + d, { dur: 0.025, freq: 1100, q: 0.7, gain: 0.05, type: 'lowpass' });
    });
  },
  // a card dealt: a quiet flick
  deal(t) { burst(t, { dur: 0.05, freq: 3400, q: 0.9, gain: 0.2, to: 1700, attack: 0.004 }); },
  // the pot pushed to the winner
  win(t) {
    burst(t, { dur: 0.5, freq: 2100, q: 0.6, gain: 0.15, to: 760, attack: 0.06 });
    chips(t + 0.06, 11, 0.035);
  },
  // someone asks the host for a seat or chips
  request(t) {
    tone(t, { freq: 523.25, dur: 0.32, gain: 0.12, type: 'triangle' });
    tone(t + 0.11, { freq: 659.25, dur: 0.38, gain: 0.12, type: 'triangle' });
  },
};

export const SOUND_NAMES = Object.keys(SOUNDS);

// kind: one of SOUND_NAMES; delay: seconds from now
export function playSound(kind, delay = 0) {
  const a = audio();
  if (!a || a.state !== 'running' || !SOUNDS[kind]) return;
  try { SOUNDS[kind](a.currentTime + 0.01 + delay); } catch { /* sound not available */ }
}
