import { describe, it, expect } from 'vitest';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';

describe('ResponseComposer', () => {
  const c = new ResponseComposer();

  it('says just "Done" for a successful open_application, not a description of it', () => {
    expect(
      c.compose({
        userText: 'open chrome',
        intentTool: 'open_application',
        toolResult: { ok: true, summary: 'chrome is running', data: { app: 'chrome' } },
      }),
    ).toBe('Done.');
  });

  it('says just "Done" for a successful close_application, but still mentions when it was already closed', () => {
    expect(
      c.compose({
        userText: 'close notepad',
        intentTool: 'close_application',
        toolResult: { ok: true, summary: 'closed', data: { app: 'notepad' } },
      }),
    ).toBe('Done.');
    expect(
      c.compose({
        userText: 'close notepad',
        intentTool: 'close_application',
        toolResult: { ok: true, summary: 'not running', data: { app: 'notepad', alreadyClosed: true } },
      }),
    ).toBe("Notepad wasn't running.");
  });

  it('phrases failed open_application', () => {
    expect(
      c.compose({
        userText: 'open chrome',
        intentTool: 'open_application',
        toolResult: { ok: false, summary: 'nope', error: 'timeout', data: { app: 'chrome' } },
      }),
    ).toBe("I couldn't open chrome.");
  });

  it('falls back to Done for unknown tools when ok', () => {
    expect(
      c.compose({
        userText: 'x',
        intentTool: 'other',
        toolResult: { ok: true, summary: 'x' },
      }),
    ).toBe('Done.');
  });
});
