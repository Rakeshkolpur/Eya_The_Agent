import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, rmdirSync, rmSync, realpathSync, statSync, statfsSync } from 'node:fs';
import dns from 'node:dns';
import os from 'node:os';
import { join, resolve, sep } from 'node:path';
import { rootLogger } from '@main/logging/logger';
import { isProcessRunning } from '@main/windowsApi/processes';
import { COMPUTER_NAME } from './computerName';

const log = rootLogger.child('pc');

/** How long a request that waits for the person's answer to the permission box is allowed to wait. */
const ELEVATION_WAIT_MS = 5 * 60_000;

/**
 * Windows' own program by its full path. A program of the same name that comes first on the PATH (Git for Windows ships a `whoami` that does not understand `/groups`) must never be the one
 * that answers a question about the account or the registry.
 */
const system32 = (exe: string): string => join(process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows', 'System32', exe);

export interface RunResult {
  /** The exit code, or null when the program could not be started or was stopped for taking too long. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface EnvEntry {
  readonly value: string;
  readonly kind: 'String' | 'ExpandString';
}

export interface DiskInfo {
  readonly drive: string;
  readonly freeGb: number;
  readonly totalGb: number;
}

export interface OsInfo {
  readonly windows: string;
  readonly build: string;
  readonly user: string;
  readonly isAdmin: boolean;
  readonly uptimeHours: number;
  readonly ramGb: number;
  readonly freeRamGb: number;
  /** Windows is waiting for a restart to finish an install or an update. */
  readonly pendingReboot: boolean;
}

export interface NetworkInfo {
  readonly dns: boolean;
  readonly internet: boolean;
  readonly proxy: string | null;
  readonly adapters: number;
}

export interface TempScan {
  readonly dir: string;
  readonly files: number;
  readonly bytes: number;
  /** Files not touched for the given time: the only ones that would be cleared. */
  readonly oldFiles: number;
  readonly oldBytes: number;
}

export interface ComputerNames {
  /** The name the PC has now. */
  readonly active: string;
  /** The name it will have after the next restart (it differs from `active` right after a rename). */
  readonly pending: string;
}

/**
 * What came of asking Windows for something that needs the permission box: `done` (the person clicked Yes and it ran), `declined` (they clicked No, or closed the box), `failed` (they clicked Yes
 * and Windows refused), `timed_out` (nobody answered).
 */
export type ElevatedOutcome = 'done' | 'declined' | 'failed' | 'timed_out';

export interface ElevatedResult {
  readonly outcome: ElevatedOutcome;
  readonly code: number | null;
}

/**
 * Everything the PC tools need from Windows, behind one interface so that every rule above it is tested without touching a machine. The real one (below) uses PowerShell and Node only
 * through fixed scripts: nothing the model or the person says is ever put into a command line — names and values travel in the child's environment variables.
 */
export interface PcSystem {
  /** The user's or the machine's environment as the registry keeps it (variables not expanded). */
  readEnv(scope: 'user' | 'machine'): Promise<Record<string, EnvEntry>>;
  /** Sets a variable of the USER's environment and tells the running programs (WM_SETTINGCHANGE). */
  writeEnv(name: string, value: string, kind: EnvEntry['kind']): Promise<void>;
  deleteEnv(name: string): Promise<void>;
  /** %VARIABLE% in a path, replaced by what it is now (this process's environment). */
  expand(text: string): string;
  folderExists(path: string): boolean;
  fileExists(path: string): boolean;
  /** The names of the folders inside a folder (for finding where a program was installed); empty when there is none. */
  listDirs(parent: string): string[];
  run(file: string, args: readonly string[], timeoutMs: number): Promise<RunResult>;
  /** Starts a program and lets it go (it is not waited for: a shell like Explorer never ends). */
  start(file: string, args: readonly string[]): void;
  /** Where `where.exe` finds a program on the PATH this process has. */
  where(name: string): Promise<string[]>;
  osInfo(): Promise<OsInfo>;
  disks(): Promise<DiskInfo[]>;
  network(): Promise<NetworkInfo>;
  scanTemp(olderThanMs: number): TempScan;
  /** Removes the files in the user's temp folder that have not been touched for this long (never anything outside it, never a file in use). */
  clearTemp(olderThanMs: number): { readonly removed: number; readonly bytes: number; readonly skipped: number };
  isProcessRunning(imageName: string): Promise<boolean>;
  /** The PC's name now and the one it will have after a restart (read only). */
  computerNames(): Promise<ComputerNames>;
  /** Windows' own permission box ("Do you want to allow this app to make changes to your device?") is on the screen right now (read only). */
  permissionBoxOpen(): Promise<boolean>;
  /** This Windows account is an administrator, so the permission box is a plain Yes / No; a standard user is asked for an administrator's password instead (read only). */
  adminAccount(): Promise<boolean>;
  /**
   * Renames the PC. That needs administrator rights, so Windows shows its own permission box and the PERSON answers it: Eya never clicks it, never types a password and never gets rights of her
   * own. Only a name that passes `COMPUTER_NAME` is accepted (this is the one fixed command that is run with rights; nothing else can reach it). The new name starts after a restart.
   */
  renameComputer(name: string): Promise<ElevatedResult>;
}

const GB = 1024 ** 3;
const TEMP_SCAN_LIMIT = 40_000;

/** Runs a fixed PowerShell script. The only things that vary travel in `vars` (the child's environment), never in the script text. */
export function powershell(script: string, vars: Readonly<Record<string, string>> = {}, timeoutMs = 20_000): Promise<RunResult> {
  return new Promise((resolveRun) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...vars } },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolveRun({ code: e === null ? 0 : typeof e.code === 'number' ? e.code : null, stdout: String(stdout), stderr: String(stderr), timedOut: e?.killed === true });
      },
    );
  });
}

const BROADCAST = `
Add-Type -Namespace Eya -Name Native -MemberDefinition '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
$r = [UIntPtr]::Zero
[Eya.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r) | Out-Null
`;

const READ_ENV = `
$ErrorActionPreference = 'Stop'
if ($env:EYA_SCOPE -eq 'machine') { $k = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment') } else { $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment') }
$out = [ordered]@{}
foreach ($n in $k.GetValueNames()) {
  $v = $k.GetValue($n, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $out[$n] = @{ value = [string]$v; kind = $k.GetValueKind($n).ToString() }
}
$k.Close()
if ($out.Count -eq 0) { '{}' } else { $out | ConvertTo-Json -Compress -Depth 3 }
`;

const WRITE_ENV = `
$ErrorActionPreference = 'Stop'
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$kind = [Microsoft.Win32.RegistryValueKind]::String
if ($env:EYA_KIND -eq 'ExpandString') { $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
$k.SetValue($env:EYA_NAME, $env:EYA_VALUE, $kind)
$k.Close()
${BROADCAST}
'ok'
`;

const DELETE_ENV = `
$ErrorActionPreference = 'Stop'
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$k.DeleteValue($env:EYA_NAME, $false)
$k.Close()
${BROADCAST}
'ok'
`;

const OS_INFO = `
$ErrorActionPreference = 'SilentlyContinue'
$cv = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$pending = (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')
[ordered]@{ windows = ($cv.ProductName + ' ' + $cv.DisplayVersion).Trim(); build = ([string]$cv.CurrentBuildNumber + '.' + [string]$cv.UBR); admin = [bool]$admin; pending = [bool]$pending } | ConvertTo-Json -Compress
`;

/**
 * Starts one fixed command with administrator rights through Windows' own permission box and waits for the person's answer. The command arrives in the child's environment (never in this script's
 * text) and is handed on encoded, so nothing in it is ever read as part of another command. A "No" is told by Windows' own error number (1223), not by its words, which change with the language.
 */
const ELEVATE = `
$ErrorActionPreference = 'Stop'
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($env:EYA_INNER))
try {
  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$enc
  exit $p.ExitCode
} catch {
  $e = $_.Exception
  $native = $null
  while ($e -ne $null) { if ($e -is [System.ComponentModel.Win32Exception]) { $native = $e.NativeErrorCode; break }; $e = $e.InnerException }
  if ($native -eq 1223 -or $_.Exception.Message -match 'cancel') { exit 1223 }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

/** The script that asks for the box (exported so that its handling of a "No" can be tested on a real PowerShell without any box). */
export const ELEVATION_SCRIPT = ELEVATE;

/** Rename-Computer, for a name that has already been checked. Exit 0 when Windows accepted it, 3 when it did not. */
const renameCommand = (name: string): string => `try { Rename-Computer -NewName '${name}' -Force -ErrorAction Stop; exit 0 } catch { exit 3 }`;

/** Runs a command through Windows' permission box. Only for fixed commands (the rename, a service restart) and for a command the person has read and said yes to (see winSystem). */
export async function runElevated(inner: string, waitMs: number = ELEVATION_WAIT_MS): Promise<ElevatedResult> {
  const r = await powershell(ELEVATE, { EYA_INNER: inner }, waitMs);
  if (r.timedOut) return { outcome: 'timed_out', code: null };
  if (r.code === 0) return { outcome: 'done', code: 0 };
  if (r.code === 1223) return { outcome: 'declined', code: 1223 };
  return { outcome: 'failed', code: r.code };
}

export function realPcSystem(): PcSystem {
  const sys: PcSystem = {
    async readEnv(scope) {
      const r = await powershell(READ_ENV, { EYA_SCOPE: scope });
      if (r.code !== 0) throw new Error(`could not read the ${scope} environment: ${r.stderr.slice(0, 200)}`);
      const raw = JSON.parse(r.stdout.trim() || '{}') as Record<string, { value?: unknown; kind?: unknown }>;
      const out: Record<string, EnvEntry> = {};
      for (const [name, v] of Object.entries(raw)) out[name] = { value: typeof v.value === 'string' ? v.value : '', kind: v.kind === 'ExpandString' ? 'ExpandString' : 'String' };
      return out;
    },
    async writeEnv(name, value, kind) {
      const r = await powershell(WRITE_ENV, { EYA_NAME: name, EYA_VALUE: value, EYA_KIND: kind }, 30_000);
      if (r.code !== 0 || !r.stdout.includes('ok')) throw new Error(`could not set the variable: ${r.stderr.slice(0, 200)}`);
    },
    async deleteEnv(name) {
      const r = await powershell(DELETE_ENV, { EYA_NAME: name }, 30_000);
      if (r.code !== 0 || !r.stdout.includes('ok')) throw new Error(`could not remove the variable: ${r.stderr.slice(0, 200)}`);
    },
    expand: (text) => text.replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (whole, name: string) => process.env[name] ?? process.env[name.toUpperCase()] ?? whole),
    folderExists: (path) => {
      try {
        return statSync(sys.expand(path)).isDirectory();
      } catch {
        return false;
      }
    },
    fileExists: (path) => {
      try {
        return statSync(sys.expand(path)).isFile();
      } catch {
        return false;
      }
    },
    listDirs: (parent) => {
      try {
        return readdirSync(sys.expand(parent), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        return [];
      }
    },
    run: (file, args, timeoutMs) =>
      new Promise((resolveRun) => {
        execFile(file, [...args], { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
          resolveRun({ code: e === null ? 0 : typeof e.code === 'number' ? e.code : null, stdout: String(stdout), stderr: String(stderr), timedOut: e?.killed === true });
        });
      }),
    start: (file, args) => {
      try {
        spawn(file, [...args], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      } catch (err) {
        log.warn('could not start a program', { err: String(err).slice(0, 120) });
      }
    },
    async where(name) {
      const r = await sys.run('where.exe', [name], 8_000);
      return r.code === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '') : [];
    },
    async osInfo() {
      const r = await powershell(OS_INFO, {}, 20_000);
      let base: { windows?: string; build?: string; admin?: boolean; pending?: boolean } = {};
      try {
        base = JSON.parse(r.stdout.trim()) as typeof base;
      } catch {
        log.warn('could not read the Windows version');
      }
      return {
        windows: base.windows ?? `Windows ${os.release()}`,
        build: base.build ?? os.release(),
        user: os.userInfo().username,
        isAdmin: base.admin === true,
        uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
        ramGb: Math.round((os.totalmem() / GB) * 10) / 10,
        freeRamGb: Math.round((os.freemem() / GB) * 10) / 10,
        pendingReboot: base.pending === true,
      };
    },
    async disks() {
      const out: DiskInfo[] = [];
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const root = `${letter}:\\`;
        if (!existsSync(root)) continue;
        try {
          const s = statfsSync(root);
          out.push({ drive: `${letter}:`, freeGb: Math.round(((s.bavail * s.bsize) / GB) * 10) / 10, totalGb: Math.round(((s.blocks * s.bsize) / GB) * 10) / 10 });
        } catch {
          // a drive that cannot be read (an empty card reader) is left out
        }
      }
      return out;
    },
    async network() {
      const adapters = Object.values(os.networkInterfaces()).flat().filter((i) => i !== undefined && !i.internal && i.family === 'IPv4').length;
      const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T | null> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([p, new Promise<null>((r) => { timer = setTimeout(() => r(null), ms); })]);
        } catch {
          return null;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };
      const dnsOk = (await withTimeout(dns.promises.lookup('www.microsoft.com'), 5_000)) !== null;
      const text = await withTimeout(fetch('http://www.msftconnecttest.com/connecttest.txt').then((r) => r.text()), 6_000);
      const proxyVar = process.env['HTTPS_PROXY'] ?? process.env['HTTP_PROXY'] ?? null;
      const winhttp = await sys.run('netsh', ['winhttp', 'show', 'proxy'], 6_000);
      const m = /Proxy Server\(s\)\s*:\s*(.+)/i.exec(winhttp.stdout);
      return { dns: dnsOk, internet: text !== null && /Microsoft Connect Test/i.test(text), proxy: proxyVar ?? (m?.[1] !== undefined ? m[1].trim() : null), adapters };
    },
    scanTemp: (olderThanMs) => scanTemp(olderThanMs, false),
    clearTemp: (olderThanMs) => {
      const done = scanTemp(olderThanMs, true);
      return { removed: done.removed, bytes: done.removedBytes, skipped: done.skipped };
    },
    isProcessRunning: (imageName) => isProcessRunning(imageName),
    async computerNames() {
      const read = async (key: string): Promise<string> => {
        const r = await sys.run(system32('reg.exe'), ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Control\\ComputerName\\${key}`, '/v', 'ComputerName'], 8_000);
        return /ComputerName\s+REG_SZ\s+(\S+)/i.exec(r.stdout)?.[1] ?? '';
      };
      const [active, pending] = await Promise.all([read('ActiveComputerName'), read('ComputerName')]);
      const now = active !== '' ? active : os.hostname();
      return { active: now, pending: pending !== '' ? pending : now };
    },
    // consent.exe is the program that draws Windows' permission box; it exists only while a box is waiting for an answer.
    permissionBoxOpen: () => isProcessRunning('consent.exe'),
    async adminAccount() {
      // an administrator's account lists the Administrators group even when this program is not elevated (as "used for deny only")
      const r = await sys.run(system32('whoami.exe'), ['/groups', '/fo', 'csv', '/nh'], 8_000);
      return r.code === 0 && r.stdout.includes('S-1-5-32-544');
    },
    async renameComputer(name) {
      if (!COMPUTER_NAME.test(name)) throw new Error('that is not a name Windows accepts for a PC');
      log.info('asking Windows (permission box) to rename the PC');
      return runElevated(renameCommand(name));
    },
  };
  return sys;
}

interface TempWalk extends TempScan {
  readonly removed: number;
  readonly removedBytes: number;
  readonly skipped: number;
}

/**
 * Walks the user's temp folder (and nothing else): counts what is there and what has not been touched for `olderThanMs`, and, when `remove` is set, removes those files. A symbolic link is never
 * followed, a path that resolves outside the temp folder is never touched, and a file in use (the removal fails) is left. Emptied folders are removed too. The walk stops after a fixed number of entries.
 */
function scanTemp(olderThanMs: number, remove: boolean): TempWalk {
  const dir = os.tmpdir();
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    return { dir, files: 0, bytes: 0, oldFiles: 0, oldBytes: 0, removed: 0, removedBytes: 0, skipped: 0 };
  }
  const cutoff = Date.now() - olderThanMs;
  let files = 0;
  let bytes = 0;
  let oldFiles = 0;
  let oldBytes = 0;
  let removed = 0;
  let removedBytes = 0;
  let skipped = 0;
  let seen = 0;
  const inside = (p: string): boolean => {
    const r = resolve(p);
    return r === root || r.startsWith(root + sep);
  };
  const walk = (folder: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(folder);
    } catch {
      return;
    }
    for (const name of entries) {
      if (seen++ > TEMP_SCAN_LIMIT) return;
      const path = join(folder, name);
      if (!inside(path)) continue;
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(path);
        if (remove) {
          try {
            rmdirSync(path); // (only when it is empty now)
          } catch {
            // not empty, or in use: stays
          }
        }
        continue;
      }
      files += 1;
      bytes += st.size;
      if (st.mtimeMs <= cutoff) {
        oldFiles += 1;
        oldBytes += st.size;
        if (remove) {
          try {
            rmSync(path, { force: false });
            removed += 1;
            removedBytes += st.size;
          } catch {
            skipped += 1;
          }
        }
      }
    }
  };
  walk(root);
  return { dir, files, bytes, oldFiles, oldBytes, removed, removedBytes, skipped };
}
