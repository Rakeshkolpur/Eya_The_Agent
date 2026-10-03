import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Real control of other applications' windows: what is open, and minimise / maximise / restore / close / focus — each
 * one done through Windows itself and confirmed by reading the window's state back, never assumed from "the request was
 * sent". Built the same way as Eya's other Windows controls: a small compiled helper run through PowerShell.
 */

export type WindowState = 'normal' | 'minimized' | 'maximized';
export type WindowAction = 'minimize' | 'maximize' | 'restore' | 'close' | 'focus';

export const WINDOW_ACTIONS: readonly WindowAction[] = ['minimize', 'maximize', 'restore', 'close', 'focus'];

export interface WindowInfo {
  /** The Windows window handle (HWND) as a number. */
  readonly handle: number;
  readonly pid: number;
  /** The process name without .exe, e.g. "chrome", "WINWORD", "ApplicationFrameHost". */
  readonly process: string;
  readonly state: WindowState;
  readonly foreground: boolean;
  readonly width: number;
  readonly height: number;
  readonly title: string;
}

export interface ActResult {
  /** The window as it is after the action, or null if it no longer exists. */
  readonly after: WindowInfo | null;
  /** Whether Windows even accepted the request (false: the window was already gone, or the helper failed). */
  readonly sent: boolean;
}

export interface WindowControl {
  /** Every visible, titled, real top-level window, frontmost first. */
  list(): Promise<readonly WindowInfo[]>;
  info(handle: number): Promise<WindowInfo | null>;
  /** Does it, then waits (up to `waitMs`) for the window to really be in the new state, and reports what it is now. */
  act(handle: number, action: WindowAction, waitMs?: number): Promise<ActResult>;
}

const HELPER = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class EyaWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);

  static string Describe(IntPtr h, IntPtr fg) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    int len = GetWindowTextLength(h);
    StringBuilder sb = new StringBuilder(len + 1);
    GetWindowText(h, sb, sb.Capacity);
    string proc = "";
    try { proc = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
    RECT r; GetWindowRect(h, out r);
    string state = IsIconic(h) ? "minimized" : (IsZoomed(h) ? "maximized" : "normal");
    string title = sb.ToString().Replace("\\t", " ").Replace("\\r", " ").Replace("\\n", " ");
    return h.ToInt64() + "\\t" + pid + "\\t" + proc + "\\t" + state + "\\t" + (h == fg ? "1" : "0") + "\\t" + (r.Right - r.Left) + "\\t" + (r.Bottom - r.Top) + "\\t" + title;
  }

  public static string List() {
    SetProcessDPIAware();
    List<string> rows = new List<string>();
    IntPtr fg = GetForegroundWindow();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      int ex = GetWindowLong(h, -20);
      if ((ex & 0x80) != 0 && (ex & 0x40000) == 0) return true; // a tool window that is not an application window
      if (GetWindowTextLength(h) == 0) return true;
      int cloaked = 0; DwmGetWindowAttribute(h, 14, out cloaked, 4);
      if (cloaked != 0) return true; // kept "visible" by Windows but never drawn (a suspended app, another virtual desktop)
      rows.Add(Describe(h, fg));
      return true;
    }, IntPtr.Zero);
    return string.Join("\\n", rows.ToArray());
  }

  public static string Info(long handle) {
    SetProcessDPIAware();
    IntPtr h = new IntPtr(handle);
    if (!IsWindow(h)) return "gone";
    return Describe(h, GetForegroundWindow());
  }

  static bool Reached(IntPtr h, string action) {
    if (action == "close") return !IsWindow(h) || !IsWindowVisible(h);
    if (!IsWindow(h)) return false;
    if (action == "minimize") return IsIconic(h);
    if (action == "maximize") return IsZoomed(h) && !IsIconic(h);
    if (action == "restore") return !IsIconic(h);
    if (action == "focus") return GetForegroundWindow() == h && !IsIconic(h);
    return false;
  }

  // Does it, then waits for the window to truly be there. Prints "sent" then the window's state (or "gone").
  public static string Act(long handle, string action, int waitMs) {
    SetProcessDPIAware();
    IntPtr h = new IntPtr(handle);
    if (!IsWindow(h)) return "gone";
    int attempts = 0;
    DateTime until = DateTime.UtcNow.AddMilliseconds(waitMs);
    while (true) {
      if (attempts == 0 || (action == "focus" && attempts % 4 == 0)) {
        if (action == "minimize") ShowWindow(h, 6);
        else if (action == "maximize") ShowWindow(h, 3);
        else if (action == "restore") ShowWindow(h, 9);
        else if (action == "close") PostMessage(h, 0x10, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE: the polite request, like the X button
        else if (action == "focus") {
          if (IsIconic(h)) ShowWindow(h, 9);
          keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); // a tap of ALT lets SetForegroundWindow through
          SetForegroundWindow(h);
        }
      }
      attempts++;
      Thread.Sleep(60);
      if (Reached(h, action) || DateTime.UtcNow > until) break;
    }
    // A closed window is gone — or hidden away (an app that keeps running in the tray): either way, not there to the user.
    if (!IsWindow(h) || (action == "close" && !IsWindowVisible(h))) return "sent\\ngone";
    return "sent\\n" + Describe(h, GetForegroundWindow());
  }
}`;

const PREFIX = `Add-Type -TypeDefinition @'${HELPER}\n'@\n`;

export function windowListScript(): string {
  return `${PREFIX}[EyaWin]::List()`;
}

export function windowInfoScript(handle: number): string {
  if (!Number.isSafeInteger(handle) || handle <= 0) throw new Error('not a window handle');
  return `${PREFIX}[EyaWin]::Info(${handle})`;
}

export function windowActScript(handle: number, action: WindowAction, waitMs: number): string {
  if (!Number.isSafeInteger(handle) || handle <= 0) throw new Error('not a window handle');
  // The action is one of a closed set (checked here), the handle and wait are numbers: nothing else can reach the script.
  if (!WINDOW_ACTIONS.includes(action)) throw new Error('not a window action');
  const wait = Math.min(10_000, Math.max(0, Math.round(waitMs)));
  return `${PREFIX}[EyaWin]::Act(${handle}, '${action}', ${wait})`;
}

/** One row of the helper's output: handle, pid, process, state, foreground, width, height, title (tab-separated). */
export function parseWindowRow(row: string): WindowInfo | null {
  const parts = row.replace(/\r/g, '').split('\t');
  if (parts.length < 8) return null;
  const [handle, pid, process, state, fg, width, height] = parts;
  const title = parts.slice(7).join(' ').trim();
  const h = Number(handle);
  const p = Number(pid);
  if (!Number.isSafeInteger(h) || h <= 0 || !Number.isSafeInteger(p) || state === undefined) return null;
  if (state !== 'normal' && state !== 'minimized' && state !== 'maximized') return null;
  return { handle: h, pid: p, process: process ?? '', state, foreground: fg === '1', width: Number(width) || 0, height: Number(height) || 0, title };
}

export function parseWindowList(stdout: string): WindowInfo[] {
  return stdout
    .split('\n')
    .map((row) => parseWindowRow(row))
    .filter((w): w is WindowInfo => w !== null);
}

export function parseActResult(stdout: string): ActResult {
  const lines = stdout.replace(/\r/g, '').split('\n').filter((l) => l.length > 0);
  if (lines[0] === 'gone') return { after: null, sent: false };
  if (lines[0] !== 'sent') return { after: null, sent: false };
  if (lines[1] === 'gone' || lines[1] === undefined) return { after: null, sent: true };
  return { after: parseWindowRow(lines[1]), sent: true };
}

export type ScriptRunner = (script: string) => Promise<string>;

const runPowerShell: ScriptRunner = async (script) => {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

export function createWindowControl(run: ScriptRunner = runPowerShell): WindowControl {
  return {
    async list() {
      return parseWindowList(await run(windowListScript()));
    },
    async info(handle) {
      const out = (await run(windowInfoScript(handle))).trim();
      return out === 'gone' || out === '' ? null : parseWindowRow(out);
    },
    async act(handle, action, waitMs = 2500) {
      return parseActResult(await run(windowActScript(handle, action, waitMs)));
    },
  };
}
