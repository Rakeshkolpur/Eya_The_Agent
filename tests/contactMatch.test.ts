import { describe, it, expect } from 'vitest';
import { looksLikeControl, normalizeText, parseChatQuery, phoneEnding, resolveChat } from '../src/main/chat/contactMatch';
import type { ChatCandidate } from '../src/main/chat/contactMatch';

const row = (label: string, detail?: string): ChatCandidate => ({ label, ...(detail !== undefined ? { detail } : {}) });

const BOOK: ChatCandidate[] = [
  row('Rahul Sharma', '+91 98765 00432'),
  row('Rahul Verma', '+91 91234 55987'),
  row('Priya Singh', '+91 99887 70432'),
  row('Mum', '+91 90000 11111'),
  row('Amit Kumar', '+91 98111 22333'),
  row('Dr. Meera Iyer', '+91 97000 45678'),
];

const unique = (query: string, list = BOOK, recent?: string[]) => {
  const r = resolveChat(query, list, recent !== undefined ? { recent } : {});
  return r.kind === 'unique' ? r.match.candidate.label : r.kind;
};
const ambiguous = (query: string, list = BOOK) => {
  const r = resolveChat(query, list);
  return r.kind === 'ambiguous' ? r.matches.map((m) => m.candidate.label).sort() : r.kind;
};

describe('which chat does the user mean — by name', () => {
  it('a full name, in any case, with punctuation or accents', () => {
    expect(unique('Rahul Sharma')).toBe('Rahul Sharma');
    expect(unique('rahul sharma')).toBe('Rahul Sharma');
    expect(unique('RAHUL  SHARMA.')).toBe('Rahul Sharma');
    expect(unique('Sharma Rahul')).toBe('Rahul Sharma'); // the other way round
    expect(unique('Rahul Sharma', [row('Rahül Sharmá')])).toBe('Rahül Sharmá');
  });

  it('a first name or a last name that only one chat has', () => {
    expect(unique('Priya')).toBe('Priya Singh');
    expect(unique('Singh')).toBe('Priya Singh');
    expect(unique('Verma')).toBe('Rahul Verma');
    expect(unique('Meera')).toBe('Dr. Meera Iyer');
    expect(unique('mum')).toBe('Mum');
  });

  it('a first name that two chats share is NOT guessed: both are shown', () => {
    expect(ambiguous('Rahul')).toEqual(['Rahul Sharma', 'Rahul Verma']);
  });

  it('adding a second word settles it', () => {
    expect(unique('Rahul Sharma')).toBe('Rahul Sharma');
    expect(unique('Rahul Verma')).toBe('Rahul Verma');
    expect(unique('Rahul V')).toBe('Rahul Verma'); // a start of a word is enough
  });

  it('words that are not part of a name are ignored ("the chat named …", "contact …")', () => {
    expect(unique('the chat named Priya Singh')).toBe('Priya Singh');
    expect(unique('contact Amit')).toBe('Amit Kumar');
    expect(unique('send to Priya')).toBe('Priya Singh');
  });

  it('nothing fits: none, never the nearest guess', () => {
    expect(resolveChat('Zorro', BOOK).kind).toBe('none');
    expect(resolveChat('', BOOK).kind).toBe('none');
    expect(resolveChat('the', BOOK).kind).toBe('none');
    expect(resolveChat('Rahul Gupta', BOOK).kind).toBe('none'); // one word fits, the other does not: not the same person
  });

  it('a name the speech recogniser spelled slightly wrong still finds the one person (and says it was close)', () => {
    const r = resolveChat('Priyaa Sing', BOOK);
    expect(r.kind).toBe('unique');
    if (r.kind === 'unique') expect(r.match.candidate.label).toBe('Priya Singh');
    const close = resolveChat('Merra Iyer', BOOK);
    expect(close.kind).toBe('unique');
    if (close.kind === 'unique') expect(close.match.strength).toBe('fuzzy');
  });

  it('short names are not fuzzed: "Mom" does not become "Mum"', () => {
    expect(resolveChat('Mom', BOOK).kind).toBe('none');
  });

  it('an exact name wins over a longer one that merely contains it', () => {
    const list = [row('Amit'), row('Amit Kumar'), row('Amit Kumari')];
    expect(unique('Amit', list)).toBe('Amit');
    expect(ambiguous('Amit Kumar', [row('Amit Kumar Work'), row('Amit Kumari')])).toEqual(['Amit Kumar Work', 'Amit Kumari']);
  });

  it('the same chat listed twice (a result and the list) counts once', () => {
    expect(unique('Priya', [row('Priya Singh'), row('Priya Singh')])).toBe('Priya Singh');
  });

  it('names in other scripts match (Telugu, Hindi)', () => {
    const list = [row('రాహుల్ శర్మ'), row('प्रिया सिंह'), row('Mum')];
    expect(unique('రాహుల్', list)).toBe('రాహుల్ శర్మ');
    expect(unique('प्रिया', list)).toBe('प्रिया सिंह');
  });

  it('breaks a tie with a chat used earlier in this conversation, and says it did', () => {
    const r = resolveChat('Rahul', BOOK, { recent: ['rahul sharma'] });
    expect(r.kind).toBe('unique');
    if (r.kind === 'unique') {
      expect(r.match.candidate.label).toBe('Rahul Sharma');
      expect(r.viaRecent).toBe(true);
    }
    expect(resolveChat('Rahul', BOOK, { recent: ['Rahul Sharma', 'Rahul Verma'] }).kind).toBe('ambiguous'); // two used: still has to ask
    expect(resolveChat('Rahul', BOOK, { recent: ['Mum'] }).kind).toBe('ambiguous');
  });
});

describe('which chat does the user mean — by phone number', () => {
  it('the last digits ("ending 432" fits two here, so it asks; more digits settle it)', () => {
    expect(ambiguous('ending 432')).toEqual(['Priya Singh', 'Rahul Sharma']);
    expect(unique('ending 00432')).toBe('Rahul Sharma');
    expect(unique('ending in 70432')).toBe('Priya Singh');
    expect(unique('number ending 11111')).toBe('Mum');
  });

  it('the first digits, with or without the country code', () => {
    expect(unique('starting 98765')).toBe('Rahul Sharma');
    expect(unique('starts with 91234')).toBe('Rahul Verma');
    expect(unique('+91 98111')).toBe('Amit Kumar');
    expect(unique('starting 9198765')).toBe('Rahul Sharma');
  });

  it('a whole number', () => {
    expect(unique('+91 98765 00432')).toBe('Rahul Sharma');
    expect(unique('9876500432')).toBe('Rahul Sharma');
    expect(unique('91 99887 70432')).toBe('Priya Singh');
  });

  it('a name and digits together: both must fit', () => {
    expect(unique('Rahul ending 432')).toBe('Rahul Sharma');
    expect(unique('Rahul ending 987')).toBe('Rahul Verma');
    expect(resolveChat('Rahul ending 111', BOOK).kind).toBe('none');
    expect(unique('Priya 432')).toBe('Priya Singh');
  });

  it('an unsaved contact is shown as its number, and is found by it', () => {
    const list = [row('+91 98765 43210'), row('Priya Singh')];
    expect(unique('ending 3210', list)).toBe('+91 98765 43210');
    expect(unique('starting 98765', list)).toBe('+91 98765 43210');
  });

  it('digits that are in nobody\'s number find nothing', () => {
    expect(resolveChat('ending 999', BOOK).kind).toBe('none');
    expect(resolveChat('ending 5', BOOK).kind).toBe('none'); // too short to mean anything
  });

  it('with no number shown in the list, a name plus digits can only be a partial fit — never a confident one', () => {
    const r = resolveChat('Priya ending 432', [row('Priya Singh')]);
    expect(r.kind).toBe('unique');
    if (r.kind === 'unique') expect(r.match.strength).toBe('partial');
    expect(resolveChat('ending 432', [row('Priya Singh')]).kind).toBe('none');
  });

  it('reports the visible ending of the number, so the user can be told who it is', () => {
    const r = resolveChat('Priya', BOOK);
    if (r.kind !== 'unique') throw new Error('expected unique');
    expect(r.match.phoneEnding).toBe('432');
  });
});

describe('the parts', () => {
  it('splits what was said into name words and digits', () => {
    expect(parseChatQuery('Rahul ending in 432')).toEqual({ names: ['rahul'], digits: '432', digitMode: 'ends' });
    expect(parseChatQuery('the number starting 98765')).toEqual({ names: [], digits: '98765', digitMode: 'starts' });
    expect(parseChatQuery('+91 98765 00432')).toEqual({ names: [], digits: '919876500432', digitMode: 'any' });
    expect(parseChatQuery('Priya Singh')).toEqual({ names: ['priya', 'singh'], digits: '', digitMode: null });
  });

  it('finds the end of a phone number in text, and ignores short numbers', () => {
    expect(phoneEnding('+91 98765 00432')).toBe('432');
    expect(phoneEnding('call 9876500432 now', 4)).toBe('0432');
    expect(phoneEnding('room 101 at 10:42')).toBeNull();
    expect(phoneEnding('')).toBeNull();
  });

  it('normalises text without damaging other scripts', () => {
    expect(normalizeText('  Rahül-Sharma!! ')).toBe('rahul sharma');
    expect(normalizeText('प्रिया')).toBe('प्रिया');
  });

  it('knows a button from a person', () => {
    for (const c of ['Send', 'Attach', 'Search', 'New chat', 'Status', 'Settings', 'Type a message', 'Photos & videos', 'Document']) expect(looksLikeControl(c), c).toBe(true);
    for (const p of ['Rahul Sharma', 'Mum', 'Priya', 'Document Control Team']) expect(looksLikeControl(p), p).toBe(false);
  });
});
