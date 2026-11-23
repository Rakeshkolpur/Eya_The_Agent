import { describe, expect, it } from 'vitest';
import { bindToTask, inTask, pinnedHome, pinnedTab, runAsTask, runInTab } from '../src/main/browser/tabScope';

/**
 * A task of the Tasks page works in a place of its own: its browser tab and its browser. It has none when it starts, the first page it opens fixes them, and a later run of the same
 * task (a retry, the person's answer) goes on in the same place. Two tasks at once never see each other's.
 */

describe('a task has a place of its own', () => {
  it('starts with what an earlier run left, or with nothing', async () => {
    await runAsTask({ tab: null, home: null }, () => undefined, async () => {
      expect(inTask()).toBe(true);
      expect(pinnedTab()).toBeNull();
      expect(pinnedHome()).toBeNull();
    });
    await runAsTask({ tab: 7, home: 'eya' }, () => undefined, async () => {
      expect(pinnedTab()).toBe(7);
      expect(pinnedHome()).toBe('eya');
    });
    expect(inTask()).toBe(false);
  });

  it('the first page it opens fixes its place, however many awaits deep, and says so', async () => {
    const bound: Array<[number | null, string | null]> = [];
    await runAsTask({ tab: null, home: null }, (tab, home) => bound.push([tab, home]), async () => {
      await new Promise((r) => setTimeout(r, 2));
      bindToTask(12, 'eya');
      await Promise.resolve();
      expect(pinnedTab()).toBe(12);
      expect(pinnedHome()).toBe('eya');
    });
    expect(bound).toEqual([[12, 'eya']]);
  });

  it('two tasks at the same time keep their own places', async () => {
    const seen: Record<string, Array<number | null>> = { a: [], b: [] };
    const run = (name: 'a' | 'b', tab: number, wait: number) =>
      runAsTask({ tab: null, home: null }, () => undefined, async () => {
        await new Promise((r) => setTimeout(r, wait));
        bindToTask(tab, 'eya');
        await new Promise((r) => setTimeout(r, 5 - wait));
        seen[name]?.push(pinnedTab());
      });
    await Promise.all([run('a', 1, 1), run('b', 2, 3)]);
    expect(seen).toEqual({ a: [1], b: [2] });
  });

  it('binding does nothing outside a task, and a live chat scope is not a task', async () => {
    bindToTask(5, 'eya');
    expect(pinnedTab()).toBeNull();
    await runInTab(9, async () => {
      bindToTask(5, 'chrome');
      expect(pinnedTab()).toBe(9);
      expect(inTask()).toBe(false);
    }, 'eya');
  });

  it('a live chat pinned inside a task keeps its own tab', async () => {
    await runAsTask({ tab: 3, home: 'eya' }, () => undefined, async () => {
      await runInTab(77, async () => {
        expect(pinnedTab()).toBe(77);
        expect(pinnedHome()).toBe('eya');
      });
      expect(pinnedTab()).toBe(3);
    });
  });
});
