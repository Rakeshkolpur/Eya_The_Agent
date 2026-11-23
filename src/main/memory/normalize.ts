import { EYA_NAME_PATTERN } from '@shared/wake';

/**
 * Reducing what someone said to its plain form, so "Hey Eya, could you please check today's cause list for me?" and "check todays
 * cause list" are the same thing. Used for both the saved wording and the spoken wording, which is what makes an exact match
 * (one indexed lookup, no model) possible.
 */

const LEADING_FILLER: readonly RegExp[] = [
  new RegExp(`^(?:hey|hi|hello|ok|okay)\\s+${EYA_NAME_PATTERN}\\s+`),
  new RegExp(`^${EYA_NAME_PATTERN}\\s+`),
  /^(?:ok|okay|so|now|and|then)\s+/,
  /^(?:please|kindly|just)\s+/,
  /^(?:can|could|would|will)\s+you\s+(?:please\s+)?/,
  /^i\s+(?:want|need)\s+(?:you\s+)?to\s+/,
  /^i(?:'d| would)\s+like\s+(?:you\s+)?to\s+/,
  /^go\s+ahead\s+and\s+/,
  /^let'?s\s+/,
];
const TRAILING_FILLER: readonly RegExp[] = [/\s+(?:please|for me|now|right now|quickly|thanks|thank you|again)$/];
const ARTICLES = new Set(['the', 'a', 'an']);

/** The plain form of an utterance: lower case, no punctuation or apostrophes, no politeness, no articles. */
export function normalizeUtterance(raw: string): string {
  let text = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/(\p{L})'(\p{L})/gu, '$1$2') // today's -> todays, don't -> dont
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ') // marks stay: they are the vowel signs of Telugu, Hindi and the like
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 6; i += 1) {
    const before = text;
    for (const re of LEADING_FILLER) text = text.replace(re, '');
    for (const re of TRAILING_FILLER) text = text.replace(re, '');
    text = text.trim();
    if (text === before) break;
  }
  return text
    .split(' ')
    .filter((w) => w !== '' && !ARTICLES.has(w))
    .join(' ');
}

const SMALL_WORDS = new Set(['of', 'for', 'to', 'in', 'on', 'at', 'and', 'or', 'me', 'my', 'is', 'it', 'with', 'from', 'by']);

/** The words that carry meaning (no articles or small joining words). */
export function contentTokens(normalized: string): string[] {
  return normalized.split(' ').filter((w) => w !== '' && !SMALL_WORDS.has(w));
}

const MONTHS = 'january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec';
const TIME_WORDS = new Set([
  ...MONTHS.split(' '),
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'tomorrow', 'yesterday', 'tonight', 'next', 'last', 'previous', 'week', 'month', 'year', 'weekly', 'monthly', 'morning', 'evening',
  'first', 'second', 'third', 'latest', 'earlier', 'later',
]);

/**
 * Words that change WHAT is being asked rather than how it is phrased: a date, a day, "tomorrow", "next", a number. "Check today's
 * cause list" and "check tomorrow's cause list" are close in spelling and different in meaning, so a loose match must never bridge them.
 */
export function distinguishingTokens(normalized: string): string[] {
  return normalized.split(' ').filter((w) => /\d/.test(w) || TIME_WORDS.has(w)).sort();
}

/** A short, readable, stable identifier for a routine: "check_todays_cause_list". */
export function slugify(text: string, maxWords = 8): string {
  const words = normalizeUtterance(text).split(' ').filter((w) => w !== '').slice(0, maxWords);
  const slug = words.join('_').replace(/[^\p{L}\p{M}\p{N}_]/gu, '');
  return slug === '' ? 'routine' : slug;
}

/** Memory keys are compared without case or stray spacing/punctuation. */
export function normalizeKey(raw: string): string {
  return raw.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Edit distance (an adjacent swap counts as one edit), stopping early once it passes `limit` (it returns limit + 1 then). */
export function editDistance(a: string, b: string, limit = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let older = Array.from({ length: b.length + 1 }, () => 0);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      let v = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, (older[j - 2] as number) + 1);
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > limit) return limit + 1;
    older = prev;
    prev = cur;
  }
  return prev[b.length] as number;
}

/**
 * Is `b` just `a` mistyped — two neighbouring letters swapped, or one letter missing or extra? Only for words of 5+ letters, and NOT
 * for one letter changed to another ("cause" and "pause" are different words, "cuase" and "caus" are slips).
 */
export function isTypoOf(a: string, b: string): boolean {
  if (a === b || a.length < 5 || b.length < 5) return false;
  if (a.length === b.length) {
    for (let i = 0; i < a.length - 1; i += 1) {
      if (a[i] !== b[i]) return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
    }
    return false;
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  if (long.length - short.length !== 1) return false;
  for (let i = 0; i < short.length; i += 1) if (long[i] !== short[i]) return long.slice(i + 1) === short.slice(i);
  return true;
}

/** True for text that must never be put in memory: passwords, one-time codes, card numbers. */
export function looksSensitive(text: string): boolean {
  if (/\b(pass(word|code|phrase)|pwd|otp|one[- ]time (code|password)|cvv|cvc|pin|secret key|api key|private key|security code)\b/i.test(text)) return true;
  for (const run of text.match(/\b(?:\d[ -]?){13,19}\b/g) ?? []) {
    const digits = run.replace(/\D/g, '');
    let sum = 0;
    for (let i = 0; i < digits.length; i += 1) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true; // passes the card-number checksum
  }
  return false;
}
