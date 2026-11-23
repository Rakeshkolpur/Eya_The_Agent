import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiveChatPage } from '../src/renderer/pages/LiveChatPage';
import type { EyaControl } from '../src/renderer/control';
import { keepTalkOpen, TOGETHER_RULES, togetherListening, togetherNote } from '../src/renderer/liveTogether';
import { EMPTY_LIVE_CHAT_VIEW } from '../src/shared/liveChat';
import type { LiveChatView } from '../src/shared/liveChat';

/**
 * TOGETHER, on the person's side: the microphone stays on only while the person is with Eya in a live chat that is going, the live voice model is told how to be beside them, and the
 * Live chat page shows the switch (and the two buttons) only where they can be used.
 */

const html = (view: LiveChatView | null): string =>
  renderToStaticMarkup(React.createElement(LiveChatPage, { c: { liveChat: view, liveChatAct: async () => ({ ok: true, message: '', view: view ?? EMPTY_LIVE_CHAT_VIEW }) } as unknown as EyaControl }));

const running = (over: Partial<LiveChatView> = {}): LiveChatView => ({
  ...EMPTY_LIVE_CHAT_VIEW,
  active: true,
  sessionId: 's1',
  chat: 'Rahul Sharma',
  verified: true,
  state: 'ACTIVE',
  mode: 'assisted',
  startedAt: Date.now() - 65_000,
  monitoring: 'event',
  sendAllowed: true,
  ...over,
});

describe('the microphone stays on only while the person is with Eya in a live chat that is going', () => {
  it('on: together, the chat running', () => {
    expect(togetherListening(running({ together: true }))).toBe(true);
    expect(togetherListening(running({ together: true, state: 'WAITING_FOR_APPROVAL' }))).toBe(true);
    expect(togetherListening(running({ together: true, state: 'PROCESSING_MESSAGE' }))).toBe(true);
  });

  it('off: not together, no chat, an ended chat, or one that is paused', () => {
    expect(togetherListening(null)).toBe(false);
    expect(togetherListening(running())).toBe(false);
    expect(togetherListening(running({ together: false }))).toBe(false);
    expect(togetherListening({ ...EMPTY_LIVE_CHAT_VIEW, together: true })).toBe(false);
    expect(togetherListening(running({ together: true, active: false, state: 'STOPPED' }))).toBe(false);
    expect(togetherListening(running({ together: true, state: 'PAUSED', pause: 'user' }))).toBe(false);
  });
});

describe('the conversation is kept open', () => {
  it('while tasks are open, while she works, or while the person sits with her in a live chat — and not otherwise', () => {
    expect(keepTalkOpen({ tasksOpen: 0, agentWorking: false, together: false })).toBe(false);
    expect(keepTalkOpen({ tasksOpen: 2, agentWorking: false, together: false })).toBe(true);
    expect(keepTalkOpen({ tasksOpen: 0, agentWorking: true, together: false })).toBe(true);
    expect(keepTalkOpen({ tasksOpen: 0, agentWorking: false, together: true })).toBe(true);
  });
});

describe('what the live voice model is told', () => {
  it('how to be: a warm third person beside them, their own words carried out word for word through quick_command, nothing decided for them', () => {
    expect(TOGETHER_RULES).toMatch(/third person/);
    expect(TOGETHER_RULES).toMatch(/not a machine/);
    expect(TOGETHER_RULES).toMatch(/quick_command/);
    expect(TOGETHER_RULES).toMatch(/send this/);
    expect(TOGETHER_RULES).toMatch(/Never put words in their mouth/);
    expect(TOGETHER_RULES.startsWith("[Eya's note]")).toBe(true);
  });

  it('what comes in is said now, and the model listens for what to send', () => {
    const line = togetherNote('Rahul Sharma says: are you free tonight?');
    expect(line.startsWith("[Eya's note]")).toBe(true);
    expect(line).toContain('Rahul Sharma says: are you free tonight?');
    expect(line).toMatch(/right now/);
    expect(line).toMatch(/quick_command with exactly what they say/);
    expect(line).toMatch(/Do not decide anything for them/);
  });
});

describe('the Live chat page', () => {
  it('the start form offers to be in the chat too', () => {
    const m = html(EMPTY_LIVE_CHAT_VIEW);
    expect(m).toContain('I will be in this chat too (together)');
    expect(m).toContain('my microphone stays on');
  });

  it('a running chat shows the switch, off, with what it would do', () => {
    const m = html(running());
    expect(m).toContain('Together with Eya');
    expect(m).toContain('I am here too: Eya tells me what they write as it comes');
    expect(m).toContain('Switch it on when you are sitting with Eya');
    expect(m).not.toContain('Wait: hold her replies');
  });

  it('together: the switch is on, what to say is listed, and Wait / Go ahead are there (Go ahead only while she is holding)', () => {
    const m = html(running({ together: true }));
    expect(m).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""[^>]*\/>\s*<span>I am here too/);
    expect(m).toContain('send this: …');
    expect(m).toContain('Eya never sends anything you did not tell her to');
    expect(m).toContain('Wait: hold her replies');
    expect(/<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>).)*Go ahead/s.test(m)).toBe(true);
    const held = html(running({ together: true, held: true }));
    expect(held).toContain('Eya is holding her replies until you say go ahead.');
    expect(/<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>).)*Go ahead/s.test(held)).toBe(false);
  });
});
