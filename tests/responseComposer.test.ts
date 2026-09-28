import { describe, it, expect } from 'vitest';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';

describe('ResponseComposer', () => {
  const c = new ResponseComposer();

  it('phrases successful open_application naturally', () => {
    expect(
      c.compose({
        userText: 'open chrome',
        intentTool: 'open_application',
        toolResult: { ok: true, summary: 'chrome is running', data: { app: 'chrome' } },
      }),
    ).toBe('Chrome is open.');
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
