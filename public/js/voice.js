// Voice chat at the table. Audio goes straight between browsers (WebRTC): each person in voice has a
// connection to each other person in it, set up through the table's socket, which also carries who is
// in and who is muted. Whoever joins calls everyone already in, so two pages never call each other at
// once. Muting turns the microphone track off; nothing is renegotiated.
import { app, emit } from './table-core.js';
import { toast } from './ui.js';

export const voice = {
  on: false, joining: false, muted: false,
  speaking: new Set(), // userIds talking right now, this page's own included
};
const V = { stream: null, ice: [], peers: new Map(), who: new Map(), ctx: null, meters: new Map(), loud: new Map(), timer: null, onChange: () => {} };
const SPEAK = 0.03; // loudness that counts as talking
const HOLD_MS = 450; // talking stays lit this long after the last loud moment, so it does not flicker

const changed = () => V.onChange();
const send = (to, data) => emit('voice:signal', { to, data }, { quiet: true });

export function bindVoice(socket, onChange) {
  V.onChange = onChange;
  socket.on('voice:joined', (p) => V.who.set(p.peerId, p.userId));
  socket.on('voice:left', ({ peerId }) => { dropPeer(peerId); changed(); });
  socket.on('voice:signal', ({ from, data }) => onSignal(from, data));
  socket.on('voice:ended', ({ reason }) => { stopAll(); toast(reason || 'You left voice'); changed(); });
}

export async function joinVoice() {
  if (voice.on || voice.joining) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) { toast('This browser cannot do voice chat', 'error'); return; }
  voice.joining = true;
  changed();
  try {
    V.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  } catch (e) {
    voice.joining = false;
    changed();
    toast(e && e.name === 'NotAllowedError' ? 'Allow the microphone for this site to join voice' : 'No microphone could be opened', 'error');
    return;
  }
  try { V.ctx ||= new (window.AudioContext || window.webkitAudioContext)(); V.ctx.resume?.(); } catch { V.ctx = null; }
  voice.muted = false;
  meter('me', V.stream);
  await connect();
  voice.joining = false;
  changed();
}

async function connect() {
  const r = await emit('voice:join', {}, { quiet: true });
  if (!r.ok) { toast(r.error || 'Could not join voice', 'error'); stopAll(); return; }
  voice.on = true;
  V.ice = r.iceServers || [];
  for (const p of r.peers) { V.who.set(p.peerId, p.userId); startPeer(p.peerId, true); }
  if (voice.muted) emit('voice:mute', { muted: true }, { quiet: true });
  if (!V.timer) V.timer = setInterval(listen, 120);
}

// After the page reconnects the server has forgotten its voice: join again with the same microphone.
export function voiceReconnected() {
  if (!voice.on || !V.stream) return;
  for (const id of [...V.peers.keys()]) dropPeer(id);
  voice.on = false;
  connect().then(changed);
}

export function leaveVoice() {
  if (!voice.on && !V.stream) return;
  emit('voice:leave', {}, { quiet: true });
  stopAll();
  changed();
}

export function toggleMute() {
  if (!V.stream) return;
  voice.muted = !voice.muted;
  for (const t of V.stream.getAudioTracks()) t.enabled = !voice.muted;
  emit('voice:mute', { muted: voice.muted }, { quiet: true });
  changed();
}

function stopAll() {
  for (const id of [...V.peers.keys()]) dropPeer(id);
  for (const t of V.stream?.getTracks() || []) t.stop();
  V.stream = null;
  voice.on = false;
  voice.joining = false;
  voice.muted = false;
  clearInterval(V.timer);
  V.timer = null;
  V.meters.clear();
  V.loud.clear();
  voice.speaking = new Set();
  paintVoice();
}

function startPeer(peerId, calling) {
  const pc = new RTCPeerConnection({ iceServers: V.ice });
  const x = { pc, audio: null, pending: [] };
  V.peers.set(peerId, x);
  for (const t of V.stream.getTracks()) pc.addTrack(t, V.stream);
  pc.onicecandidate = (e) => { if (e.candidate) send(peerId, { candidate: e.candidate.toJSON() }); };
  pc.ontrack = (e) => hear(peerId, e.streams[0] || new MediaStream([e.track]));
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && calling) pc.restartIce?.();
    changed();
  };
  if (calling) {
    pc.onnegotiationneeded = async () => {
      try { await pc.setLocalDescription(); send(peerId, { sdp: pc.localDescription.toJSON() }); } catch (e) { console.warn('voice: offer', e); }
    };
  }
  return x;
}

async function onSignal(from, data) {
  if (!voice.on || !V.stream || !data) return;
  const x = V.peers.get(from) || startPeer(from, false);
  const pc = x.pc;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      for (const c of x.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription();
        send(from, { sdp: pc.localDescription.toJSON() });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else x.pending.push(data.candidate);
    }
  } catch (e) { console.warn('voice: signal', e); }
}

function hear(peerId, stream) {
  const x = V.peers.get(peerId);
  if (!x) return;
  if (!x.audio) {
    x.audio = document.createElement('audio');
    x.audio.autoplay = true;
    x.audio.setAttribute('playsinline', '');
    x.audio.className = 'voice-out';
    document.body.appendChild(x.audio);
  }
  x.audio.srcObject = stream;
  x.audio.play().catch(() => toast('Tap anywhere on the table to hear voice'));
  meter(peerId, stream);
}

function dropPeer(peerId) {
  const x = V.peers.get(peerId);
  V.meters.delete(peerId);
  if (!x) return;
  V.peers.delete(peerId);
  try { x.pc.close(); } catch { /* closed already */ }
  if (x.audio) { x.audio.srcObject = null; x.audio.remove(); }
}

// How loud each stream is, to light up whoever is talking.
function meter(key, stream) {
  if (!V.ctx) return;
  try {
    const an = V.ctx.createAnalyser();
    an.fftSize = 512;
    V.ctx.createMediaStreamSource(stream).connect(an);
    V.meters.set(key, { an, buf: new Uint8Array(an.fftSize) });
  } catch { /* the voice still works, just without the light */ }
}

function listen() {
  const now = Date.now();
  for (const [key, m] of V.meters) {
    const uid = key === 'me' ? app.state?.me.userId : V.who.get(key);
    if (!uid || (key === 'me' && voice.muted)) continue;
    m.an.getByteTimeDomainData(m.buf);
    let sum = 0;
    for (const v of m.buf) { const d = (v - 128) / 128; sum += d * d; }
    if (Math.sqrt(sum / m.buf.length) > SPEAK) V.loud.set(uid, now);
  }
  const talking = new Set([...V.loud].filter(([, t]) => now - t < HOLD_MS).map(([uid]) => uid));
  const same = talking.size === voice.speaking.size && [...talking].every((u) => voice.speaking.has(u));
  if (!same) { voice.speaking = talking; paintVoice(); }
}

// Lights the seats of whoever is talking. Called after every redraw of the seats too.
export function paintVoice() {
  for (const el of document.querySelectorAll('.seat[data-uid]')) el.classList.toggle('speaking', voice.speaking.has(el.dataset.uid));
}

// For tests and the connection hint: how each call is doing.
export function voicePeers() {
  return [...V.peers].map(([peerId, x]) => ({ peerId, userId: V.who.get(peerId) || null, state: x.pc.connectionState }));
}

// Audio received from each call so far, in bytes.
export async function voiceStats() {
  const out = [];
  for (const [peerId, x] of V.peers) {
    let bytes = 0;
    try { (await x.pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') bytes += r.bytesReceived || 0; }); } catch { /* closed */ }
    out.push({ peerId, userId: V.who.get(peerId) || null, state: x.pc.connectionState, bytes });
  }
  return out;
}
