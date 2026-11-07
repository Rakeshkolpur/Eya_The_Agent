import { describe, expect, it } from 'vitest';
import { chooseClickTarget, findListItem, normalizePageState } from '../src/main/chrome/pageState';
import { resolveChat } from '../src/main/chat/contactMatch';
import { phoneDigits, splitPhone } from '../src/main/chat/phone';
import { cleanMessageText, parseChatIntent } from '../src/main/local/chatIntents';
import { runningImageOf } from '../src/main/tools/impl/openApplication';

/**
 * The request is understood before anything is clicked: which app, who it is for (a name or a number), what is to be done, what is to be sent. These
 * run the real parser. "Open WhatsApp and send msg to +91 884 031 0914 "hello"" used to match nothing at all and went to the model.
 */

describe('the request, parsed before anything is clicked', () => {
  it('keeps the app, the recipient and the message of "open WhatsApp and send msg to <number> "hello""', () => {
    const intent = parseChatIntent('open whatsapp and send msg to +91 884 031 0914 " hello "');
    // the quotation marks say where the message is, so the number and the message are told apart at once (and the marks are not part of the message)
    expect(intent).toMatchObject({ kind: 'message', app: 'whatsapp', name: '+91 884 031 0914', text: 'hello' });
    expect(phoneDigits((intent as { name: string }).name)).toBe('918840310914');
    // (said without the marks, the number still ends where the digits do)
    const unmarked = parseChatIntent('open whatsapp and send msg to +91 884 031 0914 hello there');
    expect(unmarked).toMatchObject({ kind: 'message_unsplit', app: 'whatsapp' });
    const split = splitPhone((unmarked as { rest: string }).rest);
    expect(split?.name).toBe('+91 884 031 0914');
    expect(cleanMessageText(split?.text ?? '')).toBe('hello there');
  });

  it('a phone number is a recipient in every wording', () => {
    for (const [say, name, text] of [
      ['send message to +91 884 031 0914 saying hello', '+91 884 031 0914', 'hello'],
      ['send hello to +91 884 031 0914 on whatsapp', '+91 884 031 0914', 'hello'],
      ['send "Hello, how are you?" to 9840310914 on WhatsApp', '9840310914', 'Hello, how are you?'],
      ['message 98403 10914 saying see you at five', '98403 10914', 'see you at five'],
    ] as const) {
      expect(parseChatIntent(say), say).toMatchObject({ kind: 'message', name, text });
    }
  });

  it('the opening words name the app, whichever app', () => {
    expect(parseChatIntent("open whatsapp and message Ravi that I'll be late")).toMatchObject({ kind: 'message', app: 'whatsapp', name: 'Ravi', text: "I'll be late" });
    expect(parseChatIntent('Open Telegram then send hi to Amma')).toMatchObject({ app: 'telegram' });
    expect(parseChatIntent('open whatsapp')).toBeNull(); // opening an app is not a message
  });

  it('"send this PDF to Anna on WhatsApp" is a file, the one being talked about, for Anna, on WhatsApp', () => {
    expect(parseChatIntent('Send this PDF to Anna on WhatsApp.')).toEqual({ kind: 'send_file', app: 'whatsapp', name: 'Anna', file: 'PDF', deictic: true, fileType: 'pdf' });
    expect(parseChatIntent('send the pdf to Anna Reddy')).toMatchObject({ kind: 'send_file', name: 'Anna Reddy', deictic: true });
  });

  it('a file that is named, or looked for, is not "this file"', () => {
    expect(parseChatIntent('send resume.pdf to Anna on whatsapp')).toEqual({ kind: 'send_file', app: 'whatsapp', name: 'Anna', file: 'resume.pdf' });
    expect(parseChatIntent('send the latest pdf to Anna on whatsapp')).toEqual({ kind: 'send_file', app: 'whatsapp', name: 'Anna', file: 'latest pdf' });
    expect(parseChatIntent('send my report to Priya Singh on whatsapp')).toMatchObject({ file: 'report' });
    expect((parseChatIntent('send my report to Priya Singh on whatsapp') as { deictic?: boolean }).deictic).toBeUndefined();
  });

  it('a request for an app that has no adapter is not taken for WhatsApp', () => {
    for (const say of ['message Anna on snapchat saying hi', 'send hi to Anna on instagram', 'tell Anna on messenger that I am late', 'message Ravi by email saying hello']) {
      expect(parseChatIntent(say), say).toBeNull();
    }
    // the same words for an app that has one are handled
    expect(parseChatIntent('message Anna on whatsapp saying hi')).toMatchObject({ kind: 'message', app: 'whatsapp', name: 'Anna' });
  });

  it('a phone number needs the whole number to count', () => {
    expect(phoneDigits('98765 43210')).toBe('919876543210');
    expect(phoneDigits('+91 98765-43210')).toBe('919876543210');
    expect(phoneDigits('09876543210')).toBe('919876543210');
    expect(phoneDigits('432')).toBeNull();
    expect(phoneDigits('Anna 98765 43210')).toBeNull();
  });
});

describe('what a match rests on', () => {
  const names = (labels: string[]) => labels.map((label) => ({ label }));
  const outcome = (query: string, labels: string[]) => {
    const r = resolveChat(query, names(labels));
    return r.kind === 'unique' ? { kind: r.kind, label: r.match.candidate.label, verified: r.match.verified, evidence: r.match.evidence } : r.kind === 'ambiguous' ? { kind: r.kind, labels: r.matches.map((m) => m.candidate.label) } : { kind: r.kind };
  };

  it('an exact name wins over every name that contains it, and is the only thing here that identifies', () => {
    expect(outcome('Anna', ['Ramesh Anna', 'Anna Reddy', 'Anna', 'Anna Kumar'])).toEqual({ kind: 'unique', label: 'Anna', verified: true, evidence: 'exact name' });
  });

  it('case and spacing are harmless', () => {
    expect(outcome('  anna ', ['Ramesh Anna', 'ANNA'])).toMatchObject({ label: 'ANNA', verified: true });
  });

  it('with no exact name, the names that contain it are asked about, never chosen by position', () => {
    expect(outcome('Anna', ['Ramesh Anna', 'Anna Reddy', 'Anna Kumar'])).toEqual({ kind: 'ambiguous', labels: expect.arrayContaining(['Ramesh Anna', 'Anna Reddy', 'Anna Kumar']) });
    // (whichever order the page lists them in, the answer is the same: a question)
    expect(outcome('Anna', ['Anna Kumar', 'Anna Reddy', 'Ramesh Anna']).kind).toBe('ambiguous');
  });

  it('one name that merely contains what was said is a likely match, not a verified one', () => {
    expect(outcome('Anna', ['Ramesh Anna', 'Mum'])).toEqual({ kind: 'unique', label: 'Ramesh Anna', verified: false, evidence: 'part of the name' });
    expect(outcome('Ramesh', ['Ramesh Anna', 'Mum'])).toMatchObject({ verified: false });
  });

  it('the same words in another order, and a close spelling, are likely matches too', () => {
    expect(outcome('Reddy Anna', ['Anna Reddy', 'Mum'])).toEqual({ kind: 'unique', label: 'Anna Reddy', verified: false, evidence: 'same words' });
    expect(outcome('Rahull', ['Rahul', 'Mum'])).toMatchObject({ verified: false, evidence: 'close spelling' });
  });

  it('a whole phone number identifies; the end of a number does not', () => {
    const rows = [{ label: 'Rahul Sharma', detail: '+91 98765 00432' }, { label: 'Priya Singh', detail: '+91 99887 70432' }];
    expect(resolveChat('+91 98765 00432', rows)).toMatchObject({ kind: 'unique', match: { verified: true, evidence: 'full phone number' } });
    expect(resolveChat('number ending 432', rows).kind).toBe('ambiguous');
    const one = resolveChat('number ending 00432', [rows[0] as { label: string; detail: string }]);
    expect(one).toMatchObject({ kind: 'unique', match: { verified: false, evidence: 'part of the number' } });
  });
});

describe('opening a list row by what it is', () => {
  const state = (elements: Array<Record<string, unknown>>) =>
    normalizePageState({ url: 'https://web.whatsapp.com/', title: 'WhatsApp', headings: [], elements: elements.map((e, i) => ({ id: `e${i}`, inViewport: true, ...e })), dialogs: [], visibleText: '', tables: [], scroll: { y: 0, max: 0, atBottom: true }, challenge: null, loading: false, notes: [] });

  it('finds the row by its first line even when the rest of its text has changed', () => {
    const now = state([
      { role: 'clickable', name: 'Chats', region: 'nav' },
      { role: 'clickable', name: 'Anna Reddy see you 10:44 2 unread messages', primary: 'Anna Reddy' },
      { role: 'clickable', name: 'Anna new message 10:44', primary: 'Anna' },
    ]);
    expect(findListItem(now, { primary: 'Anna', name: 'Anna call me 10:42' })).toMatchObject({ kind: 'target', element: { primary: 'Anna', id: 'e2' } });
    // by the old words (the whole row as it was) the click had nothing to land on
    expect(chooseClickTarget(now, 'Anna call me 10:42').kind).not.toBe('target');
  });

  it('does not take a different chat for it ("Anna" is not "Anna Reddy" or "Ramesh Anna")', () => {
    const now = state([
      { role: 'clickable', name: 'Ramesh Anna ok 10:44', primary: 'Ramesh Anna' },
      { role: 'clickable', name: 'Anna Reddy see you 10:44', primary: 'Anna Reddy' },
    ]);
    expect(findListItem(now, { primary: 'Anna' }).kind).toBe('none');
  });

  it('the same chat shown twice is one chat: the one showing, a row of the list before the app\'s own menus', () => {
    const now = state([
      { role: 'clickable', name: 'Anna', region: 'nav', primary: 'Anna' },
      { role: 'clickable', name: 'Anna Hey there! I am using WhatsApp', primary: 'Anna', inViewport: false },
      { role: 'clickable', name: 'Anna call me 10:44', primary: 'Anna' },
    ]);
    expect(findListItem(now, { primary: 'Anna' })).toMatchObject({ kind: 'target', element: { id: 'e2' } });
  });

  it('never opens a row that is hidden or disabled', () => {
    const now = state([{ role: 'clickable', name: 'Anna x', primary: 'Anna', hidden: true }, { role: 'clickable', name: 'Anna y', primary: 'Anna', disabled: true }]);
    expect(findListItem(now, { primary: 'Anna' }).kind).toBe('none');
  });
});

describe('an app that is already open', () => {
  it('is recognised by its name among the running programs', () => {
    expect(runningImageOf('WhatsApp', ['explorer.exe', 'WhatsApp.Root.exe'])).toBe('WhatsApp.Root.exe');
    expect(runningImageOf('Spotify', ['chrome.exe', 'Spotify.exe'])).toBe('Spotify.exe');
    expect(runningImageOf('WhatsApp', ['explorer.exe', 'chrome.exe'])).toBeNull();
    expect(runningImageOf('app', ['application.exe'])).toBeNull(); // a name too short to say anything
  });
});
