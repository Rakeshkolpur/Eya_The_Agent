import { beforeEach, describe, expect, it } from 'vitest';
import { BridgeError } from '../src/main/chrome/ChromeBridge';
import { ChromeBrowserService } from '../src/main/chrome/ChromeBrowserService';
import type { BridgeLike } from '../src/main/chrome/ChromeBrowserService';
import { createOpenApplicationTool } from '../src/main/tools/impl/openApplication';
import type { KnownApp, OpenApplicationDeps } from '../src/main/tools/impl/openApplication';

/**
 * Two things that failed on the user's real PC and were never exercised: (1) a chat row that was found and then "could not be opened" because the
 * click wanted the row's WHOLE text (preview, time, unread count) to be unchanged; (2) "open whatsapp" reported as failed, after a 6 second wait,
 * while WhatsApp was already open on the screen.
 */

type RawEl = Record<string, unknown>;
const rawState = (elements: RawEl[]): Record<string, unknown> => ({
  url: 'https://web.whatsapp.com/',
  title: 'WhatsApp',
  epoch: 1,
  headings: [],
  elements: elements.map((e, i) => ({ id: `e${i}`, inViewport: true, ...e })),
  dialogs: [],
  visibleText: '',
  tables: [],
  focused: null,
  scroll: { y: 0, max: 0, atBottom: true },
  challenge: null,
  loading: false,
  notes: [],
});

class FakeBridge implements BridgeLike {
  calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  observed: Array<Record<string, unknown>> = [];
  clickReplies: Array<(args: Record<string, unknown>) => unknown> = [];
  isConnected() {
    return true;
  }
  async request<T = unknown>(op: string, args: Readonly<Record<string, unknown>> = {}): Promise<T> {
    this.calls.push({ op, args: { ...args } });
    if (op === 'observe') {
      const state = this.observed.length > 1 ? this.observed.shift() : this.observed[0];
      return { tabId: 7, state } as T;
    }
    if (op === 'click') {
      const reply = this.clickReplies.length > 1 ? this.clickReplies.shift() : this.clickReplies[0];
      if (reply === undefined) throw new BridgeError('extension_error', 'no reply');
      return reply(args) as T;
    }
    throw new Error(`unexpected request: ${op}`);
  }
}

const ok = (state: Record<string, unknown>) => ({ performed: { ok: true }, tabId: 7, state, settled: true });
const stale = (state: Record<string, unknown>) => ({ performed: { ok: false, reason: 'stale_element', detail: 'changed' }, tabId: 7, state, settled: true });

let bridge: FakeBridge;
let svc: ChromeBrowserService;
beforeEach(() => {
  bridge = new FakeBridge();
  svc = new ChromeBrowserService(bridge, { quickFor: () => true });
});

describe('ChromeBrowserService.clickItem', () => {
  const list = (time: string) =>
    rawState([
      { role: 'clickable', name: 'Chats', region: 'nav' },
      { role: 'clickable', name: `Ramesh Anna ok ${time}`, primary: 'Ramesh Anna' },
      { role: 'clickable', name: `Anna call me ${time} 1 unread message`, primary: 'Anna' },
    ]);

  it('clicks the row that is that chat in the page as it is now, with its CURRENT name (so a row that only changed its preview or time is still the row)', async () => {
    bridge.observed = [list('10:44')];
    bridge.clickReplies = [(a) => ok(rawState([{ role: 'clickable', name: String(a['name']), primary: 'Anna' }]))];
    const result = await svc.clickItem({ primary: 'Anna', name: 'Anna call me 10:42' }); // the words of an earlier look
    expect(result.ok).toBe(true);
    const click = bridge.calls.find((c) => c.op === 'click');
    expect(click?.args).toMatchObject({ id: 'e2', name: 'Anna call me 10:44 1 unread message', quick: true });
  });

  it('never opens "Ramesh Anna" for "Anna"', async () => {
    bridge.observed = [rawState([{ role: 'clickable', name: 'Ramesh Anna ok 10:44', primary: 'Ramesh Anna' }])];
    bridge.clickReplies = [() => ok(rawState([]))];
    const result = await svc.clickItem({ primary: 'Anna' });
    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
    expect(bridge.calls.some((c) => c.op === 'click')).toBe(false);
  });

  it('when the page moves between the look and the click, looks again and clicks the row as it now is (twice at most)', async () => {
    bridge.observed = [list('10:44'), list('10:45')];
    bridge.clickReplies = [() => stale(list('10:45')), (a) => ok(rawState([{ role: 'clickable', name: String(a['name']), primary: 'Anna' }]))];
    const result = await svc.clickItem({ primary: 'Anna' });
    expect(result.ok).toBe(true);
    expect(bridge.calls.filter((c) => c.op === 'click').map((c) => c.args['name'])).toEqual(['Anna call me 10:44 1 unread message', 'Anna call me 10:45 1 unread message']);
  });

  it('a row that keeps going stale is not clicked for ever', async () => {
    bridge.observed = [list('10:44')];
    bridge.clickReplies = [() => stale(list('10:44'))];
    const result = await svc.clickItem({ primary: 'Anna' });
    expect(result.ok).toBe(false);
    expect(bridge.calls.filter((c) => c.op === 'click')).toHaveLength(3); // the first, and two more
  });

  it('asks the send gate first when it is given one (opening a chat is not a send, so it normally is not asked)', async () => {
    bridge.observed = [list('10:44')];
    bridge.clickReplies = [() => ok(rawState([]))];
    const result = await svc.clickItem({ primary: 'Anna' }, () => 'a reason to ask');
    expect(result).toMatchObject({ ok: false, reason: 'needs_confirmation' });
    expect(bridge.calls.some((c) => c.op === 'click')).toBe(false);
  });
});

describe('"open WhatsApp" when WhatsApp is already open', () => {
  const whatsapp = { name: 'WhatsApp', appId: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' };
  function deps(running: string[], afterLaunch: { newProcess: string | null; runningNow?: string[] }) {
    const launched: string[] = [];
    let waited = 0;
    const calls = { list: 0 };
    const d: OpenApplicationDeps = {
      isInstalled: async (_app: KnownApp) => true,
      start: () => ({ ok: true }),
      waitForProcess: async () => true,
      listStartApps: async () => [whatsapp],
      launchStartApp: (id) => (launched.push(id), { ok: true }),
      listRunningProcessNames: async () => (calls.list++ === 0 ? running : (afterLaunch.runningNow ?? running)),
      waitForNewProcess: async () => ((waited += 1), afterLaunch.newProcess),
      launchBrowser: async () => true,
      openExternal: async () => undefined,
    };
    return { d, launched, waited: () => waited };
  }

  it('is a success, at once: launching it brought its window forward, and there is no new process to wait six seconds for', async () => {
    const f = deps(['explorer.exe', 'WhatsApp.Root.exe'], { newProcess: null });
    const result = await createOpenApplicationTool(f.d).execute({ name: 'WhatsApp' });
    expect(result).toMatchObject({ ok: true, data: { app: 'WhatsApp', alreadyRunning: true, exe: 'WhatsApp.Root.exe' } });
    expect(f.launched).toEqual([whatsapp.appId]); // it was still launched (that is what brings the window forward)
    expect(f.waited()).toBe(0);
  });

  it('an app that was not running and starts is still verified by its new process', async () => {
    const f = deps(['explorer.exe'], { newProcess: 'WhatsApp.Root.exe' });
    expect(await createOpenApplicationTool(f.d).execute({ name: 'WhatsApp' })).toMatchObject({ ok: true, summary: 'WhatsApp is running' });
    expect(f.waited()).toBe(1);
  });

  it('a slow app that shows under its own name a moment late is not called a failure', async () => {
    const f = deps(['explorer.exe'], { newProcess: null, runningNow: ['explorer.exe', 'WhatsApp.Root.exe'] });
    expect(await createOpenApplicationTool(f.d).execute({ name: 'WhatsApp' })).toMatchObject({ ok: true, data: { exe: 'WhatsApp.Root.exe' } });
  });

  it('an app that did not start at all is still reported as not opened', async () => {
    const f = deps(['explorer.exe'], { newProcess: null });
    expect(await createOpenApplicationTool(f.d).execute({ name: 'WhatsApp' })).toMatchObject({ ok: false, summary: 'launched but not verified' });
  });
});
