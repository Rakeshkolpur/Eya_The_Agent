import { describe, it, expect } from 'vitest';
import {
  anchorOf,
  appBounds,
  ASSISTANT_WINDOW,
  between,
  BUBBLE_WINDOW,
  bubbleWithin,
  clampRect,
  defaultBubble,
  dragged,
  EDGE_MARGIN,
  expandedBounds,
  overlaps,
  snapToEdge,
} from '../src/main/windows/geometry';
import type { Rect } from '../src/main/windows/geometry';

// A 1366x768 laptop with the taskbar taking the bottom 40px.
const LAPTOP: Rect = { x: 0, y: 0, width: 1366, height: 728 };
// A second screen to the right of it.
const SECOND: Rect = { x: 1366, y: 0, width: 1920, height: 1040 };

const bubbleAt = (x: number, y: number): Rect => ({ x, y, ...BUBBLE_WINDOW });

describe('settling the bubble against an edge', () => {
  it('goes to the nearer side edge at the height it was let go', () => {
    expect(snapToEdge(bubbleAt(300, 200), LAPTOP)).toEqual({ x: EDGE_MARGIN, y: 200, ...BUBBLE_WINDOW });
    expect(snapToEdge(bubbleAt(900, 200), LAPTOP)).toEqual({ x: 1366 - 80 - EDGE_MARGIN, y: 200, ...BUBBLE_WINDOW });
  });

  it('the exact middle goes right, and either way it never leaves the screen', () => {
    expect(snapToEdge(bubbleAt(1366 / 2 - 40, 100), LAPTOP).x).toBe(1366 - 80 - EDGE_MARGIN);
    expect(snapToEdge(bubbleAt(-50, -80), LAPTOP)).toEqual({ x: EDGE_MARGIN, y: EDGE_MARGIN, ...BUBBLE_WINDOW });
    expect(snapToEdge(bubbleAt(5000, 5000), LAPTOP)).toEqual({ x: 1366 - 80 - EDGE_MARGIN, y: 728 - 80 - EDGE_MARGIN, ...BUBBLE_WINDOW });
  });

  it('works on a second screen with its own origin', () => {
    expect(snapToEdge(bubbleAt(1500, 300), SECOND).x).toBe(1366 + EDGE_MARGIN);
    expect(snapToEdge(bubbleAt(3000, 300), SECOND).x).toBe(1366 + 1920 - 80 - EDGE_MARGIN);
  });

  it('starts at the right edge, low on the screen but above the taskbar', () => {
    const home = defaultBubble(LAPTOP);
    expect(home.x).toBe(1366 - 80 - EDGE_MARGIN);
    expect(home.y).toBeGreaterThan(728 / 2);
    expect(home.y + home.height).toBeLessThan(728);
  });
});

describe('the quick assistant growing out of the bubble', () => {
  it('a low bubble on the right: the panel opens up and to the left, with the bubble still in the bottom-right corner', () => {
    const bubble = snapToEdge(bubbleAt(1280, 600), LAPTOP);
    expect(anchorOf(bubble, LAPTOP)).toBe('bottom-right');
    const win = expandedBounds(bubble, ASSISTANT_WINDOW, LAPTOP);
    expect(win.width).toBe(380);
    expect(win.x + win.width).toBe(bubble.x + bubble.width);
    expect(win.y + win.height).toBe(bubble.y + bubble.height);
    expect(bubbleWithin(win, 'bottom-right')).toEqual(bubble); // closing the panel puts the bubble exactly back
  });

  it('a high bubble on the left: the panel opens down and to the right', () => {
    const bubble = snapToEdge(bubbleAt(20, 40), LAPTOP);
    expect(anchorOf(bubble, LAPTOP)).toBe('top-left');
    const win = expandedBounds(bubble, ASSISTANT_WINDOW, LAPTOP);
    expect(win).toMatchObject({ x: bubble.x, y: bubble.y });
    expect(bubbleWithin(win, 'top-left')).toEqual(bubble);
  });

  it('all four corners keep the bubble where it was', () => {
    for (const [x, y] of [[10, 10], [1300, 10], [10, 640], [1300, 640]] as const) {
      const bubble = snapToEdge(bubbleAt(x, y), LAPTOP);
      const anchor = anchorOf(bubble, LAPTOP);
      const win = expandedBounds(bubble, ASSISTANT_WINDOW, LAPTOP, anchor);
      expect(bubbleWithin(win, anchor), anchor).toEqual(bubble);
      expect(win.x).toBeGreaterThanOrEqual(0);
      expect(win.y).toBeGreaterThanOrEqual(0);
      expect(win.x + win.width).toBeLessThanOrEqual(1366);
      expect(win.y + win.height).toBeLessThanOrEqual(728);
    }
  });

  it('on a short screen the panel gets shorter rather than running off it — and the bubble does not move', () => {
    const short: Rect = { x: 0, y: 0, width: 1280, height: 520 };
    const bubble = snapToEdge(bubbleAt(1200, 420), short);
    const win = expandedBounds(bubble, ASSISTANT_WINDOW, short);
    expect(win.height).toBeLessThanOrEqual(520);
    expect(win.y).toBeGreaterThanOrEqual(0);
    expect(bubbleWithin(win, anchorOf(bubble, short))).toEqual(bubble);
  });

  it('a bubble high on the screen with a tall panel: the panel is trimmed to the room below, and the bubble stays put (the bug: it used to slide up each time)', () => {
    // 824px of screen, bubble at y=348: only 476px below it, but the panel wants 600.
    const area: Rect = { x: 0, y: 0, width: 1536, height: 824 };
    const bubble = snapToEdge(bubbleAt(300, 348), area);
    const anchor = anchorOf(bubble, area);
    expect(anchor).toBe('top-left');
    const win = expandedBounds(bubble, ASSISTANT_WINDOW, area, anchor);
    expect(win.y).toBe(348);
    expect(win.height).toBe(824 - 348);
    expect(bubbleWithin(win, anchor)).toEqual(bubble);
    // Open and close it a dozen times: the bubble never drifts.
    let b = bubble;
    for (let i = 0; i < 12; i += 1) b = bubbleWithin(expandedBounds(b, ASSISTANT_WINDOW, area, anchorOf(b, area)), anchorOf(b, area));
    expect(b).toEqual(bubble);
  });

  it('wherever the bubble is left, opening and closing it returns it to exactly the same place', () => {
    for (const area of [LAPTOP, SECOND, { x: 0, y: 0, width: 1024, height: 600 }, { x: -1920, y: 0, width: 1920, height: 1040 }]) {
      for (let fx = 0; fx <= 1; fx += 0.25) {
        for (let fy = 0; fy <= 1; fy += 0.125) {
          const bubble = snapToEdge(bubbleAt(area.x + fx * area.width, area.y + fy * area.height), area);
          const anchor = anchorOf(bubble, area);
          const win = expandedBounds(bubble, ASSISTANT_WINDOW, area, anchor);
          expect(bubbleWithin(win, anchor)).toEqual(bubble);
          expect(win.x).toBeGreaterThanOrEqual(area.x);
          expect(win.y).toBeGreaterThanOrEqual(area.y);
          expect(win.x + win.width).toBeLessThanOrEqual(area.x + area.width);
          expect(win.y + win.height).toBeLessThanOrEqual(area.y + area.height);
        }
      }
    }
  });
});

describe('the full app window', () => {
  it('is centred and as large as fits', () => {
    expect(appBounds(SECOND)).toEqual({ x: 1366 + (1920 - 1120) / 2, y: (1040 - 720) / 2, width: 1120, height: 720 });
  });

  it('still fits a 1366x768 laptop with room to spare', () => {
    expect(appBounds(LAPTOP)).toEqual({ x: 123, y: 24, width: 1120, height: 680 });
  });

  it('shrinks on a small screen but keeps a margin all round', () => {
    const small: Rect = { x: 0, y: 0, width: 1024, height: 600 };
    expect(appBounds(small)).toEqual({ x: 24, y: 24, width: 976, height: 552 });
  });
});

describe('clamping, overlap, dragging and the settling animation', () => {
  it('clamps a rectangle into an area', () => {
    expect(clampRect({ x: -30, y: 900, width: 100, height: 100 }, LAPTOP)).toEqual({ x: 0, y: 628, width: 100, height: 100 });
    expect(clampRect({ x: 0, y: 0, width: 5000, height: 5000 }, LAPTOP)).toEqual({ x: 0, y: 0, width: 1366, height: 728 });
  });

  it('knows a remembered position that is now off every screen (a monitor was unplugged)', () => {
    expect(overlaps(bubbleAt(3000, 100), LAPTOP)).toBe(false);
    expect(overlaps(bubbleAt(1300, 100), LAPTOP)).toBe(true);
    expect(overlaps(bubbleAt(3000, 100), SECOND)).toBe(true);
  });

  it('moves with the pointer by how far it has travelled, not to where it is', () => {
    expect(dragged(bubbleAt(100, 100), { x: 500, y: 500 }, { x: 520, y: 470 })).toEqual(bubbleAt(120, 70));
  });

  it('eases from one place to another, ending exactly there and never overshooting', () => {
    const from = bubbleAt(400, 100);
    const to = bubbleAt(1280, 160);
    expect(between(from, to, 0)).toEqual(from);
    expect(between(from, to, 1)).toEqual(to);
    expect(between(from, to, 5)).toEqual(to);
    const half = between(from, to, 0.5);
    expect(half.x).toBeGreaterThan(from.x + (to.x - from.x) / 2); // eased out: past the halfway point already
    expect(half.x).toBeLessThan(to.x);
  });
});
