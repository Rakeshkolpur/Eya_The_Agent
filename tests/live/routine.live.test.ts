/**
 * The whole "Eya learns a routine" loop with the REAL extension in a REAL Chrome, through Eya's real browser tools, the real
 * AgentEngine and a real SQLite file — against the fixture courts portal (home → Services menu → Cause List → a Date field):
 *
 *   do the task three times (the model is scripted; the browser is real) → Eya offers → "yes" → saved to the database
 *   → the same request is now run by the routine with NO model call → the date is today's, not the day it was learned
 *   → it survives a restart → a broken step falls back to the normal agent and offers to update → a routine can never
 *   say yes to a "Place order" click for the user.
 *
 * Opt-in: EYA_LIVE_BROWSER=1 npx vitest run tests/live/routine.live.test.ts
 * Not covered: a real court website, Edge, a real model (the model is scripted so the run is repeatable).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEngine } from '../../src/main/agent/AgentEngine';
import { IntentRouter } from '../../src/main/agent/IntentRouter';
import { ResponseComposer } from '../../src/main/agent/ResponseComposer';
import { ChromeBridge } from '../../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../../src/main/chrome/ChromeBridge';
import { BrowserWorldTracker } from '../../src/main/chrome/browserWorld';
import { BrowserSessionManager } from '../../src/main/browser/BrowserSessionManager';
import type { BrowserLauncher } from '../../src/main/browser/BrowserSessionManager';
import type { BrowserAutomationService } from '../../src/main/browser/BrowserAutomationService';
import type { BrowserName } from '../../src/main/chrome/protocol';
import { ConversationContext } from '../../src/main/context/ConversationContext';
import { MemoryService } from '../../src/main/memory/MemoryService';
import type { AIChatMessage, AICompletion, AIProvider, AIToolCall } from '../../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../../src/main/providers/tts/TTSProvider';
import { LoopGuard } from '../../src/main/browser/loopGuard';
import { createBrowserTools } from '../../src/main/tools/impl/browserTools';
import { createMemoryTools } from '../../src/main/tools/impl/memoryTools';
import { ToolRegistry } from '../../src/main/tools/ToolRegistry';
import { startTestSite } from '../fixtures/chrome-test-site/server.mjs';
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, userEval, userNavigate, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const BRIDGE_PORT = 47838;
const DEBUG_PORT = 9347;

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

const forbiddenIsolatedBrowser = new Proxy(
  {},
  { get: (_t, prop) => (prop === 'close' ? async () => undefined : () => Promise.reject(new Error(`Eya's separate browser window must not be used (${String(prop)})`))) },
) as BrowserAutomationService;

const call = (name: string, args: Record<string, unknown> = {}): AIToolCall => ({ id: `id_${name}_${Math.random().toString(36).slice(2, 6)}`, name, args });
const step = (toolCalls: AIToolCall[], text = ''): AICompletion => ({ text, toolCalls });
const say = (text: string): AICompletion => ({ text, toolCalls: [] });

class ScriptedAI implements AIProvider {
  readonly name = 'scripted';
  readonly seen: AIChatMessage[][] = [];
  constructor(public script: Array<AICompletion | Error> = []) {}
  isReady(): boolean {
    return true;
  }
  async complete(messages: readonly AIChatMessage[]): Promise<AICompletion> {
    this.seen.push([...messages]);
    const next = this.script.shift();
    if (next === undefined) throw new Error('the model was called but the script is exhausted');
    if (next instanceof Error) throw next;
    return next;
  }
}

class FakeTTS implements TTSProvider {
  readonly name = 'fake';
  readonly spoken: string[] = [];
  init = async (): Promise<void> => undefined;
  speak = async (text: string): Promise<void> => {
    this.spoken.push(text);
  };
  stop = (): void => undefined;
  isReady = (): boolean => true;
  dispose = async (): Promise<void> => undefined;
}

const ddmmyyyy = (d: Date): string => `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('learning a routine: real extension, real Chrome, real browser tools, real SQLite', () => {
  let site: { server: Server; port: number };
  let bridge: ChromeBridge;
  let world: BrowserWorldTracker;
  let browser: TestBrowser;
  let ext: { dir: string; cleanup: () => void };
  let manager: BrowserSessionManager;
  let registry: ToolRegistry;
  let work = '';
  let dbPath = '';
  let svc: MemoryService;
  let engine: AgentEngine;
  let ai: ScriptedAI;
  let tts: FakeTTS;
  let nowMs = Date.now();
  // The browser tools' loop guard refuses a third identical click from the same page within two minutes. A person repeating a task is
  // minutes or days apart, not seconds, so each request lets time pass first (one test asks quickly, to see what happens then).
  let guardMs = Date.now();

  const portal = () => `http://localhost:${site.port}/portal/`;
  const forms = () => `http://localhost:${site.port}/forms.html`;
  const inPage = (expression: string) => userEval(DEBUG_PORT, 'localhost', expression);
  const title = () => inPage('document.title');
  const dateField = () => inPage(`document.querySelector('[name=d]') ? document.querySelector('[name=d]').value : null`);
  const toPortalHome = async () => {
    await userNavigate(DEBUG_PORT, portal(), 'localhost');
    // Just after navigating, the tab can briefly have no address that matches: that is "not yet", not a failure.
    await waitFor(
      async () => {
        try {
          return (await title()) === 'Welcome to the State Portal';
        } catch {
          return false;
        }
      },
      15_000,
      'the portal home page',
    );
  };
  const ask = (text: string, quickly = false) => {
    if (!quickly) guardMs += 3 * 60_000;
    return engine.handle({ requestId: `r-${Math.random().toString(36).slice(2, 6)}`, text, source: 'text' }, () => undefined);
  };
  const startMemory = (): MemoryService => MemoryService.open(dbPath, { tools: registry, now: () => new Date(nowMs) });
  const makeEngine = (): AgentEngine => {
    ai = new ScriptedAI();
    tts = new FakeTTS();
    return new AgentEngine({ router: new IntentRouter(), tools: registry, composer: new ResponseComposer(), tts, context: new ConversationContext(), ai, memory: svc, now: () => new Date(nowMs) });
  };

  /** What the model does for "check the cause list": open the portal, click Cause List (it sits in the Services menu), type the date. */
  const modelDoesIt = (today: Date): AICompletion[] => [
    step([call('open_website', { url: portal() })]),
    step([call('click_on_page', { text: 'Cause List' })]),
    step([call('fill_on_page', { label: 'Date', value: ddmmyyyy(today) })]),
    say("Here is today's cause list."),
  ];

  beforeAll(async () => {
    site = await startTestSite(0);
    ext = prepareExtensionCopy(BRIDGE_PORT);
    work = mkdtempSync(join(tmpdir(), 'eya-routine-live-'));
    dbPath = join(work, 'data', 'eya_memory.db');

    bridge = new ChromeBridge({ secrets: new MemorySecrets(), port: BRIDGE_PORT });
    if (!(await bridge.start())) throw new Error(`port ${BRIDGE_PORT} is busy`);
    world = new BrowserWorldTracker();
    world.attach(bridge);
    bridge.openPairingWindow();
    browser = await startTestBrowser({ kind: 'chrome', extensionDir: ext.dir, debugPort: DEBUG_PORT });
    await waitFor(() => bridge.isConnected('chrome'), 45_000, 'the extension to connect and pair');

    const launcher: BrowserLauncher = { installed: async () => ['chrome'], running: async () => ['chrome'], launch: async () => false };
    manager = new BrowserSessionManager({ bridge, world, isolated: forbiddenIsolatedBrowser, launcher, mode: 'user_browser' });
    registry = new ToolRegistry();
    for (const tool of createBrowserTools(manager, new LoopGuard(() => guardMs), { tabs: manager, session: manager })) registry.register(tool);
    svc = startMemory();
    for (const tool of createMemoryTools(svc)) registry.register(tool);
    engine = makeEngine();
  }, 120_000);

  afterAll(async () => {
    svc?.close();
    browser?.kill();
    await bridge?.stop();
    site?.server.close();
    await sleep(1500);
    for (const cleanup of [() => browser?.cleanup(), () => ext?.cleanup(), () => (work !== '' ? rmSync(work, { recursive: true, force: true }) : undefined)]) {
      try {
        cleanup();
      } catch {
        // Windows may still hold a file for a moment; a leftover temp folder is not a test failure.
      }
    }
  }, 30_000);

  it('does the task three times with the model, then offers to save it — and the browser really did it each time', async () => {
    const today = new Date(nowMs);
    const phrasings = ["Check today's Telangana High Court cause list", 'check the high court cause list', 'check todays cause list'];
    ai.script.push(...phrasings.flatMap(() => modelDoesIt(today)));
    for (const [i, said] of phrasings.entries()) {
      const r = await ask(said);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(await title(), `after run ${i + 1}`).toBe('Cause List');
      expect(await dateField(), `after run ${i + 1}`).toBe(ddmmyyyy(today));
      if (i < 2) {
        expect(r.spoken).toBe("Here is today's cause list.");
        expect(svc.skills.count()).toBe(0);
      } else {
        expect(r.spoken).toBe("Here is today's cause list. You've done this several times. Would you like me to save it as a routine?");
      }
    }
  }, 180_000);

  it('"yes" saves it to the database, as steps made of high-level actions — never screen coordinates — with the date as a placeholder', async () => {
    const r = await ask('yes please');
    expect(r.spoken).toContain('Saved as');
    const routine = svc.skills.listDetails()[0];
    expect(routine?.name).toBe('check_todays_telangana_high_court_cause_list');
    expect(routine?.triggers).toHaveLength(3);
    expect(routine?.steps.map((s) => [s.action, s.target, s.value])).toEqual([
      ['open_url', portal(), ''],
      ['click_text', 'Cause List', ''],
      ['type_text', 'Date', '{{today:dd-mm-yyyy}}'],
    ]);
    expect(routine?.steps[0]).toMatchObject({ verifyKind: 'url_contains', verifyText: 'localhost' });
    expect(JSON.stringify(routine?.steps)).not.toMatch(/\bx\b|\by\b|coordinate|pixel/i);
  }, 60_000);

  it('the same request is now done by the routine alone: real clicks, a real typed date, and the model is never called', async () => {
    await toPortalHome();
    expect(await dateField()).toBeNull();
    const calls = ai.seen.length;
    const t0 = Date.now();
    const r = await ask("Check today's Telangana High Court cause list");
    const ms = Date.now() - t0;
    expect(ai.seen.length).toBe(calls); // no model call
    expect(r).toMatchObject({ ok: true, spoken: 'Done.' });
    expect(await title()).toBe('Cause List');
    expect(await dateField()).toBe(ddmmyyyy(new Date(nowMs)));
    expect(svc.skills.listDetails()[0]).toMatchObject({ useCount: 1, successCount: 1, failureCount: 0 });
    console.info(`[live] routine ran 3 steps in the real browser in ${ms} ms with no model call`);
  }, 120_000);

  it('a later day gets that day\'s date: the routine learned "today", not the day it was learned', async () => {
    nowMs += 24 * 3_600_000;
    await toPortalHome();
    const r = await ask('check todays cause list');
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, spoken: 'Done.' });
    expect(await dateField()).toBe(ddmmyyyy(new Date(nowMs)));
    expect(await dateField()).not.toBe(ddmmyyyy(new Date(nowMs - 24 * 3_600_000)));
  }, 120_000);

  it('survives a restart: close the database, open the same file, and it still runs', async () => {
    svc.close();
    svc = startMemory();
    engine = makeEngine();
    expect(svc.skills.count()).toBe(1);
    expect(svc.skills.listDetails()[0]).toMatchObject({ useCount: 2, successCount: 2 }); // the history is in the file too
    await toPortalHome();
    const r = await ask('Check the high court cause list'); // another of the wordings it was taught
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, spoken: 'Done.' });
    expect(await title()).toBe('Cause List');
    expect(ai.seen.length).toBe(0);
  }, 120_000);

  it('a switched-off routine is not run (the request goes to the model instead)', async () => {
    const id = svc.skills.listDetails()[0]?.id ?? 0;
    svc.skills.setEnabled(id, false);
    await toPortalHome();
    ai.script.push(say('I would need to do that step by step.'));
    const r = await ask('check todays cause list');
    expect(ai.seen.length).toBe(1);
    expect(r.spoken).toBe('I would need to do that step by step.');
    expect(await title()).toBe('Welcome to the State Portal'); // nothing was clicked
    svc.skills.setEnabled(id, true);
  }, 60_000);

  it('when the site changes under it, the routine stops, records the failure, hands over to the normal agent, and offers to update', async () => {
    const id = svc.skills.listDetails()[0]?.id ?? 0;
    const original = svc.skills.stepsOf(id).map((s) => ({ action: s.action, target: s.target, value: s.value, submit: s.submit, verifyKind: s.verifyKind, verifyText: s.verifyText }));
    // The site "renamed" the link: the saved step looks for one that is no longer there.
    svc.skills.replaceSteps(id, original.map((s) => (s.target === 'Cause List' ? { ...s, target: 'Daily Causelist Portal' } : s)));
    await toPortalHome();
    ai.script.push(...modelDoesIt(new Date(nowMs)).slice(1)); // the model carries on from the portal home the routine had already opened
    const before = svc.skills.get(id);
    const base = ai.seen.length;
    const r = await ask('check todays cause list');
    expect(ai.seen.length).toBeGreaterThan(base); // the model was brought in
    expect(ai.seen[base]?.[0]?.content).toContain('stopped at step 2 of 3 (1 done)');
    expect(ai.seen[base]?.at(-1)).toMatchObject({ role: 'user', content: 'check todays cause list' }); // the user is not asked to repeat anything
    expect(await title()).toBe('Cause List');
    expect(await dateField()).toBe(ddmmyyyy(new Date(nowMs)));
    expect(svc.skills.get(id)?.failureCount).toBe((before?.failureCount ?? 0) + 1);
    expect(r.spoken).toContain('update the routine');

    const yes = await ask('yes');
    expect(yes.spoken).toContain('updated');
    expect(svc.skills.stepsOf(id).map((s) => s.target)).toEqual([portal(), 'Cause List', 'Date']); // the part that worked, then the model's way
    // And now it works on its own again.
    await toPortalHome();
    const calls = ai.seen.length;
    expect((await ask('check todays cause list')).spoken).toBe('Done.');
    expect(ai.seen.length).toBe(calls);
    expect(await title()).toBe('Cause List');
  }, 240_000);

  it('a routine can never say yes for the user: a saved "Place order" click is refused, nothing is bought, and the agent is told to ask', async () => {
    const made = svc.skills.create({
      name: 'order_it',
      triggers: ['order it now'],
      steps: [
        { action: 'open_url', target: forms(), value: '', submit: false, verifyKind: 'url_contains', verifyText: 'forms.html' },
        { action: 'click_text', target: 'Place order', value: '', submit: false, verifyKind: 'none', verifyText: '' },
      ],
    });
    ai.script.push(say('That would place an order. Do you want me to go ahead?'));
    const calls = ai.seen.length;
    const r = await ask('order it now');
    await sleep(500);
    expect(await inPage(`document.getElementById('out') ? document.getElementById('out').textContent : null`)).not.toBe('Bought it');
    expect(ai.seen.length).toBe(calls + 1); // handed to the agent…
    expect(ai.seen[calls]?.[0]?.content).toContain("it needs the user's say-so"); // …with the question the tool raised
    expect(r.spoken).toBe('That would place an order. Do you want me to go ahead?');
    expect(svc.skills.get(made.id)).toMatchObject({ useCount: 1, successCount: 0, failureCount: 0 }); // paused for the user: neither a success nor a failure
  }, 120_000);

  it('asked again and again within seconds, the third run is stopped by the loop guard: it says so plainly and the routine is not blamed', async () => {
    guardMs += 10 * 60_000; // start clean
    const id = svc.skills.listDetails().find((r) => r.name !== 'order_it')?.id ?? 0;
    const before = svc.skills.get(id);
    const calls = ai.seen.length;
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      await toPortalHome();
      results.push(await ask('check todays cause list', true));
    }
    expect(results[0]?.spoken).toBe('Done.');
    expect(results[1]?.spoken).toBe('Done.');
    expect(results[2]).toMatchObject({ ok: false });
    expect(results[2]?.spoken).toContain('a few times in a row');
    expect(ai.seen.length).toBe(calls); // no model was asked to keep going round in circles
    const after = svc.skills.get(id);
    expect(after?.failureCount).toBe(before?.failureCount);
    expect(after?.successCount).toBe((before?.successCount ?? 0) + 2);
  }, 240_000);
});
