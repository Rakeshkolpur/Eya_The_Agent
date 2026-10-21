import { describe, it, expect } from 'vitest';
import { ReferenceCommands, parseReferenceIntent } from '../src/main/word/ReferenceCommands';

describe('what is taken as teaching Eya from a reference', () => {
  it('"learn this document as my writ petition" and its forms', () => {
    for (const [say, name] of [
      ['learn this document as my writ petition', 'writ petition'],
      ['Learn this document as my writ petition.', 'writ petition'],
      ['remember this file as a reference', undefined],
      ['use this petition as my template', undefined],
      ['save this document as the legal notice reference', 'legal notice'],
      ['study this draft as a bail application', 'bail application'],
      ['Eya, learn this document as my service matter sample', 'service matter'],
      ['learn this document', undefined],
      ['remember this document please', undefined],
      ['learn this petition as my counter affidavit template', 'counter affidavit'],
    ] as const) {
      expect(parseReferenceIntent(say), say).toEqual({ kind: 'learn', name });
    }
  });

  it('asking what has been learned', () => {
    for (const say of ['what have you learned', 'what references have you learned', 'list my references', 'show my templates', 'which documents did you remember']) {
      expect(parseReferenceIntent(say), say).toEqual({ kind: 'list' });
    }
  });

  it('"format this like my writ petition" and its forms', () => {
    for (const [say, name] of [
      ['format this like my writ petition', 'writ petition'],
      ['make this look like the writ petition', 'writ petition'],
      ['make this the same as my legal notice', 'legal notice'],
      ['apply my writ petition format', 'writ petition'],
      ['apply the legal notice layout to this document', 'legal notice'],
      ['lay out this document like my bail application', 'bail application'],
    ] as const) {
      expect(parseReferenceIntent(say), say).toEqual({ kind: 'format', name });
    }
  });

  it('leaves everything else — including filling a document, which needs the model — alone', () => {
    for (const say of [
      'fill this like my writ petition',
      'write the grounds like the reference',
      'learn Telugu',
      'learn this song',
      'remember to call Ravi',
      'save the document',
      'what is a writ petition',
      'make this bold',
      'format the disk',
      '',
    ]) {
      expect(parseReferenceIntent(say), say).toBeNull();
    }
  });
});

describe('doing them', () => {
  const sections = [
    { title: 'IN THE HIGH COURT', startPage: 1, words: 0, tableRows: 0 },
    { title: 'SYNOPSIS', startPage: 2, words: 34, tableRows: 0 },
    { title: 'LIST OF DATES AND EVENTS', startPage: 3, words: 23, tableRows: 3 },
    { title: 'GROUNDS', startPage: 4, words: 46, tableRows: 0 },
  ];
  const make = (front = true) => {
    const calls: string[] = [];
    const commands = new ReferenceCommands({
      wordIsInFront: async () => front,
      service: {
        list: () => (calls.push('list'), [{ id: 'writ-petition', name: 'writ petition', learnedAt: '', pages: 5, sections: 7, fileName: 'a.docx' }]),
        learn: async (name) => {
          calls.push(`learn:${String(name)}`);
          return { ok: true as const, map: [], reference: { id: 'x', name: name ?? 'Old petition', learnedAt: '', source: { fileName: 'a.docx', pages: 5, words: 120, paragraphs: 9, fromFile: false }, pageNumbers: true, tablesOfContents: 0, tables: 1, profile: {} as never, sections: sections as never } };
        },
        applyFormat: async (name, what) => {
          calls.push(`format:${name}:${what}`);
          return { ok: true as const, reference: 'writ petition', applied: ['page setup', 'body text'], titlesNotFound: [] };
        },
      },
    });
    return { commands, calls };
  };

  it('learns the open document and says, aloud-sized, which page each part is on', async () => {
    const { commands, calls } = make();
    const done = await commands.tryHandle('learn this document as my writ petition');
    expect(calls).toEqual(['learn:writ petition']);
    expect(done).toMatchObject({ ok: true, intent: 'word_reference' });
    expect(done?.spoken).toMatch(/^Learned writ petition: 5 pages and 4 parts\. Synopsis on page 2, list of dates and events on page 3, grounds on page 4\./);
    expect(done?.spoken).toMatch(/Tell me if I have any part wrong\.$/);
  });

  it('lists what it has learned, even when Word is not in front', async () => {
    const { commands } = make(false);
    const done = await commands.tryHandle('what have you learned');
    expect(done?.spoken).toBe('I know one reference: writ petition, 5 pages.');
  });

  it('"this document" means the one in Word: when Word is not what the user is in, it is left to the model', async () => {
    const { commands, calls } = make(false);
    expect(await commands.tryHandle('learn this document as my writ petition')).toBeNull();
    expect(await commands.tryHandle('format this like my writ petition')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('formats like the reference in one go, and says it can be undone', async () => {
    const { commands, calls } = make();
    const done = await commands.tryHandle('format this like my writ petition');
    expect(calls).toEqual(['format:writ petition:all']);
    expect(done?.spoken).toBe('Done. This document is laid out like writ petition: page setup, body text. Ctrl Z takes it back.');
  });

  it('is never done from always-on listening', async () => {
    const { commands, calls } = make();
    expect(await commands.tryHandle('learn this document as my writ petition', { live: true })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('says plainly when it cannot learn', async () => {
    const commands = new ReferenceCommands({
      wordIsInFront: async () => true,
      service: { list: () => [], learn: async () => ({ ok: false as const, why: 'Word is not open' }), applyFormat: async () => ({ ok: false as const, why: 'no reference has been learned yet' }) },
    });
    expect((await commands.tryHandle('learn this document'))?.spoken).toBe('I could not learn it: Word is not open.');
    expect((await commands.tryHandle('what have you learned'))?.spoken).toMatch(/not learned any reference yet/);
  });
});
