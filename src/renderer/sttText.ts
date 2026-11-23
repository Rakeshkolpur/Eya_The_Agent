// Whisper is trained on subtitled video, so given silence or noise it tends to
// make up the kind of thing that ends a video. Those inventions must never be
// treated as something the user said.
const HALLUCINATIONS = new Set([
  'you',
  'thank you',
  'thanks',
  'thanks for watching',
  'thank you for watching',
  'thank you so much',
  'bye',
  'goodbye',
  'the end',
  'so',
  'okay',
  'oh',
  'uh',
  'um',
  'hmm',
  'mm',
  'mhm',
]);

/**
 * Turns raw Whisper output into what was actually said, or '' if it was
 * nothing (silence, noise, a cough, an invented sign-off).
 */
export function cleanTranscript(raw: string): string {
  let text = raw
    // Sound annotations Whisper writes for non-speech: [BLANK_AUDIO], (music), *applause*, ♪ ...
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length === 0) return '';

  const words = text.toLowerCase().replace(/[.,!?;:"]+/g, ' ').split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return '';

  // A whole reply that is just one of the known inventions.
  if (HALLUCINATIONS.has(words.join(' '))) return '';

  // Decoder loops: "the the the the the", or a short phrase repeated over and over.
  if (words.length >= 6 && new Set(words).size <= 2) return '';
  if (hasRunOfRepeats(words, 5)) return '';

  // Strip stray leading punctuation left over from removed annotations.
  text = text.replace(/^[\s.,;:-]+/, '');
  return text;
}

function hasRunOfRepeats(words: readonly string[], limit: number): boolean {
  let run = 1;
  for (let i = 1; i < words.length; i += 1) {
    run = words[i] === words[i - 1] ? run + 1 : 1;
    if (run >= limit) return true;
  }
  return false;
}
