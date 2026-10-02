/**
 * The wire format between the Eya desktop app and the Eya Browser Bridge
 * extension, plus the few constants both ends must agree on.
 *
 * The extension's ID is fixed by the public key in its manifest (see
 * eya-chrome-extension/manifest.json) so the desktop side can insist that a
 * connection really comes from that extension and not from some web page or
 * other program that merely found the port.
 */
export const EYA_EXTENSION_ID = 'edokidnlajcpopeadgnnmhomhhoaomhm';
export const EXTENSION_ORIGIN = `chrome-extension://${EYA_EXTENSION_ID}`;
export const BRIDGE_HOST = '127.0.0.1';
export const BRIDGE_PORT = 47821;
export const BRIDGE_PATH = '/eya-bridge';

export type RefusalReason = 'not_pairing' | 'bad_secret' | 'protocol';

/** Extension → desktop. */
export type ExtensionMessage =
  | { readonly t: 'hello'; readonly ext: string; readonly version: string; readonly browser: string; readonly secret?: string }
  | { readonly t: 'res'; readonly id: number; readonly ok: boolean; readonly result?: unknown; readonly error?: string }
  | { readonly t: 'ping' }
  | { readonly t: 'pong' };

/** Desktop → extension. */
export type DesktopMessage =
  | { readonly t: 'ready' }
  | { readonly t: 'paired'; readonly secret: string }
  | { readonly t: 'refused'; readonly reason: RefusalReason }
  | { readonly t: 'req'; readonly id: number; readonly op: string; readonly args: Readonly<Record<string, unknown>> }
  | { readonly t: 'ping' }
  | { readonly t: 'pong' };

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
    case 'hello':
      if (typeof m['ext'] !== 'string' || typeof m['version'] !== 'string' || typeof m['browser'] !== 'string') return null;
      if (m['secret'] !== undefined && typeof m['secret'] !== 'string') return null;
      return {
        t: 'hello',
        ext: m['ext'],
        version: m['version'],
        browser: m['browser'],
        ...(typeof m['secret'] === 'string' ? { secret: m['secret'] } : {}),
      };
    case 'res':
      if (typeof m['id'] !== 'number' || typeof m['ok'] !== 'boolean') return null;
      return {
        t: 'res',
        id: m['id'],
        ok: m['ok'],
        ...(m['result'] !== undefined ? { result: m['result'] } : {}),
        ...(typeof m['error'] === 'string' ? { error: m['error'] } : {}),
      };
    case 'ping':
      return { t: 'ping' };
    case 'pong':
      return { t: 'pong' };
    default:
      return null;
  }
}
