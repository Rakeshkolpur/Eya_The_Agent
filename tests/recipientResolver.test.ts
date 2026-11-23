import { describe, expect, it } from 'vitest';
import { looksLikeControl } from '../src/main/chat/contactMatch';
import { countryContext } from '../src/main/chat/phoneNumbers';
import { readContextReference, readRecipientReference, resolveRecipient, shownNumberOf } from '../src/main/chat/recipientResolver';
import type { RecentRecipient, RecipientRow } from '../src/main/chat/recipientResolver';

const row = (label: string, extra: Partial<RecipientRow> = {}): RecipientRow & { label: string } => ({ label, ...extra });
const NO_ROWS: Array<{ label: string }> = [];
const NOW = new Date('2026-10-26T15:00:00').getTime();
const minutesAgo = (m: number): number => NOW - m * 60_000;
const yesterdayAt = (hour: number): number => new Date(`2026-10-25T${String(hour).padStart(2, '0')}:00:00`).getTime();

describe('reading what was said', () => {
  it.each([
    ['+91 9361113900', 'full_number'],
    ['9361113900', 'full_number'],
    ['09361113900', 'full_number'],
    ['93611 13900', 'full_number'],
    ['ending 3900', 'partial_number'],
    ['the last 4 digits 3900', 'partial_number'],
    ['5361113900', 'unclear_number'],
    ['Anna', 'name'],
    ['Ravi Kumar', 'name'],
    ['akka', 'name'],
    ['him', 'context'],
    ['the same person I messaged yesterday', 'context'],
    ['nine three six one one one three nine zero zero', 'full_number'],
  ])('%s is %s', (text, kind) => {
    expect(readRecipientReference(text).kind).toBe(kind);
  });

  it('keeps what was said as it was said', () => {
    expect(readRecipientReference('  +91 93611-13900 ').raw).toBe('+91 93611-13900');
    expect(readRecipientReference('+91 93611-13900').phone?.e164).toBe('919361113900');
  });

  it('reads references to the conversation, and only those', () => {
    for (const [text, kind] of [
      ['him', 'pronoun'],
      ['her', 'pronoun'],
      ['that person', 'pronoun'],
      ['the same person', 'pronoun'],
      ['the last person', 'last'],
      ['the last one I messaged', 'last'],
      ['the person I messaged', 'last'],
      ['the same person I messaged yesterday', 'yesterday'],
      ['the person I texted yesterday', 'yesterday'],
      ['the one I messaged earlier', 'recent'],
      ['the guy I chatted with just now', 'recent'],
    ] as const) {
      expect(readContextReference(text)?.kind, text).toBe(kind);
    }
    for (const text of ['Anna', 'my brother', 'the person I messaged on Monday', 'the person I messaged last week', 'it', 'me', 'the pdf', '']) {
      expect(readContextReference(text), text).toBeNull();
    }
  });
});

describe('a whole number', () => {
  it('is resolved when a chat is listed under exactly that number, whichever way it was said', () => {
    const rows = [row('Anna Reddy'), row('+91 93611 13900'), row('Ravi')];
    for (const said of ['+91 9361113900', '9361113900', '09361113900', '91 93611 13900', 'nine three six one one one three nine zero zero']) {
      const r = resolveRecipient(said, rows);
      expect(r.status, said).toBe('resolved');
      expect(r.safeToSend, said).toBe(true);
      expect(r.chosen?.row.label, said).toBe('+91 93611 13900');
      expect(r.chosen?.evidence, said).toBe('exact_number');
      expect(r.normalized, said).toBe('919361113900');
    }
  });

  it('is resolved on the app\'s own search when the saved contact does not show its number', () => {
    const r = resolveRecipient('+91 9361113900', [row('Anna Reddy', { fromSearch: true })], { searched: true });
    expect(r.status).toBe('resolved');
    expect(r.chosen?.evidence).toBe('app_search_whole_number');
    expect(r.safeToSend).toBe(true);
  });

  it('is not settled on the app\'s search alone when the rows were not the result of a search for it', () => {
    const r = resolveRecipient('+91 9361113900', [row('Anna Reddy'), row('Ravi')]);
    expect(r.status).toBe('not_found');
    expect(r.chosen).toBeNull();
    expect(r.safeToSend).toBe(false);
  });

  it('asks which when the app found several chats for it and none shows the number', () => {
    const r = resolveRecipient('9361113900', [row('Anna Reddy'), row('Anna Kumar')], { searched: true });
    expect(r.status).toBe('ambiguous');
    expect(r.needsClarification).toBe(true);
    expect(r.question).toContain('Anna Reddy');
    expect(r.question).toContain('Anna Kumar');
    expect(r.safeToSend).toBe(false);
  });

  it('is exactly one chat when it is listed under the number even if the search listed others too', () => {
    const r = resolveRecipient('9361113900', [row('Anna Reddy', { fromSearch: true }), row('+91 93611 13900')], { searched: true });
    expect(r.status).toBe('resolved');
    expect(r.chosen?.row.label).toBe('+91 93611 13900');
  });

  it('never matches a chat that shows a different number', () => {
    const r = resolveRecipient('9361113900', [row('+91 93611 13901'), row('+91 83611 13900')], { searched: true });
    expect(r.status).toBe('not_found');
  });

  it('does not treat the same digits under another country code as the same person: it asks', () => {
    const r = resolveRecipient('9361113900', [row('+1 936 111 3900')], { searched: true });
    expect(r.status).toBe('confirm');
    expect(r.safeToSend).toBe(false);
    expect(r.chosen?.evidence).toBe('number_other_country');
    expect(r.question).not.toContain('9361113900');
    // …but a number that was written WITH its country code is never matched to another country's chat
    const withCode = resolveRecipient('+91 9361113900', [row('+1 936 111 3900')], { searched: true });
    expect(withCode.status).toBe('not_found');
  });

  it('reads a number without a country code against the configured country, and not against India', () => {
    const us = countryContext('US');
    const r = resolveRecipient('(415) 555-2671', [row('+1 415 555 2671')], { country: us });
    expect(r.status).toBe('resolved');
    expect(r.normalized).toBe('14155552671');
    // the same row is not an Indian number
    const india = resolveRecipient('(415) 555-2671', [row('+1 415 555 2671')]);
    expect(india.normalized).toBe('914155552671');
    expect(india.status).not.toBe('resolved');
  });

  it('is unreadable when the digits are not a valid number anywhere, and no chat shows them: no code is added', () => {
    const r = resolveRecipient('5361113900', [row('Anna Reddy'), row('+91 93611 13900')]);
    expect(r.status).toBe('unreadable');
    expect(r.normalized).toBeNull();
    expect(r.needsClarification).toBe(true);
    expect(r.question).toMatch(/number/);
    expect(r.chosen).toBeNull();
    // the app searched those digits and showed nobody: the same
    expect(resolveRecipient('5361113900', NO_ROWS, { searched: true }).status).toBe('unreadable');
  });

  it('if the app found a chat for digits that are not a valid number, it is said back, never sent on', () => {
    const r = resolveRecipient('5361113900', [row('Anna Reddy', { fromSearch: true })], { searched: true });
    expect(r.status).toBe('confirm');
    expect(r.safeToSend).toBe(false);
    expect(r.normalized).toBeNull();
  });

  it('still finds a chat that is listed under exactly those digits even if they are not a valid number', () => {
    const r = resolveRecipient('5361113900', [row('5361113900')]);
    expect(r.status).toBe('resolved');
  });

  it('says a number with too many digits cannot be a number', () => {
    const r = resolveRecipient('1234567890123456789', [row('Anna')]);
    expect(r.status).toBe('unreadable');
  });

  it('the same chat shown twice is one chat', () => {
    const r = resolveRecipient('9361113900', [row('+91 93611 13900'), row('+91 93611 13900')]);
    expect(r.status).toBe('resolved');
  });
});

describe('part of a number', () => {
  const rows = [row('+91 93611 13900'), row('+91 98765 00432'), row('Anna Reddy')];

  it('is resolved when exactly one chat shows a number that ends with six or more of those digits', () => {
    const r = resolveRecipient('ending 113900', rows);
    expect(r.status).toBe('resolved');
    expect(r.chosen?.evidence).toBe('number_suffix');
    expect(r.chosen?.row.label).toBe('+91 93611 13900');
    expect(r.normalized).toBeNull(); // a part of a number is never made into a whole one
  });

  it('is only said back for a shorter end: four digits are not an identity', () => {
    const r = resolveRecipient('the last 4 digits 3900', rows);
    expect(r.status).toBe('confirm');
    expect(r.safeToSend).toBe(false);
    expect(r.question).toContain('3900');
    expect(r.question).not.toContain('9361');
  });

  it('asks which when two chats show numbers with the same end (masked, never whole)', () => {
    const r = resolveRecipient('ending 3900', [row('+91 93611 13900'), row('+44 7911 123900'), row('Anna')]);
    expect(r.status).toBe('ambiguous');
    expect(r.candidates).toHaveLength(2);
    expect(r.question).toContain('••');
    expect(r.question).not.toContain('93611');
    expect(r.question).not.toContain('7911');
    expect(r.safeToSend).toBe(false);
  });

  it('asks which when two chats have the same six-digit end', () => {
    const r = resolveRecipient('ending 113900', [row('+91 93611 13900'), row('+91 70211 13900')]);
    expect(r.status).toBe('ambiguous');
    expect(r.chosen).toBeNull();
  });

  it('is never settled by the app\'s search alone: a saved contact that does not show its number is asked about', () => {
    const r = resolveRecipient('ending 3900', [row('Anna Reddy', { fromSearch: true })], { searched: true });
    expect(r.status).toBe('confirm');
    expect(r.chosen?.evidence).toBe('app_search_part_of_number');
    expect(r.safeToSend).toBe(false);
  });

  it('is not settled when one chat shows the end and the app\'s search found another that does not show its number', () => {
    const r = resolveRecipient('ending 113900', [row('+91 93611 13900'), row('Anna Reddy', { fromSearch: true })], { searched: true });
    expect(r.status).toBe('ambiguous');
    expect(r.candidates).toHaveLength(2);
  });

  it('finds nothing when no chat has those digits', () => {
    expect(resolveRecipient('ending 4444', rows).status).toBe('not_found');
    expect(resolveRecipient('ending 4444', NO_ROWS, { searched: true }).status).toBe('not_found');
  });

  it('a number that starts with the digits is weaker than one that ends with them', () => {
    const r = resolveRecipient('starting 93611', rows);
    expect(r.status).toBe('confirm');
    expect(r.chosen?.evidence).toBe('number_prefix');
  });
});

describe('a name', () => {
  const rows = [row('Anna Reddy'), row('Ramesh Anna'), row('Ravi Kumar'), row('Priya')];

  it('is resolved on an exact name', () => {
    const r = resolveRecipient('Priya', rows);
    expect(r.status).toBe('resolved');
    expect(r.chosen?.evidence).toBe('exact_name');
    expect(r.safeToSend).toBe(true);
  });

  it('is only said back for a part of a name', () => {
    const r = resolveRecipient('Ravi', rows);
    expect(r.status).toBe('confirm');
    expect(r.chosen?.row.label).toBe('Ravi Kumar');
    expect(r.safeToSend).toBe(false);
  });

  it('asks which of several names', () => {
    const r = resolveRecipient('Anna', rows);
    expect(r.status).toBe('ambiguous');
    expect(r.question).toContain('Anna Reddy');
    expect(r.question).toContain('Ramesh Anna');
  });

  it('settles a tie by the chat used earlier in this conversation, but says so (never silently)', () => {
    const r = resolveRecipient('Anna', rows, { recents: [{ label: 'Anna Reddy', at: NOW, session: true }] });
    expect(r.status).toBe('confirm');
    expect(r.chosen?.evidence).toBe('used_earlier');
    expect(r.safeToSend).toBe(false);
  });

  it('finds nobody for a name that is not there', () => {
    const r = resolveRecipient('Zainab', rows);
    expect(r.status).toBe('not_found');
    expect(r.chosen).toBeNull();
    expect(r.needsClarification).toBe(false);
  });
});

describe('a reference to the conversation', () => {
  const day = (label: string, at: number, session = false): RecentRecipient => ({ label, at, session });

  it('"him" is the one person this conversation has been about: said back, never sent on', () => {
    const r = resolveRecipient('him', NO_ROWS, { recents: [day('Anna Reddy', minutesAgo(5), true)], now: NOW });
    expect(r.status).toBe('confirm');
    expect(r.chosen?.row.label).toBe('Anna Reddy');
    expect(r.chosen?.evidence).toBe('recent_conversation');
    expect(r.safeToSend).toBe(false);
    expect(r.question).toContain('Anna Reddy');
  });

  it('"him" with two people in the conversation asks which', () => {
    const r = resolveRecipient('him', NO_ROWS, { recents: [day('Anna Reddy', minutesAgo(5), true), day('Ravi Kumar', minutesAgo(9), true)], now: NOW });
    expect(r.status).toBe('ambiguous');
    expect(r.question).toContain('Anna Reddy');
    expect(r.question).toContain('Ravi Kumar');
  });

  it('"him" with nobody in the conversation is nobody (the AI, which has the whole talk, can take it)', () => {
    expect(resolveRecipient('him', NO_ROWS, { recents: [], now: NOW }).status).toBe('not_found');
    expect(resolveRecipient('him', NO_ROWS, { recents: [day('Anna Reddy', minutesAgo(180), true)], now: NOW }).status).toBe('not_found');
  });

  it('the same chat used twice is one person', () => {
    const r = resolveRecipient('her', NO_ROWS, { recents: [day('Anna Reddy', minutesAgo(3), true), day('Anna Reddy', minutesAgo(20), true)], now: NOW });
    expect(r.status).toBe('confirm');
  });

  it('"the last person I messaged" is the most recent one, even with several', () => {
    const r = resolveRecipient('the last person I messaged', NO_ROWS, { recents: [day('Ravi Kumar', minutesAgo(90)), day('Anna Reddy', minutesAgo(10))], now: NOW });
    expect(r.status).toBe('confirm');
    expect(r.chosen?.row.label).toBe('Anna Reddy');
  });

  it('"the same person I messaged yesterday" is found by when the chats were used', () => {
    const r = resolveRecipient('the same person I messaged yesterday', NO_ROWS, {
      recents: [day('Anna Reddy', minutesAgo(10)), day('Ravi Kumar', yesterdayAt(18)), day('Priya', new Date('2026-10-24T10:00:00').getTime())],
      now: NOW,
    });
    expect(r.status).toBe('confirm');
    expect(r.chosen?.row.label).toBe('Ravi Kumar');
    expect(r.chosen?.evidence).toBe('recent_history');
    expect(r.safeToSend).toBe(false);
  });

  it('"yesterday" with two people yesterday asks, with none says nobody', () => {
    const two = resolveRecipient('the person I messaged yesterday', NO_ROWS, { recents: [day('Ravi Kumar', yesterdayAt(18)), day('Priya', yesterdayAt(9))], now: NOW });
    expect(two.status).toBe('ambiguous');
    const none = resolveRecipient('the person I messaged yesterday', NO_ROWS, { recents: [day('Anna Reddy', minutesAgo(10))], now: NOW });
    expect(none.status).toBe('not_found');
    expect(none.chosen).toBeNull();
  });

  it('never picks a chat that is a menu button', () => {
    const r = resolveRecipient('him', NO_ROWS, { recents: [day('Menu', minutesAgo(1), true)], now: NOW });
    expect(r.status).toBe('not_found');
  });
});

describe('what is and is not a chat', () => {
  it('the app\'s own buttons are never contacts', () => {
    for (const label of ['Meta AI', 'Go to Calls', 'Invite a friend', 'New call', 'New chat', 'Menu', 'Chats', 'Calls', 'Status', 'Channels', 'Communities', 'Select chats', 'Search', 'Download WhatsApp for Windows']) {
      expect(looksLikeControl(label), label).toBe(true);
    }
    for (const label of ['Anna Reddy', 'Tools', 'Go Kart Club', 'Meta Anna']) expect(looksLikeControl(label), label).toBe(false);
  });

  it('buttons among the rows are never candidates for a number or a name', () => {
    const rows = [row('Meta AI', { fromSearch: true }), row('Go to Calls', { fromSearch: true }), row('Invite a friend', { fromSearch: true })];
    expect(resolveRecipient('ending 3900', rows, { searched: true }).status).toBe('not_found');
    expect(resolveRecipient('9361113900', rows, { searched: true }).status).toBe('not_found');
    expect(resolveRecipient('Meta', rows).status).toBe('not_found');
  });

  it('reads the number a chat is listed under', () => {
    expect(shownNumberOf(row('+91 93611 13900'))).toBe('919361113900');
    expect(shownNumberOf(row('93611 13900'))).toBe('919361113900');
    expect(shownNumberOf(row('Anna Reddy', { detail: 'last seen today at 10:30' }))).toBeNull();
    expect(shownNumberOf(row('Anna Reddy'))).toBeNull();
  });
});

describe('what the answer never contains', () => {
  it('a question about a number never carries the whole number', () => {
    const r = resolveRecipient('ending 3900', [row('+91 93611 13900'), row('+44 7911 123900')]);
    const text = JSON.stringify(r.question);
    expect(text).not.toMatch(/\d{7,}/);
  });

  it('nothing is chosen unless the status says so', () => {
    for (const said of ['ending 3900', 'Anna', '5361113900', 'him']) {
      const r = resolveRecipient(said, [row('Anna Reddy'), row('Anna Kumar'), row('+91 93611 13900'), row('+44 7911 123900')], { searched: true });
      if (r.status === 'ambiguous' || r.status === 'not_found' || r.status === 'unreadable') expect(r.chosen, said).toBeNull();
      if (r.safeToSend) expect(r.status, said).toBe('resolved');
    }
  });
});
