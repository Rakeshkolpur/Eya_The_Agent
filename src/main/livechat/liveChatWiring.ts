import type { BrowserChatLive, BrowserAutomationService, ChatReadResult } from '@main/browser/BrowserAutomationService';
import type { PageSnapshot } from '@main/browser/pageSnapshot';
import type { BridgeBrowserEvent, BridgeConnectionEvent } from '@main/chrome/ChromeBridge';
import type { BrowserName } from '@main/chrome/protocol';
import { ADAPTERS } from '@main/chat/platformAdapter';
import type { ChatSession } from '@main/chat/chatSession';
import type { ChatTask } from '@main/chat/chatTask';
import { rootLogger } from '@main/logging/logger';
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
export function createChatWatcher(bridge: WatcherBridge, service: BrowserAutomationService & Partial<BrowserChatLive>): LiveWatcher {
  let tabId: number | null = null;
  let browser: BrowserName | 'other' | null = null;

  const live = (): BrowserChatLive => {
    if (typeof service.chatWatch !== 'function' || typeof service.chatRead !== 'function') throw new Error("Watching a chat is only possible in the user's own browser (Chrome or Edge with the Eya extension).");
    return service as BrowserChatLive;
  };

  return {
    async start() {
      let r;
      try {
        r = await live().chatWatch('start');
      } catch (err) {
        if (err instanceof Error && /only possible in the user's own browser/.test(err.message)) return { ok: false, message: err.message, pause: null };
        throw err;
      }
      if (!r.ok) return { ok: false, message: r.message, pause: r.reason === 'extension_old' ? ('extension_old' as LiveChatPause) : null };
      if (r.hasMain === false) return { ok: false, message: 'No chat is open on the page, so there is nothing to watch.', pause: 'chat_closed' };
      tabId = r.tabId;
      browser = r.browser ?? null;
      return { ok: true };
    },

    async stop() {
      const t = tabId;
      tabId = null; // (the browser is remembered: when IT comes back, a live chat that only lost its connection carries on)
      if (t === null) return;
      try {
        await live().chatWatch('stop', t);
      } catch (err) {
        log.info('could not tell the page to stop watching', { err: String(err) });
      }
    },

    async read(max): Promise<ChatReadResult> {
      const r = await live().chatRead(max, tabId ?? undefined);
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
          void live()
            .chatWatch('start', tabId)
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
    let found = await deps.tools.invoke('find_chat', args);
    if (needsTheApp(found)) {
      const opened = await deps.tools.invoke('open_website', { url: adapter.url });
      if (browserMissing(opened)) return { kind: 'unavailable', say: 'No browser of yours is connected to Eya, so I cannot reach WhatsApp.' };
      if (!opened.ok) return { kind: 'failed', say: "I couldn't open WhatsApp Web." };
    }
    for (let attempt = 0; attempt < LOAD_WAITS_MS.length; attempt += 1) {
      const waiting = needsTheApp(found) || found.data?.['status'] === 'loading';
      if (!waiting) break;
      await sleep(LOAD_WAITS_MS[attempt] ?? 2000);
      found = await deps.tools.invoke('find_chat', args);
      if (found.data?.['status'] === 'needs_login') break;
    }
    return readOpened(found);
  }

  return {
    open: (query) => findChat({ query }),
    choose: (choice) => findChat({ choice }),

    async isOpen(label) {
      const page: PageSnapshot = await deps.service.inspectPage(); // refused here when Communication Access is off
      return chatOpenState(deps.session, page, label);
    },

    async typeInBox(text) {
      for (const label of adapter.composerLabels) {
        const filled = await deps.tools.invoke('fill_on_page', { label, value: text });
        if (filled.ok) return { ok: true };
      }
      return { ok: false, say: 'The message box was not found in the open chat.' };
    },

    async typeAndSend(label, text): Promise<SendPress> {
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
    },

    async verify(text): Promise<SendCheck> {
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
    },
  };
}
