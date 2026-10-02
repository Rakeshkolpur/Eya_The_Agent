import { describe, it, expect } from 'vitest';
import { LoopGuard, pageFingerprint } from '../src/main/browser/loopGuard';
import type { PageSnapshot } from '../src/main/browser/pageSnapshot';

function snap(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com/',
    title: 'Example',
    headings: ['Welcome'],
    links: ['Home', 'Menu'],
    buttons: [],
    inputs: [],
    dialogs: [],
    truncated: false,
    ...overrides,
  };
}

describe('pageFingerprint', () => {
  it('is identical for identical pages and stable across calls', () => {
    expect(pageFingerprint(snap())).toBe(pageFingerprint(snap()));
  });

  it('changes when the url, title, or anything visible changes', () => {
    const base = pageFingerprint(snap());
    expect(pageFingerprint(snap({ url: 'https://example.com/other' }))).not.toBe(base);
    expect(pageFingerprint(snap({ title: 'Other' }))).not.toBe(base);
    // A menu expanding changes neither the url nor the title — only what is visible.
    expect(pageFingerprint(snap({ links: ['Home', 'Menu', 'Trending'] }))).not.toBe(base);
    expect(pageFingerprint(snap({ dialogs: ['Please sign in'] }))).not.toBe(base);
  });
});

describe('LoopGuard', () => {
  it('allows the first two identical attempts from the same state, and blocks the third', () => {
    const guard = new LoopGuard();
    expect(guard.isLoop('s1', 'click', 'Menu')).toBe(false);
    guard.record('s1', 'click', 'Menu');
    expect(guard.isLoop('s1', 'click', 'Menu')).toBe(false);
    guard.record('s1', 'click', 'Menu');
    expect(guard.isLoop('s1', 'click', 'Menu')).toBe(true);
  });

  it('keeps blocking: a blocked attempt is not recorded, so persistence never un-blocks it', () => {
    const guard = new LoopGuard();
    guard.record('s1', 'click', 'Menu');
    guard.record('s1', 'click', 'Menu');
    for (let i = 0; i < 5; i += 1) expect(guard.isLoop('s1', 'click', 'Menu')).toBe(true);
  });

  it('treats a different page state, action or target as a different attempt', () => {
    const guard = new LoopGuard();
    guard.record('s1', 'click', 'Menu');
    guard.record('s1', 'click', 'Menu');
    expect(guard.isLoop('s2', 'click', 'Menu')).toBe(false); // the page changed
    expect(guard.isLoop('s1', 'fill', 'Menu')).toBe(false); // a different kind of action
    expect(guard.isLoop('s1', 'click', 'Home')).toBe(false); // a different target
  });

  it('ignores case and extra whitespace in the target', () => {
    const guard = new LoopGuard();
    guard.record('s1', 'click', 'Cause   List');
    guard.record('s1', 'click', 'cause list');
    expect(guard.isLoop('s1', 'click', ' CAUSE LIST ')).toBe(true);
  });

  it('catches a cycle: returning to an already-seen page and repeating the same click', () => {
    const guard = new LoopGuard();
    // click A from s1 -> lands on s2; go back to s1; click A again ... the key is (s1, click, A) each time
    guard.record('s1', 'click', 'A');
    guard.record('s2', 'click', 'Back');
    guard.record('s1', 'click', 'A');
    guard.record('s2', 'click', 'Back');
    expect(guard.isLoop('s1', 'click', 'A')).toBe(true);
    expect(guard.isLoop('s2', 'click', 'Back')).toBe(true);
  });

  it('forgets attempts older than the time window, so asking again later is a fresh try', () => {
    let now = 1_000_000;
    const guard = new LoopGuard(() => now);
    guard.record('s1', 'click', 'Menu');
    guard.record('s1', 'click', 'Menu');
    expect(guard.isLoop('s1', 'click', 'Menu')).toBe(true);
    now += 121_000;
    expect(guard.isLoop('s1', 'click', 'Menu')).toBe(false);
  });

  it('only remembers the most recent attempts', () => {
    const guard = new LoopGuard();
    guard.record('s1', 'click', 'Menu');
    guard.record('s1', 'click', 'Menu');
    for (let i = 0; i < 12; i += 1) guard.record(`other-${i}`, 'click', 'x');
    expect(guard.isLoop('s1', 'click', 'Menu')).toBe(false);
  });
});
