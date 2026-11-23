/**
 * The Tasks page's promise — "every task runs on its own" — in a REAL Chromium page, through the real services:
 *
 *   runAsTask (tabScope) → browser tools → BrowserSessionManager → EmbeddedBrowserService → EmbeddedPageHost → the page script run inside a real page
 *
 * Two tasks (an order-shaped one on a phone shop, a look-up on a cause list) run AT THE SAME TIME, each opening its page and acting on it step by step with the other's steps in
 * between. What this proves: each task gets a tab of its own, every step of a task lands in THAT task's page (never the other's), a task run again goes on in the tab it had,
 * a task whose tab was closed gets a new one without touching the other, and a plain request (no task) is not scoped at all.
 *
 * Opt-in: EYA_LIVE_BROWSER=1 npx vitest run tests/live/tasks.live.test.ts
 * NOT covered: Electron's own layer (WebContentsView, the window), the real Flipkart, a real model (the steps are scripted).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { BrowserWorldTracker } from '../../src/main/chrome/browserWorld';
import { BrowserSessionManager } from '../../src/main/browser/BrowserSessionManager';
import type { BrowserLauncher, ManagedBridge } from '../../src/main/browser/BrowserSessionManager';
import { EmbeddedBrowserService } from '../../src/main/browser/EmbeddedBrowserService';
import { runAsTask } from '../../src/main/browser/tabScope';
import type { Home } from '../../src/main/browser/tabScope';
import { TaskPlaces } from '../../src/main/tasks/TaskBoard';
import { CommunicationPolicy } from '../../src/main/privacy/communicationAccess';
import { CommunicationAccessStore } from '../../src/main/privacy/communicationAccessStore';
import { createBrowserTools } from '../../src/main/tools/impl/browserTools';
import type { Tool, ToolArgs, ToolResult } from '../../src/main/tools/types';
import { startTestSite } from '../fixtures/chrome-test-site/server.mjs';
import { CdpEnv } from './cdpEmbedded';
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const DEBUG_PORT = 9367;

/** A bridge with no browser of the user's behind it: this test uses Eya Browser only, and fails if the user's own browser is asked for anything. */
const noUserBrowser = {
  connectedBrowsers: () => [],
  isConnected: () => false,
  forBrowser: () => {
    throw new Error("the user's own browser must not be used in this test");
  },
  waitForConnection: async () => false,
  waitingToPair: () => [],
  outdated: () => [],
  info: () => ({}),
} as unknown as ManagedBridge;

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('Tasks: several at once, each in a tab of its own (real Chromium)', () => {
  let site: { server: Server; port: number };
  let browser: TestBrowser;
  let ext: { dir: string; cleanup: () => void };
  let env: CdpEnv;
  let eya: EmbeddedBrowserService;
  let manager: BrowserSessionManager;
  let tools: Tool[];
  const places = new TaskPlaces();

  const call = async (name: string, args: ToolArgs = {}): Promise<ToolResult> => {
    const tool = tools.find((t) => t.schema.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.execute(args);
  };
  const url = (page: string): string => `http://shop.localhost:${site.port}/${page}`;
  /** Runs `work` as the task `id`, in the place the task has (and keeps whatever place its first page gave it). */
  const asTask = <T>(id: string, work: () => Promise<T>): Promise<T> =>
    runAsTask(places.get(id), (tab: number | null, home: Home | null) => places.set(id, tab, home), work);
  /** The title of the page in a tab of Eya Browser (what that tab shows now), by the tab's number. */
  const titleOf = async (tab: number | null): Promise<string> => {
    const listed = await eya.host.request<{ tabs: Array<{ tabId: number; title: string }> }>('list_tabs');
    return listed.tabs.find((t) => t.tabId === tab)?.title ?? '';
  };
  const tabs = (): number => env.tabs.filter((t) => !t.isClosed()).length;
  /** The open page of a tab that shows an address with this in it. */
  const pageWith = (part: string) => env.tabs.find((t) => !t.isClosed() && t.url().includes(part));

  beforeAll(async () => {
    site = await startTestSite(0);
    ext = prepareExtensionCopy(47868);
    browser = await startTestBrowser({ kind: 'chrome', extensionDir: ext.dir, debugPort: DEBUG_PORT, extraArgs: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'] });
    env = new CdpEnv(DEBUG_PORT);
    eya = new EmbeddedBrowserService({ env, navTimeoutMs: 10_000, blankWaitMs: 1500 });
    const files = new Map<string, string>();
    const store = new CommunicationAccessStore('memory', { read: (p) => files.get(p) ?? null, write: (p, t) => void files.set(p, t) }, []);
    store.load();
    const policy = new CommunicationPolicy(() => store.get(), []);
    const launcher: BrowserLauncher = { installed: async () => [], running: async () => [], launch: async () => false };
    manager = new BrowserSessionManager({ bridge: noUserBrowser, world: new BrowserWorldTracker(), isolated: eya, mode: 'smart', preference: () => 'eya', words: () => '', launcher, policy });
    tools = createBrowserTools(manager, undefined, { tabs: manager, session: manager });
  }, 120_000);

  afterAll(async () => {
    await eya?.close().catch(() => undefined);
    browser?.kill();
    site?.server.close();
    await sleep(500);
    browser?.cleanup();
    ext?.cleanup();
  }, 30_000);

  it('two tasks at the same time: each opens its own tab, and every step of each lands in ITS page', async () => {
    const phones = asTask('order', async () => {
      const opened = await call('open_website', { url: url('phones.html') });
      expect(opened.ok, JSON.stringify(opened)).toBe(true);
      await sleep(40);
      const seen = await call('inspect_page');
      expect(seen.ok, JSON.stringify(seen)).toBe(true);
      expect(JSON.stringify(seen.data)).toContain('Mock Phone Shop');
      await sleep(40);
      const again = await call('inspect_page'); // (after the other task has opened and read its own page in between)
      expect(JSON.stringify(again.data)).toContain('Mock Phone Shop');
      expect(JSON.stringify(again.data)).not.toContain('Cause List');
    });
    const causelist = asTask('lookup', async () => {
      await sleep(20);
      const opened = await call('open_website', { url: url('causelist.html') });
      expect(opened.ok, JSON.stringify(opened)).toBe(true);
      await sleep(40);
      const seen = await call('inspect_page');
      expect(seen.ok, JSON.stringify(seen)).toBe(true);
      expect(JSON.stringify(seen.data)).toContain('Cause List');
      expect(JSON.stringify(seen.data)).not.toContain('Mock Phone Shop');
      // a step that DOES something in the page: type into the cause list's box, press Search, read the answer
      const typed = await call('fill_on_page', { label: 'Advocate Code', value: 'A-1' });
      expect(typed.ok, JSON.stringify(typed)).toBe(true);
      const pressed = await call('click_on_page', { text: 'Search' });
      expect(pressed.ok, JSON.stringify(pressed)).toBe(true);
    });
    await Promise.all([phones, causelist]);

    expect(tabs()).toBe(2);
    const a = places.get('order');
    const b = places.get('lookup');
    expect(a.home).toBe('eya');
    expect(b.home).toBe('eya');
    expect(a.tab).not.toBe(b.tab);
    expect(await titleOf(a.tab)).toBe('Mock Phone Shop');
    expect(await titleOf(b.tab)).toBe('Cause List');
    // (the cause list's own click happened in the cause list's page, and the phone shop's page was not touched by it)
    const out = String(await pageWith('causelist')?.run("document.getElementById('out').textContent"));
    expect(out).toBe('Searched for A-1');
  }, 90_000);

  it('a task that runs again (a retry, the person\'s answer) goes on in the tab it had, not a new one', async () => {
    const before = tabs();
    const a = places.get('order');
    await asTask('order', async () => {
      const opened = await call('open_website', { url: url('index.html') });
      expect(opened.ok, JSON.stringify(opened)).toBe(true);
    });
    expect(tabs()).toBe(before);
    expect(places.get('order').tab).toBe(a.tab);
    expect(await titleOf(a.tab)).not.toBe('Mock Phone Shop'); // (the order task's own tab went to the new page)
    expect(await titleOf(places.get('lookup').tab)).toBe('Cause List'); // (the other task's page was left alone)
  }, 60_000);

  it('a task whose tab was closed gets a new one, and the other task is not touched', async () => {
    const gone = places.get('order').tab;
    const own = pageWith('index.html'); // (the order task's own tab: the last test took it to the home page)
    expect(own).toBeDefined();
    own?.close();
    await sleep(300);
    await asTask('order', async () => {
      const opened = await call('open_website', { url: url('phones.html') });
      expect(opened.ok, JSON.stringify(opened)).toBe(true);
    });
    expect(places.get('order').tab).not.toBe(gone);
    expect(await titleOf(places.get('order').tab)).toBe('Mock Phone Shop');
    expect(await titleOf(places.get('lookup').tab)).toBe('Cause List');
  }, 60_000);

  it('a request that is not a task is not scoped: it goes on in the page in front, and a task\'s place does not change', async () => {
    const before = { ...places.get('lookup') };
    const opened = await call('open_website', { url: url('index.html') });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    expect(places.get('lookup')).toEqual(before);
  }, 60_000);
});
