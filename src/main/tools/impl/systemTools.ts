import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rootLogger } from '@main/logging/logger';
import { permissionRequest } from '@main/permissions/PermissionManager';
import { isProcessRunning } from '@main/windowsApi/processes';
import type { Tool, ToolArgs, ToolResult } from '../types';

const execFileAsync = promisify(execFile);
const log = rootLogger.child('tools.system');

// Long enough for LogonUI.exe to actually appear after LockWorkStation returns
// (measured comfortably safe, not tuned to a minimum), short enough nobody notices.
const LOCK_VERIFY_DELAY_MS = 700;
// Gives the spoken "Done." time to finish playing before the screen actually
// goes down — the restart/shutdown itself is scheduled instantly; this is
// purely a grace window for Eya's own voice, not a "you can still cancel this"
// feature (there is no cancel tool; ordering isn't guaranteed for a voice
// round-trip to catch it in time anyway).
const POWER_ACTION_DELAY_SECONDS = 5;

/**
 * Typed, narrow Windows system controls — never a general command shell for
 * the model. Each of these is one specific, reversible, easily-verified
 * setting. Deliberately NOT here: turning Wi-Fi or Bluetooth on/off. Toggling
 * the Wi-Fi adapter risks cutting off the very machine Eya runs on, and
 * toggling Bluetooth risks dropping a wireless mouse/keyboard — both require
 * elevation on most machines besides, so a tool that usually fails silently
 * would be worse than no tool. Their Settings *pages* still open fine below;
 * flipping them is left to the user.
 */
export interface SystemControlDeps {
  openExternal(url: string): Promise<void>;
  getVolume(): Promise<{ percent: number; muted: boolean }>;
  setVolume(percent: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  /** null when this display doesn't expose software brightness control (common on desktop monitors). */
  getBrightness(): Promise<number | null>;
  setBrightness(percent: number): Promise<boolean>;
  /** Resolves true once the lock has actually been observed to take effect, not just requested. */
  lockWorkstation(): Promise<boolean>;
  /** Resolves true if Windows accepted and scheduled the restart/shutdown — the furthest "verified" can honestly go, since the machine itself is about to go away. */
  scheduleRestart(delaySeconds: number): Promise<boolean>;
  scheduleShutdown(delaySeconds: number): Promise<boolean>;
}

async function powershell(script: string): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  return stdout;
}

// A vtable-based (non-IDispatch) COM interface like IAudioEndpointVolume can't be
// called through PowerShell's own dynamic COM binder; the calls have to happen
// inside compiled IL, so every accessor is a static method on this C# helper
// rather than a method PowerShell invokes on the interface directly.
const AUDIO_HELPER_TYPE = `
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
  int f1(); int f2(); int f3(); int f4();
  int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);
  int f5();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int f6(); int f7(); int f8(); int f9();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, System.Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice { int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator { int f1(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumeratorComObject { }
public class EyaAudioHelper {
  static IAudioEndpointVolume GetVol() {
    var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev; enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
    var epGuid = typeof(IAudioEndpointVolume).GUID;
    IAudioEndpointVolume aev; dev.Activate(ref epGuid, 23, 0, out aev);
    return aev;
  }
  public static float GetVolume() { float level; GetVol().GetMasterVolumeLevelScalar(out level); return level; }
  public static void SetVolume(float level) { GetVol().SetMasterVolumeLevelScalar(level, System.Guid.Empty); }
  public static bool GetMuted() { bool m; GetVol().GetMute(out m); return m; }
  public static void SetMuted(bool m) { GetVol().SetMute(m, System.Guid.Empty); }
}
`.replace(/\r?\n/g, ' ');

function addAudioHelper(rest: string): string {
  return `Add-Type -TypeDefinition '${AUDIO_HELPER_TYPE.replace(/'/g, "''")}'; ${rest}`;
}

/**
 * The PowerShell/WMI/CoreAudio mechanisms, without `openExternal` — the
 * caller (main.ts) supplies that with Electron's own `shell.openExternal`,
 * the same one every other tool that opens something already uses, rather
 * than this module spawning its own shell process for it.
 */
export const defaultSystemControlDeps: Omit<SystemControlDeps, 'openExternal'> = {
  getVolume: async () => {
    const out = await powershell(addAudioHelper('"$([EyaAudioHelper]::GetVolume())|$([EyaAudioHelper]::GetMuted())"'));
    const [levelText, mutedText] = out.trim().split('|');
    return { percent: Math.round(Number(levelText ?? '0') * 100), muted: (mutedText ?? '').toLowerCase() === 'true' };
  },
  setVolume: async (percent) => {
    await powershell(addAudioHelper(`[EyaAudioHelper]::SetVolume(${(percent / 100).toFixed(4)})`));
  },
  setMuted: async (muted) => {
    await powershell(addAudioHelper(`[EyaAudioHelper]::SetMuted($${muted ? 'true' : 'false'})`));
  },
  getBrightness: async () => {
    try {
      const out = await powershell('(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1).CurrentBrightness');
      const value = Number(out.trim());
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  },
  setBrightness: async (percent) => {
    try {
      await powershell(
        `Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | ` +
          `Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{Timeout=0; Brightness=${Math.round(percent)}} -ErrorAction Stop`,
      );
      return true;
    } catch {
      return false;
    }
  },
  lockWorkstation: async () => {
    try {
      await execFileAsync('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true });
    } catch (err) {
      log.warn('LockWorkStation failed to launch', { err: String(err) });
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_VERIFY_DELAY_MS));
    // LogonUI.exe is the real lock-screen process — its presence is Windows'
    // own confirmation the workstation actually locked, not just that the
    // request was sent.
    return isProcessRunning('LogonUI.exe');
  },
  scheduleRestart: async (delaySeconds) => {
    try {
      // No /f: an application that refuses to close (unsaved changes) gets to
      // ask first, the same "polite, never force-kill" rule close_application
      // already follows — this can mean the restart doesn't happen until the
      // user responds to that prompt themselves, which is the point.
      await execFileAsync('shutdown.exe', ['/r', '/t', String(delaySeconds)], { windowsHide: true });
      return true;
    } catch (err) {
      log.warn('scheduling a restart failed', { err: String(err) });
      return false;
    }
  },
  scheduleShutdown: async (delaySeconds) => {
    try {
      await execFileAsync('shutdown.exe', ['/s', '/t', String(delaySeconds)], { windowsHide: true });
      return true;
    } catch (err) {
      log.warn('scheduling a shutdown failed', { err: String(err) });
      return false;
    }
  },
};

// Friendly names -> ms-settings: URI suffixes (https://learn.microsoft.com/windows/uwp/launch-resume/launch-settings-app).
const SETTINGS_PAGES: Readonly<Record<string, string>> = {
  wifi: 'network-wifi',
  bluetooth: 'bluetooth',
  display: 'display',
  sound: 'sound',
  network: 'network-status',
  personalization: 'personalization-background',
  apps: 'apps-features',
  update: 'windowsupdate-action',
  storage: 'storagesense',
  battery: 'batterysaver',
  notifications: 'notifications',
  camera: 'privacy-webcam',
  microphone: 'privacy-microphone',
};

function clampPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function createSystemTools(deps: SystemControlDeps): Tool[] {
  const openWindowsSettings: Tool = {
    schema: { name: 'open_windows_settings', status: 'Opening Settings…', description: 'Open the Windows Settings app.', args: {} },
    async execute(): Promise<ToolResult> {
      try {
        await deps.openExternal('ms-settings:');
      } catch (err) {
        return { ok: false, summary: 'could not open', error: `I could not open Settings: ${String(err)}` };
      }
      return { ok: true, summary: 'opened Settings' };
    },
  };

  const openSettingsPage: Tool = {
    schema: {
      name: 'open_settings_page',
      status: 'Opening that settings page…',
      description: 'Open a specific page of Windows Settings, e.g. Wi-Fi, Bluetooth, Display, Sound.',
      args: { page: { type: 'string', required: true, enum: Object.keys(SETTINGS_PAGES), description: 'Which settings page to open.' } },
    },
    async execute(args: ToolArgs): Promise<ToolResult> {
      const page = args['page'];
      if (typeof page !== 'string' || !(page in SETTINGS_PAGES)) {
        return { ok: false, summary: 'unknown page', error: `I don't know a settings page called "${String(page)}".` };
      }
      try {
        await deps.openExternal(`ms-settings:${SETTINGS_PAGES[page]}`);
      } catch (err) {
        return { ok: false, summary: 'could not open', error: `I could not open that settings page: ${String(err)}` };
      }
      return { ok: true, summary: `opened ${page} settings`, data: { page } };
    },
  };

  const getVolume: Tool = {
    schema: { name: 'get_volume', status: 'Checking the volume…', description: 'Read the current system volume and whether it is muted.', args: {} },
    async execute(): Promise<ToolResult> {
      try {
        const { percent, muted } = await deps.getVolume();
        return { ok: true, summary: 'read the volume', data: { percent, muted } };
      } catch (err) {
        log.warn('get_volume failed', { err: String(err) });
        return { ok: false, summary: 'could not read', error: 'I could not check the volume.' };
      }
    },
  };

  const setVolume: Tool = {
    schema: {
      name: 'set_volume',
      status: 'Adjusting the volume…',
      description: 'Set the system volume to an exact percentage (0-100).',
      args: { percent: { type: 'number', required: true, description: 'Target volume, 0-100.' } },
    },
    async execute(args: ToolArgs): Promise<ToolResult> {
      const percent = clampPercent(args['percent']);
      if (percent === null) return { ok: false, summary: 'bad value', error: 'Give a volume between 0 and 100.' };
      try {
        await deps.setVolume(percent);
        const after = await deps.getVolume();
        const verified = Math.abs(after.percent - percent) <= 2; // rounding in the OS's own scalar representation
        return {
          ok: verified,
          summary: verified ? 'set the volume' : 'volume not verified',
          data: { percent: after.percent, verification: { verified, evidence: `now at ${after.percent}%` } },
          ...(verified ? {} : { error: `I set it, but it now reads ${after.percent}%.` }),
        };
      } catch (err) {
        log.warn('set_volume failed', { err: String(err) });
        return { ok: false, summary: 'could not set', error: 'I could not change the volume.' };
      }
    },
  };

  const muteVolume: Tool = {
    schema: { name: 'mute_volume', status: 'Muting…', description: 'Mute the system volume.', args: {} },
    async execute(): Promise<ToolResult> {
      try {
        await deps.setMuted(true);
        const after = await deps.getVolume();
        return { ok: after.muted, summary: after.muted ? 'muted' : 'not verified', data: { muted: after.muted } };
      } catch (err) {
        log.warn('mute_volume failed', { err: String(err) });
        return { ok: false, summary: 'could not mute', error: 'I could not mute the volume.' };
      }
    },
  };

  const unmuteVolume: Tool = {
    schema: { name: 'unmute_volume', status: 'Unmuting…', description: 'Unmute the system volume.', args: {} },
    async execute(): Promise<ToolResult> {
      try {
        await deps.setMuted(false);
        const after = await deps.getVolume();
        return { ok: !after.muted, summary: !after.muted ? 'unmuted' : 'not verified', data: { muted: after.muted } };
      } catch (err) {
        log.warn('unmute_volume failed', { err: String(err) });
        return { ok: false, summary: 'could not unmute', error: 'I could not unmute the volume.' };
      }
    },
  };

  const getBrightness: Tool = {
    schema: { name: 'get_brightness', status: 'Checking the screen brightness…', description: 'Read the current screen brightness, if this display supports it.', args: {} },
    async execute(): Promise<ToolResult> {
      const value = await deps.getBrightness();
      if (value === null) {
        return { ok: false, summary: 'not supported', error: "This display doesn't support software brightness control." };
      }
      return { ok: true, summary: 'read the brightness', data: { percent: value } };
    },
  };

  const setBrightness: Tool = {
    schema: {
      name: 'set_brightness',
      status: 'Adjusting the brightness…',
      description: 'Set the screen brightness to an exact percentage (0-100), if this display supports it.',
      args: { percent: { type: 'number', required: true, description: 'Target brightness, 0-100.' } },
    },
    async execute(args: ToolArgs): Promise<ToolResult> {
      const percent = clampPercent(args['percent']);
      if (percent === null) return { ok: false, summary: 'bad value', error: 'Give a brightness between 0 and 100.' };
      const applied = await deps.setBrightness(percent);
      if (!applied) {
        return { ok: false, summary: 'not supported', error: "This display doesn't support software brightness control." };
      }
      const after = await deps.getBrightness();
      const verified = after !== null && Math.abs(after - percent) <= 2;
      return {
        ok: verified,
        summary: verified ? 'set the brightness' : 'brightness not verified',
        data: { percent: after, verification: { verified, evidence: after === null ? 'could not read it back' : `now at ${after}%` } },
        ...(verified ? {} : { error: 'I set it, but could not confirm the new brightness.' }),
      };
    },
  };

  const lockScreen: Tool = {
    schema: {
      name: 'lock_screen',
      status: 'Locking the screen…',
      description:
        'Actually lock the Windows workstation right now (the real lock, same as pressing Win+L) — never open Settings for this. No confirmation needed.',
      args: {},
    },
    async execute(): Promise<ToolResult> {
      const verified = await deps.lockWorkstation();
      return {
        ok: verified,
        summary: verified ? 'locked the screen' : 'lock not verified',
        data: { verification: { verified, evidence: verified ? 'the Windows lock screen is showing' : 'the lock screen did not appear' } },
        ...(verified ? {} : { error: 'I asked Windows to lock the screen, but could not confirm it actually did.' }),
      };
    },
  };

  const restartComputer: Tool = {
    schema: {
      name: 'restart_computer',
      status: 'Restarting the computer…',
      requiresConfirmation: true,
      description:
        'Actually restart the whole computer (never just open Settings/Power). This affects every running application, ' +
        "not only Eya, so it ALWAYS needs the user's explicit yes first: the first call (without confirm) does nothing " +
        'and returns exactly that question to ask. Only call again with confirm: true once the user has clearly agreed ' +
        'in this conversation. Windows will ask individual applications with unsaved work to close politely first — it ' +
        'is not forced.',
      args: { confirm: { type: 'boolean', description: 'Set true only after the user has clearly agreed to restart.' } },
    },
    async execute(args: ToolArgs): Promise<ToolResult> {
      if (args['confirm'] !== true) {
        return {
          ok: false,
          summary: 'needs confirmation',
          error: 'Do you want me to restart the computer? Anything unsaved in other apps may prompt you to save first.',
          data: permissionRequest('restart_computer', 'the computer', 'This restarts the whole machine, not just Eya.'),
        };
      }
      const scheduled = await deps.scheduleRestart(POWER_ACTION_DELAY_SECONDS);
      return {
        ok: scheduled,
        summary: scheduled ? 'restarting the computer' : 'could not schedule the restart',
        data: { verification: { verified: scheduled, evidence: scheduled ? 'Windows accepted the restart request' : 'Windows rejected the restart request' } },
        ...(scheduled ? {} : { error: 'I could not get Windows to restart the computer.' }),
      };
    },
  };

  const shutdownComputer: Tool = {
    schema: {
      name: 'shutdown_computer',
      status: 'Shutting down the computer…',
      requiresConfirmation: true,
      description:
        'Actually shut the whole computer down (never just open Settings/the Start menu). This affects every running ' +
        "application, so it ALWAYS needs the user's explicit yes first: the first call (without confirm) does nothing " +
        'and returns exactly that question to ask. Only call again with confirm: true once the user has clearly agreed ' +
        'in this conversation. Windows will ask individual applications with unsaved work to close politely first — it ' +
        'is not forced.',
      args: { confirm: { type: 'boolean', description: 'Set true only after the user has clearly agreed to shut down.' } },
    },
    async execute(args: ToolArgs): Promise<ToolResult> {
      if (args['confirm'] !== true) {
        return {
          ok: false,
          summary: 'needs confirmation',
          error: 'Do you want me to shut the computer down? Anything unsaved in other apps may prompt you to save first.',
          data: permissionRequest('shutdown_computer', 'the computer', 'This shuts down the whole machine, not just Eya.'),
        };
      }
      const scheduled = await deps.scheduleShutdown(POWER_ACTION_DELAY_SECONDS);
      return {
        ok: scheduled,
        summary: scheduled ? 'shutting down the computer' : 'could not schedule the shutdown',
        data: { verification: { verified: scheduled, evidence: scheduled ? 'Windows accepted the shutdown request' : 'Windows rejected the shutdown request' } },
        ...(scheduled ? {} : { error: 'I could not get Windows to shut the computer down.' }),
      };
    },
  };

  return [
    openWindowsSettings,
    openSettingsPage,
    getVolume,
    setVolume,
    muteVolume,
    unmuteVolume,
    getBrightness,
    setBrightness,
    lockScreen,
    restartComputer,
    shutdownComputer,
  ];
}
