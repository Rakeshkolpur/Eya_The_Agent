/**
 * Live integration test of typing a verification code the user said: the real extension (0.8.0) in a real Chrome, on a login page with a
 * mobile-number step, then a one-time-code step with a password and a card-number field beside it. Driven through fill_on_page (the tool
 * the model uses), with the person's words attached the way the app attaches them.
 *
 * What it proves: a code the person said is typed into the one-time-code field and the page's own Verify button then works; a code they did
 * not say is not typed; a password or a card number is never typed, whatever was said.
 *
 * Skipped unless EYA_LIVE_BROWSER=1 (it launches a browser). Run with:
 *   EYA_LIVE_BROWSER=1 npx vitest run tests/live/otp.live.test.ts
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
const BRIDGE_PORT = 47854;
const DEBUG_PORT = 9354;

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

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('Typing a verification code the user said: real extension, real Chrome', () => {
  let site: { server: Server; port: number };
  let base = '';
  let bridge: ChromeBridge;
  let svc: ChromeBrowserService;
  let browser: TestBrowser;
  let ext: { dir: string; cleanup: () => void };
  let entered = 0;
  let toolByName: Record<string, Tool> = {};

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
    toolByName = Object.fromEntries(createBrowserTools(svc, undefined, { onCodeEntered: () => void (entered += 1) }).map((t) => [t.schema.name, t]));
  }, 120_000);

  afterAll(async () => {
    browser?.kill();
    await bridge?.stop();
    site?.server.close();
    await sleep(500);
    browser?.cleanup();
    ext?.cleanup();
  }, 30_000);

  const say = (words: string) => <T>(fn: () => Promise<T>): Promise<T> => runWithUserWords(words, fn);
  const field = (id: string) => userEval(DEBUG_PORT, undefined, `document.getElementById(${JSON.stringify(id)}).value`);
  const result = () => userEval(DEBUG_PORT, undefined, "document.getElementById('result').textContent");

  it('the extension offers one_time_code (so an old extension can be told to reload)', () => {
    expect(bridge.info().browsers['chrome']?.capabilities).toContain('one_time_code');
  });

  it('the code page is reported as asking for a verification code, and the task is told what to do', async () => {
    await svc.openWebsite(`${base}/otp.html`);
    await svc.fillOnPage('Mobile number', '9876543210');
    await svc.clickOnPage('Request OTP');
    const r = await toolByName['inspect_page']!.execute({});
    expect(r.data).toMatchObject({ needsUser: true, challengeKind: 'mfa' });
    expect(String(r.data?.['userAction'])).toMatch(/tell you the code/);
  }, 60_000);

  it('a code the user did NOT say is not typed', async () => {
    const r = await say('book this product')(() => toolByName['fill_on_page']!.execute({ label: 'Enter OTP', value: '482913' }));
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('needs you');
    expect(await field('otp')).toBe('');
    expect(entered).toBe(0);
  }, 60_000);

  it('a code the user said out loud is typed, and the page\'s own Verify button then works', async () => {
    const r = await say('the code is four eight two nine one three')(() => toolByName['fill_on_page']!.execute({ label: 'Enter OTP', value: '482913' }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await field('otp')).toBe('482913');
    expect(entered).toBe(1);
    const verify = await toolByName['click_on_page']!.execute({ text: 'Verify' });
    expect(verify.ok).toBe(true);
    await waitFor(async () => (await result()) === 'Verified: welcome back', 8000, 'the page to accept the code');
  }, 60_000);

  it('a password is never typed, even with a code said and allowed', async () => {
    const r = await say('my password is hunter22 and the code is 482913')(() => toolByName['fill_on_page']!.execute({ label: 'Account password', value: 'hunter22' }));
    expect(r.ok).toBe(false);
    expect(await field('pw')).toBe('');
  }, 60_000);

  it('a card number is never typed, even when the user said the number', async () => {
    const r = await say('the card number is 4111111111111111')(() => toolByName['fill_on_page']!.execute({ label: 'Card number', value: '4111111111111111' }));
    expect(r.ok).toBe(false);
    expect(await field('card')).toBe('');
  }, 60_000);
});
