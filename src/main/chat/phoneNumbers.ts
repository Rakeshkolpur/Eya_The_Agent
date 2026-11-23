import { isSupportedCountry, parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type { CountryCode } from 'libphonenumber-js/max';

/**
 * Phone numbers the way people really give them: with or without a country code, with spaces, hyphens and brackets, as only the last few digits, in
 * the digits of another script (Telugu, Hindi), or read out ("nine three six double one three nine zero zero"). A number is read by libphonenumber-js
 * against the user's configured COUNTRY, and a country code is only ever added when the number is a valid number of that country: a number that
 * fits nowhere is left as the person gave it, never "fixed" into somebody else's.
 *
 * Pure: no page, no app. The recipient resolver (recipientResolver.ts) is built on it.
 */

export interface CountryContext {
  /** ISO 3166-1 alpha-2 ("IN"): what a number with no country code is taken to be a number of. */
  readonly region: CountryCode;
}

/** India, until the person chooses another country in Settings. */
export const DEFAULT_COUNTRY: CountryContext = { region: 'IN' };

/** The country context for a saved setting; India when it is missing or not a country that can be read. */
export function countryContext(setting: string | null | undefined): CountryContext {
  const code = typeof setting === 'string' ? setting.trim().toUpperCase() : '';
  return code.length === 2 && isSupportedCountry(code) ? { region: code as CountryCode } : DEFAULT_COUNTRY;
}

export type PhoneKind =
  /** Written with its country code ("+91 9361113900", "0091 …", "91 9361113900"). */
  | 'international'
  /** A valid number of the configured country written without a code ("9361113900", "09361113900"). */
  | 'national'
  /** Only some of the digits ("ending 3900", "the last 4 digits 3900"). */
  | 'partial'
  /** Digits that read as a number but fit no country's rules (a country code is NOT added to them). */
  | 'unclear';

export type DigitMode = 'ends' | 'starts' | 'any';

export interface PhoneReading {
  readonly kind: PhoneKind;
  /** The digits as given (after reading out loud and other scripts are turned into 0-9), with no country code added. */
  readonly digits: string;
  /** The whole number with its country code, digits only ("919361113900"); only for `international` and `national`. */
  readonly e164?: string;
  /** The number without its country code ("9361113900"); only for `international` and `national`. */
  readonly national?: string;
  /** The country the number belongs to ("IN"). */
  readonly region?: string;
  /** What kind of line it is, when the library says ("MOBILE", "FIXED_LINE"). */
  readonly lineType?: string;
  /** The country code came from the configured country, not from the person. */
  readonly countryAssumed: boolean;
  /** Said out loud, in words or in another script. */
  readonly spoken: boolean;
  /** Which part of a number the digits of a `partial` are ("ending", "starting" or anywhere in it). */
  readonly mode: DigitMode;
  /** In a few words, how the number was read (for the person when something has to be asked, and for the log). */
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------- digits in other forms
/** A decimal digit of any script (Devanagari, Telugu, Arabic-Indic…) as 0-9. Anything else is returned as it is. */
function asciiDigit(ch: string): string {
  if (/[0-9]/.test(ch)) return ch;
  if (!/^\p{Nd}$/u.test(ch)) return ch;
  // the digits of a script sit together in blocks of ten starting at its zero: how far this one is from the start of its run is its value
  const here = ch.codePointAt(0) as number;
  let start = here;
  while (start > 0 && /^\p{Nd}$/u.test(String.fromCodePoint(start - 1))) start -= 1;
  return String((here - start) % 10);
}

export function foldDigits(text: string): string {
  return Array.from(text.normalize('NFKC'), asciiDigit).join('');
}

const WORD_DIGIT: Readonly<Record<string, string>> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};
const MULTIPLIER: Readonly<Record<string, number>> = { double: 2, triple: 3, treble: 3, quadruple: 4 };
// Words that say a number is coming: "ending three nine zero zero", "number nine three six…", "digits …".
const NUMBER_CUE = /^(?:ending|ends?|ended|last|starting|starts?|begins?|beginning|number|digits?|phone|mobile|contact|no|num|plus)$/;

const bare = (token: string | undefined): string => (token ?? '').toLowerCase().replace(/[,.;:]+$/, '');

/** One spoken digit ("nine") or a doubled one ("double nine") at tokens[j]: its digits and how many words it took, or null. */
export function spokenDigitAt(tokens: readonly string[], j: number): { readonly digits: string; readonly used: number } | null {
  const t = bare(tokens[j]);
  const next = bare(tokens[j + 1]);
  const multiplier = MULTIPLIER[t];
  if (multiplier !== undefined && (WORD_DIGIT[next] !== undefined || /^\d$/.test(next))) return { digits: (WORD_DIGIT[next] ?? next).repeat(multiplier), used: 2 };
  const one = WORD_DIGIT[t];
  return one === undefined ? null : { digits: one, used: 1 };
}

interface SpokenRun {
  readonly start: number;
  readonly end: number;
  readonly digits: string;
}

/**
 * Runs of digits that were READ OUT ("nine three six one one one three nine zero zero", "double nine", "triple five"). Only a run that is long enough to be a phone
 * number (seven digits or more), or that comes right after a word that says a number is coming ("ending three nine zero zero"), is a number: "one two three"
 * in the middle of a message is left alone.
 */
function spokenRuns(tokens: readonly string[]): SpokenRun[] {
  const runs: SpokenRun[] = [];
  let i = 0;
  while (i < tokens.length) {
    let j = i;
    let digits = '';
    while (j < tokens.length) {
      const said = spokenDigitAt(tokens, j);
      const t = bare(tokens[j]);
      if (said !== null) {
        digits += said.digits;
        j += said.used;
      } else if (digits !== '' && /^\d+$/.test(t)) {
        // (digits written beside digits said: "nine three six 11139 zero zero")
        digits += t;
        j += 1;
      } else break;
    }
    if (j > i) {
      const before = bare(tokens[i - 1]);
      if (digits.length >= 7 || (digits.length >= 3 && NUMBER_CUE.test(before))) runs.push({ start: i, end: j, digits });
      i = j;
    } else i += 1;
  }
  return runs;
}

/** The text with every number that was read out turned into digits; text that has none is returned unchanged. */
export function spokenNumbersToDigits(text: string): string {
  const tokens = text.split(/\s+/).filter((t) => t !== '');
  const runs = spokenRuns(tokens);
  if (runs.length === 0) return text;
  const out: string[] = [];
  let at = 0;
  for (const run of runs) {
    out.push(...tokens.slice(at, run.start), run.digits);
    at = run.end;
  }
  out.push(...tokens.slice(at));
  return out.join(' ');
}

// ---------------------------------------------------------------------------------------------------------------- reading a number
const FILLER = /\b(?:the|a|an|of|is|in|with|whose|at|which|has|have|number|numbers|no\.?|num|phone|mobile|contact|digits?|ending|ends?|ended|last|starting|starts?|begins?|beginning)\b/gi;

function modeOf(text: string): DigitMode {
  const lower = text.toLowerCase();
  if (/\b(?:ending|ends?|ended|last)\b/.test(lower)) return 'ends';
  if (/\b(?:starting|starts?|begins?|beginning)\b/.test(lower)) return 'starts';
  return 'any';
}

/**
 * What a phone-number-like reference is: the number it names, in full when it can be, and how sure the reading is. Null when the words are not about a number
 * at all (a name, a nickname, "him"). A country code is added from the configured country only when the digits are a VALID number of that country; a number
 * that is not valid there is `unclear` and keeps exactly the digits it was given.
 */
export function readPhoneReference(text: string, country: CountryContext = DEFAULT_COUNTRY): PhoneReading | null {
  const original = text.trim();
  if (original === '') return null;
  const readOut = spokenNumbersToDigits(original);
  // "plus nine one …" is a "+" said out loud
  const ascii = foldDigits(readOut);
  const spoken = readOut !== original || ascii !== readOut.normalize('NFKC');
  const folded = ascii.replace(/\bplus\s+(?=\d)/gi, '+');
  const mode = modeOf(folded);
  // What is left once the words that only introduce a number are taken away ("the last 4 digits of …": that 4 is a count, not a digit of the number)
  // must be nothing but the number's own characters.
  const bare = folded
    .replace(/\b(?:last|first|final)\s+(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+digits?\b/gi, ' ')
    .replace(FILLER, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/^\+?[\d\s().\-/]+$/.test(bare)) return null;
  const digits = bare.replace(/\D/g, '');
  if (digits.length < 2) return null;
  const plus = bare.startsWith('+');
  const notes: string[] = [];
  if (digits.length > 15) return { kind: 'unclear', digits, countryAssumed: false, spoken, mode: 'any', notes: ['more digits than any phone number has'] };

  // A whole number: ten digits or more.
  if (digits.length >= 10) {
    const explicit = plus || digits.startsWith('00');
    const given = explicit ? (digits.startsWith('00') && !plus ? `+${digits.slice(2)}` : `+${digits}`) : bare;
    const parsed = parsePhoneNumberFromString(given, explicit ? undefined : country.region);
    if (parsed?.isValid() === true) {
      const e164 = parsed.number.slice(1);
      const national = parsed.nationalNumber;
      // Was the country code written by the person? Without a "+", it was when the digits already start with it ("919361113900"), and added when not.
      const wrote = explicit || digits === e164 || digits === `00${e164}`;
      if (!wrote) notes.push(`read as a number of ${parsed.country ?? country.region}: the country code +${parsed.countryCallingCode} was added from your settings`);
      const lineType = parsed.getType();
      if (lineType !== undefined && lineType !== 'MOBILE' && lineType !== 'FIXED_LINE_OR_MOBILE') notes.push('a landline number, not a mobile one');
      return {
        kind: wrote ? 'international' : 'national',
        digits,
        e164,
        national,
        ...(parsed.country !== undefined ? { region: parsed.country } : {}),
        ...(lineType !== undefined ? { lineType } : {}),
        countryAssumed: !wrote,
        spoken,
        mode: 'any',
        notes,
      };
    }
    notes.push(explicit ? 'not a valid number for that country code' : `not a valid ${country.region} number, so no country code was added`);
    return { kind: 'unclear', digits, countryAssumed: false, spoken, mode: 'any', notes };
  }

  // Part of a number.
  return { kind: 'partial', digits, countryAssumed: false, spoken, mode, notes: [`${digits.length} digits only`] };
}

/**
 * A whole phone number in the words a person said, as digits with its country code ("919361113900") — or null when the words are not a whole number the
 * configured country can read. A number that is not valid is NOT given a country code (it used to be given India's 91 whatever it was).
 */
export function phoneDigitsOf(text: string, country: CountryContext = DEFAULT_COUNTRY): string | null {
  const reading = readPhoneReference(text, country);
  return reading !== null && (reading.kind === 'international' || reading.kind === 'national') ? (reading.e164 ?? null) : null;
}

// ---------------------------------------------------------------------------------------------------------------- showing a number
/** A number with all but its last four digits hidden ("+91 ••••••3900"), for asking which of two it is without reading a whole number out. */
export function maskNumber(digits: string): string {
  const d = digits.replace(/\D/g, '');
  if (d.length < 5) return d === '' ? '' : `••••${d.slice(-2)}`;
  const parsed = parsePhoneNumberFromString(`+${d}`);
  const code = parsed?.isValid() === true ? parsed.countryCallingCode : undefined;
  const rest = code !== undefined ? d.slice(String(code).length) : d;
  const hidden = '•'.repeat(Math.max(2, rest.length - 4));
  return `${code !== undefined ? `+${code} ` : ''}${hidden}${rest.slice(-4)}`;
}

/** The phone-number-like run in a chat's name or detail (an unsaved contact is shown as its number): its digits, or null. */
export function numberShownIn(text: string): string | null {
  for (const run of text.normalize('NFKC').match(/\+?\d[\d\s().-]{5,}\d/g) ?? []) {
    const d = foldDigits(run).replace(/\D/g, '');
    if (d.length >= 8 && d.length <= 15) return d;
  }
  return null;
}
