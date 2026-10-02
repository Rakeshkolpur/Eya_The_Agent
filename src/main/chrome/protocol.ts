/**
 * The wire format between the Eya desktop app and the Eya Browser Bridge
 * extension, plus the few constants both ends must agree on.
 *
 * The extension's ID is fixed by the public key in its manifest (see
 * eya-chrome-extension/manifest.json) so the desktop side can insist that a
 * connection really comes from that extension and not from some web page or
 * other program that merely found the port.
 *
 * Version 2 adds: the browser's identity and version, a capability list and a
 * snapshot of the browser's windows and tabs in the handshake itself, and live
 * browser events — so Eya always knows which browser she is talking to and what
 * is open in it, without having to ask.
 */
export const EYA_EXTENSION_ID = 'edokidnlajcpopeadgnnmhomhhoaomhm';
export const EXTENSION_ORIGIN = `chrome-extension://${EYA_EXTENSION_ID}`;
export const BRIDGE_HOST = '127.0.0.1';
export const BRIDGE_PORT = 47821;
export const BRIDGE_PATH = '/eya-bridge';

/** Bumped whenever the messages change incompatibly; an extension speaking another version is refused with a clear reason. */
export const PROTOCOL_VERSION = 2;

/** Which browser an extension is running in. Chrome and Edge are tracked independently; anything else Chromium-based is "other". */
export type BrowserName = 'chrome' | 'edge' | 'other';
export const BROWSER_NAMES: readonly BrowserName[] = ['chrome', 'edge', 'other'];

export function toBrowserName(raw: string): BrowserName {
  return raw === 'chrome' || raw === 'edge' ? raw : 'other';
}

export type RefusalReason = 'not_pairing' | 'bad_secret' | 'protocol' | 'incompatible';

/** What an extension says it can do. The desktop side checks it has what it needs before relying on it. */
export const REQUIRED_CAPABILITIES: readonly string[] = ['observe', 'click', 'fill', 'open_url', 'list_tabs', 'focus_tab', 'back'];

export interface WireTab {
  readonly tabId: number;
  readonly windowId: number;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
  readonly pinned: boolean;
  readonly loading: boolean;
}

export interface WireWindow {
  readonly windowId: number;
  readonly focused: boolean;
  readonly tabCount: number;
}

/** The handshake an extension opens with. */
export interface WireHello {
  readonly t: 'hello';
  readonly ext: string;
  readonly protocolVersion: number;
  readonly extensionVersion: string;
  readonly browser: string;
  readonly browserVersion: string;
  readonly capabilities: readonly string[];
  readonly tabs: readonly WireTab[];
  readonly windows: readonly WireWindow[];
  readonly activeWindowId?: number;
  readonly activeTabId?: number;
  readonly secret?: string;
}

/** Extension → desktop. */
export type ExtensionMessage =
  | WireHello
  | { readonly t: 'res'; readonly id: number; readonly ok: boolean; readonly result?: unknown; readonly error?: string }
  | { readonly t: 'event'; readonly name: string; readonly data: Readonly<Record<string, unknown>> }
  | { readonly t: 'ping' }
  | { readonly t: 'pong' };

/** Desktop → extension. */
export type DesktopMessage =
  | { readonly t: 'ready'; readonly protocolVersion: number }
  | { readonly t: 'paired'; readonly secret: string; readonly protocolVersion: number }
  | { readonly t: 'refused'; readonly reason: RefusalReason; readonly detail?: string }
  | { readonly t: 'req'; readonly id: number; readonly op: string; readonly args: Readonly<Record<string, unknown>> }
  | { readonly t: 'ping' }
  | { readonly t: 'pong' };

const str = (v: unknown, max = 600): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function parseTab(raw: unknown): WireTab | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const tabId = num(t['tabId']);
  const windowId = num(t['windowId']);
  if (tabId === undefined || windowId === undefined) return null;
  return {
    tabId,
    windowId,
    title: str(t['title'], 120),
    url: str(t['url'], 300),
    active: t['active'] === true,
    pinned: t['pinned'] === true,
    loading: t['loading'] === true,
  };
}

function parseWindow(raw: unknown): WireWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const w = raw as Record<string, unknown>;
  const windowId = num(w['windowId']);
  if (windowId === undefined) return null;
  return { windowId, focused: w['focused'] === true, tabCount: num(w['tabCount']) ?? 0 };
}

export function parseTabs(raw: unknown): WireTab[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 300).map(parseTab).filter((t): t is WireTab => t !== null);
}

/** Parses one incoming frame; anything that is not a well-formed known message is `null`. */
export function parseExtensionMessage(raw: string): ExtensionMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  switch (m['t']) {
    case 'hello': {
      if (typeof m['ext'] !== 'string' || typeof m['browser'] !== 'string') return null;
      if (m['secret'] !== undefined && typeof m['secret'] !== 'string') return null;
      const activeWindowId = num(m['activeWindowId']);
      const activeTabId = num(m['activeTabId']);
      return {
        t: 'hello',
        ext: m['ext'],
        // A version-1 extension sent `version` and no protocolVersion; it parses (so it can be refused with a reason) as protocol 1.
        protocolVersion: num(m['protocolVersion']) ?? 1,
        extensionVersion: str(m['extensionVersion'] ?? m['version'], 40),
        browser: str(m['browser'], 20),
        browserVersion: str(m['browserVersion'], 40),
        capabilities: (Array.isArray(m['capabilities']) ? m['capabilities'] : []).filter((c): c is string => typeof c === 'string').slice(0, 60),
        tabs: parseTabs(m['tabs']),
        windows: (Array.isArray(m['windows']) ? m['windows'] : []).slice(0, 50).map(parseWindow).filter((w): w is WireWindow => w !== null),
        ...(activeWindowId !== undefined ? { activeWindowId } : {}),
        ...(activeTabId !== undefined ? { activeTabId } : {}),
        ...(typeof m['secret'] === 'string' ? { secret: m['secret'] } : {}),
      };
    }
    case 'res':
      if (typeof m['id'] !== 'number' || typeof m['ok'] !== 'boolean') return null;
      return {
        t: 'res',
        id: m['id'],
        ok: m['ok'],
        ...(m['result'] !== undefined ? { result: m['result'] } : {}),
        ...(typeof m['error'] === 'string' ? { error: m['error'] } : {}),
      };
    case 'event': {
      if (typeof m['name'] !== 'string') return null;
      const data = typeof m['data'] === 'object' && m['data'] !== null ? (m['data'] as Record<string, unknown>) : {};
      return { t: 'event', name: m['name'].slice(0, 40), data };
    }
    case 'ping':
      return { t: 'ping' };
    case 'pong':
      return { t: 'pong' };
    default:
      return null;
  }
}
