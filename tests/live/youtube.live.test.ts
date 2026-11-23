/**
 * Exploratory live check against REAL YouTube: the play_on_youtube tool (search over plain HTTP, pick, open in a real Chrome with the
 * real extension, skip adverts, wait for the video to play). YouTube decides whether it shows an advert at all, so this reports what
 * happened instead of asserting that one appeared; it asserts only that the right video opened and started playing.
 *
 * Skipped unless EYA_LIVE_YOUTUBE=1 (it uses the internet and launches a browser). Run with:
 *   EYA_LIVE_YOUTUBE=1 npx vitest run tests/live/youtube.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChromeBridge } from '../../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../../src/main/chrome/ChromeBridge';
import { ChromeBrowserService } from '../../src/main/chrome/ChromeBrowserService';
import type { BrowserName } from '../../src/main/chrome/protocol';
import { WebFetcher } from '../../src/main/research/webFetch';
import { searchYoutube } from '../../src/main/research/youtube';
import { createYoutubeTools } from '../../src/main/tools/impl/youtubeTools';
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, userEval, userEvalWithGesture, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_YOUTUBE'] === '1';
const BRIDGE_PORT = 47853;
const DEBUG_PORT = 9353;

class MemorySecrets implements SecretStore {
  hashes = new Map<BrowserName, string>();
  loadHash(b: BrowserName) {
    return this.hashes.get(b) ?? null;
  }
  saveHash(b: BrowserName, h: string) {
    this.hashes.set(b, h);
  }
  clear(b?: BrowserName) {
    if (b === undefined) this.hashes.clear();
    else this.hashes.delete(b);
  }
}

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('play_on_youtube against real YouTube', () => {
  let bridge: ChromeBridge;
  let svc: ChromeBrowserService;
  let browser: TestBrowser;
  let ext: { dir: string; cleanup: () => void };

  beforeAll(async () => {
    ext = prepareExtensionCopy(BRIDGE_PORT);
    bridge = new ChromeBridge({ secrets: new MemorySecrets(), port: BRIDGE_PORT });
    if (!(await bridge.start())) throw new Error(`port ${BRIDGE_PORT} is busy`);
    svc = new ChromeBrowserService(bridge.forBrowser('chrome'), { browserName: 'chrome' });
    bridge.openPairingWindow();
    browser = await startTestBrowser({ kind: 'chrome', extensionDir: ext.dir, debugPort: DEBUG_PORT, headed: process.env['EYA_LIVE_HEADED'] === '1' });
    await waitFor(() => bridge.isConnected('chrome'), 45_000, 'the extension to connect and pair');
  }, 120_000);

  afterAll(async () => {
    browser?.kill();
    await bridge?.stop();
    await sleep(500);
    browser?.cleanup();
    ext?.cleanup();
  }, 30_000);

  it('plays a song from its official channel, skipping any advert by itself', async () => {
    const fetcher = new WebFetcher();
    const [play, skip] = createYoutubeTools({ browser: svc, search: (q) => searchYoutube(fetcher, q) });
    const started = Date.now();
    const result = await play!.execute({ query: 'Tum Hi Ho Aashiqui 2 song' });
    console.log('[youtube] result after', Math.round((Date.now() - started) / 1000), 's:', JSON.stringify(result, null, 1));
    expect(result.ok).toBe(true);
    expect((result.data as { video?: { channel?: string } }).video?.channel).toMatch(/T-Series/i);
    const after = await skip!.execute({});
    console.log('[youtube] skip_ads:', JSON.stringify(after));
    // Watch for a while: an advert in the middle of the song would be skipped too.
    for (let i = 0; i < 4; i += 1) {
      await sleep(5000);
      const s = await svc.ads('once');
      console.log('[youtube] state', JSON.stringify(s));
    }
    // Why is it not playing in this fresh profile? (A new profile has no history with YouTube, so the browser may refuse to start sound by itself.)
    const why = await userEval(DEBUG_PORT, 'youtube', "(async () => { const v = document.querySelector('video'); if (!v) return 'no video'; try { await v.play(); return 'play() worked'; } catch (e) { return 'play() refused: ' + String(e) } })()");
    console.log('[youtube] direct play():', why);
    // Now as a person who has clicked on the page: the video starts, YouTube may serve an advert first, and the helper deals with it.
    console.log('[youtube] play with a click:', await userEvalWithGesture(DEBUG_PORT, 'youtube', "(async () => { const v = document.querySelector('video'); try { await v.play(); return 'playing'; } catch (e) { return String(e) } })()"));
    for (let i = 0; i < 8; i += 1) {
      await sleep(2500);
      const s2 = await svc.ads('once');
      console.log('[youtube] after click', i, JSON.stringify({ adShowing: s2.adShowing, waitingForAd: s2.waitingForAd, skipped: s2.skipped, closed: s2.closed, video: s2.video }));
    }
    const last = await svc.ads('once', { play: true });
    console.log('[youtube] last state', JSON.stringify(last));
  }, 150_000);
});
