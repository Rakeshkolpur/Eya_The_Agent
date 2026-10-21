import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_RATE, MotionClock } from '../src/renderer/motion';
import type { MotionHost } from '../src/renderer/motion';

function fakeHost() {
  const vars = new Map<string, string>();
  const dataset: Record<string, string | undefined> = {};
  const timers = new Map<number, { handler: () => void; ms: number }>();
  let next = 1;
  const host: MotionHost = {
    root: { style: { setProperty: (n, v) => void vars.set(n, v), removeProperty: (n) => void vars.delete(n) }, dataset },
    setInterval: (handler, ms) => {
      timers.set(next, { handler, ms });
      return next++;
    },
    clearInterval: (h) => void timers.delete(h as number),
  };
  const tick = (n = 1) => {
    for (let i = 0; i < n; i += 1) for (const t of [...timers.values()]) t.handler();
  };
  return { host, vars, dataset, timers, tick };
}

describe('MotionClock', () => {
  it('does nothing at all while nothing holds it', () => {
    const f = fakeHost();
    const clock = new MotionClock(f.host, 4);
    expect(clock.running).toBe(false);
    expect(f.timers.size).toBe(0);
    expect(f.vars.size).toBe(0);
    expect(f.dataset['motion']).toBeUndefined();
  });

  it('runs a few times a second while held, drawing a pulse, ripples and quarter-turns', () => {
    const f = fakeHost();
    const clock = new MotionClock(f.host, 4);
    const release = clock.hold();
    expect(clock.running).toBe(true);
    expect([...f.timers.values()].map((t) => t.ms)).toEqual([250]); // one timer, four changes a second
    expect(f.dataset['motion']).toBe('on');
    const seen: Array<[string | undefined, string | undefined, string | undefined, string | undefined]> = [];
    for (let i = 0; i < 8; i += 1) {
      seen.push([f.vars.get('--tri'), f.vars.get('--tri-b'), f.vars.get('--tri-c'), f.vars.get('--turn')]);
      f.tick();
    }
    expect(seen.map((s) => s[0])).toEqual(['0', '1', '2', '1', '0', '1', '2', '1']); // grow, peak, shrink
    expect(seen.map((s) => s[1])).toEqual(['1', '2', '1', '0', '1', '2', '1', '0']); // one step behind
    expect(seen.map((s) => s[2])).toEqual(['2', '1', '0', '1', '2', '1', '0', '1']);
    expect(seen.map((s) => s[3])).toEqual(['0', '1', '2', '3', '0', '1', '2', '3']);
    release();
  });

  it('shares one timer between everything that moves, and stops (and tidies up) when the last lets go', () => {
    const f = fakeHost();
    const clock = new MotionClock(f.host, 4);
    const a = clock.hold();
    const b = clock.hold();
    expect(f.timers.size).toBe(1);
    a();
    expect(clock.running).toBe(true);
    a(); // letting go twice is harmless
    expect(clock.running).toBe(true);
    b();
    expect(clock.running).toBe(false);
    expect(f.timers.size).toBe(0);
    expect(f.vars.size).toBe(0);
    expect(f.dataset['motion']).toBeUndefined();
  });

  it('follows the performance setting: slower, faster, or perfectly still', () => {
    const f = fakeHost();
    const clock = new MotionClock(f.host, 6);
    clock.hold();
    expect([...f.timers.values()].map((t) => t.ms)).toEqual([167]);
    clock.setRate(2);
    expect([...f.timers.values()].map((t) => t.ms)).toEqual([500]);
    clock.setRate(0);
    expect(clock.running).toBe(false);
    expect(f.vars.size).toBe(0); // still: every look falls back to its resting style
    clock.setRate(4);
    expect(clock.running).toBe(true);
    clock.setRate(1000);
    expect(clock.currentRate).toBe(MAX_RATE);
    clock.setRate(Number.NaN);
    expect(clock.currentRate).toBe(4);
    clock.setRate(-3);
    expect(clock.currentRate).toBe(0);
  });
});

describe('no CSS animation loops (the bug this replaced)', () => {
  // A looping CSS animation in Eya's transparent window kept the graphics process at 65-130% of a core, even for a 1-a-second stepped
  // one. Motion has to come from the motion clock instead. This stops one being added back by accident.
  const dir = join(__dirname, '..', 'src', 'renderer');
  const sheets = readdirSync(dir).filter((f) => f.endsWith('.css'));

  it('finds the style sheets', () => {
    expect(sheets).toContain('styles.css');
    expect(sheets).toContain('app.css');
  });

  it.each(sheets)('%s has no @keyframes and no animation property', (file) => {
    const css = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''); // comments may talk about it
    expect(css).not.toMatch(/@keyframes/);
    expect(css).not.toMatch(/(^|[;{\s])animation(-[a-z]+)?\s*:/);
  });
});
