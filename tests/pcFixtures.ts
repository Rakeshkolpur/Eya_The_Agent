import type { ComputerNames, DiskInfo, ElevatedOutcome, ElevatedResult, EnvEntry, NetworkInfo, OsInfo, PcSystem, RunResult, TempScan } from '../src/main/pc/pcSystem';
import { PcJournal } from '../src/main/pc/PcJournal';
import type { MicFacts } from '../src/main/pc/micRules';
import type { ProcInfo } from '../src/main/pc/processRules';
import type { StartupEntry } from '../src/main/pc/startupRules';
import { SERVICES } from '../src/main/pc/winSystem';
import type { CommandResult, ServiceKey, WinSystem } from '../src/main/pc/winSystem';
import { createPcTools } from '../src/main/tools/impl/pcTools';
import { createWinTools } from '../src/main/tools/impl/winTools';
import type { StoreIo } from '../src/main/privacy/communicationAccessStore';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';

/** A pretend Windows for the PC tools' tests: an environment, some folders and files, programs that answer, and a record of everything that was written. */
const lc = (s: string): string => s.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');

export class FakePc implements PcSystem {
  user: Record<string, EnvEntry> = {};
  machine: Record<string, EnvEntry> = {};
  folders = new Set<string>();
  files = new Set<string>();
  dirs: Record<string, string[]> = {};
  vars: Record<string, string> = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\Rakesh\\AppData\\Local', USERPROFILE: 'C:\\Users\\Rakesh', windir: 'C:\\Windows', APPDATA: 'C:\\Users\\Rakesh\\AppData\\Roaming' };
  writes: Array<{ name: string; value: string; kind: EnvEntry['kind'] }> = [];
  deletes: string[] = [];
  /** writeEnv returns but nothing changes (Windows refused quietly): the read-back must notice. */
  writeIgnored = false;
  runs: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];
  runner: (file: string, args: readonly string[]) => RunResult = () => ({ code: 0, stdout: '', stderr: '', timedOut: false });
  started: string[] = [];
  onPath: Record<string, string[]> = {};
  os: OsInfo = { windows: 'Windows 11 Home 23H2', build: '22631.4602', user: 'Rakesh', isAdmin: false, uptimeHours: 5, ramGb: 16, freeRamGb: 8, pendingReboot: false };
  diskList: DiskInfo[] = [{ drive: 'C:', freeGb: 80, totalGb: 475 }];
  net: NetworkInfo = { dns: true, internet: true, proxy: null, adapters: 1 };
  temp: TempScan = { dir: 'C:\\Users\\Rakesh\\AppData\\Local\\Temp', files: 100, bytes: 900 * 1024 * 1024, oldFiles: 60, oldBytes: 800 * 1024 * 1024 };
  tempCleared = 0;
  running = new Set<string>(['explorer.exe']);
  names: ComputerNames = { active: 'DESKTOP-OLD1', pending: 'DESKTOP-OLD1' };
  /** What successive looks for Windows' permission box see (true = it is on the screen); after the list, it is not. */
  boxScript: boolean[] = [];
  boxLooks = 0;
  /** An administrator's account (the box is Yes / No) or a standard user's (it asks for a password). */
  adminAccountValue = true;
  /** What the person does at the box when a rename asks for it. */
  renameOutcome: ElevatedOutcome = 'done';
  /** When set, a rename (and an install or uninstall) waits for it: the time during which the permission box is "on the screen". */
  gate: Promise<void> | null = null;
  renames: string[] = [];

  folder(...p: string[]): this {
    for (const f of p) this.folders.add(lc(f));
    return this;
  }
  file(...p: string[]): this {
    for (const f of p) {
      this.files.add(lc(f));
      // (every folder above it exists too)
      let dir = f;
      while (/\\[^\\]+$/.test(dir)) {
        dir = dir.replace(/\\[^\\]+$/, '');
        if (dir.length > 2) this.folders.add(lc(dir));
      }
    }
    return this;
  }

  async readEnv(scope: 'user' | 'machine'): Promise<Record<string, EnvEntry>> {
    return { ...(scope === 'user' ? this.user : this.machine) };
  }
  async writeEnv(name: string, value: string, kind: EnvEntry['kind']): Promise<void> {
    this.writes.push({ name, value, kind });
    if (this.writeIgnored) return;
    for (const n of Object.keys(this.user)) if (n.toUpperCase() === name.toUpperCase()) delete this.user[n];
    this.user[name] = { value, kind };
  }
  async deleteEnv(name: string): Promise<void> {
    this.deletes.push(name);
    for (const n of Object.keys(this.user)) if (n.toUpperCase() === name.toUpperCase()) delete this.user[n];
  }
  expand(text: string): string {
    return text.replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (whole, name: string) => this.vars[name] ?? whole);
  }
  folderExists(path: string): boolean {
    return this.folders.has(lc(this.expand(path)));
  }
  fileExists(path: string): boolean {
    return this.files.has(lc(this.expand(path)));
  }
  listDirs(parent: string): string[] {
    return this.dirs[lc(this.expand(parent))] ?? [];
  }
  async run(file: string, args: readonly string[], timeoutMs: number): Promise<RunResult> {
    this.runs.push({ file, args, timeoutMs });
    if (this.gate !== null && (args[0] === 'install' || args[0] === 'uninstall')) await this.gate;
    return this.runner(file, args);
  }
  start(file: string): void {
    this.started.push(file);
    if (/explorer/i.test(file)) this.running.add('explorer.exe');
  }
  async where(name: string): Promise<string[]> {
    return this.onPath[name] ?? [];
  }
  async osInfo(): Promise<OsInfo> {
    return this.os;
  }
  async disks(): Promise<DiskInfo[]> {
    return this.diskList;
  }
  async network(): Promise<NetworkInfo> {
    return this.net;
  }
  scanTemp(): TempScan {
    return this.temp;
  }
  clearTemp(): { removed: number; bytes: number; skipped: number } {
    this.tempCleared += 1;
    return { removed: this.temp.oldFiles - 2, bytes: this.temp.oldBytes, skipped: 2 };
  }
  async isProcessRunning(name: string): Promise<boolean> {
    return this.running.has(name.toLowerCase());
  }
  async computerNames(): Promise<ComputerNames> {
    return { ...this.names };
  }
  async permissionBoxOpen(): Promise<boolean> {
    const seen = this.boxScript[this.boxLooks] ?? false;
    this.boxLooks += 1;
    return seen;
  }
  async adminAccount(): Promise<boolean> {
    return this.adminAccountValue;
  }
  async renameComputer(name: string): Promise<ElevatedResult> {
    this.renames.push(name);
    if (this.gate !== null) await this.gate;
    if (this.renameOutcome === 'done') this.names = { ...this.names, pending: name };
    return { outcome: this.renameOutcome, code: this.renameOutcome === 'done' ? 0 : this.renameOutcome === 'declined' ? 1223 : this.renameOutcome === 'failed' ? 3 : null };
  }
}

export const healthyMic: MicFacts = {
  accessUser: 'Allow',
  accessMachine: 'Allow',
  accessDesktopApps: 'Allow',
  policyBlocks: false,
  usedNow: [],
  blockedApps: [],
  devices: [
    { name: 'Microphone Array', state: 1 },
    { name: 'Headset Microphone', state: 8 },
  ],
  defaultDevice: { name: 'Microphone Array', muted: false, volume: 80 },
  audioService: 'Running',
  endpointBuilder: 'Running',
};

/** A pretend Windows for the tools of the Windows side: running programs, start-up entries, a microphone, services and commands, and a record of everything that was done to them. */
export class FakeWin implements WinSystem {
  procs: ProcInfo[] = [];
  startup: StartupEntry[] = [];
  startupWrites: Array<{ name: string; source: string; enabled: boolean }> = [];
  /** A write returns but nothing changes (Windows refused quietly): the read-back must notice. */
  startupIgnored = false;
  stops: Array<{ pids: number[]; how: 'close' | 'kill' }> = [];
  /** A program that does not go when asked to close (it is asking the person to save). */
  closeRefused = new Set<number>();
  started: string[] = [];
  mic: MicFacts = healthyMic;
  micWrites: string[] = [];
  micWriteIgnored = false;
  services: Record<string, string> = { Audiosrv: 'Running', AudioEndpointBuilder: 'Running', Spooler: 'Running', bthserv: 'Running', WSearch: 'Running' };
  restartOutcome: ElevatedOutcome = 'done';
  restarts: ServiceKey[] = [];
  /** While set, a restart or an administrator command waits for it: the time the permission box is "on the screen". */
  gate: Promise<void> | null = null;
  commands: Array<{ script: string; admin: boolean; timeoutMs: number }> = [];
  commandResult: CommandResult = { outcome: 'done', code: 0, output: '' };
  mem = { freeMb: 900, totalMb: 7900 };
  listFails = false;

  async listProcesses(): Promise<ProcInfo[]> {
    if (this.listFails) throw new Error('could not list the programs');
    return this.procs.map((p) => ({ ...p }));
  }
  async stopProcesses(pids: readonly number[], how: 'close' | 'kill'): Promise<void> {
    this.stops.push({ pids: [...pids], how });
    for (const pid of pids) {
      const p = this.procs.find((x) => x.pid === pid);
      if (p === undefined) continue;
      if (how === 'close' && p.hasWindow && this.closeRefused.has(pid)) continue;
      this.procs = this.procs.filter((x) => x.pid !== pid);
      this.mem = { ...this.mem, freeMb: this.mem.freeMb + p.mb };
    }
  }
  startProgram(path: string): void {
    this.started.push(path);
  }
  async startupEntries(): Promise<StartupEntry[]> {
    return this.startup.map((e) => ({ ...e }));
  }
  async setStartupEnabled(entry: Pick<StartupEntry, 'name' | 'source'>, enabled: boolean): Promise<void> {
    this.startupWrites.push({ name: entry.name, source: entry.source, enabled });
    if (this.startupIgnored) return;
    this.startup = this.startup.map((e) => (e.name === entry.name && e.source === entry.source ? { ...e, enabled } : e));
  }
  async micFacts(): Promise<MicFacts> {
    return JSON.parse(JSON.stringify(this.mic)) as MicFacts;
  }
  async setMicMuted(muted: boolean): Promise<void> {
    this.micWrites.push(`mute:${muted}`);
    if (this.micWriteIgnored || this.mic.defaultDevice === null) return;
    this.mic = { ...this.mic, defaultDevice: { ...this.mic.defaultDevice, muted } };
  }
  async setMicVolume(percent: number): Promise<void> {
    this.micWrites.push(`volume:${percent}`);
    if (this.micWriteIgnored || this.mic.defaultDevice === null) return;
    this.mic = { ...this.mic, defaultDevice: { ...this.mic.defaultDevice, volume: percent } };
  }
  async allowMicAccess(): Promise<void> {
    this.micWrites.push('allow');
    if (this.micWriteIgnored) return;
    this.mic = { ...this.mic, accessUser: 'Allow', accessMachine: 'Allow', accessDesktopApps: 'Allow' };
  }
  async serviceStatus(names: readonly string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const n of names) out[n] = this.services[n] ?? 'Missing';
    return out;
  }
  async restartService(key: ServiceKey): Promise<ElevatedResult> {
    this.restarts.push(key);
    if (this.gate !== null) await this.gate;
    if (this.restartOutcome === 'done') {
      for (const n of SERVICES[key].watch) this.services[n] = 'Running';
      if (key === 'audio') this.mic = { ...this.mic, audioService: 'Running', endpointBuilder: 'Running' };
    }
    return { outcome: this.restartOutcome, code: this.restartOutcome === 'done' ? 0 : this.restartOutcome === 'declined' ? 1223 : this.restartOutcome === 'failed' ? 3 : null };
  }
  async runCommand(script: string, o: { readonly admin: boolean; readonly timeoutMs: number }): Promise<CommandResult> {
    this.commands.push({ script, admin: o.admin, timeoutMs: o.timeoutMs });
    if (o.admin && this.gate !== null) await this.gate;
    return this.commandResult;
  }
  memory(): { freeMb: number; totalMb: number } {
    return { ...this.mem };
  }
  now(): number {
    return 1_800_000_000_000;
  }
}

/** A busy PC like the real one: Edge open (most of its processes have no window of their own), Spotify and OneDrive in the background, Windows, a work tool, and Eya herself. */
export function busyWorld(): ProcInfo[] {
  const user = (name: string, pid: number, mb: number, o: Partial<ProcInfo> = {}): ProcInfo => ({ pid, parent: 100, name, mb, hasWindow: false, path: `C:\\Users\\Rakesh\\AppData\\Local\\${name}\\${name}.exe`, session: 1, ...o });
  return [
    user('explorer', 100, 90, { parent: 4, hasWindow: true, path: 'C:\\Windows\\Explorer.EXE' }),
    user('msedge', 200, 520, { hasWindow: false, path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' }),
    user('msedge', 201, 200, { hasWindow: true, path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' }),
    user('msedge', 202, 170, { hasWindow: false, path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' }),
    user('Spotify', 300, 310),
    user('Spotify', 301, 90, { parent: 300 }),
    user('OneDrive', 310, 120),
    user('powershell', 400, 86, { path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }),
    user('eya', 900, 120, { hasWindow: true, path: 'C:\\Eya\\eya.exe' }),
    user('eya', 901, 60, { parent: 900, path: 'C:\\Eya\\eya.exe' }),
  ];
}

export const startupWorld = (): StartupEntry[] => [
  { id: 'user-registry:OneDrive', name: 'OneDrive', command: 'C:\\OneDrive\\OneDrive.exe /background', source: 'user-registry', enabled: true },
  { id: 'user-registry:Spotify', name: 'Spotify', command: 'C:\\Spotify\\Spotify.exe', source: 'user-registry', enabled: true },
  { id: 'user-registry:MicrosoftEdgeAutoLaunch_A54DD1FBCA0F857FE848E5EEA070E463', name: 'MicrosoftEdgeAutoLaunch_A54DD1FBCA0F857FE848E5EEA070E463', command: 'msedge.exe --no-startup-window', source: 'user-registry', enabled: false },
  { id: 'machine-registry:SecurityHealth', name: 'SecurityHealth', command: 'C:\\Windows\\system32\\SecurityHealthSystray.exe', source: 'machine-registry', enabled: true },
  { id: 'machine-registry:RtkAudUService', name: 'RtkAudUService', command: 'C:\\Windows\\System32\\DriverStore\\RtkAudUService64.exe', source: 'machine-registry', enabled: true },
  { id: 'user-folder:Ollama.lnk', name: 'Ollama.lnk', command: 'C:\\Users\\Rakesh\\Start Menu\\Startup\\Ollama.lnk', source: 'user-folder', enabled: true },
  { id: 'machine-registry-32:BrStsMon00', name: 'BrStsMon00', command: 'C:\\Program Files (x86)\\Brother\\BrStMonW.exe /AUTORUN', source: 'machine-registry-32', enabled: true },
];

export class MemIo implements StoreIo {
  files = new Map<string, string>();
  read = (p: string): string | null => this.files.get(p) ?? null;
  write = (p: string, t: string): void => void this.files.set(p, t);
}

export function pcRig(options: { stillWaitingMs?: number } = {}) {
  const sys = new FakePc();
  const io = new MemIo();
  let ids = 0;
  const journal = new PcJournal('pc-changes.json', io, () => 1_800_000_000_000, () => `c${++ids}`);
  /** What Eya said aloud on her own while a tool was working (where the permission box was waiting for a Yes). */
  const notes: string[] = [];
  const tools = createPcTools({ sys, journal, notify: (t) => void notes.push(t), pollMs: 1, stillWaitingMs: options.stillWaitingMs ?? 8_000 });
  const call = async (name: string, args: ToolArgs = {}): Promise<ToolResult> => {
    const tool = tools.find((t: Tool) => t.schema.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.execute(args);
  };
  return { sys, io, journal, tools, call, notes };
}

/** The tools of the Windows side on a pretend Windows (a busy one), with a record of what Eya said aloud while she worked. */
export function winRig(options: { stillWaitingMs?: number; world?: boolean } = {}) {
  const pc = new FakePc();
  const win = new FakeWin();
  if (options.world !== false) {
    win.procs = busyWorld();
    win.startup = startupWorld();
  }
  const io = new MemIo();
  let ids = 0;
  const journal = new PcJournal('pc-changes.json', io, () => 1_800_000_000_000, () => `w${++ids}`);
  const notes: string[] = [];
  const tools = createWinTools({ pc, win, journal, notify: (t) => void notes.push(t), pollMs: 1, stillWaitingMs: options.stillWaitingMs ?? 8_000, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))), selfPid: 900, windir: 'C:\\Windows' });
  const call = async (name: string, args: ToolArgs = {}): Promise<ToolResult> => {
    const tool = tools.find((t: Tool) => t.schema.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.execute(args);
  };
  return { pc, win, journal, tools, call, notes };
}

/** A list or search as winget prints it: a header, a line of dashes, and the columns lined up under the header. */
function table(rows: ReadonlyArray<{ name: string; id: string; version: string }>): string {
  const width = (pick: (r: { name: string; id: string; version: string }) => string, head: string): number => Math.max(head.length, ...rows.map((r) => pick(r).length)) + 2;
  const nw = width((r) => r.name, 'Name');
  const iw = width((r) => r.id, 'Id');
  const vw = width((r) => r.version, 'Version');
  return `${'Name'.padEnd(nw)}${'Id'.padEnd(iw)}${'Version'.padEnd(vw)}Source\n${'-'.repeat(nw + iw + vw + 6)}\n${rows.map((r) => `${r.name.padEnd(nw)}${r.id.padEnd(iw)}${r.version.padEnd(vw)}winget`).join('\n')}\n`;
}

/** A winget that knows these packages. */
export function wingetThatKnows(packages: Array<{ name: string; id: string; version: string; publisher: string }>, installed: Set<string> = new Set()) {
  return (file: string, args: readonly string[]): RunResult => {
    const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
    if (file !== 'winget') return ok('');
    const id = args[args.indexOf('--id') + 1];
    if (args[0] === 'search') {
      const q = (args[args.indexOf('--query') + 1] ?? '').toLowerCase();
      const hits = packages.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
      const header = 'Name   Id            Version  Match      Source\n';
      const rows = hits.map((p) => `${p.name.padEnd(7)}${p.id.padEnd(14)}${p.version.padEnd(9)}${'Tag: x'.padEnd(11)}winget`).join('\n');
      return ok(`${header}${'-'.repeat(48)}\n${rows}\n`);
    }
    const p = packages.find((x) => x.id === id);
    if (args[0] === 'show') return p === undefined ? { code: 1, stdout: 'No package found matching input criteria.', stderr: '', timedOut: false } : ok(`Found ${p.name} [${p.id}]\nVersion: ${p.version}\nPublisher: ${p.publisher}\n`);
    if (args[0] === 'install') {
      if (p !== undefined) installed.add(p.id);
      return ok('Successfully installed');
    }
    if (args[0] === 'uninstall') {
      if (id !== undefined) installed.delete(id);
      return ok('Successfully uninstalled');
    }
    const none: RunResult = { code: 1, stdout: 'No installed package found matching input criteria.', stderr: '', timedOut: false };
    if (args[0] === 'list' && args.includes('--query')) {
      const q = (args[args.indexOf('--query') + 1] ?? '').toLowerCase();
      const rows = packages.filter((x) => installed.has(x.id) && (x.name.toLowerCase().includes(q) || x.id.toLowerCase().includes(q))).map((x) => ({ name: x.name, id: x.id, version: x.version }));
      return rows.length === 0 ? none : ok(table(rows));
    }
    if (args[0] === 'list') return id !== undefined && installed.has(id) ? ok(table([{ name: p?.name ?? id, id, version: p?.version ?? '1.0' }])) : none;
    return ok('');
  };
}
