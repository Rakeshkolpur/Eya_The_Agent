/**
 * Where Eya's window goes. Pure arithmetic over rectangles (no Electron), so every placement rule can be tested:
 *
 *  - the BUBBLE: a small round window the user drags anywhere; on release it settles against the nearer side edge;
 *  - the ASSISTANT: the quick panel, which grows out of the bubble — the bubble stays exactly where it was, in the window's corner
 *    nearest the screen edge, and the panel opens away from the edge (above a low bubble, below a high one);
 *  - the APP: the full window, centred.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Which corner of the expanded window the bubble sits in. */
export type Anchor = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

/** The window around the bubble: the 64px circle plus room for its glow and badge. */
export const BUBBLE_WINDOW: Size = { width: 80, height: 80 };
/** Space kept between a settled bubble and the screen edge. */
export const EDGE_MARGIN = 6;
/** The quick assistant panel's window. */
export const ASSISTANT_WINDOW: Size = { width: 380, height: 600 };
/** The full app window at its largest; on a small screen it shrinks to fit. */
export const APP_WINDOW: Size = { width: 1120, height: 720 };
const APP_SCREEN_MARGIN = 24;

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), Math.max(lo, hi));

/** The same rectangle, moved (and if need be shrunk) so it lies fully inside `area`. */
export function clampRect(r: Rect, area: Rect): Rect {
  const width = Math.min(r.width, area.width);
  const height = Math.min(r.height, area.height);
  return { x: clamp(r.x, area.x, area.x + area.width - width), y: clamp(r.y, area.y, area.y + area.height - height), width, height };
}

/** Is any part of `r` on `area`? (Used to notice a remembered position that is now off every screen.) */
export function overlaps(r: Rect, area: Rect): boolean {
  return r.x < area.x + area.width && r.x + r.width > area.x && r.y < area.y + area.height && r.y + r.height > area.y;
}

/** Where a released bubble settles: against the nearer side edge, at the height it was let go, always fully on screen. */
export function snapToEdge(bubble: Rect, area: Rect, margin: number = EDGE_MARGIN): Rect {
  const leftSide = bubble.x + bubble.width / 2 < area.x + area.width / 2;
  const x = leftSide ? area.x + margin : area.x + area.width - bubble.width - margin;
  const y = clamp(bubble.y, area.y + margin, area.y + area.height - bubble.height - margin);
  return { ...bubble, x, y };
}

/** The bubble's first home: against the right edge, a little above the bottom. */
export function defaultBubble(area: Rect, size: Size = BUBBLE_WINDOW): Rect {
  return snapToEdge({ x: area.x + area.width, y: area.y + area.height - size.height - 96, ...size }, area);
}

/** Which corner of the expanded window the bubble belongs in: the one nearest its own corner of the screen. */
export function anchorOf(bubble: Rect, area: Rect): Anchor {
  const vertical = bubble.y + bubble.height / 2 > area.y + area.height / 2 ? 'bottom' : 'top';
  const horizontal = bubble.x + bubble.width / 2 > area.x + area.width / 2 ? 'right' : 'left';
  return `${vertical}-${horizontal}`;
}

/**
 * The expanded window: the bubble keeps EXACTLY its place, in the corner given by `anchor`, and the rest of the window opens away from
 * it. If there is not room for the whole panel on that side of the screen, the panel is made shorter (it scrolls) — the window is
 * never slid along to make it fit, because that would move the bubble every time it is opened.
 */
export function expandedBounds(bubble: Rect, size: Size, area: Rect, anchor: Anchor = anchorOf(bubble, area)): Rect {
  const right = anchor.endsWith('right');
  const below = anchor.startsWith('top'); // the bubble is at the top of the window, so the panel is below it
  const roomX = right ? bubble.x + bubble.width - area.x : area.x + area.width - bubble.x;
  const roomY = below ? area.y + area.height - bubble.y : bubble.y + bubble.height - area.y;
  const width = Math.max(bubble.width, Math.min(size.width, roomX));
  const height = Math.max(bubble.height, Math.min(size.height, roomY));
  return { x: right ? bubble.x + bubble.width - width : bubble.x, y: below ? bubble.y : bubble.y + bubble.height - height, width, height };
}

/** The bubble's own rectangle recovered from an expanded window, so closing the panel puts it back exactly where it was. */
export function bubbleWithin(expanded: Rect, anchor: Anchor, size: Size = BUBBLE_WINDOW): Rect {
  const x = anchor.endsWith('right') ? expanded.x + expanded.width - size.width : expanded.x;
  const y = anchor.startsWith('bottom') ? expanded.y + expanded.height - size.height : expanded.y;
  return { x, y, ...size };
}

/** The full app window: as large as fits (never beyond APP_WINDOW), centred on the screen. */
export function appBounds(area: Rect, size: Size = APP_WINDOW): Rect {
  const width = Math.min(size.width, area.width - APP_SCREEN_MARGIN * 2);
  const height = Math.min(size.height, area.height - APP_SCREEN_MARGIN * 2);
  return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height };
}

/** One step of the settling animation: how far along (0..1) eased out, from one rectangle's position to another's. */
export function between(from: Rect, to: Rect, t: number): Rect {
  const e = 1 - (1 - clamp(t, 0, 1)) ** 3;
  return { x: Math.round(from.x + (to.x - from.x) * e), y: Math.round(from.y + (to.y - from.y) * e), width: to.width, height: to.height };
}

/** Moves a rectangle by how far the pointer has travelled since the drag began. */
export function dragged(start: Rect, from: Point, now: Point): Rect {
  return { ...start, x: start.x + (now.x - from.x), y: start.y + (now.y - from.y) };
}
