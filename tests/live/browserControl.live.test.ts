/**
 * Step 1 of reliable browser control, in a REAL Chrome with the REAL extension and the REAL tools, against the local test site: open a website, read the
 * page, find and click a control (also by what it means), check from the page that it did something, recover from a failed navigation, and do all of it
 * without anyone sharing a screen — through the same AgentEngine the app uses, with a scripted AI standing in for the model.
 *
 * Opt-in: EYA_LIVE_BROWSER=1 npx vitest run tests/live/browserControl.live.test.ts
 * Not covered: a real signed-in profile, a real site, a real model (a scripted one stands in for it, so what is proved is what Eya's own code does).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { AgentEngine } from '../../src/main/agent/AgentEngine';
import { IntentRouter } from '../../src/main/agent/IntentRouter';
import { ResponseComposer } from '../../src/main/agent/ResponseComposer';
import { ChromeBridge } from '../../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../../src/main/chrome/ChromeBridge';
import { ChromeBrowserService } from '../../src/main/chrome/ChromeBrowserService';
import type { BrowserName } from '../../src/main/chrome/protocol';
import { ConversationContext } from '../../src/main/context/ConversationContext';
import type { AIChatMessage, AICompletion, AIProvider, AIToolCall, AIToolSpec } from '../../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../../src/main/providers/tts/TTSProvider';
import type { KnownFolders } from '../../src/main/security/pathPolicy';
import { createBrowserTools } from '../../src/main/tools/impl/browserTools';
import { createSiteTools } from '../../src/main/tools/impl/siteTools';
import { ToolRegistry } from '../../src/main/tools/ToolRegistry';
import type { ToolArgs, ToolResult } from '../../src/main/tools/types';
import { startTestSite } from '../fixtures/chrome-test-site/server.mjs';
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const BRIDGE_PORT = 47839;
const DEBUG_PORT = 9349;

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

const call = (name: string, args: Record<string, unknown> = {}): AIToolCall => ({ id: `id_${name}_${Math.random().toString(36).slice(2, 6)}`, name, args });
const step = (...toolCalls: AIToolCall[]): AICompletion => ({ text: '', toolCalls });
const say = (text: string): AICompletion => ({ text, toolCalls: [] });
const CLAIM = "I'm unable to interact with your browser. Could you please share your screen so I can see the page?";

class Recording implements AIProvider {
  readonly name = 'recording';
  readonly sent: AIChatMessage[][] = [];
  constructor(private readonly script: AICompletion[]) {}
  isReady(): boolean {
    return true;
  }
  async complete(messages: readonly AIChatMessage[], _tools: readonly AIToolSpec[]): Promise<AICompletion> {
    this.sent.push([...messages]);
    const next = this.script.shift();
    if (next === undefined) throw new Error('script exhausted');
    return next;
  }
}

const quietTTS: TTSProvider = { name: 'quiet', init: async () => undefined, speak: async () => undefined, prefetch: () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('reliable browser control: a real Chrome, the real tools, no screen sharing', () => {
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
    tools = new ToolRegistry();
    for (const t of createBrowserTools(svc)) tools.register(t);
    for (const t of createSiteTools({ service: svc, folders, downloadsDir: browser.downloads })) tools.register(t);
  }, 120_000);

  afterAll(async () => {
    browser?.kill();
    await bridge?.stop();
    site?.server.close();
    await sleep(500);
    browser?.cleanup();
    ext?.cleanup();
  }, 30_000);

  const engine = (ai: AIProvider): AgentEngine =>
    new AgentEngine({ router: new IntentRouter(), tools, composer: new ResponseComposer(), tts: quietTTS, context: new ConversationContext(), ai, now: () => new Date('2026-10-26T10:00:00Z') });
  const send = (e: AgentEngine, text: string) => e.handle({ requestId: `r${Math.random().toString(36).slice(2, 6)}`, text, source: 'text', mode: 'agent' }, () => undefined);
  const run = (name: string, args: ToolArgs = {}): Promise<ToolResult> => tools.invoke(name, args);

  it('the model wrongly asks for the screen: it is told what is true, then reads the REAL page itself and answers from it', async () => {
    const ai = new Recording([say(CLAIM), step(call('inspect_page')), say('The page is called Courts Portal.')]);
    const r = await send(engine(ai), `Open ${base}/menu.html and tell me the page title.`);
    expect(r.spoken).toBe('The page is called Courts Portal.');
    expect(r.spoken).not.toMatch(/share your screen/i);
    expect(ai.sent).toHaveLength(3);
    const seen = ai.sent[2]?.filter((m) => m.role === 'tool').map((m) => m.content).join('\n') ?? '';
    expect(seen).toContain('Courts Portal'); // what the tool really read from the real page
  }, 90_000);

  it('"open <site> and click X": Eya opens it, makes the one click herself, and answers from the page — no AI call, no screen sharing', async () => {
    const ai = new Recording([]);
    const t0 = Date.now();
    const r = await send(engine(ai), `Open ${base}/menu.html and click Open menu`);
    const took = Date.now() - t0;
    expect(ai.sent).toHaveLength(0);
    expect(r.ok).toBe(true);
    expect(r.spoken).toMatch(/I clicked "Open menu" and the page (changed|responded)\./);
    // the real page really is different now: the menu's own entries are showing
    const after = await svc.inspectPage();
    expect([...after.links, ...after.buttons].join(' ')).toContain('Services');
    expect(took).toBeLessThan(15_000);
  }, 90_000);

  it('finds a control by what it means: "cause-list" is the "Cause List" link, and the page it leads to is verified', async () => {
    await run('click_on_page', { text: 'Services' });
    const r = await run('click_on_page', { text: 'cause-list' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.data).toMatchObject({ navigated: true, stateChanged: true });
    expect((r.data?.['currentPage'] as { title?: string }).title).toBe('Cause List');
  }, 60_000);

  it('a click that changes nothing is said to have changed nothing — and a task that clicks it is not told it worked', async () => {
    await run('open_website', { url: `${base}/noop.html` });
    const direct = await run('click_on_page', { text: 'Refresh data' });
    expect(direct.ok).toBe(true);
    expect(direct.summary).toContain('nothing on the page changed');
    expect(direct.data).toMatchObject({ nothingChanged: true, stateChanged: false, navigated: false });

    const ai = new Recording([say('I clicked it, but nothing on the page changed, so I cannot say it worked.')]);
    const r = await send(engine(ai), `Open ${base}/noop.html and click Refresh data`);
    expect(ai.sent).toHaveLength(1); // the model was asked: Eya did not claim it done
    expect(String(ai.sent[0]?.[ai.sent[0].length - 1]?.content)).toContain('Nothing on the page changed');
    expect(r.spoken).not.toMatch(/^I opened .*I clicked/);
  }, 90_000);

  it('a click is about a second, not three: the wait for a download is only for a click that looks like one', async () => {
    await run('open_website', { url: `${base}/menu.html` });
    const times: number[] = [];
    for (const text of ['Open menu', 'Services', 'Cause List']) {
      const t0 = Date.now();
      const r = await run('click_on_page', { text });
      times.push(Date.now() - t0);
      expect(r.ok, `${text}: ${JSON.stringify(r)}`).toBe(true);
    }
    // eslint-disable-next-line no-console
    console.log(`  three clicks: ${times.join(' ms, ')} ms`);
    expect(times.reduce((a, b) => a + b, 0) / times.length).toBeLessThan(1800); // it was about 3,000 each
  }, 90_000);

  it('a click that DOES fetch a file still waits for it and reports it (the download link of a page)', async () => {
    await run('open_website', { url: `${base}/download.html` });
    const r = await run('click_on_page', { text: 'Download report' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.data?.['download']).toMatchObject({ name: 'eya-test-report.txt', state: 'complete' });
  }, 90_000);

  it('a file that begins later than a click waited is not lost: the NEXT action reports it, once', async () => {
    // (its own origin: Chrome allows a page's first automatic download and blocks a second one from the same origin, and the test above has just made one)
    await svc.openWebsite(`http://late.localhost:${site.port}/latedownload.html`);
    const first = await svc.clickOnPage('Generate'); // plain wording: not waited on for a download
    expect(first.ok && first.effects?.download).toBeFalsy();
    await sleep(2600); // the page starts its file about 1.6 s after the click
    const next = await svc.clickOnPage('Next');
    const late = next.ok ? next.effects?.download : undefined;
    expect(late?.state).toBe('complete');
    expect(late?.name).toMatch(/^eya-test-report.*\.txt$/); // (the server names the file; an earlier test saved one of that name, so the browser numbers this one)
    const again = await svc.clickOnPage('Next');
    expect(again.ok && again.effects?.download).toBeFalsy();
  }, 90_000);

  it('a page that fails the first time is recovered and verified; one that never works is said not to have opened — never "opened"', async () => {
    const flaky = await run('find_and_open_website', { url: `${base}/r/flaky` });
    expect(flaky.ok, JSON.stringify(flaky)).toBe(true);
    expect((flaky.data?.['currentPage'] as { title?: string }).title).toBe('Recovered');

    // a page the site answers with an error is an error, not an opened page (the extension now reports what the site answered)
    const missing = await run('find_and_open_website', { url: `${base}/r/status?code=404` });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('answered "404"');

    // an address nothing answers at: not reached, said so (not "opened as a blank page"), and never reported as opened
    const dead = await run('find_and_open_website', { url: 'http://127.0.0.1:59999/' });
    expect(dead.ok).toBe(false);
    expect(dead.error).toContain('could not be reached');
    expect(dead.error).not.toContain('blank page');

    // through the engine: the model is told where it stopped and is not given a page that did not open
    const ai = new Recording([say('The site did not open, so I could not click anything.')]);
    const r = await send(engine(ai), 'Open http://127.0.0.1:59999/ and click Cause List');
    expect(String(ai.sent[0]?.[ai.sent[0].length - 1]?.content)).toContain('could not finish');
    expect(r.spoken).not.toMatch(/I clicked/);
  }, 180_000);
});
