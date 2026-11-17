// "Deck seal": a rosette drawn from a SHA-256 commitment so people can compare hashes by eye.
// The same hex string always produces the same seal; a single changed character produces a different one.

function bytesOf(hex) {
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  while (out.length < 32) out.push(0);
  return out;
}

export function sealSVG(hex, size = 28, title = '') {
  if (!hex || !/^[0-9a-f]{16,}$/i.test(hex)) {
    return `<svg class="seal" width="${size}" height="${size}" viewBox="-50 -50 100 100" aria-hidden="true"><circle r="46" fill="none" stroke="#5b4334" stroke-width="3" stroke-dasharray="6 6"/></svg>`;
  }
  const b = bytesOf(hex.toLowerCase());
  const h1 = Math.round((b[0] / 256) * 360);
  const h2 = (h1 + 140 + (b[1] % 80)) % 360;
  const ray = `hsl(${h1} 62% 66%)`;
  const ray2 = `hsl(${h2} 58% 62%)`;
  const ground = `hsl(${h1} 30% 17%)`;
  const ring = `hsl(${h2} 45% 52%)`;
  const n = 24;
  let rays = '';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const v = b[(i % 28) + 2];
    const r0 = 13;
    const r1 = 19 + (v / 255) * 22;
    const x0 = (Math.cos(a) * r0).toFixed(1);
    const y0 = (Math.sin(a) * r0).toFixed(1);
    const x1 = (Math.cos(a) * r1).toFixed(1);
    const y1 = (Math.sin(a) * r1).toFixed(1);
    rays += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${(v >> 7) & 1 ? ray : ray2}" stroke-width="${3 + ((v >> 5) & 3) * 0.6}" stroke-linecap="round"/>`;
  }
  const sides = 5 + (b[30] % 4);
  let pts = '';
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 + (b[31] / 255) * Math.PI;
    pts += `${(Math.cos(a) * 9).toFixed(1)},${(Math.sin(a) * 9).toFixed(1)} `;
  }
  return `<svg class="seal" width="${size}" height="${size}" viewBox="-50 -50 100 100" role="img" aria-label="${title ? title.replace(/"/g, '') : 'Deck seal ' + hex.slice(0, 8)}">
    <circle r="48" fill="${ground}"/>
    <circle r="45" fill="none" stroke="${ring}" stroke-width="2.5" stroke-dasharray="${2 + (b[2] % 5)} ${2 + (b[3] % 4)}"/>
    ${rays}
    <polygon points="${pts.trim()}" fill="${ray}" stroke="${ground}" stroke-width="2"/>
  </svg>`;
}
