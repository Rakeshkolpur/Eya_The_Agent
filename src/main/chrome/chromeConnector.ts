import type { BrowserName } from './protocol';

/**
 * "Connect my browser": the user-initiated step that lets the Eya Browser Bridge
 * extension (in Chrome, in Edge, or in both) pair with this app. It opens a short
 * pairing window on the bridge and, only when no extension has ever shown up (never
 * paired, never knocked), opens the browser's extensions page and the extension's
 * folder so the one-time "Load unpacked" is two clicks — once per run of Eya, never
 * again just because a browser is slow to answer. An extension that was set up before
 * but is not connecting right now is not a missing extension: nothing is opened for it,
 * and the user is told what to check. The user can still ask for the folder outright.
 * It cannot do the install for the user — browsers only allow it from the user's own
 * hands — and says so rather than pretending.
 *
 * Every browser whose extension is running gets paired in the same window, so
 * connecting Chrome and Edge is one request, not two.
 */
export interface ConnectorBridge {
  isConnected(browser?: BrowserName): boolean;
  connectedBrowsers(): BrowserName[];
  /** Extensions that are running and trying to connect but are not paired yet. */
  waitingToPair(): BrowserName[];
  /** Extensions that are running but were refused for being an older version than this Eya needs. */
  outdated(): BrowserName[];
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
  /** Browsers whose extension is installed and running but is an older version than this Eya speaks: it only needs reloading. */
  readonly outdated: readonly BrowserName[];
  readonly extensionFolder: string;
  /** The extensions page and the extension folder were opened for the user (this call). */
  readonly helpOpened: boolean;
  /** An extension has been paired, or has tried to connect, before: it is installed, so a failure to connect is not "not installed". */
  readonly extensionSeen: boolean;
}

export interface ConnectOptions {
  /** The user asked to see the extension folder: open it (and the extensions page) even though an extension is known. */
  readonly showInstallHelp?: boolean;
}

export interface ChromeConnector {
  connect(waitMs?: number, options?: ConnectOptions): Promise<ChromeConnectResult>;
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

  // The folder pops up in the user's file manager, so it must not repeat: at most once per run of Eya, unless asked for.
  let helpShownThisRun = false;

  return {
    async connect(waitMs = DEFAULT_WAIT_MS, options: ConnectOptions = {}): Promise<ChromeConnectResult> {
      const base = { extensionFolder: deps.extensionFolder };
      const connectedAtStart = deps.bridge.connectedBrowsers();
      if (connectedAtStart.length > 0 && deps.bridge.waitingToPair().length === 0 && options.showInstallHelp !== true) {
        return { ...base, connected: true, alreadyConnected: true, browsers: connectedAtStart, stillWaiting: [], outdated: [], helpOpened: false, extensionSeen: true };
      }

      // Open for pairing in every case: it covers a first install, a second browser, and a reinstalled extension that lost its secret.
      deps.bridge.openPairingWindow();
      let helpOpened = false;
      const openHelp = async () => {
        helpOpened = true;
        helpShownThisRun = true;
        await deps.openExtensionsPage().catch(() => undefined);
        await deps.revealFolder(deps.extensionFolder).catch(() => undefined);
      };
      // Has any extension ever shown itself (paired before, or knocking now)? If so it is installed and it is simply a matter of
      // letting it connect — nothing is opened. Only a truly first install gets the page and the folder, and only once per run.
      const known = Object.values(deps.bridge.info().browsers).some((b) => b !== undefined) || deps.bridge.waitingToPair().length > 0;
      if (options.showInstallHelp === true || (!known && !helpShownThisRun)) await openHelp();

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
      // No last-resort pop-up here: a browser that has not answered yet (closed, asleep, an old extension waiting for its reload)
      // is not a missing extension, and the user is told what to check instead.
      const outdated = deps.bridge.outdated();
      return {
        ...base,
        connected: browsers.length > 0,
        alreadyConnected: false,
        browsers,
        stillWaiting,
        outdated,
        helpOpened,
        extensionSeen: known || stillWaiting.length > 0 || browsers.length > 0 || outdated.length > 0,
      };
    },
  };
}
