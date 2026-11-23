import { describe, expect, it } from 'vitest';
import { findTimePhrase, parseFileFinding } from '../src/main/chat/chatFiles';

describe('findTimePhrase: only an explicit time cue', () => {
  it.each([
    ['find the file i sent last week', 'last week'],
    ['the pdf from yesterday', 'yesterday'],
    ['sent 3 days ago', '3 days ago'],
    ['in the last 10 days', 'in the last 10 days'],
    ['in october', 'in october'],
    ['on 21/10/2026', 'on 21/10/2026'],
    ['on monday', 'on monday'],
  ])('%s → %s', (text, phrase) => {
    expect(findTimePhrase(text)).toBe(phrase);
  });
  it('a bare month in a file name is not a time', () => {
    expect(findTimePhrase('find the august report')).toBeNull();
    expect(findTimePhrase('the may budget file')).toBeNull();
  });
});

describe('parseFileFinding: asking where a file is in the chats', () => {
  it('"check this file where it is in WhatsApp" is about the file just talked of', () => {
    expect(parseFileFinding('check this file where it is in whatsapp')).toMatchObject({ app: 'whatsapp', words: '', deictic: true, direction: 'any' });
  });

  it('copes with how the user types WhatsApp', () => {
    expect(parseFileFinding('check this file where it is in whtsapp')).toMatchObject({ app: 'whatsapp', deictic: true });
    expect(parseFileFinding('where is this file in whats app')).toMatchObject({ app: 'whatsapp', deictic: true });
  });

  it('a file I sent, a time, a name', () => {
    expect(parseFileFinding('find the resume pdf I sent last week on WhatsApp')).toEqual({ app: 'whatsapp', words: 'resume pdf', deictic: false, when: 'last week', direction: 'sent' });
  });

  it('a file I sent to someone: who it went to is kept apart from the file words', () => {
    expect(parseFileFinding('which chat did I send the fee receipt pdf to Anna in whatsapp')).toMatchObject({ words: 'fee receipt pdf', to: 'anna', direction: 'sent' });
    expect(parseFileFinding('where is the bail petition file i sent to someone last week in whatsapp')).toMatchObject({ words: 'bail petition', when: 'last week', direction: 'sent' });
  });

  it('a file somebody sent me', () => {
    expect(parseFileFinding('find the agreement document from Priya Singh in whatsapp')).toMatchObject({ words: 'agreement', from: 'priya singh', direction: 'received' });
  });

  it('a time only is a request too (the files of last week)', () => {
    expect(parseFileFinding('find the file i sent yesterday in whatsapp')).toMatchObject({ words: '', when: 'yesterday', direction: 'sent', deictic: false });
  });

  it('"in the chats" without naming the app is enough', () => {
    expect(parseFileFinding('search the invoice pdf in my chats')).toMatchObject({ app: null, words: 'invoice pdf' });
  });

  it('is not about sending a file, or finding one on this PC, or a chat', () => {
    expect(parseFileFinding('send the resume pdf to Anna on whatsapp')).toBeNull();
    expect(parseFileFinding('find the resume pdf and send it to Anna on whatsapp')).toBeNull();
    expect(parseFileFinding('where is my resume file')).toBeNull();
    expect(parseFileFinding('find resume.pdf')).toBeNull();
    expect(parseFileFinding('open Anna chat on whatsapp')).toBeNull();
    expect(parseFileFinding('find Anna on whatsapp')).toBeNull();
    expect(parseFileFinding('message Anna on whatsapp where is the file')).toBeNull();
  });
});
