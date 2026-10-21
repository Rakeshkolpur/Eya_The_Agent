/**
 * Eya's icon as raw pixels (BGRA, as Electron's createFromBitmap wants), drawn in code: the same blue orb as the bubble, with a soft
 * highlight and an anti-aliased edge. No image file to ship or lose, and no dependency — and plain arithmetic, so it can be tested.
 */

const STOPS: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [0, [127, 178, 255]],
  [0.45, [76, 110, 245]],
  [1, [28, 36, 80]],
];

function colourAt(g: number): readonly [number, number, number] {
  const t = Math.min(Math.max(g, 0), 1);
  for (let i = 1; i < STOPS.length; i += 1) {
    const [p1, c1] = STOPS[i] as (typeof STOPS)[number];
    const [p0, c0] = STOPS[i - 1] as (typeof STOPS)[number];
    if (t <= p1) {
      const k = (t - p0) / (p1 - p0);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
  }
  return STOPS[STOPS.length - 1]?.[1] ?? [0, 0, 0];
}

export function iconBitmap(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const radius = size / 2 - 0.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const coverage = Math.min(Math.max(radius + 0.5 - Math.hypot(x - centre, y - centre), 0), 1);
      if (coverage === 0) continue;
      // The gradient's bright point sits up and to the left, like the orb on screen.
      const [r, g, b] = colourAt(Math.hypot(x / size - 0.3, y / size - 0.3) / 0.85);
      const at = (y * size + x) * 4;
      buf[at] = Math.round(b);
      buf[at + 1] = Math.round(g);
      buf[at + 2] = Math.round(r);
      buf[at + 3] = Math.round(coverage * 255);
    }
  }
  return buf;
}
