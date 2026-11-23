/**
 * Programs that start when the person signs in to Windows, and which of them may be turned off. Pure.
 *
 * Turning one off is what Task Manager's Startup tab does: it writes a small "approved" value next to the entry and leaves the entry itself, so it is undone by turning it back on and nothing
 * is lost. The first byte of that value says which it is: an even number (02, 06) is on, an odd one (03, 07) is off.
 */

export type StartupSource = 'user-registry' | 'machine-registry' | 'machine-registry-32' | 'user-folder' | 'machine-folder';

export interface StartupEntry {
  /** Stable name for it: "source:name". */
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly source: StartupSource;
  readonly enabled: boolean;
}

export type StartupClass = 'keep' | 'safe' | 'optional';

export interface StartupJudgement {
  readonly cls: StartupClass;
  readonly why: string;
}

/** Whether Windows treats an "approved" value as off: the first byte is odd. */
export const approvedIsOff = (firstByte: number): boolean => (firstByte & 1) === 1;

/** The 12 bytes Task Manager writes: 02 (on) or 03 (off), three zero bytes, then (for off) the time as a Windows FILETIME. */
export function approvedBytes(enabled: boolean, nowMs: number): number[] {
  const bytes = [enabled ? 2 : 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  if (!enabled) {
    let ft = BigInt(Math.max(0, Math.floor(nowMs))) * 10_000n + 116_444_736_000_000_000n;
    for (let i = 0; i < 8; i += 1) {
      bytes[4 + i] = Number(ft & 0xffn);
      ft >>= 8n;
    }
  }
  return bytes;
}

const KEEP: ReadonlyArray<readonly [RegExp, string]> = [
  [/(securityhealth|windows ?security|defender|msmpeng)/i, 'Windows security'],
  [/(mcafee|norton|avast|avg\b|kaspersky|bitdefender|quick ?heal|eset|malwarebytes|sophos|trend ?micro|webroot)/i, 'security software'],
  // (whole words only: "ProgramData" is not AMD)
  [/\b(realtek|rtk|igfx|intel|nvidia|nvcontainer|amd|radeon|synaptics|elan|touchpad|hotkey|waves|dolby|nahimic|sonicstudio|audio)/i, 'a helper for your sound, graphics or touchpad'],
  [/(ctfmon|msctf|\bime\b|input ?method)/i, 'the keyboard and input method'],
  [/(^|[^a-z])eya([^a-z]|$)/i, 'Eya'],
];

const SAFE: ReadonlyArray<RegExp> = [
  /onedrive/i, /microsoft\.lists/i, /\bteams\b|msteams|ms-teams/i, /spotify/i, /discord/i, /skype/i, /\bzoom(?![a-z])/i, /\bsteam(?![a-z])|steamwebhelper|steamclient/i, /epic ?games/i, /\badobe|\bccx|acrotray|acrobat ?assist/i, /cortana/i,
  /yourphone|phone ?link|phoneexperience/i, /microsoftedgeautolaunch|msedge.*--no-startup-window/i, /googlechromeautolaunch/i, /\bjava\b|jusched/i, /itunes|applemobile|apple ?push/i, /brother.*(update|notification)/i,
  /update(r)?\b|updater|autoupdate/i, /jiosphere/i, /\bopera(?![a-z])/i, /ccleaner/i, /torrent/i, /webex/i, /\bslack(?![a-z])/i, /whatsapp/i, /telegram/i, /dropbox/i, /googledrive|google ?drive/i, /onenote/i, /\b(msn|bing)\b/i, /grammarly/i,
];

/** Which entries may be turned off without a second thought (`safe`), which are the person's call (`optional`), and which are never touched (`keep`). */
export function classifyStartup(e: Pick<StartupEntry, 'name' | 'command'>): StartupJudgement {
  const text = `${e.name} ${e.command}`;
  for (const [re, why] of KEEP) if (re.test(text)) return { cls: 'keep', why };
  for (const re of SAFE) if (re.test(text)) return { cls: 'safe', why: 'it can start by itself when you open it' };
  if (/ollama/i.test(text)) return { cls: 'optional', why: "Eya's local AI (Ollama): it starts on demand if you turn this off" };
  if (/brother|printer|scan/i.test(text)) return { cls: 'optional', why: 'a printer or scanner helper' };
  return { cls: 'optional', why: 'it is not one of the usual ones, so it is your call' };
}

/** The entries to turn off: only the safe ones that are on (mode "safe"), or everything that is on except what is kept (mode "all"). */
export const startupToTurnOff = (entries: readonly StartupEntry[], mode: 'safe' | 'all'): StartupEntry[] =>
  entries.filter((e) => e.enabled && (mode === 'all' ? classifyStartup(e).cls !== 'keep' : classifyStartup(e).cls === 'safe'));

export interface StartupMatch {
  readonly matched: StartupEntry[];
  readonly refused: Array<{ name: string; why: string }>;
  readonly unknown: string[];
}

const norm = (s: string): string => s.toLowerCase().replace(/\.(exe|lnk)$/, '').replace(/[^a-z0-9]+/g, '');

/** Entries asked for by name ("onedrive", "spotify"); the ones that are kept are refused with the reason. */
export function matchStartup(entries: readonly StartupEntry[], queries: readonly string[]): StartupMatch {
  const matched: StartupEntry[] = [];
  const refused: Array<{ name: string; why: string }> = [];
  const unknown: string[] = [];
  for (const raw of queries) {
    const q = norm(raw);
    if (q.length < 2) continue;
    const hits = entries.filter((e) => norm(e.name).includes(q) || norm(e.command).includes(q));
    if (hits.length === 0) {
      unknown.push(raw.trim());
      continue;
    }
    for (const e of hits) {
      const j = classifyStartup(e);
      if (j.cls === 'keep') refused.push({ name: e.name, why: j.why });
      else if (!matched.includes(e)) matched.push(e);
    }
  }
  return { matched, refused, unknown };
}

/** A short readable name for an entry: the Run value's name, without the long random tail Edge and Chrome add. */
export function shownStartupName(e: Pick<StartupEntry, 'name'>): string {
  const n = e.name.replace(/\.lnk$/i, '').replace(/_?[A-F0-9]{16,}$/i, '').replace(/(\d+\.){2,}\d+$/, '');
  return n === '' ? e.name : n;
}
