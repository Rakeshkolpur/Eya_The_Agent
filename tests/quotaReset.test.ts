import { describe, it, expect } from 'vitest';
import { clockPhrase, limitMessage, liveLimitMessage, nextUtcMidnight, shortWait } from '../src/shared/quotaReset';

const IST = { timeZone: 'Asia/Kolkata', locale: 'en-US' };

describe('the fallback reset moment (used only when Google names no wait)', () => {
  it('is the next midnight UTC — where a spent daily limit was measured to come back', () => {
    expect(nextUtcMidnight(new Date('2026-10-02T16:34:04Z')).toISOString()).toBe('2026-10-03T00:00:00.000Z');
    expect(nextUtcMidnight(new Date('2026-10-02T00:00:00Z')).toISOString()).toBe('2026-10-03T00:00:00.000Z');
    expect(nextUtcMidnight(new Date('2026-12-31T23:59:59Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('agrees with the measurement it came from: 26755 s after 16:34:04 UTC is the very next midnight', () => {
    const failedAt = new Date('2026-10-02T16:34:04.394Z');
    const googleSaid = 26_755_000;
    expect(Math.abs(failedAt.getTime() + googleSaid - nextUtcMidnight(failedAt).getTime())).toBeLessThan(2000);
  });
});

describe('saying it in the user\'s own time', () => {
  it('turns that moment into the clock in India: 5:30 AM', () => {
    const now = new Date('2026-10-02T16:34:04Z'); // 10:04 pm on 2 Oct in India
    expect(clockPhrase(nextUtcMidnight(now), now, IST)).toBe('5:30 AM tomorrow');
  });

  it('says "today" when it is still the same local day', () => {
    const now = new Date('2026-10-02T20:00:00Z'); // 1:30 am on 3 Oct in India
    expect(clockPhrase(nextUtcMidnight(new Date('2026-10-02T20:00:00Z')), now, IST)).toBe('5:30 AM today');
  });

  it('uses the weekday when it is further off than tomorrow', () => {
    const now = new Date('2026-10-02T15:00:00Z');
    expect(clockPhrase(new Date('2026-10-06T00:00:00Z'), now, IST)).toBe('5:30 AM on Tuesday');
  });

  it('speaks in whatever zone it is given, not the machine\'s', () => {
    const now = new Date('2026-10-02T15:00:00Z');
    const at = nextUtcMidnight(now);
    expect(clockPhrase(at, now, { timeZone: 'America/Los_Angeles', locale: 'en-US' })).toBe('5:00 PM today');
    expect(clockPhrase(at, now, { timeZone: 'UTC', locale: 'en-GB' })).toMatch(/^(0?0:00|24:00) tomorrow$/);
  });

  it('names a short wait plainly', () => {
    expect(shortWait(1)).toBe('about 1 second');
    expect(shortWait(34_000)).toBe('about 34 seconds');
    expect(shortWait(89_000)).toBe('about 89 seconds');
    expect(shortWait(90_000)).toBe('about 2 minutes');
    expect(shortWait(200_000)).toBe('about 4 minutes');
    expect(shortWait(0)).toBe('about 1 second');
  });
});

describe('what the user is told', () => {
  const now = new Date('2026-10-02T16:34:04Z'); // 10:04 pm in India

  it('daily limit with Google\'s own wait: the exact clock time it comes back, in the user\'s time', () => {
    expect(limitMessage({ daily: true, retryAfterMs: 26_755_000 }, now, IST)).toBe(
      "I've used up today's free Gemini limit, so I can't do that until it comes back at 5:30 AM tomorrow. Try again after that, or turn on billing in Google AI Studio and it works straight away.",
    );
  });

  it('daily limit when Google named no wait: says "around", not a promise', () => {
    expect(limitMessage({ daily: true }, now, IST)).toContain('comes back around 5:30 AM tomorrow');
  });

  it('a wait of a few hours is turned into a clock time, never "a few hours" — rounded up to the next whole minute', () => {
    const said = limitMessage({ daily: true, retryAfterMs: 3 * 3_600_000 }, now, IST); // 10:04:04 pm + 3 h = 1:04:04 am → 1:05
    expect(said).toContain('at 1:05 AM tomorrow');
    expect(limitMessage({ daily: true, retryAfterMs: 26_755_000 }, now, IST)).toContain('at 5:30 AM tomorrow'); // Google's 23:59:59 UTC reads as 5:30
  });

  it('a per-minute limit: the wait Google named', () => {
    expect(limitMessage({ daily: false, retryAfterMs: 34_000 }, now, IST)).toBe("I've hit Gemini's usage limit for a moment. Try again in about 34 seconds.");
  });

  it('a limit with no stated wait: both possibilities, honestly, with the daily time', () => {
    const said = limitMessage({ daily: false }, now, IST);
    expect(said).toContain('try again in about a minute');
    expect(said).toContain('daily limit, which comes back around 5:30 AM tomorrow');
  });

  it('Talk mode: gives the daily time when the reason says it is the daily limit, otherwise a short wait first', () => {
    expect(liveLimitMessage('quota exceeded for the day (daily)', now, IST)).toMatch(/used up its limit for today\. It should come back around 5:30 AM tomorrow/);
    const generic = liveLimitMessage('Resource has been exhausted (quota)', now, IST);
    expect(generic).toMatch(/usage limit right now/);
    expect(generic).toMatch(/a minute or two/);
    expect(generic).toMatch(/around 5:30 AM tomorrow/);
  });
});
