import type { LocalCommandResult } from '@main/local/LocalCommands';
import type { WordAnswer, WordCommand } from './WordControl';

/**
 * The everyday Word commands, said or typed to Eya, done at once and without the model: "add page numbers", "insert a table of contents",
 * "page break", "bold this", "centre this", "undo that", "save the document", "type in Word: ...".
 *
 * Only exact phrasings are taken — anything else goes on to the model, which has the full set of Word tools. And like Writing Watch's
 * commands, never from always-on listening: these change the user's document.
 *
 * Two kinds, so that a sentence meant for another program is not taken for Word:
 *  - document commands (page numbers, contents, the index) can only mean a document: done when Word has one open;
 *  - the rest ("bold this", "page break", "undo", "save it", "go to the end") act at the cursor, so they are done only while Word is the
 *    window the user is working in.
 */

export interface WordIntent {
  /** `document`: needs Word to have a document open. `front`: needs Word to be the window in front as well. */
  readonly scope: 'document' | 'front';
  /** What is said when it worked: fixed words, or built from what Word answered (how many were filled, which could not be found). */
  readonly say: string | ((answer: WordAnswer) => string);
  readonly cmd: WordCommand;
  readonly args: Record<string, unknown>;
}

const clean = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[,!?;]+/g, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ') // a full stop is a pause; the point in 1.5 is a number
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:hey |ok |okay )?eya /, '')
    .replace(/^(?:please|can you|could you|kindly) /, '')
    .replace(/ (?:please|now|for me|once)$/g, '')
    .trim();

const doc = (say: WordIntent['say'], cmd: WordCommand, args: Record<string, unknown> = {}): WordIntent => ({ scope: 'document', say, cmd, args });

/** "Filled 6 entries of the index. I could not find Annexure P-7 and Annexure P-9." — short enough to say aloud. */
function indexReply(a: WordAnswer): string {
  const filled = typeof a['filled'] === 'number' ? a['filled'] : 0;
  const missing = Array.isArray(a['notFound']) ? (a['notFound'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const short = (s: string): string => (s.length > 40 ? `${s.slice(0, 38).trim()}…` : s);
  const list = missing.slice(0, 3).map(short);
  const more = missing.length > 3 ? ` and ${missing.length - 3} more` : '';
  const lost = missing.length === 0 ? '' : ` I could not find ${list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0]}${more} in the document, so I left those empty.`;
  if (filled === 0) return `I could not find any of the index entries in the document.${lost}`.trim();
  return `Filled ${filled} ${filled === 1 ? 'entry' : 'entries'} of the index.${lost}`;
}
const front = (say: string, cmd: WordCommand, args: Record<string, unknown> = {}): WordIntent => ({ scope: 'front', say, cmd, args });
const format = (say: string, props: Record<string, unknown>): WordIntent => front(say, 'format', { target: 'selection', ...props });

const THIS = '(?:this|that|it|the selection|selected text|this paragraph|that paragraph|this heading|this line|the paragraph|the heading)';
const ALIGN: Readonly<Record<string, string>> = { left: 'left', right: 'right', center: 'center', centre: 'center', justify: 'justify', justified: 'justify' };
const NUMBER_WORDS: Readonly<Record<string, number>> = { two: 2, three: 3, four: 4, five: 5 };
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "10", "ten", "twenty five", "twenty-five", "a hundred" -> 10 / 10 / 25 / 25; null when it is not a page number. */
export function pageNumberFrom(raw: string): number | null {
  const s = raw.trim().replace(/-/g, ' ').replace(/\s+/g, ' ');
  if (/^\d{1,4}$/.test(s)) {
    const n = Number(s);
    return n >= 1 ? n : null;
  }
  const words = s.split(' ');
  let total = 0;
  for (const w of words) {
    const one = ONES.indexOf(w);
    if (one > 0) total += one;
    else if (TENS[w] !== undefined) total += TENS[w] as number;
    else if (w === 'hundred' && total > 0) total *= 100;
    else if (w === 'a' && words.length === 2 && words[1] === 'hundred') total = 1;
    else return null;
  }
  return total >= 1 ? total : null;
}

const spacingOf = (word: string): number => (word === 'single' ? 1 : word === 'double' ? 2 : 1.5);
const spacingName = (v: number): string => (v === 1 ? 'single' : v === 2 ? 'double' : '1.5');

const PAGE_NUMBERS_ADD = new RegExp(
  '^(?:add|insert|put|put in|include|show)(?: the)?(?: page numbers?| page numbering)' +
    '(?: (?:in|to|on) (?:the |this |my )?(?:document|word|petition|page|file|footer|draft))?' +
    '(?: (?:at|in|on) (?:the )?(?:top|bottom|header|footer)(?: of (?:the )?(?:page|document|petition))?)?' +
    '(?: (?:on the )?(?:left|right|center|centre|middle))?' +
    '(?: (?:as )?page (?:number )?(?:x|n|1) of (?:y|m|n|total))?$',
);

export function parseWordIntent(raw: string): WordIntent | null {
  const original = raw.trim();
  const text = clean(raw);
  if (text === '' || text.split(' ').length > 16) return null;

  // "type in Word: <what to write>" — the words after it, exactly as said.
  const dictation = /^(?:type|write|dictate|insert|add) (?:this |the following |the text )?(?:in|into) (?:word|the document|the petition|my document)[:,]?\s+(.+)$/is.exec(original);
  if (dictation !== null && (dictation[1] ?? '').trim().length > 0) return front('Written.', 'write', { text: (dictation[1] ?? '').trim() });

  // ------------------------------------------------------------------------------------------------ document commands
  if (/^(?:remove|delete|take off|take out|clear) (?:the )?page numbers?(?: from (?:the )?(?:document|petition|footer|header))?$/.test(text)) {
    return doc('Removed the page numbers.', 'page_numbers', { remove: true });
  }
  if (PAGE_NUMBERS_ADD.test(text) || /^(?:number|page number) (?:the )?(?:pages|document|petition)$/.test(text)) {
    const ofTotal = /\bof (?:y|m|total)\b/.test(text);
    return doc(ofTotal ? 'Added page numbers, Page X of Y.' : 'Added page numbers.', 'page_numbers', {
      where: /\b(?:header|top)\b/.test(text) ? 'header' : 'footer',
      align: /\bleft\b/.test(text) ? 'left' : /\bright\b/.test(text) ? 'right' : 'center',
      format: ofTotal ? 'page_n_of_m' : 'number',
    });
  }
  // "fill the running index", "fill the index in my writ": an index table that is already there gets its page numbers, in one go
  const OF_DOC = '(?: (?:in|of|for|on|to) (?:the |my |this |that )?(?:document|writ|petition|writ petition|writ petition file|file|draft|word|word file))?';
  if (
    new RegExp(`^(?:fill|fill in|fill up|complete|finish|prepare|do|make|build)(?: in)? (?:the |my |this )?(?:running )?index(?: page numbers| page nos| table| pages| with page numbers)?${OF_DOC}$`).test(text) ||
    new RegExp(`^(?:fill|fill in|fill up|complete)(?: in)? (?:the )?page (?:numbers|nos)(?: in| of| for| on) (?:the |my |this )?(?:running )?index${OF_DOC}$`).test(text)
  ) {
    return doc(indexReply, 'fill_index');
  }
  if (/^(?:add|insert|make|create|put|build)(?: in)? (?:a |the |my )?(?:table of contents|contents page|contents list|toc)(?: (?:here|at the start|at the top|at the beginning))?$/.test(text)) {
    return doc('Added the table of contents.', 'toc', /\b(?:start|top|beginning)\b/.test(text) ? { at: 'start', title: 'TABLE OF CONTENTS' } : { title: 'TABLE OF CONTENTS' });
  }
  if (/^(?:update|refresh|recalculate) (?:the |all )?(?:table of contents|contents|toc|index|page numbers?|fields|references)(?: (?:and|&) (?:the )?(?:index|page numbers?|table of contents|contents))?$/.test(text)) {
    return doc('Updated the contents, index and page numbers.', 'fields');
  }

  // ------------------------------------------------------------------------------------- commands for the document in front
  if (/^(?:insert|add|put|start|give me) (?:in )?(?:a )?(?:new page|page break|new page break)$/.test(text) || text === 'new page' || text === 'page break') {
    return front('Added a page break.', 'break', { kind: 'page' });
  }
  let m = new RegExp(`^(bold|italic|underline)(?: ${THIS})?$`).exec(text);
  if (m !== null) return format(`Made it ${m[1]}.`, { [m[1] as string]: true });
  m = new RegExp(`^(?:make|set) ${THIS} (bold|italic|underlined?)$`).exec(text);
  if (m !== null) return format(`Made it ${m[1]}.`, { [m[1]?.startsWith('underline') ? 'underline' : (m[1] as string)]: true });
  if (new RegExp(`^(?:un-?bold|remove (?:the )?bold(?: from)?|take the bold off)(?: ${THIS})?$`).test(text)) return format('Removed the bold.', { bold: false });

  const alignWord =
    new RegExp(`^(center|centre|justify)(?: ${THIS})?$`).exec(text)?.[1] ??
    new RegExp(`^(?:align|set alignment)(?: ${THIS})?(?: to)? (left|right|center|centre|justify)$`).exec(text)?.[1] ??
    new RegExp(`^(left|right) align(?:ed)?(?: ${THIS})?$`).exec(text)?.[1] ??
    new RegExp(`^(?:make|set) (?:${THIS} )?(?:to |as )?(left|right|center|centre|justified|justify)(?: aligned?)?$`).exec(text)?.[1];
  if (alignWord !== undefined && ALIGN[alignWord] !== undefined) return format(`Aligned it ${ALIGN[alignWord]}.`, { align: ALIGN[alignWord] });

  m = new RegExp(`^(?:make|set) (?:${THIS} )?(?:to |as )?(single|double|one and a half|one point five|1\\.5) (?:line )?spac(?:ed|ing)$`).exec(text) ??
    /^(?:set |make )?(?:line spacing|spacing)(?: to)? (single|double|1\.5|one and a half|one point five)$/.exec(text);
  if (m !== null) {
    const v = spacingOf(m[1] as string);
    return format(`Set the spacing to ${spacingName(v)}.`, { lineSpacing: v });
  }
  m = new RegExp(`^(?:make|set) (?:${THIS} )?(?:a |to |as )?(heading 1|heading 2|heading 3|heading one|heading two|heading three|title|normal text|normal|body text)$`).exec(text);
  if (m !== null) {
    const raw = (m[1] as string).replace('one', '1').replace('two', '2').replace('three', '3').replace('normal text', 'normal').replace('body text', 'normal');
    const style = raw.replace(/^./, (c) => c.toUpperCase());
    return format(`Made it ${style}.`, { style });
  }
  m = new RegExp(`^(?:make|set|change) (?:the )?(?:font|text)(?: size)?(?: of ${THIS})? (?:to |as )?(\\d{1,2})(?: points?| pt)?$`).exec(text);
  if (m !== null) return format(`Set the size to ${m[1]}.`, { fontSize: Number(m[1]) });

  // Pages: "go to page 10", "page ten", "next page", "previous page", "go to the last page"; and scrolling the view.
  m = /^(?:go to|jump to|open|show|show me|take me to|move to|scroll to|turn to)(?: the)? page(?: number| no)? ([a-z0-9 -]{1,24})$/.exec(text) ?? /^page ([a-z0-9 -]{1,24})$/.exec(text);
  if (m !== null) {
    const n = pageNumberFrom(m[1] as string);
    if (n !== null) return front(`Page ${n}.`, 'goto', { page: n });
  }
  if (/^(?:go to|jump to|show|show me|move to|turn to)(?: the)? next page$/.test(text) || text === 'next page' || text === 'page down') {
    return front('Next page.', 'goto', { where: 'next_page' });
  }
  if (/^(?:go to|jump to|show|show me|move to|turn to|go back to)(?: the)? previous page$/.test(text) || text === 'previous page' || text === 'page up' || text === 'go back a page') {
    return front('Previous page.', 'goto', { where: 'previous_page' });
  }
  if (/^(?:go to|jump to|show|move to)(?: the)? last page$/.test(text) || /^(?:go to|jump to|move to) the (?:very )?end$/.test(text)) return front('At the end.', 'goto', { where: 'end' });
  if (/^(?:go to|jump to|show|move to)(?: the)? first page$/.test(text)) return front('At the start.', 'goto', { where: 'start' });
  m = /^scroll (down|up)(?: (?:by |for )?(a|one|two|three|four|five|a few|\d{1,2})? ?(?:pages?|screens?|bit|little|more))?$/.exec(text);
  if (m !== null) {
    const times = m[2] === undefined ? 1 : m[2] === 'a few' ? 3 : (NUMBER_WORDS[m[2]] ?? (m[2] === 'a' || m[2] === 'one' ? 1 : Number(m[2])));
    return front(`Scrolled ${m[1]}.`, 'scroll', { direction: m[1], times: Number.isFinite(times) && times > 0 ? times : 1 });
  }
  if (text === 'scroll' || text === 'scroll down') return front('Scrolled down.', 'scroll', { direction: 'down', times: 1 });

  if (/^(?:undo|undo that|undo it|undo this|undo the last (?:change|thing|step)|take that back|go back one step)$/.test(text)) return front('Undone.', 'undo', { times: 1 });
  m = /^undo (?:the last )?(\d{1,2}|two|three|four|five) (?:changes|steps|things)$/.exec(text);
  if (m !== null) {
    const n = NUMBER_WORDS[m[1] as string] ?? Number(m[1]);
    return front(`Undid ${n} steps.`, 'undo', { times: n });
  }
  if (/^(?:redo|redo that|redo it|bring that back)$/.test(text)) return front('Redone.', 'redo', { times: 1 });
  if (/^(?:save|save it|save this|save that|save the (?:document|file|petition|draft)|save (?:this|my) (?:document|file|petition|draft))$/.test(text)) return front('Saved.', 'save');
  if (/^(?:new paragraph|next paragraph|start a new paragraph|press enter)$/.test(text)) return front('New paragraph.', 'write', { text: '\n', at: 'cursor', newParagraph: false });
  if (/^(?:go to|jump to|move to) (?:the )?(?:end|bottom|last line)(?: of (?:the )?(?:document|petition|page|file))?$/.test(text)) return front('At the end.', 'goto', { where: 'end' });
  if (/^(?:go to|jump to|move to) (?:the )?(?:start|top|beginning|first line)(?: of (?:the )?(?:document|petition|page|file))?$/.test(text)) return front('At the start.', 'goto', { where: 'start' });
  return null;
}

interface WindowFacts {
  readonly pid: number;
  readonly process: string;
  readonly state: string;
  readonly foreground: boolean;
}

/**
 * Whether Word is the window the user is working in: it has the focus, or Eya's OWN window has it (Talk mode and the quick panel are
 * started from there) and the window right behind it — the list is in front-to-back order — is Word.
 */
export function workingInWord(windows: readonly WindowFacts[], ownPids: ReadonlySet<number>): boolean {
  const focused = windows.find((w) => w.foreground);
  if (focused === undefined) return false;
  if (focused.process.toLowerCase() === 'winword') return true;
  if (!ownPids.has(focused.pid)) return false;
  const behind = windows.find((w) => !ownPids.has(w.pid) && w.state !== 'minimized');
  return behind !== undefined && behind.process.toLowerCase() === 'winword';
}

/** What the commands need from the outside. */
export interface WordCommandsHost {
  run(cmd: WordCommand, args?: Record<string, unknown>): Promise<WordAnswer>;
  /** Whether Word is the window the user is working in right now. */
  wordIsInFront(): Promise<boolean>;
}

const reply = (spoken: string, ok: boolean): LocalCommandResult => ({ spoken, ok, intent: 'word', tools: [], refs: [] });

export class WordCommands {
  constructor(private readonly host: WordCommandsHost) {}

  async tryHandle(text: string, options: { readonly live?: boolean } = {}): Promise<LocalCommandResult | null> {
    // These change the user's document: never from sound picked up in the room.
    if (options.live === true) return null;
    const intent = parseWordIntent(text);
    if (intent === null) return null;
    // A sentence meant for another program is not Word's: the model decides then.
    if (intent.scope === 'front' && !(await this.host.wordIsInFront())) return null;
    const status = await this.host.run('status');
    if (!status.ok || status['found'] !== true) return null; // no document open: nothing here to do, and the model can say so
    const answer = await this.host.run(intent.cmd, intent.args);
    if (answer['needsConfirm'] === true) return reply(`${String(answer.why ?? 'That is a big change')}. Tell me to go ahead if you want it.`, false);
    // "fill the index" when there is no index table to fill is not a failure to report: the model can make one from the headings.
    if (!answer.ok && intent.cmd === 'fill_index' && /no table|could not find an index table|no \"page\" column/i.test(String(answer.why ?? ''))) return null;
    if (!answer.ok) return reply(`${String(answer.why ?? 'Word would not do that')}.`, false);
    return reply(typeof intent.say === 'function' ? intent.say(answer) : intent.say, true);
  }
}
