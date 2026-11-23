const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A byte string that starts like a real PNG (signature + IHDR with the given size), padded past the minimum size. */
export function fakePng(width: number, height: number, size = 96): Buffer {
  const b = Buffer.alloc(size);
  PNG_MAGIC.copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** A byte string shaped like a JPEG: SOI, an APP0 segment, then a start-of-frame marker carrying the size. */
export function fakeJpeg(width: number, height: number, size = 96): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xe0;
  b.writeUInt16BE(16, 4);
  b.write('JFIF', 6, 'ascii');
  const sof = 20;
  b[sof] = 0xff;
  b[sof + 1] = 0xc0;
  b.writeUInt16BE(17, sof + 2);
  b[sof + 4] = 8;
  b.writeUInt16BE(height, sof + 5);
  b.writeUInt16BE(width, sof + 7);
  return b;
}

export const dataUrl = (mime: string, b: Buffer): string => `data:${mime};base64,${b.toString('base64')}`;
