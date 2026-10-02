/**
 * Tab management for Eya: which tab she is working in, which tabs she opened
 * herself, finding an already-open tab instead of piling up new ones, and a
 * short memory of tabs/downloads that appeared while an action was running.
 *
 * One rule decides almost everything here: Eya never navigates away a tab the
 * USER was using. She reuses tabs she opened herself, focuses a matching tab
 * the user already has open, and otherwise opens a new one.
 */

const EVENT_BUFFER = 30;
const createdTabs = []; // { tabId, openerTabId, at }
const tabUpdates = []; // { tabId, status, at }
const downloads = new Map(); // id -> { id, url, filename, state, bytes, mime, at }

function push(list, item) {
  list.push(item);
  while (list.length > EVENT_BUFFER) list.shift();
}

export function startTabEventTracking() {
  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.id !== undefined) push(createdTabs, { tabId: tab.id, openerTabId: tab.openerTabId, at: Date.now() });
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status !== undefined) push(tabUpdates, { tabId, status: change.status, at: Date.now() });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void forgetEyaTab(tabId);
  });
  chrome.downloads.onCreated.addListener((item) => {
    downloads.set(item.id, {
      id: item.id,
      url: item.finalUrl || item.url || '',
      filename: item.filename || '',
      state: item.state || 'in_progress',
      bytes: item.totalBytes ?? -1,
      mime: item.mime || '',
      at: Date.now(),
    });
    while (downloads.size > EVENT_BUFFER) downloads.delete(downloads.keys().next().value);
  });
  chrome.downloads.onChanged.addListener((delta) => {
    const known = downloads.get(delta.id);
    if (!known) return;
    if (delta.filename?.current) known.filename = delta.filename.current;
    if (delta.state?.current) known.state = delta.state.current;
    if (delta.totalBytes?.current !== undefined) known.bytes = delta.totalBytes.current;
    if (delta.mime?.current) known.mime = delta.mime.current;
    if (delta.error?.current) known.error = delta.error.current;
  });
}

// ----------------------------------------------------------- persisted state
// The service worker can be shut down after 30s idle, so "which tab am I working in"
// lives in session storage, not in a variable.
async function readSession(key, fallback) {
  const got = await chrome.storage.session.get(key);
  return got[key] ?? fallback;
}

export async function getTaskTabId() {
  const id = await readSession('taskTabId', null);
  if (id === null) return null;
  try {
    await chrome.tabs.get(id);
    return id;
  } catch {
    return null;
  }
}

export async function setTaskTab(tabId) {
  await chrome.storage.session.set({ taskTabId: tabId });
}

async function markEyaTab(tabId) {
  const list = await readSession('eyaTabs', []);
  if (!list.includes(tabId)) await chrome.storage.session.set({ eyaTabs: [...list, tabId] });
}

async function forgetEyaTab(tabId) {
  const list = await readSession('eyaTabs', []);
  if (list.includes(tabId)) await chrome.storage.session.set({ eyaTabs: list.filter((t) => t !== tabId) });
  if ((await readSession('taskTabId', null)) === tabId) await chrome.storage.session.remove('taskTabId');
}

async function isEyaTab(tabId) {
  return (await readSession('eyaTabs', [])).includes(tabId);
}

/** The tab to act on: the one Eya is working in, else whatever the user is looking at right now. */
export async function resolveTabId(requested) {
  if (requested !== undefined && requested !== null) return requested;
  const task = await getTaskTabId();
  if (task !== null) return task;
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id === undefined) throw new Error('There is no browser tab to look at.');
  return active.id;
}

// ------------------------------------------------------------------ helpers
export function hostKey(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

const SECRET_PARAM = /token|key|auth|sess|sid|code|secret|sig|pass|jwt|otp|credential|bearer|ticket|nonce|csrf|xsrf/i;

/**
 * The address as Eya is allowed to see it. Fragments are dropped, and so is any
 * query parameter that looks like a credential (or is long enough to be one) —
 * magic-link and OAuth URLs carry live tokens that must never reach the model.
 */
export function redactedUrl(raw) {
  try {
    const u = new URL(raw);
    const kept = [];
    for (const [k, v] of u.searchParams) {
      if (SECRET_PARAM.test(k) || v.length > 40) continue;
      kept.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
    return `${u.origin}${u.pathname}${kept.length > 0 ? `?${kept.join('&')}` : ''}`.slice(0, 240);
  } catch {
    return '';
  }
}

export function assertWebUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('That is not a valid address.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only normal http(s) addresses can be opened.');
  return u;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitTabComplete(tabId, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return false;
    }
    if (tab.status === 'complete') return true;
    await sleep(80);
  }
  return false;
}

export function sawLoading(tabId, sinceMs) {
  return tabUpdates.some((u) => u.tabId === tabId && u.status === 'loading' && u.at >= sinceMs);
}

export function newTabsSince(sinceMs, actingTabId) {
  return createdTabs
    .filter((t) => t.at >= sinceMs && t.tabId !== actingTabId)
    .filter((t) => t.openerTabId === actingTabId || t.openerTabId === undefined)
    .map((t) => t.tabId);
}

export function downloadsSince(sinceMs) {
  return Array.from(downloads.values()).filter((d) => d.at >= sinceMs);
}

/** Wait for a download that an action started (if any) and report where it landed. */
export async function awaitDownload(sinceMs, { startWaitMs = 2200, finishWaitMs = 25000 } = {}) {
  const start = Date.now();
  let found = downloadsSince(sinceMs)[0];
  while (found === undefined && Date.now() - start < startWaitMs) {
    await sleep(100);
    found = downloadsSince(sinceMs)[0];
  }
  if (found === undefined) return null;
  const finishBy = Date.now() + finishWaitMs;
  while (Date.now() < finishBy) {
    const [item] = await chrome.downloads.search({ id: found.id });
    if (item) {
      found.filename = item.filename || found.filename;
      found.state = item.state;
      found.bytes = item.fileSize > 0 ? item.fileSize : (item.totalBytes ?? found.bytes);
      found.mime = item.mime || found.mime;
      if (item.error) found.error = item.error;
    }
    if (found.state !== 'in_progress' && found.filename) break;
    if (found.state === 'interrupted') break;
    await sleep(150);
  }
  return {
    downloadId: found.id,
    filename: found.filename,
    state: found.state,
    bytes: found.bytes,
    mime: found.mime,
    ...(found.error ? { error: found.error } : {}),
  };
}

// --------------------------------------------------------------- operations
export async function listTabs() {
  const [all, taskId, eya] = await Promise.all([chrome.tabs.query({}), getTaskTabId(), readSession('eyaTabs', [])]);
  return all
    .filter((t) => t.id !== undefined && !t.incognito)
    .slice(0, 40)
    .map((t) => ({
      tabId: t.id,
      windowId: t.windowId,
      title: (t.title ?? '').slice(0, 90),
      url: redactedUrl(t.url ?? t.pendingUrl ?? ''),
      active: t.active === true,
      openedByEya: eya.includes(t.id),
      workingHere: t.id === taskId,
    }));
}

export async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  await setTaskTab(tabId);
  return tab;
}

/**
 * Open a web address, preferring an existing tab over a new one.
 * Returns { tabId, reuse } where reuse is 'focused' | 'navigated' | null.
 */
export async function openUrl(raw) {
  const target = assertWebUrl(raw);
  const key = hostKey(target.href);
  const all = (await chrome.tabs.query({})).filter((t) => t.id !== undefined && !t.incognito);
  const sameHost = all.filter((t) => hostKey(t.url ?? t.pendingUrl ?? '') === key);
  const isRoot = (target.pathname === '/' || target.pathname === '') && target.search === '';

  // Already showing exactly this, or asked for a site's front door and a tab of that site is open: just go there.
  const exact = sameHost.find((t) => (t.url ?? '').split('#')[0] === target.href.split('#')[0]);
  const focusOnly = exact ?? (isRoot ? sameHost.find((t) => t.active) ?? sameHost[0] : undefined);
  if (focusOnly?.id !== undefined) {
    await focusTab(focusOnly.id);
    return { tabId: focusOnly.id, reuse: 'focused' };
  }

  // A tab Eya opened herself on this site can be steered somewhere new; the user's own tabs cannot.
  for (const t of sameHost) {
    if (t.id !== undefined && (await isEyaTab(t.id))) {
      await chrome.tabs.update(t.id, { url: target.href, active: true });
      await chrome.windows.update(t.windowId, { focused: true }).catch(() => undefined);
      await setTaskTab(t.id);
      return { tabId: t.id, reuse: 'navigated' };
    }
  }

  const sibling = sameHost[0];
  const created = await chrome.tabs.create({
    url: target.href,
    active: true,
    ...(sibling !== undefined ? { windowId: sibling.windowId, index: sibling.index + 1 } : {}),
  });
  if (created.id === undefined) throw new Error('The browser did not open a tab.');
  await markEyaTab(created.id);
  await setTaskTab(created.id);
  return { tabId: created.id, reuse: null };
}

/** A background tab that lives only for the length of one lookup, then closes. */
export async function withThrowawayTab(url, work) {
  assertWebUrl(url);
  const tab = await chrome.tabs.create({ url, active: false });
  if (tab.id === undefined) throw new Error('The browser did not open a tab.');
  try {
    await waitTabComplete(tab.id, 15000);
    return await work(tab.id);
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}
