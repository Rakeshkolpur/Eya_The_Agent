import type { PageSnapshot } from './pageSnapshot';

/**
 * The money and the details on a checkout or booking page, read from what the page SAYS, to go with the question put to the user before
 * the click that spends it. The model is told to quote these and not to guess: "₹1,299 for the red shirt, delivered to Hyderabad" is only
 * worth saying if it is what the page shows.
 *
 * A page's text arrives as long lines (a whole summary on one), so nothing here relies on one fact being on a line of its own: each amount
 * is read with the few words that come before it, and the address, the way of paying and the booking details are found by their labels.
 */
export interface CheckoutFacts {
  /** What the page charges, with what each is for ("Total payable ₹1,048", "Delivery charges ₹49"), the total first. */
  readonly amounts: readonly string[];
  /** What is being bought, with its price ("Red cotton shirt (M) x 1 ₹1,099"). */
  readonly items: readonly string[];
  readonly deliverTo?: string;
  readonly payWith?: string;
  /** For a booking: the show, the screen, the date and time, the seats, how many tickets. */
  readonly details: readonly string[];
}

const MONEY = /(?:-\s?)?(?:₹|\brs\.?\s?|\binr\s?|\$|€|£)\s?\d[\d,]*(?:\.\d{1,2})?/gi;
const WHAT = /total|amount|payable|you pay|to pay|price|fare|subtotal|delivery|shipping|fee|discount|tax|gst|convenience|charge|coupon|saving/i;
const TOTAL_FIRST = /grand total|total payable|amount payable|you pay|order total|total amount|to pay|\btotal\b/i;

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The words just before an amount, back to the previous amount or the start of its line, at most this many. */
function wordsBefore(text: string, at: number, previousEnd: number, max: number): string[] {
  const from = Math.max(previousEnd, text.lastIndexOf('\n', at) + 1);
  return clean(text.slice(from, at).replace(/[:|·]+/g, ' '))
    .split(' ')
    .filter((w) => w !== '' && w !== '-' && w !== '–')
    .slice(-max);
}

/** Takes off the page's own headings from the front of a label ("Order summary Red cotton shirt" → "Red cotton shirt"). */
function withoutHeadings(label: string, headings: readonly string[]): string {
  let out = label;
  for (let changed = true; changed; ) {
    changed = false;
    for (const h of headings) {
      const t = clean(h);
      if (t !== '' && out.toLowerCase().startsWith(t.toLowerCase() + ' ')) {
        out = out.slice(t.length).trim();
        changed = true;
      }
    }
  }
  return out;
}

function amountsAndItems(text: string, headings: readonly string[]): { amounts: string[]; items: string[] } {
  const amounts: string[] = [];
  const items: string[] = [];
  let previousEnd = 0;
  for (const m of text.matchAll(MONEY)) {
    const at = m.index ?? 0;
    const amount = clean(m[0]).replace(/^-\s?/, '-');
    const words = wordsBefore(text, at, previousEnd, 10);
    previousEnd = at + m[0].length;
    // What the amount is for: from the first word, among the last four, that names a charge ("Convenience fee", "Total payable").
    const tail = words.slice(-4);
    const start = tail.findIndex((w) => WHAT.test(w));
    if (start >= 0) {
      const line = `${tail.slice(start).join(' ')} ${amount}`;
      if (!amounts.includes(line)) amounts.push(line);
    } else {
      const label = withoutHeadings(words.join(' '), headings);
      if (label.length >= 3 && items.length < 5) {
        const line = `${label} ${amount}`;
        if (!items.includes(line)) items.push(line);
      }
    }
  }
  amounts.sort((x, y) => Number(TOTAL_FIRST.test(y)) - Number(TOTAL_FIRST.test(x)));
  return { amounts: amounts.slice(0, 8), items };
}

/** After a label, up to the next thing a page puts beside it (another label, a button, an amount, a line break). */
function after(text: string, label: RegExp, stop: RegExp, max: number): string | undefined {
  const m = label.exec(text);
  if (m === null) return undefined;
  const rest = text.slice(m.index + m[0].length).replace(/^[\s:\-–]+/, '');
  const line = rest.split('\n')[0] ?? '';
  const cut = line.search(stop);
  const value = clean(cut > 0 ? line.slice(0, cut) : line).slice(0, max);
  return value.length >= 2 ? value : undefined;
}

const NEXT_THING = /\s(?:payment|pay(?:ing)?\s(?:with|via|by|using|method)|total|delivery charges|place order|use\s|change|edit|order summary|₹|rs\.?\s?\d)/i;

function bookingDetails(text: string, headings: readonly string[]): string[] {
  const out: string[] = [];
  const add = (s: string | undefined): void => {
    if (s !== undefined && !out.includes(s)) out.push(s);
  };
  add(/(screen|audi(?:torium)?|hall)\s*\d+/i.exec(text)?.[0]);
  add(/(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{1,2}[:.]\d{2}\s?(?:am|pm)?/i.exec(text)?.[0]);
  if (out.length < 2) add(/\b\d{1,2}[:.]\d{2}\s?(?:am|pm)\b/i.exec(text)?.[0]);
  const seats = /seats?(?:\s+selected)?\s*[:\-–]?\s*((?:[A-Z]{0,2}\d{1,3}[A-Z]?)(?:\s*,\s*[A-Z]{0,2}\d{1,3}[A-Z]?)*)/i.exec(text)?.[1];
  add(seats !== undefined ? `Seats: ${clean(seats)}` : undefined);
  const tickets = /(\d+)\s+tickets?\b/i.exec(text);
  add(tickets !== null ? `${tickets[1]} ${Number(tickets[1]) === 1 ? 'Ticket' : 'Tickets'}` : undefined);
  const train = /(?:train|coach|berth|passengers?)\s*[:\-–]?\s*([^\n]{2,40}?)(?=\s{2,}|\n|$)/i.exec(text);
  add(train !== null ? clean(train[0]) : undefined);
  if (out.length > 0 && headings[1] !== undefined) out.unshift(headings[1].slice(0, 80));
  return out.slice(0, 7);
}

/** What the page says about the money and the booking, or null when it says nothing of the kind. */
export function checkoutFacts(page: PageSnapshot): CheckoutFacts | null {
  const text = [(page.visibleText ?? ''), ...page.headings, ...(page.tables ?? []).flatMap((t) => t.rows.map((r) => r.join(' ')))].join('\n');
  const { amounts, items } = amountsAndItems(text, page.headings);
  const deliverTo = after(text, /\b(?:deliver(?:ing|y)?\s+to|ship(?:ping)?\s+to|delivery address)\b/i, NEXT_THING, 140);
  const payWith = after(text, /\b(?:pay(?:ment)?\s+(?:method|mode|option)|paying\s+(?:with|via)|pay\s+(?:with|via|using))\b/i, /\s(?:pay by|use\s|place order|change|edit|total|delivery charges|₹)/i, 60);
  const details = bookingDetails(text, page.headings);
  if (amounts.length === 0 && items.length === 0 && deliverTo === undefined && payWith === undefined && details.length === 0) return null;
  return { amounts, items, ...(deliverTo !== undefined ? { deliverTo } : {}), ...(payWith !== undefined ? { payWith } : {}), details };
}
