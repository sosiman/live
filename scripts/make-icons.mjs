#!/usr/bin/env node
/** Iconos PNG de la PWA sin dependencias (codificador PNG mínimo con zlib). */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const CREAM = hex('#FFF9EE'), BUTTER = hex('#FFF1C7'), ORANGE = hex('#FF8A4D'), PEACH = hex('#FDA079'), LILAC = hex('#CDADEB');
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function pintar(size, maskable, pad) {
  const px = Buffer.alloc(size * size * 4), c = size / 2, orbR = size * (0.5 - pad), radius = maskable ? 0 : size * 0.22;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, dx = x - c, dy = y - c, d = Math.hypot(dx, dy);
    let col = CREAM.slice(), alpha = 255;
    if (!maskable) {
      const qx = Math.max(Math.abs(dx) - (size / 2 - radius), 0), qy = Math.max(Math.abs(dy) - (size / 2 - radius), 0);
      const dq = Math.hypot(qx, qy);
      if (dq > radius) alpha = 0; else if (dq > radius - 1.5) alpha = Math.round(255 * clamp(radius - dq));
    }
    const lilac = clamp(1 - Math.hypot(x - size * 0.78, y - size * 0.72) / (size * 0.42)) * 0.55;
    if (lilac > 0) col = mix(col, LILAC, lilac);
    const t = clamp((dx * 0.5 + dy * 0.85) / (orbR * 2) + 0.5);
    const orb = t < 0.55 ? mix(BUTTER, ORANGE, t / 0.55) : mix(ORANGE, PEACH, (t - 0.55) / 0.45);
    const edge = clamp((orbR - d) / (size * 0.02));
    if (edge > 0) col = mix(col, orb, edge);
    const glow = clamp(1 - Math.hypot(x - size * 0.36, y - size * 0.28) / (size * 0.3)) * 0.35 * edge;
    if (glow > 0) col = mix(col, [255, 255, 255], glow);
    px[i] = Math.round(col[0]); px[i + 1] = Math.round(col[1]); px[i + 2] = Math.round(col[2]); px[i + 3] = alpha;
  }
  return png(size, px);
}
fs.mkdirSync(OUT, { recursive: true });
for (const [name, size, maskable, pad] of [['icon-192.png', 192, false, 0.20], ['icon-512.png', 512, false, 0.20], ['maskable-512.png', 512, true, 0.26], ['apple-touch-icon.png', 180, true, 0.22], ['favicon-32.png', 32, false, 0.14]]) {
  fs.writeFileSync(path.join(OUT, name), pintar(size, maskable, pad));
  console.log('· icons/' + name);
}
