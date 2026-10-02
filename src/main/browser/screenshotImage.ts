/**
 * Turning what the browser hands back for a screenshot into bytes Eya can trust and name — pure, so it is easy to test.
 *
 * The extension sends a data: URL. Nothing is taken on faith: it must be a PNG or JPEG data URL, the bytes must really
 * start like one (a page cannot make Eya write something else to the Desktop under an image name), and the size must be
 * sensible.
 */

export interface DecodedImage {
  readonly bytes: Buffer;
  readonly mime: 'image/png' | 'image/jpeg';
  readonly width?: number;
  readonly height?: number;
}

const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MIN_IMAGE_BYTES = 64;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(bytes: Buffer): { width: number; height: number } | null {
  // IHDR: 8-byte signature, 4-byte length, "IHDR", then width and height as big-endian 32-bit integers.
  if (bytes.length < 24 || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 && width < 100_000 && height < 100_000 ? { width, height } : null;
}

function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  // Walk the segments to the first start-of-frame marker, which carries the dimensions.
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] as number;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = bytes.readUInt16BE(i + 5);
      const width = bytes.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return null;
}

/** Null when the value is not a real PNG/JPEG data URL of a believable size. */
export function decodeImageDataUrl(raw: unknown): DecodedImage | null {
  if (typeof raw !== 'string') return null;
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
  if (m === null) return null;
  const bytes = Buffer.from(m[2] as string, 'base64');
  if (bytes.length < MIN_IMAGE_BYTES || bytes.length > MAX_IMAGE_BYTES) return null;
  if (m[1] === 'png') {
    if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) return null;
    return { bytes, mime: 'image/png', ...(pngSize(bytes) ?? {}) };
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  return { bytes, mime: 'image/jpeg', ...(jpegSize(bytes) ?? {}) };
}

export function extensionFor(mime: 'image/png' | 'image/jpeg'): '.png' | '.jpg' {
  return mime === 'image/png' ? '.png' : '.jpg';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "2026-10-02 21.45.10" — no colons, which Windows does not allow in a file name. */
export function timestampForFileName(when: Date): string {
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}.${pad(when.getMinutes())}.${pad(when.getSeconds())}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** The name given when the user did not choose one: the site and the moment, e.g. "Screenshot - tshc.gov.in - 2026-10-02 21.45.10.png". */
export function defaultScreenshotName(url: string, when: Date, mime: 'image/png' | 'image/jpeg'): string {
  const host = hostOf(url).replace(/[^a-z0-9.-]/g, '');
  return `Screenshot - ${host !== '' ? host : 'web page'} - ${timestampForFileName(when)}${extensionFor(mime)}`;
}

/** A window title made safe to put in a file name (Windows forbids < > : " / \ | ? * and control characters). */
export function safeNameLabel(text: string, limit = 60): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ');
  return cleaned.replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '').slice(0, limit).replace(/[. ]+$/g, '');
}

/** "Screenshot 2026-10-02 21.45.10.png" for the screen, "Screenshot - Notepad - 2026-10-02 21.45.10.png" for a named window. */
export function labelledScreenshotName(label: string, when: Date, mime: 'image/png' | 'image/jpeg'): string {
  const safe = safeNameLabel(label);
  return safe === '' ? `Screenshot ${timestampForFileName(when)}${extensionFor(mime)}` : `Screenshot - ${safe} - ${timestampForFileName(when)}${extensionFor(mime)}`;
}

/** A name the user (or the model for them) asked for, without a directory, and with the right extension on it. */
export function customScreenshotName(requested: string, mime: 'image/png' | 'image/jpeg'): string {
  const stem = requested.trim().replace(/\.(png|jpe?g)$/i, '').trim();
  return `${stem}${extensionFor(mime)}`;
}

/** "name.png" -> "name (2).png": a screenshot never overwrites a file that is already there. */
export function withCounter(fileName: string, n: number): string {
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 ? `${fileName} (${n})` : `${fileName.slice(0, dot)} (${n})${fileName.slice(dot)}`;
}
