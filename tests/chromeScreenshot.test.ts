import { describe, it, expect } from 'vitest';
import { ChromeBrowserService } from '../src/main/chrome/ChromeBrowserService';
import type { BridgeLike } from '../src/main/chrome/ChromeBrowserService';
import { BridgeError } from '../src/main/chrome/ChromeBridge';
import { BrowserUnavailableError } from '../src/main/browser/errors';
import { dataUrl, fakeJpeg, fakePng } from './screenshotFixtures';

function service(reply: (op: string, args: Record<string, unknown>) => unknown, options: ConstructorParameters<typeof ChromeBrowserService>[1] = {}) {
  const seen: Array<{ op: string; args: unknown; timeout: number | undefined }> = [];
  const bridge: BridgeLike = {
    isConnected: () => true,
    request: async <T>(op: string, args: Readonly<Record<string, unknown>> = {}, timeoutMs?: number) => {
      seen.push({ op, args, timeout: timeoutMs });
      return (await Promise.resolve(reply(op, { ...args }))) as T;
    },
  };
  return { svc: new ChromeBrowserService(bridge, options), seen };
}

describe('screenshot through the extension', () => {
  it('asks the browser for a picture and hands back validated bytes with the page it came from', async () => {
    const png = fakePng(1366, 768, 400);
    const { svc, seen } = service(() => ({ tabId: 7, url: 'https://tshc.gov.in/cause?session=SUPERSECRET123456', title: 'Cause List', dataUrl: dataUrl('image/png', png) }), {
      browserName: 'edge',
    });
    const img = await svc.screenshot();
    expect(seen).toEqual([{ op: 'screenshot', args: {}, timeout: 30_000 }]);
    expect(img.bytes.equals(png)).toBe(true);
    expect(img).toMatchObject({ mime: 'image/png', width: 1366, height: 768, title: 'Cause List', environment: 'your_browser', browser: 'edge' });
    expect(img.url).toContain('tshc.gov.in');
    expect(img.url).not.toContain('SUPERSECRET123456'); // credential-looking parts never reach a file name or the model
  });

  it('takes a JPEG too (what the extension sends for a very large page)', async () => {
    const { svc } = service(() => ({ url: 'https://x.example/', title: '', dataUrl: dataUrl('image/jpeg', fakeJpeg(3000, 2000)) }));
    expect(await svc.screenshot()).toMatchObject({ mime: 'image/jpeg', width: 3000, height: 2000 });
  });

  it('refuses a reply that is not a real picture, rather than saving it', async () => {
    for (const reply of [{ dataUrl: 'data:text/html;base64,PGgxPg==' }, { dataUrl: 42 }, {}, null, 'nope', { dataUrl: dataUrl('image/png', Buffer.from('<script>'.padEnd(100))) }]) {
      const { svc } = service(() => reply);
      await expect(svc.screenshot()).rejects.toThrow(/did not return a usable picture/);
    }
  });

  it('an extension from before screenshots existed gets a plain "reload it" message', async () => {
    const { svc } = service(() => {
      throw new BridgeError('extension_error', 'Unknown request: screenshot');
    });
    const err = await svc.screenshot().catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/before screenshots existed/);
    expect((err as Error).message).toMatch(/reload/i);
  });

  it('a page the browser would not photograph (a browser page, a private window) comes through with the extension\'s own words', async () => {
    const { svc } = service(() => {
      throw new BridgeError('extension_error', 'That is a browser page (not a website), and the browser does not let any extension take a picture of it.');
    });
    await expect(svc.screenshot()).rejects.toThrow(/browser page/);
  });

  it('a browser that is gone is reported as unavailable, like every other browser action', async () => {
    const { svc } = service(() => {
      throw new BridgeError('disconnected', 'Your browser disconnected from Eya.');
    }, { unavailableMessage: 'lost her connection' });
    await expect(svc.screenshot()).rejects.toBeInstanceOf(BrowserUnavailableError);
  });

  it('stamps Eya\'s own window as such', async () => {
    const { svc } = service(() => ({ url: 'https://x.example/', title: 'T', dataUrl: dataUrl('image/png', fakePng(800, 600)) }), { environment: 'eya_browser' });
    expect((await svc.screenshot()).environment).toBe('eya_browser');
  });
});
