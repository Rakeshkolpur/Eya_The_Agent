/**
 * Live integration test of what Eya takes for "the page is still loading": the real extension in a real Chrome, on a busy checkout page
 * (a ticker and an advert that change many times a second, a checkout progress bar that is part of the page, loading markers tucked
 * away out of sight, and, after a button, a real spinner for seven seconds).
 *
 * What it proves: a page that is only busy is ready (no "still loading"), a progress bar with a value is not a spinner, hidden markers do not
 * count, and a spinner that really is showing is reported as one (and not reported once it is gone).
 *
 * Skipped unless EYA_LIVE_BROWSER=1 (it launches a browser). Run with:
 *   EYA_LIVE_BROWSER=1 npx vitest run tests/live/busy.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { ChromeBridge } from '../../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../../src/main/chrome/ChromeBridge';
import { ChromeBrowserService } from '../../src/main/chrome/ChromeBrowserService';
import type { BrowserName } from '../../src/main/chrome/protocol';
import { createBrowserTools } from '../../src/main/tools/impl/browserTools';
import type { Tool } from '../../src/main/tools/types';
import { startTestSite } from '../fixtures/chrome-test-site/server.mjs';
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, userEval, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const BRIDGE_PORT = 47857;
const DEBUG_PORT = 9357;

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

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('What counts as a loading page: real extension, real Chrome', () => {
  let site: { server: Server; port: number };
  let base = '';
  let bridge: ChromeBridge;
  let svc: ChromeBrowserService;
  let browser: TestBrowser;
  let ext: { dir: string; cleanup: () => void };
  let tool: Record<string, Tool> = {};

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
    tool = Object.fromEntries(createBrowserTools(svc).map((t) => [t.schema.name, t]));
  }, 120_000);

  afterAll(async () => {
    browser?.kill();
    await bridge?.stop();
    site?.server.close();
    await sleep(500);
    browser?.cleanup();
    ext?.cleanup();
  }, 30_000);

  const js = (expression: string) => userEval(DEBUG_PORT, undefined, expression);
  const click = (args: Parameters<Tool['execute']>[0]) => tool['click_on_page']!.execute(args);
  const notesOf = (r: { data?: Record<string, unknown> }): string => JSON.stringify((r.data?.['currentPage'] as { notes?: unknown } | undefined)?.notes ?? []);

  it('a busy page (a ticker, an advert, a progress bar with a value, hidden loading markers) is ready: no "still loading"', async () => {
    await svc.openWebsite(`${base}/busy.html`);
    const started = Date.now();
    const r = await click({ text: 'Deliver here' });
    expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
    expect(await js('window.__delivered === true')).toBe(true);
    expect(r.data?.['pageStillChanging']).toBeUndefined();
    expect(notesOf(r)).not.toMatch(/loading|changing/i);
    expect(Date.now() - started).toBeLessThan(9000);
    const look = await tool['inspect_page']!.execute({});
    expect(JSON.stringify(look.data)).not.toMatch(/still loading|loading indicator/i);
    expect(JSON.stringify(look.data)).toContain('12-3 Road No 4');
  }, 60_000);

  it('a spinner that really is showing is reported as one, and is not reported once it is gone', async () => {
    const r = await click({ text: 'Check availability' });
    expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
    expect(r.data?.['pageStillChanging']).toBe(true);
    expect(notesOf(r)).toMatch(/loading indicator/i);
    await sleep(4500); // the spinner goes after seven seconds
    const later = await tool['inspect_page']!.execute({});
    expect(JSON.stringify(later.data)).toContain('In stock');
    expect(JSON.stringify(later.data)).not.toMatch(/loading indicator|still loading/i);
  }, 60_000);
});
