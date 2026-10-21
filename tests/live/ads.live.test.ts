/**
 * Live integration test of the advert helper: the real Eya Browser Bridge extension (0.7.0), loaded into a real Chrome, pressing the Skip
 * button and closing the overlay advert of a page that imitates YouTube's player markup, and WAITING through an advert that has no Skip
 * button. Driven through ChromeBrowserService.ads, the same call the play_on_youtube and skip_ads tools make.
 *
 * Skipped unless EYA_LIVE_BROWSER=1 (it launches a browser). Run with:
 *   EYA_LIVE_BROWSER=1 npx vitest run tests/live/ads.live.test.ts
 *
 * What this can NOT cover: YouTube itself (its markup changes; the selectors are the ones its player has used). Real YouTube was not driven.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { ChromeBridge } from '../../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../../src/main/chrome/ChromeBridge';
import { ChromeBrowserService } from '../../src/main/chrome/ChromeBrowserService';
import type { BrowserName } from '../../src/main/chrome/protocol';
import type { AdsState } from '../../src/main/browser/BrowserAutomationService';
import { startTestSite } from '../fixtures/chrome-test-site/server.mjs';
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const BRIDGE_PORT = 47852;
const DEBUG_PORT = 9352;

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

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('Advert helper: real extension, real Chrome', () => {
  let site: { server: Server; port: number };
  let base = '';
  let bridge: ChromeBridge;
  let svc: ChromeBrowserService;
  let browser: TestBrowser;
  let ext: { dir: string; cleanup: () => void };

  beforeAll(async () => {
    site = await startTestSite(0);
    base = `http://127.0.0.1:${site.port}`;
    ext = prepareExtensionCopy(BRIDGE_PORT);
    bridge = new ChromeBridge({ secrets: new MemorySecrets(), port: BRIDGE_PORT });
    if (!(await bridge.start())) throw new Error(`port ${BRIDGE_PORT} is busy`);
    svc = new ChromeBrowserService(bridge.forBrowser('chrome'), { browserName: 'chrome' });
    bridge.openPairingWindow();
    browser = await startTestBrowser({ kind: 'chrome', extensionDir: ext.dir, debugPort: DEBUG_PORT });
    await waitFor(() => bridge.isConnected('chrome'), 45_000, 'the extension to connect and pair');
  }, 120_000);

  afterAll(async () => {
    browser?.kill();
    await bridge?.stop();
    site?.server.close();
    await sleep(500);
    browser?.cleanup();
    ext?.cleanup();
  }, 30_000);

  it('the extension offers the "ads" ability (so an old extension can be told to reload)', () => {
    expect(bridge.info().browsers['chrome']?.capabilities).toContain('ads');
  });

  it('skips the skippable advert when its Skip button appears, closes the overlay advert, and starts the video', async () => {
    await svc.openWebsite(`${base}/fakeyoutube.html`);
    const first = await svc.ads('watch', { keepPlaying: true, play: true });
    // The advert is on, the Skip button is not there yet: nothing pressed, nothing skipped.
    expect(first.adShowing).toBe(true);
    expect(first.watching).toBe(true);
    expect(first.skipped).toBe(0);
    // The overlay advert's close button is there at once and is pressed.
    expect(first.closed).toBe(1);

    let state: AdsState = first;
    await waitFor(async () => {
      state = await svc.ads('once');
      return !state.adShowing && state.skipped >= 1;
    }, 25_000, 'the advert to be skipped');
    expect(state.skipped).toBe(1);
    expect(state.adShowing).toBe(false);

    // The page left the video paused after the advert (as YouTube can): the helper starts it.
    await waitFor(async () => {
      state = await svc.ads('once', { play: true });
      return state.video !== null && !state.video.paused;
    }, 10_000, 'the video to play');
    expect(state.video?.paused).toBe(false);
  }, 60_000);

  it('does not press anything during an advert that cannot be skipped: it waits, and the video starts when the advert ends', async () => {
    await svc.openWebsite(`${base}/fakeyoutube-unskippable.html`);
    const during = await svc.ads('watch', { keepPlaying: true });
    expect(during.adShowing).toBe(true);
    expect(during.waitingForAd).toBe(true);
    expect(during.skipped).toBe(0);
    let state: AdsState = during;
    await waitFor(async () => {
      state = await svc.ads('once');
      return !state.adShowing;
    }, 15_000, 'the advert to end by itself');
    expect(state.skipped).toBe(0);
    await waitFor(async () => {
      state = await svc.ads('once');
      return state.video !== null && !state.video.paused;
    }, 10_000, 'the video to start');
  }, 60_000);

  it('stops watching when asked', async () => {
    const stopped = await svc.ads('stop');
    expect(stopped.watching).toBe(false);
  }, 20_000);
});

