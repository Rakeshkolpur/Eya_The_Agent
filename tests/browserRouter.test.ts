import { describe, it, expect } from 'vitest';
import { SwitchingBrowserService, parseBrowserMode } from '../src/main/browser/browserRouter';
import type { BrowserMode, UserBrowser } from '../src/main/browser/browserRouter';
import type { BrowserAutomationService } from '../src/main/browser/BrowserAutomationService';
import { BrowserUnavailableError } from '../src/main/browser/errors';
import type { PageSnapshot } from '../src/main/browser/pageSnapshot';

function snap(title: string): PageSnapshot {
  return { url: 'https://site.example/', title, headings: [], links: [], buttons: [], inputs: [], dialogs: [], truncated: false };
}

function fakeBrowser(name: string, calls: string[]): UserBrowser {
  return {
    openWebsite: async () => (calls.push(`${name}:open`), snap(name)),
    inspectPage: async () => (calls.push(`${name}:inspect`), snap(name)),
    clickOnPage: async () => (calls.push(`${name}:click`), { ok: true as const, snapshot: snap(name) }),
    fillOnPage: async () => (calls.push(`${name}:fill`), { ok: true as const, snapshot: snap(name) }),
    goBack: async () => (calls.push(`${name}:back`), { ok: true as const, snapshot: snap(name) }),
    searchWeb: async () => (calls.push(`${name}:search`), []),
    close: async () => void calls.push(`${name}:close`),
    listTabs: async () => (calls.push(`${name}:tabs`), []),
    switchToTab: async () => (calls.push(`${name}:switch`), snap(name)),
  };
}

function setup(mode: BrowserMode = 'auto', connected = true) {
  const calls: string[] = [];
  const state = { connected };
  const user = fakeBrowser('user', calls);
  const eya: BrowserAutomationService = fakeBrowser('eya', calls);
  const router = new SwitchingBrowserService({ user, eya, mode, isUserBrowserConnected: () => state.connected });
  return { router, calls, state, user };
}

describe('parseBrowserMode', () => {
  it('defaults to auto and accepts only the two explicit modes', () => {
    expect(parseBrowserMode(undefined)).toBe('auto');
    expect(parseBrowserMode('')).toBe('auto');
    expect(parseBrowserMode('USER_CHROME')).toBe('user_chrome');
    expect(parseBrowserMode(' eya_browser ')).toBe('eya_browser');
    expect(parseBrowserMode('whatever')).toBe('auto');
  });
});

describe('auto mode: the user\'s own browser when it is there, otherwise Eya\'s window — and always said out loud', () => {
  it('uses the user\'s browser when it is connected', async () => {
    const { router, calls } = setup();
    const s = await router.openWebsite('https://site.example/');
    expect(calls).toEqual(['user:open']);
    expect(s.environment).toBe('your_browser');
    expect(s.notes).toBeUndefined();
  });

  it('falls back to Eya\'s own window when it is not, with a note that nothing there is signed in', async () => {
    const { router, calls } = setup('auto', false);
    const s = await router.openWebsite('https://site.example/');
    expect(calls).toEqual(['eya:open']);
    expect(s.environment).toBe('eya_browser');
    expect(s.notes?.join(' ')).toMatch(/NOT the user's signed-in browser/);
    expect(s.notes?.join(' ')).toMatch(/connect my browser/);
  });

  it('keeps a task in the browser it started in: later steps do not drift to the other one', async () => {
    const { router, calls } = setup();
    await router.openWebsite('https://site.example/');
    await router.inspectPage();
    await router.clickOnPage('x');
    await router.fillOnPage('a', 'b');
    await router.goBack();
    expect(calls).toEqual(['user:open', 'user:inspect', 'user:click', 'user:fill', 'user:back']);
  });

  it('never silently swaps browsers if the user\'s one drops out mid-task: it stops and says so', async () => {
    const { router, calls, state } = setup();
    await router.openWebsite('https://site.example/');
    state.connected = false;
    for (const act of [() => router.inspectPage(), () => router.clickOnPage('x'), () => router.fillOnPage('a', 'b'), () => router.goBack()]) {
      await expect(act()).rejects.toBeInstanceOf(BrowserUnavailableError);
      await expect(act()).rejects.toThrow(/instead of carrying on in a different browser/);
    }
    expect(calls).toEqual(['user:open']); // Eya's window was never touched
  });

  it('resumes where it was when the connection comes back', async () => {
    const { router, state } = setup();
    await router.openWebsite('https://site.example/');
    state.connected = false;
    await expect(router.inspectPage()).rejects.toBeInstanceOf(BrowserUnavailableError);
    state.connected = true;
    expect((await router.inspectPage()).environment).toBe('your_browser');
  });

  it('a new website starts a new task and picks the environment afresh', async () => {
    const { router, calls, state } = setup('auto', false);
    await router.openWebsite('https://a.example/');
    await router.inspectPage();
    expect(router.currentEnvironment()).toBe('eya_browser');
    state.connected = true; // the user connected their browser in between
    await router.inspectPage();
    expect(calls.at(-1)).toBe('eya:inspect'); // the task already under way is not yanked across
    const next = await router.openWebsite('https://b.example/');
    expect(next.environment).toBe('your_browser');
    expect(router.currentEnvironment()).toBe('your_browser');
  });

  it('looking at a page before anything was opened uses the user\'s browser if connected (what is on their screen)', async () => {
    const { router, calls } = setup();
    expect((await router.inspectPage()).environment).toBe('your_browser');
    expect(calls).toEqual(['user:inspect']);
  });

  it('stamps the environment onto action results too', async () => {
    const { router } = setup();
    await router.openWebsite('https://site.example/');
    const r = await router.clickOnPage('x');
    expect(r.snapshot.environment).toBe('your_browser');
  });
});

describe('explicit modes', () => {
  it('user_chrome: only the user\'s browser; not connected means stop, not substitute', async () => {
    const { router, calls } = setup('user_chrome', false);
    await expect(router.openWebsite('https://site.example/')).rejects.toBeInstanceOf(BrowserUnavailableError);
    await expect(router.inspectPage()).rejects.toBeInstanceOf(BrowserUnavailableError);
    expect(calls).toEqual([]);
  });

  it('eya_browser: only Eya\'s window, even when the user\'s browser is connected, with no "fell back" note', async () => {
    const { router, calls } = setup('eya_browser', true);
    const s = await router.openWebsite('https://site.example/');
    await router.clickOnPage('x');
    expect(calls).toEqual(['eya:open', 'eya:click']);
    expect(s.environment).toBe('eya_browser');
    expect(s.notes).toBeUndefined();
  });
});

describe('searching', () => {
  it('auto + connected: uses the user\'s browser; if that fails, Eya\'s window does the lookup (a results page needs no sign-in)', async () => {
    const { router, calls, user } = setup();
    await router.searchWeb('q');
    expect(calls).toEqual(['user:search']);

    calls.length = 0;
    (user as { searchWeb: BrowserAutomationService['searchWeb'] }).searchWeb = async () => {
      calls.push('user:search');
      throw new Error('tab failed');
    };
    await router.searchWeb('q');
    expect(calls).toEqual(['user:search', 'eya:search']);
  });

  it('auto + not connected, and eya_browser: Eya\'s window; user_chrome: the user\'s browser only', async () => {
    const a = setup('auto', false);
    await a.router.searchWeb('q');
    expect(a.calls).toEqual(['eya:search']);
    const b = setup('eya_browser', true);
    await b.router.searchWeb('q');
    expect(b.calls).toEqual(['eya:search']);
    const c = setup('user_chrome', true);
    await c.router.searchWeb('q');
    expect(c.calls).toEqual(['user:search']);
  });
});

describe('tabs', () => {
  it('lists and switches only in the user\'s browser, and switching moves the task there', async () => {
    const off = setup('auto', false);
    await expect(off.router.listTabs()).rejects.toBeInstanceOf(BrowserUnavailableError);
    await expect(off.router.switchToTab(1)).rejects.toBeInstanceOf(BrowserUnavailableError);

    const on = setup();
    await on.router.listTabs();
    const s = await on.router.switchToTab(5);
    expect(s.environment).toBe('your_browser');
    expect(on.router.currentEnvironment()).toBe('your_browser');
    expect(on.calls).toEqual(['user:tabs', 'user:switch']);
  });
});

describe('close', () => {
  it('closes both', async () => {
    const { router, calls } = setup();
    await router.close();
    expect(calls.sort()).toEqual(['eya:close', 'user:close']);
  });
});
