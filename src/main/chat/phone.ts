import { DEFAULT_COUNTRY, foldDigits, phoneDigitsOf, readPhoneReference, spokenDigitAt } from './phoneNumbers';
import type { CountryContext } from './phoneNumbers';

/**
 * Phone numbers in the words a person says or types them. Shared by the request parser (a number can be who a message is for) and by the
 * chat commands (a number is looked for exactly, and opens the installed app's own link). The reading itself — country, spaces, hyphens, other
 * scripts, digits said out loud — is phoneNumbers.ts.
 */

/**
 * A whole phone number in the words the person said ("98765 43210", "+91 98765-43210", "09876543210", "nine eight seven…") as digits with its country
 * code, or null when the words are not a whole number the country can read. A country code is added only to a number that is valid in the configured
 * country (India until another is chosen): a number that fits nowhere is not turned into somebody else's.
 */
export function phoneDigits(text: string, country: CountryContext = DEFAULT_COUNTRY): string | null {
  return phoneDigitsOf(text, country);
}

/**
 * "98765 43210 I am late" -> the number and the message, when the words start with a whole phone number (digits, or numbers read out); null otherwise.
 * The message is returned exactly as it was said (its own spacing and all). A whole number that is not valid is still the recipient — the person is then
 * told so — rather than being taken for a name.
 */
export function splitPhone(rest: string, country: CountryContext = DEFAULT_COUNTRY): { name: string; text: string } | null {
  const text = rest.trim();
  const tokens = [...text.matchAll(/\S+/g)].map((m) => ({ word: m[0], at: m.index ?? 0 }));
  const words = tokens.map((t) => t.word);
  let digits = 0;
  let k = 0;
  while (k < tokens.length && digits < 10) {
    const word = foldDigits(words[k] as string);
    if (/^[+\d().-]+$/.test(word)) {
      digits += word.replace(/\D/g, '').length;
      k += 1;
      continue;
    }
    if (k === 0 && /^plus$/i.test(word)) {
      k += 1; // "plus nine one …"
      continue;
    }
    const said = spokenDigitAt(words, k);
    if (said === null) break;
    digits += said.digits.length;
    k += said.used;
  }
  if (digits < 10 || digits > 15 || k >= tokens.length) return null;
  const last = tokens[k - 1] as { word: string; at: number };
  const name = text.slice(0, last.at + last.word.length);
  const reading = readPhoneReference(name, country);
  return reading !== null && reading.kind !== 'partial' ? { name, text: text.slice((tokens[k] as { at: number }).at) } : null;
}
