/**
 * Observe and act. Every action is the same loop: do the thing, wait for the
 * page to actually finish reacting, follow it if it opened a new tab or started
 * a download, then LOOK again and hand back what is really there now. Eya never
 * assumes an action worked; she is always given the page as it is after it.
 */
import { eyaPageAgent } from './injected.js';
import {
  awaitDownload,
  newTabsSince,
  redactedUrl,
  resolveTabId,
  sawLoading,
  setTaskTab,
  waitTabComplete,
} from './tabs.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run one command inside a tab's page. */
export async function inject(tabId, command, params = {}) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: eyaPageAgent,
    args: [command, params],
  });
  return res?.result;
}

async function restrictedState(tabId, why) {
  const tab = await chrome.tabs.get(tabId);
  return {
    url: tab.url ?? '',
    title: tab.title ?? '',
    epoch: 0,
    headings: [],
    elements: [],
    dialogs: [],
    visibleText: '',
    tables: [],
    focused: null,
    scroll: { y: 0, max: 0, atBottom: true },
    challenge: null,
    loading: tab.status !== 'complete',
    notes: [why],
    restricted: true,
  };
}

/** The page as it is right now. Pages the browser forbids extensions to read come back as an honest empty state. */
export async function observeTab(tabId) {
  let state;
  try {
    state = await inject(tabId, 'observe', {});
  } catch (err) {
    const message = String(err?.message ?? err);
    if (/cannot access|extensions gallery|cannot be scripted|chrome-error|showing error page|not allowed/i.test(message)) {
      return restrictedState(tabId, 'This is a browser-internal or protected page that extensions are not allowed to read.');
    }
    throw err;
  }
  if (!state) return restrictedState(tabId, 'The page did not answer (it may still be loading).');
  return { ...state, url: redactedUrl(state.url) || state.url };
}

/** Wait until the tab has finished loading AND its page has stopped changing. */
export async function settleTab(tabId, sinceMs) {
  await sleep(180); // a click that navigates flips the tab to "loading" a moment later
  if (sawLoading(tabId, sinceMs)) await waitTabComplete(tabId, 12000);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await inject(tabId, 'waitQuiet', {});
    } catch (err) {
      // The page was replaced under us (a navigation finished): wait for the new one and ask again.
      if (attempt === 1) return { settled: false, error: String(err?.message ?? err) };
      await waitTabComplete(tabId, 12000);
    }
  }
  return { settled: false };
}

/**
 * Do something in a tab, then report the world afterwards.
 * `perform(tabId)` returns the page agent's own result ({ ok, reason, ... }).
 */
export async function runAction(requestedTabId, perform) {
  const tabId = await resolveTabId(requestedTabId);
  const startedAt = Date.now();

  let performed;
  try {
    performed = await perform(tabId);
  } catch (err) {
    // A click that starts a navigation can tear down the page before its result is sent back.
    if (!sawLoading(tabId, startedAt)) throw err;
    performed = { ok: true, navigated: true };
  }

  if (performed?.ok === false) {
    // Nothing happened, so there is nothing to wait for: show the page exactly as it is.
    return { performed, tabId, state: await observeTab(tabId), settled: true };
  }

  const settle = await settleTab(tabId, startedAt);

  // Did it open a new tab (target=_blank, window.open)? Follow it, like a person would.
  let activeTabId = tabId;
  let newTab = null;
  const opened = newTabsSince(startedAt, tabId);
  for (const candidate of opened.reverse()) {
    try {
      await chrome.tabs.get(candidate);
    } catch {
      continue; // opened and closed again (a download pop-under, say)
    }
    await waitTabComplete(candidate, 12000);
    await settleTab(candidate, startedAt);
    await chrome.tabs.update(candidate, { active: true });
    await setTaskTab(candidate);
    activeTabId = candidate;
    newTab = { tabId: candidate };
    break;
  }

  const download = await awaitDownload(startedAt);
  const state = await observeTab(activeTabId);
  return {
    performed,
    tabId: activeTabId,
    state,
    settled: settle?.settled !== false,
    ...(settle?.busy ? { stillBusy: true } : {}),
    ...(newTab !== null ? { newTab: { ...newTab, from: tabId } } : {}),
    ...(download !== null ? { download } : {}),
  };
}

export async function goBack(requestedTabId) {
  const tabId = await resolveTabId(requestedTabId);
  const startedAt = Date.now();
  const nothing = { ok: false, reason: 'no_history', detail: 'There is nothing to go back to in this tab.' };

  let probe;
  try {
    probe = await inject(tabId, 'back', {});
  } catch (err) {
    // A back that starts a navigation can tear the page down before it answers; that still counts as going back.
    if (!sawLoading(tabId, startedAt)) throw err;
    probe = { ok: true };
  }
  if (!probe?.ok) return { performed: probe ?? nothing, tabId, state: await observeTab(tabId), settled: true };

  const settle = await settleTab(tabId, startedAt);
  const state = await observeTab(tabId);
  // history.back() with nowhere to go does nothing at all: same address, no load.
  if (probe.from !== undefined && !sawLoading(tabId, startedAt) && safeEquals(probe.from, state.url)) {
    return { performed: nothing, tabId, state, settled: true };
  }
  return { performed: { ok: true }, tabId, state, settled: settle?.settled !== false };
}

function safeEquals(rawFrom, redactedNow) {
  return redactedUrl(rawFrom) === redactedNow;
}
