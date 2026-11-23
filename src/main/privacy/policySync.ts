import { rootLogger } from '@main/logging/logger';
import type { BrowserName } from '@main/chrome/protocol';
import type { BlockRule } from './communicationAccess';

const log = rootLogger.child('privacy.sync');

/** What it needs from the browser bridge: who is connected, a way to ask one browser's extension something, and connection changes. */
export interface PolicySyncBridge {
  connectedBrowsers(): BrowserName[];
  forBrowser(browser: BrowserName): { request<T = unknown>(op: string, args?: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<T> };
  onConnectionChange(listener: (e: { browser: BrowserName; connected: boolean }) => void): () => void;
}

export interface PolicySyncDeps {
  readonly bridge: PolicySyncBridge;
  /** The hosts the extension must NOT read or act in, right now. */
  readonly blockRules: () => readonly BlockRule[];
  /** Calls back whenever the user changes Communication Access. */
  readonly onPolicyChange: (listener: () => void) => () => void;
}

/**
 * Keeps the browser extension's block list in step with the user's Communication Access switch: sent as soon as a browser
 * connects and again whenever the switch changes. Until it arrives the extension blocks every chat app (fail closed), so a
 * slow or failed send can only ever make Eya more careful, never less. An extension too old to know the request is fine —
 * Eya's own checks still apply.
 */
export function startPolicySync(deps: PolicySyncDeps): () => void {
  async function push(browser: BrowserName): Promise<void> {
    try {
      await deps.bridge.forBrowser(browser).request('set_policy', { blocked: deps.blockRules() }, 5000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/unknown request/i.test(message)) log.info('this browser extension is too old to take the chat-app block list; Eya enforces it on her side', { browser });
      else log.warn('could not send the chat-app block list to the browser extension', { browser, err: message });
    }
  }
  const offConnect = deps.bridge.onConnectionChange((e) => {
    if (e.connected) void push(e.browser);
  });
  const offChange = deps.onPolicyChange(() => {
    for (const browser of deps.bridge.connectedBrowsers()) void push(browser);
  });
  return () => {
    offConnect();
    offChange();
  };
}
