/**
 * Eya never states a phone number that came from nowhere. A model asked "what is Anna's number?" with no contact in front of it will happily
 * write one (a Groq model answered "+1 800 234 5678"); said aloud, that reads as a fact about a real person. A number in an answer is only
 * allowed when it is in something Eya really had in front of her in this request: what the person said, an earlier line of the conversation,
 * or what a tool returned (a contact in the app, a page, a file). Any other number is taken out of the answer, and the answer says so.
 */

const CANDIDATE = /(?<![\w+])(\+?\d[\d\s().-]{6,}\d)(?![\w])/g;
const DATE_LIKE = /^\d{1,4}[-./]\d{1,2}[-./]\d{1,4}$/;
const TIME_LIKE = /^\d{1,2}:\d{2}(?::\d{2})?$/;

const digitsOf = (s: string): string => s.replace(/\D/g, '');

/** The part of a number that identifies it, whatever country code or leading zero it was written with. */
function tailOf(digits: string): string {
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** The phone-number-like pieces of a text: 10 or more digits, or a number with a "+" and 8 or more (never a date, a time or a short figure). */
export function phoneNumbersIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(CANDIDATE)) {
    const raw = (m[1] as string).trim();
    if (DATE_LIKE.test(raw) || TIME_LIKE.test(raw)) continue;
    const digits = digitsOf(raw);
    if (digits.length >= 10 || (raw.startsWith('+') && digits.length >= 8)) found.push(raw);
  }
  return found;
}

/** The numbers in `answer` that appear in none of `sources`. */
export function unverifiedNumbers(answer: string, sources: readonly string[]): string[] {
  const known = sources.map(digitsOf).filter((d) => d.length >= 7);
  return phoneNumbersIn(answer).filter((n) => {
    const tail = tailOf(digitsOf(n));
    return !known.some((d) => d.includes(tail));
  });
}

export const NUMBER_NOTE = "I don't have a verified phone number for that contact, so I haven't given one: I only use numbers from your own contacts or ones you tell me.";

/** The answer with every number that was not in the sources taken out, and (once) why. Unchanged when all its numbers are real. */
export function withoutInventedNumbers(answer: string, sources: readonly string[]): { readonly text: string; readonly removed: number } {
  const bad = unverifiedNumbers(answer, sources);
  if (bad.length === 0) return { text: answer, removed: 0 };
  let text = answer;
  for (const n of bad) text = text.split(n).join('[number removed]');
  return { text: `${text.trimEnd()} ${NUMBER_NOTE}`, removed: bad.length };
}
