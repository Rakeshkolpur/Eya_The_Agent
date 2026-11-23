import type { BrowserChatLive, BrowserAutomationService, ChatReadResult } from '@main/browser/BrowserAutomationService';
import type { PageSnapshot } from '@main/browser/pageSnapshot';
import type { BridgeBrowserEvent, BridgeConnectionEvent } from '@main/chrome/ChromeBridge';
import type { BrowserName } from '@main/chrome/protocol';
import { ADAPTERS } from '@main/chat/platformAdapter';
import type { ChatSession } from '@main/chat/chatSession';
import type { ChatTask } from '@main/chat/chatTask';
import { rootLogger } from '@main/logging/logger';
import { runInTab } from '@main/browser/tabScope';
import type { Home } from '@main/browser/tabScope';
import { chatOpenState } from '@main/tools/impl/chatTools';
import type { ToolArgs, ToolResult } from '@main/tools/types';
import type { LiveChatPause } from '@shared/liveChat';
import type { LiveChatActions, LiveWatcher, OpenOutcome, SendCheck, SendPress } from './LiveChatController';

const log = rootLogger.child('livechat');

// ------------------------------------------------------------------------------------------------------------------------------ the watcher
/** What the watcher needs of the bridge: the events the extension pushes, and whether a browser is still connected. */
export interface WatcherBridge {
  onBrowserEvent(listener: (e: BridgeBrowserEvent) => void): () => void;
  onConnectionChange(listener: (e: BridgeConnectionEvent) => void): () => void;
}

/**
 * The live chat's eyes: the extension's watcher in the open chat's page (it says THAT something changed; the event has no content), and a read of that open chat.
 * Bound to the one tab and browser it started in: events from any other tab are ignored, and a tab that closes or a browser that disconnects is "lost".
 */
/** A watcher that also says where the chat is: its tab, and its browser (the user's Chrome or Edge, or Eya Browser). */
export type ChatWatcher = LiveWatcher & { tab(): number | null; home(): Home | null };

/** The browser a result came from, as the scope names it ('other' is Eya Browser: neither Chrome nor Edge). */
const homeOf = (b: BrowserName | 'other' | null | undefined): Home | null => (b === 'chrome' ? 'chrome' : b === 'edge' ? 'edge' : b === 'other' ? 'eya' : null);

export function createChatWatcher(bridge: WatcherBridge, service: BrowserAutomationService & Partial<BrowserChatLive>): ChatWatcher {
  let tabId: number | null = null;
  let browser: BrowserName | 'other' | null = null;
  // The WhatsApp tab this live chat has been in. It is kept while the chat is paused or waiting for a turn (the watcher is off then, `tabId` is null), so that looking at the chat,
  // coming back to it and the next turn of a several-chats rotation go to THAT tab and not to whatever tab the person has in front. It is forgotten when the tab is closed or the browser goes.
  let home: number | null = null;
  bridge.onBrowserEvent((e) => {
    if (e.name === 'tab_removed' && home !== null && e.data['tabId'] === home && (browser === null || e.browser === browser)) home = null;
  });
  bridge.onConnectionChange((e) => {
    if (!e.connected && (browser === null || e.browser === browser)) home = null;
  });

  // Everything this chat does in the browser is done in ITS tab and ITS browser, once it has them: not wherever the last request happened to go.
  const here = <T>(work: () => Promise<T>): Promise<T> => runInTab(home, work, homeOf(browser));

  const live = (): BrowserChatLive => {
    if (typeof service.chatWatch !== 'function' || typeof service.chatRead !== 'function') throw new Error("Watching a chat is only possible in the user's own browser (Chrome or Edge with the Eya extension).");
    return service as BrowserChatLive;
  };

  return {
    async start() {
      let r;
      try {
        r = await here(() => live().chatWatch('start', home ?? undefined));
      } catch (err) {
        if (err instanceof Error && /only possible in the user's own browser/.test(err.message)) return { ok: false, message: err.message, pause: null };
        throw err;
      }
      if (!r.ok) return { ok: false, message: r.message, pause: r.reason === 'extension_old' ? ('extension_old' as LiveChatPause) : null };
      if (r.hasMain === false) return { ok: false, message: 'No chat is open on the page, so there is nothing to watch.', pause: 'chat_closed' };
      tabId = r.tabId;
      home = r.tabId;
      browser = r.browser ?? null;
      return { ok: true };
    },

    /** The tab this live chat is in (watching it now, or paused / waiting for its turn), or null before it has started. */
    tab() {
      return home; // (the same tab as `tabId` while watching; kept when the watcher is off; null once the tab is gone)
    },

    /** The browser it is in, once it has started: the user's Chrome or Edge, or Eya Browser. */
    home() {
      return homeOf(browser);
    },

    /** A new live chat begins: nothing is carried over from the last one (where it was, which tab). */
    forget() {
      tabId = null;
      home = null;
      browser = null;
    },

    async stop() {
      const t = tabId;
      tabId = null; // (the browser is remembered: when IT comes back, a live chat that only lost its connection carries on)
      if (t === null) return;
      try {
        await here(() => live().chatWatch('stop', t));
      } catch (err) {
        log.info('could not tell the page to stop watching', { err: String(err) });
      }
    },

    async read(max): Promise<ChatReadResult> {
      const r = await here(() => live().chatRead(max, tabId ?? undefined));
      // (the tab or browser Eya works in moved on: that is not the chat that was chosen)
      if (r.ok && browser !== null && r.browser !== undefined && r.browser !== browser) return { ...r, hasMain: false, messages: [] };
      return r;
    },

    onChange(cb) {
      return bridge.onBrowserEvent((e) => {
        if (e.name !== 'chat_changed' || tabId === null || e.data['tabId'] !== tabId || (browser !== null && e.browser !== browser)) return;
        cb(typeof e.data['reason'] === 'string' ? e.data['reason'] : 'messages');
      });
    },

    onBack(cb) {
      // only the browser the live chat was in: another browser connecting says nothing about this chat
      return bridge.onConnectionChange((e) => {
        if (e.connected && browser !== null && e.browser === browser) cb();
      });
    },

    onLost(cb) {
      const offEvents = bridge.onBrowserEvent((e) => {
        if (tabId === null || e.data['tabId'] !== tabId || (browser !== null && e.browser !== browser)) return;
        if (e.name === 'tab_removed') cb('chat_closed');
        // A page that reloaded has lost the watcher inside it: it is put back at once, and the chat looked at (a reload may have shown new messages).
        if (e.name === 'navigation_completed') {
          void here(() => live().chatWatch('start', tabId ?? undefined))
            .then((r) => {
              if (!r.ok) cb('extension_old');
            })
            .catch(() => cb('browser_lost'));
        }
      });
      const offConnection = bridge.onConnectionChange((e) => {
        if (!e.connected && (browser === null || e.browser === browser)) cb('browser_lost');
      });
      return () => {
        offEvents();
        offConnection();
      };
    },
  };
}

// ------------------------------------------------------------------------------------------------------------------------------ the actions
export interface ActionsDeps {
  readonly tools: { invoke(name: string, args: ToolArgs): Promise<ToolResult> };
  readonly service: BrowserAutomationService;
  readonly session: ChatSession;
  /** A task record for a send (the Tasks card and the send journal), or undefined for none. */
  readonly beginTask?: (label: string, text: string) => ChatTask | undefined;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The tab this live chat is in (the watcher's): looking at the chat, typing and sending all go to THAT tab, whatever else is in front or was opened since. */
  readonly tab?: () => number | null;
  /** The browser it is in (the user's Chrome or Edge, or Eya Browser): the same, for the browser. */
  readonly home?: () => Home | null;
}

const LOAD_WAITS_MS = [300, 700, 1000, 1500, 2000, 2000, 2000, 2000];
const browserMissing = (r: ToolResult): boolean => r.data?.['browserUnavailable'] === true;
/**
 * Nothing to look at yet: the page in front is not the chat app, or the browser has no window open at all ("There is no browser tab to look at", which is what
 * the extension says when Chrome is running without a window). Either way the way forward is the same one every chat request takes: open WhatsApp Web.
 */
const needsTheApp = (r: ToolResult): boolean => r.summary === 'not a chat app' || (r.data?.['status'] === 'error' && /no browser tab/i.test(r.error ?? ''));

/**
 * What the live chat does on the page, through the SAME tools and rules as every other WhatsApp action: the chat is opened by find_chat (exact name or whole number is
 * an identity; a likely match is not), and a message is typed with fill_on_page and sent with click_on_page through the Send gate — so Communication Access, the
 * plugin's "send text messages" permission and the wrong-chat check apply here exactly as they do to "send hello to Anna". Then verify_sent looks in the chat.
 */
export function createChatActions(deps: ActionsDeps): LiveChatActions {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const adapter = ADAPTERS.whatsapp;
  let task: ChatTask | undefined;

  const blockedSay = (r: ToolResult): string | null => (r.data?.['pluginBlocked'] === true && typeof r.data['forPerson'] === 'string' ? r.data['forPerson'] : null);

  function readOpened(r: ToolResult): OpenOutcome {
    const data = r.data ?? {};
    const refused = blockedSay(r);
    if (refused !== null) return { kind: 'blocked', say: `${refused} Nothing was started.` };
    if (browserMissing(r)) return { kind: 'unavailable', say: 'No browser of yours is connected to Eya, so I cannot reach WhatsApp.' };
    const status = String(data['status'] ?? '');
    if (status === 'opened' && typeof data['chat'] === 'string') {
      // An identity: an exact name or a whole number, shown open by the page's own message box or header. Anything less is only a likely match.
      return { kind: 'opened', label: data['chat'], verified: data['verified'] === true && data['headerChecked'] === true, ...(typeof data['numberEndsIn'] === 'string' ? { ending: data['numberEndsIn'] } : {}) };
    }
    if (status === 'ambiguous' && Array.isArray(data['candidates'])) {
      const options = data['candidates'].flatMap((c): Array<{ label: string; choice: number }> => {
        const x = c as { label?: unknown; choice?: unknown };
        return typeof x.label === 'string' && typeof x.choice === 'number' ? [{ label: x.label, choice: x.choice }] : [];
      });
      return { kind: 'ambiguous', options };
    }
    if (status === 'needs_login') return { kind: 'login', say: 'WhatsApp is asking you to log in with a QR code. Scan it with your phone and start the live chat again.' };
    if (status === 'loading') return { kind: 'loading', say: 'WhatsApp has not finished loading. Try again in a few seconds.' };
    if (status === 'none') return { kind: 'none', say: typeof data['hint'] === 'string' ? "I couldn't find that chat in WhatsApp. Try the name as it is saved there, or the phone number." : "I couldn't find that chat in WhatsApp." };
    return { kind: 'failed', say: r.error ?? "I couldn't open that chat." };
  }

  /** Calls find_chat, opening WhatsApp first if the page in front is not it, and waiting while WhatsApp loads (as every chat request does). */
  async function findChat(args: ToolArgs): Promise<OpenOutcome> {
    // (in the live chat's own tab when it has one: the next chat of a rotation is opened there, not in the tab the person happens to be looking at)
    let pin = deps.tab?.() ?? null;
    let pinHome = deps.home?.() ?? null;
    const find = (): Promise<ToolResult> => runInTab(pin, () => deps.tools.invoke('find_chat', args), pinHome);
    let found = await find();
    if (needsTheApp(found)) {
      pin = null; // (that tab is not WhatsApp any more: WhatsApp is opened the usual way, and looked at where it opened)
      pinHome = null;
      const opened = await deps.tools.invoke('open_website', { url: adapter.url });
      if (browserMissing(opened)) return { kind: 'unavailable', say: 'No browser of yours is connected to Eya, so I cannot reach WhatsApp.' };
      if (!opened.ok) return { kind: 'failed', say: "I couldn't open WhatsApp Web." };
    }
    for (let attempt = 0; attempt < LOAD_WAITS_MS.length; attempt += 1) {
      const waiting = needsTheApp(found) || found.data?.['status'] === 'loading';
      if (!waiting) break;
      await sleep(LOAD_WAITS_MS[attempt] ?? 2000);
      found = await find();
      if (found.data?.['status'] === 'needs_login') break;
    }
    return readOpened(found);
  }

  /** Everything the live chat does on the page runs in ITS tab (see tabScope.ts): the person opening another tab, or Eya opening a site for another request, changes nothing here. */
  const inTab = <T>(work: () => Promise<T>): Promise<T> => runInTab(deps.tab?.() ?? null, work, deps.home?.() ?? null);

  async function typeAndSendIn(label: string, text: string): Promise<SendPress> {
    task = deps.beginTask?.(label, text);
    task?.enter('PREPARE_MESSAGE_OR_ATTACHMENT');
    let typed = false;
    for (const box of adapter.composerLabels) {
      const filled = await deps.tools.invoke('fill_on_page', { label: box, value: text });
      const refused = blockedSay(filled);
      if (refused !== null) {
        task?.fail('plugin_blocked', refused);
        return { kind: 'not_sent', say: refused };
      }
      if (filled.ok) {
        typed = true;
        break;
      }
    }
    if (!typed) {
      task?.fail('composer_missing', 'the message box was not found in the open chat');
      return { kind: 'not_sent', say: 'The message box was not found in the open chat.' };
    }
    task?.enter('SEND');
    deps.session.noteSend(label, text, 'attempted');
    // The delivery marks on the page right now are what this send is compared with: a mark that was already there says nothing about THIS message. (Taken here, not left from the
    // last check: a message deleted since, by Eya or by the person, would otherwise make the new message's mark look like one that was already there, and the send would be
    // "not seen" for eight seconds.)
    try {
      const before: PageSnapshot = await deps.service.inspectPage();
      deps.session.markBaseline(before.messageStatus ?? []);
    } catch {
      // the check after Send goes on with what it has
    }
    // (the person's own setting up of the live chat for this chat is the yes; the tools still refuse a Send in a different chat, or without the permission)
    const click = await deps.tools.invoke('click_on_page', { text: adapter.sendLabel, confirm: true });
    if (!click.ok) {
      deps.session.noteSend(label, text, 'failed');
      const refused = blockedSay(click);
      if (refused !== null) {
        task?.fail('plugin_blocked', refused);
        return { kind: 'not_sent', say: refused };
      }
      if (click.data?.['status'] === 'wrong_chat') {
        task?.fail('wrong_chat', 'the chat that is open is not the one chosen: nothing was sent');
        return { kind: 'not_sent', say: 'The chat that is open is not the chosen one.' };
      }
      task?.fail('send_failed', 'the Send control could not be pressed');
      return { kind: 'not_sent', say: "I couldn't press Send." };
    }
    task?.sendBegan();
    return { kind: 'pressed' };
  }

  async function verifyIn(text: string): Promise<SendCheck> {
    const checked = await deps.tools.invoke('verify_sent', { text });
    const status = checked.data?.['status'];
    const mark = typeof checked.data?.['mark'] === 'string' ? checked.data['mark'] : undefined;
    if (status === 'sent') {
      task?.sendSeen(mark);
      task?.complete();
      return { status: 'sent', ...(mark !== undefined ? { mark } : {}) };
    }
    if (status === 'failed') {
      task?.fail('send_failed', 'the app shows the send as failed');
      return { status: 'failed' };
    }
    task?.fail('send_uncertain', 'Send was pressed but the chat did not show the result: look at the chat before sending again');
    return { status: status === 'pending' ? 'pending' : status === 'not_found' ? 'not_found' : 'unconfirmed' };
  }

  return {
    open: (query) => findChat({ query }),
    choose: (choice) => findChat({ choice }),

    async isOpen(label) {
      const page: PageSnapshot = await inTab(() => deps.service.inspectPage()); // refused here when Communication Access is off
      return chatOpenState(deps.session, page, label);
    },

    typeInBox: (text) =>
      inTab(async () => {
        for (const label of adapter.composerLabels) {
          const filled = await deps.tools.invoke('fill_on_page', { label, value: text });
          if (filled.ok) return { ok: true };
        }
        return { ok: false, say: 'The message box was not found in the open chat.' };
      }),

    typeAndSend: (label, text) => inTab(() => typeAndSendIn(label, text)),

    verify: (text) => inTab(() => verifyIn(text)),

    deleteMessage: (id, scope) =>
      inTab(async () => {
        const live = deps.service as Partial<BrowserChatLive>;
        if (typeof live.chatDelete !== 'function') return { ok: false, say: 'This browser connection cannot delete a message.' };
        const done = await live.chatDelete(id, scope, deps.tab?.() ?? undefined);
        if (!done.ok) return { ok: false, say: done.message };
        return done.gone ? { ok: true, say: '' } : { ok: false, say: 'I pressed Delete, but the message still seems to be there. Look at the chat.' };
      }),
  };
}
