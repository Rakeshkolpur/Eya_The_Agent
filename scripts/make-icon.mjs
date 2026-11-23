// Makes build/icon.ico (the installer's and the .exe's icon) from the same drawing the tray and the bubble use, so there is one source of
// truth for how Eya looks and no picture file to lose. Run by `npm run dist`; safe to run any time:  node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { iconBitmap } from '../src/main/windows/iconBitmap.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};

/** A PNG of the orb at `size` pixels (the drawing gives BGRA; a PNG wants RGBA). */
function png(size) {
  const bgra = iconBitmap(size);
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0, then pixels
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      row.set([bgra[at + 2], bgra[at + 1], bgra[at], bgra[at + 3]], 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const images = SIZES.map((size) => ({ size, data: png(size) }));
const head = Buffer.alloc(6);
head.writeUInt16LE(1, 2); // type: icon
head.writeUInt16LE(images.length, 4);
let offset = 6 + images.length * 16;
const entries = images.map(({ size, data }) => {
  const e = Buffer.alloc(16);
  e[0] = size >= 256 ? 0 : size; // 0 means 256
  e[1] = size >= 256 ? 0 : size;
  e.writeUInt16LE(1, 4); // colour planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  return e;
});

const out = join(here, '..', 'build');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'icon.ico'), Buffer.concat([head, ...entries, ...images.map((i) => i.data)]));
writeFileSync(join(out, 'icon.png'), images[images.length - 1].data); // 256 px, for anything that wants a PNG
console.log(`wrote build/icon.ico (${SIZES.join(', ')} px) and build/icon.png`);
