/**
 * Writing on LinkedIn in the user's OWN Chrome (the real extension, a real Chrome over the real bridge), against a LinkedIn-SHAPED page served as www.linkedin.com — the path the user was on
 * when it looped (23 Nov 2026: "browser routed to mine": open the site, click "Start a post" (covered), go back, open another page, another tab...).
 *
 * Opt-in: EYA_LIVE_BROWSER=1 npx vitest run tests/live/social.live.test.ts   (needs Chrome and openssl)
 * NOT covered: the real LinkedIn (its page is built differently), a signed-in account.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChromeBridge } from '../../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../../src/main/chrome/ChromeBridge';
import { BrowserWorldTracker } from '../../src/main/chrome/browserWorld';
import { BrowserSessionManager } from '../../src/main/browser/BrowserSessionManager';
import type { BrowserLauncher } from '../../src/main/browser/BrowserSessionManager';
import type { BrowserAutomationService } from '../../src/main/browser/BrowserAutomationService';
import type { BrowserName } from '../../src/main/chrome/protocol';
import { CommunicationPolicy } from '../../src/main/privacy/communicationAccess';
import type { CommunicationApp } from '../../src/main/privacy/communicationAccess';
import { createPublishGate } from '../../src/main/social/PublishGate';
import { SocialStore } from '../../src/main/social/SocialStore';
import { currentUserWords, runWithUserWords } from '../../src/main/security/userWords';
import type { KnownFolders } from '../../src/main/security/pathPolicy';
import { createBrowserTools } from '../../src/main/tools/impl/browserTools';
import { createSocialTools } from '../../src/main/tools/impl/socialTools';
import type { Tool, ToolArgs, ToolResult } from '../../src/main/tools/types';
import { startLinkedInMock } from '../fixtures/chrome-test-site/linkedin-mock.mjs';
import { MemoryIo } from '../liveChatFixtures';
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, userEval, userOpenTab, userTabUrls, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const BRIDGE_PORT = 47861;
const DEBUG_PORT = 9361;

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

const forbiddenIsolatedBrowser = new Proxy({}, { get: (_t, prop) => (prop === 'close' ? async () => undefined : () => Promise.reject(new Error(`Eya's separate browser window must not be used (${String(prop)})`))) }) as BrowserAutomationService;
const NOON = new Date(2026, 10, 24, 12, 0, 0).getTime();
const TEXT = 'Three things to check before you sign a rent agreement: the notice period, the deposit and who pays for repairs.';

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('LinkedIn writing in the user\'s own Chrome: one call, one tab, no loop, nothing published without the yes', () => {
  let mock: Awaited<ReturnType<typeof startLinkedInMock>>;
  let bridge: ChromeBridge;
  let browser: TestBrowser;
  let ext: { dir: string; cleanup: () => void };
  let tools: Map<string, Tool>;
  let store: SocialStore;
  let picture = '';
  let pictureName = '';

  const call = (name: string, args: ToolArgs = {}, said = ''): Promise<ToolResult> => {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return runWithUserWords(said, () => tool.execute(args));
  };
  const linkedInTabs = async (): Promise<string[]> => (await userTabUrls(DEBUG_PORT)).filter((u) => u.includes('linkedin.com'));

  beforeAll(async () => {
    mock = await startLinkedInMock();
    ext = prepareExtensionCopy(BRIDGE_PORT);
    const policy = new CommunicationPolicy(() => ({ enabled: true, apps: {} }), [{ id: 'whatsapp', name: 'WhatsApp', hosts: [{ host: 'wa.localhost' }], processes: [], titleHints: [] } as CommunicationApp]);
    bridge = new ChromeBridge({ secrets: new MemorySecrets(), port: BRIDGE_PORT });
    if (!(await bridge.start())) throw new Error(`port ${BRIDGE_PORT} is busy`);
    const world = new BrowserWorldTracker();
    world.attach(bridge);
    bridge.openPairingWindow();
    browser = await startTestBrowser({
      kind: 'chrome',
      extensionDir: ext.dir,
      debugPort: DEBUG_PORT,
      extraArgs: [`--host-resolver-rules=MAP www.linkedin.com 127.0.0.1:${mock.port}`, '--ignore-certificate-errors'],
    });
    await waitFor(() => bridge.isConnected('chrome'), 45_000, 'the extension to connect and pair');

    const launcher: BrowserLauncher = { installed: async () => ['chrome'], running: async () => ['chrome'], launch: async () => false };
    const manager = new BrowserSessionManager({ bridge, world, isolated: forbiddenIsolatedBrowser, launcher, mode: 'user_browser', policy });

    const dir = mkdtempSync(join(tmpdir(), 'eya-social-pics-'));
    pictureName = 'card.png';
    picture = join(dir, pictureName);
    // (a real, tiny PNG)
    writeFileSync(picture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    const folders: KnownFolders = { home: dir, downloads: dir, desktop: dir, documents: dir, pictures: dir, videos: dir, music: dir, temp: dir };
    store = new SocialStore('social.json', new MemoryIo(), () => NOON);
    const publishGate = createPublishGate({ store, permits: () => null, now: () => NOON, userWords: currentUserWords });
    const all = [
      ...createBrowserTools(manager, undefined, { tabs: manager, session: manager, publishGate }),
      ...createSocialTools({ store, service: manager, folders, imageFolder: join(dir, 'Eya posts'), now: () => NOON, publishGate }),
    ];
    tools = new Map(all.map((t) => [t.schema.name, t]));
  }, 150_000);

  afterAll(async () => {
    browser?.kill();
    browser?.cleanup();
    await bridge?.stop?.();
    ext?.cleanup();
    mock?.close();
  });

  it('the person already has LinkedIn open: ONE call opens the post box in ONE new tab, types exactly the draft, adds the picture — and nothing is clicked that publishes', async () => {
    await userOpenTab(DEBUG_PORT, 'https://www.linkedin.com/feed/');
    await waitFor(async () => (await linkedInTabs()).length === 1, 20_000, "the person's own LinkedIn tab");
    const saved = await call('social_draft', { text: TEXT, title: 'Renting a home? Read this first.', hashtags: 'rentlaw', image_path: picture }, 'write a post about renting');
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    const id = (saved.data as { id: string }).id;

    const composed = await call('social_compose', { id }, 'post it on linkedin');
    expect(composed.ok, JSON.stringify(composed)).toBe(true);
    expect((composed.data as { status: string }).status).toBe('ready_not_published');
    expect((composed.data as { picture: string }).picture).toBe(`${pictureName} added`);
    await sleep(800);
    const state = mock.page();
    expect(state.editor.replace(/\s+/g, ' ').trim()).toBe((saved.data as { text: string }).text.replace(/\s+/g, ' ').trim());
    expect(state.image).toBe(pictureName);
    expect(mock.posted).toEqual([]);
    // (the person's own tab was left alone, and exactly one more was opened: never a tab for every try)
    expect((await linkedInTabs()).length).toBe(2);
    expect((composed.data as { steps: string[] }).steps.join(' | ')).not.toMatch(/Start a post/);
  }, 120_000);

  it('the real extension refuses a click on "Start a post" while the box covers it — which is exactly what looped; social_compose never makes that click', async () => {
    const r = await call('click_on_page', { text: 'Start a post' }, 'post it on linkedin');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toMatch(/covering/i);
  }, 60_000);

  it('asking again (a second post) reuses that tab: still two LinkedIn tabs in all, not three', async () => {
    const saved = await call('social_draft', { text: 'A second post about security deposits and written receipts.' }, 'another post');
    const composed = await call('social_compose', { id: (saved.data as { id: string }).id }, 'post it on linkedin');
    expect(composed.ok, JSON.stringify(composed)).toBe(true);
    expect((await linkedInTabs()).length).toBe(2);
  }, 120_000);

  it('Post asks with the exact text; a confirm without the person\'s yes does nothing; their yes publishes exactly it, once', async () => {
    // (the second draft is in the box now: the first is what the test publishes, so it is put back by compose)
    const first = store.drafts({ status: 'draft' })[0];
    expect(first).toBeDefined();
    const composed = await call('social_compose', { id: (first as { id: string }).id }, 'post it on linkedin');
    expect(composed.ok, JSON.stringify(composed)).toBe(true);
    await sleep(500);
    const asked = await call('click_on_page', { text: 'Post' }, 'post it on linkedin');
    expect(asked.ok).toBe(false);
    expect(JSON.stringify(asked)).toContain('Post this on LinkedIn as you?');
    expect(mock.posted).toEqual([]);
    const sneaky = await call('click_on_page', { text: 'Post', confirm: true }, 'hmm what about the hashtags');
    expect(sneaky.ok).toBe(false);
    expect(mock.posted).toEqual([]);
    const done = await call('click_on_page', { text: 'Post', confirm: true }, 'yes');
    expect(done.ok, JSON.stringify(done)).toBe(true);
    await waitFor(() => mock.posted.length === 1, 10_000, 'the post to reach the page');
    expect(mock.posted[0]).toMatchObject({ kind: 'post', image: pictureName });
    expect((mock.posted[0]?.text ?? '').replace(/\s+/g, ' ')).toBe((first as { text: string }).text.replace(/\s+/g, ' '));
    expect(store.ledger()).toHaveLength(1);
  }, 120_000);

  it('a draft with a client matter is refused before the page is touched', async () => {
    const before = (await userTabUrls(DEBUG_PORT)).length;
    const bad = await call('social_draft', { text: 'Today I won O.S. No. 123/2020 for my client.' });
    const r = await call('social_compose', { id: (bad.data as { id: string }).id }, 'post it');
    expect(r.ok).toBe(false);
    expect((await userTabUrls(DEBUG_PORT)).length).toBe(before);
  }, 60_000);

  it('the page really is what the extension saw: the box was found by its own name on a page it had not been told about', async () => {
    const names = (await userEval(DEBUG_PORT, 'linkedin.com', `[...document.querySelectorAll('[role=textbox]')].map((e) => e.getAttribute('aria-label'))`)) as string[];
    expect(names).toContain('Text editor for creating content');
  }, 30_000);
});
