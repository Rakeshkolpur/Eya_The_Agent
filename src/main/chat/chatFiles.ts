import { normalizeText } from './contactMatch';

/**
 * Finding a file in the chats: what WhatsApp Web's own document list ("Media" in its left rail → "Docs", all chats) shows for each file, read from the
 * page's text and judged here; and what a person means by "last week", "yesterday", "in October". Pure: no page, no browser, so it is tested without one.
 *
 * What the real page shows for a document, one line each (seen on the real WhatsApp Web, 27 Oct 2026):
 *   a small type badge · the FILE NAME · "3 MB • PDF" · the CAPTION ("No caption") · the SENDER ("You", or a name) · the DATE ("Today at 21:14")
 * The list does not say which chat a file is in: for that the chat is opened at the message (see the tool).
 */

export interface DocRow {
  readonly file: string;
  /** "PDF", "DOCX"… as the page says. */
  readonly type: string;
  /** "3 MB". */
  readonly size: string;
  /** Empty when the page says "No caption". */
  readonly caption: string;
  /** "You" for a file the person sent; otherwise the sender's name as shown. */
  readonly sender: string;
  readonly mine: boolean;
  /** The date as the page wrote it ("Today at 21:14"). */
  readonly whenText: string;
  /** The date read from it, or null when it could not be read. */
  readonly when: Date | null;
}

const SIZE_LINE = /^(\d[\d,.]*\s?(?:bytes?|[kKMG]B))\s*[•·]\s*(\S+)\s*$/;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const CLOCK = '(?:,?\\s+(?:at\\s+)?\\d{1,2}[:.]\\d{2}(?:\\s*[ap]\\.?m\\.?)?)?';
/** The whole line has the shape of a date the page writes: "Today at 21:14", "Monday at 09:05", "21/10/2026", "21 Oct 2026", "Oct 21, 2026" (and is then also read by parseWhenText). */
const DATE_LINE = new RegExp(
  `^(?:(?:today|yesterday|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\\b${CLOCK}|\\d{1,2}[/.\\-]\\d{1,2}[/.\\-]\\d{2,4}${CLOCK}|\\d{1,2}\\s+[a-z]{3,9}\\.?(?:,?\\s+\\d{4})?${CLOCK}|[a-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?${CLOCK})$`,
  'i',
);

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function withTime(day: Date, text: string): Date {
  // a clock time is "at 9.05" or "21:14" — a bare "21.10" is part of a date, never a time
  const m = /\bat\s+(\d{1,2})[:.](\d{2})\s*([ap])?\.?m?\b/i.exec(text) ?? /(?:^|[\s,])(\d{1,2}):(\d{2})\s*([ap])?\.?m?\b/i.exec(text);
  const x = new Date(day);
  if (m === null) return x;
  let h = Number(m[1]);
  if (m[3] !== undefined) h = (h % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0);
  x.setHours(h, Number(m[2]), 0, 0);
  return x;
}

/** The date a line like "Today at 21:14", "Yesterday at 09:05", "Monday at 14:30", "21/10/2026", "21 Oct 2026" means, or null. Day-first for numbers (the way India writes them). */
export function parseWhenText(text: string, now: Date): Date | null {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t === '') return null;
  const lower = t.toLowerCase();
  const today = startOfDay(now);
  if (/^today\b/.test(lower)) return withTime(today, lower);
  if (/^yesterday\b/.test(lower)) return withTime(addDays(today, -1), lower);
  const weekday = WEEKDAYS.findIndex((d) => lower.startsWith(d) || lower.startsWith(d.slice(0, 3) + ' ') || lower.startsWith(d.slice(0, 3) + ','));
  if (weekday >= 0) {
    // the most recent such day before today (a name within the last week)
    let back = (today.getDay() - weekday + 7) % 7;
    if (back === 0) back = 7;
    return withTime(addDays(today, -back), lower);
  }
  const numeric = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/.exec(lower);
  if (numeric !== null) {
    let day = Number(numeric[1]);
    let month = Number(numeric[2]);
    if (month > 12 && day <= 12) [day, month] = [month, day]; // written month-first
    const year = Number(numeric[3]) < 100 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return withTime(new Date(year, month - 1, day), lower);
  }
  const named = /^(\d{1,2})\s+([a-z]{3,9})\.?,?(?:\s+(\d{4}))?\b/.exec(lower) ?? /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?\b/.exec(lower);
  if (named !== null) {
    const dayFirst = /^\d+$/.test(named[1] as string);
    const monthWord = (dayFirst ? named[2] : named[1]) as string;
    const dayNum = Number(dayFirst ? named[1] : named[2]);
    const month = MONTHS.findIndex((m) => m.startsWith(monthWord));
    if (month < 0 || dayNum < 1 || dayNum > 31) return null;
    const given = named[3];
    let date = new Date(given === undefined ? now.getFullYear() : Number(given), month, dayNum);
    // a date written without a year that would be in the future is last year's
    if (given === undefined && date.getTime() > now.getTime() + 86_400_000) date = new Date(now.getFullYear() - 1, month, dayNum);
    return withTime(date, lower);
  }
  return null;
}

/**
 * Reads the document rows out of the text of the page. Anchored on the one line that has the shape "3 MB • PDF" — the file name is the line before it, the caption
 * the lines after it up to the sender, the sender the line before the date line. Rows that cannot be read whole are skipped, never guessed.
 */
export function parseDocRows(text: string, now: Date): DocRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  const rows: DocRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const size = SIZE_LINE.exec(lines[i] as string);
    if (size === null) continue;
    // A document inside an OPEN CHAT has the same "3 MB • PDF" line, followed by the message's clock time: that is a message, not a row of the list.
    if (/^\d{1,2}[:.]\d{2}(?:\s*[ap]\.?m\.?)?$/i.test(lines[i + 1] ?? '')) continue;
    const file = lines[i - 1] as string;
    // the date line is the first line after the size that reads as a date, within a handful of lines (a caption can have several)
    let d = -1;
    for (let k = i + 1; k < Math.min(i + 6, lines.length); k += 1) { // (a caption of more than three lines is not read: the row is skipped, never guessed)
      if (DATE_LINE.test(lines[k] as string) && parseWhenText(lines[k] as string, now) !== null) {
        d = k;
        break;
      }
    }
    if (d < i + 2) continue; // needs at least a caption line and a sender line between the size and the date
    const sender = lines[d - 1] as string;
    const caption = lines.slice(i + 1, d - 1).join(' ').trim();
    const whenText = lines[d] as string;
    rows.push({
      file,
      type: (size[2] as string).toUpperCase(),
      size: size[1] as string,
      caption: /^no caption$/i.test(caption) ? '' : caption,
      sender,
      mine: /^you$/i.test(sender),
      whenText,
      when: parseWhenText(whenText, now),
    });
    i = d;
  }
  return rows;
}

// ------------------------------------------------------------------------------------------------------------------------------- time
export interface TimeWindow {
  readonly from: Date;
  readonly to: Date;
  /** In words, for saying back ("last week (19 Oct – 25 Oct)"). */
  readonly label: string;
}

const fmt = (d: Date): string => `${d.getDate()} ${(MONTHS[d.getMonth()] ?? '').slice(0, 3).replace(/^./, (c) => c.toUpperCase())}`;
const endOfDay = (d: Date): Date => new Date(startOfDay(d).getTime() + 86_400_000 - 1);

function windowOf(from: Date, to: Date, name: string, showRange = true): TimeWindow {
  return { from, to, label: showRange ? `${name} (${fmt(from)} – ${fmt(to)})` : name };
}

/** What a person means by a time: "today", "yesterday", "this week", "last week", "this month", "last month", "in October", "on Monday", "3 days ago", "on 21/10". Null when it is not one of these. */
export function readTimeWindow(phrase: string, now: Date): TimeWindow | null {
  const p = ` ${phrase.toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const today = startOfDay(now);
  const monday = (d: Date): Date => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
  if (/\b(today|this morning|tonight)\b/.test(p)) return windowOf(today, endOfDay(now), 'today', false);
  if (/\byesterday\b/.test(p)) return windowOf(addDays(today, -1), endOfDay(addDays(today, -1)), 'yesterday', false);
  if (/\b(last|previous) week\b/.test(p)) {
    // said loosely it is "a week or so ago", so the window runs from the start of last week up to now (never narrower than the past seven days)
    return windowOf(addDays(monday(today), -7), endOfDay(now), 'last week or so');
  }
  if (/\bthis week\b/.test(p)) return windowOf(monday(today), endOfDay(now), 'this week');
  const past = /\b(?:past|last|previous)\s+(\d{1,3}|a|one|two|three|four|five|six|seven|ten|fifteen)\s+(days?|weeks?|months?)\b/.exec(p);
  if (past !== null) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fifteen: 15 };
    const n = words[past[1] as string] ?? Number(past[1]);
    const unit = (past[2] as string).startsWith('week') ? 7 : (past[2] as string).startsWith('month') ? 30 : 1;
    return windowOf(addDays(today, -n * unit + 1), endOfDay(now), `the last ${n * unit} days`, false);
  }
  if (/\b(last|previous) month\b/.test(p)) {
    const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    return windowOf(from, endOfDay(new Date(today.getFullYear(), today.getMonth(), 0)), 'last month');
  }
  if (/\bthis month\b/.test(p)) return windowOf(new Date(today.getFullYear(), today.getMonth(), 1), endOfDay(now), 'this month');
  const ago = /\b(\d{1,3}|a|one|two|three|four|five)\s+(days?|weeks?)\s+ago\b/.exec(p);
  if (ago !== null) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };
    const n = words[ago[1] as string] ?? Number(ago[1]);
    const days = n * ((ago[2] as string).startsWith('week') ? 7 : 1);
    const centre = addDays(today, -days);
    const slack = (ago[2] as string).startsWith('week') ? 2 : 0;
    return windowOf(addDays(centre, -slack), endOfDay(addDays(centre, slack)), `${n} ${ago[2]} ago`, false);
  }
  const onDate = /\b(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{1,2}\s+[a-z]{3,9}(?:\s+\d{4})?|[a-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+\d{4})?)\b/.exec(p);
  if (onDate !== null) {
    const day = parseWhenText(onDate[1] as string, now);
    if (day !== null) return windowOf(startOfDay(day), endOfDay(day), `${fmt(day)}`, false);
  }
  for (let i = 0; i < 12; i += 1) {
    const name = MONTHS[i] as string;
    // "in October", "during oct", "of october 2025"; a bare full name too — but a bare "may" is a verb as often as a month
    const named = new RegExp(`\\b(?:in|during|of|from|last)\\s+(?:${name}|${name.slice(0, 3)})\\b|\\b${name}\\b`);
    if (!named.test(p) || (name === 'may' && !/\b(?:in|during|of|from|last)\s+may\b/.test(p))) continue;
    const given = /\b(\d{4})\b/.exec(p)?.[1];
    const year = given !== undefined ? Number(given) : i > today.getMonth() ? today.getFullYear() - 1 : today.getFullYear();
    return windowOf(new Date(year, i, 1), endOfDay(new Date(year, i + 1, 0)), `${name.charAt(0).toUpperCase()}${name.slice(1)} ${year}`, false);
  }
  const lastDay = /\b(?:last|on|this past)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(p);
  if (lastDay !== null) {
    const idx = WEEKDAYS.indexOf(lastDay[1] as string);
    let back = (today.getDay() - idx + 7) % 7;
    if (back === 0 && /\blast\b/.test(p)) back = 7;
    const day = addDays(today, -back);
    return windowOf(day, endOfDay(day), `${(lastDay[1] as string).charAt(0).toUpperCase()}${(lastDay[1] as string).slice(1)} ${fmt(day)}`, false);
  }
  return null;
}

// -------------------------------------------------------------------------------------------------------------------------- matching
export interface FileQuery {
  /** Words that must appear in the file name, the caption or the sender. */
  readonly words: readonly string[];
  /** Only files this person sent (a part of the sender's name as shown). */
  readonly sender?: string;
  readonly direction: 'sent' | 'received' | 'any';
  readonly window?: TimeWindow | null;
}

const TYPE_WORDS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'zip', 'rar', 'apk']);
const STOP = new Set(['the', 'a', 'an', 'my', 'this', 'that', 'file', 'files', 'document', 'documents', 'doc', 'docs', 'attachment', 'attachments', 'named', 'called', 'of', 'to', 'in', 'on', 'for', 'with', 'about', 'one', 'it']);

/** The words that identify a file in what the person said ("the resume pdf" → resume, pdf; "this file" → nothing). */
export function fileWords(text: string): string[] {
  return normalizeText(text.replace(/\.(?=[a-z0-9]{2,5}\b)/gi, ' '))
    .split(' ')
    .filter((w) => w.length > 0 && !(STOP.has(w) && !TYPE_WORDS.has(w)));
}

export interface MatchedDoc extends DocRow {
  /** The row's position in the list on the page (for choosing its menu). */
  readonly index: number;
}

/** The rows that answer the query: every word in the name, the caption or the sender (a type word also in the type), the right direction, the right sender, in the time asked for. */
export function matchDocRows(rows: readonly DocRow[], query: FileQuery): { readonly matches: MatchedDoc[]; readonly undated: number } {
  let undated = 0;
  const matches: MatchedDoc[] = [];
  rows.forEach((row, index) => {
    const hay = normalizeText(`${row.file} ${row.caption} ${row.sender} ${row.type}`);
    const compact = hay.replace(/ /g, '');
    if (!query.words.every((w) => hay.includes(w) || compact.includes(w))) return;
    if (query.direction === 'sent' && !row.mine) return;
    if (query.direction === 'received' && row.mine) return;
    if (query.sender !== undefined && query.sender !== '' && !normalizeText(row.sender).includes(normalizeText(query.sender))) return;
    if (query.window !== undefined && query.window !== null) {
      if (row.when === null) {
        undated += 1;
        return;
      }
      if (row.when.getTime() < query.window.from.getTime() || row.when.getTime() > query.window.to.getTime()) return;
    }
    matches.push({ ...row, index });
  });
  return { matches, undated };
}

// ------------------------------------------------------------------------------------------------------------------------ saying it
export interface FileFindings {
  readonly appName: string;
  /** The files that answer, newest first. */
  readonly files: readonly DocRow[];
  /** What was asked for, in words ("resume pdf"), or empty. */
  readonly asked: string;
  readonly window: TimeWindow | null;
  /** The chat the one file is in, when its chat was opened (never a bare phone number). */
  readonly chat: string | null;
  /** Why the chat is not known, when there is one file and it could not be found out. */
  readonly notLocated: 'copies' | 'no_menu' | 'no_chat' | null;
  /** How many rows had the same file name (the same file sent more than once). */
  readonly copies: number;
  /** The list reached back as far as the time asked (or the person asked for no time). */
  readonly reachedBack: boolean;
  /** The date of the oldest row the list showed, as the page wrote it. */
  readonly oldest: string | null;
  /** Rows whose date could not be read and so were left out of a time-limited answer. */
  readonly undated: number;
}

const quote = (s: string): string => `“${s}”`;
const detail = (f: DocRow): string => `${f.type}${f.size !== '' ? `, ${f.size}` : ''}`;
const who = (f: DocRow): string => (f.mine ? 'you sent it' : `${f.sender} sent it`);

/** What is told to the person: where the file is, or what was seen and what was not. Plain words, no list of every chat. */
export function sayFileFindings(f: FileFindings): string {
  const inTime = f.window !== null ? ` from ${f.window.label}` : '';
  const limit =
    !f.reachedBack && f.oldest !== null
      ? ` ${f.appName}'s list only went back to ${f.oldest}, so an older file may not show — tell me more of the name and I'll look again.`
      : '';
  if (f.files.length === 0) {
    const what = f.asked !== '' ? `a file like ${quote(f.asked)}` : 'a file';
    const undated = f.undated > 0 ? ` (${f.undated} file${f.undated === 1 ? '' : 's'} had a date I could not read, so I left ${f.undated === 1 ? 'it' : 'them'} out)` : '';
    return `I did not find ${what}${inTime} in ${f.appName}'s documents${undated}.${limit || ' Give me more of the name, or say who it was with, and I will look again.'}`;
  }
  if (f.files.length === 1) {
    const file = f.files[0] as DocRow;
    const head = `${quote(file.file)} (${detail(file)}) — ${who(file)} ${file.whenText}`;
    if (f.chat !== null) return `${head}, in ${file.mine ? 'your chat with' : 'the chat with'} ${f.chat}. I have opened that chat on the file.`;
    if (f.notLocated === 'copies') return `${head}. The same file shows ${f.copies} times in ${f.appName} (sent to different chats), and its list does not say which chat each is in. Tell me the day, or who it was for, and I will open it.`;
    if (f.notLocated === 'no_chat') return `${head}. I opened the message but could not read which chat it is in — it is on your screen now.`;
    return `${head}. ${f.appName}'s list does not say which chat it is in, and I could not open its message to find out.${limit}`;
  }
  const shown = f.files.slice(0, 5);
  const lines = shown.map((x, i) => `${i + 1}. ${quote(x.file)} — ${who(x)} ${x.whenText}`).join('; ');
  const more = f.files.length > shown.length ? ` and ${f.files.length - shown.length} more` : '';
  return `I found ${f.files.length} files${inTime}: ${lines}${more}. Which one? Give me more of the name, or the day, and I will open its chat.${limit}`;
}

// ---------------------------------------------------------------------------------------------------------------------- the request
const MONTH_NAMES = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
const DAY_NAMES = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday';
const COUNT_WORD = '\\d{1,3}|a|one|two|three|four|five|six|seven|ten|fifteen';
const TIME_PHRASE = new RegExp(
  `\\b(?:today|yesterday|this morning|(?:this|last|previous|past)\\s+(?:week|month)|(?:in\\s+the\\s+)?(?:past|last)\\s+(?:${COUNT_WORD})\\s+(?:days?|weeks?|months?)|(?:${COUNT_WORD})\\s+(?:days?|weeks?)\\s+ago|on\\s+\\d{1,2}[/.\\-]\\d{1,2}(?:[/.\\-]\\d{2,4})?|on\\s+(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTH_NAMES})(?:\\s+\\d{4})?|(?:in|during)\\s+(?:${MONTH_NAMES})(?:\\s+\\d{4})?|(?:on|last)\\s+(?:${DAY_NAMES}))\\b`,
  'i',
);

/** The words in a request that say WHEN ("last week", "yesterday", "in October", "3 days ago"), or null. Only an explicit time cue: a bare month name may be part of a file's name. */
export function findTimePhrase(text: string): string | null {
  return TIME_PHRASE.exec(text)?.[0] ?? null;
}

export interface FileRequest {
  readonly app: 'whatsapp' | 'telegram' | null;
  /** The words of the file name left after the request's own words are taken out; empty for "this file". */
  readonly words: string;
  /** "this file", "it": the file Eya has just been talking about. */
  readonly deictic: boolean;
  readonly when?: string;
  /** A person who sent the file to the user. */
  readonly from?: string;
  /** Who the user says a file they sent went to (kept to compare with the chat that is found; the list does not show it). */
  readonly to?: string;
  readonly direction: 'sent' | 'received' | 'any';
}

const APP_FUZZY = /\b(whatsapp|whats\s?app|whatsap|whtsapp|watsapp|telegram)\b/i;
const IN_CHATS = /\b(?:in|on|through|across|inside|from)\s+(?:all\s+|my\s+|the\s+|our\s+)*(?:chats?|conversations?)\b/i;
const LOCATE_CUE = /\b(?:where|which\s+chat|what\s+chat|who(?:m)?|find|search|look(?:ing)?|check|locate|track|show|see)\b/i;
const FILE_NOUN = /\b(?:files?|documents?|docs?|pdfs?|attachments?)\b|\.(?:pdf|docx?|xlsx?|pptx?|zip|txt|csv)\b/i;
const SENT_BY_ME = /\b(?:i|we)\s+(?:was\s+|were\s+|have\s+|had\s+|already\s+|just\s+)*(?:sent|send|shared|share|gave|forwarded)\b|\bi['’]?ve\s+(?:sent|shared|forwarded)\b|\bsent\s+by\s+me\b|\bmy\s+sent\b/i;
const NOISE = new Set(
  ('where is are was were did do does i you me my we us check find search look looking for locate show tell which what chat chats conversation conversations who whom to sent send sending shared share gave forwarded received got in on at of from by ' +
    'whatsapp telegram please it there exists available name named called the a an this that these those file files document documents doc docs one so and such someone somebody anyone everyone all any can could would will kindly eya hey okay ok now again ' +
    'earlier before recently few couple some long time out up via using into then also just').split(' '),
);

/**
 * A request to find a file in the chats — "check this file where it is in WhatsApp", "find the resume pdf I sent to Anna last week on WhatsApp", "which chat did I
 * send the fee receipt in" — or null. It needs a chat app (or "in the chats") AND a word that asks to find or locate AND a file; a sending request never is one.
 * Sending a file ("send the pdf to Anna") and finding a file on this PC ("where is my resume") are other jobs, and are left to them.
 */
export function parseFileFinding(raw: string): FileRequest | null {
  const text = raw.trim().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
  const t = text.toLowerCase();
  if (t === '' || /^(?:send|share|forward|message|msg|text|tell|whatsapp|telegram|attach|ping|dm)\b/.test(t)) return null;
  if (/\b(?:and|then)\s+(?:send|share|forward|attach|message)\b/.test(t)) return null;
  const app = APP_FUZZY.exec(t)?.[1];
  if (app === undefined && !IN_CHATS.test(t)) return null;
  if (!LOCATE_CUE.test(t)) return null;
  const sentByMe = SENT_BY_ME.test(t);
  if (!FILE_NOUN.test(t) && !sentByMe) return null;

  const when = findTimePhrase(t);
  let rest = t;
  if (when !== null) rest = rest.replace(when, ' ');
  rest = rest.replace(new RegExp(`(?:\\b(?:in|on|via|through|using|over)\\s+(?:my\\s+)?)?${APP_FUZZY.source}`, 'i'), ' ').replace(IN_CHATS, ' ');
  const fromMatch = /\b(?:from|by|sent\s+by)\s+(?!me\b)([a-z][\w'’.-]*(?:\s+[a-z][\w'’.-]*){0,2})/.exec(rest);
  const from = fromMatch?.[1] !== undefined && !NOISE.has(fromMatch[1].split(' ')[0] as string) ? fromMatch[1].trim() : undefined;
  if (fromMatch !== null && from !== undefined) rest = rest.replace(fromMatch[0], ' ');
  // who a file I sent went to ("... send the fee receipt to Anna"): the last "to <name>" (the list does not show it, so it is only kept to compare with the chat found)
  const toMatch = sentByMe ? [...rest.matchAll(/\bto\s+(?!me\b|my\b|the\b|a\b|an\b|this\b|that\b)([a-z][\w'’.-]*(?:\s+[a-z][\w'’.-]*)?)/g)].pop() : undefined;
  const to = toMatch?.[1] !== undefined && !NOISE.has(toMatch[1].split(' ')[0] as string) ? toMatch[1].trim() : undefined;
  if (toMatch !== undefined && to !== undefined) rest = rest.replace(toMatch[0], ' ');

  const words = rest
    .replace(/[^\p{L}\p{N}.'’\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '' && !NOISE.has(w.replace(/['’]s$/, '')))
    .join(' ')
    .trim();
  const deictic = words === '' && /\b(?:this|that|it|same)\b/.test(t);
  const direction: FileRequest['direction'] = sentByMe ? 'sent' : from !== undefined ? 'received' : 'any';
  return {
    app: app === undefined ? null : /telegram/i.test(app) ? 'telegram' : 'whatsapp',
    words,
    deictic,
    ...(when !== null ? { when } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    direction,
  };
}
