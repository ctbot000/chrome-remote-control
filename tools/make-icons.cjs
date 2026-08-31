#!/usr/bin/env node
'use strict';
// Draws the extension icons (a "no entry" mark on a rounded blue tile) so the
// repository carries no binary blobs that cannot be regenerated.
//   node tools/make-icons.js

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor, for cheap anti-aliasing
const BG = [47, 109, 246];
const FG = [255, 255, 255];

function roundedRect(x, y, size, radius) {
  const rx = Math.min(Math.max(x, radius), size - radius);
  const ry = Math.min(Math.max(y, radius), size - radius);
  return (x - rx) ** 2 + (y - ry) ** 2 <= radius ** 2;
}

function draw(size) {
  const n = size * SS;
  const acc = new Float64Array(n * n * 4);
  const c = n / 2;
  const ringOuter = n * 0.33;
  const ringInner = n * 0.235;
  const barHalf = n * 0.052;

  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const i = (y * n + x) * 4;
      if (!roundedRect(x, y, n, n * 0.22)) continue;
      acc[i] = BG[0];
      acc[i + 1] = BG[1];
      acc[i + 2] = BG[2];
      acc[i + 3] = 255;

      const dx = x - c;
      const dy = y - c;
      const dist = Math.hypot(dx, dy);
      const onRing = dist <= ringOuter && dist >= ringInner;
      // Distance to the 45-degree line through the centre.
      const onBar = Math.abs(dx + dy) / Math.SQRT2 <= barHalf && dist <= ringOuter;
      if (onRing || onBar) {
        acc[i] = FG[0];
        acc[i + 1] = FG[1];
        acc[i + 2] = FG[2];
        acc[i + 3] = 255;
      }
    }
  }

  // Box-downsample back to the requested size.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * n + (x * SS + sx)) * 4;
          const alpha = acc[i + 3] / 255;
          r += acc[i] * alpha;
          g += acc[i + 1] * alpha;
          b += acc[i + 2] * alpha;
          a += acc[i + 3];
        }
      }
      const samples = SS * SS;
      const alphaAvg = a / samples;
      const weight = alphaAvg > 0 ? a / 255 : 1;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / weight);
      out[o + 1] = Math.round(g / weight);
      out[o + 2] = Math.round(b / weight);
      out[o + 3] = Math.round(alphaAvg);
    }
  }
  return out;
}

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(draw(size), size));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
