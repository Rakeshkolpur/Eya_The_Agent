/**
 * Live integration test of ordering and booking: the real extension (0.9.0) in a real Chrome, on a small shop (search, results, cart,
 * checkout with cash on delivery or a card, order placed) and a cinema booking page (seats, confirm). Driven through the browser tools the
 * model uses.
 *
 * What it proves: the steps on the way go through without asking; the click that spends money does NOT go through without the user's yes
 * and comes back with the amounts, address and way of paying the page shows; with the yes it goes through exactly once; a card number and a
 * CVV are never typed (and the card step is flagged as the user's); a booking works the same way.
 *
 * Skipped unless EYA_LIVE_BROWSER=1 (it launches a browser). Run with:
 *   EYA_LIVE_BROWSER=1 npx vitest run tests/live/shop.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { ChromeBridge } from '../../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../../src/main/chrome/ChromeBridge';
import { ChromeBrowserService } from '../../src/main/chrome/ChromeBrowserService';
import type { BrowserName } from '../../src/main/chrome/protocol';
import { createBrowserTools } from '../../src/main/tools/impl/browserTools';
import { runWithUserWords } from '../../src/main/security/userWords';
import type { Tool } from '../../src/main/tools/types';
import { startTestSite } from '../fixtures/chrome-test-site/server.mjs';
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, userEval, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const BRIDGE_PORT = 47855;
const DEBUG_PORT = 9355;

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

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('Ordering and booking: real extension, real Chrome', () => {
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

  const text = (js: string) => userEval(DEBUG_PORT, undefined, js);

  it('the extension offers the payment-step detection (version 0.9.0)', () => {
    expect(bridge.info().browsers['chrome']?.extensionVersion).toBe('0.9.0');
  });

  it('searching, choosing the right item and adding it to the cart go through without asking anything', async () => {
    await svc.openWebsite(`${base}/shop.html`);
    expect((await tool['fill_on_page']!.execute({ label: 'Search', value: 'red shirt' })).ok).toBe(true);
    expect((await tool['click_on_page']!.execute({ text: 'Search' })).ok).toBe(true);
    const page = await tool['inspect_page']!.execute({});
    expect(JSON.stringify(page.data)).toContain('Red cotton shirt (M)');
    // the cotton one (the user asked for cotton), not the first or the cheapest
    const adds = await tool['find_on_page']!.execute({ query: 'Add to cart' });
    expect(adds.ok).toBe(true);
    expect((await tool['click_on_page']!.execute({ text: 'Add to cart' })).ok).toBe(true);
    expect(await text("document.getElementById('cartline').textContent")).toMatch(/In your cart: Red (cotton|polyester) shirt/);
    expect((await tool['click_on_page']!.execute({ text: 'Checkout' })).ok).toBe(true);
  }, 90_000);

  it('the card step is flagged as the user\'s, and a card number or CVV is never typed, whatever was said', async () => {
    await tool['click_on_page']!.execute({ text: 'Pay by card instead' });
    const look = await tool['inspect_page']!.execute({});
    expect(look.data).toMatchObject({ needsUser: true, challengeKind: 'payment' });
    expect(String(look.data?.['userAction'])).toMatch(/payment is theirs|are the user's/);
    for (const [label, value] of [['Card number', '4111111111111111'], ['CVV', '123']] as const) {
      const r = await runWithUserWords(`the ${label} is ${value}`, () => tool['fill_on_page']!.execute({ label, value }));
      expect(r.ok, label).toBe(false);
    }
    expect(await text("document.getElementById('card').value + '|' + document.getElementById('cvv').value")).toBe('|');
    await tool['click_on_page']!.execute({ text: 'Use cash on delivery' });
  }, 90_000);

  it('Place order does NOT go through on its own: it comes back with the total, the address and the way of paying', async () => {
    const r = await tool['click_on_page']!.execute({ text: 'Place order' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('needs confirmation');
    const checkout = r.data?.['checkout'] as { amounts: string[]; deliverTo?: string; payWith?: string } | undefined;
    expect(checkout?.amounts[0]).toMatch(/^Total payable ₹\d/);
    expect(checkout?.deliverTo).toBe('12-3 Road No 4, Hyderabad 500034');
    expect(checkout?.payWith).toBe('Cash on delivery');
    expect(await text('window.__placed')).toBe(0);
  }, 60_000);

  it('with the user\'s yes it goes through, once, and the confirmation page says so', async () => {
    const r = await tool['click_on_page']!.execute({ text: 'Place order', confirm: true });
    expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
    await waitFor(async () => /Order placed/.test(String(await text('document.body.innerText'))), 8000, 'the order confirmation');
    expect(await text('window.__placed')).toBe(1);
    expect(String(await text("document.getElementById('orderid').textContent"))).toMatch(/^Order ID OD10001 for Red/);
  }, 60_000);

  it('booking tickets: choosing seats goes through; Confirm booking asks first, with the show, the seats and the total', async () => {
    await svc.openWebsite(`${base}/book.html`);
    expect((await tool['click_on_page']!.execute({ text: 'F7' })).ok).toBe(true);
    expect((await tool['click_on_page']!.execute({ text: 'F8' })).ok).toBe(true);
    const asked = await tool['click_on_page']!.execute({ text: 'Confirm booking' });
    expect(asked.ok).toBe(false);
    expect(asked.summary).toBe('needs confirmation');
    const checkout = asked.data?.['checkout'] as { amounts: string[]; details: string[] } | undefined;
    expect(checkout?.amounts[0]).toBe('Total ₹560');
    expect(checkout?.details.join(' | ')).toMatch(/Seats: F7, F8/);
    expect(checkout?.details.join(' | ')).toMatch(/2 Tickets/);
    expect(await text('window.__bookings')).toBe(0);
  }, 90_000);

  it('and with the yes the booking is made, once', async () => {
    const r = await tool['click_on_page']!.execute({ text: 'Confirm booking', confirm: true });
    expect(r.ok).toBe(true);
    await waitFor(async () => /Booking confirmed: BK701 for seats F7, F8/.test(String(await text("document.getElementById('result').textContent"))), 8000, 'the booking confirmation');
    expect(await text('window.__bookings')).toBe(1);
  }, 60_000);
});
