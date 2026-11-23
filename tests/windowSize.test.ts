import { describe, it, expect } from 'vitest';
import { handleFromSourceId, parseWindowSize, queryWindowSize, windowSizeScript } from '../src/main/screen/windowSize';

describe('which window a capture source is', () => {
  it('reads the window handle out of the id the capturer gives', () => {
    expect(handleFromSourceId('window:132532:0')).toBe(132532);
    expect(handleFromSourceId('window:1:12')).toBe(1);
  });

  it('is null for anything that is not a window id (a screen, junk, an injection attempt)', () => {
    for (const id of ['screen:0:0', 'window:abc:0', 'window:0:0', 'window:12', 'window:12:0; calc', '', 'window:99999999999999999999:0', 'xwindow:5:0']) {
      expect(handleFromSourceId(id), id).toBeNull();
    }
  });
});

describe('asking Windows for a window\'s size', () => {
  it('builds a script around the handle as a plain number — nothing else can get into it', () => {
    const script = windowSizeScript(132532);
    expect(script).toContain('[EyaWindowGeometry]::Size(132532)');
    expect(script).toContain('GetWindowRect');
    // PowerShell is not DPI-aware: without this, a 1440-pixel window reads as 1152 at 125% scaling (measured), and the picture comes out soft.
    expect(script).toContain('SetProcessDPIAware');
    expect(script.indexOf('SetProcessDPIAware();')).toBeLessThan(script.indexOf('GetWindowRect(new IntPtr'));
    expect(script.startsWith("Add-Type -TypeDefinition @'")).toBe(true);
    expect(script).toContain("\n'@\n"); // the here-string closes at the start of a line, as PowerShell needs
    expect(() => windowSizeScript(0)).toThrow();
    expect(() => windowSizeScript(-5)).toThrow();
    expect(() => windowSizeScript(1.5)).toThrow();
    expect(() => windowSizeScript(Number.NaN)).toThrow();
  });

  it('reads "width height", and refuses anything else', () => {
    expect(parseWindowSize('1440 748\r\n')).toEqual({ width: 1440, height: 748 });
    expect(parseWindowSize('  800 600  ')).toEqual({ width: 800, height: 600 });
    for (const bad of ['none', '', '0 100', '100 0', '99999 100', '1440x748', '1440 748 3', 'error', '-5 100']) {
      expect(parseWindowSize(bad), bad).toBeNull();
    }
  });

  it('runs the script for the matching handle and returns the size', async () => {
    const seen: string[] = [];
    const size = await queryWindowSize('window:777:0', async (script) => {
      seen.push(script);
      return '1280 720\r\n';
    });
    expect(size).toEqual({ width: 1280, height: 720 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('Size(777)');
  });

  it('is null — so the caller falls back — when the id is not a window, PowerShell fails, or it prints nonsense', async () => {
    const never = async () => {
      throw new Error('should not run');
    };
    expect(await queryWindowSize('screen:0:0', never)).toBeNull();
    expect(
      await queryWindowSize('window:5:0', async () => {
        throw new Error('powershell.exe is blocked');
      }),
    ).toBeNull();
    expect(await queryWindowSize('window:5:0', async () => 'none')).toBeNull();
  });
});
