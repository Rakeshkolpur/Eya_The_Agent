import { useEffect } from 'react';

/**
 * The one clock for everything that moves on screen.
 *
 * Why this exists instead of CSS animations: Eya's window is a transparent, always-on-top window, and on Windows every frame of such a
 * window is expensive to present. Measured on a small laptop (Core i3, 7.7 GB), a single looping CSS animation — even the bubble's
 * little idle "breathing", even stepped down to one visible change a second — kept the graphics process at 65-130% of a core, forever.
 * The same motion done as a few discrete changes a second from JavaScript costs 4% (2 a second) to 9% (4 a second), and with nothing
 * moving the whole app idles at about 1%.
 *
 * So nothing loops in CSS. While something is genuinely happening (listening, thinking, working, speaking, an offer waiting, a spinner)
 * it holds the clock with `useMotion(true)`; the clock then sets a few CSS variables on the page a few times a second, and the styles
 * draw each moment from them. Nothing holding it means no timer at all, and the page is perfectly still.
 *
 * Variables (all whole numbers as text, for use in calc()):
 *   --tri    0,1,2,1,0,1,2,1…     a pulse (grow, peak, shrink)
 *   --tri-a  --tri-b  --tri-c      the same pulse, each a step behind the last (for dots that ripple)
 *   --turn   0,1,2,3,0…            a quarter-turn counter (for a spinner)
 * and `data-motion="on"` on <html> while it runs (styles use it to drop transitions that would add frames between the steps).
 */

const TRIANGLE = [0, 1, 2, 1] as const;
export const MIN_RATE = 0;
export const MAX_RATE = 12;

/** What the clock needs from the page: where to put the variables, and timers. Injected so it can be tested without a browser. */
export interface MotionHost {
  readonly root: {
    readonly style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
    readonly dataset: Record<string, string | undefined>;
  };
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const VARIABLES = ['--tri', '--tri-a', '--tri-b', '--tri-c', '--turn'] as const;

export class MotionClock {
  private rate: number;
  private holders = 0;
  private step = 0;
  private timer: unknown = null;

  constructor(
    private readonly host: MotionHost,
    /** Changes per second while something holds the clock; 0 keeps everything still. */
    rate = 4,
  ) {
    this.rate = clampRate(rate);
  }

  /** A change of speed (the user's performance setting). Takes effect at once. */
  setRate(perSecond: number): void {
    this.rate = clampRate(perSecond);
    this.sync();
  }

  get currentRate(): number {
    return this.rate;
  }

  /** Whether the timer is running right now. */
  get running(): boolean {
    return this.timer !== null;
  }

  /** Something is moving. Returns what to call when it stops (calling it twice is harmless). */
  hold(): () => void {
    this.holders += 1;
    this.sync();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders -= 1;
      this.sync();
    };
  }

  private sync(): void {
    const wanted = this.holders > 0 && this.rate > 0;
    if (!wanted) {
      if (this.timer !== null) {
        this.host.clearInterval(this.timer);
        this.timer = null;
      }
      this.clearVariables();
      return;
    }
    if (this.timer !== null) this.host.clearInterval(this.timer); // the speed may have changed
    this.apply();
    this.timer = this.host.setInterval(() => {
      this.step += 1;
      this.apply();
    }, Math.round(1000 / this.rate));
  }

  private apply(): void {
    const { style, dataset } = this.host.root;
    const at = (offset: number): string => String(TRIANGLE[(this.step + offset) % TRIANGLE.length]);
    dataset['motion'] = 'on';
    style.setProperty('--tri', at(0));
    style.setProperty('--tri-a', at(0));
    style.setProperty('--tri-b', at(1));
    style.setProperty('--tri-c', at(2));
    style.setProperty('--turn', String(this.step % 4));
  }

  private clearVariables(): void {
    const { style, dataset } = this.host.root;
    delete dataset['motion'];
    for (const name of VARIABLES) style.removeProperty(name);
  }
}

function clampRate(value: number): number {
  return Number.isFinite(value) ? Math.max(MIN_RATE, Math.min(MAX_RATE, Math.round(value))) : 4;
}

let shared: MotionClock | null = null;

/** The page's clock (created when first needed, in the browser only). */
export function motionClock(): MotionClock | null {
  if (shared === null && typeof document !== 'undefined') {
    shared = new MotionClock({
      root: document.documentElement,
      setInterval: (h, ms) => window.setInterval(h, ms),
      clearInterval: (handle) => window.clearInterval(handle as number),
    });
  }
  return shared;
}

/** The user's performance setting says how fast things may move (changes per second; 0 = nothing moves). */
export function setMotionRate(perSecond: number): void {
  motionClock()?.setRate(perSecond);
}

/** Holds the clock while `active` is true. Components that show something moving call this; when none do, nothing runs. */
export function useMotion(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    return motionClock()?.hold();
  }, [active]);
}
