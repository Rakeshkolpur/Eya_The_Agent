import { describe, it, expect } from 'vitest';
import { selectBrowser } from '../src/main/browser/browserSelection';
import type { SelectionInput } from '../src/main/browser/browserSelection';

const base: SelectionInput = { connected: ['chrome', 'edge'], tabsOnSite: [] };
const pick = (over: Partial<SelectionInput>) => selectBrowser({ ...base, ...over });

describe('which browser a piece of work belongs in', () => {
  it('nothing connected: no choice at all (the caller must start or wake a browser, out loud)', () => {
    expect(pick({ connected: [] })).toBeNull();
  });

  it('only one connected: that one', () => {
    expect(pick({ connected: ['edge'] })).toEqual({ browser: 'edge', reason: 'only_one' });
    expect(pick({ connected: ['edge'], tabsOnSite: [{ browser: 'edge', url: 'https://x.example/', active: false }] })).toEqual({ browser: 'edge', reason: 'matching_tab' });
  });

  it('the browser that already has the site open wins — that is where the user\'s session for it is', () => {
    expect(pick({ tabsOnSite: [{ browser: 'edge', url: 'https://shop.example/', active: false }], activeBrowser: 'chrome', taskBrowser: 'chrome' })).toEqual({
      browser: 'edge',
      reason: 'matching_tab',
    });
  });

  it('with the site open in both: the exact address first, then the one in front, then the task\'s browser', () => {
    const both = [
      { browser: 'chrome' as const, url: 'https://shop.example/', active: false },
      { browser: 'edge' as const, url: 'https://shop.example/orders', active: false },
    ];
    expect(pick({ tabsOnSite: both, url: 'https://shop.example/orders/' })?.browser).toBe('edge'); // exact (trailing slash aside)
    expect(
      pick({
        tabsOnSite: [
          { browser: 'chrome', url: 'https://shop.example/a', active: true },
          { browser: 'edge', url: 'https://shop.example/b', active: true },
        ],
        activeBrowser: 'edge',
        url: 'https://shop.example/zzz',
      })?.browser,
    ).toBe('edge');
    expect(pick({ tabsOnSite: both, url: 'https://shop.example/zzz', taskBrowser: 'chrome' })?.browser).toBe('chrome');
    expect(pick({ tabsOnSite: both, url: 'https://shop.example/zzz', activeBrowser: 'edge' })?.browser).toBe('edge');
    expect(pick({ tabsOnSite: both, url: 'https://shop.example/zzz' })?.browser).toBe('chrome'); // last resort among matches: Chrome first
  });

  it('with no matching tab: the task\'s browser, then the one the user is using, then their preference, then any', () => {
    expect(pick({ taskBrowser: 'edge', activeBrowser: 'chrome', preferred: 'chrome' })).toEqual({ browser: 'edge', reason: 'task' });
    expect(pick({ activeBrowser: 'edge', preferred: 'chrome' })).toEqual({ browser: 'edge', reason: 'active' });
    expect(pick({ preferred: 'edge' })).toEqual({ browser: 'edge', reason: 'preferred' });
    expect(pick({})).toEqual({ browser: 'chrome', reason: 'available' });
  });

  it('never picks a browser that is not connected, however it is ranked', () => {
    expect(pick({ connected: ['chrome'], taskBrowser: 'edge', activeBrowser: 'edge', preferred: 'edge' })).toEqual({ browser: 'chrome', reason: 'only_one' });
    expect(pick({ connected: ['chrome', 'other'], taskBrowser: 'edge', preferred: 'edge' })?.browser).toBe('chrome');
    expect(pick({ tabsOnSite: [{ browser: 'edge', url: 'https://x.example/', active: true }], connected: ['chrome', 'other'] })?.browser).toBe('chrome');
  });

  it('the spec\'s example: "continue with the site I already opened" — Chrome has the tab, Edge has unrelated tabs — picks Chrome', () => {
    expect(
      pick({
        tabsOnSite: [{ browser: 'chrome', url: 'https://mysite.example/dashboard', active: false }],
        activeBrowser: 'edge',
        url: 'https://mysite.example/',
      }),
    ).toEqual({ browser: 'chrome', reason: 'matching_tab' });
  });
});
