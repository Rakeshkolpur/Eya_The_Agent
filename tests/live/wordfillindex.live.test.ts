/**
 * "Fill the running index" against REAL Word: a petition that already has its INDEX table (S.No / Particulars / Page No.) with empty page
 * cells and each part on its own page. One command fills every page cell; an entry that is not in the document is named and left empty;
 * and because the cells are live page references, the numbers follow the document when pages are added.
 *
 * Runs in a hidden Word of its own: the person's own Word is never touched.
 * Opt-in:  EYA_LIVE_WORD=1 npx vitest run tests/live/wordfillindex.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReaderProcess } from '../../src/main/writing/ReaderProcess';
import { WordControl } from '../../src/main/word/WordControl';
import { WordCommands } from '../../src/main/word/WordCommands';
import { createWordTools } from '../../src/main/tools/impl/wordTools';
import type { Tool, ToolArgs, ToolResult } from '../../src/main/tools/types';
import { validateArgs } from '../../src/main/tools/types';
import helper from '../../src/main/word/word-helper.ps1?raw';

const live = process.env['EYA_LIVE_WORD'] === '1' && existsSync('C:\\Program Files\\Microsoft Office\\Root\\Office16\\WINWORD.EXE');
const ps = (script: string): string =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60_000 }).trim();
const wordPids = (): number[] => {
  const out = ps(`@(Get-Process winword -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) -join ','`);
  return out === '' ? [] : out.split(',').map(Number);
};
const usersWord = (): string => {
  try {
    return ps(`$w = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application'); ($w.Documents | ForEach-Object { $_.FullName + ':' + $_.Content.End + ':' + $_.Saved }) -join '|'`);
  } catch {
    return '(no Word running)';
  }
};

describe.skipIf(!live)('filling a running index with real Word (a hidden Word of its own)', () => {
  let dir = '';
  let reader: ReaderProcess;
  let control: WordControl;
  let tools: Map<string, Tool>;
  let pidsBefore: number[] = [];
  let usersBefore = '';

  const call = async (name: string, args: ToolArgs = {}): Promise<ToolResult> => {
    const tool = tools.get(name) as Tool;
    validateArgs(tool.schema, args);
    return tool.execute(args);
  };
  const texts = async (from: number, to: number): Promise<string[]> => {
    const r = await call('word_read', { from, to });
    expect(r.ok, r.error).toBe(true);
    return (r.data?.['paragraphs'] as Array<{ text: string }>).map((p) => p.text);
  };
  /** The page cell of each index row, in order, read from the document. */
  const pageCells = async (): Promise<string[]> => {
    const all = await texts(1, 80);
    const at = all.findIndex((t) => t === 'Page No.');
    expect(at).toBeGreaterThan(0);
    const cells: string[] = [];
    // after the header row: S.No, Particulars, Page, then an empty end-of-row paragraph, per row
    let i = at + 2;
    while (i + 2 < all.length && /^\d+$/.test(all[i] ?? '')) {
      cells.push(all[i + 2] ?? '');
      i += 4;
    }
    return cells;
  };

  beforeAll(async () => {
    usersBefore = usersWord();
    pidsBefore = wordPids();
    process.env['EYA_WORD_PRIVATE'] = '1';
    dir = mkdtempSync(join(tmpdir(), 'eya-fillindex-'));
    reader = new ReaderProcess(join(dir, 'scripts'), undefined, 90_000, { fileName: 'word-helper.ps1', text: helper });
    control = new WordControl(reader);
    tools = new Map(createWordTools({ word: control }).map((t) => [t.schema.name, t]));

    // the petition: page 1 cause title + INDEX with empty page cells; then each part on its own page
    expect((await call('word_edit', { kind: 'new_document' })).ok).toBe(true);
    await call('word_write', { text: 'IN THE HIGH COURT OF TELANGANA AT HYDERABAD', align: 'center', bold: true });
    await call('word_write', { text: 'INDEX', align: 'center', bold: true });
    const rows = [
      ['S.No', 'Particulars', 'Page No.'],
      ['1', 'Synopsis', ''],
      ['2', 'List of Dates and Events', ''],
      ['3', 'Grounds', ''],
      ['4', 'Annexure P-1 - copy of the impugned order dated 12.03.2026', ''],
      ['5', 'Annexure P-2 (copy of the representation dated 20.03.2026)', ''],
      ['6', 'Annexure P-5 - copy of the reply', ''],
    ];
    const made = await call('word_structure', { kind: 'table', at: 'end', options: JSON.stringify({ rows }) });
    expect(made.ok, made.error).toBe(true);
    for (const [heading, body] of [
      ['SYNOPSIS', 'The Petitioner challenges the order.'],
      ['LIST OF DATES AND EVENTS', 'The events are listed here.'],
      ['GROUNDS', 'That the order is arbitrary.'],
      ['ANNEXURE P-1', 'Copy of the order.'],
      ['ANNEXURE P-2', 'Copy of the representation.'],
    ] as const) {
      await call('word_structure', { kind: 'page_break', at: 'end' });
      await call('word_write', { text: heading, at: 'end', align: 'center', bold: true });
      await call('word_write', { text: body, at: 'end', align: 'left', bold: false });
    }
    await call('word_structure', { kind: 'update_fields' });
  }, 240_000);

  afterAll(async () => {
    control?.close();
    await new Promise((r) => setTimeout(r, 4000));
    for (const pid of wordPids()) {
      if (pidsBefore.includes(pid)) continue;
      try {
        ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
      } catch {
        // already gone
      }
    }
    delete process.env['EYA_WORD_PRIVATE'];
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('the page cells start empty', async () => {
    expect(await pageCells()).toEqual(['', '', '', '', '', '']);
  }, 60_000);

  it('fills every entry that is in the document with its page — one call — and names the one that is not', async () => {
    const started = Date.now();
    const r = await call('word_structure', { kind: 'fill_index', options: '{}' });
    const ms = Date.now() - started;
    expect(r.ok, r.error).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`  [fill the index, 6 entries] ${ms} ms: ${r.summary}`);
    expect(r.data).toMatchObject({ filled: 5, table: 1 });
    expect(r.data?.['notFound']).toEqual(['Annexure P-5 - copy of the reply']);
    expect(await pageCells()).toEqual(['2', '3', '4', '5', '6', '']);
    expect(ms).toBeLessThan(15_000);
  }, 120_000);

  it('the numbers are LIVE: pages added in front move every entry, and the index follows', async () => {
    expect((await call('word_structure', { kind: 'page_break', at: 'before:heading:SYNOPSIS' })).ok).toBe(true);
    const status = await call('word_status');
    expect(Number(status.data?.['pages'])).toBeGreaterThanOrEqual(7);
    expect((await call('word_structure', { kind: 'update_fields' })).ok).toBe(true);
    const after = await pageCells();
    expect(after.slice(0, 5).every((c) => /^\d+$/.test(c))).toBe(true);
    expect(Number(after[0])).toBeGreaterThanOrEqual(2);
    expect(Number(after[4])).toBeGreaterThan(Number(after[0]));
  }, 120_000);

  it('can give page RANGES instead (start - end), each part running to where the next begins', async () => {
    const r = await call('word_structure', { kind: 'fill_index', options: '{"ranges":true}' });
    expect(r.ok, r.error).toBe(true);
    const entries = r.data?.['entries'] as Array<{ found: boolean; page?: number; endPage?: number }>;
    expect(entries.filter((e) => e.found)).toHaveLength(5);
    const cells = await pageCells();
    expect(cells[5]).toBe('');
    // the last annexure runs to the end of the document; every found entry has a start, and a range when it spans pages
    expect(cells.slice(0, 5).every((c) => /^\d+( - \d+)?$/.test(c))).toBe(true);
  }, 120_000);

  it('a break aimed at words that are in the index table itself goes in front of the TABLE, and the table is not damaged', async () => {
    const before = await pageCells();
    expect((await call('word_structure', { kind: 'page_break', at: 'before:containing:List of Dates and Events' })).ok).toBe(true);
    const after = await pageCells();
    expect(after).toHaveLength(before.length); // every row is still a row of the table
    const again = await call('word_structure', { kind: 'fill_index', options: '{}' });
    expect(again.ok, again.error).toBe(true);
    expect(again.data).toMatchObject({ filled: 5, table: 1 });
  }, 120_000);

  it('is one undo step: undoing it empties the cells again', async () => {
    expect((await call('word_edit', { kind: 'undo' })).ok).toBe(true);
    const cells = await pageCells();
    expect(cells.every((c) => c === '' || /^\d+$/.test(c))).toBe(true);
  }, 60_000);

  it('the spoken phrase does it without the model, and says what it could not find', async () => {
    const commands = new WordCommands({ run: (cmd, args) => control.run(cmd, args), wordIsInFront: async () => true });
    const done = await commands.tryHandle('fill the running index in my writ');
    expect(done?.ok).toBe(true);
    expect(done?.spoken).toMatch(/^Filled 5 entries of the index\. I could not find Annexure P-5 - copy of the reply in the document, so I left those empty\.$/);
  }, 120_000);

  it('left the person\'s own Word exactly as it was', () => {
    expect(usersWord()).toBe(usersBefore);
  });
});
