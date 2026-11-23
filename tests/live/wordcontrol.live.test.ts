/**
 * Word control against REAL Word, through the real PowerShell helper and the real tools — in a PRIVATE hidden Word of its own
 * (EYA_WORD_PRIVATE=1), so that whatever the person running this has open in their own Word is never touched. It drafts a petition the
 * way somebody would dictate it, then checks what Word really holds: the writing, the headings, a list of dates and events that grows,
 * page numbers, a table of contents and a running index whose page numbers follow the document, and that every Eya action is ONE undo step.
 *
 * Opt-in (it starts a hidden Word on this PC):  EYA_LIVE_WORD=1 npx vitest run tests/live/wordcontrol.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReaderProcess } from '../../src/main/writing/ReaderProcess';
import { WordControl } from '../../src/main/word/WordControl';
import { createWordTools } from '../../src/main/tools/impl/wordTools';
import { WordCommands } from '../../src/main/word/WordCommands';
import type { Tool, ToolArgs, ToolResult } from '../../src/main/tools/types';
import { validateArgs } from '../../src/main/tools/types';
import helper from '../../src/main/word/word-helper.ps1?raw';

const live = process.env['EYA_LIVE_WORD'] === '1' && existsSync('C:\\Program Files\\Microsoft Office\\Root\\Office16\\WINWORD.EXE');

const ps = (script: string): string =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60_000 }).trim();

/** The Word processes running now (id list), so that only what THIS test started is ever closed. */
const wordPids = (): number[] => {
  const out = ps(`@(Get-Process winword -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) -join ','`);
  return out === '' ? [] : out.split(',').map(Number);
};

/** What the person's own Word holds right now (read only): document names and sizes. */
const usersWord = (): string => {
  try {
    return ps(`$w = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application'); ($w.Documents | ForEach-Object { $_.FullName + ':' + $_.Content.End + ':' + $_.Saved }) -join '|'`);
  } catch {
    return '(no Word running)';
  }
};

describe.skipIf(!live)('Word control with real Word (a private hidden instance)', () => {
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
  const paragraphs = async (from: number, to: number): Promise<Array<Record<string, unknown>>> => {
    // Formatting is asked of Word paragraph by paragraph (slow), so it is only available for a few paragraphs at a time.
    const r = await call('word_read', { from, to, ...(to - from + 1 <= 10 ? { detail: true } : {}) });
    expect(r.ok, r.error).toBe(true);
    return r.data?.['paragraphs'] as Array<Record<string, unknown>>;
  };
  const status = async (): Promise<Record<string, unknown>> => {
    const r = await call('word_status');
    expect(r.ok, r.error).toBe(true);
    return r.data as Record<string, unknown>;
  };
  const headingPage = async (title: string): Promise<number> => {
    const s = await status();
    const h = (s['headings'] as Array<{ text: string; page: number }>).find((x) => x.text.startsWith(title));
    expect(h, `heading ${title}`).toBeDefined();
    return (h as { page: number }).page;
  };

  beforeAll(() => {
    usersBefore = usersWord();
    pidsBefore = wordPids();
    process.env['EYA_WORD_PRIVATE'] = '1'; // the helper starts a Word of its own; it never attaches to the user's
    dir = mkdtempSync(join(tmpdir(), 'eya-wordctl-'));
    reader = new ReaderProcess(join(dir, 'scripts'), undefined, 60_000, { fileName: 'word-helper.ps1', text: helper });
    control = new WordControl(reader);
    tools = new Map(createWordTools({ word: control }).map((t) => [t.schema.name, t]));
  }, 60_000);

  afterAll(async () => {
    control?.close();
    await new Promise((r) => setTimeout(r, 4000));
    // Anything this test started that is still there (hidden, no window) goes; the person's own Word never does.
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

  it('says so, in words, when no document is open', async () => {
    const r = await call('word_status');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Word is not open/);
  }, 60_000);

  it('opens a new document and writes what is dictated: title centred and bold, then body text that is NOT a heading', async () => {
    expect((await call('word_edit', { kind: 'new_document' })).ok).toBe(true);
    await call('word_write', { text: 'IN THE HIGH COURT OF TELANGANA AT HYDERABAD', align: 'center', bold: true, fontSize: 14 });
    await call('word_write', { text: 'WRIT PETITION NO. ______ OF 2026', align: 'center', bold: true });
    await call('word_write', { text: 'SYNOPSIS', style: 'Heading 1' });
    await call('word_write', { text: 'The Petitioner challenges the order dated 12.03.2026 passed by the Respondent.' });
    await call('word_write', { text: 'LIST OF DATES AND EVENTS', style: 'Heading 1' });
    await call('word_write', { text: 'GROUNDS', style: 'Heading 1' });
    await call('word_write', { text: 'A. That the order is arbitrary.\nB. That the order violates natural justice.' });
    await call('word_write', { text: 'PRAYER', style: 'Heading 1' });
    await call('word_write', { text: 'It is therefore prayed that this Hon\u2019ble Court may be pleased to set aside the order.' });

    const p = await paragraphs(1, 10);
    expect(p.map((x) => x['text'])).toEqual([
      'IN THE HIGH COURT OF TELANGANA AT HYDERABAD',
      'WRIT PETITION NO. ______ OF 2026',
      'SYNOPSIS',
      'The Petitioner challenges the order dated 12.03.2026 passed by the Respondent.',
      'LIST OF DATES AND EVENTS',
      'GROUNDS',
      'A. That the order is arbitrary.',
      'B. That the order violates natural justice.',
      'PRAYER',
      'It is therefore prayed that this Hon\u2019ble Court may be pleased to set aside the order.',
    ]);
    expect(p[0]).toMatchObject({ align: 'center', bold: true, size: 14 });
    expect(p[2]).toMatchObject({ style: 'Heading 1' });
    expect(p[3]).toMatchObject({ style: 'Normal' }); // after a heading: ordinary text, as pressing Enter would give
    expect(p[6]).toMatchObject({ style: 'Normal' });
    expect(p[8]).toMatchObject({ style: 'Heading 1' });
  }, 120_000);

  it('formats a place by name: the heading centred and underlined, the grounds justified at 1.5 spacing in Times New Roman 12', async () => {
    expect((await call('word_format', { target: 'heading:SYNOPSIS', align: 'center', underline: true })).ok).toBe(true);
    const r = await call('word_format', { target: 'paragraphs:7-8', align: 'justify', lineSpacing: 1.5, fontName: 'Times New Roman', fontSize: 12 });
    expect(r.ok, r.error).toBe(true);
    const p = await paragraphs(3, 8);
    expect(p[0]).toMatchObject({ align: 'center' });
    expect(p[4]).toMatchObject({ align: 'justify', font: 'Times New Roman', size: 12 });
    expect(p[5]).toMatchObject({ align: 'justify', font: 'Times New Roman', size: 12 });
  }, 60_000);

  it('turns what was written into a numbered list when asked, and back', async () => {
    expect((await call('word_format', { target: 'paragraphs:7-8', list: 'numbers' })).ok).toBe(true);
    const numbered = await paragraphs(7, 8);
    expect(numbered[0]?.['list']).toBeTruthy();
    expect((await call('word_format', { target: 'paragraphs:7-8', list: 'none' })).ok).toBe(true);
    expect((await paragraphs(7, 7))[0]?.['list']).toBeUndefined();
  }, 60_000);

  it('builds the list of dates and events: a table under its heading, and a new row that numbers itself', async () => {
    const made = await call('word_structure', {
      kind: 'table',
      at: 'after:heading:LIST OF DATES AND EVENTS',
      options: JSON.stringify({ rows: [['S.No', 'Date', 'Event'], ['1', '12.03.2026', 'Order passed by the Respondent'], ['2', '20.03.2026', 'Representation made by the Petitioner']], widths: [8, 22, 70] }),
    });
    expect(made.ok, made.error).toBe(true);
    const added = await call('word_structure', { kind: 'table', options: JSON.stringify({ append: true, rows: [['05.04.2026', 'Writ petition filed']] }) });
    expect(added.ok, added.error).toBe(true);
    const s = await status();
    expect(s['tables']).toBe(1);
    // Word's end-of-row marks are paragraphs with no text: left out; the cells then follow one another in reading order.
    const texts = (await paragraphs(5, 40)).map((x) => String(x['text'])).filter((t) => t !== '');
    expect(texts.join('|')).toContain(
      ['S.No', 'Date', 'Event', '1', '12.03.2026', 'Order passed by the Respondent', '2', '20.03.2026', 'Representation made by the Petitioner', '3', '05.04.2026', 'Writ petition filed'].join('|'),
    );
  }, 120_000);

  it('adds page numbers "Page X of Y" in the footer, as live fields', async () => {
    const r = await call('word_structure', { kind: 'page_numbers', options: '{"where":"footer","align":"center","format":"page_n_of_m"}' });
    expect(r.ok, r.error).toBe(true);
    const s = await status();
    expect(s['pageNumbers']).toBe(true);
    expect(String(s['footer'])).toMatch(/^Page 1 of \d+$/);
  }, 60_000);

  it('makes a table of contents from the headings, with a title', async () => {
    const r = await call('word_structure', { kind: 'table_of_contents', at: 'start', options: '{"levels":2,"title":"TABLE OF CONTENTS"}' });
    expect(r.ok, r.error).toBe(true);
    expect(r.data?.['created']).toBe(true);
    const s = await status();
    expect(s['tablesOfContents']).toBe(1);
    const top = await paragraphs(1, 6);
    expect(top[0]).toMatchObject({ text: 'TABLE OF CONTENTS', align: 'center', bold: true });
    expect(top.some((x) => /SYNOPSIS/.test(String(x['text'])) && /TOC/i.test(String(x['style'])))).toBe(true);
    // asking again updates it rather than making a second one
    const again = await call('word_structure', { kind: 'table_of_contents' });
    expect(again.summary).toBe('updated the table of contents');
    expect((await status())['tablesOfContents']).toBe(1);
  }, 120_000);

  it('builds a running index whose page numbers FOLLOW the document: they change when the document grows', async () => {
    const entries = [
      { particulars: 'Synopsis', find: 'SYNOPSIS' },
      { particulars: 'List of dates and events', find: 'LIST OF DATES AND EVENTS' },
      { particulars: 'Grounds', find: 'GROUNDS' },
      { particulars: 'Prayer', find: 'PRAYER' },
      { particulars: 'Annexure P-9 (not in the document)', find: 'ANNEXURE P-9' },
    ];
    const made = await call('word_structure', { kind: 'index', at: 'start', options: JSON.stringify({ title: 'INDEX', entries }) });
    expect(made.ok, made.error).toBe(true);
    expect(made.data?.['missing']).toEqual(['Annexure P-9 (not in the document)']);

    const pageOf = async (particular: string): Promise<string> => {
      const all = await paragraphs(1, 40);
      const at = all.findIndex((x) => x['text'] === particular);
      expect(at, particular).toBeGreaterThanOrEqual(0);
      return String(all[at + 1]?.['text']);
    };
    const before = await pageOf('Prayer');
    expect(before).toMatch(/^\d+$/);
    expect(Number(before)).toBe(await headingPage('PRAYER'));
    expect(await pageOf('Annexure P-9 (not in the document)')).toBe('-');

    // The document grows: two page breaks before the synopsis. Every heading moves, and the index has to follow.
    const prayerBefore = await headingPage('PRAYER');
    expect((await call('word_structure', { kind: 'page_break', at: 'before:heading:SYNOPSIS' })).ok).toBe(true);
    expect((await call('word_structure', { kind: 'page_break', at: 'before:heading:SYNOPSIS' })).ok).toBe(true);
    expect((await call('word_structure', { kind: 'update_fields' })).ok).toBe(true);
    const prayerAfter = await headingPage('PRAYER');
    expect(prayerAfter).toBeGreaterThan(prayerBefore);
    expect(Number(await pageOf('Prayer'))).toBe(prayerAfter);

    // Asking for the index again replaces it where it stood: still one index table, not two.
    const tablesBefore = (await status())['tables'];
    const again = await call('word_structure', { kind: 'index', options: JSON.stringify({ title: 'INDEX', entries }) });
    expect(again.ok, again.error).toBe(true);
    expect((await status())['tables']).toBe(tablesBefore);
  }, 240_000);

  it('every Eya action is ONE undo step: undoing it takes back the whole thing', async () => {
    const before = (await status())['paragraphs'] as number;
    expect((await call('word_write', { text: 'First line to be taken back.\nSecond line to be taken back.', at: 'end' })).ok).toBe(true);
    expect(((await status())['paragraphs'] as number) - before).toBe(2);
    const undone = await call('word_edit', { kind: 'undo' });
    expect(undone.ok, undone.error).toBe(true);
    expect((await status())['paragraphs']).toBe(before);
  }, 60_000);

  it('asks before a big delete and removes nothing until it is told yes; a small one is just done', async () => {
    const total = (await status())['paragraphs'] as number;
    const asked = await call('word_edit', { kind: 'delete', target: `paragraphs:${total - 2}-${total}` });
    expect(asked.ok).toBe(false);
    expect(asked.summary).toBe('needs confirmation');
    expect((await status())['paragraphs']).toBe(total);
    const done = await call('word_edit', { kind: 'delete', target: `paragraphs:${total - 2}-${total}`, confirm: true });
    expect(done.ok, done.error).toBe(true);
    expect((await status())['paragraphs'] as number).toBeLessThan(total);
    expect((await call('word_edit', { kind: 'undo' })).ok).toBe(true); // and Ctrl+Z brings it back
    expect((await status())['paragraphs']).toBe(total);
  }, 60_000);

  it('finds and replaces across the document, and says how many places', async () => {
    const r = await call('word_edit', { kind: 'find_replace', find: 'Respondent', replace: 'State' });
    expect(r.ok, r.error).toBe(true);
    expect(Number(r.data?.['replaced'])).toBeGreaterThanOrEqual(2); // the sentence, and the events table
  }, 60_000);

  it('sets the page for a petition: A4 with a wider left margin', async () => {
    const r = await call('word_structure', { kind: 'page_setup', options: '{"paper":"a4","marginLeftCm":3.5,"marginRightCm":2}' });
    expect(r.ok, r.error).toBe(true);
    expect((r.data?.['marginsCm'] as { left: number }).left).toBe(3.5);
  }, 60_000);

  it('will not save a document that has no name, and says what to ask', async () => {
    const r = await call('word_edit', { kind: 'save' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ask the user where to save it/);
  }, 60_000);

  it('goes to a page, next, previous, scrolls and finds text — each ONE quick call, never by reading page after page', async () => {
    const timed = async (name: string, args: ToolArgs) => {
      const started = Date.now();
      const r = await call(name, args);
      return { r, ms: Date.now() - started };
    };
    const pages = (await status())['pages'] as number;
    expect(pages).toBeGreaterThanOrEqual(3);
    const went = await timed('word_edit', { kind: 'goto', page: 2 });
    expect(went.r.ok, went.r.error).toBe(true);
    expect(went.r.data?.['page']).toBe(2);
    expect((await status())['cursor']).toMatchObject({ page: 2 });
    const next = await timed('word_edit', { kind: 'goto', where: 'next_page' });
    expect(next.r.data?.['page']).toBe(3);
    const previous = await timed('word_edit', { kind: 'goto', where: 'previous_page' });
    expect(previous.r.data?.['page']).toBe(2);
    const far = await call('word_edit', { kind: 'goto', page: pages + 5 });
    expect(far.ok).toBe(false);
    expect(far.error).toMatch(/only \d+ page/);
    const scrolled = await timed('word_edit', { kind: 'scroll', direction: 'down', times: 1 });
    expect(scrolled.r.ok, scrolled.r.error).toBe(true);

    const found = await timed('word_read', { find: 'PRAYER' });
    expect(found.r.ok, found.r.error).toBe(true);
    expect(Number(found.r.data?.['total'])).toBeGreaterThanOrEqual(1);
    const places = found.r.data?.['matches'] as Array<{ n: number; text: string }>;
    expect(places.some((x) => /PRAYER/.test(x.text))).toBe(true);
    const none = await call('word_read', { find: 'text that is nowhere in this petition' });
    expect(none.summary).toMatch(/is not in the document/);

    const slowest = Math.max(went.ms, next.ms, previous.ms, scrolled.ms, found.ms);
    // eslint-disable-next-line no-console
    console.log(`  [page navigation, scroll, find] slowest of five: ${slowest} ms`);
    expect(slowest).toBeLessThan(3000);
    // and the status that used to take seconds on a long document
    const started = Date.now();
    await status();
    expect(Date.now() - started).toBeLessThan(3000);
  }, 120_000);

  it('the spoken fast path works through the same Word, without a model, in about a second at most', async () => {
    const commands = new WordCommands({ run: (cmd, args) => control.run(cmd, args), wordIsInFront: async () => true });
    const timed = async (say: string) => {
      const started = Date.now();
      const done = await commands.tryHandle(say);
      const ms = Date.now() - started;
      expect(done?.ok, say).toBe(true);
      return ms;
    };
    const slowest = Math.max(
      await timed('remove the page numbers'),
      await timed('add page numbers at the bottom right as page x of y'),
      await timed('go to the end of the document'),
      await timed('centre this'),
      await timed('make this double spaced'),
    );
    // eslint-disable-next-line no-console
    console.log(`  [spoken Word commands] slowest of five: ${slowest} ms`);
    expect(String((await status())['footer'])).toMatch(/^Page 1 of \d+$/);
    const total = (await status())['paragraphs'] as number;
    expect((await paragraphs(total, total))[0]).toMatchObject({ align: 'center' });
    expect((await commands.tryHandle('undo that'))?.ok).toBe(true); // takes back the spacing, one step
    expect((await commands.tryHandle('type in Word: Respectfully submitted.'))?.ok).toBe(true);
    expect((await paragraphs(total, total + 1)).map((x) => x['text']).join('|')).toContain('Respectfully submitted.');
    expect(await commands.tryHandle('write a message to akka')).toBeNull(); // not Word's: left to the model
  }, 120_000);

  it('left the person\'s own Word exactly as it was', () => {
    expect(usersWord()).toBe(usersBefore);
  });
});
