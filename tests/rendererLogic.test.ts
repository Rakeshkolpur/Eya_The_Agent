import { describe, it, expect } from 'vitest';
import { formatSize, statusLine, timeAgo } from '../src/renderer/ui/format';
import { addMessage, emptyThread, liveEnded, liveHeard, liveSaid, MAX_MESSAGES } from '../src/renderer/thread';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

describe('how long ago', () => {
  it('says it the way the Recent screen does', () => {
    expect(timeAgo(ago(10_000), NOW)).toBe('just now');
    expect(timeAgo(ago(2 * 60_000), NOW)).toBe('2m ago');
    expect(timeAgo(ago(8 * 60_000 + 20_000), NOW)).toBe('8m ago');
    expect(timeAgo(ago(60 * 60_000), NOW)).toBe('1 hour ago');
    expect(timeAgo(ago(3 * 3_600_000), NOW)).toBe('3 hours ago');
    expect(timeAgo(ago(30 * 3_600_000), NOW)).toBe('yesterday');
    expect(timeAgo(ago(4 * 86_400_000), NOW)).toBe('4 days ago');
    expect(timeAgo(ago(30 * 86_400_000), NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it('is blank for a date it cannot read, and never negative for one in the future', () => {
    expect(timeAgo('not a date', NOW)).toBe('');
    expect(timeAgo(new Date(NOW + 5 * 60_000).toISOString(), NOW)).toBe('just now');
  });
});

describe('how big a file is', () => {
  it('reads like a person would say it', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1024)).toBe('1 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(340 * 1024)).toBe('340 KB');
    expect(formatSize(1.2 * 1024 * 1024)).toBe('1.2 MB');
    expect(formatSize(5 * 1024 ** 3)).toBe('5 GB');
    expect(formatSize(3 * 1024 ** 4)).toBe('3 TB');
    expect(formatSize(5000 * 1024 ** 4)).toMatch(/TB$/);
  });

  it('is blank for a size it cannot make sense of', () => {
    expect(formatSize(-1)).toBe('');
    expect(formatSize(Number.NaN)).toBe('');
    expect(formatSize(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('the status line under her name', () => {
  const base = { state: 'idle', talk: 'off' as const, voiceOn: true, listening: true, wakeReady: true };
  it('reads what she is doing', () => {
    expect(statusLine(base)).toBe('Ready · Listening for "Hey Eya"');
    expect(statusLine({ ...base, wakeReady: false })).toBe('Ready · Listening');
    expect(statusLine({ ...base, voiceOn: false })).toBe('Voice is off');
    expect(statusLine({ ...base, listening: false })).toBe('Starting up…');
    expect(statusLine({ ...base, state: 'thinking' })).toBe('Thinking…');
    expect(statusLine({ ...base, state: 'working' })).toBe('Working on it…');
    expect(statusLine({ ...base, talk: 'connecting' })).toBe('Connecting…');
    expect(statusLine({ ...base, talk: 'on' })).toBe('Live conversation · listening');
    expect(statusLine({ ...base, talk: 'on', state: 'speaking' })).toBe('Speaking…');
  });
});

describe('the chat thread', () => {
  it('adds typed and spoken messages in order, and ignores an empty one', () => {
    let t = addMessage(emptyThread, 'user', '  open notepad ', 'typed', 1);
    t = addMessage(t, 'eya', 'Done.', 'typed', 2);
    t = addMessage(t, 'eya', '   ', 'typed', 3);
    expect(t.messages.map((m) => [m.role, m.text])).toEqual([['user', 'open notepad'], ['eya', 'Done.']]);
  });

  it('a live turn grows ONE message as the words arrive, rather than adding one per update', () => {
    let t = emptyThread;
    for (const heard of ['check', 'check the', 'check the cause list']) t = liveHeard(t, heard, 1);
    for (const said of ['Sure', 'Sure, opening it', 'Sure, opening it now.']) t = liveSaid(t, said, 2);
    expect(t.messages.map((m) => [m.role, m.text])).toEqual([['user', 'check the cause list'], ['eya', 'Sure, opening it now.']]);
  });

  it('once she has answered, the next words are a new turn', () => {
    let t = liveHeard(emptyThread, 'open notepad');
    t = liveSaid(t, 'Done.');
    t = liveHeard(t, 'now close it');
    t = liveSaid(t, 'Closed.');
    expect(t.messages.map((m) => m.text)).toEqual(['open notepad', 'Done.', 'now close it', 'Closed.']);
  });

  it('if the user speaks again before she answers, it is still the same turn', () => {
    let t = liveHeard(emptyThread, 'open');
    t = liveHeard(t, 'open notepad');
    expect(t.messages).toHaveLength(1);
  });

  it('empty updates (a turn being cleared) change nothing, and ending the conversation closes the exchange', () => {
    let t = liveHeard(emptyThread, 'hello');
    expect(liveSaid(t, '')).toBe(t);
    expect(liveHeard(t, '  ')).toBe(t);
    t = liveEnded(liveSaid(t, 'Hi'));
    t = liveHeard(t, 'hello again');
    expect(t.messages.map((m) => m.text)).toEqual(['hello', 'Hi', 'hello again']);
  });

  it('keeps only the latest hundred messages', () => {
    let t = emptyThread;
    for (let i = 0; i < MAX_MESSAGES + 25; i += 1) t = addMessage(t, 'user', `message ${i}`, 'typed', i);
    expect(t.messages).toHaveLength(MAX_MESSAGES);
    expect(t.messages[0]?.text).toBe('message 25');
    expect(t.messages.at(-1)?.text).toBe(`message ${MAX_MESSAGES + 24}`);
  });
});
