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
import { startEventForwarding } from './events.js';
import { goBack, goForward, inject, observeTab, reloadTab, runAction } from './actions.js';
import {
  assertWebUrl,
  beginEyaAction,
  closeTab,
  endEyaAction,
  focusTab,
  focusWindow,
  listTabs,
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
  'events',
  'downloads',
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
      const opened = await openUrl(args.url);
      const result = await runAction(opened.tabId, async (tabId) => {
        // tabs.update() can resolve a beat before the tab reports "loading"; let it start, then wait for it to finish.
        await new Promise((r) => setTimeout(r, 120));
        const loaded = await waitTabComplete(tabId, 20000);
        return { ok: true, opened: true, loaded };
      });
      return { ...result, reuse: opened.reuse };
    }

    case 'observe': {
      const tabId = await resolveTabId(args.tabId);
      return { tabId, state: await observeTab(tabId) };
    }

    case 'click':
      return runAction(args.tabId, (tabId) => inject(tabId, 'click', { id: args.id, expectName: args.name }));

    case 'fill':
      return runAction(args.tabId, async (tabId) => {
        const filled = await inject(tabId, 'fill', { id: args.id, expectName: args.name, value: args.value });
        if (filled?.ok && args.submit === true) {
          const pressed = await inject(tabId, 'press', { id: args.id, expectName: args.name });
          return { ...filled, submitted: pressed?.ok === true };
        }
        return filled;
      });

    case 'scroll':
      return runAction(args.tabId, (tabId) => inject(tabId, 'scroll', { direction: args.direction, amount: args.amount }));

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
