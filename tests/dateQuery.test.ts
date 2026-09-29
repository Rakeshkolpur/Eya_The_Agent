import { describe, it, expect } from 'vitest';
import { parseDateOnly, resolveWhen } from '../src/main/tools/dateQuery';

// A Wednesday, so week-boundary math has something to prove.
const NOW = new Date('2026-09-30T15:00:00');

// The module works entirely in local time, so tests compare local date parts,
// not toISOString() (UTC) — this machine runs several hours ahead of UTC, and
// toISOString() on a local midnight silently shifts the calendar date back.
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('resolveWhen', () => {
  it('today is midnight to midnight tomorrow', () => {
    const r = resolveWhen('today', NOW);
    expect(ymd(r.from)).toBe('2026-09-30');
    expect(ymd(r.to)).toBe('2026-10-01');
  });

  it('yesterday is the day before today', () => {
    const r = resolveWhen('yesterday', NOW);
    expect(ymd(r.from)).toBe('2026-09-29');
    expect(ymd(r.to)).toBe('2026-09-30');
  });

  it('this_week starts on Monday and covers 7 days', () => {
    const r = resolveWhen('this_week', NOW);
    expect(r.from.getDay()).toBe(1); // Monday
    expect(ymd(r.from)).toBe('2026-09-28');
    expect((r.to.getTime() - r.from.getTime()) / 86_400_000).toBe(7);
  });

  it('last_week is the 7 days before this week', () => {
    const thisWeek = resolveWhen('this_week', NOW);
    const r = resolveWhen('last_week', NOW);
    expect(r.to.getTime()).toBe(thisWeek.from.getTime());
    expect((r.to.getTime() - r.from.getTime()) / 86_400_000).toBe(7);
  });

  it('this_month and last_month bracket the 1st correctly', () => {
    const thisMonth = resolveWhen('this_month', NOW);
    expect(ymd(thisMonth.from)).toBe('2026-09-01');
    expect(ymd(thisMonth.to)).toBe('2026-10-01');
    const lastMonth = resolveWhen('last_month', NOW);
    expect(ymd(lastMonth.from)).toBe('2026-08-01');
    expect(lastMonth.to.getTime()).toBe(thisMonth.from.getTime());
  });

  it('handles a Sunday correctly for this_week (still the same Monday-started week)', () => {
    const sunday = new Date('2026-10-04T10:00:00'); // the Sunday ending that week
    expect(sunday.getDay()).toBe(0); // sanity-check the fixture itself
    const r = resolveWhen('this_week', sunday);
    expect(ymd(r.from)).toBe('2026-09-28');
  });
});

describe('parseDateOnly', () => {
  it('parses a plain YYYY-MM-DD', () => {
    const d = parseDateOnly('2026-09-20');
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(8);
    expect(d?.getDate()).toBe(20);
  });

  it('rejects anything else rather than guessing', () => {
    for (const bad of ['2026/09/20', 'September 20', '', '2026-9-20', 'yesterday']) {
      expect(parseDateOnly(bad), bad).toBeNull();
    }
  });
});
