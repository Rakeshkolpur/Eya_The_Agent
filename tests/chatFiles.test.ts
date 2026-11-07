import { describe, expect, it } from 'vitest';
import { fileWords, matchDocRows, parseDocRows, parseWhenText, readTimeWindow } from '../src/main/chat/chatFiles';

/** Tuesday 27 October 2026, midday. */
const NOW = new Date(2026, 9, 27, 12, 0, 0);
const ymd = (d: Date | null): string => (d === null ? 'null' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);

describe('parseWhenText: the date the page writes under a file', () => {
  it.each([
    ['Today at 21:14', '2026-10-27 21:14'],
    ['Yesterday at 09:05', '2026-10-26 09:05'],
    ['Monday at 14:30', '2026-10-26 14:30'],
    ['Thursday', '2026-10-22 00:00'],
    ['Tuesday', '2026-10-20 00:00'], // today's own name means a week ago (today is written "Today")
    ['21/10/2026', '2026-10-21 00:00'],
    ['21.10.2026', '2026-10-21 00:00'], // the ".10" is never a clock
    ['21/10/26', '2026-10-21 00:00'],
    ['10/21/2026', '2026-10-21 00:00'], // month first, only when it cannot be day first
    ['21 Oct 2026', '2026-10-21 00:00'],
    ['Oct 21, 2026', '2026-10-21 00:00'],
    ['5 Nov', '2025-11-05 00:00'], // no year and still ahead → last year's
    ['3 Oct', '2026-10-03 00:00'],
    ['Today at 9.05 pm', '2026-10-27 21:05'],
  ])('%s → %s', (text, expected) => {
    expect(ymd(parseWhenText(text, NOW))).toBe(expected);
  });

  it('says null for what is not a date, never a guess', () => {
    expect(parseWhenText('', NOW)).toBeNull();
    expect(parseWhenText('No caption', NOW)).toBeNull();
    expect(parseWhenText('Page 12', NOW)).toBeNull();
    expect(parseWhenText('45/45/2026', NOW)).toBeNull();
  });
});

const PAGE = [
  'Docs',
  'Search by sender, caption or filename',
  'PDF',
  'Resume Rakesh.pdf',
  '3 MB • PDF',
  'No caption',
  'You',
  'Today at 21:14',
  'DOC',
  'Bail petition draft.docx',
  '48 KB • DOCX',
  'Please check page 3 at 10:30',
  'Anna Reddy',
  'Yesterday at 09:05',
  'XLS',
  'Fee receipts.xlsx',
  '1.2 MB • XLSX',
  'No caption',
  'You',
  '21/10/2026',
  'PDF',
  'Odd file.pdf',
  '2 MB • PDF',
  'No caption',
].join('\n');

describe('parseDocRows: the rows of the Docs list, read from the page text', () => {
  const rows = parseDocRows(PAGE, NOW);

  it('reads name, type, size, caption, sender and date of each whole row', () => {
    expect(rows.map((r) => r.file)).toEqual(['Resume Rakesh.pdf', 'Bail petition draft.docx', 'Fee receipts.xlsx']);
    expect(rows[0]).toMatchObject({ type: 'PDF', size: '3 MB', caption: '', sender: 'You', mine: true, whenText: 'Today at 21:14' });
    expect(ymd(rows[0]?.when ?? null)).toBe('2026-10-27 21:14');
    expect(rows[2]).toMatchObject({ type: 'XLSX', size: '1.2 MB', sender: 'You', mine: true });
    expect(ymd(rows[2]?.when ?? null)).toBe('2026-10-21 00:00');
  });

  it('a caption that looks like a time ("at 10:30") is a caption, not the date', () => {
    expect(rows[1]).toMatchObject({ caption: 'Please check page 3 at 10:30', sender: 'Anna Reddy', mine: false, whenText: 'Yesterday at 09:05' });
  });

  it('skips a row cut off before its date (never invents one)', () => {
    expect(rows.some((r) => r.file === 'Odd file.pdf')).toBe(false);
  });

  it('reads nothing from a page that is not a list of documents', () => {
    expect(parseDocRows('WhatsApp\nChats\nCalls', NOW)).toEqual([]);
  });
});

describe('readTimeWindow: what "last week" and friends mean', () => {
  const span = (phrase: string): string => {
    const w = readTimeWindow(phrase, NOW);
    return w === null ? 'null' : `${ymd(w.from).slice(0, 10)}..${ymd(w.to).slice(0, 10)}`;
  };

  it.each([
    ['today', '2026-10-27..2026-10-27'],
    ['yesterday', '2026-10-26..2026-10-26'],
    ['this week', '2026-10-26..2026-10-27'],
    ['last week', '2026-10-19..2026-10-27'], // loosely: from the start of last week, never narrower than seven days
    ['this month', '2026-10-01..2026-10-27'],
    ['last month', '2026-09-01..2026-09-30'],
    ['3 days ago', '2026-10-24..2026-10-24'],
    ['2 weeks ago', '2026-10-11..2026-10-15'], // the 13th, give or take two days
    ['in the last 10 days', '2026-10-18..2026-10-27'],
    ['in october', '2026-10-01..2026-10-31'],
    ['in august', '2026-08-01..2026-08-31'],
    ['in december', '2025-12-01..2025-12-31'], // ahead of now → last year's
    ['on 21/10/2026', '2026-10-21..2026-10-21'],
    ['on 5 october', '2026-10-05..2026-10-05'],
    ['on monday', '2026-10-26..2026-10-26'],
    ['last friday', '2026-10-23..2026-10-23'],
  ])('%s → %s', (phrase, expected) => {
    expect(span(phrase)).toBe(expected);
  });

  it('is null for a phrase with no time in it, and does not take "may" the verb for the month', () => {
    expect(readTimeWindow('the resume pdf', NOW)).toBeNull();
    expect(readTimeWindow('I may have sent the resume', NOW)).toBeNull();
    expect(span('in may')).toBe('2026-05-01..2026-05-31');
  });

  it('says it back in words', () => {
    expect(readTimeWindow('last week', NOW)?.label).toBe('last week or so (19 Oct – 27 Oct)');
    expect(readTimeWindow('yesterday', NOW)?.label).toBe('yesterday');
  });
});

describe('fileWords: the words that identify a file in what was said', () => {
  it('keeps the name words and the type, drops the filler', () => {
    expect(fileWords('the resume pdf')).toEqual(['resume', 'pdf']);
    expect(fileWords('Bail petition draft.docx')).toEqual(['bail', 'petition', 'draft', 'docx']);
  });
  it('"this file" has no words (it means the last one)', () => {
    expect(fileWords('this file')).toEqual([]);
    expect(fileWords('it')).toEqual([]);
  });
});

describe('matchDocRows: which rows answer the question', () => {
  const rows = parseDocRows(PAGE, NOW);
  const q = (over: Partial<Parameters<typeof matchDocRows>[1]> = {}) => matchDocRows(rows, { words: [], direction: 'any', ...over });

  it('every word must be in the name, the caption, the sender or the type', () => {
    expect(q({ words: ['resume'] }).matches.map((m) => m.file)).toEqual(['Resume Rakesh.pdf']);
    expect(q({ words: ['bail', 'draft'] }).matches.map((m) => m.file)).toEqual(['Bail petition draft.docx']);
    expect(q({ words: ['bail', 'resume'] }).matches).toEqual([]);
    expect(q({ words: ['page'] }).matches.map((m) => m.file)).toEqual(['Bail petition draft.docx']); // in the caption
  });

  it('"sent" keeps only the files the person sent, "received" the others', () => {
    expect(q({ direction: 'sent' }).matches.map((m) => m.file)).toEqual(['Resume Rakesh.pdf', 'Fee receipts.xlsx']);
    expect(q({ direction: 'received' }).matches.map((m) => m.file)).toEqual(['Bail petition draft.docx']);
  });

  it('a sender name keeps that person’s files', () => {
    expect(q({ sender: 'anna' }).matches.map((m) => m.file)).toEqual(['Bail petition draft.docx']);
  });

  it('a time window keeps only what is dated inside it, and counts what cannot be dated', () => {
    const lastWeek = readTimeWindow('last week', NOW);
    expect(q({ window: lastWeek }).matches.map((m) => m.file)).toEqual(['Resume Rakesh.pdf', 'Bail petition draft.docx', 'Fee receipts.xlsx']);
    const yesterday = readTimeWindow('yesterday', NOW);
    expect(q({ window: yesterday }).matches.map((m) => m.file)).toEqual(['Bail petition draft.docx']);
    const odd = parseDocRows('A.pdf\n1 MB • PDF\nNo caption\nYou\nsometime ago', NOW);
    expect(odd).toEqual([]); // a date it cannot read means the row is not read at all
  });

  it('remembers each match’s place in the list', () => {
    expect(q({ words: ['fee'] }).matches[0]?.index).toBe(2);
  });
});
