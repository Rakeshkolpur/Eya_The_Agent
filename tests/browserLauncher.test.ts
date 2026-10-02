import { describe, it, expect } from 'vitest';
import { createBrowserLauncher } from '../src/main/browser/browserLauncher';

const procs = (exe: string, n: number) => Array.from({ length: n }, () => exe);

function make(opts: { installed?: string[]; processes?: string[]; launchOk?: boolean } = {}) {
  const launched: Array<[string, string]> = [];
  const launcher = createBrowserLauncher({
    findExe: async (name) => ((opts.installed ?? []).includes(name) ? `C:\\fake\\${name}` : null),
    launch: async (browser, url) => {
      launched.push([browser, url]);
      return opts.launchOk ?? true;
    },
    listProcessNames: async () => opts.processes ?? [],
  });
  return { launcher, launched };
}

describe('the user\'s normal browsers', () => {
  it('finds which of Chrome and Edge are installed, Chrome first', async () => {
    expect(await make({ installed: ['msedge.exe', 'chrome.exe'] }).launcher.installed()).toEqual(['chrome', 'edge']);
    expect(await make({ installed: ['msedge.exe'] }).launcher.installed()).toEqual(['edge']);
    expect(await make({}).launcher.installed()).toEqual([]);
  });

  it('calls a browser running only when several of its processes are (one or two are background helpers)', async () => {
    expect(await make({ processes: [...procs('chrome.exe', 9), ...procs('msedge.exe', 2), 'explorer.exe'] }).launcher.running()).toEqual(['chrome']);
    expect(await make({ processes: [...procs('CHROME.EXE', 4), ...procs('msedge.exe', 5)] }).launcher.running()).toEqual(['chrome', 'edge']);
    expect(await make({ processes: procs('chrome.exe', 1) }).launcher.running()).toEqual([]);
  });

  it('opens an address in the named browser (its normal profile — there is no profile argument at all)', async () => {
    const { launcher, launched } = make();
    expect(await launcher.launch('edge', 'https://x.example/')).toBe(true);
    expect(launched).toEqual([['edge', 'https://x.example/']]);
  });

  it('reports a browser that would not start, and will not launch "other"', async () => {
    const { launcher, launched } = make({ launchOk: false });
    expect(await launcher.launch('chrome', 'https://x.example/')).toBe(false);
    expect(await launcher.launch('other', 'https://x.example/')).toBe(false);
    expect(launched).toHaveLength(1);
  });
});
