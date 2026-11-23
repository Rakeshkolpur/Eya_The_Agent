import { describe, expect, it } from 'vitest';
import type { BrowserAutomationService } from '../src/main/browser/BrowserAutomationService';
import { pinnedHome, pinnedTab, runInTab } from '../src/main/browser/tabScope';
import { ChatSession } from '../src/main/chat/chatSession';
import { ChromeBrowserService } from '../src/main/chrome/ChromeBrowserService';
import type { BridgeLike } from '../src/main/chrome/ChromeBrowserService';
import type { BridgeBrowserEvent, BridgeConnectionEvent } from '../src/main/chrome/ChromeBridge';
import { createChatActions, createChatWatcher } from '../src/main/livechat/liveChatWiring';
import { rig, settle } from './liveChatFixtures';
import { createChatMedia } from '../src/main/livechat/liveChatMedia';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';

/**
 * "When other tabs are open it is not working": a live chat is in ONE browser tab (WhatsApp), but looking at the chat, typing and pressing Send used to act on "the tab Eya is working
 * in, else the tab the person is looking at". Opening another tab (or Eya opening a site for another request) made the chat look "not open", so it paused with a reply written and
 * nothing sent. Now everything the live chat does on the page is pinned to its own tab.
 */

const WA_TAB = 41; // the WhatsApp tab
const OTHER_TAB = 99; // whatever else is in front

describe('work pinned to a tab', () => {
  it('is pinned inside and not outside, and nests', async () => {
    expect(pinnedTab()).toBeNull();
    await runInTab(5, async () => {
      expect(pinnedTab()).toBe(5);
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      expect(pinnedTab()).toBe(5); // (still, after awaits and timers)
      await runInTab(6, async () => expect(pinnedTab()).toBe(6));
      expect(pinnedTab()).toBe(5);
      await runInTab(null, async () => expect(pinnedTab()).toBe(5)); // (no tab = no change)
    });
    expect(pinnedTab()).toBeNull();
  });

  it('two pieces of work at the same time do not see each other\'s tab', async () => {
    const seen: Array<number | null> = [];
    await Promise.all([
      runInTab(1, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(pinnedTab());
      }),
      (async () => {
        await new Promise((r) => setTimeout(r, 2));
        seen.push(pinnedTab()); // another request, not in the scope
      })(),
    ]);
    expect(seen).toEqual([null, 1]);
  });
});

class FakeBridge implements BridgeLike {
  calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  isConnected(): boolean {
    return true;
  }
  async request<T = unknown>(op: string, args: Readonly<Record<string, unknown>> = {}): Promise<T> {
    this.calls.push({ op, args: { ...args } });
    return { tabId: typeof args['tabId'] === 'number' ? args['tabId'] : OTHER_TAB, state: { url: 'https://web.whatsapp.com/', title: 'WhatsApp', epoch: 1, headings: [], elements: [], dialogs: [], visibleText: '', tables: [], focused: null, scroll: { y: 0, max: 0, atBottom: true }, challenge: null, loading: false, notes: [] } } as T;
  }
}

describe('the browser service acts on the pinned tab', () => {
  it('looks at the pinned tab, not the one in front; outside the pin it is as before', async () => {
    const bridge = new FakeBridge();
    const svc = new ChromeBrowserService(bridge);
    await runInTab(WA_TAB, () => svc.inspectPage());
    await svc.inspectPage();
    expect(bridge.calls[0]).toMatchObject({ op: 'observe', args: { tabId: WA_TAB } });
    expect(bridge.calls[1]!.args['tabId']).toBeUndefined();
  });

  it('a call that names its own tab keeps it, and opening / focusing / closing tabs are never pinned', async () => {
    const bridge = new FakeBridge();
    const svc = new ChromeBrowserService(bridge);
    await runInTab(WA_TAB, async () => {
      await svc.chatRead(10, 7);
      await svc.openWebsite('https://example.com/');
    });
    expect(bridge.calls[0]).toMatchObject({ op: 'chat_read', args: { tabId: 7 } });
    expect(bridge.calls[1]!.op).toBe('open_url');
    expect(bridge.calls[1]!.args['tabId']).toBeUndefined();
  });
});

function actions(tab: () => number | null) {
  const seen: Array<{ name: string; tab: number | null }> = [];
  const script = new Map<string, ToolResult[]>();
  const a = createChatActions({
    tools: {
      invoke: async (name: string, _args: ToolArgs): Promise<ToolResult> => {
        seen.push({ name, tab: pinnedTab() });
        const next = script.get(name)?.shift();
        return next ?? { ok: true, summary: name, data: { status: name === 'verify_sent' ? 'sent' : 'opened', chat: 'Rahul', verified: true, headerChecked: true } };
      },
    },
    service: {
      inspectPage: async () => {
        seen.push({ name: 'inspectPage', tab: pinnedTab() });
        return { url: 'https://web.whatsapp.com/', title: 'WhatsApp', headings: [], buttons: [], links: [], inputs: [], notes: [], environment: 'your_browser' };
      },
    } as unknown as BrowserAutomationService,
    session: new ChatSession(),
    sleep: async () => undefined,
    tab,
  });
  return { a, seen, script };
}

describe('the live chat acts in its own tab', () => {
  it('looking at the chat, typing in the box, pressing Send and checking it all run pinned to the chat\'s tab', async () => {
    const { a, seen } = actions(() => WA_TAB);
    await a.isOpen('Rahul').catch(() => undefined);
    await a.typeInBox('hello');
    await a.typeAndSend('Rahul', 'hello');
    await a.verify('hello');
    expect(seen.map((s) => s.name)).toEqual(expect.arrayContaining(['inspectPage', 'fill_on_page', 'click_on_page', 'verify_sent']));
    expect(seen.every((s) => s.tab === WA_TAB)).toBe(true);
  });

  it('with no tab known yet (the very first look) nothing is pinned: as before', async () => {
    const { a, seen } = actions(() => null);
    await a.isOpen('Rahul').catch(() => undefined);
    await a.typeAndSend('Rahul', 'hello');
    expect(seen.every((s) => s.tab === null)).toBe(true);
  });

  it('finding the next chat is done in the chat\'s tab; when that tab is not WhatsApp any more, WhatsApp is opened the usual way and looked at where it opened', async () => {
    const { a, seen, script } = actions(() => WA_TAB);
    script.set('find_chat', [{ ok: false, summary: 'not a chat app', error: 'The page in front is not a chat app.', data: {} }]);
    await a.open('Rahul');
    expect(seen.map((s) => `${s.name}:${s.tab}`)).toEqual([`find_chat:${WA_TAB}`, 'open_website:null', 'find_chat:null']);
  });

  it('the person\'s other tab does not matter: the tab is read when the action runs, not when the chat was set up', async () => {
    let current: number | null = WA_TAB;
    const { a, seen } = actions(() => current);
    await a.typeInBox('one');
    current = 55; // (the chat moved to another tab)
    await a.typeInBox('two');
    expect(seen.map((s) => s.tab)).toEqual([WA_TAB, 55]);
  });
});

describe('the watcher keeps the chat\'s tab while it is paused', () => {
  function watcher() {
    const listeners: Array<(e: BridgeBrowserEvent) => void> = [];
    const conn: Array<(e: BridgeConnectionEvent) => void> = [];
    const starts: Array<number | undefined> = [];
    const service = {
      chatWatch: async (mode: string, tabId?: number) => {
        if (mode === 'start') starts.push(tabId);
        return { ok: true, watching: mode === 'start', tabId: tabId ?? WA_TAB, browser: 'chrome', hasMain: true };
      },
      chatRead: async () => ({ ok: true }),
    } as unknown as BrowserAutomationService;
    const w = createChatWatcher(
      {
        onBrowserEvent: (l) => {
          listeners.push(l);
          return () => undefined;
        },
        onConnectionChange: (l) => {
          conn.push(l);
          return () => undefined;
        },
      },
      service as never,
    );
    return {
      w,
      starts,
      removed: (tabId: number) => listeners.forEach((l) => l({ name: 'tab_removed', data: { tabId }, browser: 'chrome' } as BridgeBrowserEvent)),
      disconnected: () => conn.forEach((l) => l({ connected: false, browser: 'chrome' } as BridgeConnectionEvent)),
    };
  }

  it('is not known before the chat starts, is known while watching and AFTER the watcher is stopped (paused, or waiting for its turn)', async () => {
    const { w } = watcher();
    expect(w.tab()).toBeNull();
    await w.start();
    expect(w.tab()).toBe(WA_TAB);
    await w.stop();
    expect(w.tab()).toBe(WA_TAB);
  });

  it('starting again watches the SAME tab, not the one in front', async () => {
    const { w, starts } = watcher();
    await w.start();
    await w.stop();
    await w.start();
    expect(starts).toEqual([undefined, WA_TAB]);
  });

  it('is forgotten when that tab is closed, or the browser goes; another tab closing changes nothing', async () => {
    const a = watcher();
    await a.w.start();
    a.removed(12345);
    expect(a.w.tab()).toBe(WA_TAB);
    a.removed(WA_TAB);
    expect(a.w.tab()).toBeNull();
    const b = watcher();
    await b.w.start();
    await b.w.stop();
    b.disconnected();
    expect(b.w.tab()).toBeNull();
  });
});

describe('a picture or document is taken from the chat\'s tab', () => {
  it('the media step names the tab', async () => {
    const tabs: Array<number | undefined> = [];
    const service = {
      chatMedia: async (_id: string, _step: string, tabId?: number) => {
        tabs.push(tabId);
        return { ok: false, message: 'not here' };
      },
    } as unknown as BrowserAutomationService;
    const media = createChatMedia({ service: service as never, downloadsDir: 'C:/Downloads', tools: { invoke: async () => ({ ok: false, summary: '' }) }, tab: () => WA_TAB });
    await media.save('m1', 'image');
    expect(tabs).toEqual([WA_TAB]);
  });
});

describe('the browser is kept as well as the tab', () => {
  it('a scope holds a browser too; a scope inside a scope keeps what it does not set', async () => {
    expect(pinnedHome()).toBeNull();
    await runInTab(5, async () => {
      expect(pinnedHome()).toBeNull();
      await runInTab(null, async () => expect([pinnedTab(), pinnedHome()]).toEqual([5, 'eya']), 'eya');
      await runInTab(7, async () => expect([pinnedTab(), pinnedHome()]).toEqual([7, 'chrome']), 'chrome');
    });
    await runInTab(null, async () => expect([pinnedTab(), pinnedHome()]).toEqual([null, 'edge']), 'edge');
    // (a scope that names only a tab, inside one that has a browser, keeps that browser)
    await runInTab(
      5,
      async () => {
        await runInTab(7, async () => expect([pinnedTab(), pinnedHome()]).toEqual([7, 'eya']));
        expect([pinnedTab(), pinnedHome()]).toEqual([5, 'eya']);
      },
      'eya',
    );
    expect(pinnedHome()).toBeNull();
  });

  function homed(browser: 'chrome' | 'edge' | 'other') {
    const where: Array<{ op: string; tab: number | null; home: string | null }> = [];
    const service = {
      chatWatch: async (mode: string, tabId?: number) => {
        where.push({ op: 'watch:' + mode, tab: pinnedTab(), home: pinnedHome() });
        return { ok: true, watching: mode === 'start', tabId: tabId ?? WA_TAB, browser, hasMain: true };
      },
      chatRead: async () => {
        where.push({ op: 'read', tab: pinnedTab(), home: pinnedHome() });
        return { ok: true, tabId: WA_TAB, browser, hasMain: true, title: 't', messages: [], reliable: true };
      },
    } as unknown as BrowserAutomationService;
    const w = createChatWatcher({ onBrowserEvent: () => () => undefined, onConnectionChange: () => () => undefined }, service as never);
    return { w, where };
  }

  it.each([
    ['chrome', 'chrome'],
    ['edge', 'edge'],
    ['other', 'eya'],
  ] as const)('a chat that started in %s knows it is in %s, and everything it does there is pinned to that browser and tab', async (browser, home) => {
    const { w, where } = homed(browser);
    expect(w.home()).toBeNull();
    await w.start();
    expect(w.home()).toBe(home);
    await w.read(10);
    await w.stop();
    await w.start();
    // the very first start is not pinned (nothing is known yet); everything after it is
    expect(where.map((x) => [x.op, x.tab, x.home])).toEqual([
      ['watch:start', null, null],
      ['read', WA_TAB, home],
      ['watch:stop', WA_TAB, home],
      ['watch:start', WA_TAB, home],
    ]);
  });

  it('the live chat\'s looking, typing, sending and checking all go to its browser, and finding the next chat starts there too', async () => {
    const seen: Array<{ name: string; tab: number | null; home: string | null }> = [];
    const script = new Map<string, ToolResult[]>();
    const a = createChatActions({
      tools: {
        invoke: async (name: string, _args: ToolArgs): Promise<ToolResult> => {
          seen.push({ name, tab: pinnedTab(), home: pinnedHome() });
          return script.get(name)?.shift() ?? { ok: true, summary: name, data: { status: name === 'verify_sent' ? 'sent' : 'opened', chat: 'Rahul', verified: true, headerChecked: true } };
        },
      },
      service: {
        inspectPage: async () => {
          seen.push({ name: 'inspectPage', tab: pinnedTab(), home: pinnedHome() });
          return { url: 'https://web.whatsapp.com/', title: 'WhatsApp', headings: [], buttons: [], links: [], inputs: [], notes: [], environment: 'eya_browser' };
        },
      } as unknown as BrowserAutomationService,
      session: new ChatSession(),
      sleep: async () => undefined,
      tab: () => WA_TAB,
      home: () => 'eya',
    });
    await a.isOpen('Rahul').catch(() => undefined);
    await a.typeInBox('hello');
    await a.typeAndSend('Rahul', 'hello');
    await a.verify('hello');
    await a.open('Rahul');
    expect(seen.length).toBeGreaterThanOrEqual(5);
    expect(seen.every((x) => x.tab === WA_TAB && x.home === 'eya')).toBe(true);
    // when that page is not WhatsApp any more, WhatsApp is opened the usual way (the switch decides where), and looked at where it opened
    seen.length = 0;
    script.set('find_chat', [{ ok: false, summary: 'not a chat app', error: 'The page in front is not a chat app.', data: {} }]);
    await a.open('Rahul');
    expect(seen.map((x) => [x.name, x.tab, x.home])).toEqual([
      ['find_chat', WA_TAB, 'eya'],
      ['open_website', null, null],
      ['find_chat', null, null],
    ]);
  });

  it('a picture or document is taken from the chat\'s own browser', async () => {
    const where: Array<{ tab: number | null; home: string | null }> = [];
    const service = {
      chatMedia: async () => {
        where.push({ tab: pinnedTab(), home: pinnedHome() });
        return { ok: false, message: 'not here' };
      },
    } as unknown as BrowserAutomationService;
    const media = createChatMedia({ service: service as never, downloadsDir: 'C:/Downloads', tools: { invoke: async () => ({ ok: false, summary: '' }) }, tab: () => WA_TAB, home: () => 'edge' });
    await media.save('m1', 'image');
    expect(where).toEqual([{ tab: WA_TAB, home: 'edge' }]);
  });
});

describe('the marks a send is compared with are taken right before Send is pressed', () => {
  it('after a message was deleted the page has fewer marks than at the last check: the new message\'s mark is still seen as new', async () => {
    const order: string[] = [];
    const session = new ChatSession();
    session.markBaseline(['sent', 'sent', 'sent']); // (what the last check left: three marks)
    let marks = ['sent', 'sent']; // (one of those messages was deleted since)
    const a = createChatActions({
      tools: {
        invoke: async (name: string): Promise<ToolResult> => {
          order.push(name);
          return { ok: true, summary: name, data: {} };
        },
      },
      service: {
        inspectPage: async () => {
          order.push('inspectPage');
          return { url: 'https://web.whatsapp.com/', title: 'WhatsApp', headings: [], buttons: [], links: [], inputs: [], notes: [], environment: 'eya_browser', messageStatus: marks };
        },
      } as unknown as BrowserAutomationService,
      session,
      sleep: async () => undefined,
    });
    await a.typeAndSend('Rahul', 'hello');
    // looked at the page, THEN pressed Send
    expect(order.indexOf('inspectPage')).toBeGreaterThan(-1);
    expect(order.indexOf('inspectPage')).toBeLessThan(order.indexOf('click_on_page'));
    expect(session.baseline()).toEqual(['sent', 'sent']);
    // so when the new message's mark arrives, the marks are different from the baseline (three, not the same two)
    marks = ['sent', 'sent', 'sent'];
    expect(marks.length === (session.baseline()?.length ?? 0)).toBe(false);
  });

  it('a page that cannot be looked at does not stop the send', async () => {
    const a = createChatActions({
      tools: { invoke: async (name: string): Promise<ToolResult> => ({ ok: true, summary: name, data: {} }) },
      service: {
        inspectPage: async () => {
          throw new Error('page gone');
        },
      } as unknown as BrowserAutomationService,
      session: new ChatSession(),
      sleep: async () => undefined,
    });
    expect(await a.typeAndSend('Rahul', 'hello')).toEqual({ kind: 'pressed' });
  });
});

describe('a NEW live chat does not inherit where the last one was', () => {
  it('the watcher forgets its browser and tab; a chat that is only resumed keeps them', async () => {
    const where: Array<[string | null, number | null]> = [];
    const service = {
      chatWatch: async (mode: string, tabId?: number) => {
        where.push([pinnedHome(), pinnedTab()]);
        return { ok: true, watching: mode === 'start', tabId: tabId ?? WA_TAB, browser: 'other', hasMain: true };
      },
      chatRead: async () => ({ ok: true }),
    } as unknown as BrowserAutomationService;
    const w = createChatWatcher({ onBrowserEvent: () => () => undefined, onConnectionChange: () => () => undefined }, service as never);
    await w.start();
    await w.stop();
    expect([w.home(), w.tab()]).toEqual(['eya', WA_TAB]); // (paused: kept, so it can be resumed in the same place)
    w.forget?.();
    expect([w.home(), w.tab()]).toEqual([null, null]);
    await w.start();
    expect(where[where.length - 1]).toEqual([null, null]); // (started afresh: not pinned to the old place)
  });

  it('starting a live chat tells the watcher to forget; pausing and resuming one does not', async () => {
    const r = rig();
    r.chat.openOutcome = { kind: 'opened', label: 'Rahul Sharma', verified: true };
    await r.controller.start('Rahul Sharma');
    await settle(40);
    expect(r.chat.forgets).toBe(1);
    await r.controller.pause('user');
    await r.controller.resume();
    await settle(40);
    expect(r.chat.forgets).toBe(1);
    await r.controller.stop();
    await r.controller.start('Rahul Sharma');
    await settle(40);
    expect(r.chat.forgets).toBe(2);
  });
});
