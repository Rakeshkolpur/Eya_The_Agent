import { rootLogger } from '@main/logging/logger';
import type { StartMenuApp } from '@main/windowsApi/appDiscovery';

const log = rootLogger.child('appcatalog');

/**
 * The apps in the Start Menu, remembered.
 *
 * Asking Windows for them (`Get-StartApps`) starts a PowerShell and takes about a second on a small laptop, and "open Spotify"
 * did that every single time. The list changes rarely, so it is read once in the background, kept for a few minutes, and
 * refreshed behind the scenes. Opening an app that was installed a moment ago still works: the caller can ask for a fresh read
 * when the remembered list has no match.
 */

export interface AppCatalogOptions {
  readonly list: () => Promise<StartMenuApp[]>;
  readonly now?: () => number;
  /** How long a read stays good before it is refreshed in the background. */
  readonly maxAgeMs?: number;
}

const DEFAULT_MAX_AGE_MS = 10 * 60_000;

// "Microsoft Word" is "word" to someone speaking.
const VENDOR_PREFIX = /^(?:microsoft|windows|google|adobe)\s+/i;

export function normalizeAppName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export class AppCatalog {
  private apps: readonly StartMenuApp[] | null = null;
  private byKey = new Map<string, StartMenuApp>();
  private loadedAt = 0;
  private loading: Promise<readonly StartMenuApp[]> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly maxAgeMs: number;

  constructor(private readonly options: AppCatalogOptions) {
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  /** Reads the list in the background, after `delayMs` so it does not compete with the app starting up. */
  start(delayMs = 0): void {
    if (this.timer !== null || this.apps !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().catch(() => undefined);
    }, delayMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  get loaded(): boolean {
    return this.apps !== null;
  }

  /** The remembered list; reads it first if it never has been. An old list is returned at once and refreshed behind the scenes. */
  async get(): Promise<readonly StartMenuApp[]> {
    if (this.apps === null) return this.refresh();
    if (this.now() - this.loadedAt > this.maxAgeMs) void this.refresh().catch(() => undefined);
    return this.apps;
  }

  /** Reads the list from Windows now. Several callers at once share one read. */
  refresh(): Promise<readonly StartMenuApp[]> {
    if (this.loading !== null) return this.loading;
    const started = this.now();
    this.loading = this.options
      .list()
      .then((apps) => {
        this.apps = apps;
        this.loadedAt = this.now();
        this.byKey = indexByKey(apps);
        log.info('start menu apps read', { apps: apps.length, ms: this.now() - started });
        return apps;
      })
      .catch((err) => {
        log.warn('could not read the start menu apps', { err: String(err) });
        // Keep what we had; with nothing, an empty list means "not known" and the slow path still gets its turn.
        if (this.apps === null) return [] as readonly StartMenuApp[];
        return this.apps;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /**
   * The real name of the installed app that was asked for, if it is certain; null otherwise (or if the list is not read yet).
   * Only an exact match counts (ignoring spaces, case, punctuation and a leading "Microsoft"/"Google"...): this is what lets
   * "open Spotify" skip the model, so it must never guess that "open the door" means some app with "door" in its name.
   */
  lookup(spoken: string): string | null {
    const key = normalizeAppName(spoken);
    if (key.length < 2) return null;
    return this.byKey.get(key)?.name ?? null;
  }
}

function indexByKey(apps: readonly StartMenuApp[]): Map<string, StartMenuApp> {
  const exact = new Map<string, StartMenuApp>();
  const shortened = new Map<string, StartMenuApp>();
  const ambiguous = new Set<string>();
  for (const app of apps) {
    const key = normalizeAppName(app.name);
    if (key.length > 0 && !exact.has(key)) exact.set(key, app);
    const bare = normalizeAppName(app.name.replace(VENDOR_PREFIX, ''));
    if (bare.length === 0 || bare === key) continue;
    // Two different apps that shorten to the same word ("Microsoft Edge" / "Windows Edge") mean neither: leave it to the model.
    if (shortened.has(bare) && shortened.get(bare)?.appId !== app.appId) ambiguous.add(bare);
    else shortened.set(bare, app);
  }
  // A full name always beats a shortened one ("Word" the app, not "Microsoft Word" the shortening of something else).
  for (const [key, app] of shortened) if (!exact.has(key) && !ambiguous.has(key)) exact.set(key, app);
  return exact;
}
