import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { rootLogger } from '@main/logging/logger';
import type { MicFacts } from './micRules';
import { powershell, runElevated } from './pcSystem';
import type { ElevatedOutcome, ElevatedResult } from './pcSystem';
import type { ProcInfo } from './processRules';
import { approvedBytes } from './startupRules';
import type { StartupEntry, StartupSource } from './startupRules';

const log = rootLogger.child('pc.win');

/** The services Eya may restart (through Windows' permission box), by the name she uses for them. The commands are fixed here; nothing the person or a model says reaches them. */
export const SERVICES = {
  audio: { label: 'Windows Audio', watch: ['AudioEndpointBuilder', 'Audiosrv'], inner: "Restart-Service -Name 'AudioEndpointBuilder' -Force -ErrorAction Stop; Start-Service -Name 'Audiosrv' -ErrorAction Stop" },
  printer: { label: 'the print spooler', watch: ['Spooler'], inner: "Restart-Service -Name 'Spooler' -Force -ErrorAction Stop" },
  bluetooth: { label: 'the Bluetooth service', watch: ['bthserv'], inner: "Restart-Service -Name 'bthserv' -Force -ErrorAction Stop" },
  search: { label: 'Windows Search (the file index)', watch: ['WSearch'], inner: "Restart-Service -Name 'WSearch' -Force -ErrorAction Stop" },
} as const;
export type ServiceKey = keyof typeof SERVICES;
export const SERVICE_KEYS = Object.keys(SERVICES) as ServiceKey[];

export interface CommandResult {
  /** `done`: it ran and finished normally; `failed`: it ran and ended with an error; `declined` / `timed_out`: the permission box was answered No or not at all. */
  readonly outcome: ElevatedOutcome;
  readonly code: number | null;
  readonly output: string;
}

/**
 * What the tools for the Windows side of the PC (programs, start-up, microphone, services, commands) need from Windows, behind one interface so that every rule above it is tested without
 * touching a machine. The real one uses PowerShell through fixed scripts: names and values travel in the child's environment, never inside a script's text. The one exception is `runCommand`,
 * whose text is the command the person has read and agreed to (or one that only looks), checked first by commandPolicy.
 */
export interface WinSystem {
  /** Every running program of every session, with its memory, its window and its parent. */
  listProcesses(): Promise<ProcInfo[]>;
  /** `close` asks a program with a window to close like its X (it may ask to save); a program without one is ended. `kill` ends it outright. Nothing is checked here: the rules decide first. */
  stopProcesses(pids: readonly number[], how: 'close' | 'kill'): Promise<void>;
  /** Starts a program again from where it was (a path Eya wrote down when she stopped it). */
  startProgram(path: string): void;
  startupEntries(): Promise<StartupEntry[]>;
  /** Turns a start-up entry on or off the way Task Manager does (a small "approved" value next to it; the entry itself is not touched). */
  setStartupEnabled(entry: Pick<StartupEntry, 'name' | 'source'>, enabled: boolean): Promise<void>;
  micFacts(): Promise<MicFacts>;
  setMicMuted(muted: boolean): Promise<void>;
  setMicVolume(percent: number): Promise<void>;
  /** Switches the microphone access of Windows' Privacy settings on (for this user, and for desktop programs). */
  allowMicAccess(): Promise<void>;
  /** The status of services (Running, Stopped …), by name. */
  serviceStatus(names: readonly string[]): Promise<Record<string, string>>;
  /** Restarts one of the services in SERVICES through Windows' permission box; the person answers it. */
  restartService(key: ServiceKey): Promise<ElevatedResult>;
  /** Runs a command. Without `admin` it runs at once; with it, through Windows' permission box (the person answers it) and its output is read from a file. */
  runCommand(script: string, o: { readonly admin: boolean; readonly timeoutMs: number }): Promise<CommandResult>;
  /** Memory in megabytes, now. */
  memory(): { readonly freeMb: number; readonly totalMb: number };
  /** The time now in milliseconds (so that a test controls it). */
  now(): number;
}

const parseJsonList = <T>(text: string): T[] => {
  const t = text.trim();
  if (t === '' || t === 'null') return [];
  const raw = JSON.parse(t) as unknown;
  return Array.isArray(raw) ? (raw as T[]) : [raw as T];
};

const LIST_PROCS = `
$ErrorActionPreference = 'SilentlyContinue'
$parents = @{}
foreach ($c in (Get-CimInstance Win32_Process)) { $parents[[int]$c.ProcessId] = [int]$c.ParentProcessId }
$rows = New-Object System.Collections.ArrayList
foreach ($p in (Get-Process)) {
  [void]$rows.Add([ordered]@{ pid = [int]$p.Id; parent = [int]$parents[[int]$p.Id]; name = [string]$p.ProcessName; mb = [int]($p.WorkingSet64 / 1MB); win = ($p.MainWindowHandle -ne 0); path = [string]$p.Path; session = [int]$p.SessionId })
}
if ($rows.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject @($rows) -Compress }
`;

const STOP_PROCS = `
$ErrorActionPreference = 'SilentlyContinue'
foreach ($id in ($env:EYA_PIDS -split ',')) {
  $p = Get-Process -Id ([int]$id)
  if (-not $p) { continue }
  if ($env:EYA_HOW -eq 'close' -and $p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() } else { Stop-Process -Id $p.Id -Force }
}
'ok'
`;

const APPROVED = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved';

const STARTUP_LIST = `
$ErrorActionPreference = 'SilentlyContinue'
$hkcu = [Microsoft.Win32.Registry]::CurrentUser
$hklm = [Microsoft.Win32.Registry]::LocalMachine
function Approved($hive, $sub, $name) {
  $k = $hive.OpenSubKey('${APPROVED}\\' + $sub)
  if ($k) { $v = $k.GetValue($name); $k.Close(); if ($v -is [byte[]] -and $v.Length -gt 0) { return [int]$v[0] } }
  return $null
}
$out = New-Object System.Collections.ArrayList
function AddRun($hive, $path, $source, $sub) {
  $k = $hive.OpenSubKey($path)
  if (-not $k) { return }
  foreach ($n in $k.GetValueNames()) {
    if ($n -eq '') { continue }
    $a = Approved $hkcu $sub $n
    if ($a -eq $null) { $a = Approved $hklm $sub $n }
    $off = ($a -ne $null -and (($a -band 1) -eq 1))
    [void]$out.Add([ordered]@{ name = [string]$n; command = [string]$k.GetValue($n); source = $source; enabled = (-not $off) })
  }
  $k.Close()
}
AddRun $hkcu 'Software\\Microsoft\\Windows\\CurrentVersion\\Run' 'user-registry' 'Run'
AddRun $hklm 'Software\\Microsoft\\Windows\\CurrentVersion\\Run' 'machine-registry' 'Run'
AddRun $hklm 'Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run' 'machine-registry-32' 'Run32'
function AddFolder($dir, $source) {
  if (-not $dir -or -not (Test-Path $dir)) { return }
  foreach ($f in (Get-ChildItem $dir -File)) {
    if ($f.Name -ieq 'desktop.ini') { continue }
    $a = Approved $hkcu 'StartupFolder' $f.Name
    if ($a -eq $null) { $a = Approved $hklm 'StartupFolder' $f.Name }
    $off = ($a -ne $null -and (($a -band 1) -eq 1))
    [void]$out.Add([ordered]@{ name = [string]$f.Name; command = [string]$f.FullName; source = $source; enabled = (-not $off) })
  }
}
AddFolder ([Environment]::GetFolderPath('Startup')) 'user-folder'
AddFolder ([Environment]::GetFolderPath('CommonStartup')) 'machine-folder'
if ($out.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject @($out) -Compress }
`;

const SET_STARTUP = `
$ErrorActionPreference = 'Stop'
$hex = $env:EYA_HEX
$bytes = [byte[]]@(for ($i = 0; $i -lt $hex.Length; $i += 2) { [Convert]::ToByte($hex.Substring($i, 2), 16) })
$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${APPROVED}\\' + $env:EYA_SUB)
$k.SetValue($env:EYA_NAME, $bytes, [Microsoft.Win32.RegistryValueKind]::Binary)
$k.Close()
'ok'
`;

const SUB_OF: Readonly<Record<StartupSource, 'Run' | 'Run32' | 'StartupFolder'>> = {
  'user-registry': 'Run',
  'machine-registry': 'Run',
  'machine-registry-32': 'Run32',
  'user-folder': 'StartupFolder',
  'machine-folder': 'StartupFolder',
};

/** The sound helper: Windows' audio endpoint interfaces cannot be called through PowerShell's own COM binder, so the calls are made inside compiled code (the same approach as the speaker volume). */
const MIC_HELPER = `
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMicVolume {
  int f1(); int f2(); int f3(); int f4();
  int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);
  int f5();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int f6(); int f7(); int f8(); int f9();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, System.Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMicDevice {
  int Activate(ref System.Guid id, int clsCtx, int activationParams, out IMicVolume aev);
  int OpenPropertyStore(int access, out System.IntPtr props);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMicEnumerator { int f1(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMicDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MicEnumeratorComObject { }
public class EyaMic {
  static IMicDevice Dev() {
    var e = new MicEnumeratorComObject() as IMicEnumerator;
    IMicDevice d;
    int hr = e.GetDefaultAudioEndpoint(1, 0, out d);
    return hr == 0 ? d : null;
  }
  static IMicVolume Vol(IMicDevice d) { var g = typeof(IMicVolume).GUID; IMicVolume v; d.Activate(ref g, 23, 0, out v); return v; }
  public static string Info() {
    var d = Dev(); if (d == null) return "none";
    string id; d.GetId(out id);
    var v = Vol(d); float lvl; v.GetMasterVolumeLevelScalar(out lvl); bool m; v.GetMute(out m);
    return id + "|" + (m ? "1" : "0") + "|" + ((int)System.Math.Round(lvl * 100)).ToString();
  }
  public static bool SetMute(bool m) { var d = Dev(); if (d == null) return false; Vol(d).SetMute(m, System.Guid.Empty); return true; }
  public static bool SetVolume(float l) { var d = Dev(); if (d == null) return false; Vol(d).SetMasterVolumeLevelScalar(l, System.Guid.Empty); return true; }
}
`;

const withMicHelper = (rest: string): string => `Add-Type -TypeDefinition @'${MIC_HELPER}'@\n${rest}`;

const MIC_FACTS = `
$ErrorActionPreference = 'SilentlyContinue'
function Val($p) { (Get-ItemProperty -Path $p -Name Value).Value }
$cs = 'Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'
$accessUser = Val ('HKCU:\\' + $cs)
$accessMachine = Val ('HKLM:\\' + $cs)
$desktop = Val ('HKCU:\\' + $cs + '\\NonPackaged')
$pol = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\AppPrivacy' -Name LetAppsAccessMicrophone).LetAppsAccessMicrophone
$used = New-Object System.Collections.ArrayList
$blocked = New-Object System.Collections.ArrayList
function Visit($path, $nonPackaged) {
  foreach ($k in (Get-ChildItem $path)) {
    $n = $k.PSChildName
    if ($n -eq 'NonPackaged') { Visit $k.PSPath $true; continue }
    $p = Get-ItemProperty $k.PSPath
    $label = $n
    if ($nonPackaged) { $label = ($n -split '#')[-1] -replace '\\.exe$', '' } else { $label = ($n -split '_')[0] -replace '^Microsoft\\.', '' }
    if ($p.Value -eq 'Deny') { [void]$blocked.Add($label) }
    if ($p.LastUsedTimeStart -gt 0 -and $p.LastUsedTimeStop -eq 0) { [void]$used.Add($label) }
  }
}
Visit ('HKCU:\\' + $cs) $false
$devices = New-Object System.Collections.ArrayList
foreach ($k in (Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Capture')) {
  $p = Get-ItemProperty $k.PSPath
  $pr = Get-ItemProperty ($k.PSPath + '\\Properties')
  [void]$devices.Add([ordered]@{ guid = [string]$k.PSChildName; name = [string]$pr.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'; state = [int64]$p.DeviceState })
}
$info = 'error'
try { $info = [EyaMic]::Info() } catch { $info = 'error' }
$svc = @{}
foreach ($s in (Get-Service -Name 'Audiosrv', 'AudioEndpointBuilder')) { $svc[$s.Name] = [string]$s.Status }
[ordered]@{ accessUser = $accessUser; accessMachine = $accessMachine; desktop = $desktop; policy = $pol; used = @($used); blocked = @($blocked); devices = @($devices); info = $info; audio = $svc['Audiosrv']; builder = $svc['AudioEndpointBuilder'] } | ConvertTo-Json -Compress -Depth 4
`;

const ALLOW_MIC = `
$ErrorActionPreference = 'Stop'
$cs = 'Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'
foreach ($sub in @('', '\\NonPackaged')) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($cs + $sub)
  $k.SetValue('Value', 'Allow', [Microsoft.Win32.RegistryValueKind]::String)
  $k.Close()
}
'ok'
`;

const SERVICE_STATUS = `
$ErrorActionPreference = 'SilentlyContinue'
$o = [ordered]@{}
foreach ($n in ($env:EYA_NAMES -split ',')) { $s = Get-Service -Name $n; $o[$n] = if ($s) { [string]$s.Status } else { 'Missing' } }
$o | ConvertTo-Json -Compress
`;

/** A short random name for the file an elevated command writes its output to. */
const tempOut = (): string => join(os.tmpdir(), `eya-admin-${randomBytes(6).toString('hex')}.txt`);
const MAX_OUTPUT = 20_000;

function runPlain(script: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        const output = `${String(stdout)}${String(stderr) !== '' ? `\n${String(stderr)}` : ''}`.trim().slice(0, MAX_OUTPUT);
        if (e?.killed === true) return resolve({ outcome: 'timed_out', code: null, output });
        resolve({ outcome: e === null ? 'done' : 'failed', code: e === null ? 0 : typeof e.code === 'number' ? e.code : null, output });
      },
    );
  });
}

export function realWinSystem(): WinSystem {
  const sys: WinSystem = {
    async listProcesses() {
      const r = await powershell(LIST_PROCS, {}, 30_000);
      if (r.code !== 0) throw new Error(`could not list the programs: ${r.stderr.slice(0, 200)}`);
      return parseJsonList<{ pid: number; parent: number; name: string; mb: number; win: boolean; path: string; session: number }>(r.stdout).map((p) => ({
        pid: Number(p.pid),
        parent: Number(p.parent),
        name: String(p.name),
        mb: Number(p.mb),
        hasWindow: p.win === true,
        path: String(p.path ?? ''),
        session: Number(p.session),
      }));
    },
    async stopProcesses(pids, how) {
      const ids = pids.filter((n) => Number.isInteger(n) && n > 4);
      if (ids.length === 0) return;
      const r = await powershell(STOP_PROCS, { EYA_PIDS: ids.join(','), EYA_HOW: how }, 60_000);
      if (r.code !== 0) throw new Error(`could not stop them: ${r.stderr.slice(0, 200)}`);
    },
    startProgram(path) {
      // (through Explorer's own start, so that the program is not tied to Eya and opens as if the person had clicked it)
      execFile('explorer.exe', [path], { windowsHide: false }, () => undefined);
    },
    async startupEntries() {
      const r = await powershell(STARTUP_LIST, {}, 30_000);
      if (r.code !== 0) throw new Error(`could not read the start-up programs: ${r.stderr.slice(0, 200)}`);
      return parseJsonList<{ name: string; command: string; source: StartupSource; enabled: boolean }>(r.stdout).map((e) => ({ id: `${e.source}:${e.name}`, name: String(e.name), command: String(e.command ?? ''), source: e.source, enabled: e.enabled !== false }));
    },
    async setStartupEnabled(entry, enabled) {
      const hex = approvedBytes(enabled, sys.now()).map((b) => b.toString(16).padStart(2, '0')).join('');
      const r = await powershell(SET_STARTUP, { EYA_SUB: SUB_OF[entry.source], EYA_NAME: entry.name, EYA_HEX: hex }, 30_000);
      if (r.code !== 0 || !r.stdout.includes('ok')) throw new Error(`could not change the start-up program: ${r.stderr.slice(0, 200)}`);
    },
    async micFacts() {
      const r = await powershell(withMicHelper(MIC_FACTS), {}, 40_000);
      if (r.code !== 0 || r.stdout.trim() === '') throw new Error(`could not look at the microphone: ${r.stderr.slice(0, 200)}`);
      const j = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
      const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]);
      const info = typeof j['info'] === 'string' ? (j['info'] as string) : 'error';
      // (the sound helper itself failed: that is not the same as "there is no microphone", so it is not reported as one)
      if (info === 'error') throw new Error('could not ask Windows about the default microphone');
      const [id, muted, volume] = info.split('|');
      const devices = list(j['devices']).map((d) => d as { guid: string; name: string; state: number });
      const defaultGuid = /\.\{([0-9a-f-]+)\}$/i.exec(id ?? '')?.[1]?.toLowerCase();
      const defaultName = devices.find((d) => d.guid.toLowerCase().includes(defaultGuid ?? '\0'))?.name;
      const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
      return {
        accessUser: str(j['accessUser']),
        accessMachine: str(j['accessMachine']),
        accessDesktopApps: str(j['desktop']),
        policyBlocks: j['policy'] === 2,
        usedNow: [...new Set(list(j['used']).map(String))],
        blockedApps: [...new Set(list(j['blocked']).map(String))],
        devices: devices.map((d) => ({ name: String(d.name || 'Microphone'), state: Number(d.state) })),
        defaultDevice: info === 'none' || id === undefined ? null : { name: defaultName ?? 'the default microphone', muted: muted === '1', volume: Number(volume ?? 0) },
        audioService: str(j['audio']) ?? '',
        endpointBuilder: str(j['builder']) ?? '',
      };
    },
    async setMicMuted(muted) {
      const r = await powershell(withMicHelper(`if ([EyaMic]::SetMute($${muted ? 'true' : 'false'})) { 'ok' } else { 'none' }`), {}, 30_000);
      if (r.code !== 0 || !r.stdout.includes('ok')) throw new Error('Windows has no default microphone to change');
    },
    async setMicVolume(percent) {
      const level = Math.min(100, Math.max(0, Math.round(percent))) / 100;
      const r = await powershell(withMicHelper(`if ([EyaMic]::SetVolume(${level.toFixed(4)})) { 'ok' } else { 'none' }`), {}, 30_000);
      if (r.code !== 0 || !r.stdout.includes('ok')) throw new Error('Windows has no default microphone to change');
    },
    async allowMicAccess() {
      const r = await powershell(ALLOW_MIC, {}, 30_000);
      if (r.code !== 0 || !r.stdout.includes('ok')) throw new Error(`could not switch the microphone access on: ${r.stderr.slice(0, 200)}`);
    },
    async serviceStatus(names) {
      const safe = names.filter((n) => /^[A-Za-z0-9_.-]{1,60}$/.test(n));
      if (safe.length === 0) return {};
      const r = await powershell(SERVICE_STATUS, { EYA_NAMES: safe.join(',') }, 20_000);
      try {
        return JSON.parse(r.stdout.trim() || '{}') as Record<string, string>;
      } catch {
        return {};
      }
    },
    async restartService(key) {
      const spec = SERVICES[key];
      log.info('asking Windows (permission box) to restart a service', { key });
      return runElevated(`try { ${spec.inner}; exit 0 } catch { exit 3 }`);
    },
    async runCommand(script, o) {
      if (!o.admin) return runPlain(script, o.timeoutMs);
      const out = tempOut();
      const quoted = out.replace(/'/g, "''");
      // (all of the command's output goes to a file the elevated window writes: it has no pipe back to Eya)
      const inner = `$ErrorActionPreference = 'Continue'; try { & { ${script}\n} *>&1 | Out-File -FilePath '${quoted}' -Encoding utf8; exit 0 } catch { ($_ | Out-String) | Out-File -FilePath '${quoted}' -Encoding utf8 -Append; exit 3 }`;
      log.info('asking Windows (permission box) to run a command with administrator rights');
      const r = await runElevated(inner, Math.max(o.timeoutMs, 60_000) + 120_000);
      let output = '';
      try {
        output = readFileSync(out, 'utf8').replace(/^﻿/, '').trim().slice(0, MAX_OUTPUT);
      } catch {
        // (no output: the box was answered No, or the command wrote nothing)
      }
      try {
        rmSync(out, { force: true });
      } catch {
        // (a file in the temp folder: it is cleared with the rest)
      }
      return { outcome: r.outcome, code: r.code, output };
    },
    memory: () => ({ freeMb: Math.round(os.freemem() / 1048576), totalMb: Math.round(os.totalmem() / 1048576) }),
    now: () => Date.now(),
  };
  return sys;
}
