import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { extname } from 'node:path';
import { checkPath } from '@main/security/pathPolicy';
import type { KnownFolders } from '@main/security/pathPolicy';
import type { Tool, ToolResult } from '../types';

/**
 * Writing in Notepad, typed live so the person can watch it: a Notepad window is opened (or the one in front is used), brought to the front, and the words are typed into it a few characters at a
 * time. The one rule that matters: if Notepad is not really the window in front, NOTHING is typed (keystrokes go to whatever has the focus, and that could be the person's browser or a chat).
 * That is checked before the first key and again before every piece. A file is only ever created inside the user's own folders, as a plain text file.
 */
export interface NotepadRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface NotepadToolDeps {
  readonly folders: KnownFolders;
  readonly run?: (script: string, env: Record<string, string>, timeoutMs: number) => Promise<NotepadRun>;
  readonly exists?: (path: string) => boolean;
  readonly createEmpty?: (path: string) => Promise<void>;
}

const SPEEDS: Readonly<Record<string, number>> = { slow: 12, normal: 30, fast: 80 };
const MAX_CHARS = 8000;
const TEXT_EXTENSIONS = ['.txt', '.md', '.log', '.csv', '.json', '.xml', '.ini'];

/** Keys that mean something to SendKeys are typed as themselves by putting them in braces; a new line is Enter and a tab is Tab. */
export const SEND_KEYS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EyaWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@
function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)) }
function Keys-For([string]$s) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $s.ToCharArray()) {
    $c = [string]$ch
    if ('+^%~(){}[]'.Contains($c)) { [void]$sb.Append('{' + $c + '}') }
    elseif ($ch -eq [char]10) { [void]$sb.Append('{ENTER}') }
    elseif ($ch -eq [char]9) { [void]$sb.Append('{TAB}') }
    elseif ($ch -eq [char]13) { }
    else { [void]$sb.Append($c) }
  }
  return $sb.ToString()
}
try {
  $mode = $env:EYA_MODE
  $path = $env:EYA_PATH
  $text = $env:EYA_TEXT
  $cps = [double]$env:EYA_CPS
  $began = Get-Date
  $proc = $null
  if ($mode -eq 'open') {
    $proc = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
    if ($null -eq $proc) { throw 'EYA:there is no Notepad window open' }
  } else {
    if ($path) { [void](Start-Process notepad.exe -ArgumentList ('"' + $path + '"')) } else { [void](Start-Process notepad.exe) }
    for ($i = 0; $i -lt 50 -and $null -eq $proc; $i++) {
      Start-Sleep -Milliseconds 200
      $proc = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.StartTime -ge $began.AddSeconds(-2) } | Sort-Object StartTime -Descending | Select-Object -First 1
    }
    if ($null -eq $proc) { throw 'EYA:Notepad did not open a window' }
  }
  $h = $proc.MainWindowHandle
  if ([EyaWin]::IsIconic($h)) { [void][EyaWin]::ShowWindow($h, 9) }
  $wsh = New-Object -ComObject WScript.Shell
  [void]$wsh.AppActivate([int]$proc.Id)
  Start-Sleep -Milliseconds 400
  if ([EyaWin]::GetForegroundWindow() -ne $h) { [void][EyaWin]::SetForegroundWindow($h); Start-Sleep -Milliseconds 400 }
  if ([EyaWin]::GetForegroundWindow() -ne $h) { throw 'EYA:I could not bring Notepad to the front, so I typed nothing (the words could have gone to another window)' }
  [System.Windows.Forms.SendKeys]::SendWait('^{END}')
  $per = [Math]::Max(1, [int][Math]::Round($cps / 10.0))
  $delay = [int][Math]::Max(15, [Math]::Round(1000.0 * $per / $cps))
  $text = $text.Replace([string][char]13 + [string][char]10, [string][char]10)
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $typed = 0
  $p = 0
  while ($p -lt $text.Length) {
    $take = [Math]::Min($per, $text.Length - $p)
    if ($take -gt 0 -and [char]::IsHighSurrogate($text[$p + $take - 1]) -and ($p + $take) -lt $text.Length) { $take++ }
    # before every piece: Notepad must still be the window in front, or nothing more is typed
    if ([EyaWin]::GetForegroundWindow() -ne $h) { throw ('EYA:Notepad lost the focus after ' + $typed + ' characters, so I stopped typing (the rest could have gone to another window)') }
    [System.Windows.Forms.SendKeys]::SendWait((Keys-For $text.Substring($p, $take)))
    $typed += $take
    $p += $take
    Start-Sleep -Milliseconds $delay
  }
  if ($env:EYA_SAVE -eq '1') {
    if ([EyaWin]::GetForegroundWindow() -ne $h) { throw 'EYA:Notepad lost the focus, so I did not save' }
    [System.Windows.Forms.SendKeys]::SendWait('^s')
    Start-Sleep -Milliseconds 600
  }
  Out-Json @{ ok = $true; typed = $typed; seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 1); pid = [int]$proc.Id; title = [string]$proc.MainWindowTitle }
} catch {
  $m = [string]$_.Exception.Message
  if ($m.StartsWith('EYA:')) { Out-Json @{ ok = $false; why = $m.Substring(4) } } else { Out-Json @{ ok = $false; why = 'Notepad would not take the text'; detail = $m.Substring(0, [Math]::Min(160, $m.Length)) } }
}
`;

const realRun = (script: string, env: Record<string, string>, timeoutMs: number): Promise<NotepadRun> =>
  new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({ code: e === null ? 0 : typeof e.code === 'number' ? e.code : null, stdout: String(stdout), stderr: String(stderr) });
    });
  });

const failure = (summary: string, error: string, data?: Record<string, unknown>): ToolResult => ({ ok: false, summary, error, ...(data !== undefined ? { data } : {}) });

export function createNotepadTool(deps: NotepadToolDeps): Tool {
  const run = deps.run ?? realRun;
  const exists = deps.exists ?? existsSync;
  const createEmpty = deps.createEmpty ?? (async (p: string): Promise<void> => fs.writeFile(p, '', { flag: 'wx' }));
  return {
    schema: {
      name: 'notepad_write',
      status: 'Typing in Notepad…',
      description:
        'Write text in Notepad, typed LIVE so the user can watch it appear. By default a new Notepad window opens; give `path` (a .txt, .md or .log file in the user\'s own folders; it is created if it is not there) to write into that file, and `save` true to ' +
        'save it with Ctrl+S when done. mode "open" types into the Notepad window that is already open (at its end) instead. speed: slow, normal (default) or fast. About 8,000 characters at most. ' +
        'It types only when Notepad really is the window in front (otherwise it types nothing and says so): tell the user if that happens. Do it at once when the user says to write something in Notepad.',
      args: {
        text: { type: 'string', required: true, description: 'What to type. Line breaks are kept.' },
        path: { type: 'string', description: 'A text file to write in (created if missing).' },
        save: { type: 'boolean', description: 'Save with Ctrl+S after typing (needs path, or a file that is already open in Notepad).' },
        mode: { type: 'string', enum: ['new', 'open'], description: 'new (default) opens Notepad; open uses the Notepad window that is already open.' },
        speed: { type: 'string', enum: ['slow', 'normal', 'fast'] },
      },
    },
    async execute(args): Promise<ToolResult> {
      const text = typeof args['text'] === 'string' ? args['text'] : '';
      if (text === '') return failure('no text', 'There is no text to type.');
      if (text.length > MAX_CHARS) return failure('too much text', `That is too much to type live (${MAX_CHARS} characters at most).`);
      const mode = args['mode'] === 'open' ? 'open' : 'new';
      const pathIn = typeof args['path'] === 'string' ? args['path'].trim() : '';
      let path = '';
      if (pathIn !== '') {
        const check = checkPath(pathIn, deps.folders);
        if (!check.ok) return failure('not allowed', check.reason);
        if (!TEXT_EXTENSIONS.includes(extname(check.path).toLowerCase())) return failure('not a text file', `Notepad writes plain text files: ${TEXT_EXTENSIONS.join(', ')}.`);
        path = check.path;
        if (mode === 'new' && !exists(path)) {
          try {
            await createEmpty(path);
          } catch {
            return failure('could not create the file', 'I could not create that file there.');
          }
        }
      }
      const cps = SPEEDS[typeof args['speed'] === 'string' ? args['speed'] : 'normal'] ?? 30;
      const timeoutMs = Math.min(240_000, Math.ceil((text.length / cps) * 1000) + 40_000);
      const r = await run(SEND_KEYS_SCRIPT, { EYA_MODE: mode, EYA_PATH: path, EYA_TEXT: text, EYA_CPS: String(cps), EYA_SAVE: args['save'] === true ? '1' : '0' }, timeoutMs);
      let answer: Record<string, unknown> | null = null;
      try {
        answer = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? '') as Record<string, unknown>;
      } catch {
        answer = null;
      }
      if (answer === null) return failure('Notepad would not take the text', 'I could not type in Notepad (it did not answer).');
      if (answer['ok'] !== true) return failure('nothing typed', `${String(answer['why'] ?? 'Notepad would not take the text')}.`);
      return {
        ok: true,
        summary: `typed ${String(answer['typed'])} characters in Notepad${args['save'] === true ? ' and saved it' : ''}`,
        data: { typed: answer['typed'], seconds: answer['seconds'], window: answer['title'], pid: answer['pid'], ...(path !== '' ? { file: path } : {}), saved: args['save'] === true },
      };
    },
  };
}
