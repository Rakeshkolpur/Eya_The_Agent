import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compareBuilt, describeSpec, EXTRACTION_PROMPT, gridOf, LIMITS, normalizeDocSpec, parseModelJson, shapeOf } from '../src/main/word/docSpec';
import type { DocSpec, TableBlock } from '../src/main/word/docSpec';
import type { WordAnswer, WordCommand } from '../src/main/word/WordControl';
import { createWordImageTool } from '../src/main/tools/impl/wordImageTool';
import { createWordTools } from '../src/main/tools/impl/wordTools';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';

/**
 * Word, the new abilities: a page as a layout (cleaned before Word sees it), typing live, finding and fixing a table, building a whole document, and recreating a PICTURE in Word.
 * The helper and the vision model are pretend here; the real Word is in tests/live/wordoffice.live.test.ts.
 */

interface Call {
  cmd: WordCommand;
  args: Record<string, unknown>;
  timeoutMs: number | undefined;
}

function fakeWord(answers: Partial<Record<WordCommand, WordAnswer>> = {}) {
  const calls: Call[] = [];
  const word = {
    run: async (cmd: WordCommand, args: Record<string, unknown> = {}, options: { readonly timeoutMs?: number } = {}): Promise<WordAnswer> => {
      calls.push({ cmd, args, timeoutMs: options.timeoutMs });
      return answers[cmd] ?? { ok: true };
    },
  };
  return { word, calls };
}

const wordTool = (name: string, answers: Partial<Record<WordCommand, WordAnswer>> = {}) => {
  const f = fakeWord(answers);
  const tool = createWordTools({ word: f.word }).find((t) => t.schema.name === name) as Tool;
  return { ...f, run: (args: ToolArgs): Promise<ToolResult> => tool.execute(args), tool };
};

describe('a page as a layout: what a model returns is cleaned before it reaches Word', () => {
  it('JSON is found in a code fence, among words, or with a trailing comma; nothing usable is null', () => {
    expect(parseModelJson('```json\n{"blocks":[{"type":"paragraph","text":"a"}]}\n```')).toEqual({ blocks: [{ type: 'paragraph', text: 'a' }] });
    expect(parseModelJson('Here it is: {"blocks":[]} hope that helps')).toEqual({ blocks: [] });
    expect(parseModelJson('{"blocks":[{"type":"line"},],}')).toEqual({ blocks: [{ type: 'line' }] });
    expect(parseModelJson('sorry, I cannot')).toBeNull();
    expect(parseModelJson('{ not json at all }')).toBeNull();
    expect(parseModelJson('')).toBeNull();
  });

  it('a layout with no blocks, or that is not an object, is refused with the reason', () => {
    expect(normalizeDocSpec(null)).toMatchObject({ ok: false, error: 'the layout is not an object' });
    expect(normalizeDocSpec([])).toMatchObject({ ok: false });
    expect(normalizeDocSpec({ blocks: [] })).toMatchObject({ ok: false, error: 'the layout has no blocks' });
    expect(normalizeDocSpec({ blocks: [{ type: 'sparkle' }] })).toMatchObject({ ok: false, error: 'nothing in the layout could be built' });
  });

  it('only known kinds of block are kept, and what was dropped is said', () => {
    const n = normalizeDocSpec({ blocks: [{ type: 'heading', text: 'T' }, { type: 'sparkle' }, 'nonsense', { type: 'table', rows: [] }, { type: 'pagebreak' }, { type: 'rule' }] });
    expect(n.ok).toBe(true);
    expect(n.spec?.blocks.map((b) => b.type)).toEqual(['heading', 'pagebreak', 'line']);
    expect(n.dropped.join(' | ')).toMatch(/"sparkle" is not a kind/);
    expect(n.dropped.join(' | ')).toMatch(/was not an object/);
    expect(n.dropped.join(' | ')).toMatch(/a table with no rows/);
  });

  it('numbers are kept in range, colours are checked, alignment is checked, and unknown fields are dropped', () => {
    const n = normalizeDocSpec({
      blocks: [{ type: 'heading', level: 9, text: 'T', size: 500, color: 'FF0000', align: 'sideways', bold: 'yes', evil: 'x', font: 'Arial' }, { type: 'paragraph', text: 'p', size: 12.3, color: 'banana', align: 'JUSTIFY', lineSpacing: 99, indentLeftCm: 400 }],
    });
    const [h, p] = n.spec?.blocks ?? [];
    expect(h).toEqual({ type: 'heading', level: 6, text: 'T', size: 400, color: '#FF0000', font: 'Arial' });
    expect(p).toEqual({ type: 'paragraph', text: 'p', size: 12.5, align: 'justify', lineSpacing: 5, indentLeftCm: 30 });
  });

  it('runs keep their look; a run with no text is dropped; text alone becomes one paragraph; an empty line becomes spacing', () => {
    const n = normalizeDocSpec({ blocks: [{ type: 'paragraph', runs: [{ text: 'a ' }, { text: 'b', bold: true, italic: false, color: '#00ff00', highlight: 'yellow' }, { text: '' }, 'c'] }, { type: 'paragraph', text: '' }, { type: 'paragraph' }] });
    expect(n.spec?.blocks[0]).toEqual({ type: 'paragraph', runs: [{ text: 'a ' }, { text: 'b', bold: true, italic: false, color: '#00FF00', highlight: 'yellow' }, { text: 'c' }] });
    expect(n.spec?.blocks[1]).toEqual({ type: 'paragraph', text: ' ' });
    expect(n.spec?.blocks[2]).toEqual({ type: 'paragraph', text: ' ' });
  });

  it('lists are bullets or numbers, with a level only when there is a list', () => {
    const n = normalizeDocSpec({ blocks: [{ type: 'paragraph', text: 'x', list: 'bullets', listLevel: 2 }, { type: 'paragraph', text: 'y', list: 'numbered' }, { type: 'paragraph', text: 'z', list: 'none', listLevel: 3 }] });
    expect(n.spec?.blocks).toEqual([
      { type: 'paragraph', text: 'x', list: 'bullet', listLevel: 2 },
      { type: 'paragraph', text: 'y', list: 'number' },
      { type: 'paragraph', text: 'z' },
    ]);
  });

  it('a table: cells may be plain text, spans are kept, shading and alignment are checked, header rows are limited to the rows', () => {
    const n = normalizeDocSpec({
      blocks: [{ type: 'table', headerRows: 9, borders: 'all', rows: [['A', 'B', 'C'], [{ text: 'wide', colSpan: 2, shade: '#d9d9d9', vAlign: 'middle', align: 'center' }, 7], [{ text: 'tall', rowSpan: 2 }, { text: 'x', colSpan: 1, rowSpan: 1 }]] }],
    });
    const t = n.spec?.blocks[0] as TableBlock;
    expect(t.headerRows).toBe(3);
    expect(t.borders).toBe('all');
    expect(t.rows[0]).toEqual([{ text: 'A' }, { text: 'B' }, { text: 'C' }]);
    expect(t.rows[1]?.[0]).toEqual({ text: 'wide', colSpan: 2, shade: '#D9D9D9', vAlign: 'center', align: 'center' });
    expect(t.rows[1]?.[1]).toEqual({ text: '7' });
    expect(t.rows[2]?.[0]).toEqual({ text: 'tall', rowSpan: 2 });
    expect(t.rows[2]?.[1]).toEqual({ text: 'x' });
  });

  it('column widths that add up to more than the page are scaled to 100 (a table wider than the page is the usual fault, not what the picture shows)', () => {
    const t = normalizeDocSpec({ blocks: [{ type: 'table', colWidthsPct: [60, 60, 60], rows: [['a', 'b', 'c']] }] }).spec?.blocks[0] as TableBlock;
    expect(t.colWidthsPct).toEqual([33.3, 33.3, 33.3]);
    const ok = normalizeDocSpec({ blocks: [{ type: 'table', colWidthsPct: [10, 50, 40], rows: [['a', 'b', 'c']] }] }).spec?.blocks[0] as TableBlock;
    expect(ok.colWidthsPct).toEqual([10, 50, 40]);
  });

  it('the size is limited: too many blocks, rows, columns and runs are cut, and it is said', () => {
    const many = Array.from({ length: LIMITS.blocks + 5 }, () => ({ type: 'paragraph', text: 'x' }));
    const a = normalizeDocSpec({ blocks: many });
    expect(a.spec?.blocks).toHaveLength(LIMITS.blocks);
    expect(a.dropped[0]).toContain(`only the first ${LIMITS.blocks}`);
    const rows = Array.from({ length: LIMITS.tableRows + 3 }, () => Array.from({ length: LIMITS.tableCols + 4 }, () => 'c'));
    const t = normalizeDocSpec({ blocks: [{ type: 'table', rows }] });
    const tb = t.spec?.blocks[0] as TableBlock;
    expect(tb.rows).toHaveLength(LIMITS.tableRows);
    expect(tb.rows[0]).toHaveLength(LIMITS.tableCols);
    expect(t.dropped.join(' ')).toContain(`first ${LIMITS.tableRows} rows`);
  });

  it('page setup and defaults keep only what Word understands', () => {
    const n = normalizeDocSpec({ blocks: [{ type: 'line' }], page: { paper: 'A4', orientation: 'sideways', marginLeftCm: 3, marginTopCm: 99, junk: 1 }, defaults: { font: 'Times New Roman', size: 2, lineSpacing: 1.5, spaceAfter: 6, junk: 2 } });
    expect(n.spec?.page).toEqual({ paper: 'a4', marginLeftCm: 3, marginTopCm: 10 });
    expect(n.spec?.defaults).toEqual({ font: 'Times New Roman', size: 6, lineSpacing: 1.5, spaceAfter: 6 });
  });

  it('the grid of a table counts merged cells the way Word lays them out', () => {
    const t = (rows: TableBlock['rows']): TableBlock => ({ type: 'table', rows });
    expect(gridOf(t([[{ text: 'a' }, { text: 'b' }], [{ text: 'c' }, { text: 'd' }]]))).toEqual({ rows: 2, columns: 2 });
    expect(gridOf(t([[{ text: 'a', colSpan: 3 }], [{ text: 'b' }, { text: 'c' }, { text: 'd' }]]))).toEqual({ rows: 2, columns: 3 });
    expect(gridOf(t([[{ text: 'a', rowSpan: 3 }, { text: 'b' }], [{ text: 'c' }], [{ text: 'd' }]]))).toEqual({ rows: 3, columns: 2 });
    expect(gridOf(t([[{ text: 'a', rowSpan: 3 }, { text: 'b' }]]))).toEqual({ rows: 3, columns: 2 });
    expect(gridOf(t([[{ text: 'a' }], [{ text: 'b' }, { text: 'c' }, { text: 'd' }]]))).toEqual({ rows: 2, columns: 3 });
  });

  const spec: DocSpec = { blocks: [{ type: 'heading', level: 1, text: 'T' }, { type: 'paragraph', text: 'p' }, { type: 'table', rows: [[{ text: 'a' }, { text: 'b' }], [{ text: 'c', colSpan: 2 }]] }, { type: 'pagebreak' }] };

  it('what Word built is compared with what was recognised: the same shape, or what differs', () => {
    expect(shapeOf(spec)).toEqual({ headings: 1, paragraphs: 1, tables: [{ rows: 2, columns: 2 }], pageBreaks: 1 });
    expect(compareBuilt(spec, { headings: 1, tables: 1, tableRows: [2], tableColumns: [2], pageBreaks: 1 })).toEqual({ same: true, differences: [] });
    const off = compareBuilt(spec, { headings: 0, tables: 2, tableRows: [3], tableColumns: [1], pageBreaks: 0 });
    expect(off.same).toBe(false);
    expect(off.differences).toEqual(['1 heading(s) were recognised but Word has 0', '1 table(s) were recognised but Word has 2', 'table 1 should have 2 rows but has 3', 'table 1 should have 2 columns but has 1', '1 page break(s) were recognised but Word has 0']);
  });

  it('what was recognised is said in a few plain words', () => {
    expect(describeSpec(spec)).toBe('1 heading, 1 paragraph, table 1 (2 rows × 2 columns), 1 page break');
  });

  it('the question to the vision model asks for exact words, every cell, merged cells, widths and JSON only', () => {
    for (const w of ['EXACTLY', 'ONE JSON object', 'colSpan', 'rowSpan', 'colWidthsPct', 'Hindi, Telugu', 'do not correct', 'Do not invent']) expect(EXTRACTION_PROMPT, w).toContain(w);
  });
});

describe('typing live in Word', () => {
  it('word_write with live asks the helper to TYPE, at the speed asked for, and gives it the time the typing needs', async () => {
    const t = wordTool('word_write', { type: { ok: true, typed: 200, paragraphs: { from: 4, to: 5 } } });
    const text = 'x'.repeat(200);
    const r = await t.run({ text, live: true, speed: 'slow', style: 'Heading 1' });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('typed 200 characters live in paragraphs 4–5');
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ cmd: 'type', args: { text, cps: 20, style: 'Heading 1' } });
    expect(t.calls[0]?.timeoutMs).toBe(Math.ceil((200 / 20) * 1000) + 30_000);
  });

  it('the speeds are slow (20), normal (60, the default) and fast (160), and the wait never exceeds 170 seconds', async () => {
    for (const [speed, cps] of [['slow', 20], ['normal', 60], ['fast', 160], [undefined, 60]] as const) {
      const t = wordTool('word_write');
      await t.run({ text: 'hello', live: true, ...(speed !== undefined ? { speed } : {}) });
      expect(t.calls[0]?.args['cps'], String(speed)).toBe(cps);
    }
    const long = wordTool('word_write');
    await long.run({ text: 'x'.repeat(6000), live: true, speed: 'slow' });
    expect(long.calls[0]?.timeoutMs).toBe(170_000);
  });

  it('without live it writes in one go, exactly as before (no typing, no extra wait)', async () => {
    const t = wordTool('word_write', { write: { ok: true, paragraphs: { from: 1, to: 1 } } });
    const r = await t.run({ text: 'hello' });
    expect(r.ok).toBe(true);
    expect(t.calls[0]).toMatchObject({ cmd: 'write', timeoutMs: undefined });
    expect((await t.run({ text: 'hello', live: false })).ok).toBe(true);
    expect(t.calls.every((c) => c.cmd === 'write')).toBe(true);
  });

  it('a failure to type comes back in words (Word not open)', async () => {
    const t = wordTool('word_write', { type: { ok: false, why: 'Word is not open' } });
    const r = await t.run({ text: 'hi', live: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Open Word');
  });
});

describe('tables that are not coming properly', () => {
  it('inspect_tables says how many tables and what is wrong with each', async () => {
    const t = wordTool('word_structure', { tables: { ok: true, count: 2, problems: ['Table 1: it has no borders', 'Table 2: its right side runs off the page'], tables: [] } });
    const r = await t.run({ kind: 'inspect_tables' });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('2 tables: 2 problems found');
    expect((r.data?.['problems'] as string[])[1]).toContain('runs off the page');
    expect(t.calls[0]?.cmd).toBe('tables');
  });

  it('inspect_tables on a document with none, and on a table that is fine', async () => {
    expect((await wordTool('word_structure', { tables: { ok: true, count: 0, problems: [] } }).run({ kind: 'inspect_tables' })).summary).toBe('the document has no tables');
    expect((await wordTool('word_structure', { tables: { ok: true, count: 1, problems: [] } }).run({ kind: 'inspect_tables' })).summary).toBe('1 table: nothing looks wrong');
  });

  it('fix_table passes the options on and says what was done and what is left', async () => {
    const t = wordTool('word_structure', { fix_table: { ok: true, tables: [{ table: 1, did: ['gave it borders', 'fitted it to the page width'], problemsAfter: ['column(s) 3 are squeezed'] }], converted: false } });
    const r = await t.run({ kind: 'fix_table', options: '{"table":1,"actions":["fit","borders"]}' });
    expect(r.summary).toBe('fixed 1 table (2 changes, 1 problem left)');
    expect(t.calls[0]).toMatchObject({ cmd: 'fix_table', args: { table: 1, actions: ['fit', 'borders'] } });
  });

  it('fix_table with from_text says it turned text into a table; bad options are refused in words', async () => {
    const t = wordTool('word_structure', { fix_table: { ok: true, tables: [], converted: true } });
    expect((await t.run({ kind: 'fix_table', options: '{"actions":["from_text"],"target":"paragraphs:3-9"}' })).summary).toBe('turned the text into a table');
    const bad = await t.run({ kind: 'fix_table', options: 'not json' });
    expect(bad.ok).toBe(false);
    expect(bad.summary).toBe('bad options');
  });

  it('build_document cleans the layout, builds it in a NEW document by default, and says whether the shape matches', async () => {
    const t = wordTool('word_structure', { build: { ok: true, name: 'Document2', headings: 1, tables: 1, tableRows: [2], tableColumns: [2], pageBreaks: 0, warnings: [] } });
    const spec = { blocks: [{ type: 'heading', text: 'T', size: 999 }, { type: 'table', rows: [['a', 'b'], ['c', 'd']] }, { type: 'sparkle' }] };
    const r = await t.run({ kind: 'build_document', options: JSON.stringify({ spec }) });
    expect(r.ok, r.error).toBe(true);
    const sent = t.calls[0];
    expect(sent?.cmd).toBe('build');
    expect(sent?.args['target']).toBe('new');
    expect(sent?.timeoutMs).toBe(170_000);
    const built = (sent?.args['spec'] as DocSpec).blocks;
    expect(built).toHaveLength(2);
    expect(built[0]).toMatchObject({ type: 'heading', size: 400 });
    expect(r.data?.['sameShapeAsLayout']).toBe(true);
    expect((r.data?.['notUnderstood'] as string[])[0]).toContain('sparkle');
  });

  it('build_document with no usable layout is refused before Word is asked', async () => {
    const t = wordTool('word_structure');
    const r = await t.run({ kind: 'build_document', options: '{"spec":{"blocks":[]}}' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('bad options');
    expect(t.calls).toEqual([]);
  });
});

describe('recreating a picture in Word', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eya-wordimg-'));
  const picture = join(dir, 'page.png');
  writeFileSync(picture, Buffer.from('not really a png but it has the extension'));
  writeFileSync(join(dir, 'doc.pdf'), 'x');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const LAYOUT = { page: { paper: 'a4' }, blocks: [{ type: 'heading', level: 1, text: 'NOTICE', align: 'center', bold: true, size: 16 }, { type: 'table', headerRows: 1, rows: [[{ text: 'S.No', bold: true }, { text: 'Item' }], [{ text: '1' }, { text: 'Pen' }]] }] };
  const BUILT_OK: WordAnswer = { ok: true, name: 'Document3', headings: 1, tables: 1, tableRows: [2], tableColumns: [2], pageBreaks: 0, pages: 1, warnings: [] };

  function setup(replies: Array<string | Error>, built: WordAnswer = BUILT_OK, hasKey = true) {
    const f = fakeWord({ build: built });
    const asked: Array<{ b64: string; mime: string; question: string }> = [];
    const brain = {
      hasKey: () => hasKey,
      analyzeFile: async (b64: string, mime: string, question: string): Promise<string> => {
        asked.push({ b64, mime, question });
        const next = replies.shift();
        if (next === undefined) throw new Error('no more answers');
        if (next instanceof Error) throw next;
        return next;
      },
    };
    const tool = createWordImageTool({ word: f.word, brain, folders: { home: dir, desktop: dir, documents: dir, downloads: dir, pictures: dir, videos: dir, music: dir, temp: dir }, attachmentsDir: dir });
    return { ...f, asked, tool };
  }

  it('reads the picture with the extraction question, builds the cleaned layout in a NEW document, and says what it recognised', async () => {
    const s = setup(['```json\n' + JSON.stringify(LAYOUT) + '\n```']);
    const r = await s.tool.execute({ path: picture });
    expect(r.ok, r.error).toBe(true);
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]?.mime).toBe('image/png');
    expect(s.asked[0]?.question).toBe(EXTRACTION_PROMPT);
    expect(Buffer.from(s.asked[0]?.b64 ?? '', 'base64').toString()).toContain('not really a png');
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({ cmd: 'build', args: { target: 'new' }, timeoutMs: 170_000 });
    expect(r.summary).toBe('rebuilt the picture in a new Word document: 1 heading, 0 paragraphs, table 1 (2 rows × 2 columns)');
    expect(r.data).toMatchObject({ document: 'Document3', sameShapeAsRecognised: true, differences: [], warnings: [] });
    expect(String(r.data?.['note'])).toContain('check the words, numbers');
  });

  it('what Word built that differs from what was recognised is said, and what Word warned about', async () => {
    const s = setup([JSON.stringify(LAYOUT)], { ...BUILT_OK, tableRows: [3], warnings: ['block 2: something'] });
    const r = await s.tool.execute({ path: picture });
    expect(r.ok).toBe(true);
    expect(r.data?.['sameShapeAsRecognised']).toBe(false);
    expect(r.data?.['differences']).toEqual(['table 1 should have 2 rows but has 3']);
    expect(r.data?.['warnings']).toEqual(['block 2: something']);
  });

  it('an answer that is not JSON is asked for a second time, once, and then used', async () => {
    const s = setup(['I am sorry, here is a description instead.', JSON.stringify(LAYOUT)]);
    const r = await s.tool.execute({ path: picture });
    expect(r.ok, r.error).toBe(true);
    expect(s.asked).toHaveLength(2);
    expect(s.asked[1]?.question).toContain('could not be read as JSON');
  });

  it('two answers that cannot be read: said, and Word is never asked', async () => {
    const s = setup(['no', 'still no']);
    const r = await s.tool.execute({ path: picture });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('unreadable answer');
    expect(s.calls).toEqual([]);
  });

  it('a layout with nothing in it is said, and Word is never asked', async () => {
    const s = setup([JSON.stringify({ blocks: [] })]);
    const r = await s.tool.execute({ path: picture });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('nothing to build');
    expect(s.calls).toEqual([]);
  });

  it('the AI failing, no key, a file that is not a picture or not there, and a path outside the person\'s files are each said', async () => {
    expect((await setup([new Error('quota')]).tool.execute({ path: picture })).summary).toBe('could not read the picture');
    expect((await setup([], BUILT_OK, false).tool.execute({ path: picture })).summary).toBe('no Gemini key');
    expect((await setup([]).tool.execute({ path: join(dir, 'doc.pdf') })).summary).toBe('not a picture');
    expect((await setup([]).tool.execute({ path: join(dir, 'missing.png') })).summary).toBe('could not read');
    expect((await setup([]).tool.execute({ path: 'C:\\Windows\\System32\\x.png' })).summary).toBe('not allowed');
    expect((await setup([]).tool.execute({ path: '' })).summary).toBe('missing input');
  });

  it('Word not being open is said with what to do', async () => {
    const s = setup([JSON.stringify(LAYOUT)], { ok: false, why: 'Word is not open' });
    const r = await s.tool.execute({ path: picture });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('Word would not build it');
    expect(r.error).toContain('Open Word');
  });

  it('it never claims to be identical, and tells the person to check', () => {
    const s = setup([]);
    expect(s.tool.schema.description).toContain('never claim it is identical');
    expect(s.tool.schema.description).toContain('NEW Word document');
  });
});
