/**
 * What the Plugins page shows and can ask for. A plugin has three separate states that must never be confused:
 *   INSTALLED   — it is on this PC and Eya knows what it can do. Nothing about any account.
 *   CONNECTED   — the person has linked the account or session it works in (for WhatsApp: allowed it in Communication Access).
 *   AUTHORIZED  — the person has granted a particular permission; an action runs only if its permission is granted.
 * Installing never connects or grants anything.
 */

export type PluginRisk = 'read' | 'write' | 'send' | 'destructive';

export interface PluginPermissionView {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly risk: PluginRisk;
  readonly granted: boolean;
}

export interface PluginActionView {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The permission it needs (absent for an action that is not supported). */
  readonly permission: string | null;
  /** It changes something outside Eya (a message sent, a file sent): it is checked afterwards and never repeated on a guess. */
  readonly consequential: boolean;
  /** How the result is checked, in words. */
  readonly verify: string;
  readonly supported: boolean;
  /** For an action that is not supported: why (so nothing is promised that does not work). */
  readonly unsupportedReason: string | null;
}

/** Whether the plugin can be used right now, and if not, what is missing — in the order the person has to fix it. */
export type PluginStatus = 'ready' | 'not_installed' | 'disabled' | 'not_connected' | 'missing_permission' | 'incompatible' | 'error';

export type ConnectionState = 'connected' | 'not_connected' | 'error';

export interface PluginView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The version in the catalogue. */
  readonly version: string;
  /** The version on this PC, or null when it is not installed. */
  readonly installedVersion: string | null;
  readonly updateAvailable: boolean;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly connection: ConnectionState;
  /** What "connected" means for this plugin, in a sentence (and what is wrong, when it is not). */
  readonly connectionDetail: string;
  /** How the person links their account: a sentence. */
  readonly authDescription: string;
  readonly status: PluginStatus;
  readonly statusText: string;
  readonly compatible: boolean;
  readonly compatibilityNote: string;
  readonly origin: string;
  readonly author: string;
  readonly permissions: readonly PluginPermissionView[];
  readonly actions: readonly PluginActionView[];
  readonly lastError: string | null;
}

export interface PluginsSnapshot {
  readonly plugins: readonly PluginView[];
  /** Where the list comes from, said plainly: nothing here pretends a marketplace is connected. */
  readonly catalogue: { readonly source: string; readonly remote: boolean; readonly note: string };
}

export type PluginChange =
  | { readonly kind: 'install' | 'uninstall' | 'enable' | 'disable' | 'connect' | 'disconnect' | 'update'; readonly id: string }
  | { readonly kind: 'grant' | 'revoke'; readonly id: string; readonly permission: string }
  | { readonly kind: 'grant_all'; readonly id: string };

export interface PluginChangeResult {
  readonly ok: boolean;
  /** One sentence for the person: what happened, or why not. */
  readonly message: string;
  readonly snapshot: PluginsSnapshot;
}

/** A choice sent by the page, checked: anything that is not exactly one of the known choices is nothing. */
export function parsePluginChange(raw: unknown): PluginChange | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r['id'] === 'string' && /^[a-z][a-z0-9-]{1,40}$/.test(r['id']) ? r['id'] : null;
  if (id === null) return null;
  switch (r['kind']) {
    case 'install':
    case 'uninstall':
    case 'enable':
    case 'disable':
    case 'connect':
    case 'disconnect':
    case 'update':
    case 'grant_all':
      return { kind: r['kind'], id };
    case 'grant':
    case 'revoke':
      return typeof r['permission'] === 'string' && /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(r['permission']) ? { kind: r['kind'], id, permission: r['permission'] } : null;
    default:
      return null;
  }
}
