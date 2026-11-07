import { describe, expect, it } from 'vitest';
import { KeepAwake, MAX_HOLD_MS, trackAgentWork } from '../src/main/power/KeepAwake';
import type { PowerBlocker } from '../src/main/power/KeepAwake';

/** The PC is kept from sleeping exactly while Eya is working for the person, so she does not go offline in the middle of a job. */

class FakeBlocker implements PowerBlocker {
  started: number[] = [];
  stopped: number[] = [];
  private n = 0;
  start(kind: 'prevent-app-suspension'): number {
    expect(kind).toBe('prevent-app-suspension'); // never the display: the screen may still turn off
    this.n += 1;
    this.started.push(this.n);
    return this.n;
  }
  stop(id: number): void {
    this.stopped.push(id);
  }
  get active(): number {
    return this.started.length - this.stopped.length;
  }
}

function rig() {
  const blocker = new FakeBlocker();
  const clock = { now: 1_800_000_000_000 };
  return { blocker, clock, keep: new KeepAwake(blocker, () => clock.now) };
}

describe('KeepAwake', () => {
  it('holds the PC awake while there is work, and lets go when there is none', () => {
    const { blocker, keep } = rig();
    expect(keep.holding).toBe(false);
    keep.hold('request:a');
    expect(keep.holding).toBe(true);
    expect(blocker.active).toBe(1);
    keep.release('request:a');
    expect(keep.holding).toBe(false);
    expect(blocker.active).toBe(0);
  });

  it('two pieces of work share one hold, and one ending does not release the other', () => {
    const { blocker, keep } = rig();
    keep.hold('request:a');
    keep.hold('live:1');
    expect(blocker.started).toHaveLength(1);
    keep.release('request:a');
    expect(keep.holding).toBe(true);
    keep.release('live:1');
    expect(keep.holding).toBe(false);
  });

  it('holding again for the same work does not start another hold; releasing what was never held does nothing', () => {
    const { blocker, keep } = rig();
    keep.hold('request:a');
    keep.hold('request:a');
    keep.release('request:never');
    expect(blocker.started).toHaveLength(1);
    expect(keep.holding).toBe(true);
  });

  it('the tasks Eya keeps hold it while any is open', () => {
    const { keep } = rig();
    keep.setTasksOpen(2);
    expect(keep.holding).toBe(true);
    keep.setTasksOpen(1);
    expect(keep.holding).toBe(true);
    keep.setTasksOpen(0);
    expect(keep.holding).toBe(false);
  });

  it('work that has gone on for hours is taken to be stuck: it stops holding at the next sweep', () => {
    const { keep, clock } = rig();
    keep.hold('request:stuck');
    clock.now += MAX_HOLD_MS - 1000;
    keep.sweep();
    expect(keep.holding).toBe(true);
    clock.now += 5000;
    keep.sweep();
    expect(keep.holding).toBe(false);
  });

  it('a stuck piece of work does not release a healthy one', () => {
    const { keep, clock } = rig();
    keep.hold('request:stuck');
    clock.now += MAX_HOLD_MS + 1000;
    keep.hold('request:fresh');
    expect(keep.holding).toBe(true);
    keep.release('request:fresh');
    expect(keep.holding).toBe(false);
  });

  it('releaseAll lets go of everything (at quit)', () => {
    const { blocker, keep } = rig();
    keep.hold('a');
    keep.hold('b');
    keep.releaseAll();
    expect(keep.holding).toBe(false);
    expect(blocker.active).toBe(0);
  });
});

describe('what the agent says about its work', () => {
  it('"working" holds for that request; "thinking" keeps it; speaking or idle ends it', () => {
    const { keep } = rig();
    trackAgentWork(keep, { requestId: 'r1', state: 'working' });
    expect(keep.holding).toBe(true);
    trackAgentWork(keep, { requestId: 'r1', state: 'thinking' });
    expect(keep.holding).toBe(true);
    trackAgentWork(keep, { requestId: 'r1', state: 'speaking' });
    expect(keep.holding).toBe(false);
  });

  it('each request is its own: one finishing does not release another that is still working', () => {
    const { keep } = rig();
    trackAgentWork(keep, { requestId: 'r1', state: 'working' });
    trackAgentWork(keep, { requestId: 'r2', state: 'working' });
    trackAgentWork(keep, { requestId: 'r1', state: 'idle' });
    expect(keep.holding).toBe(true);
    trackAgentWork(keep, { requestId: 'r2', state: 'idle' });
    expect(keep.holding).toBe(false);
  });
});
