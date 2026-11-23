import type { RawFinding } from './types';

/**
 * The checks Eya runs on a draft, all on this PC and with no model: slips a careful second reader would catch in a petition — a word
 * written twice, a date that does not exist, an amount whose figures and words disagree, a name spelled two ways, a paragraph number that
 * jumps. Pure functions of text, so each is tested on its own.
 *
 * What they do NOT do is judge style or law. They only report what is certainly or very probably a slip, and say it plainly; a fix is
 * offered only when it is certain, and is never applied without the user's click.
 */

const EXCERPT_PAD = 28;

/** The words around a position, for showing the slip in its place. */
function around(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_PAD);
  const end = Math.min(text.length, index + length + EXCERPT_PAD);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/** Whether the token the match sits in is an address or link (where ".C" and ",x" are normal). */
function insideAddress(text: string, index: number): boolean {
  let start = index;
  while (start > 0 && !/\s/.test(text[start - 1] ?? ' ')) start -= 1;
  let end = index;
  while (end < text.length && !/\s/.test(text[end] ?? ' ')) end += 1;
  return /[@/\\]|https?:|www\./i.test(text.slice(start, end));
}

// ---------------------------------------------------------------------------------------------------------------- one paragraph
const REPEAT_OK = new Set(['had', 'that', 'is']); // "she had had", "that that is", "what it is is"

const ABBREVIATIONS = new Set([
  'no', 'nos', 'vs', 'v', 'viz', 'ie', 'eg', 'etc', 'rs', 'dr', 'mr', 'mrs', 'ms', 'smt', 'sri', 'shri', 'sl', 'hon', 'ltd', 'pvt', 'dt', 'st',
  'sec', 'secs', 'art', 'arts', 'para', 'paras', 'cl', 'anr', 'ors', 'ex', 'cf', 'ibid', 'id', 'prof', 'adv', 'col', 'gen', 'capt', 'jr', 'sr',
  'mt', 'ref', 'vol', 'pp', 'pg', 'fig', 'approx', 'dept', 'govt', 'est', 'inc', 'co', 'dist', 'distt', 'tq', 'mdl', 'crl', 'wp',
]);

const MONTHS: Readonly<Record<string, number>> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function daysIn(month: number, year: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function ordinalSuffix(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return 'th';
  return n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
}

const capitalise = (w: string): string => (w === '' ? w : w[0]?.toUpperCase() + w.slice(1));

// Words for a number, the way an Indian amount is written: "five lakh fifty thousand".
const UNITS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const FILLER_WORDS = new Set(['and', 'only', 'rupees', 'rupee', 'rs']);

/** The number a phrase like "five lakh fifty thousand only" says, or null when it is not a plain amount (then nothing is judged). */
export function wordsToNumber(words: string): number | null {
  const tokens = words
    .toLowerCase()
    .replace(/[-,]/g, ' ')
    .split(/\s+/)
    .filter((t) => t !== '' && !FILLER_WORDS.has(t));
  let total = 0;
  let current = 0;
  let any = false;
  for (const t of tokens) {
    if (t in UNITS) current += UNITS[t] as number;
    else if (t in TENS) current += TENS[t] as number;
    else if (t === 'hundred') current = (current === 0 ? 1 : current) * 100;
    else if (t === 'thousand') {
      total += (current === 0 ? 1 : current) * 1_000;
      current = 0;
    } else if (t === 'lakh' || t === 'lakhs' || t === 'lac' || t === 'lacs') {
      total += (current === 0 ? 1 : current) * 100_000;
      current = 0;
    } else if (t === 'crore' || t === 'crores') {
      total += (current === 0 ? 1 : current) * 10_000_000;
      current = 0;
    } else return null;
    any = true;
  }
  return any ? total + current : null;
}

/** 550000 as Indian readers write it: 5,50,000. */
export function formatIndian(n: number): string {
  const s = String(Math.trunc(n));
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

/** Slips inside one paragraph, as written. */
export function checkParagraph(text: string): RawFinding[] {
  const out: RawFinding[] = [];
  const push = (f: RawFinding): void => void out.push(f);

  // A word written twice in a row.
  for (const m of text.matchAll(/\b([A-Za-z][A-Za-z']*)(\s+)\1\b/gi)) {
    const word = m[1] as string;
    if (REPEAT_OK.has(word.toLowerCase())) continue;
    push({ kind: 'repeated_word', message: `"${word}" is written twice in a row`, excerpt: around(text, m.index ?? 0, m[0].length), replace: { from: m[0], to: word } });
  }

  // Two spaces between words (three or more are taken as layout, and a double space after a full stop as a habit).
  for (const m of text.matchAll(/(\S)( {2})(?! )(\S)/g)) {
    const before = m[1] as string;
    if (/[.?!:]/.test(before)) continue;
    push({ kind: 'spacing', message: 'Two spaces in a row', excerpt: around(text, m.index ?? 0, m[0].length), replace: { from: m[0], to: `${before} ${m[3] as string}` } });
  }

  // A space before a comma, semicolon, full stop, ! or ?.
  for (const m of text.matchAll(/([^\s.,]) +([,;.!?])(?=\s|$|["')\]])/g)) {
    push({ kind: 'punctuation', message: `A space before "${m[2] as string}"`, excerpt: around(text, m.index ?? 0, m[0].length), replace: { from: m[0], to: `${m[1] as string}${m[2] as string}` } });
  }

  // No space after a comma, a semicolon or a full stop between words ("the Court,the", "Court.The").
  for (const m of text.matchAll(/([A-Za-z]{2}),([A-Za-z]{2})/g)) {
    if (insideAddress(text, m.index ?? 0)) continue;
    push({ kind: 'punctuation', message: 'No space after the comma', excerpt: around(text, m.index ?? 0, m[0].length), replace: { from: m[0], to: `${m[1] as string}, ${m[2] as string}` } });
  }
  for (const m of text.matchAll(/([A-Za-z]{2});([A-Za-z]{2})/g)) {
    if (insideAddress(text, m.index ?? 0)) continue;
    push({ kind: 'punctuation', message: 'No space after the semicolon', excerpt: around(text, m.index ?? 0, m[0].length), replace: { from: m[0], to: `${m[1] as string}; ${m[2] as string}` } });
  }
  for (const m of text.matchAll(/\b([A-Za-z]{3,})\.([A-Z][a-z]{2,})/g)) {
    if (insideAddress(text, m.index ?? 0) || ABBREVIATIONS.has((m[1] as string).toLowerCase())) continue;
    push({ kind: 'punctuation', message: 'No space after the full stop', excerpt: around(text, m.index ?? 0, m[0].length), replace: { from: m[0], to: `${m[1] as string}. ${m[2] as string}` } });
  }

  // Brackets and quotation marks that are not closed. (A list marker such as "a)" or "1)" at the start is not a bracket.)
  const body = text.replace(/^\s*[A-Za-z0-9]{1,4}[.)]\s+/, ' ');
  const pairs: ReadonlyArray<readonly [string, string, string]> = [['(', ')', 'bracket'], ['[', ']', 'square bracket'], ['{', '}', 'brace']];
  for (const [open, close, name] of pairs) {
    const opens = [...body].filter((c) => c === open).length;
    const closes = [...body].filter((c) => c === close).length;
    if (opens > closes) push({ kind: 'brackets', message: `A ${name} "${open}" is opened but never closed`, excerpt: around(text, Math.max(0, text.lastIndexOf(open)), 1) });
    else if (closes > opens) push({ kind: 'brackets', message: `A ${name} "${close}" has no matching "${open}"`, excerpt: around(text, Math.max(0, text.indexOf(close)), 1) });
  }
  const straight = [...text].filter((c) => c === '"').length;
  if (straight % 2 === 1) push({ kind: 'quotes', message: 'A quotation mark is opened but never closed', excerpt: around(text, Math.max(0, text.lastIndexOf('"')), 1) });
  const curlyOpen = [...text].filter((c) => c === '“').length;
  const curlyClose = [...text].filter((c) => c === '”').length;
  if (curlyOpen !== curlyClose) push({ kind: 'quotes', message: 'A quotation mark is opened but never closed (or closed but never opened)', excerpt: around(text, Math.max(0, text.indexOf(curlyOpen > curlyClose ? '“' : '”')), 1) });

  // A sentence that starts with a small letter (after a full stop that is not an abbreviation's).
  for (const m of text.matchAll(/([A-Za-z.]+)([.?!])\s+([a-z][a-z']+)/g)) {
    const previous = (m[1] as string).replace(/\.+$/, '').toLowerCase();
    if (m[2] === '.' && (ABBREVIATIONS.has(previous) || previous.length <= 2 || previous.includes('.'))) continue;
    const word = m[3] as string;
    push({
      kind: 'capital',
      message: `"${word}" starts a sentence but begins with a small letter`,
      excerpt: around(text, m.index ?? 0, m[0].length),
      replace: { from: `${m[2] as string} ${word}`, to: `${m[2] as string} ${capitalise(word)}` },
    });
  }
  for (const m of text.matchAll(/\s(i)(?=\s|,|'m|'ll|'ve|'d)/g)) {
    push({ kind: 'capital', message: 'The word "I" should be a capital letter', excerpt: around(text, m.index ?? 0, 3), replace: { from: m[0], to: ' I' } });
  }

  // Dates that do not exist, and the wrong ending on a number ("22th").
  for (const m of text.matchAll(/\b(\d{1,2})([./-])(\d{1,2})\2(\d{4})\b/g)) {
    const day = Number(m[1]);
    const month = Number(m[3]);
    const year = Number(m[4]);
    if (month < 1 || month > 12 || day < 1 || day > daysIn(month, year) || year < 1900 || year > 2100) {
      push({ kind: 'date', message: `${m[0]} is not a real date (day, month, year)`, excerpt: around(text, m.index ?? 0, m[0].length) });
    }
  }
  const monthNames = Object.keys(MONTHS).join('|');
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthNames})\\s*,?\\s+(\\d{4})\\b`, 'gi'))) {
    const day = Number(m[1]);
    const month = MONTHS[(m[2] as string).toLowerCase()] as number;
    const year = Number(m[3]);
    if (day < 1 || day > daysIn(month, year)) push({ kind: 'date', message: `"${m[0]}" is not a real date: that month has no day ${day}`, excerpt: around(text, m.index ?? 0, m[0].length) });
  }
  for (const m of text.matchAll(/\b(\d{1,3})(st|nd|rd|th)\b/gi)) {
    const n = Number(m[1]);
    const right = ordinalSuffix(n);
    if ((m[2] as string).toLowerCase() !== right) {
      push({ kind: 'number', message: `"${m[0]}" should be "${n}${right}"`, excerpt: around(text, m.index ?? 0, m[0].length), replace: { from: m[0], to: `${n}${right}` } });
    }
  }
  // The letter O typed for a zero inside a number ("2O26").
  for (const m of text.matchAll(/\b(?=\d*[Oo])(?=[\dOo]*\d)[\dOo]{3,}\b/g)) {
    const fixed = m[0].replace(/[Oo]/g, '0');
    push({ kind: 'number', message: `"${m[0]}" has the letter O where a zero belongs`, excerpt: around(text, m.index ?? 0, m[0].length), replace: { from: m[0], to: fixed } });
  }

  // An amount whose figures and words disagree: "Rs. 5,00,000/- (Rupees five lakh fifty thousand only)".
  for (const m of text.matchAll(/(?:Rs\.?|₹|INR)\s*([\d,]+(?:\.\d+)?)\s*(?:\/-)?\s*\(\s*(?:Rupees|Rs\.?)?\s*([A-Za-z][A-Za-z\s,-]*?)\s*(?:only)?\s*\.?\s*\)/gi)) {
    const figures = Number((m[1] as string).replace(/,/g, ''));
    const words = wordsToNumber(m[2] as string);
    if (words === null || !Number.isFinite(figures) || !Number.isInteger(figures)) continue;
    if (figures !== words) {
      push({
        kind: 'amount',
        message: `The figures say ${formatIndian(figures)} but the words say ${formatIndian(words)} ("${(m[2] as string).trim()}")`,
        excerpt: around(text, m.index ?? 0, m[0].length),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- the whole draft
export interface DocumentFinding extends RawFinding {
  readonly paragraph: number;
}

function edits(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const v = Math.min((previous[j] as number) + 1, (row[j - 1] as number) + 1, (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
      row.push(v);
      if (v < best) best = v;
    }
    if (best > limit) return limit + 1;
    previous = row;
  }
  return previous[b.length] as number;
}

const isSuffixVariant = (a: string, b: string): boolean => (a.startsWith(b) || b.startsWith(a)) && Math.abs(a.length - b.length) <= 3;

export interface DocumentCheckOptions {
  /** Whether a spell checker (Word's, on this PC) calls this word wrong. When given, a name is only doubted if the checker also doubts it. */
  readonly isMisspelled?: (word: string) => boolean;
}

/** Slips that only show across paragraphs: a name spelled two ways, a case number that differs by a digit, numbering that jumps. */
export function checkDocument(paragraphs: readonly string[], options: DocumentCheckOptions = {}): DocumentFinding[] {
  const out: DocumentFinding[] = [];

  // Names (and other capitalised words) written once that look like a typo of one written many times.
  const counts = new Map<string, number>();
  const firstAt = new Map<string, number>();
  paragraphs.forEach((p, i) => {
    for (const m of p.matchAll(/\b[A-Z][a-z]{5,}\b/g)) {
      counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
      if (!firstAt.has(m[0])) firstAt.set(m[0], i + 1);
    }
  });
  for (const [rare, n] of counts) {
    if (n !== 1) continue;
    for (const [usual, m] of counts) {
      if (m < 3 || usual === rare || usual[0] !== rare[0]) continue;
      // Without a dictionary only a one-letter difference is called a typo ("Selection" and "Section" are both real words).
      const allowed = options.isMisspelled === undefined ? 1 : 2;
      const distance = edits(usual, rare, allowed);
      if (distance < 1 || distance > allowed || isSuffixVariant(usual, rare)) continue;
      if (options.isMisspelled !== undefined && !options.isMisspelled(rare)) continue; // a real word, not a slip
      out.push({
        kind: 'name',
        paragraph: firstAt.get(rare) as number,
        message: `"${rare}" is written once, but "${usual}" is written ${m} times — is it a typo?`,
        excerpt: rare,
        replace: { from: rare, to: usual },
      });
      break;
    }
  }

  // Case numbers: the same kind of number with a digit changed, used once against several times.
  type CaseRef = { text: string; prefix: string; number: string; year: string; paragraph: number };
  const cases: CaseRef[] = [];
  paragraphs.forEach((p, i) => {
    for (const m of p.matchAll(/\b([A-Z][A-Za-z.]{0,12}?)\s*(?:No\.?\s*)?(\d{1,6})\s*(?:of|\/)\s*((?:19|20)\d{2})\b/g)) {
      cases.push({ text: m[0], prefix: (m[1] as string).replace(/[^A-Za-z]/g, '').toUpperCase(), number: m[2] as string, year: m[3] as string, paragraph: i + 1 });
    }
  });
  const byKey = new Map<string, CaseRef[]>();
  for (const c of cases) byKey.set(`${c.prefix}|${c.number}|${c.year}`, [...(byKey.get(`${c.prefix}|${c.number}|${c.year}`) ?? []), c]);
  for (const [key, refs] of byKey) {
    if (refs.length !== 1) continue;
    const one = refs[0] as CaseRef;
    for (const [otherKey, others] of byKey) {
      if (otherKey === key || others.length < 2) continue;
      const other = others[0] as CaseRef;
      if (other.prefix !== one.prefix) continue;
      const apart = edits(`${one.number}${one.year}`, `${other.number}${other.year}`, 1);
      if (apart !== 1 && !(one.number.length === other.number.length && swapped(one.number, other.number) && one.year === other.year)) continue;
      out.push({
        kind: 'case_number',
        paragraph: one.paragraph,
        message: `"${one.text}" is written once, but "${other.text}" is written ${others.length} times — is it the same case?`,
        excerpt: one.text,
        replace: { from: one.text, to: one.text.replace(one.year, other.year).replace(one.number, other.number) },
      });
      break;
    }
  }

  // Paragraph numbers: 1, 2, 4 — or 3, 3.
  const numbered: Array<{ paragraph: number; n: number }> = [];
  paragraphs.forEach((p, i) => {
    const m = /^\s*(\d{1,3})[.)]\s+\S/.exec(p);
    if (m !== null) numbered.push({ paragraph: i + 1, n: Number(m[1]) });
  });
  if (numbered.length >= 3) {
    for (let i = 1; i < numbered.length; i += 1) {
      const before = numbered[i - 1] as { paragraph: number; n: number };
      const here = numbered[i] as { paragraph: number; n: number };
      if (here.n === 1) continue; // a new list
      if (here.n === before.n) out.push({ kind: 'numbering', paragraph: here.paragraph, message: `Paragraph number ${here.n} is used twice`, excerpt: `${here.n}.` });
      else if (here.n > before.n + 1 && here.n - before.n <= 3) out.push({ kind: 'numbering', paragraph: here.paragraph, message: `The paragraph numbers jump from ${before.n} to ${here.n}`, excerpt: `${here.n}.` });
      else if (here.n < before.n) out.push({ kind: 'numbering', paragraph: here.paragraph, message: `The paragraph numbers go back from ${before.n} to ${here.n}`, excerpt: `${here.n}.` });
    }
  }

  // A party's name written with a capital almost always and once with a small letter ("the petitioner").
  for (const term of ['Petitioner', 'Respondent', 'Appellant', 'Applicant', 'Complainant', 'Accused', 'Plaintiff', 'Defendant']) {
    const capital = new RegExp(`\\b${term}s?\\b`, 'g');
    const small = new RegExp(`\\b${term.toLowerCase()}s?\\b`, 'g');
    let capitals = 0;
    let firstSmall: { paragraph: number; word: string } | null = null;
    paragraphs.forEach((p, i) => {
      capitals += [...p.matchAll(capital)].length;
      if (firstSmall === null) {
        const m = small.exec(p);
        small.lastIndex = 0;
        if (m !== null) firstSmall = { paragraph: i + 1, word: m[0] };
      }
    });
    const found = firstSmall as { paragraph: number; word: string } | null;
    if (capitals >= 4 && found !== null) {
      out.push({
        kind: 'term',
        paragraph: found.paragraph,
        message: `"${found.word}" is written with a small letter, but "${term}" is used ${capitals} times`,
        excerpt: found.word,
        replace: { from: found.word, to: capitalise(found.word) },
      });
    }
  }
  return out;
}

/** Two digit strings of the same length that differ by two neighbouring digits swapped (12345 and 12354). */
function swapped(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const diff: number[] = [];
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff.push(i);
  return diff.length === 2 && (diff[1] as number) - (diff[0] as number) === 1 && a[diff[0] as number] === b[diff[1] as number] && a[diff[1] as number] === b[diff[0] as number];
}
