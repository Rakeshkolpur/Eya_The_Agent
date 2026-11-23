import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * How big an application window really is, in pixels. Electron's desktop capturer scales a window's thumbnail to
 * whatever size it is asked for — UP as well as down — so a picture at the window's own size needs that size first:
 * asking for "as big as possible" returns a blurry enlargement (measured: a 1440-wide Notepad came back 7680 wide).
 */

/** The capturer names a window "window:<HWND in decimal>:<n>"; null for anything else. */
export function handleFromSourceId(id: string): number | null {
  const m = /^window:(\d+):\d+$/.exec(id);
  if (m === null) return null;
  const handle = Number(m[1]);
  return Number.isSafeInteger(handle) && handle > 0 ? handle : null;
}

const GEOMETRY_TYPE = `
using System;
using System.Runtime.InteropServices;
public static class EyaWindowGeometry {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  public static string Size(long handle) {
    // PowerShell is not DPI-aware, so without this Windows reports sizes in scaled units: at 125% a 1440-pixel window
    // reads as 1152 (measured on this PC). The capture needs real pixels.
    SetProcessDPIAware();
    RECT r;
    if (!GetWindowRect(new IntPtr(handle), out r)) return "none";
    return (r.Right - r.Left) + " " + (r.Bottom - r.Top);
  }
}`;

/** The script that prints "<width> <height>" for a window handle (a number, so nothing from outside can be injected into it). */
export function windowSizeScript(handle: number): string {
  if (!Number.isSafeInteger(handle) || handle <= 0) throw new Error('not a window handle');
  return `Add-Type -TypeDefinition @'${GEOMETRY_TYPE}\n'@\n[EyaWindowGeometry]::Size(${handle})`;
}

export interface WindowSize {
  readonly width: number;
  readonly height: number;
}

/** "1440 748" -> a size; anything else (including "none" and absurd numbers) -> null. */
export function parseWindowSize(stdout: string): WindowSize | null {
  const m = /^\s*(\d+) (\d+)\s*$/.exec(stdout);
  if (m === null) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width >= 1 && height >= 1 && width <= 16_384 && height <= 16_384 ? { width, height } : null;
}

export type ScriptRunner = (script: string) => Promise<string>;

const runPowerShell: ScriptRunner = async (script) => {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000 });
  return stdout;
};

/** The real size of the window a capture source stands for, or null if it cannot be found out (the caller then falls back). */
export async function queryWindowSize(sourceId: string, run: ScriptRunner = runPowerShell): Promise<WindowSize | null> {
  const handle = handleFromSourceId(sourceId);
  if (handle === null) return null;
  try {
    return parseWindowSize(await run(windowSizeScript(handle)));
  } catch {
    return null;
  }
}
