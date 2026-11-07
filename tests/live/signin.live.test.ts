/**
 * Whether the person is signed in, as the REAL extension in a REAL Chrome shows it to Eya: the lists Eya really gets for a page (links, buttons, clickable elements, the links hidden in
 * a closed menu) feed the sign-in detector, over mock pages shaped like the real ones (a Login link in the header and a phone-number box with Continue; a name with an account menu
 * holding Logout; a clickable "Sign In" that is neither a link nor a button). The unit tests prove the rules; this proves the real page lists reach them.
 *
 * Opt-in: EYA_LIVE_BROWSER=1 npx vitest run tests/live/signin.live.test.ts
 * Not covered: the real Flipkart / Swiggy pages signed in (they were read signed OUT from their public pages; the signed-in state of the person's own Chrome was never looked at).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { ChromeBridge } from '../../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../../src/main/chrome/ChromeBridge';
import { ChromeBrowserService } from '../../src/main/chrome/ChromeBrowserService';
import type { BrowserName } from '../../src/main/chrome/protocol';
import type { KnownFolders } from '../../src/main/security/pathPolicy';
import { signInState } from '../../src/main/browser/signInState';
import { createBrowserTools } from '../../src/main/tools/impl/browserTools';
import { ToolRegistry } from '../../src/main/tools/ToolRegistry';
import type { ToolArgs, ToolResult } from '../../src/main/tools/types';
import { startTestSite } from '../fixtures/chrome-test-site/server.mjs';
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const BRIDGE_PORT = 47871;
const DEBUG_PORT = 9371;

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

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('signed in or not, from the pages a real Chrome gives Eya', () => {
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
    const home = tmpdir();
    const folders: KnownFolders = { home, downloads: browser.downloads, desktop: home, documents: home, pictures: home, videos: home, music: home, temp: home };
    void folders;
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
  const open = async (page: string): Promise<Record<string, unknown>> => {
    const r = await run('open_website', { url: `${base}/${page}` });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return ((r.data ?? {})['currentPage'] ?? {}) as Record<string, unknown>;
  };

  it('nobody signed in (a Login link, a phone-number box, Continue): the tool result says NO, with the evidence', async () => {
    const page = await open('account-out.html');
    expect(page['signedIn'], JSON.stringify(page).slice(0, 600)).toBe('no');
    expect(String((page['signInEvidence'] as string[])?.join(' '))).toMatch(/login/i);
  }, 60_000);

  it('somebody signed in (a name with an account menu that holds Logout, no Login): the tool result says YES — the Logout inside the closed menu is seen', async () => {
    const page = await open('account-in.html');
    expect(page['signedIn'], JSON.stringify(page).slice(0, 800)).toBe('yes');
  }, 60_000);

  it('a "Sign In" that is neither a link nor a button (a clickable element, as Swiggy draws it) is still seen', async () => {
    const page = await open('account-clickable.html');
    expect(page['signedIn'], JSON.stringify(page).slice(0, 600)).toBe('no');
  }, 60_000);

  it('the same answer is reached from the snapshot the browser gives (not only from the tool result)', async () => {
    await open('account-out.html');
    const snap = await svc.inspectPage();
    expect(signInState(snap).answer).toBe('no');
    await open('account-in.html');
    expect(signInState(await svc.inspectPage()).answer).toBe('yes');
  }, 60_000);
});
