export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const CARD_WIDTH = 380;
export const CARD_MIN_HEIGHT = 80;
export const CARD_MAX_HEIGHT = 520;
const GAP = 8;

export const clampHeight = (h: number): number => Math.max(CARD_MIN_HEIGHT, Math.min(CARD_MAX_HEIGHT, Math.round(h)));

/**
 * Where the card goes: just above the bubble with its right edges lined up (the bubble lives in a corner, so that is where the user's
 * eye already is), below it when there is no room above, and always inside the screen.
 */
export function placeCard(bubble: Box | null, height: number, workArea: Box): Box {
  const h = clampHeight(height);
  const w = Math.min(CARD_WIDTH, workArea.width);
  if (bubble === null) {
    return { x: workArea.x + workArea.width - w - GAP, y: workArea.y + workArea.height - h - GAP, width: w, height: h };
  }
  let x = bubble.x + bubble.width - w;
  let y = bubble.y - h - GAP;
  if (y < workArea.y) y = bubble.y + bubble.height + GAP; // no room above
  x = Math.max(workArea.x + GAP, Math.min(x, workArea.x + workArea.width - w - GAP));
  y = Math.max(workArea.y + GAP, Math.min(y, workArea.y + workArea.height - h - GAP));
  return { x, y, width: w, height: h };
}
