/**
 * Communication Access: the user's switch for whether Eya may look at, or act inside, the apps and sites where they talk
 * to other people (WhatsApp, Telegram, Instagram…). OFF unless the user turns it on, per app if they like; there is no tool
 * or voice command that turns it on — only the switch in Eya's panel — and anything unclear fails closed to OFF.
 *
 * This file is only the catalogue and the rules: which app is this address or window, and is Eya allowed to look at it.
 * Enforcement happens where Eya reads pages, lists windows and takes pictures (and, as a second line, inside the browser
 * extension itself).
 */

/** A web address pattern: a host (and any subdomain of it), optionally only under one path. */
export interface HostRule {
  readonly host: string;
  readonly pathPrefix?: string;
}

export interface CommunicationApp {
  readonly id: string;
  readonly name: string;
  readonly hosts: readonly HostRule[];
  /** Process names (lower-case, no .exe) of the desktop version of the app. */
  readonly processes: readonly string[];
  /** In a window's title: a browser window showing the web version has its page title in the window title. */
  readonly titleHints: readonly RegExp[];
}

/**
 * The messaging apps Eya treats as private. Deliberately NOT here: e-mail and ordinary social feeds — "check my inbox" has
 * always worked and is not a chat. Add an app here and it is covered everywhere at once.
 */
export const COMMUNICATION_APPS: readonly CommunicationApp[] = [
  { id: 'whatsapp', name: 'WhatsApp', hosts: [{ host: 'web.whatsapp.com' }], processes: ['whatsapp', 'whatsapp.root'], titleHints: [/whatsapp/i] },
  { id: 'telegram', name: 'Telegram', hosts: [{ host: 'web.telegram.org' }], processes: ['telegram'], titleHints: [/telegram/i] },
  { id: 'instagram', name: 'Instagram', hosts: [{ host: 'instagram.com' }], processes: [], titleHints: [/instagram/i] },
  {
    id: 'messenger',
    name: 'Messenger',
    hosts: [{ host: 'messenger.com' }, { host: 'facebook.com', pathPrefix: '/messages' }],
    processes: ['messenger'],
    titleHints: [/messenger/i],
  },
  { id: 'discord', name: 'Discord', hosts: [{ host: 'discord.com', pathPrefix: '/channels' }], processes: ['discord'], titleHints: [/discord/i] },
  { id: 'slack', name: 'Slack', hosts: [{ host: 'app.slack.com' }], processes: ['slack'], titleHints: [/\bslack\b/i] },
  { id: 'teams', name: 'Microsoft Teams', hosts: [{ host: 'teams.microsoft.com' }, { host: 'teams.live.com' }], processes: ['ms-teams', 'teams'], titleHints: [/microsoft teams/i] },
  { id: 'signal', name: 'Signal', hosts: [], processes: ['signal'], titleHints: [/^signal$/i] },
  { id: 'skype', name: 'Skype', hosts: [{ host: 'web.skype.com' }], processes: ['skype'], titleHints: [/skype/i] },
];

export interface CommunicationSettings {
  /** The master switch. */
  readonly enabled: boolean;
  /** Per app, once the master switch is on: false turns that one app off again. An app not listed follows the master switch. */
  readonly apps: Readonly<Record<string, boolean>>;
}

export const COMMUNICATION_OFF: CommunicationSettings = { enabled: false, apps: {} };

/** Reads saved settings. Anything that is not exactly what was written — missing, corrupt, wrong types — is OFF. */
export function parseSettings(raw: unknown, knownIds: readonly string[] = COMMUNICATION_APPS.map((a) => a.id)): CommunicationSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return COMMUNICATION_OFF;
  const r = raw as { enabled?: unknown; apps?: unknown };
  // The master switch is ON only if it is exactly `true`. The per-app choices are kept either way, so turning the master
  // switch off and on again never quietly re-allows an app the user had excluded.
  const apps: Record<string, boolean> = {};
  if (typeof r.apps === 'object' && r.apps !== null && !Array.isArray(r.apps)) {
    for (const [id, value] of Object.entries(r.apps as Record<string, unknown>)) {
      if (knownIds.includes(id) && typeof value === 'boolean') apps[id] = value;
    }
  }
  return { enabled: r.enabled === true, apps };
}

/** The friendly name of the built-in chat app a host belongs to, or the host itself if it is not one. */
export function appNameForHost(host: string): string {
  const h = host.toLowerCase();
  const app = COMMUNICATION_APPS.find((a) => a.hosts.some((r) => h === r.host.toLowerCase() || h.endsWith(`.${r.host.toLowerCase()}`)));
  return app?.name ?? host;
}

function hostMatches(hostname: string, pathname: string, rule: HostRule): boolean {
  const h = hostname.toLowerCase();
  const host = rule.host.toLowerCase();
  if (h !== host && !h.endsWith(`.${host}`)) return false;
  return rule.pathPrefix === undefined || pathname.toLowerCase().startsWith(rule.pathPrefix.toLowerCase());
}

/** The rules the browser extension is given for the apps that are NOT allowed. */
export interface BlockRule {
  readonly host: string;
  readonly pathPrefix?: string;
}

/**
 * The live policy: reads the current settings every time it is asked, so switching Communication Access on or off takes
 * effect immediately everywhere. `extraApps` is for tests and local experiments only.
 */
export class CommunicationPolicy {
  constructor(
    private readonly current: () => CommunicationSettings,
    private readonly extraApps: readonly CommunicationApp[] = [],
  ) {}

  settings(): CommunicationSettings {
    return this.current();
  }

  apps(): readonly CommunicationApp[] {
    return [...COMMUNICATION_APPS, ...this.extraApps];
  }

  appForUrl(url: string): CommunicationApp | null {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return this.apps().find((app) => app.hosts.some((rule) => hostMatches(u.hostname, u.pathname, rule))) ?? null;
  }

  appForWindow(w: { readonly process: string; readonly title: string }): CommunicationApp | null {
    const process = w.process.toLowerCase();
    return this.apps().find((app) => app.processes.includes(process) || app.titleHints.some((re) => re.test(w.title))) ?? null;
  }

  allowed(app: CommunicationApp): boolean {
    const s = this.current();
    return s.enabled && s.apps[app.id] !== false;
  }

  /** The communication app this address belongs to, if Eya is NOT allowed to look at it; null if it is fine to. */
  blockedForUrl(url: string | null | undefined): CommunicationApp | null {
    if (url === null || url === undefined || url === '') return null;
    const app = this.appForUrl(url);
    return app !== null && !this.allowed(app) ? app : null;
  }

  blockedForWindow(w: { readonly process: string; readonly title: string }): CommunicationApp | null {
    const app = this.appForWindow(w);
    return app !== null && !this.allowed(app) ? app : null;
  }

  /** What the browser extension must refuse to read or act in: every host of every app that is not allowed. */
  blockRules(): BlockRule[] {
    return this.apps()
      .filter((app) => !this.allowed(app))
      .flatMap((app) => app.hosts.map((h) => ({ host: h.host, ...(h.pathPrefix !== undefined ? { pathPrefix: h.pathPrefix } : {}) })));
  }

  /** One line for the model's context, so it never has to guess whether it may look at a chat. */
  summary(): string {
    const s = this.current();
    if (!s.enabled) {
      return 'Communication Access is OFF: do not look at or use WhatsApp, Telegram, Instagram or any other chat app or site. If asked to, say the user can turn it on with the Chats switch in Eya\'s panel; you cannot turn it on.';
    }
    const off = this.apps().filter((a) => !this.allowed(a) && (a.hosts.length > 0 || a.processes.length > 0));
    const on = this.apps().filter((a) => this.allowed(a));
    return (
      `Communication Access is ON for the chat apps the user allowed (${on.map((a) => a.name).join(', ')}).` +
      (off.length > 0 ? ` Still OFF for: ${off.map((a) => a.name).join(', ')}.` : '') +
      ' Use them only as the user asked, look at as little as the task needs, and never repeat private messages beyond what the user asked for.'
    );
  }
}
