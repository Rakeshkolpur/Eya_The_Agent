const MAX_SPOKEN_CHARS = 420;

/**
 * Model replies are written text; they're about to be spoken. Drop markdown
 * and link syntax that would be read out as symbols, and keep it short enough
 * to listen to.
 */
export function cleanForSpeech(text: string): string {
  let t = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= MAX_SPOKEN_CHARS) return t;

  const cut = t.slice(0, MAX_SPOKEN_CHARS);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  t = stop > MAX_SPOKEN_CHARS / 2 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
  return t;
}
