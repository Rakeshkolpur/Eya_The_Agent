import { describe, it, expect } from 'vitest';
import { CuePicker, siteName } from '../src/shared/humanCues';

/** A "random" that walks through 0, 0.1, 0.2 ... so every phrase of a family gets its turn. */
const sweep = (): (() => number) => {
  let n = 0;
  return () => {
    n = (n + 0.13) % 1;
    return n;
  };
};

describe('the name of a site, as a person says it', () => {
  it('turns an address into a name', () => {
    expect(siteName('https://www.flipkart.com/search?q=shirt')).toBe('Flipkart');
    expect(siteName('https://web.whatsapp.com/')).toBe('WhatsApp');
    expect(siteName('https://www.bookmyshow.com/')).toBe('BookMyShow');
    expect(siteName('https://indiankanoon.org/doc/1/')).toBe('Indian Kanoon');
    expect(siteName('https://accounts.google.co.in/signin')).toBe('Google');
    expect(siteName('someunknownshop.in')).toBe('Someunknownshop');
  });

  it('gives nothing for what is not an address', () => {
    expect(siteName(undefined)).toBeNull();
    expect(siteName(42)).toBeNull();
    expect(siteName('')).toBeNull();
    expect(siteName('http://127.0.0.1:8080/x')).toBeNull();
  });
});

describe('what she says while something takes a moment', () => {
  it('names the place she is opening', () => {
    const picker = new CuePicker(sweep());
    const phrase = picker.pick({ tool: 'open_website', args: { url: 'https://www.flipkart.com/' } });
    expect(phrase).toContain('Flipkart');
  });

  it('says what she is doing, by kind of work', () => {
    const p = new CuePicker(() => 0);
    expect(p.pick({ tool: 'find_file' })).toMatch(/PC|file|files/);
    expect(new CuePicker(() => 0).pick({ tool: 'download_file' })).toMatch(/download|grabbing/i);
    expect(new CuePicker(() => 0).pick({ tool: 'word_write' })).toMatch(/document/i);
    expect(new CuePicker(() => 0).pick({ tool: 'play_on_youtube' })).toMatch(/YouTube|playing/);
    expect(new CuePicker(() => 0).pick({ tool: 'deep_research' })).toMatch(/minute|sites|digging/i);
  });

  it('never says the same words twice running', () => {
    const picker = new CuePicker(() => 0.999);
    const seen: string[] = [];
    for (let i = 0; i < 12; i += 1) seen.push(picker.pick({ tool: 'something_new' }));
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).not.toBe(seen[i - 1]);
  });

  it('is never the machine\'s "working on it", "processing" or "please wait"', () => {
    const picker = new CuePicker(sweep());
    const tools = ['open_website', 'web_search', 'deep_research', 'fill_on_page', 'click_on_page', 'inspect_page', 'find_file', 'find_chat', 'download_file', 'word_edit', 'play_on_youtube', 'take_screenshot', 'unknown_tool', undefined];
    for (const tool of tools) {
      for (const stage of ['start', 'slow', 'long'] as const) {
        for (let i = 0; i < 6; i += 1) {
          const phrase = picker.pick({ ...(tool !== undefined ? { tool } : {}), args: { url: 'https://www.irctc.co.in/' }, stage });
          expect(phrase, `${tool}/${stage}`).not.toMatch(/working on it|processing|please wait|loading\.\.\.|\{site\}/i);
          expect(phrase.length).toBeGreaterThan(8);
          expect(phrase.length).toBeLessThan(110);
        }
      }
    }
  });

  it('a phrase that needs a place\'s name is not used when there is none', () => {
    const picker = new CuePicker(sweep());
    for (let i = 0; i < 40; i += 1) {
      expect(picker.pick({ tool: 'open_website', args: {}, stage: i % 2 === 0 ? 'start' : 'slow' })).not.toContain('{site}');
    }
  });

  it('says something honest when it is slow, and something else when it is very slow', () => {
    const picker = new CuePicker(() => 0);
    const slow = picker.pick({ tool: 'open_website', args: { url: 'https://www.flipkart.com/' }, stage: 'slow' });
    const long = new CuePicker(() => 0).pick({ stage: 'long' });
    expect(slow).toMatch(/slow|still|bear with|almost|longer/i);
    expect(long).toMatch(/longer|slow|still/i);
    expect(slow).not.toBe(long);
  });
});
