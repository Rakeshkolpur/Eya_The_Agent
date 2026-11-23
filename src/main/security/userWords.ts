import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What the person themselves just said or typed, available to whatever runs on behalf of that request (every tool call it makes). It
 * exists for one thing: a one-time verification code may be typed into a page only when the person SAID it, so the value always comes
 * from their own mouth, never from the model's guess or from anything a web page told it.
 */
const store = new AsyncLocalStorage<{ readonly text: string }>();

/** Runs `fn` (and everything it awaits) with the person's words attached. */
export function runWithUserWords<T>(text: string, fn: () => T): T {
  return store.run({ text: text.slice(0, 2000) }, fn);
}

/** The person's words for the request being worked on now, or '' when there is none. */
export function currentUserWords(): string {
  return store.getStore()?.text ?? '';
}

const DIGIT_WORDS: Readonly<Record<string, string>> = {
  zero: '0',
  oh: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

/** What was said as a list of plain pieces: spoken digits as digits ("double four" as 44), everything lower case, no punctuation. */
export function spokenTokens(said: string): string[] {
  const out: string[] = [];
  const words = said
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w !== '');
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] as string;
    const repeat = w === 'double' ? 2 : w === 'triple' ? 3 : 1;
    if (repeat > 1) {
      const next = words[i + 1];
      const digit = next === undefined ? undefined : (DIGIT_WORDS[next] ?? (/^\d$/.test(next) ? next : undefined));
      if (digit !== undefined) {
        out.push(digit.repeat(repeat));
        i += 1;
        continue;
      }
    }
    out.push(DIGIT_WORDS[w] ?? w);
  }
  return out;
}

/**
 * Whether `value` is something the person said: all of it, as one word or as a run of consecutive words or digits ("482913",
 * "482 913", "four eight two nine one three"). Only codes of 4 to 12 letters and digits qualify.
 */
export function codeWasSaid(value: string, said: string): boolean {
  const code = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (code.length < 4 || code.length > 12) return false;
  const tokens = spokenTokens(said);
  for (let start = 0; start < tokens.length; start += 1) {
    let joined = '';
    for (let end = start; end < tokens.length && joined.length < code.length; end += 1) {
      joined += tokens[end];
      if (joined === code) return true;
      if (!code.startsWith(joined)) break;
    }
  }
  return false;
}
