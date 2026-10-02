/**
 * "Connect my browser": the user-initiated step that lets the Eya Browser
 * Bridge extension pair with this app. It opens a short pairing window on the
 * bridge and, when the extension is not installed yet, opens the browser's
 * extensions page and the extension's folder so the one-time "Load unpacked"
 * is two clicks. It cannot do that install for the user — browsers only allow
 * it from the user's own hands — and says so rather than pretending.
 */
export interface ConnectorBridge {
  isConnected(): boolean;
  info(): { readonly connected: boolean; readonly browser?: string | undefined; readonly paired: boolean };
  openPairingWindow(): number;
}

export interface ChromeConnectResult {
  readonly connected: boolean;
  readonly alreadyConnected: boolean;
  readonly browser?: string;
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

export function createChromeConnector(deps: ConnectorDeps): ChromeConnector {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  return {
    async connect(waitMs = DEFAULT_WAIT_MS): Promise<ChromeConnectResult> {
      const base = { extensionFolder: deps.extensionFolder };
      if (deps.bridge.isConnected()) {
        const browser = deps.bridge.info().browser;
        return { ...base, connected: true, alreadyConnected: true, helpOpened: false, ...(browser !== undefined ? { browser } : {}) };
      }

      // Open for pairing in every case: it covers a first install and a reinstalled extension that lost its secret.
      deps.bridge.openPairingWindow();
      let helpOpened = false;
      const openHelp = async () => {
        helpOpened = true;
        await deps.openExtensionsPage().catch(() => undefined);
        await deps.revealFolder(deps.extensionFolder).catch(() => undefined);
      };
      if (!deps.bridge.info().paired) await openHelp();

      const deadline = now() + waitMs;
      while (now() < deadline && !deps.bridge.isConnected()) await sleep(POLL_MS);

      if (deps.bridge.isConnected()) {
        const browser = deps.bridge.info().browser;
        return { ...base, connected: true, alreadyConnected: false, helpOpened, ...(browser !== undefined ? { browser } : {}) };
      }
      if (!helpOpened) await openHelp();
      return { ...base, connected: false, alreadyConnected: false, helpOpened };
    },
  };
}
