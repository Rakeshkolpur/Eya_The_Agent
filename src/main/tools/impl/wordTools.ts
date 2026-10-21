import type { WordAnswer, WordCommand } from '@main/word/WordControl';
import type { Tool, ToolArgs, ToolResult } from '../types';

/**
 * Microsoft Word, in the document the user has open: write into it, format it, and build its page numbers, table of contents, list of
 * dates and events, and a running index — through Word's own automation interface on this PC.
 *
 * Six tools, deliberately: every tool is read by the model on every turn. Each change Eya makes is ONE undo step in Word (Ctrl+Z takes it
 * back), a read-only or protected document is refused, and nothing is saved, closed or printed unless the user asked. Reading the text is
 * only done when the request needs it, in short pieces.
 */
export interface WordToolDeps {
  readonly word: { run(cmd: WordCommand, args?: Record<string, unknown>): Promise<WordAnswer> };
  readonly now?: () => number;
}

/** A model that keeps reading page after page is looping, not working: after this many reads in a row it is stopped and told what to do. */
const READS_IN_A_ROW_LIMIT = 10;
const READ_STREAK_WINDOW_MS = 90_000;

type Bag = Record<string, unknown>;

function text(args: ToolArgs, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** Text as given, spaces and line breaks included (what is to be written must not be trimmed). */
function raw(args: ToolArgs, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(args: ToolArgs, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function flag(args: ToolArgs, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === 'boolean' ? v : undefined;
}

/** Copies the named arguments that were actually given, so the helper can tell "false" from "not said". */
function pick(args: ToolArgs, keys: readonly string[]): Bag {
  const out: Bag = {};
  for (const k of keys) {
    const v = args[k];
    if (v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')) out[k] = v;
  }
  return out;
}

function failure(summary: string, error: string, data?: Bag): ToolResult {
  return { ok: false, summary, error, ...(data !== undefined ? { data } : {}) };
}

/** An answer from the helper as a result the model can use: what failed in words, or the facts. */
function toResult(answer: WordAnswer, summary: string, extra: Bag = {}): ToolResult {
  if (answer['needsConfirm'] === true) {
    const { ok: _ok, why, needsConfirm: _n, id: _id, ...rest } = answer as Record<string, unknown>;
    return failure('needs confirmation', `${String(why ?? 'This is a big change')}. Tell the user what it would do and ask whether to go ahead; call again with confirm=true only after they say yes. (It can be undone in Word with Ctrl+Z either way.)`, {
      needsConfirmation: true,
      ...rest,
    });
  }
  if (!answer.ok) {
    const why = typeof answer.why === 'string' && answer.why.length > 0 ? answer.why : 'Word would not do that';
    const missingWord = why === 'Word is not open' || why === 'no document is open in Word';
    return failure(missingWord ? 'Word is not open' : 'Word would not do that', why + (missingWord ? '. Open Word (open_application "Word") or ask the user to open the document first.' : '.'));
  }
  const { ok: _ok, id: _id, why: _why, ...facts } = answer as Record<string, unknown>;
  return { ok: true, summary, data: { ...facts, ...extra } };
}

function parseOptions(args: ToolArgs, example: string): { options: Bag } | { error: ToolResult } {
  const given = text(args, 'options');
  if (given === undefined) return { options: {} };
  try {
    const value: unknown = JSON.parse(given);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return { options: value as Bag };
  } catch {
    return { error: failure('bad options', `options must be a JSON object, for example ${example}`) };
  }
}

const KINDS = ['page_numbers', 'table_of_contents', 'table', 'index', 'fill_index', 'header', 'footer', 'page_setup', 'page_break', 'section_break', 'update_fields'] as const;
const EDIT_KINDS = ['find_replace', 'delete', 'undo', 'redo', 'save', 'goto', 'scroll', 'new_document'] as const;

const TARGETS =
  'a target: "selection" (the selected text, or the paragraph the cursor is in), "document", "first", "last", "paragraph:5", ' +
  '"paragraphs:3-7", "heading:Prayer" (the heading with those words), "containing:some words" (the paragraph that has them), ' +
  '"find:some words" (just that text, the first time it appears) or "findall:some words" (every place). Paragraph numbers come from word_status / word_read.';

export function createWordTools(deps: WordToolDeps): Tool[] {
  const { word } = deps;
  const now = deps.now ?? Date.now;
  let readsInARow = 0;
  let lastReadAt = 0;

  const status: Tool = {
    schema: {
      name: 'word_status',
      status: 'Looking at the Word document…',
      description:
        'What is open in Microsoft Word right now: the document in front (name, pages, words, tables, whether it has page numbers or a table of ' +
        'contents, header and footer text), where the cursor is, and the document\'s headings with their paragraph numbers and pages. Call it first ' +
        'whenever the user wants something done in Word, and again when you need paragraph numbers. It reads only headings and counts, not the body text.',
      args: {},
    },
    async execute(): Promise<ToolResult> {
      const answer = await word.run('status');
      if (answer.ok && answer['found'] === false) {
        return failure('Word is not open', `${String(answer.why ?? 'Word is not open')}. Open Word (open_application "Word") or ask the user to open the document first.`);
      }
      const name = typeof answer['name'] === 'string' ? answer['name'] : 'the document';
      const pages = typeof answer['pages'] === 'number' ? answer['pages'] : 0;
      return toResult(answer, `${name}: ${pages} page${pages === 1 ? '' : 's'}`);
    },
  };

  const read: Tool = {
    schema: {
      name: 'word_read',
      status: 'Reading the Word document…',
      description:
        'Read the open Word document, or SEARCH it. To find where something is (a placeholder like "P1", a name, a clause, a date) use `find`: ' +
        'it returns every place (paragraph number, the words around it, and the page for the first few) in ONE call — never page through the document ' +
        'looking for it. Without `find` it returns paragraphs as text, up to 120 at a time (from / to / last; with none it is around the cursor). ' +
        'Only formatting (style, alignment, bold, size) is slow, so ask for `detail` only when it matters, for at most 10 paragraphs. Read only what ' +
        'the request needs; never read the document out loud unless the user asks, and say in one short sentence what you looked at.',
      args: {
        find: { type: 'string', description: 'Search for these words; returns the places that have them.' },
        matchCase: { type: 'boolean', description: 'With find: match capital letters exactly.' },
        from: { type: 'number', description: 'First paragraph number to read.' },
        to: { type: 'number', description: 'Last paragraph number to read (default: 30 from `from`; at most 120).' },
        last: { type: 'number', description: 'Read the last N paragraphs instead.' },
        detail: { type: 'boolean', description: 'Add style, alignment, bold and size for the first 10 paragraphs returned.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const at = now();
      if (at - lastReadAt > READ_STREAK_WINDOW_MS) readsInARow = 0;
      lastReadAt = at;
      readsInARow += 1;
      if (readsInARow > READS_IN_A_ROW_LIMIT) {
        return failure(
          'too many reads',
          `You have read the document ${readsInARow - 1} times in a row without doing anything with it. Stop reading page by page: use word_read with find to ` +
            'locate words, word_edit goto with page to go to a page, or tell the user what you could not find and ask them.',
        );
      }
      const find = text(args, 'find');
      const answer = await word.run('read', pick(args, ['find', 'matchCase', 'from', 'to', 'last', 'detail']));
      if (find !== undefined) {
        const total = typeof answer['total'] === 'number' ? answer['total'] : 0;
        return toResult(answer, total === 0 ? `"${find}" is not in the document` : `found "${find}" in ${total} paragraph${total === 1 ? '' : 's'}`);
      }
      const from = typeof answer['from'] === 'number' ? answer['from'] : 0;
      const to = typeof answer['to'] === 'number' ? answer['to'] : 0;
      return toResult(answer, `read paragraphs ${from} to ${to}`);
    },
  };

  const write: Tool = {
    schema: {
      name: 'word_write',
      status: 'Writing in Word…',
      description:
        'Type text into the open Word document: this is how to write, dictate or add to it. `text` can hold several paragraphs (separate them with a ' +
        'line break). Give `at` to say where: "cursor" (default — where the user is typing), "end", "start", "after:<target>", "before:<target>" or ' +
        '"replace_selection". Targets are like paragraph:5, heading:Prayer, containing:some words, last. A new paragraph takes on the formatting of the one ' +
        'before it, as typing does (after a heading it becomes normal text). To change how it looks give style / bold / align / fontSize... here, or use ' +
        'word_format afterwards. It is one undo step in Word. Write exactly the words the user dictated unless they asked you to draft.',
      args: {
        text: { type: 'string', required: true, description: 'What to write. Several paragraphs: separate with line breaks.' },
        at: { type: 'string', description: 'Where: cursor (default), end, start, after:<target>, before:<target>, replace_selection.' },
        style: { type: 'string', description: 'A Word style for the new paragraphs: Normal, Heading 1, Heading 2, Heading 3, Title, Subtitle, List Bullet, List Number, Quote, or a style name the document has.' },
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        underline: { type: 'boolean' },
        align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
        fontName: { type: 'string', description: 'For example Times New Roman, Arial, Calibri.' },
        fontSize: { type: 'number', description: 'Points, for example 12.' },
        color: { type: 'string', description: 'A colour name (red, blue, black...) or #RRGGBB.' },
        newParagraph: { type: 'boolean', description: 'Default true: when the cursor is at the end of a line that has text, start a new paragraph. false keeps writing on the same line.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const body = raw(args, 'text');
      if (body === undefined) return failure('no text', 'There is no text to write.');
      const answer = await word.run('write', { text: body, ...pick(args, ['at', 'style', 'bold', 'italic', 'underline', 'align', 'fontName', 'fontSize', 'color', 'newParagraph']) });
      const p = answer['paragraphs'] as { from?: number; to?: number } | undefined;
      return toResult(answer, p?.from !== undefined ? `wrote ${body.length} characters in paragraph${p.to !== p.from ? 's' : ''} ${p.from}${p.to !== p.from ? `–${String(p.to)}` : ''}` : 'wrote the text');
    },
  };

  const format: Tool = {
    schema: {
      name: 'word_format',
      status: 'Formatting the Word document…',
      description:
        'Change how text looks in the open Word document. `target` is ' + TARGETS + ' With no target it is the selection (or the cursor\'s paragraph). ' +
        'Give only what should change: character look (bold, italic, underline, fontName, fontSize, color, highlight, allCaps), paragraph look (align, ' +
        'lineSpacing 1 / 1.15 / 1.5 / 2, spaceBefore / spaceAfter in points, indents in cm), a style (Normal, Heading 1..3, Title), a list (bullets / ' +
        'numbers / none). Setting a style clears the old manual formatting first. One undo step in Word.',
      args: {
        target: { type: 'string', description: 'What to format (see above). Default: the selection.' },
        style: { type: 'string', description: 'Normal, Heading 1, Heading 2, Heading 3, Title, Subtitle, List Bullet, List Number, Quote, or a style the document has.' },
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        underline: { type: 'boolean' },
        strike: { type: 'boolean' },
        allCaps: { type: 'boolean' },
        smallCaps: { type: 'boolean' },
        fontName: { type: 'string' },
        fontSize: { type: 'number', description: 'Points.' },
        color: { type: 'string', description: 'A colour name or #RRGGBB.' },
        highlight: { type: 'string', enum: ['yellow', 'green', 'turquoise', 'pink', 'blue', 'red', 'gray', 'none'] },
        align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
        lineSpacing: { type: 'number', description: '1 = single, 1.5, 2 = double, or 1.15 etc.' },
        spaceBefore: { type: 'number', description: 'Points above each paragraph.' },
        spaceAfter: { type: 'number', description: 'Points below each paragraph.' },
        leftIndentCm: { type: 'number' },
        rightIndentCm: { type: 'number' },
        firstLineIndentCm: { type: 'number' },
        list: { type: 'string', enum: ['bullets', 'numbers', 'none'] },
        keepWithNext: { type: 'boolean' },
        pageBreakBefore: { type: 'boolean' },
        clear: { type: 'boolean', description: 'Remove all manual formatting from the target first.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const spec = pick(args, [
        'target', 'style', 'bold', 'italic', 'underline', 'strike', 'allCaps', 'smallCaps', 'fontName', 'fontSize', 'color', 'highlight', 'align',
        'lineSpacing', 'spaceBefore', 'spaceAfter', 'leftIndentCm', 'rightIndentCm', 'firstLineIndentCm', 'list', 'keepWithNext', 'pageBreakBefore', 'clear',
      ]);
      if (Object.keys(spec).filter((k) => k !== 'target').length === 0) {
        return failure('nothing to change', 'Say what to change: bold, italic, size, alignment, spacing, a style, a list...');
      }
      const answer = await word.run('format', spec);
      const applied = Array.isArray(answer['applied']) ? (answer['applied'] as string[]).join(', ') : 'formatting';
      return toResult(answer, `applied ${applied}`);
    },
  };

  const structure: Tool = {
    schema: {
      name: 'word_structure',
      status: 'Building the document structure…',
      description:
        'Page numbers, table of contents, tables (a list of dates and events), a running index, headers, footers, page setup and breaks in the open ' +
        'Word document. `kind` picks one; `options` is a JSON object for it; `at` is where a block goes (cursor, start, end, after:<target>, before:<target>). ' +
        'KINDS — ' +
        'page_numbers: {"where":"footer"|"header","align":"center"|"left"|"right","format":"number"|"page_n"|"page_n_of_m"|"n_of_m"|"dash","startAt":1,"skipFirstPage":false,"remove":false} (live fields: they follow the document). ' +
        'table_of_contents: {"levels":3,"title":"TABLE OF CONTENTS","replace":false,"remove":false} from the heading styles (mark headings with word_format style Heading 1 first); one that exists is updated. ' +
        'table: {"rows":[["S.No","Date","Event"],["1","12.03.2020","…"]],"header":true,"title":"LIST OF DATES AND EVENTS","widths":[8,22,70]} to make one; ' +
        '{"rows":[["05.04.2021","Notice issued"]],"append":true,"tableIndex":1} to add rows to an existing one (the S.No column is numbered on). ' +
        'index: {"entries":[{"particulars":"Synopsis","find":"SYNOPSIS"},{"particulars":"Annexure P-1","find":"ANNEXURE P-1","end":"last words of it"}],"title":"INDEX"} — a running index: each page number is a live field pointing at that place in the document, so it follows as the document grows; entries it cannot find are returned in "missing". ' +
        'fill_index: "fill the running index" when the petition ALREADY has its INDEX table (S.No / Particulars / Page No.) with empty page cells: options ' +
        '{} (optional {"table":2,"ranges":true,"fields":true}). ONE call: it reads each particular, finds that part in the document (an "Annexure P-1" ' +
        'line, a heading) and puts its page in the cell as a live page reference; what it could not find comes back in notFound — tell the user which. ' +
        'Never do this by reading the document yourself. ' +
        'header / footer: {"text":"Writ Petition No. 123 of 2026   Page {PAGE} of {NUMPAGES}","align":"center","bold":false}. ' +
        'page_setup: {"paper":"a4"|"legal"|"letter"|"a3"|"a5","orientation":"portrait"|"landscape","marginTopCm":2.54,"marginBottomCm":2.54,"marginLeftCm":3,"marginRightCm":2}. ' +
        'page_break / section_break: put a break at `at`. update_fields: refresh page numbers, the contents list and the index (after the document changed). ' +
        'One undo step in Word each.',
      args: {
        kind: { type: 'string', required: true, enum: KINDS },
        options: { type: 'string', description: 'A JSON object with the settings for this kind (see above).' },
        at: { type: 'string', description: 'Where a table / contents / index / break goes: cursor (default), start, end, after:<target>, before:<target>.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const kind = text(args, 'kind') as (typeof KINDS)[number] | undefined;
      if (kind === undefined || !KINDS.includes(kind)) return failure('unknown kind', `kind must be one of: ${KINDS.join(', ')}.`);
      const parsed = parseOptions(args, '{"where":"footer","align":"center","format":"page_n_of_m"}');
      if ('error' in parsed) return parsed.error;
      const options = parsed.options;
      const at = text(args, 'at');
      const withAt: Bag = at !== undefined ? { at } : {};

      switch (kind) {
        case 'page_numbers': {
          const a = await word.run('page_numbers', options);
          return toResult(a, a['removed'] === true ? 'removed the page numbers' : `added page numbers (${String(a['format'] ?? 'number')}) in the ${String(a['where'] ?? 'footer')}`);
        }
        case 'table_of_contents': {
          const a = await word.run('toc', { ...options, ...withAt });
          return toResult(a, a['removed'] !== undefined ? 'removed the table of contents' : a['updated'] === true ? 'updated the table of contents' : 'added the table of contents');
        }
        case 'table': {
          const rows = options['rows'];
          if (!Array.isArray(rows) || rows.length === 0 || !rows.every((r) => Array.isArray(r))) {
            return failure('bad options', 'options.rows must be a list of rows, each a list of cell texts, for example {"rows":[["S.No","Date","Event"],["1","12.03.2020","Order passed"]]}.');
          }
          const a = await word.run('table', { ...options, rows: (rows as unknown[][]).map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c)))), ...withAt });
          return toResult(a, a['appended'] === true ? `added ${String(a['rows'])} row(s) to the table` : `inserted a table of ${String(a['rows'])} rows`);
        }
        case 'index': {
          const entries = options['entries'];
          if (!Array.isArray(entries) || entries.length === 0 || !entries.every((e) => typeof e === 'object' && e !== null && typeof (e as Bag)['particulars'] === 'string')) {
            return failure('bad options', 'options.entries must be a list of {"particulars":"…","find":"words that start that part of the document"} objects.');
          }
          const a = await word.run('index', { ...options, ...withAt });
          const missing = Array.isArray(a['missing']) ? (a['missing'] as unknown[]).length : 0;
          return toResult(a, `built the index with ${String(a['entries'])} entries${missing > 0 ? ` (${missing} not found in the document)` : ''}`);
        }
        case 'fill_index': {
          // The index table is already in the document with its page cells empty: ONE call does all of it, with no entries to give.
          const a = await word.run('fill_index', options);
          const missing = Array.isArray(a['notFound']) ? (a['notFound'] as unknown[]) : [];
          const filled = typeof a['filled'] === 'number' ? a['filled'] : 0;
          const result = toResult(a, `filled ${filled} page number${filled === 1 ? '' : 's'} of the index${missing.length > 0 ? `; ${missing.length} not found in the document` : ''}`);
          return result;
        }
        case 'header':
        case 'footer': {
          if (typeof options['text'] !== 'string') return failure('bad options', `options.text is the words for the ${kind}, for example {"text":"Page {PAGE} of {NUMPAGES}"}.`);
          const a = await word.run('header_footer', { ...options, where: kind });
          return toResult(a, `set the ${kind}`);
        }
        case 'page_setup': {
          const a = await word.run('page_setup', options);
          return toResult(a, 'changed the page setup');
        }
        case 'page_break':
        case 'section_break': {
          const a = await word.run('break', { kind: kind === 'page_break' ? 'page' : 'section', ...withAt });
          return toResult(a, kind === 'page_break' ? 'inserted a page break' : 'inserted a section break');
        }
        case 'update_fields': {
          const a = await word.run('fields');
          return toResult(a, `updated the page numbers, contents and index (${String(a['pages'] ?? '?')} pages)`);
        }
      }
    },
  };

  const edit: Tool = {
    schema: {
      name: 'word_edit',
      status: 'Editing the Word document…',
      description:
        'Edit or manage the open Word document. `kind`: find_replace (find + replace; changes every place, and asks first when there are many), ' +
        'delete (target — see word_format for targets — and it asks first when it would remove more than a sentence or two), undo / redo (times: how many ' +
        'steps — each thing Eya did is one step), goto (move the cursor and show it: `page` N for "go to page 10", or where = next_page / previous_page / ' +
        'start / end / target / after with target — ONE call does it, never find a page by reading), scroll (move the view, not the cursor: direction down ' +
        'or up, times = how many screens), save (saves the document under its own name; one that has never been saved cannot be saved from here — ask ' +
        'the user where), new_document (a new blank document). ' +
        'For delete and find_replace the first answer may be a question: ask the user, and only after a clear yes call again with confirm=true.',
      args: {
        kind: { type: 'string', required: true, enum: EDIT_KINDS },
        page: { type: 'number', description: 'For goto: the page number to go to ("go to page 10" is page 10).' },
        direction: { type: 'string', enum: ['down', 'up'], description: 'For scroll.' },
        target: { type: 'string', description: 'For delete and goto: what (see word_format).' },
        find: { type: 'string', description: 'For find_replace: the text to look for (up to 250 characters).' },
        replace: { type: 'string', description: 'For find_replace: what to put instead (may be empty to remove the text).' },
        matchCase: { type: 'boolean' },
        times: { type: 'number', description: 'For undo / redo: how many steps (default 1). For scroll: how many screens (default 1).' },
        where: { type: 'string', enum: ['start', 'end', 'next_page', 'previous_page', 'target', 'after'], description: 'For goto.' },
        confirm: { type: 'boolean', description: 'Only after the user clearly agreed to a big change.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const kind = text(args, 'kind') as (typeof EDIT_KINDS)[number] | undefined;
      if (kind === undefined || !EDIT_KINDS.includes(kind)) return failure('unknown kind', `kind must be one of: ${EDIT_KINDS.join(', ')}.`);
      const confirm = flag(args, 'confirm') === true;
      switch (kind) {
        case 'find_replace': {
          const find = raw(args, 'find');
          const replacement = typeof args['replace'] === 'string' ? args['replace'] : undefined;
          if (find === undefined || replacement === undefined) return failure('missing text', 'find_replace needs both find and replace.');
          const a = await word.run('replace', { find, replace: replacement, ...pick(args, ['matchCase']), confirm });
          const n = typeof a['replaced'] === 'number' ? a['replaced'] : 0;
          return toResult(a, n === 0 ? `"${find}" was not found` : `replaced ${n} place${n === 1 ? '' : 's'}`);
        }
        case 'delete': {
          const a = await word.run('delete', { ...pick(args, ['target']), confirm });
          return toResult(a, 'deleted it');
        }
        case 'undo':
        case 'redo': {
          const a = await word.run(kind, pick(args, ['times']));
          return toResult(a, `${kind === 'undo' ? 'undid' : 'redid'} ${String(a['times'] ?? 1)} step(s)`);
        }
        case 'goto': {
          const a = await word.run('goto', pick(args, ['page', 'where', 'target']));
          const page = typeof a['page'] === 'number' && a['page'] > 0 ? ` (page ${a['page']} of ${String(a['pages'] ?? '?')})` : '';
          return toResult(a, `moved the cursor${page}`);
        }
        case 'scroll': {
          const a = await word.run('scroll', { ...pick(args, ['direction', 'times']) });
          return toResult(a, `scrolled ${String(a['direction'] ?? 'down')}`);
        }
        case 'save': {
          const a = await word.run('save');
          return toResult(a, `saved ${String(a['name'] ?? 'the document')}`);
        }
        case 'new_document': {
          const a = await word.run('new');
          return toResult(a, `opened ${String(a['name'] ?? 'a new document')}`);
        }
      }
    },
  };

  // Doing something with the document ends a run of reads.
  for (const tool of [write, format, structure, edit]) {
    const run = tool.execute.bind(tool);
    tool.execute = async (args) => {
      const result = await run(args);
      if (result.ok) readsInARow = 0;
      return result;
    };
  }

  return [status, read, write, format, structure, edit];
}
