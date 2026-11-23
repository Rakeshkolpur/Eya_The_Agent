import { describe, it, expect, beforeEach } from 'vitest';
import { createWordTools } from '../src/main/tools/impl/wordTools';
import type { WordAnswer, WordCommand } from '../src/main/word/WordControl';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';
import { validateArgs } from '../src/main/tools/types';

/** A stand-in for Word: records what was asked and answers from a table. */
class FakeWord {
  readonly calls: Array<{ cmd: WordCommand; args: Record<string, unknown> }> = [];
  answers: Partial<Record<WordCommand, WordAnswer>> = {};
  async run(cmd: WordCommand, args: Record<string, unknown> = {}): Promise<WordAnswer> {
    this.calls.push({ cmd, args });
    return this.answers[cmd] ?? { ok: true };
  }
}

let fake: FakeWord;
let tools: Map<string, Tool>;

beforeEach(() => {
  fake = new FakeWord();
  tools = new Map(createWordTools({ word: fake }).map((t) => [t.schema.name, t]));
});

/** Runs a tool the way the registry does: arguments are validated against the schema first. */
async function call(name: string, args: ToolArgs = {}): Promise<ToolResult> {
  const tool = tools.get(name) as Tool;
  validateArgs(tool.schema, args);
  return tool.execute(args);
}

describe('the Word tools', () => {
  it('are six, with the names the prompt and the model rely on', () => {
    expect([...tools.keys()].sort()).toEqual(['word_edit', 'word_format', 'word_read', 'word_status', 'word_structure', 'word_write']);
  });

  it('only one of them can change anything by merely being called with text: none saves, closes or prints on its own', () => {
    const names = [...tools.values()].map((t) => t.schema.name + t.schema.description).join(' ');
    expect(names).not.toMatch(/\bprint\b.*automatically/i);
    expect(tools.get('word_edit')?.schema.description).toMatch(/save \(saves the document under its own name/);
  });
});

describe('word_status', () => {
  it('says Word is not open — with what to do — instead of failing strangely', async () => {
    fake.answers['status'] = { ok: true, found: false, why: 'Word is not open' };
    const r = await call('word_status');
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('Word is not open');
    expect(r.error).toMatch(/open_application/);
  });

  it('hands the headings and counts to the model', async () => {
    fake.answers['status'] = { ok: true, found: true, name: 'Petition.docx', pages: 4, headings: [{ n: 3, level: 1, text: 'SYNOPSIS', page: 1 }] };
    const r = await call('word_status');
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('Petition.docx: 4 pages');
    expect(r.data?.['headings']).toEqual([{ n: 3, level: 1, text: 'SYNOPSIS', page: 1 }]);
  });

  it('explains a helper that could not be reached as a busy Word, not a crash', async () => {
    fake.answers['status'] = { ok: false, why: 'Eya could not reach Word just now (it may be busy with a dialog open). Try again in a moment.' };
    const r = await call('word_status');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/busy/);
  });
});

describe('word_write', () => {
  it('sends the text exactly as given (spaces and line breaks kept) with only the formatting that was asked for', async () => {
    fake.answers['write'] = { ok: true, written: 12, paragraphs: { from: 4, to: 5 } };
    const r = await call('word_write', { text: '  1. First\nSecond  ', at: 'end', align: 'justify', bold: false });
    expect(fake.calls[0]).toEqual({ cmd: 'write', args: { text: '  1. First\nSecond  ', at: 'end', align: 'justify', bold: false } });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('wrote 19 characters in paragraphs 4–5');
  });

  it('refuses an empty text without bothering Word', async () => {
    const r = await tools.get('word_write')?.execute({ text: '' });
    expect(r?.ok).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it('passes on Word\'s own reason when it cannot write (a protected document, say)', async () => {
    fake.answers['write'] = { ok: false, why: 'the document is protected against editing' };
    const r = await call('word_write', { text: 'hello' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('the document is protected against editing.');
  });
});

describe('word_format', () => {
  it('sends only what was given, and asks for something to change', async () => {
    fake.answers['format'] = { ok: true, applied: ['bold', 'align'], places: 1 };
    const r = await call('word_format', { target: 'heading:Prayer', bold: true, align: 'center' });
    expect(fake.calls[0]).toEqual({ cmd: 'format', args: { target: 'heading:Prayer', bold: true, align: 'center' } });
    expect(r.summary).toBe('applied bold, align');

    const none = await call('word_format', { target: 'last' });
    expect(none.ok).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });

  it('rejects an alignment Word does not have, before it gets there', () => {
    expect(() => validateArgs(tools.get('word_format')?.schema as Tool['schema'], { align: 'diagonal' })).toThrow(/must be one of/);
  });
});

describe('word_structure', () => {
  it('page numbers: the options go through, and the answer says what was done', async () => {
    fake.answers['page_numbers'] = { ok: true, where: 'footer', format: 'page_n_of_m' };
    const r = await call('word_structure', { kind: 'page_numbers', options: '{"format":"page_n_of_m","align":"center"}' });
    expect(fake.calls[0]).toEqual({ cmd: 'page_numbers', args: { format: 'page_n_of_m', align: 'center' } });
    expect(r.summary).toBe('added page numbers (page_n_of_m) in the footer');
  });

  it('table of contents: placed where asked; an existing one is reported as updated', async () => {
    fake.answers['toc'] = { ok: true, updated: true };
    const r = await call('word_structure', { kind: 'table_of_contents', at: 'start', options: '{"levels":2}' });
    expect(fake.calls[0]).toEqual({ cmd: 'toc', args: { levels: 2, at: 'start' } });
    expect(r.summary).toBe('updated the table of contents');
  });

  it('a list of dates and events: rows are made into text cells, numbers included', async () => {
    fake.answers['table'] = { ok: true, rows: 3, appended: false };
    await call('word_structure', {
      kind: 'table',
      at: 'after:heading:LIST OF DATES AND EVENTS',
      options: JSON.stringify({ rows: [['S.No', 'Date', 'Event'], [1, '12.03.2020', 'Order passed'], [2, null, 'x']], header: true }),
    });
    expect(fake.calls[0]?.cmd).toBe('table');
    expect(fake.calls[0]?.args['rows']).toEqual([['S.No', 'Date', 'Event'], ['1', '12.03.2020', 'Order passed'], ['2', '', 'x']]);
    expect(fake.calls[0]?.args['at']).toBe('after:heading:LIST OF DATES AND EVENTS');
  });

  it('adding to a table needs rows; a malformed one is explained with an example', async () => {
    const bad = await call('word_structure', { kind: 'table', options: '{"rows":"not a list"}' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/list of rows/);
    expect(fake.calls).toEqual([]);
  });

  it('a running index: entries are checked, and what Word could not find is passed on', async () => {
    fake.answers['index'] = { ok: true, entries: 3, missing: ['Annexure P-9'] };
    const r = await call('word_structure', {
      kind: 'index',
      options: JSON.stringify({ entries: [{ particulars: 'Synopsis', find: 'SYNOPSIS' }, { particulars: 'Annexure P-9' }] }),
    });
    expect(r.summary).toBe('built the index with 3 entries (1 not found in the document)');
    expect(r.data?.['missing']).toEqual(['Annexure P-9']);
    const bad = await call('word_structure', { kind: 'index', options: '{"entries":[{"find":"x"}]}' });
    expect(bad.ok).toBe(false);
  });

  it('header and footer: the kind is the place, and the text is required', async () => {
    fake.answers['header_footer'] = { ok: true };
    await call('word_structure', { kind: 'footer', options: '{"text":"Page {PAGE} of {NUMPAGES}","align":"center"}' });
    expect(fake.calls[0]).toEqual({ cmd: 'header_footer', args: { text: 'Page {PAGE} of {NUMPAGES}', align: 'center', where: 'footer' } });
    const missing = await call('word_structure', { kind: 'header', options: '{}' });
    expect(missing.ok).toBe(false);
  });

  it('breaks and refreshing fields', async () => {
    await call('word_structure', { kind: 'page_break', at: 'end' });
    expect(fake.calls[0]).toEqual({ cmd: 'break', args: { kind: 'page', at: 'end' } });
    await call('word_structure', { kind: 'section_break' });
    expect(fake.calls[1]).toEqual({ cmd: 'break', args: { kind: 'section' } });
    await call('word_structure', { kind: 'update_fields' });
    expect(fake.calls[2]?.cmd).toBe('fields');
  });

  it('options that are not a JSON object are explained, not guessed at', async () => {
    for (const options of ['not json', '[1,2]', '"text"']) {
      const r = await call('word_structure', { kind: 'page_setup', options });
      expect(r.ok, options).toBe(false);
      expect(r.summary).toBe('bad options');
    }
    expect(fake.calls).toEqual([]);
  });
});

describe('word_edit', () => {
  it('a delete that would remove a lot comes back as a question, and nothing is removed until the user agrees', async () => {
    fake.answers['delete'] = { ok: false, needsConfirm: true, why: 'this would remove a lot', paragraphs: 12, characters: 4000, preview: 'PRAYER' };
    const asked = await call('word_edit', { kind: 'delete', target: 'paragraphs:3-14' });
    expect(asked.ok).toBe(false);
    expect(asked.summary).toBe('needs confirmation');
    expect(asked.error).toMatch(/ask whether to go ahead/);
    expect(asked.data).toMatchObject({ needsConfirmation: true, paragraphs: 12 });
    expect(fake.calls[0]).toEqual({ cmd: 'delete', args: { target: 'paragraphs:3-14', confirm: false } });

    fake.answers['delete'] = { ok: true, paragraphs: 12 };
    const done = await call('word_edit', { kind: 'delete', target: 'paragraphs:3-14', confirm: true });
    expect(done.ok).toBe(true);
    expect(fake.calls[1]?.args['confirm']).toBe(true);
  });

  it('find and replace: both sides are needed (an empty replacement is allowed), and a big change asks first', async () => {
    const missing = await call('word_edit', { kind: 'find_replace', find: 'Respondent' });
    expect(missing.ok).toBe(false);
    fake.answers['replace'] = { ok: true, replaced: 0 };
    const none = await call('word_edit', { kind: 'find_replace', find: 'Respondent', replace: '' });
    expect(none.summary).toBe('"Respondent" was not found');
    fake.answers['replace'] = { ok: false, needsConfirm: true, count: 40, why: '"State" appears 40 times' };
    const ask = await call('word_edit', { kind: 'find_replace', find: 'State', replace: 'Union' });
    expect(ask.summary).toBe('needs confirmation');
  });

  it('undo and redo carry the number of steps; goto, save and a new document are single asks', async () => {
    fake.answers['undo'] = { ok: true, times: 2, kind: 'undo' };
    const u = await call('word_edit', { kind: 'undo', times: 2 });
    expect(fake.calls[0]).toEqual({ cmd: 'undo', args: { times: 2 } });
    expect(u.summary).toBe('undid 2 step(s)');
    await call('word_edit', { kind: 'redo' });
    expect(fake.calls[1]?.cmd).toBe('redo');
    await call('word_edit', { kind: 'goto', where: 'end' });
    expect(fake.calls[2]).toEqual({ cmd: 'goto', args: { where: 'end' } });
    fake.answers['save'] = { ok: false, why: 'this document has not been saved yet and has no file name, so ask the user where to save it' };
    const s = await call('word_edit', { kind: 'save' });
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/ask the user where to save it/);
    fake.answers['new'] = { ok: true, name: 'Document3' };
    expect((await call('word_edit', { kind: 'new_document' })).summary).toBe('opened Document3');
  });
});

describe('finding, going to a page and scrolling — one call each, never by reading page after page', () => {
  it('word_read with find returns the places in one call, and says plainly when there are none', async () => {
    fake.answers['read'] = { ok: true, find: 'P1', total: 3, matches: [{ n: 4, text: '…item P1…', page: 1 }, { n: 77, text: '…P1 again…', page: 3 }] };
    const r = await call('word_read', { find: 'P1' });
    expect(fake.calls[0]).toEqual({ cmd: 'read', args: { find: 'P1' } });
    expect(r.summary).toBe('found "P1" in 3 paragraphs');
    expect(r.data?.['matches']).toHaveLength(2);
    fake.answers['read'] = { ok: true, find: 'zzz', total: 0, matches: [] };
    expect((await call('word_read', { find: 'zzz' })).summary).toBe('"zzz" is not in the document');
  });

  it('word_edit goto takes a page number straight to the helper, and reports where it landed', async () => {
    fake.answers['goto'] = { ok: true, page: 10, pages: 53, paragraph: 612 };
    const r = await call('word_edit', { kind: 'goto', page: 10 });
    expect(fake.calls[0]).toEqual({ cmd: 'goto', args: { page: 10 } });
    expect(r.summary).toBe('moved the cursor (page 10 of 53)');
    fake.answers['goto'] = { ok: false, why: 'the document has only 53 pages' };
    const far = await call('word_edit', { kind: 'goto', page: 99 });
    expect(far.ok).toBe(false);
    expect(far.error).toMatch(/only 53 pages/);
    await call('word_edit', { kind: 'goto', where: 'next_page' });
    expect(fake.calls[2]).toEqual({ cmd: 'goto', args: { where: 'next_page' } });
  });

  it('word_edit scroll moves the view down or up by screens', async () => {
    fake.answers['scroll'] = { ok: true, direction: 'down', times: 2 };
    const r = await call('word_edit', { kind: 'scroll', direction: 'down', times: 2 });
    expect(fake.calls[0]).toEqual({ cmd: 'scroll', args: { direction: 'down', times: 2 } });
    expect(r.summary).toBe('scrolled down');
  });
});

describe('a model that keeps reading is stopped', () => {
  it('after ten reads in a row it is told to search or ask instead, and doing something with the document starts the count again', async () => {
    let clock = 1_000_000;
    const guarded = new Map(createWordTools({ word: fake, now: () => clock }).map((t) => [t.schema.name, t]));
    const read = guarded.get('word_read') as Tool;
    fake.answers['read'] = { ok: true, from: 1, to: 30, total: 1155, paragraphs: [] };
    for (let i = 0; i < 10; i += 1) {
      clock += 2000;
      expect((await read.execute({ from: i * 30 + 1 })).ok, `read ${i + 1}`).toBe(true);
    }
    clock += 2000;
    const stopped = await read.execute({ from: 301 });
    expect(stopped.ok).toBe(false);
    expect(stopped.summary).toBe('too many reads');
    expect(stopped.error).toMatch(/find/);
    expect(stopped.error).toMatch(/page/);
    expect(fake.calls.filter((c) => c.cmd === 'read')).toHaveLength(10); // the eleventh never reached Word

    // writing something is "doing something": the count starts again
    await (guarded.get('word_write') as Tool).execute({ text: 'x' });
    clock += 2000;
    expect((await read.execute({ from: 1 })).ok).toBe(true);
  });

  it('a pause long enough is a new request, not a loop', async () => {
    let clock = 1_000_000;
    const guarded = new Map(createWordTools({ word: fake, now: () => clock }).map((t) => [t.schema.name, t]));
    const read = guarded.get('word_read') as Tool;
    for (let i = 0; i < 25; i += 1) {
      clock += 120_000; // two minutes between reads
      expect((await read.execute({ from: 1 })).ok).toBe(true);
    }
  });
});
