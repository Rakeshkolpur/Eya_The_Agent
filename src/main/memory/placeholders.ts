/**
 * A routine that types a date can't store "14-10-2026": tomorrow it would be wrong. It stores {{today:dd-mm-yyyy}} instead, and the
 * real date is filled in each time it runs. This module does both directions: filling in (for running) and turning a date seen
 * today back into a placeholder (for saving what Eya just did).
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad = (n: number): string => String(n).padStart(2, '0');

/** Formats a date by tokens: yyyy yy mmmm mmm mm m dd d (all lower case; anything else is copied as it is). */
export function formatDate(date: Date, format: string): string {
  const tokens: Record<string, string> = {
    yyyy: String(date.getFullYear()),
    yy: String(date.getFullYear()).slice(-2),
    mmmm: MONTHS[date.getMonth()] as string,
    mmm: (MONTHS[date.getMonth()] as string).slice(0, 3),
    mm: pad(date.getMonth() + 1),
    m: String(date.getMonth() + 1),
    dd: pad(date.getDate()),
    d: String(date.getDate()),
  };
  return format.replace(/yyyy|yy|mmmm|mmm|mm|m|dd|d/g, (t) => tokens[t] as string);
}

export interface PlaceholderContext {
  readonly now: Date;
  /** The file the last download step produced, if any. */
  readonly lastDownload?: string | undefined;
}

export class PlaceholderError extends Error {}

/** Fills in {{today}}, {{today:FORMAT}} and {{last_download}}. An unknown placeholder is an error, never silently left in. */
export function expandPlaceholders(text: string, ctx: PlaceholderContext): string {
  return text.replace(/\{\{\s*([a-z_]+)(?::([^}]*))?\s*\}\}/gi, (_all, name: string, arg: string | undefined) => {
    const key = name.toLowerCase();
    if (key === 'today') return formatDate(ctx.now, (arg ?? 'yyyy-mm-dd').trim().toLowerCase());
    if (key === 'last_download') {
      if (ctx.lastDownload === undefined) throw new PlaceholderError('This step needs a file from an earlier download, and there was none.');
      return ctx.lastDownload;
    }
    throw new PlaceholderError(`Unknown placeholder {{${name}}}.`);
  });
}

export function hasPlaceholder(text: string): boolean {
  return /\{\{[^}]+\}\}/.test(text);
}

/** The ways a date is commonly typed, most specific first so "14 October 2026" is not read as the shorter "14 Oct". */
const DATE_FORMATS = ['dd mmmm yyyy', 'd mmmm yyyy', 'dd mmm yyyy', 'd mmm yyyy', 'yyyy-mm-dd', 'yyyy/mm/dd', 'dd-mm-yyyy', 'dd/mm/yyyy', 'dd.mm.yyyy', 'd/m/yyyy', 'd-m-yyyy', 'mm/dd/yyyy'];

/** Turns today's date, written in any of the usual ways, into a placeholder; leaves any other text alone. */
export function templatizeDates(text: string, now: Date): string {
  let out = text;
  for (const format of DATE_FORMATS) {
    const today = formatDate(now, format);
    const re = new RegExp(`(?<![\\w])${today.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'gi');
    out = out.replace(re, `{{today:${format}}}`);
  }
  return out;
}
