import { describe, it, expect } from 'vitest';
import { cleanForSpeech } from '../src/main/agent/speechText';

describe('cleanForSpeech', () => {
  it('removes markdown emphasis, headings, bullets and code', () => {
    expect(cleanForSpeech('# Title\n- **one**\n- _two_\nSome `code` here')).toBe('Title one two Some code here');
    expect(cleanForSpeech('before ```js\nlet x = 1;\n``` after')).toBe('before after');
  });

  it('keeps link text but drops the address', () => {
    expect(cleanForSpeech('Read [the order](https://a.example/b?c=d) now')).toBe('Read the order now');
    expect(cleanForSpeech('Go to https://example.com/very/long/path today')).toBe('Go to today');
  });

  it('collapses whitespace', () => {
    expect(cleanForSpeech('a \n\n  b\t c')).toBe('a b c');
  });

  it('leaves short natural text alone', () => {
    expect(cleanForSpeech("Notepad is open. It's 10:30.")).toBe("Notepad is open. It's 10:30.");
  });

  it('shortens long replies at a sentence boundary', () => {
    const long = `${'This is a fairly long sentence about nothing much. '.repeat(20)}`;
    const out = cleanForSpeech(long);
    expect(out.length).toBeLessThanOrEqual(420);
    expect(out.endsWith('.')).toBe(true);
  });

  it('adds an ellipsis if there is no sentence break to cut at', () => {
    const out = cleanForSpeech('word '.repeat(200));
    expect(out.length).toBeLessThanOrEqual(421);
    expect(out.endsWith('…')).toBe(true);
  });
});
