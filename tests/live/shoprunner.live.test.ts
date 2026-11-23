/**
 * The whole order, with no AI, in a real Chrome with the real extension, on a mock phone shop shaped like Flipkart's: a search box that needs Enter, result cards that are links with
 * long text, an accessory "for POCO M6 PRO 5G" among them, a product page that opens on the OTHER variant after a 2.5 s loading screen, variant tiles, a painted "Buy at" box that only
 * opens an offers panel, a yellow "Buy now" painted by a separate layer, and then the checkout (the delivery address, the order summary, the ways to pay) and the button that pays.
 *
 * Proves, with the real browser tools on real pages: the right phone is opened, the 128 GB + 6 GB tile is chosen, "Buy now" starts the checkout, the address and the order summary are
 * passed, the ONE question is how to pay — and nothing has been paid (the shop counts presses); then the person's answers ("cash on delivery", "yes") are understood, the way to pay is
 * chosen, ONE confirmation is asked, and only the yes presses the button that places the order (once).
 *
 * Opt-in: EYA_LIVE_BROWSER=1 npx vitest run tests/live/shoprunner.live.test.ts
 * Not covered: the real Flipkart (signed in or not).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { ChromeBridge } from '../../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../../src/main/chrome/ChromeBridge';
import { ChromeBrowserService } from '../../src/main/chrome/ChromeBrowserService';
import type { BrowserName } from '../../src/main/chrome/protocol';
import { continueCheckout } from '../../src/main/agent/checkoutRunner';
import type { PendingCheckout } from '../../src/main/agent/checkoutRunner';
import { runShopOrder } from '../../src/main/agent/shopRunner';
import { createBrowserTools } from '../../src/main/tools/impl/browserTools';
import { ToolRegistry } from '../../src/main/tools/ToolRegistry';
import type { ToolArgs } from '../../src/main/tools/types';
import { startTestSite } from '../fixtures/chrome-test-site/server.mjs';
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, userEval, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const BRIDGE_PORT = 47873;
const DEBUG_PORT = 9373;

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

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('an order run by the application itself, in a real Chrome', () => {
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

  it('searches, opens the right phone, chooses 128 GB + 6 GB, presses "Buy now", passes the address and the summary, asks HOW TO PAY — then the answers go on, and only "yes" pays', async () => {
    const opened = await tools.invoke('open_website', { url: `${base}/phones.html` });
    expect(opened.ok, JSON.stringify(opened).slice(0, 400)).toBe(true);
    const said: string[] = [];
    const calls: string[] = [];
    const deps = {
      invoke: (n: string, a: ToolArgs) => (calls.push(`${n}:${String(a['text'] ?? a['label'] ?? '').slice(0, 30)}${a['confirm'] === true ? ':confirm' : ''}`), tools.invoke(n, a, { lenient: true })),
      say: (m: string) => void said.push(m),
    };
    const r = await runShopOrder(deps, { site: 'Mock Phone Shop', siteId: 'flipkart', product: 'POCO M7 Pro 5G 6GB 128GB' });
    expect(r.answer, `${JSON.stringify(r)} | ${calls.join(' > ')}`).toMatch(/pressed "Buy now"/);
    expect(r.answer).toMatch(/How do you want to pay — UPI, Cash on Delivery, Net Banking\?/);
    expect(r.answer).toMatch(/Total Payable ₹14,249/);
    expect(r.answer).toMatch(/Makthal/);
    expect(r.answer).not.toMatch(/shall I proceed/i);
    expect(r.steps.map((s) => s.split(' ').slice(0, 2).join(' '))).toEqual(['Searched Mock', 'Opened POCO', 'Chose the', 'Pressed "Buy', 'Used the', 'Went on']);
    // (the page was still loading when it was opened: it waited for the buttons)
    expect(calls.filter((c) => c.startsWith('inspect_page')).length).toBeGreaterThan(1);
    expect(r.pending).toMatchObject({ stage: 'payment' });
    await sleep(200);
    expect(await userEval(DEBUG_PORT, undefined, 'window.__placed')).toBe(0);

    // the person says how to pay: it is chosen, and ONE confirmation is asked
    const second = await continueCheckout(deps, r.pending as PendingCheckout, 'cash on delivery please');
    expect(second?.answer, JSON.stringify(second)).toMatch(/I chose Cash on Delivery\./);
    expect(second?.answer).toMatch(/Shall I place the order now\?/);
    await sleep(200);
    expect(await userEval(DEBUG_PORT, undefined, 'window.__placed')).toBe(0); // (still nothing paid)

    // only the yes places it, once
    const third = await continueCheckout(deps, second?.pending as PendingCheckout, 'yes');
    expect(third?.answer, `${JSON.stringify(third)} | ${calls.join(' > ')}`).toMatch(/Done: the order for POCO M7 Pro 5G 6GB 128GB is placed on Mock Phone Shop \(order OD555000111222\)/);
    await sleep(200);
    expect(await userEval(DEBUG_PORT, undefined, 'window.__placed')).toBe(1);
    expect(calls.filter((c) => /Pay ₹14,249/.test(c))).toEqual(['click_on_page:Pay ₹14,249:confirm']);
  }, 180_000);
});
