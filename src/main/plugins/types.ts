import type { ConnectionState, PluginRisk } from '@shared/plugins';

/**
 * The plugin interface. A plugin is a MANIFEST (what it is, what it needs, what it can do) plus a CONNECTOR (Eya's own code that says whether the account
 * is linked). Its actions are carried out by tools in the one ToolRegistry the agent already uses — a plugin adds no second way to run anything, and no code
 * is ever downloaded: a manifest can only name tools that are already part of Eya.
 */

export interface PluginPermission {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly risk: PluginRisk;
}

/**
 * How an action is held to its permission:
 *   registry  — the tools are the plugin's own; the registry hides and refuses them while the plugin cannot be used.
 *   send_gate — the tools are general browser tools (typing in a box, clicking Send) that other things use too; what is held to the permission is the
 *               SEND itself, at the page gate that already guards every Send click in a chat app.
 */
export type PluginGate = 'registry' | 'send_gate';

export interface PluginActionDef {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The tools that carry it out (all of them are registered tools; checked when the manifest is validated). Empty for an action that is not supported. */
  readonly tools: readonly string[];
  readonly gate: PluginGate;
  /** The permission it needs. Required for a supported action. */
  readonly permission?: string;
  /** It changes something outside Eya (sends a message or a file). */
  readonly consequential?: boolean;
  /** What is the result of the action in the world, and how it is checked afterwards. */
  readonly verify: string;
  /** Why it is not supported: set for an action that is declared so the person can see it is NOT there, never for one that works. */
  readonly unsupported?: string;
}

export type PluginAuth =
  /** Nothing to link. */
  | { readonly kind: 'none'; readonly describe: string }
  /** The person's own switch for an app in Communication Access, and their own sign-in to the app in their browser (WhatsApp Web's QR code). */
  | { readonly kind: 'app_switch'; readonly app: string; readonly describe: string };

export interface PluginManifest {
  /** Lower-case letters, digits and hyphens; never changes. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Semantic version, "1.2.0". */
  readonly version: string;
  readonly author: string;
  /** The Eya versions it works with. */
  readonly compat: { readonly minEya: string; readonly maxEya?: string };
  readonly auth: PluginAuth;
  readonly permissions: readonly PluginPermission[];
  readonly actions: readonly PluginActionDef[];
  /** Installed and switched on when Eya is first run (a plugin the person already relies on). */
  readonly bundled?: boolean;
}

/** How far a catalogue entry is trusted. Only `built-in` can be installed today: it ships inside Eya, so there is nothing to download or run. */
export type PluginTrust = 'built-in';

export interface CatalogEntry {
  readonly manifest: PluginManifest;
  readonly trust: PluginTrust;
}

/**
 * Where plugins are offered from. Today there is one source, the plugins that ship with Eya. A remote catalogue would be another implementation of this
 * interface — returning manifests, with whatever signature checks it needs — and would plug in here without changing anything else.
 */
export interface CatalogSource {
  readonly name: string;
  /** False for a source on this PC; true for one that fetches from elsewhere. Said as it is on the Plugins page. */
  readonly remote: boolean;
  entries(): readonly CatalogEntry[];
}

export interface ConnectorStatus {
  readonly state: ConnectionState;
  readonly detail: string;
}

export interface ConnectorResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Eya's own code for a plugin's account: is it linked right now, and how to link or unlink it. `connect` and `disconnect` are called only from the person's
 * own click on the Plugins page — no tool, no voice command, no web page can reach them.
 */
export interface PluginConnector {
  status(): ConnectorStatus;
  connect(): ConnectorResult;
  disconnect(): ConnectorResult;
}

/** What the person has done with one plugin; the only thing written to disk. Never an account, a token, a contact or a message. */
export interface PluginRecord {
  readonly installedVersion: string;
  readonly enabled: boolean;
  /** Permission ids the person granted. */
  readonly granted: readonly string[];
}

export interface PluginState {
  readonly version: 1;
  readonly plugins: Readonly<Record<string, PluginRecord>>;
  /** Plugins that ship with Eya and that the person took off: they are not put back by themselves. */
  readonly removed: readonly string[];
}

/** Why a tool of a plugin cannot be used right now (or null when it can, or when no plugin owns it). */
export interface ToolBlock {
  readonly plugin: string;
  readonly reason: string;
}
