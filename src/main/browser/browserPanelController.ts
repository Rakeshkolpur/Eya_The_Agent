import { rootLogger } from '@main/logging/logger';
import { IpcChannels } from '@shared/ipcContract';
import type { BrowserKind, BrowserPanelAction, BrowserPanelResult, BrowserViewBounds, PanelTab } from '@shared/browserPanel';
import type { BrowserName } from '@main/chrome/protocol';
import type { ChromeConnector } from '@main/chrome/chromeConnector';
import type { BrowserPanel } from './BrowserPanel';
import type { EmbeddedBrowserService } from './EmbeddedBrowserService';

const log = rootLogger.child('browser.panel');

const NAME: Record<BrowserName, string> = { chrome: 'Chrome', edge: 'Edge', other: 'browser' };

export interface BrowserPanelWiring {
  readonly panel: BrowserPanel;
  /** Eya Browser (drawn inside the Eya window), for its events, tabs and the address bar. */
  readonly eya: EmbeddedBrowserService;
  readonly bridge: {
    connectedBrowsers(): BrowserName[];
    onConnectionChange(listener: () => void): () => void;
    forgetPairing(browser?: BrowserName): void;
  };
  readonly connector: ChromeConnector;
  readonly openExternal: (url: string) => void;
  readonly send: (channel: string, payload: unknown) => void;
  readonly setPreference: (kind: BrowserKind) => void;
  /** Stop was pressed: whatever request is being worked on is ended on the spot (not only the browser steps that come after it). */
  readonly onStop?: () => void;
}

/** What was typed in the address bar, as an address: a web address as it is, a bare site name with https, anything else is a search (like any browser). */
export function addressFrom(text: string): string | null {
  const t = text.trim();
  if (t === '') return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return /^https?:\/\//i.test(t) ? t : null;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(t) || /^localhost(:\d+)?([/?#].*)?$/i.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}


/** What the Browser page can do and sees, with no Electron in it: its controls, where the browser is drawn, the page events that feed it. */
export function createBrowserPanelController(w: BrowserPanelWiring): {
  act: (action: BrowserPanelAction) => Promise<BrowserPanelResult>;
  get: () => Promise<ReturnType<BrowserPanel['get']>>;
  setView: (bounds: BrowserViewBounds | null) => void;
  dispose: () => void;
} {
  const { panel, eya } = w;
  const host = eya.host;
  const refreshTabs = async (): Promise<void> => {
    try {
      const raw = (await host.request<{ tabs?: Array<{ tabId: number; title: string; url: string; active: boolean }> }>('list_tabs')).tabs ?? [];
      const tabs: PanelTab[] = raw.map((t) => ({ id: t.tabId, title: t.title, url: t.url, active: t.active }));
      panel.setTabs(tabs);
    } catch {
      panel.setTabs([]);
    }
  };
  const refreshMine = (): void => panel.setMyBrowsers(w.bridge.connectedBrowsers().map((b) => NAME[b]));
  refreshMine();

  const offHost = host.onEvent((e) => {
    switch (e.type) {
      case 'page':
        // A problem stays on the page until the next page starts to load (the browser's own error page finishing loading must not wipe it).
        panel.setPage({ url: e.url, title: e.title, loading: e.loading, ...(e.loading ? { error: null } : {}) });
        if (!e.loading) void refreshTabs();
        break;
      case 'problem':
        panel.setPage({ loading: false, error: e.message });
        panel.note('warn', e.message.slice(0, 200));
        break;
      case 'tabs':
        void refreshTabs();
        break;
      case 'closed':
        panel.setTabs([]);
        panel.setPage({ loading: false });
        panel.note('warn', 'Eya Browser was closed. It opens again the next time Eya needs it.');
        break;
    }
  });
  const offBridge = w.bridge.onConnectionChange(refreshMine);
  const offPanel = panel.onChange((state) => w.send(IpcChannels.browserPanelChanged, state));

  const done = (ok: boolean, message: string): BrowserPanelResult => ({ ok, message, state: panel.get() });

  const act = async (action: BrowserPanelAction): Promise<BrowserPanelResult> => {
    switch (action.type) {
      case 'pause':
        panel.pause();
        return done(true, 'Paused. Eya waits before her next step.');
      case 'resume':
        panel.resume();
        return done(true, 'Carrying on.');
      case 'stop':
        panel.stop();
        // The request itself is ended at once, and a page that is still loading stops loading.
        w.onStop?.();
        void host.request('stop_loading').catch(() => undefined);
        return done(true, 'Stopped.');
      case 'take_over':
        panel.takeOver();
        await host.request('show_window').catch(() => undefined);
        return done(true, 'The browser is yours: click and type in it as you like. Then press "Hand back to Eya".');
      case 'hand_back':
        panel.handBack();
        return done(true, 'Handed back. Eya looks at the page as it is now and carries on.');
      case 'show_window':
        await host.request('show_window').catch(() => undefined);
        return done(true, 'Eya Browser is open.');
      case 'navigate': {
        const url = addressFrom(action.url);
        if (url === null) return done(false, 'Type a web address (https://…) or a site name.');
        await panel.asUser(async () => {
          panel.setPage({ loading: true, error: null });
          try {
            await eya.openWebsite(url);
          } catch (err) {
            panel.setPage({ loading: false, error: err instanceof Error ? err.message : String(err) });
          }
        });
        return done(true, 'Opened.');
      }
      case 'back':
      case 'forward':
      case 'reload':
      case 'stop_loading':
      case 'new_tab': {
        const op = action.type === 'new_tab' ? 'new_tab' : action.type === 'stop_loading' ? 'stop_loading' : action.type;
        await panel.asUser(async () => {
          try {
            await host.request(op);
          } catch (err) {
            panel.setPage({ loading: false, error: err instanceof Error ? err.message : String(err) });
          }
        });
        return done(true, '');
      }
      case 'focus_tab':
        await host.request('focus_tab', { tabId: action.id }).catch(() => undefined);
        void refreshTabs();
        return done(true, '');
      case 'open_in_my_browser': {
        const url = panel.get().url;
        if (!/^https?:\/\//i.test(url)) return done(false, 'There is no page open to send.');
        w.openExternal(url);
        return done(true, 'Opened this page in your normal browser.');
      }
      case 'connect_my_browser': {
        panel.note('info', 'Connecting your browser (My Browser)…');
        const r = await w.connector.connect(25_000);
        refreshMine();
        if (r.connected) return done(true, `Connected: ${r.browsers.map((b) => NAME[b]).join(' and ')}. Eya uses it only when you ask her to, or when you choose it in settings.`);
        if (r.outdated.length > 0) return done(false, 'The Eya extension in your browser is the old version. Open the extensions page, press reload on "Eya Browser Bridge", then try again.');
        return done(false, r.extensionSeen ? 'Your browser has not answered yet. Make sure it is open with the Eya Browser Bridge extension on, then try again.' : 'The Eya Browser Bridge extension is not in your browser yet. I opened its folder and the extensions page: turn on Developer mode, press "Load unpacked", choose that folder, then try again.');
      }
      case 'disconnect_my_browser':
        w.bridge.forgetPairing();
        refreshMine();
        panel.note('info', 'You disconnected My Browser.');
        return done(true, 'Disconnected. Eya will not use your browser until you connect it again.');
    }
  };


  const get = async (): Promise<ReturnType<BrowserPanel['get']>> => {
    refreshMine();
    await refreshTabs();
    return panel.get();
  };

  /** The Browser page says where it has room for the browser (null: it is not showing). */
  const setView = (bounds: BrowserViewBounds | null): void => host.setViewBounds(bounds);

  return {
    act: (action) =>
      act(action).catch((err: unknown) => {
        log.warn('browser panel action failed', { err: String(err) });
        return done(false, err instanceof Error ? err.message : String(err));
      }),
    get,
    setView,
    dispose: () => {
      offHost();
      offBridge();
      offPanel();
      host.setViewBounds(null);
    },
  };
}
