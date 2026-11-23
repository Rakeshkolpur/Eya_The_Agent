import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startDetached } from './processes';
import type { StartResult } from './processes';

const execFileAsync = promisify(execFile);

export interface StartMenuApp {
  readonly name: string;
  readonly appId: string;
}

// Start Menu clutter that should never be offered as "the app": uninstallers
// (a real risk — "open node" should never launch "Uninstall Node.js" just
// because the substring matches), and shortcuts to a website/doc page rather
// than a real application.
const EXCLUDED_NAME_PATTERN = /uninstall|remove|documentation|website|readme|help online|manual|faq|changelog|license/i;

/**
 * Every app Windows' own Start Menu search would show — ordinary Win32
 * programs and UWP/Microsoft Store apps alike, whichever way each happens to
 * be registered. `Get-StartApps` is the same source Start Menu search itself
 * uses, so this is "would the user find it by typing its name", not a guess
 * at install locations.
 */
export async function listStartApps(): Promise<StartMenuApp[]> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-StartApps | ConvertTo-Json -Compress'],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const apps: StartMenuApp[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const name = (row as Record<string, unknown>)['Name'];
    const appId = (row as Record<string, unknown>)['AppID'];
    if (typeof name !== 'string' || typeof appId !== 'string') continue;
    if (EXCLUDED_NAME_PATTERN.test(name) || /^https?:\/\//i.test(appId)) continue;
    apps.push({ name, appId });
  }
  return apps;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A few very common short/alternate names people actually say. */
const NAME_ALIASES: Readonly<Record<string, string>> = {
  vscode: 'visualstudiocode',
  vs: 'visualstudiocode',
  code: 'visualstudiocode',
};

/**
 * Finds the best Start-Menu match for a spoken app name, or null if nothing
 * plausible does. An exact (normalized) name match always wins; otherwise the
 * shortest name containing the query (or vice versa) — picks "WhatsApp" over
 * some unrelated longer name that happens to also contain the letters — and
 * never on fewer than 3 characters, so a one-letter query can't match anything.
 * Re-checks the same uninstaller/documentation exclusion `listStartApps`
 * already applies, so this stays safe even given an unfiltered list directly
 * (a future caller, a test double) rather than relying on the one call site.
 */
export function findStartApp(query: string, apps: readonly StartMenuApp[]): StartMenuApp | null {
  const key = normalize(query);
  if (key.length === 0) return null;
  const aliased = NAME_ALIASES[key] ?? key;
  const candidates = apps.filter((a) => !EXCLUDED_NAME_PATTERN.test(a.name) && !/^https?:\/\//i.test(a.appId));
  const exact = candidates.find((a) => normalize(a.name) === aliased);
  if (exact !== undefined) return exact;
  if (aliased.length < 3) return null;
  let best: StartMenuApp | null = null;
  for (const app of candidates) {
    const name = normalize(app.name);
    if (name.length === 0) continue;
    if (name.includes(aliased) || aliased.includes(name)) {
      if (best === null || name.length < normalize(best.name).length) best = app;
    }
  }
  return best;
}

/**
 * Launches anything `Get-StartApps` knows about, Win32 or UWP alike, by its
 * AppID — `shell:AppsFolder\<AppID>` is the one launch mechanism that works
 * uniformly for both (verified live against both an AppUserModelID-based
 * UWP app and a classic .exe-backed Start Menu entry on this machine).
 */
export function launchStartApp(appId: string): StartResult {
  return startDetached('explorer.exe', [`shell:AppsFolder\\${appId}`]);
}
