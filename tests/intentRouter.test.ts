import { describe, it, expect } from 'vitest';
import { IntentRouter } from '../src/main/agent/IntentRouter';

describe('IntentRouter', () => {
  const r = new IntentRouter();

  it('matches "Open Chrome" to open_application(chrome)', () => {
    const m = r.match('Open Chrome');
    expect(m).toBeDefined();
    expect(m?.tool).toBe('open_application');
    expect(m?.args['name']).toBe('chrome');
    expect(m?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('matches variants: "launch google chrome", "start notepad", "run edge"', () => {
    expect(r.match('launch google chrome')?.args['name']).toBe('chrome');
    expect(r.match('start notepad')?.args['name']).toBe('notepad');
    expect(r.match('run edge')?.args['name']).toBe('edge');
  });

  it('handles trailing punctuation', () => {
    expect(r.match('Open Chrome.')?.args['name']).toBe('chrome');
    expect(r.match('Open Chrome!')?.args['name']).toBe('chrome');
  });

  it('matches "Close Chrome" to close_application(chrome)', () => {
    const m = r.match('Close Chrome');
    expect(m?.tool).toBe('close_application');
    expect(m?.args['name']).toBe('chrome');
  });

  it('understands polite and conversational phrasing', () => {
    const cases: Array<[string, string, string]> = [
      ['Please open Notepad', 'open_application', 'notepad'],
      ['Hey Eya, open Chrome', 'open_application', 'chrome'],
      ['Eya open chrome', 'open_application', 'chrome'],
      ['Can you please open the calculator app for me?', 'open_application', 'calculator'],
      ['could you open my notepad', 'open_application', 'notepad'],
      ['I want you to launch Edge', 'open_application', 'edge'],
      ['fire up chrome', 'open_application', 'chrome'],
      ['open note pad', 'open_application', 'notepad'],
      ['Open File Explorer.', 'open_application', 'explorer'],
      ['close chrome please', 'close_application', 'chrome'],
      ['Okay Eya, quit the notepad', 'close_application', 'notepad'],
    ];
    for (const [phrase, tool, app] of cases) {
      const m = r.match(phrase);
      expect(m?.tool, phrase).toBe(tool);
      expect(m?.args['name'], phrase).toBe(app);
    }
  });

  it("understands the assistant's name however speech recognition spells it", () => {
    for (const heard of ['Hey Ayah, could you please open the calculator app for me?', 'Hey Aya open calculator', 'Iya, open the calculator', 'okay eyah please open calculator']) {
      const m = r.match(heard);
      expect(m?.tool, heard).toBe('open_application');
      expect(m?.args['name'], heard).toBe('calculator');
    }
  });

  it('understands the exact spellings the real speech model produced for "Hey Eya, open Notepad"', () => {
    for (const heard of ['Hey, I-A, open Notepad.', 'Hey, ia open notepad', 'hey ee-ya, open notepad']) {
      const m = r.match(heard);
      expect(m?.tool, heard).toBe('open_application');
      expect(m?.args['name'], heard).toBe('notepad');
    }
  });

  it('does not claim things that only look like commands', () => {
    expect(r.match('open the door')).toBeUndefined();
    expect(r.match('please')).toBeUndefined();
    expect(r.match('hey eya')).toBeUndefined();
    expect(r.match('what time is it')).toBeUndefined();
  });

  it('returns undefined for unknown apps', () => {
    expect(r.match('Open unicorn')).toBeUndefined();
  });

  it('returns undefined for verb without object', () => {
    expect(r.match('Open')).toBeUndefined();
    expect(r.match('Open  ')).toBeUndefined();
  });

  it('returns undefined for non-command sentences', () => {
    expect(r.match('what is the weather')).toBeUndefined();
    expect(r.match('')).toBeUndefined();
  });
});
