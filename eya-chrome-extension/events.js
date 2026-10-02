/**
 * Live happenings inside the browser, forwarded to Eya as they occur: tabs opening, closing, being switched to,
 * navigating and finishing loading; windows opening, closing and gaining focus; downloads starting and finishing.
 * Eya keeps her picture of the browser from these, so she knows what the user has just done without having to ask.
 *
 * Every event says whether it happened while Eya herself was acting (`byEya`), which is how a click by the user in
 * the middle of one of her tasks is told apart from her own. Private windows are never reported.
 */
import { eyaIsActing, wireTab } from './tabs.js';

export function startEventForwarding(sendEvent) {
  const emit = (name, data) => sendEvent(name, { ...data, byEya: eyaIsActing() });
  const quiet = new Map(); // tabId -> timer, so a burst of title/url updates is reported once

  chrome.tabs.onCreated.addListener((tab) => {
    if (!tab.incognito) emit('tab_created', { tab: wireTab(tab) });
  });

  chrome.tabs.onRemoved.addListener((tabId, info) => {
    clearTimeout(quiet.get(tabId));
    quiet.delete(tabId);
    emit('tab_removed', { tabId, windowId: info.windowId, windowClosing: info.isWindowClosing === true });
  });

  chrome.tabs.onActivated.addListener((info) => emit('tab_activated', { tabId: info.tabId, windowId: info.windowId }));

  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (tab.incognito) return;
    if (change.status === 'loading') emit('navigation_started', { tabId, windowId: tab.windowId });
    if (change.status === 'complete') emit('navigation_completed', { tabId, windowId: tab.windowId });
    if (change.url === undefined && change.title === undefined && change.status === undefined && change.pinned === undefined) return;
    clearTimeout(quiet.get(tabId));
    quiet.set(
      tabId,
      setTimeout(async () => {
        quiet.delete(tabId);
        try {
          const latest = await chrome.tabs.get(tabId);
          if (!latest.incognito) emit('tab_updated', { tab: wireTab(latest) });
        } catch {
          // closed in the meantime; tab_removed already said so
        }
      }, 120),
    );
  });

  chrome.windows.onFocusChanged.addListener((windowId) => emit('window_focused', { windowId })); // -1: the browser lost focus
  chrome.windows.onCreated.addListener((w) => {
    if (!w.incognito) emit('window_created', { windowId: w.id });
  });
  chrome.windows.onRemoved.addListener((windowId) => emit('window_removed', { windowId }));

  chrome.downloads.onCreated.addListener((item) => emit('download_created', { id: item.id, state: item.state ?? 'in_progress' }));
  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
      emit('download_changed', { id: delta.id, state: delta.state.current });
    }
  });
}
