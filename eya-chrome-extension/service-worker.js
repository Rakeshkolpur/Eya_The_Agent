/**
 * Eya Browser Bridge — service worker.
 *
 * Receives requests from the Eya desktop app (over the authenticated local
 * bridge), performs them in the browser you are already signed in to, and
 * sends back what the page looks like afterwards. It never reads cookies,
 * passwords or stored tokens, and it never talks to anything but Eya on this PC.
 */
import { Bridge } from './bridge.js';
import { goBack, inject, observeTab, runAction } from './actions.js';
import {
  assertWebUrl,
  focusTab,
  listTabs,
  openUrl,
  resolveTabId,
  startTabEventTracking,
  waitTabComplete,
  withThrowawayTab,
} from './tabs.js';

startTabEventTracking();

const manifest = chrome.runtime.getManifest();
let lastStatus = { status: 'connecting', detail: '' };

function browserName() {
  const ua = navigator.userAgent;
  if (ua.includes('Edg/')) return 'edge';
  if (ua.includes('Chrome/')) return 'chrome';
  return 'unknown';
}

function showStatus(status, detail) {
  lastStatus = { status, detail };
  const on = status === 'connected';
  chrome.action.setBadgeText({ text: on ? 'ON' : '' }).catch(() => undefined);
  chrome.action.setBadgeBackgroundColor({ color: '#1a7f37' }).catch(() => undefined);
}

async function handleRequest(op, args) {
  switch (op) {
    case 'ping':
      return { browser: browserName(), version: manifest.version };

    case 'list_tabs':
      return { tabs: await listTabs() };

    case 'focus_tab': {
      await focusTab(args.tabId);
      return { performed: { ok: true }, tabId: args.tabId, state: await observeTab(args.tabId), settled: true };
    }

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

    case 'back':
      return goBack(args.tabId);

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
});

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
    sendResponse({ ...lastStatus, version: manifest.version, browser: browserName(), extensionId: chrome.runtime.id });
  }
  if (message?.t === 'forget_pairing') {
    chrome.storage.local.remove('eyaSecret').then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

bridge.ensureConnected();
