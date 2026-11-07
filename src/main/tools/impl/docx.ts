import { inflateRawSync } from 'node:zlib';

/**
 * The text of a Word document (.docx), taken out on this PC: a .docx is a zip file, and the words are in word/document.xml. Needs no Word and no
 * library. Returns null when the file is not a readable .docx (damaged, encrypted, or not a zip at all). The text is cut at MAX_CHARS.
 */
const MAX_CHARS = 200_000;
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function readZipEntry(zip: Buffer, wanted: string): Buffer | null {
  // The end-of-central-directory record is within the last 64 KB.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_536); i -= 1) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n += 1) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== CENTRAL) return null;
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    const localAt = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLength);
    if (name === wanted) {
      if (localAt + 30 > zip.length || zip.readUInt32LE(localAt) !== LOCAL) return null;
      const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
      const data = zip.subarray(dataAt, dataAt + compressed);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    p += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function docxText(file: Buffer): string | null {
  try {
    const xml = readZipEntry(file, 'word/document.xml');
    if (xml === null) return null;
    const text = decodeEntities(
      xml
        .toString('utf8')
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<w:(?:br|cr)\/>/g, '\n')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<\/w:tc>/g, '\t')
        .replace(/<[^>]+>/g, ''),
    );
    return text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, MAX_CHARS);
  } catch {
    return null;
  }
}
