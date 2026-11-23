import { describe, it, expect, beforeEach } from 'vitest';
import { WordCommands, pageNumberFrom, parseWordIntent, workingInWord } from '../src/main/word/WordCommands';
import type { WordAnswer, WordCommand } from '../src/main/word/WordControl';
import { CommandChain } from '../src/main/local/CommandChain';

const intent = (text: string) => parseWordIntent(text);

describe('what is taken as a Word command (exact phrasings only)', () => {
  it('page numbers: add, where, "Page X of Y", remove', () => {
    for (const say of ['add page numbers', 'Add page numbers.', 'insert page numbers', 'add page numbers please', 'put page numbers at the bottom', 'add page numbers to the document', 'Eya, add page numbers']) {
      expect(intent(say), say).toMatchObject({ scope: 'document', cmd: 'page_numbers', args: { where: 'footer', align: 'center', format: 'number' } });
    }
    expect(intent('add page numbers at the top right')).toMatchObject({ cmd: 'page_numbers', args: { where: 'header', align: 'right' } });
    expect(intent('add page numbers at the bottom left')).toMatchObject({ cmd: 'page_numbers', args: { where: 'footer', align: 'left' } });
    expect(intent('add page numbers as page x of y')).toMatchObject({ args: { format: 'page_n_of_m' } });
    expect(intent('remove the page numbers')).toMatchObject({ cmd: 'page_numbers', args: { remove: true } });
  });

  it('table of contents and refreshing the numbers', () => {
    expect(intent('insert a table of contents')).toMatchObject({ scope: 'document', cmd: 'toc', args: { title: 'TABLE OF CONTENTS' } });
    expect(intent('add the table of contents at the start')).toMatchObject({ cmd: 'toc', args: { at: 'start' } });
    for (const say of ['update the table of contents', 'update the index', 'refresh the page numbers', 'update all fields', 'update the index and page numbers']) {
      expect(intent(say), say).toMatchObject({ scope: 'document', cmd: 'fields' });
    }
  });

  it('what acts at the cursor needs Word in front: formatting, breaks, undo, save, moving', () => {
    expect(intent('bold this')).toMatchObject({ scope: 'front', cmd: 'format', args: { target: 'selection', bold: true } });
    expect(intent('make this italic')).toMatchObject({ args: { italic: true } });
    expect(intent('make that underlined')).toMatchObject({ args: { underline: true } });
    expect(intent('centre this')).toMatchObject({ args: { align: 'center' } });
    expect(intent('justify this paragraph')).toMatchObject({ args: { align: 'justify' } });
    expect(intent('align right')).toMatchObject({ args: { align: 'right' } });
    expect(intent('make this double spaced')).toMatchObject({ args: { lineSpacing: 2 } });
    expect(intent('set line spacing to 1.5')).toMatchObject({ args: { lineSpacing: 1.5 } });
    expect(intent('make this heading 1')).toMatchObject({ args: { style: 'Heading 1' } });
    expect(intent('make this normal text')).toMatchObject({ args: { style: 'Normal' } });
    expect(intent('make the font size 14')).toMatchObject({ args: { fontSize: 14 } });
    expect(intent('insert a page break')).toMatchObject({ scope: 'front', cmd: 'break', args: { kind: 'page' } });
    expect(intent('new page')).toMatchObject({ cmd: 'break' });
    expect(intent('undo that')).toMatchObject({ scope: 'front', cmd: 'undo', args: { times: 1 } });
    expect(intent('undo the last three changes')).toMatchObject({ cmd: 'undo', args: { times: 3 } });
    expect(intent('redo')).toMatchObject({ cmd: 'redo' });
    expect(intent('save the document')).toMatchObject({ scope: 'front', cmd: 'save' });
    expect(intent('go to the end of the document')).toMatchObject({ cmd: 'goto', args: { where: 'end' } });
    expect(intent('new paragraph')).toMatchObject({ cmd: 'write', args: { text: '\n', newParagraph: false } });
  });

  it('"type in Word: ..." writes exactly the words after it, case and punctuation kept', () => {
    expect(intent('type in Word: The Petitioner, Mr. A. Kumar, humbly submits as follows.')).toMatchObject({
      scope: 'front',
      cmd: 'write',
      args: { text: 'The Petitioner, Mr. A. Kumar, humbly submits as follows.' },
    });
    expect(intent('write in the document This Hon’ble Court has jurisdiction')).toMatchObject({ args: { text: 'This Hon’ble Court has jurisdiction' } });
  });

  it('leaves everything else to the model', () => {
    for (const say of [
      'write a message to akka',
      'add page numbers to the report and email it to me',
      'what is a table of contents',
      'save the file to the desktop in a folder called petitions',
      'bold the word petitioner in the third paragraph',
      'open word',
      'undo the update in my bank account',
      'add the following clause in the document',
      'make the petitioner heading blue',
      '',
    ]) {
      expect(intent(say), say).toBeNull();
    }
  });
});

describe('doing them', () => {
  let calls: Array<{ cmd: WordCommand; args: Record<string, unknown> }>;
  let front: boolean;
  let answers: Partial<Record<WordCommand, WordAnswer>>;
  const word = () =>
    new WordCommands({
      run: async (cmd, args = {}) => {
        calls.push({ cmd, args });
        return answers[cmd] ?? { ok: true };
      },
      wordIsInFront: async () => front,
    });

  beforeEach(() => {
    calls = [];
    front = true;
    answers = { status: { ok: true, found: true } };
  });

  it('a document command is done when Word has a document, even if Word is not the window in front', async () => {
    front = false;
    const done = await word().tryHandle('add page numbers');
    expect(done).toMatchObject({ spoken: 'Added page numbers.', ok: true, intent: 'word' });
    expect(calls.map((c) => c.cmd)).toEqual(['status', 'page_numbers']);
  });

  it('a command that acts at the cursor is NOT done when Word is not in front: it goes to the model', async () => {
    front = false;
    expect(await word().tryHandle('bold this')).toBeNull();
    expect(await word().tryHandle('undo that')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('is never done from always-on listening', async () => {
    expect(await word().tryHandle('add page numbers', { live: true })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('with no document open it steps aside, so the model can say so', async () => {
    answers['status'] = { ok: true, found: false };
    expect(await word().tryHandle('add page numbers')).toBeNull();
    answers['status'] = { ok: false, why: 'Word is busy' };
    expect(await word().tryHandle('add page numbers')).toBeNull();
    expect(calls.every((c) => c.cmd === 'status')).toBe(true);
  });

  it('says Word\'s own reason when it cannot (a protected document)', async () => {
    answers['page_numbers'] = { ok: false, why: 'the document is protected against editing' };
    const done = await word().tryHandle('add page numbers');
    expect(done).toMatchObject({ ok: false, spoken: 'the document is protected against editing.' });
  });

  it('sends formatting at the selection, with only what was said', async () => {
    await word().tryHandle('centre this');
    expect(calls[1]).toEqual({ cmd: 'format', args: { target: 'selection', align: 'center' } });
  });
});

describe('the chain of command layers', () => {
  it('asks each in turn and stops at the first that takes the request', async () => {
    const asked: string[] = [];
    const layer = (name: string, takes: boolean) => ({
      tryHandle: async () => {
        asked.push(name);
        return takes ? { spoken: name, ok: true, intent: name, tools: [], refs: [] } : null;
      },
    });
    const chain = new CommandChain([layer('a', false), layer('b', true), layer('c', true)]);
    expect((await chain.tryHandle('x'))?.spoken).toBe('b');
    expect(asked).toEqual(['a', 'b']);
    expect(await new CommandChain([layer('a', false)]).tryHandle('x')).toBeNull();
  });
});

describe('pages and scrolling (said, not guessed at by reading)', () => {
  it('"go to page ten" and its forms go straight to the page', () => {
    for (const [say, page] of [
      ['go to page 10', 10],
      ['Go to page ten.', 10],
      ['jump to page number 12', 12],
      ['go to page twenty five', 25],
      ['go to page twenty-five', 25],
      ['take me to page 3', 3],
      ['page 7', 7],
      ['show me page forty two', 42],
    ] as const) {
      expect(parseWordIntent(say), say).toMatchObject({ scope: 'front', cmd: 'goto', args: { page } });
    }
    expect(parseWordIntent('go to page abc')).toBeNull();
    expect(parseWordIntent('go to page 0')).toBeNull();
  });

  it('next and previous page, first and last', () => {
    expect(parseWordIntent('next page')).toMatchObject({ cmd: 'goto', args: { where: 'next_page' } });
    expect(parseWordIntent('go to the next page')).toMatchObject({ cmd: 'goto', args: { where: 'next_page' } });
    expect(parseWordIntent('previous page')).toMatchObject({ cmd: 'goto', args: { where: 'previous_page' } });
    expect(parseWordIntent('go to the previous page')).toMatchObject({ cmd: 'goto', args: { where: 'previous_page' } });
    expect(parseWordIntent('go to the last page')).toMatchObject({ cmd: 'goto', args: { where: 'end' } });
    expect(parseWordIntent('go to the first page')).toMatchObject({ cmd: 'goto', args: { where: 'start' } });
  });

  it('scrolling moves the view, by as many screens as said', () => {
    expect(parseWordIntent('scroll down')).toMatchObject({ cmd: 'scroll', args: { direction: 'down', times: 1 } });
    expect(parseWordIntent('scroll up')).toMatchObject({ cmd: 'scroll', args: { direction: 'up', times: 1 } });
    expect(parseWordIntent('scroll down two pages')).toMatchObject({ args: { direction: 'down', times: 2 } });
    expect(parseWordIntent('scroll up a page')).toMatchObject({ args: { direction: 'up', times: 1 } });
    expect(parseWordIntent('scroll down a bit')).toMatchObject({ args: { direction: 'down', times: 1 } });
    expect(parseWordIntent('scroll down 3 screens')).toMatchObject({ args: { direction: 'down', times: 3 } });
  });

  it('page numbers in words', () => {
    for (const [say, n] of [['ten', 10], ['seventeen', 17], ['twenty', 20], ['ninety nine', 99], ['one hundred', 100], ['a hundred', 100], ['7', 7]] as const) {
      expect(pageNumberFrom(say), say).toBe(n);
    }
    for (const say of ['', 'zero', '0', 'banana', 'twenty banana']) expect(pageNumberFrom(say), say).toBeNull();
  });
});

describe('is Word the window the user is working in', () => {
  const w = (process: string, pid: number, over: Partial<{ state: string; foreground: boolean }> = {}) => ({ process, pid, state: 'normal', foreground: false, ...over });
  const own = new Set([100, 101]);

  it('Word has the focus', () => {
    expect(workingInWord([w('WINWORD', 5, { foreground: true }), w('chrome', 6)], own)).toBe(true);
  });

  it('another program has the focus: not Word, whatever is behind it', () => {
    expect(workingInWord([w('chrome', 6, { foreground: true }), w('WINWORD', 5)], own)).toBe(false);
  });

  it('Eya\'s own window has the focus (Talk mode was started from it): it is Word when Word is the window right behind it', () => {
    expect(workingInWord([w('eya', 100, { foreground: true }), w('WINWORD', 5), w('chrome', 6)], own)).toBe(true);
    expect(workingInWord([w('eya', 100, { foreground: true }), w('chrome', 6), w('WINWORD', 5)], own)).toBe(false);
    // minimised windows and Eya's other windows do not count as "behind"
    expect(workingInWord([w('eya', 100, { foreground: true }), w('eya', 101), w('chrome', 6, { state: 'minimized' }), w('WINWORD', 5)], own)).toBe(true);
  });

  it('nothing has the focus', () => {
    expect(workingInWord([w('WINWORD', 5)], own)).toBe(false);
    expect(workingInWord([], own)).toBe(false);
  });
});

describe('filling a running index that is already in the petition', () => {
  it('"fill the running index in my writ" and its forms are one command, with no model', () => {
    for (const say of [
      'fill the running index in my writ',
      'Fill running index in my writ.',
      'fill the index',
      'fill index',
      'fill the running index',
      'please fill the running index in this petition',
      'fill in the index',
      'complete the index',
      'fill the index page numbers',
      'fill the page numbers in the index',
      'fill the index with page numbers',
      'Eya, fill the running index in my writ petition',
      'finish the running index of the document',
    ]) {
      expect(parseWordIntent(say), say).toMatchObject({ scope: 'document', cmd: 'fill_index' });
    }
  });

  it('does not take "update the index" (that refreshes the numbers already there) or other uses of the word', () => {
    expect(parseWordIntent('update the index')).toMatchObject({ cmd: 'fields' });
    for (const say of ['fill the form', 'fill the tank', 'what is a running index', 'fill the index card with the name', 'fill index finger']) {
      expect(parseWordIntent(say), say).toBeNull();
    }
  });

  const words = (a: Record<string, unknown>) => {
    const i = parseWordIntent('fill the running index');
    return typeof i?.say === 'function' ? i.say({ ok: true, ...a }) : String(i?.say);
  };

  it('says how many it filled and which it could not find, short enough to hear', () => {
    expect(words({ filled: 6, notFound: [] })).toBe('Filled 6 entries of the index.');
    expect(words({ filled: 1, notFound: [] })).toBe('Filled 1 entry of the index.');
    expect(words({ filled: 5, notFound: ['Annexure P-7'] })).toBe('Filled 5 entries of the index. I could not find Annexure P-7 in the document, so I left those empty.');
    expect(words({ filled: 4, notFound: ['Annexure P-7', 'Annexure P-9', 'Affidavit'] })).toMatch(/I could not find Annexure P-7, Annexure P-9 and Affidavit in the document/);
    expect(words({ filled: 2, notFound: ['a', 'b', 'c', 'd', 'e'] })).toMatch(/a, b and c and 2 more in the document/);
    expect(words({ filled: 0, notFound: ['Synopsis'] })).toMatch(/^I could not find any of the index entries in the document\. I could not find Synopsis/);
  });

  it('with no index table in the document it steps aside so the model can make one, but reports other failures', async () => {
    const make = (why: string) =>
      new WordCommands({
        wordIsInFront: async () => true,
        run: async (cmd) => (cmd === 'status' ? { ok: true, found: true } : { ok: false, why }),
      });
    expect(await make('the document has no table, so there is no index to fill').tryHandle('fill the running index')).toBeNull();
    expect(await make('I could not find an index table (a table with a "Particulars" column and a "Page" column)').tryHandle('fill the index')).toBeNull();
    const protectedDoc = await make('the document is protected against editing').tryHandle('fill the index');
    expect(protectedDoc).toMatchObject({ ok: false, spoken: 'the document is protected against editing.' });
  });
});
