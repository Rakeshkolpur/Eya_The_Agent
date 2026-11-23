/**
 * Live integration test of adding to a cart on shop and food-app pages: the real extension in a real Chrome, driven through the browser tools
 * the model uses.
 *
 * The pages: a food menu where every dish has the same "ADD" (a div, as the delivery apps do) and a second section that only loads when the
 * page is scrolled near its end; a store page with "Add to bag" beside "Add to wishlist" and "Add address", and other products' buttons below.
 *
 * What it proves: the same button for many items is not collapsed into one nor clicked at random (it asks which); the dish named gets its
 * own; a button that only appears after scrolling is found by scrolling; "Add to cart" finds "Add to bag" and "ADD" but never "Add address".
 *
 * Skipped unless EYA_LIVE_BROWSER=1 (it launches a browser). Run with:
 *   EYA_LIVE_BROWSER=1 npx vitest run tests/live/cart.live.test.ts
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
const BRIDGE_PORT = 47856;
const DEBUG_PORT = 9356;

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

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('Adding to a cart: real extension, real Chrome', () => {
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

  it('a food menu: every dish has its own ADD in the page listing, not one ADD for all', async () => {
    await svc.openWebsite(`${base}/food.html`);
    const page = await tool['inspect_page']!.execute({});
    const text = JSON.stringify(page.data);
    for (const dish of ['Paneer Butter Masala', 'Veg Biryani', 'Masala Dosa', 'Chicken Dum Biryani']) expect(text, dish).toContain(`ADD — ${dish}`);
  }, 60_000);

  it('"Add to cart" with no dish named asks which one and clicks nothing', async () => {
    const r = await click({ text: 'Add to cart' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('which one?');
    expect(r.data?.['choices']).toEqual(expect.arrayContaining(['Paneer Butter Masala', 'Veg Biryani', 'Masala Dosa', 'Chicken Dum Biryani']));
    expect(await js('window.cart.length')).toBe(0);
  }, 60_000);

  it('the dish that was named gets its own ADD, not the first one', async () => {
    const r = await click({ text: 'ADD', near: 'Veg Biryani' });
    expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
    expect(await js('window.cart.join("|")')).toBe('Veg Biryani');
    expect((await click({ text: 'Add to cart', near: 'Masala Dosa' })).ok).toBe(true);
    expect(await js('window.cart.join("|")')).toBe('Veg Biryani|Masala Dosa');
  }, 60_000);

  it('a dish further down the menu, that only loads when the page is scrolled, is found by scrolling', async () => {
    expect(await js('document.getElementById("desserts").children.length')).toBe(0); // not there yet
    const r = await click({ text: 'ADD', near: 'Gulab Jamun' });
    expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(true);
    expect(await js('window.cart.join("|")')).toBe('Veg Biryani|Masala Dosa|Gulab Jamun');
  }, 90_000);

  it('a dish that is not on the menu at all is not replaced by another: it is reported as not on the page', async () => {
    const r = await click({ text: 'ADD', near: 'Chicken 65' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('not found');
    expect(await js('window.cart.length')).toBe(3);
  }, 90_000);

  it('a store page: "Add to cart" finds "Add to bag" for the product, and never "Add to wishlist" or "Add address"', async () => {
    await svc.openWebsite(`${base}/shop2.html`);
    const r = await click({ text: 'Add to cart' });
    // the page also has other products' "Add to bag" buttons below: it asks which product
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('which one?');
    expect(await js('window.__wished === undefined && window.__addr === undefined')).toBe(true);
    const named = await click({ text: 'Add to cart', near: 'Wireless Mouse' });
    expect(named.ok, JSON.stringify(named).slice(0, 300)).toBe(true);
    expect(await js('window.bag.join("|")')).toBe('Wireless Mouse M185');
    expect(await js('window.__wished === undefined && window.__addr === undefined')).toBe(true);
  }, 60_000);
});
