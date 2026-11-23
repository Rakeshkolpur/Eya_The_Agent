import { describe, expect, it } from 'vitest';
import { AFTER_WORK_QUIET_MS, QUIET_MS, STUCK_WORK_MS, answered, freshQuiet, nextQuiet, personSpoke } from '../src/renderer/talkIdle';
import type { QuietState } from '../src/renderer/talkIdle';

/**
 * "If I give Eya a task and stay silent for two or three minutes — I am doing my own work — she must not go offline." These are the rules the hands-free
 * conversation follows when it decides to end itself for being quiet.
 */

const T0 = 1_800_000_000_000;

/** Looks every two seconds for `ms`, as the page does, with the given situation; returns the state and whether it ended (and when). */
function run(from: QuietState, startAt: number, ms: number, look: { working: boolean; busy?: boolean }): { state: QuietState; endedAfter: number | null } {
  let state = from;
  for (let t = 2000; t <= ms; t += 2000) {
    const v = nextQuiet(state, { now: startAt + t, working: look.working, busy: look.busy === true });
    state = v.state;
    if (v.end) return { state, endedAfter: t };
  }
  return { state, endedAfter: null };
}

describe('with nothing being done, a quiet conversation ends after a short silence, as it always did', () => {
  it('45 seconds', () => {
    const r = run(freshQuiet(T0), T0, 5 * 60_000, { working: false });
    expect(r.endedAfter).not.toBeNull();
    expect(r.endedAfter as number).toBeGreaterThan(QUIET_MS);
    expect(r.endedAfter as number).toBeLessThanOrEqual(QUIET_MS + 2000);
  });

  it('not while she is speaking or thinking of her answer — and the silence counts from when she stopped', () => {
    const talking = run(freshQuiet(T0), T0, 10 * 60_000, { working: false, busy: true });
    expect(talking.endedAfter).toBeNull();
    const after = run(talking.state, T0 + 10 * 60_000, 5 * 60_000, { working: false });
    expect(after.endedAfter as number).toBeGreaterThan(QUIET_MS);
    expect(after.endedAfter as number).toBeLessThanOrEqual(QUIET_MS + 2000);
  });
});

describe('while she is WORKING for the person, their silence does not end it — however long', () => {
  it.each([2, 3, 10, 11, 30, 90])('%i minutes of quiet while she works', (minutes) => {
    const r = run(freshQuiet(T0), T0, minutes * 60_000, { working: true });
    expect(r.endedAfter).toBeNull();
  });

  it('and the quiet time after the work counts from when the work ended, not from when it began', () => {
    const worked = run(freshQuiet(T0), T0, 30 * 60_000, { working: true });
    const after = run(worked.state, T0 + 30 * 60_000, 10 * 60_000, { working: false });
    expect(after.endedAfter as number).toBeGreaterThan(AFTER_WORK_QUIET_MS);
    expect(after.endedAfter as number).toBeLessThanOrEqual(AFTER_WORK_QUIET_MS + 2000);
  });

  it('after work she waits two minutes for the person (who was busy), not 45 seconds', () => {
    const worked = run(freshQuiet(T0), T0, 5 * 60_000, { working: true });
    const wait = run(worked.state, T0 + 5 * 60_000, 100_000, { working: false });
    expect(wait.endedAfter).toBeNull(); // 100 s of silence after the work: still there
  });

  it('a work that starts again keeps it open again', () => {
    let state = freshQuiet(T0);
    let at = T0;
    for (let round = 0; round < 3; round += 1) {
      const worked = run(state, at, 4 * 60_000, { working: true });
      at += 4 * 60_000;
      const rested = run(worked.state, at, 60_000, { working: false });
      expect(rested.endedAfter).toBeNull();
      at += 60_000;
      state = rested.state;
    }
  });

  it('the person speaking starts a new exchange: with no new work it is the short silence again', () => {
    const worked = run(freshQuiet(T0), T0, 5 * 60_000, { working: true });
    const spoke = personSpoke(worked.state, T0 + 5 * 60_000);
    const after = run(spoke, T0 + 5 * 60_000, 5 * 60_000, { working: false });
    expect(after.endedAfter as number).toBeLessThanOrEqual(QUIET_MS + 2000);
  });

  it('an answer she has just given keeps what is known about the work (the longer wait still applies)', () => {
    const worked = run(freshQuiet(T0), T0, 5 * 60_000, { working: true });
    const said = answered(worked.state, T0 + 5 * 60_000);
    const after = run(said, T0 + 5 * 60_000, 100_000, { working: false });
    expect(after.endedAfter).toBeNull();
  });
});

describe('work that never ends', () => {
  it('after hours it is taken to be stuck, and then the conversation can end after its quiet time', () => {
    const worked = run(freshQuiet(T0), T0, STUCK_WORK_MS - 60_000, { working: true });
    expect(worked.endedAfter).toBeNull();
    const longer = run(worked.state, T0 + STUCK_WORK_MS - 60_000, 10 * 60_000, { working: true });
    expect(longer.endedAfter).not.toBeNull();
    expect(longer.endedAfter as number).toBeGreaterThan(60_000);
  });
});
