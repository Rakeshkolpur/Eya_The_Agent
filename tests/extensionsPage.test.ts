import { describe, it, expect } from 'vitest';
import { openExtensionsPage } from '../src/main/chrome/extensionsPage';
import type { BrowserName } from '../src/main/windowsApi/appPaths';

const procs = (exe: string, n: number) => Array.from({ length: n }, () => exe);

function deps(running: string[], installed: BrowserName[]) {
  const launched: Array<[BrowserName, string]> = [];
  return {
    launched,
    d: {
      listRunningProcessNames: async () => running,
      launchBrowser: async (b: BrowserName, url: string) => {
        if (!installed.includes(b)) return false;
        launched.push([b, url]);
        return true;
      },
    },
  };
}

describe('openExtensionsPage', () => {
  it('uses the browser that is actually open', async () => {
    const { d, launched } = deps(procs('chrome.exe', 8), ['edge', 'chrome']);
    expect(await openExtensionsPage(d)).toBe('chrome');
    expect(launched).toEqual([['chrome', 'chrome://extensions/']]);
  });

  it('otherwise Edge first, then Chrome', async () => {
    const a = deps([], ['edge', 'chrome']);
    expect(await openExtensionsPage(a.d)).toBe('edge');
    expect(a.launched).toEqual([['edge', 'edge://extensions/']]);
    const b = deps([], ['chrome']);
    expect(await openExtensionsPage(b.d)).toBe('chrome');
  });

  it('never tries Firefox (the bridge is a Chromium extension), even if that is what is open', async () => {
    const { d, launched } = deps(procs('firefox.exe', 8), ['edge']);
    expect(await openExtensionsPage(d)).toBe('edge');
    expect(launched.map(([b]) => b)).toEqual(['edge']);
  });

  it('falls back to the next browser if the open one cannot be launched', async () => {
    const { d } = deps(procs('msedge.exe', 8), ['chrome']);
    expect(await openExtensionsPage(d)).toBe('chrome');
  });

  it('throws when no supported browser is installed', async () => {
    const { d } = deps([], []);
    await expect(openExtensionsPage(d)).rejects.toThrow(/Neither Edge nor Chrome/);
  });
});
