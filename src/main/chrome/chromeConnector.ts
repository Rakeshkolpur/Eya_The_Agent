import type { BrowserName } from './protocol';

/**
 * "Connect my browser": the user-initiated step that lets the Eya Browser Bridge
 * extension (in Chrome, in Edge, or in both) pair with this app. It opens a short
 * pairing window on the bridge and, when no extension has ever shown up, opens the
 * browser's extensions page and the extension's folder so the one-time "Load
 * unpacked" is two clicks. It cannot do that install for the user — browsers only
 * allow it from the user's own hands — and says so rather than pretending.
 *
 * Every browser whose extension is running gets paired in the same window, so
 * connecting Chrome and Edge is one request, not two.
 */
export interface ConnectorBridge {
  isConnected(browser?: BrowserName): boolean;
  connectedBrowsers(): BrowserName[];
  /** Extensions that are running and trying to connect but are not paired yet. */
  waitingToPair(): BrowserName[];
  info(): { readonly browsers: Readonly<Partial<Record<BrowserName, { readonly connected: boolean; readonly paired: boolean }>>> };
  openPairingWindow(): number;
}

export interface ChromeConnectResult {
  /** At least one browser is connected. */
  readonly connected: boolean;
  /** Every browser that was already connected before this request, with nothing left to pair. */
  readonly alreadyConnected: boolean;
  readonly browsers: readonly BrowserName[];
  /** Browsers whose extension is running but did not get paired in time. */
  readonly stillWaiting: readonly BrowserName[];
  readonly extensionFolder: string;
  /** The extensions page and the extension folder were opened for the user. */
  readonly helpOpened: boolean;
}

export interface ChromeConnector {
  connect(waitMs?: number): Promise<ChromeConnectResult>;
}

export interface ConnectorDeps {
  readonly bridge: ConnectorBridge;
  readonly extensionFolder: string;
  readonly openExtensionsPage: () => Promise<void>;
  readonly revealFolder: (path: string) => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const DEFAULT_WAIT_MS = 25_000;
const POLL_MS = 500;
// After the first browser connects, give a second browser's extension this long to pair in the same window.
const OTHERS_GRACE_MS = 6000;

export function createChromeConnector(deps: ConnectorDeps): ChromeConnector {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  return {
    async connect(waitMs = DEFAULT_WAIT_MS): Promise<ChromeConnectResult> {
      const base = { extensionFolder: deps.extensionFolder };
      const connectedAtStart = deps.bridge.connectedBrowsers();
      if (connectedAtStart.length > 0 && deps.bridge.waitingToPair().length === 0) {
        return { ...base, connected: true, alreadyConnected: true, browsers: connectedAtStart, stillWaiting: [], helpOpened: false };
      }

      // Open for pairing in every case: it covers a first install, a second browser, and a reinstalled extension that lost its secret.
      deps.bridge.openPairingWindow();
      let helpOpened = false;
      const openHelp = async () => {
        helpOpened = true;
        await deps.openExtensionsPage().catch(() => undefined);
        await deps.revealFolder(deps.extensionFolder).catch(() => undefined);
      };
      // Has any extension ever shown itself? If so it is simply a matter of letting it connect; if not, help the user add it.
      const known = Object.values(deps.bridge.info().browsers).some((b) => b !== undefined) || deps.bridge.waitingToPair().length > 0;
      if (!known) await openHelp();

      const deadline = now() + waitMs;
      let firstConnectedAt: number | null = connectedAtStart.length > 0 ? now() : null;
      while (now() < deadline) {
        if (firstConnectedAt === null && deps.bridge.connectedBrowsers().length > 0) firstConnectedAt = now();
        const waiting = deps.bridge.waitingToPair();
        if (firstConnectedAt !== null && (waiting.length === 0 || now() - firstConnectedAt >= OTHERS_GRACE_MS)) break;
        await sleep(POLL_MS);
      }

      const browsers = deps.bridge.connectedBrowsers();
      const stillWaiting = deps.bridge.waitingToPair();
      if (browsers.length === 0 && !helpOpened) await openHelp();
      return { ...base, connected: browsers.length > 0, alreadyConnected: false, browsers, stillWaiting, helpOpened };
    },
  };
}
