import type { WindowInfo } from './windowControl';

/**
 * Which open window does the user mean by "Chrome", "Word", "the calculator", "WhatsApp"? Pure and testable: it only
 * looks at the list of windows Windows reports (process name and title), never guesses at one that is not there.
 */

// Words people say, mapped to the process names Windows reports (lower-case, without .exe).
const PROCESS_ALIASES: Readonly<Record<string, readonly string[]>> = {
  word: ['winword'],
  'microsoft word': ['winword'],
  excel: ['excel'],
  'microsoft excel': ['excel'],
  powerpoint: ['powerpnt'],
  'power point': ['powerpnt'],
  outlook: ['outlook', 'olk'],
  onenote: ['onenote', 'onenotem'],
  chrome: ['chrome'],
  'google chrome': ['chrome'],
  edge: ['msedge'],
  'microsoft edge': ['msedge'],
  firefox: ['firefox'],
  explorer: ['explorer'],
  'file explorer': ['explorer'],
  'windows explorer': ['explorer'],
  files: ['explorer'],
  notepad: ['notepad'],
  paint: ['mspaint'],
  'task manager': ['taskmgr'],
  'vs code': ['code'],
  vscode: ['code'],
  'visual studio code': ['code'],
  code: ['code'],
  terminal: ['windowsterminal'],
  'windows terminal': ['windowsterminal'],
  'command prompt': ['cmd', 'windowsterminal'],
  cmd: ['cmd', 'windowsterminal'],
  powershell: ['powershell', 'pwsh', 'windowsterminal'],
  teams: ['ms-teams', 'teams'],
  'microsoft teams': ['ms-teams', 'teams'],
  whatsapp: ['whatsapp', 'whatsapp.root'],
  telegram: ['telegram'],
  spotify: ['spotify'],
  vlc: ['vlc'],
  discord: ['discord'],
  slack: ['slack'],
  zoom: ['zoom'],
  photoshop: ['photoshop'],
};

function normalize(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/^(the|my|that|this)\s+/, '')
    .replace(/\s+(app|application|window|program)$/, '')
    .trim();
}

export interface WindowMatch {
  /** The windows that match, frontmost first. */
  readonly matches: readonly WindowInfo[];
  /** Whether they matched by their program's name or only by what their title says. */
  readonly by: 'process' | 'title' | null;
  /** The one to act on: the one in front if it is among them, otherwise the frontmost. */
  readonly best: WindowInfo | null;
}

/** Windows that are Eya's own, or the desktop shell: never offered, never acted on. */
export function isActable(w: WindowInfo, ownPids: ReadonlySet<number>): boolean {
  if (ownPids.has(w.pid)) return false;
  if (w.process.toLowerCase() === 'explorer' && w.title === 'Program Manager') return false; // the desktop itself
  return true;
}

export function matchWindows(windows: readonly WindowInfo[], query: string, options: { exact?: boolean } = {}): WindowMatch {
  const q = normalize(query);
  if (q === '') return { matches: [], by: null, best: null };

  if (options.exact === true) {
    const matches = windows.filter((w) => w.title.trim().toLowerCase() === q);
    return { matches, by: matches.length > 0 ? 'title' : null, best: pickBest(matches) };
  }

  const names = new Set<string>([...(PROCESS_ALIASES[q] ?? []), q.replace(/\s+/g, '')]);
  const byProcess = windows.filter((w) => names.has(w.process.toLowerCase()));
  if (byProcess.length > 0) return { matches: byProcess, by: 'process', best: pickBest(byProcess) };

  const byTitle = windows.filter((w) => w.title.toLowerCase().includes(q));
  if (byTitle.length > 0) return { matches: byTitle, by: 'title', best: pickBest(byTitle) };

  // Last resort: the process name merely contains what was said ("notepad" for "notepad++", "chrom" for "chrome").
  const loose = q.length >= 4 ? windows.filter((w) => w.process.toLowerCase().includes(q.replace(/\s+/g, ''))) : [];
  return { matches: loose, by: loose.length > 0 ? 'process' : null, best: pickBest(loose) };
}

function pickBest(list: readonly WindowInfo[]): WindowInfo | null {
  return list.find((w) => w.foreground) ?? list[0] ?? null;
}

const FRIENDLY: Readonly<Record<string, string>> = {
  winword: 'Word',
  excel: 'Excel',
  powerpnt: 'PowerPoint',
  outlook: 'Outlook',
  msedge: 'Edge',
  chrome: 'Chrome',
  firefox: 'Firefox',
  explorer: 'File Explorer',
  notepad: 'Notepad',
  mspaint: 'Paint',
  taskmgr: 'Task Manager',
  code: 'Visual Studio Code',
  windowsterminal: 'Windows Terminal',
  'ms-teams': 'Teams',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  spotify: 'Spotify',
};

/** A short, speakable name for a window's application. Store apps all run inside "ApplicationFrameHost", so their title says more. */
export function appLabel(w: WindowInfo): string {
  const p = w.process.toLowerCase();
  if (p === 'applicationframehost' || p === 'textinputhost') return w.title || 'a Windows app';
  return FRIENDLY[p] ?? (w.process === '' ? 'an application' : w.process);
}
