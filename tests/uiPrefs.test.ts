import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAutoSplit, getTheme, greetingFor, setAutoSplit, setTheme } from '../src/renderer/ui/prefs';
import { loadHidden } from '../src/renderer/ui/sections';

/** A window with only the storage the page uses. */
function stubStorage(initial: Record<string, string> = {}, broken = false): Record<string, string> {
  const data = { ...initial };
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => {
        if (broken) throw new Error('blocked');
        return k in data ? (data[k] as string) : null;
      },
      setItem: (k: string, v: string) => {
        if (broken) throw new Error('blocked');
        data[k] = v;
      },
    },
  });
  return data;
}

afterEach(() => vi.unstubAllGlobals());

describe('the greeting on Home', () => {
  it('follows the hour', () => {
    expect(greetingFor(new Date(2026, 9, 22, 9))).toBe('Good Morning');
    expect(greetingFor(new Date(2026, 9, 22, 14))).toBe('Good Afternoon');
    expect(greetingFor(new Date(2026, 9, 22, 19))).toBe('Good Evening');
    expect(greetingFor(new Date(2026, 9, 22, 2))).toBe('Good Evening');
  });
});

describe('small choices about how the window looks', () => {
  it('start light, with the browser opening beside Eya', () => {
    stubStorage();
    expect(getTheme()).toBe('light');
    expect(getAutoSplit()).toBe(true);
  });

  it('are remembered', () => {
    const data = stubStorage();
    setTheme('dark');
    setAutoSplit(false);
    expect(data['eya.theme']).toBe('dark');
    expect(getTheme()).toBe('dark');
    expect(getAutoSplit()).toBe(false);
    setAutoSplit(true);
    expect(getAutoSplit()).toBe(true);
  });

  it('fall back to the defaults when the storage is blocked', () => {
    stubStorage({}, true);
    expect(getTheme()).toBe('light');
    expect(getAutoSplit()).toBe(true);
    expect(() => setTheme('dark')).not.toThrow();
  });
});

describe('which sections were hidden last time', () => {
  // when the app opens only the conversation shows: the side cards and Recent Tasks start off, and so does the Connected Apps block of the sidebar
  const START = ['aiKeys', 'connectedApps', 'popularApps', 'recentFiles', 'recentTasks', 'todayActivity'];

  it('the way the app opens, when nothing was saved: only the conversation (and the panels about a task at hand)', () => {
    stubStorage();
    expect([...loadHidden()].sort()).toEqual(START);
    expect(loadHidden().has('agentTimeline')).toBe(false);
    expect(loadHidden().has('agentList')).toBe(false);
  });

  it('what was saved, keeping only sections that exist (and the Connected Apps block hidden once, when this version opens for the first time)', () => {
    stubStorage({ 'eya.hiddenSections2': JSON.stringify(['popularApps', 'recentFiles', 'somethingOld', 7]) });
    expect([...loadHidden()].sort()).toEqual(['connectedApps', 'popularApps', 'recentFiles']);
  });

  it('a choice made after that is kept: Connected Apps switched back on stays on', () => {
    const data = stubStorage({ 'eya.hiddenSections2': JSON.stringify(['popularApps']) });
    expect(loadHidden().has('connectedApps')).toBe(true); // (first time: hidden, and written down)
    expect(JSON.parse(data['eya.hiddenSections2'] as string)).toContain('connectedApps');
    data['eya.hiddenSections2'] = JSON.stringify(['popularApps']); // the person switched it on in the Layout menu
    expect([...loadHidden()].sort()).toEqual(['popularApps']);
  });

  it('nothing saved at all: the first opening does not force it later either', () => {
    const data = stubStorage();
    expect(loadHidden().has('connectedApps')).toBe(true); // (the default)
    data['eya.hiddenSections2'] = JSON.stringify(['recentTasks']); // the person has since shown it (and the rest)
    expect([...loadHidden()].sort()).toEqual(['recentTasks']);
  });

  it('a choice saved for the first dashboard (the old key) does not decide the new layout', () => {
    stubStorage({ 'eya.hiddenSections': JSON.stringify(['agentTimeline']) });
    expect([...loadHidden()].sort()).toEqual(START);
  });

  it('the way the app opens, when the saved value is damaged or the storage is blocked', () => {
    stubStorage({ 'eya.hiddenSections2': '{not json' });
    expect([...loadHidden()].sort()).toEqual(START);
    stubStorage({ 'eya.hiddenSections2': '"popularApps"' });
    expect([...loadHidden()].sort()).toEqual(START);
    stubStorage({}, true);
    expect([...loadHidden()].sort()).toEqual(START);
  });
});
