/**
 * Which running programs may be stopped, and which never. Pure.
 *
 * A program is judged as a WHOLE (all its processes together, by the program's name), never process by process: Edge keeps most of its processes without a window of their own (each tab is one),
 * so judging them one by one would close the person's tabs. A program with a window anywhere is in use and is left alone by "stop the background apps". Windows itself, security software,
 * the program Eya runs in, and the tools the person works in are never swept. Asked for by name, nearly everything may be stopped, except Windows itself, Eya and security software.
 */

export interface ProcInfo {
  readonly pid: number;
  readonly parent: number;
  readonly name: string;
  readonly mb: number;
  readonly hasWindow: boolean;
  readonly path: string;
  readonly session: number;
}

export interface AppGroup {
  /** The program's process name in lower case (msedge, spotify). */
  readonly key: string;
  /** What to call it aloud (Spotify, msedge). */
  readonly name: string;
  readonly pids: readonly number[];
  readonly mb: number;
  readonly hasWindow: boolean;
  readonly path: string;
  /** Why "stop the background apps" leaves it alone; null when it may be stopped. (An app with a window is left alone too, see `backgroundTargets`.) */
  readonly keepBecause: string | null;
  /** Why it is not stopped even when asked for by name; null when it may be. */
  readonly neverBecause: string | null;
}

export interface RuleContext {
  /** Eya's own process and everything above and below it. */
  readonly selfPids: ReadonlySet<number>;
  /** C:\Windows. */
  readonly windir: string;
  /** The Windows session the person is signed in to (programs of other sessions are not theirs). */
  readonly session: number;
}

const WINDOWS_PARTS = new Set([
  'system', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso', 'svchost', 'dwm', 'explorer', 'sihost', 'taskhostw', 'ctfmon', 'fontdrvhost',
  'runtimebroker', 'searchhost', 'searchapp', 'searchindexer', 'searchprotocolhost', 'searchfilterhost', 'startmenuexperiencehost', 'shellexperiencehost', 'textinputhost',
  'applicationframehost', 'systemsettings', 'lockapp', 'logonui', 'userinit', 'dllhost', 'conhost', 'backgroundtaskhost', 'smartscreen', 'spoolsv', 'wmiprvse', 'wudfhost', 'audiodg',
  'memory compression', 'idle', 'sgrmbroker', 'wlanext', 'dashost', 'unsecapp', 'consent', 'msiexec', 'trustedinstaller', 'tiworker', 'wuauclt', 'wusa',
]);

/** Security software: stopping it is a change to the PC's protection, which is the person's to make, so it is never done, even by name. */
const SECURITY = /(defender|windows ?security|securityhealth|msmpeng|mcafee|norton|avast|avg|kaspersky|bitdefender|quick ?heal|eset|malwarebytes|sophos|trend ?micro|webroot|crowdstrike|sentinel)/i;

/** The tools a person works in, the shells, and Eya's own helpers: they are not swept (stopped by name, with the person's word, they may be). */
const WORK_TOOLS = new Set([
  'electron', 'eya', 'node', 'npm', 'npx', 'claude', 'claude-code', 'code', 'cursor', 'windsurf', 'devenv', 'idea64', 'pycharm64', 'studio64', 'powershell', 'pwsh', 'cmd', 'windowsterminal', 'wt',
  'bash', 'git', 'mintty', 'python', 'pythonw', 'py', 'java', 'javaw', 'docker', 'dockerd', 'com.docker.backend', 'wsl', 'wslhost', 'wslservice', 'vmmem', 'ollama', 'ollama app', 'winword', 'excel',
  'powerpnt', 'outlook', 'onenote', 'msaccess', 'acrord32', 'acrobat', 'notepad', 'notepad++', 'sublime_text', 'esbuild', 'vite', 'tsx', 'ts-node', 'deno', 'bun', 'yarn', 'pnpm', 'php', 'ruby', 'go',
  'cargo', 'rustc', 'dotnet', 'mongod', 'mysqld', 'postgres', 'redis-server', 'sqlservr',
]);

/** Remote-access programs: stopping one can cut off the person who is using the PC from far away. Not swept; they may be stopped when named. */
const REMOTE = /(anydesk|teamviewer|rustdesk|parsec|ultraviewer|splashtop|remoting_host|chromeremotedesktop|^vnc|tightvnc|realvnc|ammyy|supremo)/i;

/** The programs that sit inside another program (its web view, its browser link, its crash reporter): stopping one breaks the program that is open. */
const HELPER = /(native-?host|webview|crashpad|^cef|helper$|^winpty)/i;

/** Hardware helpers (sound, graphics, touchpad, hotkeys, printers' monitors): not swept, because switching them off breaks something that works. Whole words only ("ProgramData" is not AMD). */
const HARDWARE = /(\b(realtek|rtk|igfx|intel|nvidia|nvcontainer|nvdisplay|amd|radeon|synaptics|elan|touchpad|hotkey|bluetooth|ibtsiva|hpsystem|hpsupport|lenovo|dell|asus|acer|waves|dolby|nahimic|sonicstudio)|^bt)/i;

const ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(microsoft ?)?edge$/, 'msedge'],
  [/^(google ?)?chrome$/, 'chrome'],
  [/^(microsoft ?)?teams$/, 'teams|ms-teams|msteams'],
  [/^one ?drive$/, 'onedrive'],
  [/^(vs ?code|visual ?studio ?code)$/, 'code'],
  [/^(ms ?)?word$/, 'winword'],
  [/^(ms ?)?excel$/, 'excel'],
  [/^(ms ?)?power ?point$/, 'powerpnt'],
  [/^whats ?app$/, 'whatsapp'],
  [/^task ?manager$/, 'taskmgr'],
  [/^file ?explorer$/, 'explorer'],
  [/^(any ?desk)$/, 'anydesk'],
  [/^(team ?viewer)$/, 'teamviewer'],
];

const norm = (s: string): string => s.toLowerCase().replace(/\.exe$/, '').replace(/[\s_-]+/g, '');

const baseName = (path: string): string => (path.split('\\').pop() ?? '').replace(/\.exe$/i, '');

function judge(key: string, path: string, group: { selfHit: boolean }, ctx: RuleContext): { keep: string | null; never: string | null } {
  const lowerPath = path.toLowerCase();
  const win = ctx.windir.toLowerCase().replace(/\\+$/, '');
  if (group.selfHit) return { keep: 'Eya itself', never: 'Eya itself' };
  // (the core of Windows, and the security software: never, not even when the person names them)
  if (WINDOWS_PARTS.has(key)) return { keep: 'part of Windows', never: 'part of Windows' };
  if (SECURITY.test(key) || SECURITY.test(lowerPath.split('\\').slice(-2).join('\\'))) return { keep: 'security software', never: 'security software (changing protection is yours to do)' };
  if (WORK_TOOLS.has(key) || /^claude|anthropic/.test(key)) return { keep: 'a tool you work in', never: null };
  // (a program Windows ships, such as Notepad: left out of a sweep, but the person may name it)
  if (win !== '' && lowerPath.startsWith(`${win}\\`)) return { keep: 'part of Windows', never: null };
  if (REMOTE.test(key)) return { keep: 'remote access (stopping it could cut you off)', never: null };
  if (HELPER.test(key)) return { keep: 'a helper inside another program', never: null };
  if (HARDWARE.test(key) || HARDWARE.test(baseName(path))) return { keep: 'a helper for your hardware (sound, graphics, touchpad)', never: null };
  return { keep: null, never: null };
}

/** The running programs of the person's session, grouped by program, each with whether it may be stopped. */
export function groupApps(procs: readonly ProcInfo[], ctx: RuleContext): AppGroup[] {
  const byKey = new Map<string, ProcInfo[]>();
  for (const p of procs) {
    if (p.session !== ctx.session || p.pid <= 4) continue;
    const key = p.name.toLowerCase();
    byKey.set(key, [...(byKey.get(key) ?? []), p]);
  }
  const first: AppGroup[] = [];
  for (const [key, list] of byKey) {
    const path = list.find((p) => p.path !== '')?.path ?? '';
    const selfHit = list.some((p) => ctx.selfPids.has(p.pid));
    const verdict = judge(key, path, { selfHit }, ctx);
    first.push({
      key,
      name: baseName(path) !== '' ? baseName(path) : key,
      pids: list.map((p) => p.pid),
      mb: list.reduce((sum, p) => sum + p.mb, 0),
      hasWindow: list.some((p) => p.hasWindow),
      path,
      keepBecause: verdict.keep,
      neverBecause: verdict.never,
    });
  }
  // A program with no window that was started by a program that is open (or by a work tool) is that program's helper: its web view, its native link, a server a developer started. It is left alone.
  // (Not when the parent is Windows itself, which starts every program the person opens from the Start menu, nor Eya, which starts the programs she opens for the person.)
  const groupOfPid = new Map<number, AppGroup>();
  for (const g of first) for (const pid of g.pids) groupOfPid.set(pid, g);
  const groups = first.map((g): AppGroup => {
    if (g.keepBecause !== null || g.hasWindow) return g;
    for (const proc of byKey.get(g.key) ?? []) {
      const parent = groupOfPid.get(proc.parent);
      if (parent === undefined || parent.key === g.key) continue;
      if (parent.keepBecause === 'part of Windows' || parent.keepBecause === 'Eya itself') continue;
      if (parent.hasWindow || parent.keepBecause !== null) return { ...g, keepBecause: `a helper of ${parent.name}` };
    }
    return g;
  });
  return groups.sort((a, b) => b.mb - a.mb);
}

/** What "stop the background apps" stops: programs with no window anywhere that are not Windows, security, a work tool or a hardware helper. */
export const backgroundTargets = (groups: readonly AppGroup[]): AppGroup[] => groups.filter((g) => g.keepBecause === null && !g.hasWindow);

/** What a sweep leaves alone and why (for saying it), biggest first. */
export function leftAlone(groups: readonly AppGroup[]): Array<{ name: string; mb: number; why: string }> {
  return groups
    .filter((g) => g.keepBecause !== null || g.hasWindow)
    .map((g) => ({ name: g.name, mb: g.mb, why: g.keepBecause ?? 'you have it open' }));
}

export interface NamedResult {
  readonly matched: AppGroup[];
  readonly refused: Array<{ name: string; why: string }>;
  readonly notRunning: string[];
}

/** Programs asked for by name ("spotify", "microsoft edge", "onedrive"): everything that matches, except what may never be stopped. */
export function targetsByName(groups: readonly AppGroup[], queries: readonly string[]): NamedResult {
  const matched: AppGroup[] = [];
  const refused: Array<{ name: string; why: string }> = [];
  const notRunning: string[] = [];
  for (const raw of queries) {
    const q = norm(raw);
    if (q.length < 2) continue;
    const aliasHit = ALIASES.find(([re]) => re.test(raw.trim().toLowerCase().replace(/\.exe$/, '')));
    const wanted = aliasHit !== undefined ? aliasHit[1].split('|') : [q];
    const hits = groups.filter((g) => wanted.some((w) => norm(g.key) === norm(w) || (q.length >= 3 && (norm(g.key).includes(norm(w)) || norm(g.name).includes(norm(w))))));
    if (hits.length === 0) {
      notRunning.push(raw.trim());
      continue;
    }
    for (const g of hits) {
      if (g.neverBecause !== null) refused.push({ name: g.name, why: g.neverBecause });
      else if (!matched.includes(g)) matched.push(g);
    }
  }
  return { matched, refused, notRunning };
}

/**
 * Eya's own processes: hers, and what she started that is the same program file (Electron's renderer and helper processes). Never the programs she started for the person (Spotify, Notepad):
 * those are the person's, and may be stopped. And never the programs that started HER (Explorer, a terminal): they are judged by their own rules, so that Explorer is "part of Windows" and not
 * "Eya itself". None of it is ever stopped.
 */
export function treeAround(procs: readonly ProcInfo[], pid: number): Set<number> {
  const out = new Set<number>([pid]);
  const selfPath = (procs.find((p) => p.pid === pid)?.path ?? '').toLowerCase();
  const below = new Set<number>([pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs) {
      if (!below.has(p.pid) && below.has(p.parent) && p.parent > 4 && selfPath !== '' && p.path.toLowerCase() === selfPath) {
        below.add(p.pid);
        out.add(p.pid);
        grew = true;
      }
    }
  }
  return out;
}
