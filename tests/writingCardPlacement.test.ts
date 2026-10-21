import { describe, it, expect } from 'vitest';
import { CARD_MAX_HEIGHT, CARD_MIN_HEIGHT, CARD_WIDTH, clampHeight, placeCard } from '../src/main/writing/cardPlacement';

const screen = { x: 0, y: 0, width: 1536, height: 816 };
const bubble = { x: 1449, y: 648, width: 80, height: 80 };

describe('where the suggestion card goes', () => {
  it('above the bubble, right edges lined up (kept a small margin inside the screen)', () => {
    expect(placeCard(bubble, 200, screen)).toEqual({ x: 1536 - CARD_WIDTH - 8, y: 648 - 200 - 8, width: CARD_WIDTH, height: 200 });
    const middle = { x: 900, y: 648, width: 80, height: 80 };
    expect(placeCard(middle, 200, screen).x).toBe(900 + 80 - CARD_WIDTH); // exactly lined up when there is room
  });

  it('below the bubble when there is no room above it', () => {
    const top = { x: 600, y: 10, width: 80, height: 80 };
    expect(placeCard(top, 200, screen).y).toBe(10 + 80 + 8);
  });

  it('never leaves the screen, whatever the bubble does', () => {
    const corner = { x: -50, y: 780, width: 80, height: 80 };
    const box = placeCard(corner, 300, screen);
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.y + box.height).toBeLessThanOrEqual(816 - 8);
    expect(box.x + box.width).toBeLessThanOrEqual(1536 - 8);
  });

  it('goes to the bottom-right corner of the screen when the bubble is hidden, and works in another monitor\'s coordinates', () => {
    expect(placeCard(null, 100, screen)).toEqual({ x: 1536 - CARD_WIDTH - 8, y: 816 - 100 - 8, width: CARD_WIDTH, height: 100 });
    const second = { x: 1536, y: 0, width: 1920, height: 1040 };
    const there = placeCard({ x: 3300, y: 900, width: 80, height: 80 }, 150, second);
    expect(there.x).toBeGreaterThanOrEqual(1536);
    expect(there.x + there.width).toBeLessThanOrEqual(1536 + 1920);
  });

  it('keeps its height sensible', () => {
    expect(clampHeight(10)).toBe(CARD_MIN_HEIGHT);
    expect(clampHeight(5000)).toBe(CARD_MAX_HEIGHT);
    expect(clampHeight(212.6)).toBe(213);
  });
});
