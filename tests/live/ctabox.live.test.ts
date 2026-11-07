/**
 * The "Buy at ₹14,249" problem, in a real Chrome with the real extension. On the real Flipkart product page the buy buttons are plain <div>s — no role, no tabindex,
 * cursor: auto — so Eya's list of what can be clicked did not have them, and "Buy at ₹14,249" came back "isn't visible on the current page" while it was in plain
 * sight. The mock page has that shape (words in a leaf div, painted box around it, the handler on the box). Proved here: the box is listed and clicked, a sentence
 * that merely contains "buy" and a green "Next day delivery" badge are NOT taken for buttons, and the spend gate still stops "Buy now".
 *
 * Opt-in: EYA_LIVE_BROWSER=1 npx vitest run tests/live/ctabox.live.test.ts
 * Not covered: the real Flipkart page (its public page was read in a browser; its signed-in page and its real click response were not).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { ChromeBridge } from '../../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../../src/main/chrome/ChromeBridge';
import { ChromeBrowserService } from '../../src/main/chrome/ChromeBrowserService';
import type { BrowserName } from '../../src/main/chrome/protocol';
import { createBrowserTools } from '../../src/main/tools/impl/browserTools';
import { ToolRegistry } from '../../src/main/tools/ToolRegistry';
import type { ToolArgs, ToolResult } from '../../src/main/tools/types';
import { startTestSite } from '../fixtures/chrome-test-site/server.mjs';
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const BRIDGE_PORT = 47872;
const DEBUG_PORT = 9372;

class Secrets implements SecretStore {
  h = new Map<BrowserName, string>();
  loadHash(b: BrowserName) {
    return this.h.get(b) ?? null;
  }
  saveHash(b: BrowserName, x: string) {
    this.h.set(b, x);
  }
  clear(b?: BrowserName) {
    if (b === undefined) this.h.clear();
    else this.h.delete(b);
  }
}

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('call-to-action boxes that are not marked as controls', () => {
  let site: { server: Server; port: number };
  let bridge: ChromeBridge;
  let svc: ChromeBrowserService;
  let browser: TestBrowser;
  let ext: { dir: string; cleanup: () => void };
  let tools: ToolRegistry;
  let base = '';

  beforeAll(async () => {
    site = await startTestSite(0);
    base = `http://127.0.0.1:${site.port}`;
    ext = prepareExtensionCopy(BRIDGE_PORT);
    bridge = new ChromeBridge({ secrets: new Secrets(), port: BRIDGE_PORT });
    if (!(await bridge.start())) throw new Error(`port ${BRIDGE_PORT} is busy`);
    svc = new ChromeBrowserService(bridge.forBrowser('chrome'), { browserName: 'chrome' });
    bridge.openPairingWindow();
    browser = await startTestBrowser({ kind: 'chrome', extensionDir: ext.dir, debugPort: DEBUG_PORT, headed: process.env['EYA_LIVE_HEADED'] === '1' });
    await waitFor(() => bridge.isConnected('chrome'), 45_000, 'the extension to connect and pair');
    tools = new ToolRegistry();
    for (const t of createBrowserTools(svc)) tools.register(t);
  }, 120_000);

  afterAll(async () => {
    browser?.kill();
    await bridge?.stop();
    site?.server.close();
    await sleep(500);
    browser?.cleanup();
    ext?.cleanup();
  }, 30_000);

  const run = (name: string, args: ToolArgs = {}): Promise<ToolResult> => tools.invoke(name, args);
  const openPage = async (): Promise<string> => {
    const r = await run('open_website', { url: `${base}/cta-boxes.html` });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return JSON.stringify(r.data ?? {});
  };

  it('the painted boxes are listed as things to click; a sentence with "buy" in it and a green badge are not', async () => {
    const r = await run('open_website', { url: `${base}/cta-boxes.html` });
    const page = ((r.data ?? {})['currentPage'] ?? {}) as Record<string, unknown>;
    // (only what can be clicked: the page's own text, which the result also carries, does hold those words)
    const clickable = JSON.stringify({ links: page['links'], buttons: page['buttons'] });
    expect(clickable, JSON.stringify(page).slice(0, 900)).toContain('Buy at ₹14,249');
    expect(clickable).not.toContain('Buy fresh vegetables');
    expect(clickable).not.toContain('Buy local'); // starts with "buy", but is not what a button says
    expect(clickable).toContain('Buy now'); // painted by a layer BEHIND the words: no colour on it or above it
    expect(clickable).toContain('Continue'); // a weaker word, on a box painted with an IMAGE
    expect(clickable).not.toContain('Continue reading'); // the same word in a sentence, on no box
    expect(clickable).not.toContain('Next day delivery');
  }, 60_000);

  it('"Buy at ₹14,249" is clicked (it used to be "not visible on the page"), and the page answers', async () => {
    await openPage();
    const r = await run('click_on_page', { text: 'Buy at ₹14,249' });
    expect(r.ok, JSON.stringify(r).slice(0, 700)).toBe(true);
    await sleep(300);
    const read = await run('read_page', {});
    expect(JSON.stringify(read.data ?? {})).toContain('Order summary: POCO M7 Pro 5G, total ₹14,249');
  }, 60_000);

  it('"Buy now" (further down the page, in an orange box) is found too — and the spend gate still stops it until the user says yes', async () => {
    await openPage();
    const first = await run('click_on_page', { text: 'Buy now' });
    expect(first.ok).toBe(false);
    expect(first.summary).toBe('needs confirmation');
    const read1 = await run('read_page', {});
    expect(JSON.stringify(read1.data ?? {})).not.toContain('Checkout started');
    const second = await run('click_on_page', { text: 'Buy now', confirm: true });
    expect(second.ok, JSON.stringify(second).slice(0, 500)).toBe(true);
    await sleep(300);
    expect(JSON.stringify((await run('read_page', {})).data ?? {})).toContain('Checkout started');
  }, 60_000);

  it('the variant tile (cursor: pointer) still works as before', async () => {
    await openPage();
    const r = await run('click_on_page', { text: '128 GB + 6 GB ₹14,999' });
    expect(r.ok, JSON.stringify(r).slice(0, 500)).toBe(true);
    await sleep(300);
    expect(JSON.stringify((await run('read_page', {})).data ?? {})).toContain('Variant 128 GB + 6 GB chosen');
  }, 60_000);
});
