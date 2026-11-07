/**
 * Eya Browser Bridge — service worker.
 *
 * Receives requests from the Eya desktop app (over the authenticated local
 * bridge), performs them in the browser you are already signed in to, and
 * sends back what the page looks like afterwards. It also tells Eya, as they
 * happen, what is going on in the browser (tabs opening and closing, pages
 * loading, windows gaining focus, downloads). It never reads cookies,
 * passwords or stored tokens, and it never talks to anything but Eya on this PC.
 */
import { Bridge } from './bridge.js';
import { blockedHostFor, setBlocked } from './policy.js';
import { startEventForwarding } from './events.js';
import { attachFile, goBack, goForward, inject, observeTab, reloadTab, runAction } from './actions.js';
import {
  assertWebUrl,
  beginEyaAction,
  closeTab,
  endEyaAction,
  focusTab,
  focusWindow,
  listTabs,
  looksLikeFileUrl,
  openUrl,
  resolveTabId,
  screenshotTab,
  snapshotBrowser,
  startTabEventTracking,
  waitTabComplete,
  withThrowawayTab,
} from './tabs.js';

startTabEventTracking();

const manifest = chrome.runtime.getManifest();
let lastStatus = { status: 'connecting', detail: '' };

/** What this extension can do. Eya checks it has what it needs before relying on it, so a mismatch is caught at connect time. */
const CAPABILITIES = [
  'item_context',
  'observe',
  'click',
  'fill',
  'open_url',
  'list_tabs',
  'focus_tab',
  'focus_window',
  'back',
  'forward',
  'reload',
  'scroll',
  'close_tab',
  'search_page',
  'screenshot',
  'policy',
  'attach_file',
  'events',
  'downloads',
  // Chat apps: a short settle and no download wait for click/fill/open_url when Eya says `quick` (see actions.js).
  'quick_actions',
  // Skipping skippable adverts on YouTube and closing its overlay adverts, once or watching (see injected.js `ads`).
  'ads',
  // Typing a one-time verification code the user said out loud into a one-time-code field (never a password or a card number).
  'one_time_code',
  // Pressing Escape (and nothing else) to leave the open chat, so a file can be sent through the app's own "Select chats" step.
  'press_key',
  // Live chat: tells Eya when something changed in the ONE chat that is open (never what), and reads that open chat's last messages on request.
  'chat_watch',
  'chat_read',
  // Live chat, version 0.11.3 on: reads a message by its own bubble marks when the page's ids are not of the known shape, and says (masked, no words) how the page is built.
  // Eya will not start a live chat on an extension without it: the older reader cannot read the page WhatsApp shows today.
  'chat_read_bubbles',
  // Version 0.11.4 on: which side a message is on is read from its delivery tick, from where the page DRAWS it and from its sender — the real page has no direction in its ids
  // or classes — and a picture or voice note whose side cannot be told no longer makes the whole page unreadable.
  'chat_read_sides',
  // Version 0.11.5 on: takes a picture or a document the OTHER person sent out of the open chat — a picture's own bytes, or a document by pressing its own download control and
  // watching the browser's download. Nothing is sent, changed or deleted; Eya decides what is kept (and only in the Downloads folder).
  'chat_media',
  // Version 0.11.6 on: a document's bubble is recognised by what it OFFERS (a document icon or download control, and a file name). Before, any bubble with words in it was a text
  // message — and a document's bubble always has words (its file name, its size) — so on the real WhatsApp a PDF was never taken. Also: if the page draws the download arrow
  // with no name, the document's own button is pressed instead.
  'chat_documents',
];

function browserName() {
  const ua = navigator.userAgent;
  if (ua.includes('Edg/')) return 'edge';
  if (ua.includes('Chrome/')) return 'chrome';
  return 'other';
}

function browserVersion() {
  const m = /(?:Edg|Chrome)\/([\d.]+)/.exec(navigator.userAgent);
  return m ? m[1] : '';
}

function showStatus(status, detail) {
  lastStatus = { status, detail };
  const on = status === 'connected';
  chrome.action.setBadgeText({ text: on ? 'ON' : '' }).catch(() => undefined);
  chrome.action.setBadgeBackgroundColor({ color: '#1a7f37' }).catch(() => undefined);
}

async function handleRequest(op, args) {
  beginEyaAction();
  try {
    return await perform(op, args);
  } finally {
    // A moment of grace: events caused by this request can arrive just after it finishes.
    setTimeout(endEyaAction, 400);
  }
}

async function perform(op, args) {
  switch (op) {
    case 'ping':
      return { browser: browserName(), version: manifest.version, browserVersion: browserVersion() };

    case 'list_tabs':
      return { tabs: await listTabs(), ...(await snapshotBrowser().then((s) => ({ activeTabId: s.activeTabId, activeWindowId: s.activeWindowId }))) };

    case 'focus_tab': {
      await focusTab(args.tabId);
      return { performed: { ok: true }, tabId: args.tabId, state: await observeTab(args.tabId), settled: true };
    }

    case 'focus_window':
      await focusWindow(args.windowId);
      return { performed: { ok: true } };

    case 'open_url': {
      assertWebUrl(args.url);
      // `fresh`: a try after a failure loads the address again even if a tab is already showing exactly it (it would otherwise only be brought to the front)
      const opened = await openUrl(args.url, { fresh: args.fresh === true });
      const result = await runAction(
        opened.tabId,
        async (tabId) => {
          // tabs.update() can resolve a beat before the tab reports "loading"; let it start, then wait for it to finish.
          await new Promise((r) => setTimeout(r, 120));
          const loaded = await waitTabComplete(tabId, 20000);
          return { ok: true, opened: true, loaded };
        },
        // Going back to a tab that is already open starts no download; a chat app (quick) never does.
        { quick: args.quick === true, downloads: opened.reuse !== 'focused', downloadLikely: looksLikeFileUrl(args.url) },
      );
      // What the site ANSWERED, and whether the page came up empty: without it a 404 or 503 page was taken for the page that was asked for (the desktop side
      // already knows what to do with a status — retry a hiccup, say a missing page is missing — but was never given one).
      let navigation = null;
      try {
        const info = await inject(result.tabId, 'navInfo', {});
        navigation = { requested: args.url, final: result.state?.url ?? '', status: info?.status ?? null, blank: info?.blank === true };
      } catch {
        // a page that cannot be asked (a chat app that is switched off, a browser page): no status is better than a made-up one
      }
      return { ...result, reuse: opened.reuse, ...(navigation !== null ? { navigation } : {}) };
    }

    case 'observe': {
      const tabId = await resolveTabId(args.tabId);
      return { tabId, state: await observeTab(tabId) };
    }

    // Read-only: how the page's text fields and file inputs are built (never what is in them). For Eya's own diagnostics only.
    case 'probe': {
      const tabId = await resolveTabId(args.tabId);
      return { tabId, probe: await inject(tabId, 'probe', {}) };
    }

    case 'click':
      // `quick`: the page is a single-page app such as a chat (Eya says so; an older Eya never sends it, and then nothing changes).
      return runAction(args.tabId, (tabId) => inject(tabId, 'click', { id: args.id, expectName: args.name }), { quick: args.quick === true });

    case 'fill':
      return runAction(
        args.tabId,
        async (tabId) => {
          const filled = await inject(tabId, 'fill', { id: args.id, expectName: args.name, value: args.value, allowCode: args.allowCode === true });
          if (filled?.ok && args.submit === true) {
            const pressed = await inject(tabId, 'press', { id: args.id, expectName: args.name });
            return { ...filled, submitted: pressed?.ok === true };
          }
          return filled;
        },
        // Typing in a box starts no download (pressing Enter in it might submit a form that does).
        { quick: args.quick === true, downloads: args.submit === true },
      );

    case 'press_key':
      // Escape only (see injected.js `pressKey`): closes the open chat or popup. Settles briefly, as a chat page does.
      return runAction(args.tabId, (tabId) => inject(tabId, 'pressKey', { key: args.key }), { quick: true, downloads: false });

    // Live chat: start / stop / ask about the watcher in the open chat, and read the open chat's last messages (see injected.js `chatWatch`, `chatRead`).
    case 'chat_watch': {
      const tabId = await resolveTabId(args.tabId);
      return { tabId, ...(await inject(tabId, 'chatWatch', { mode: args.mode })) };
    }

    case 'chat_read': {
      const tabId = await resolveTabId(args.tabId);
      return { tabId, ...(await inject(tabId, 'chatRead', { max: args.max })) };
    }

    case 'chat_media': {
      const tabId = await resolveTabId(args.tabId);
      if (args.phase === 'click') {
        // Pressing a document's download control starts a browser download: watched like any other (where it landed, whether it finished).
        return runAction(tabId, (id) => inject(id, 'chatMedia', { id: args.id, phase: 'click' }), { quick: false, downloads: true, downloadLikely: true });
      }
      return { tabId, ...(await inject(tabId, 'chatMedia', { id: args.id, phase: 'look', maxBytes: args.maxBytes })) };
    }

    case 'ads': {
      // The page's own Skip / close buttons, once or watched (nothing is hidden or blocked). Not for a chat app (inject refuses those).
      const tabId = await resolveTabId(args.tabId);
      const state = await inject(tabId, 'ads', { mode: args.mode, keepPlaying: args.keepPlaying === true, play: args.play === true });
      return { tabId, state };
    }

    case 'scroll':
      return runAction(args.tabId, (tabId) => inject(tabId, 'scroll', { direction: args.direction, amount: args.amount }), { downloads: false });

    case 'back':
      return goBack(args.tabId);

    case 'forward':
      return goForward(args.tabId);

    case 'reload':
      return reloadTab(args.tabId);

    case 'close_tab':
      return closeTab(args.tabId, args.allowUserTab === true);

    case 'screenshot':
      return screenshotTab(args.tabId);

    case 'attach_file':
      // A file for a chat app's own file picker, sent in parts (see actions.js).
      return attachFile(args);

    case 'set_policy':
      // Eya says which chat apps are NOT allowed right now (the user's Communication Access switch).
      return { blockedRules: setBlocked(args.blocked) };

    case 'search_page': {
      // A background tab that closes again: searching never disturbs the tabs you are using.
      return withThrowawayTab(args.url, async (tabId) => {
        await inject(tabId, 'waitQuiet', { minMs: 200, timeoutMs: 3000 }).catch(() => undefined);
        return { hits: (await inject(tabId, 'extractSearch', { engine: args.engine })) ?? [] };
      });
    }

    default:
      throw new Error(`Unknown request: ${op}`);
  }
}

const bridge = new Bridge({
  onRequest: handleRequest,
  onStatus: showStatus,
  version: manifest.version,
  browserName: browserName(),
  browserVersion: browserVersion(),
  capabilities: CAPABILITIES,
  getSnapshot: snapshotBrowser,
});

// Everything that happens in the browser is passed on to Eya as it happens.
startEventForwarding((name, data) => bridge.sendEvent(name, data));

// Wake-ups: a 30-second alarm re-checks the connection, and so does every page load of the options page.
chrome.alarms.create('eya-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'eya-keepalive') bridge.ensureConnected();
});
chrome.runtime.onStartup.addListener(() => bridge.ensureConnected());
chrome.runtime.onInstalled.addListener(() => bridge.ensureConnected());

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // The live-chat watcher in a page: something changed in the open chat. Passed on to Eya with no content at all — and only while the chat app is allowed.
  if (message?.t === 'chat_event') {
    const tab = sender.tab;
    // (asked of the saved list, after it has loaded: a worker that has just woken up must not take a gap for "allowed")
    blockedHostFor(tab?.url || tab?.pendingUrl || '')
      .then((blockedHost) => {
        if (!tab || tab.incognito || blockedHost !== null) {
          sendResponse({ stop: true }); // Communication Access went off (or this is no tab of ours): the watcher in the page switches itself off
          return;
        }
        // (waits for the connection if it has just dropped, and says whether the event really went: the page reports it again until it has)
        return bridge
          .sendEventWhenReady('chat_changed', { tabId: tab.id, windowId: tab.windowId, reason: String(message.reason ?? '').slice(0, 12), rows: Number(message.rows) || 0 })
          .then((delivered) => sendResponse({ stop: false, delivered }));
      })
      .catch(() => sendResponse({ stop: false, delivered: false })); // (not told to stop: it is reported again)
    return true;
  }
  if (message?.t === 'status') {
    bridge.ensureConnected();
    sendResponse({
      ...lastStatus,
      version: manifest.version,
      browser: browserName(),
      browserVersion: browserVersion(),
      extensionId: chrome.runtime.id,
    });
  }
  if (message?.t === 'forget_pairing') {
    chrome.storage.local.remove('eyaSecret').then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

bridge.ensureConnected();
