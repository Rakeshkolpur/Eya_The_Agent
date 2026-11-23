import { describe, it, expect } from 'vitest';
import { customScreenshotName, decodeImageDataUrl, defaultScreenshotName, extensionFor, timestampForFileName, withCounter } from '../src/main/browser/screenshotImage';

import { dataUrl as url, fakeJpeg, fakePng } from './screenshotFixtures';

describe('decoding what the browser hands back', () => {
  it('accepts a PNG data URL and reads its size', () => {
    const img = decodeImageDataUrl(url('image/png', fakePng(1280, 720)));
    expect(img).not.toBeNull();
    expect(img).toMatchObject({ mime: 'image/png', width: 1280, height: 720 });
    expect(img!.bytes.length).toBe(96);
  });

  it('accepts a JPEG data URL (the fallback for a very large page) and reads its size', () => {
    expect(decodeImageDataUrl(url('image/jpeg', fakeJpeg(1920, 1080)))).toMatchObject({ mime: 'image/jpeg', width: 1920, height: 1080 });
  });

  it('still accepts a valid image whose size it cannot read, just without dimensions', () => {
    const b = fakePng(10, 10);
    b.write('XXXX', 12, 'ascii'); // no IHDR where it should be
    const img = decodeImageDataUrl(url('image/png', b));
    expect(img).not.toBeNull();
    expect(img!.width).toBeUndefined();
  });

  it('refuses anything that is not really a PNG or JPEG — a page cannot make Eya save something else under an image name', () => {
    expect(decodeImageDataUrl(url('image/png', Buffer.from('<html><script>alert(1)</script></html>'.padEnd(100, ' '))))).toBeNull(); // wrong magic
    expect(decodeImageDataUrl(url('image/jpeg', fakePng(10, 10)))).toBeNull(); // PNG bytes under a JPEG label
    expect(decodeImageDataUrl(url('image/png', fakeJpeg(10, 10)))).toBeNull(); // and the other way round
    expect(decodeImageDataUrl(url('image/svg+xml', Buffer.from('<svg></svg>'.padEnd(100, ' '))))).toBeNull();
    expect(decodeImageDataUrl(url('image/gif', fakePng(10, 10)))).toBeNull();
    expect(decodeImageDataUrl(`data:image/png;base64,${'not base64 !!'}`)).toBeNull();
    expect(decodeImageDataUrl('https://example.com/a.png')).toBeNull();
    expect(decodeImageDataUrl('data:text/html;base64,PGh0bWw+')).toBeNull();
    expect(decodeImageDataUrl(undefined)).toBeNull();
    expect(decodeImageDataUrl(42)).toBeNull();
    expect(decodeImageDataUrl('')).toBeNull();
  });

  it('refuses an image that is far too small to be a picture, and one that is absurdly large', () => {
    expect(decodeImageDataUrl(url('image/png', fakePng(10, 10, 30)))).toBeNull();
    const huge = fakePng(10, 10, 41 * 1024 * 1024);
    expect(decodeImageDataUrl(url('image/png', huge))).toBeNull();
  });

  it('ignores a nonsense size rather than trusting it', () => {
    const img = decodeImageDataUrl(url('image/png', fakePng(0, 5)));
    expect(img).not.toBeNull();
    expect(img!.width).toBeUndefined();
    expect(decodeImageDataUrl(url('image/png', fakePng(400_000, 5)))!.width).toBeUndefined();
  });
});

describe('naming the file', () => {
  const when = new Date(2026, 9, 2, 21, 5, 7); // 2 Oct 2026, 21:05:07 local

  it('zero-pads the time and uses no colons (Windows does not allow them)', () => {
    expect(timestampForFileName(when)).toBe('2026-10-02 21.05.07');
    expect(timestampForFileName(new Date(2026, 0, 3, 4, 5, 6))).toBe('2026-01-03 04.05.06');
  });

  it('names a screenshot after the site and the moment', () => {
    expect(defaultScreenshotName('https://www.tshc.gov.in/some/path?x=1', when, 'image/png')).toBe('Screenshot - tshc.gov.in - 2026-10-02 21.05.07.png');
    expect(defaultScreenshotName('https://Example.COM/', when, 'image/jpeg')).toBe('Screenshot - example.com - 2026-10-02 21.05.07.jpg');
  });

  it('has a sensible name when the address is missing or odd, and never lets address characters into it', () => {
    expect(defaultScreenshotName('', when, 'image/png')).toBe('Screenshot - web page - 2026-10-02 21.05.07.png');
    expect(defaultScreenshotName('not a url', when, 'image/png')).toBe('Screenshot - web page - 2026-10-02 21.05.07.png');
    const name = defaultScreenshotName('https://evil.example/..%5C..%5Cx', when, 'image/png');
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('puts the right extension on a name the user asked for, once', () => {
    expect(customScreenshotName('Cause list', 'image/png')).toBe('Cause list.png');
    expect(customScreenshotName('Cause list.png', 'image/png')).toBe('Cause list.png');
    expect(customScreenshotName('cause list.JPG', 'image/png')).toBe('cause list.png');
    expect(customScreenshotName('  spaced  ', 'image/jpeg')).toBe('spaced.jpg');
    expect(extensionFor('image/png')).toBe('.png');
    expect(extensionFor('image/jpeg')).toBe('.jpg');
  });

  it('adds a counter before the extension so nothing is overwritten', () => {
    expect(withCounter('shot.png', 2)).toBe('shot (2).png');
    expect(withCounter('a.b.png', 3)).toBe('a.b (3).png');
    expect(withCounter('noext', 2)).toBe('noext (2)');
  });
});
