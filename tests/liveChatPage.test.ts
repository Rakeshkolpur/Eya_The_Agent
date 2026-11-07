import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiveChatPage } from '../src/renderer/pages/LiveChatPage';
import type { EyaControl } from '../src/renderer/control';
import { EMPTY_LIVE_CHAT_VIEW } from '../src/shared/liveChat';
import type { LiveChatView } from '../src/shared/liveChat';

/**
 * The Live chat page as it is drawn for each state: which controls are there and which are switched off. (What the buttons DO is the controller's — tested through
 * it and in the real browser; this is that the page offers the right ones, and never offers a send that cannot happen.)
 */

const html = (view: LiveChatView | null): string =>
  renderToStaticMarkup(React.createElement(LiveChatPage, { c: { liveChat: view, liveChatAct: async () => ({ ok: true, message: '', view: view ?? EMPTY_LIVE_CHAT_VIEW }) } as unknown as EyaControl }));

const running = (over: Partial<LiveChatView> = {}): LiveChatView => ({
  ...EMPTY_LIVE_CHAT_VIEW,
  active: true,
  sessionId: 's1',
  chat: 'Rahul Sharma',
  verified: true,
  state: 'WAITING_FOR_APPROVAL',
  mode: 'assisted',
  startedAt: Date.now() - 65_000,
  replies: 2,
  monitoring: 'event',
  sendAllowed: true,
  recent: [
    { id: 'false_1', dir: 'in', kind: 'text', text: 'Can we talk today?', at: '10:00', handled: true },
    { id: 'false_2', dir: 'in', kind: 'text', text: 'Hello?', at: '10:01', handled: false },
  ],
  draft: { id: 'd1', text: 'Yes, call me.', status: 'ready', createdAt: Date.now(), answers: 1, by: 'eya', confidence: 'high', commitment: false, note: null },
  ...over,
});

/** The button whose text contains this, with whether it is switched off. */
function button(markup: string, label: string): { found: boolean; disabled: boolean } {
  const re = new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, 's');
  const m = re.exec(markup);
  return { found: m !== null, disabled: m !== null && /<button[^>]*\sdisabled=""/.test(m[0]) };
}

describe('the Live chat page', () => {
  it('says it is loading until it has the state', () => {
    expect(html(null)).toContain('Loading…');
  });

  it('with nothing running it offers to start — and explains Draft and Assisted plainly', () => {
    const m = html(EMPTY_LIVE_CHAT_VIEW);
    expect(m).toContain('Start a live chat');
    expect(m).toContain('Draft: suggest replies, never send');
    expect(m).toContain('Assisted: send when I approve');
    expect(m).toContain('She never reads your other chats');
    expect(button(m, 'Start')).toEqual({ found: true, disabled: true }); // no name yet
    expect(m).not.toContain('Suggested reply');
  });

  it('a failed start shows why, and a stopped one says how many replies it sent', () => {
    expect(html({ ...EMPTY_LIVE_CHAT_VIEW, state: 'FAILED', error: "I couldn't find a chat called Rahul." })).toContain("I couldn&#x27;t find a chat called Rahul.");
    expect(html({ ...EMPTY_LIVE_CHAT_VIEW, state: 'STOPPED', chat: 'Rahul Sharma', replies: 3 })).toContain('3 replies were sent');
  });

  it('the start form offers automatic replies in one step, with the confirmation that goes with it', () => {
    const m = html(EMPTY_LIVE_CHAT_VIEW);
    expect(m).toContain('Reply automatically (AI-assisted)');
    expect(m).toContain('without asking me each time');
    expect(button(m, 'Start').found).toBe(true);
  });

  it('the start form lets the person say what Eya is to do in the chat, and offers the first message only with automatic replies', () => {
    const m = html(EMPTY_LIVE_CHAT_VIEW);
    expect(m).toContain('What should Eya do in this chat?');
    // (the first-message box lives inside the automatic-reply form, which is shown only when that is ticked)
    expect(m).not.toContain('Eya writes the first message');
  });

  it('a running chat shows what the person asked for', () => {
    expect(html(running({ purpose: 'she is my close friend, make her happy' }))).toContain('What you asked Eya to do in this chat: she is my close friend, make her happy');
    expect(html(running({ purpose: '' }))).not.toContain('What you asked Eya to do');
  });

  it('shows how new messages are noticed and when the chat was last looked at', () => {
    const event = html(running({ lastCheckAt: Date.now() - 4_000 }));
    expect(event).toContain('on (the page tells Eya when something changes)');
    expect(event).toMatch(/last checked [3-6]s ago/);
    const checking = html(running({ monitoring: 'checking', lastCheckAt: Date.now() }));
    expect(checking).toContain('checking every few seconds');
    expect(html(running({ monitoring: 'off', lastCheckAt: Date.now() }))).not.toContain('last checked');
  });

  it('Assisted with a reply waiting and sending allowed: every control is there and Send is on', () => {
    const m = html(running());
    for (const label of ['Pause', 'Stop', 'Save edit', 'Approve', 'Send', 'Discard', 'Write it again']) expect(button(m, label).found, label).toBe(true);
    expect(button(m, 'Send').disabled).toBe(false);
    expect(button(m, 'Approve').disabled).toBe(false);
    expect(m).toContain('Rahul Sharma');
    expect(m).toContain('A reply is waiting for you');
    expect(m).toContain('Session 1:05');
    expect(m).toContain('2 replies sent');
    expect(m).toContain('Automatic sending: off');
    expect(m).toContain('Can we talk today?');
    expect(m).toContain('>new<'); // the unhandled incoming message
  });

  it('Draft mode: Send is switched off, with the reason, and Approve says what it really does', () => {
    const m = html(running({ mode: 'draft' }));
    expect(button(m, 'Send').disabled).toBe(true);
    expect(m).toContain('Draft mode never sends');
    expect(m).toContain('Approve: put in WhatsApp’s box');
  });

  it('sending is switched off when the plugin or Chats do not allow it, and the page says so for the person who looks', () => {
    const m = html(running({ sendAllowed: false }));
    expect(button(m, 'Send').disabled).toBe(true);
    expect(m).toContain('Sending is switched off');
  });

  it('while a send is in progress nothing can be pressed twice', () => {
    const m = html(running({ state: 'SENDING' }));
    for (const label of ['Save edit', 'Approve', 'Send', 'Discard', 'Write it again']) expect(button(m, label).disabled, label).toBe(true);
    expect(button(m, 'Pause').disabled).toBe(true);
  });

  it('automatic replies ON are unmissable, with the limits, and one press turns them off', () => {
    const m = html(running({ mode: 'auto', auto: { maxReplies: 5, repliesSent: 2, minGapSeconds: 30, until: Date.now() + 10 * 60_000, holdBack: false } }));
    expect(m).toContain('AI-ASSISTED AUTOMATIC REPLIES ARE ON FOR THIS CHAT');
    expect(m).toContain('2 of 5 sent');
    expect(m).toContain('Automatic sending: ON');
    expect(button(m, 'Turn automatic replies off').found).toBe(true);
    expect(m).not.toContain('Set up automatic replies');
  });

  it('says plainly how replies go out: as the message comes in by default, held back for approval only when asked', () => {
    const open = html(running({ mode: 'auto', auto: { maxReplies: 5, repliesSent: 0, minGapSeconds: 30, until: Date.now() + 10 * 60_000, holdBack: false } }));
    expect(open).toContain('Each reply goes out as the message comes in');
    expect(open).toContain('never sends a password, a one-time code or a card or account number');
    const held = html(running({ mode: 'auto', auto: { maxReplies: 5, repliesSent: 0, minGapSeconds: 30, until: Date.now() + 10 * 60_000, holdBack: true } }));
    expect(held).toContain('A reply that promises something or mentions figures or links stops automatic replies and comes to you');
    expect(held).not.toContain('Each reply goes out as the message comes in');
  });

  it('automatic replies are offered only once the chat is confirmed and sending is allowed', () => {
    expect(button(html(running()), 'Set up automatic replies').disabled).toBe(false);
    expect(button(html(running({ verified: false })), 'Set up automatic replies').disabled).toBe(true);
    expect(button(html(running({ sendAllowed: false })), 'Set up automatic replies').disabled).toBe(true);
    expect(button(html(running({ state: 'PAUSED', pause: 'user' })), 'Set up automatic replies').disabled).toBe(true);
  });

  it('paused: says why, and offers Resume instead of Pause', () => {
    const m = html(running({ state: 'PAUSED', pause: 'chat_switched', monitoring: 'off', draft: null }));
    expect(m).toContain('The open chat is not the chosen one any more.');
    expect(button(m, 'Resume').found).toBe(true);
    expect(button(m, 'Pause').found).toBe(false);
    expect(m).toContain('monitoring: off');
  });

  it('a likely match asks the person to confirm; several chats are offered as numbered buttons', () => {
    const confirm = html(running({ state: 'WAITING_FOR_USER', verified: false, confirmChat: 'Rahul Sharma', draft: null }));
    expect(confirm).toContain('the right chat?');
    expect(button(confirm, 'Yes, this chat').found).toBe(true);
    expect(button(confirm, 'Resume').found).toBe(false); // not while a choice is waiting
    const choose = html(running({ state: 'WAITING_FOR_USER', verified: false, choices: [{ choice: 1, label: 'Rahul Sharma' }, { choice: 2, label: 'Rahul Verma' }], draft: null }));
    expect(button(choose, '1. Rahul Sharma').found).toBe(true);
    expect(button(choose, '2. Rahul Verma').found).toBe(true);
  });

  it('a reply that Eya is not sure of, or that states something for the person, says so', () => {
    const m = html(running({ draft: { id: 'd', text: 'Yes I will come', status: 'ready', createdAt: 0, answers: 1, by: 'eya', confidence: 'medium', commitment: true, note: null } }));
    expect(m).toContain('fairly sure');
    expect(m).toContain('states or promises something for you');
  });

  it('an uncertain send is shown as not confirmed (never as sent)', () => {
    const m = html(running({ state: 'WAITING_FOR_USER', draft: { id: 'd', text: 'Hi', status: 'uncertain', createdAt: 0, answers: 1, by: 'eya', confidence: 'high', commitment: false, note: 'I will not send it again.' } }));
    expect(m).toContain('Not confirmed — check the chat');
    expect(m).not.toContain('>Sent<');
    expect(m).toContain('I will not send it again.');
    expect(button(m, 'Send').disabled).toBe(true);
  });
});
