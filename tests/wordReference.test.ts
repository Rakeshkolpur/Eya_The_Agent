import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProfile, buildSections, compareLooks, compareSections, normalizeTitle, pageMap, parseBody } from '../src/main/word/referenceAnalyzer';
import { ReferenceStore } from '../src/main/word/ReferenceStore';
import { ReferenceService, numberFormatOf } from '../src/main/word/ReferenceService';
import type { ReferenceHost } from '../src/main/word/ReferenceService';
import type { WordAnswer, WordCommand } from '../src/main/word/WordControl';
import { createReferenceTools } from '../src/main/tools/impl/referenceTools';
import type { KnownFolders } from '../src/main/security/pathPolicy';

// ------------------------------------------------------------------------------------------------------------- XML builders
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
interface Opts {
  bold?: boolean;
  caps?: boolean;
  underline?: boolean;
  size?: number;
  font?: string;
  jc?: string;
  style?: string;
  numbered?: boolean;
  spacing?: number;
  firstLineCm?: number;
  pageBreak?: boolean;
}
const run = (t: string, o: Opts): string =>
  `<w:r><w:rPr>${o.font ? `<w:rFonts w:ascii="${o.font}" w:hAnsi="${o.font}"/>` : ''}${o.bold ? '<w:b/>' : ''}${o.caps ? '<w:caps/>' : ''}${o.underline ? '<w:u w:val="single"/>' : ''}${o.size ? `<w:sz w:val="${o.size * 2}"/>` : ''}</w:rPr>${o.pageBreak ? '<w:br w:type="page"/>' : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const para = (t: string, o: Opts = {}): string =>
  `<w:p w:rsidR="00AA">` +
  `<w:pPr>${o.style ? `<w:pStyle w:val="${o.style}"/>` : ''}${o.numbered ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ''}` +
  `${o.spacing ? `<w:spacing w:line="${Math.round(o.spacing * 240)}" w:lineRule="auto"/>` : ''}${o.firstLineCm ? `<w:ind w:firstLine="${Math.round(o.firstLineCm * 567)}"/>` : ''}` +
  `${o.jc ? `<w:jc w:val="${o.jc}"/>` : ''}<w:rPr><w:b/></w:rPr></w:pPr>${run(t, o)}</w:p>`;
const table = (rows: string[][]): string =>
  `<w:tbl><w:tblPr/>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${para(c)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;

const BODY: Opts = { jc: 'both', font: 'Times New Roman', size: 12, spacing: 1.5, firstLineCm: 1.27 };
const TITLE: Opts = { jc: 'center', bold: true, caps: true, underline: true, size: 12, font: 'Times New Roman' };

function referenceBody(): string {
  return `<w:body>${[
    para('IN THE HIGH COURT OF TELANGANA AT HYDERABAD', { jc: 'center', bold: true, size: 14, font: 'Times New Roman' }),
    para('WRIT PETITION NO. ______ OF 2026', { jc: 'center', bold: true, size: 12, font: 'Times New Roman' }),
    para('BETWEEN:', { bold: true, font: 'Times New Roman', size: 12 }),
    para('A. Kumar, aged 45 years, resident of Hyderabad ... Petitioner', BODY),
    para('SYNOPSIS', TITLE),
    para('The Petitioner challenges the order dated 12.03.2026 passed by the Respondent as arbitrary and illegal.', BODY),
    para('The Petitioner has no other efficacious remedy and approaches this Hon\u2019ble Court under Article 226.', BODY),
    para('LIST OF DATES AND EVENTS', TITLE),
    table([['S.No', 'Date', 'Event'], ['1', '12.03.2026', 'Order passed'], ['2', '20.03.2026', 'Representation made']]),
    para('GROUNDS', TITLE),
    para('1. That the order is contrary to the settled law and is liable to be set aside by this Hon\u2019ble Court.', { ...BODY, numbered: true }),
    para('2. That the Respondent did not give the Petitioner an opportunity of being heard before passing it.', { ...BODY, numbered: true }),
    para('3. That the Petitioner reserves the right to raise additional grounds at the time of hearing.', { ...BODY, numbered: true }),
    para('PRAYER', TITLE),
    para('It is therefore prayed that this Hon\u2019ble Court may be pleased to set aside the order dated 12.03.2026.', BODY),
  ].join('')}</w:body>`;
}

function halfDoneBody(): string {
  return `<w:body>${[
    para('IN THE HIGH COURT OF TELANGANA AT HYDERABAD', { jc: 'center', bold: true, size: 14 }),
    para('WRIT PETITION NO. ______ OF 2026', { jc: 'center', bold: true }),
    para('Synopsis', { jc: 'center', bold: true }),
    para('The Petitioner challenges the order.', { jc: 'left', size: 11 }),
    para('Grounds', { jc: 'center', bold: true }),
    para('1. That the order is bad.', { jc: 'left', size: 11, numbered: true }),
  ].join('')}</w:body>`;
}

describe('reading a document like a clerk', () => {
  it('finds every part (a heading with nothing under it is a part that is still empty) and reads each part\'s looks', () => {
    const paras = parseBody(referenceBody());
    const sections = buildSections(paras);
    expect(sections.map((s) => s.title)).toEqual([
      'IN THE HIGH COURT OF TELANGANA AT HYDERABAD',
      'WRIT PETITION NO. ______ OF 2026',
      'BETWEEN:',
      'SYNOPSIS',
      'LIST OF DATES AND EVENTS',
      'GROUNDS',
      'PRAYER',
    ]);
    expect(sections[0]).toMatchObject({ paragraphs: 0, words: 0 });
    expect(sections[2]).toMatchObject({ paragraphs: 1 }); // the party line

    const synopsis = sections[3];
    expect(synopsis).toMatchObject({ paragraphs: 2 });
    expect(synopsis?.titleLook).toMatchObject({ align: 'center', bold: true, caps: true, underline: true });
    expect(synopsis?.bodyLook).toMatchObject({ align: 'justify', font: 'Times New Roman', sizePt: 12, lineSpacing: 1.5, firstLineCm: 1.3 });
    expect(synopsis?.text).toContain('arbitrary and illegal');

    const dates = sections[4];
    expect(dates).toMatchObject({ tables: 1, tableRows: 3, paragraphs: 0 });
    expect(dates?.text).toBe('S.No | Date | Event\n1 | 12.03.2026 | Order passed\n2 | 20.03.2026 | Representation made');

    const grounds = sections[5];
    expect(grounds?.paragraphs).toBe(3);
    expect(grounds?.numberedShare).toBe(1);
  });

  it('does not take a long sentence, a numbered paragraph or a table cell for a title, even in capitals', () => {
    const paras = parseBody(
      `<w:body>${[
        para('THE PETITIONER SUBMITS THAT THE IMPUGNED ORDER IS ARBITRARY, ILLEGAL AND LIABLE TO BE SET ASIDE BY THIS HON\u2019BLE COURT FORTHWITH.', { bold: true }),
        para('1. THE FACTS ARE AS FOLLOWS', { bold: true, numbered: true }),
        table([['SYNOPSIS', 'x']]),
      ].join('')}</w:body>`,
    );
    expect(paras.filter((p) => p.isTitle)).toHaveLength(0);
  });

  it('uses a heading style as a title when the author did use one', () => {
    const paras = parseBody(`<w:body>${[para('Statement of facts', { style: 'Heading1' }), para('Text that follows.', BODY)].join('')}</w:body>`);
    expect(paras[0]).toMatchObject({ isTitle: true, level: 1, bold: true });
  });

  it('builds the profile the whole document follows', () => {
    const paras = parseBody(referenceBody());
    const profile = buildProfile(paras, buildSections(paras));
    expect(profile.body).toMatchObject({ align: 'justify', font: 'Times New Roman', sizePt: 12, lineSpacing: 1.5 });
    expect(profile.titles).toMatchObject({ align: 'center', bold: true });
    expect(profile.sections).toBe(7);
    expect(profile.numberedShare).toBeGreaterThan(0.2);
  });

  it('reads XML entities and non-Latin text', () => {
    const paras = parseBody(`<w:body>${para('Rama & Sons \u2014 \u0c24\u0c46\u0c32\u0c41\u0c17\u0c41', BODY)}</w:body>`);
    expect(paras[0]?.text).toBe('Rama & Sons \u2014 \u0c24\u0c46\u0c32\u0c41\u0c17\u0c41');
  });

  it('writes the page map the user will hear back, with the pages once they are known', () => {
    const sections = buildSections(parseBody(referenceBody()));
    for (const i of [0, 1, 2]) {
      sections[i]!.startPage = 1;
      sections[i]!.endPage = 1;
    }
    sections[3]!.startPage = 2;
    sections[3]!.endPage = 3;
    const lines = pageMap(sections);
    // the court, the case number and "BETWEEN:" read as one block with the party line under them
    expect(lines[0]).toMatch(/^page 1: IN THE HIGH COURT OF TELANGANA AT HYDERABAD \(\+2 more title lines\) — 1 paragraph/);
    expect(lines[1]).toMatch(/^pages 2-3: SYNOPSIS — 2 paragraphs; \d+ words; Times New Roman, 12 pt, justify, 1\.5 line spacing/);
    expect(lines[2]).toMatch(/^page \?: LIST OF DATES AND EVENTS — table of 3 rows/); // no page known yet
  });
});

describe('comparing a half-done document with a reference', () => {
  const reference = buildSections(parseBody(referenceBody()));
  const current = buildSections(parseBody(halfDoneBody()));

  it('finds the parts that are there (even when typed in a different case), the ones missing, and the ones still short', () => {
    const c = compareSections(reference, current);
    expect(c.matched.map((m) => m.title)).toEqual(['IN THE HIGH COURT OF TELANGANA AT HYDERABAD', 'WRIT PETITION NO. ______ OF 2026', 'SYNOPSIS', 'GROUNDS']);
    expect(c.missing.map((m) => m.title)).toEqual(['BETWEEN:', 'LIST OF DATES AND EVENTS', 'PRAYER']);
    expect(c.missing[1]).toMatchObject({ after: 'Synopsis' });
    expect(c.missing[2]).toMatchObject({ after: 'Grounds' });
    expect(c.matched.find((m) => m.title === 'SYNOPSIS')?.status).toBe('shorter');
    expect(c.matched.find((m) => m.title === 'GROUNDS')?.status).toBe('shorter');
    expect(c.extra).toEqual([]);
    expect(c.orderDiffers).toBe(false);
  });

  it('says what looks different in the layout, in plain words', () => {
    const rp = buildProfile(parseBody(referenceBody()), reference);
    const cp = buildProfile(parseBody(halfDoneBody()), current);
    const diffs = compareLooks(rp, cp);
    expect(diffs.join('\n')).toMatch(/Body alignment: the reference uses justify, this document left/);
    expect(diffs.join('\n')).toMatch(/Body size: the reference uses 12 pt, this document 11 pt/);
    expect(diffs.join('\n')).toMatch(/Body font: the reference uses Times New Roman/);
  });

  it('notices parts in a different order', () => {
    const swapped = [...current].reverse();
    expect(compareSections(reference, swapped).orderDiffers).toBe(true);
  });

  it('title matching ignores case, punctuation and filler words', () => {
    expect(normalizeTitle('LIST OF DATES & EVENTS:')).toBe(normalizeTitle('List of Dates and Events'));
  });
});

describe('page number formats are read back from the footer text', () => {
  it('maps what the footer shows to the format to rebuild', () => {
    expect(numberFormatOf('Page 3 of 12')).toBe('page_n_of_m');
    expect(numberFormatOf('3 of 12')).toBe('n_of_m');
    expect(numberFormatOf('- 3 -')).toBe('dash');
    expect(numberFormatOf('Page 3')).toBe('page_n');
    expect(numberFormatOf('3')).toBe('number');
    expect(numberFormatOf('')).toBe('number');
  });
});

// ------------------------------------------------------------------------------------------------------ service and tool
class FakeWord implements ReferenceHost {
  calls: Array<{ cmd: WordCommand; args: Record<string, unknown> }> = [];
  /** What is open in Word right now, and what a file would be. */
  open = { name: 'Half done.docx', body: halfDoneBody(), pages: 3 };
  file = { name: 'Old petition.docx', body: referenceBody(), pages: 6 };
  usingFile = false;
  async run(cmd: WordCommand, args: Record<string, unknown> = {}): Promise<WordAnswer> {
    this.calls.push({ cmd, args });
    if (cmd === 'analyze') {
      this.usingFile = args['path'] !== undefined;
      const d = this.usingFile ? this.file : this.open;
      return {
        ok: true,
        name: d.name,
        pages: d.pages,
        words: 300,
        tables: 1,
        tablesOfContents: 0,
        pageNumbers: true,
        header: '',
        footer: 'Page 1 of 6',
        pageSetup: { paper: 'a4', orientation: 'portrait', marginTopCm: 2.54, marginBottomCm: 2.54, marginLeftCm: 3.5, marginRightCm: 2 },
        bodyXml: d.body,
      };
    }
    if (cmd === 'pages_of') {
      const titles = args['titles'] as string[];
      return { ok: true, pages: titles.map((_t, i) => i * 2 + 1), total: 6 };
    }
    if (cmd === 'analyze_close') return { ok: true };
    if (cmd === 'apply_profile') return { ok: true, applied: ['page setup', 'body text', '3 section titles'], titlesNotFound: [] };
    return { ok: true };
  }
}

describe('learning from a file, then using it on a half-done document', () => {
  let dir: string;
  let word: FakeWord;
  let service: ReferenceService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eya-ref-'));
    word = new FakeWord();
    service = new ReferenceService(word, new ReferenceStore(join(dir, 'references')));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('learns a file (in Word\'s own hidden copy), keeps it, and says which page each part is on', async () => {
    const learned = await service.learn('writ petition', 'C:\\Users\\x\\Documents\\old.docx');
    expect(learned.ok).toBe(true);
    if (!learned.ok) return;
    expect(learned.reference).toMatchObject({ name: 'writ petition', id: 'writ-petition' });
    expect(learned.reference.source).toMatchObject({ pages: 6, fromFile: true });
    expect(learned.reference.sections.map((s) => s.startPage)).toEqual([1, 3, 5, 7, 9, 11, 13]);
    expect(learned.map[0]).toMatch(/^pages 1-6: IN THE HIGH COURT/); // the cause title block, up to where the synopsis starts
    expect(learned.map[1]).toMatch(/^pages 7-8: SYNOPSIS/);
    // the file was opened in the helper's own Word and closed again, and the user's Word was never asked for it
    expect(word.calls.map((c) => c.cmd)).toEqual(['analyze', 'pages_of', 'analyze_close']);
    expect(word.calls[0]?.args).toEqual({ path: 'C:\\Users\\x\\Documents\\old.docx' });
    expect(word.calls[1]?.args['useAnalyzed']).toBe(true);
  });

  it('closes the reference copy of Word even when reading fails', async () => {
    word.run = async (cmd) => (cmd === 'analyze' ? { ok: false, why: 'Word could not open that file' } : { ok: true });
    const got = await service.learn('x', 'C:\\Users\\x\\old.docx');
    expect(got).toMatchObject({ ok: false, why: 'Word could not open that file' });
  });

  it('remembers it for next time, by name or by a part of the name, and can list and forget', async () => {
    await service.learn('Writ petition (service matter)', undefined);
    const fresh = new ReferenceService(word, new ReferenceStore(join(dir, 'references'))); // a restart
    expect(fresh.list().map((r) => r.name)).toEqual(['Writ petition (service matter)']);
    expect(fresh.show('writ', {}).ok).toBe(true);
    expect(fresh.show(undefined, {}).ok).toBe(true); // only one learned: no need to say which
    expect(fresh.forget('writ')).toBe('Writ petition (service matter)');
    expect(fresh.list()).toEqual([]);
    expect(fresh.show('writ', {})).toMatchObject({ ok: false });
  });

  it('shows one part: its text, its pages and how it looks — and what is on a page', async () => {
    await service.learn('writ petition', 'C:/Users/x/old.docx');
    const part = service.show('writ petition', { section: 'grounds' });
    expect(part).toMatchObject({ ok: true, section: { title: 'GROUNDS', paragraphs: 3, numbered: true } });
    if (part.ok) expect(String((part['section'] as { text: string }).text)).toContain('settled law');
    const onPage = service.show('writ petition', { page: 3 });
    expect(onPage).toMatchObject({ ok: true });
    const missing = service.show('writ petition', { section: 'verification' });
    expect(missing).toMatchObject({ ok: false });
    if (!missing.ok) expect(missing.why).toMatch(/SYNOPSIS/);
  });

  it('compares the open half-done document with it: what is missing, what is short, what looks different', async () => {
    await service.learn('writ petition', 'C:\\Users\\x\\old.docx');
    word.calls = [];
    const got = await service.compare('writ petition');
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.comparison.missing.map((m) => m.title)).toEqual(['BETWEEN:', 'LIST OF DATES AND EVENTS', 'PRAYER']);
    expect(got.comparison.matched.map((m) => m.status)).toEqual(['similar', 'similar', 'shorter', 'shorter']);
    expect(got.looks.join(' ')).toMatch(/Body alignment/);
    expect(got.current).toMatchObject({ name: 'Half done.docx', pages: 3 });
  });

  it('lays the open document out like the reference, in one request to Word', async () => {
    await service.learn('writ petition', 'C:\\Users\\x\\old.docx');
    word.calls = [];
    const got = await service.applyFormat('writ petition', 'all');
    expect(got).toMatchObject({ ok: true, applied: ['page setup', 'body text', '3 section titles'] });
    const apply = word.calls.find((c) => c.cmd === 'apply_profile');
    const sent = apply?.args as {
      pageSetup: Record<string, unknown>;
      body: Record<string, unknown>;
      titles: Array<Record<string, unknown>>;
      pageNumbers: Record<string, unknown>;
    };
    expect(sent.pageSetup).toMatchObject({ paper: 'a4', marginLeftCm: 3.5 });
    expect(sent.body).toEqual({ fontName: 'Times New Roman', fontSize: 12, align: 'justify', lineSpacing: 1.5, firstLineIndentCm: 1.3 });
    // the titles of THIS document, each given the look the reference's matching title has
    expect(sent.titles.map((t) => t['text'])).toEqual(['IN THE HIGH COURT OF TELANGANA AT HYDERABAD', 'WRIT PETITION NO. ______ OF 2026', 'Synopsis', 'Grounds']);
    expect(sent.titles[2]).toMatchObject({ text: 'Synopsis', align: 'center', bold: true, underline: true, allCaps: true });
    expect(sent.pageNumbers).toEqual({ present: true, where: 'footer', align: 'center', format: 'page_n_of_m' });
  });

  it('applies only what was asked for', async () => {
    await service.learn('writ petition', undefined);
    word.calls = [];
    await service.applyFormat('writ petition', 'page_numbers');
    const sent = word.calls.find((c) => c.cmd === 'apply_profile')?.args as Record<string, unknown>;
    expect(Object.keys(sent)).toEqual(['pageNumbers']);
  });

  it('with no reference learned it says so, and with several it asks which', async () => {
    expect(service.show('anything', {})).toMatchObject({ ok: false, why: expect.stringMatching(/learn one first/) });
    await service.learn('writ petition', undefined);
    await service.learn('legal notice', undefined);
    const ambiguous = service.show(undefined, {});
    expect(ambiguous).toMatchObject({ ok: false });
    if (!ambiguous.ok) expect(ambiguous.why).toMatch(/writ petition, legal notice|legal notice, writ petition/);
  });
});

describe('the word_reference tool', () => {
  let dir: string;
  const folders = (home: string): KnownFolders => ({ home, desktop: home, documents: home, downloads: home, pictures: home, videos: home, music: home, temp: home });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eya-reftool-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const make = () => {
    const word = new FakeWord();
    const service = new ReferenceService(word, new ReferenceStore(join(dir, 'references')));
    const [tool] = createReferenceTools({ service, folders: folders(dir) });
    return { tool: tool!, word };
  };

  it('learns a Word file from the user\'s own folders, and only that', async () => {
    const { tool, word } = make();
    mkdirSync(join(dir, 'Documents'), { recursive: true });
    const file = join(dir, 'Documents', 'old petition.docx');
    writeFileSync(file, 'x');
    const ok = await tool.execute({ kind: 'learn', name: 'writ petition', path: file });
    expect(ok.ok, ok.error).toBe(true);
    expect(ok.data?.['pageMap']).toBeInstanceOf(Array);
    expect(word.calls[0]?.args['path']).toBe(file);

    const notWord = join(dir, 'Documents', 'notes.txt');
    writeFileSync(notWord, 'x');
    expect((await tool.execute({ kind: 'learn', path: notWord })).error).toMatch(/not a Word document/);
    expect((await tool.execute({ kind: 'learn', path: join(dir, 'Documents', 'nothing.docx') })).error).toMatch(/does not exist/);
    expect((await tool.execute({ kind: 'learn', path: 'C:\\Windows\\System32\\drivers\\etc\\hosts.docx' })).ok).toBe(false);
  });

  it('learns the open document when no file is given, and reports in words', async () => {
    const { tool } = make();
    const learned = await tool.execute({ kind: 'learn', name: 'half' });
    expect(learned.summary).toMatch(/^learned "half": 3 pages, \d+ parts$/);
    const list = await tool.execute({ kind: 'list' });
    expect(list.summary).toBe('1 reference');
  });

  it('compare reports what is missing and short in a sentence the model can say', async () => {
    const { tool } = make();
    await tool.execute({ kind: 'learn', name: 'writ petition' });
    const got = await tool.execute({ kind: 'compare', name: 'writ petition' });
    expect(got.ok, got.error).toBe(true);
    expect(got.summary).toMatch(/parts match/);
    expect(got.data?.['missing']).toBeInstanceOf(Array);
  });

  it('refuses things it does not know', async () => {
    const { tool } = make();
    expect((await tool.execute({ kind: 'dance' })).ok).toBe(false);
    expect((await tool.execute({ kind: 'forget', name: 'nothing' })).ok).toBe(false);
  });
});
