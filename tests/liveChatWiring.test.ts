import { describe, expect, it } from 'vitest';
import type { BrowserAutomationService } from '../src/main/browser/BrowserAutomationService';
import { ChatSession } from '../src/main/chat/chatSession';
import { createChatActions } from '../src/main/livechat/liveChatWiring';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';

/**
 * How the live chat reaches the chat: through find_chat, opening WhatsApp Web first when there is nothing to look at. This was missing in the first real run: Chrome was
 * running with no window, the extension said "There is no browser tab to look at", and the live chat gave up instead of opening WhatsApp as every other chat request does.
 */

const OPENED: ToolResult = { ok: true, summary: 'opened chat', data: { status: 'opened', chat: 'Rahul Sharma', verified: true, headerChecked: true } };
const NO_TAB: ToolResult = { ok: false, summary: 'could not look', error: 'I could not look for that chat: There is no browser tab to look at.', data: { status: 'error', reason: 'extension_error' } };
const NOT_CHAT_APP: ToolResult = { ok: false, summary: 'not a chat app', error: 'The page in front is not a chat app.', data: {} };
const LOADING: ToolResult = { ok: true, summary: 'loading', data: { status: 'loading' } };

function actions(script: Record<string, ToolResult[]>) {
  const calls: Array<{ name: string; args: ToolArgs }> = [];
  const queue = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const a = createChatActions({
    tools: {
      invoke: async (name, args) => {
        calls.push({ name, args });
        const next = queue.get(name)?.shift();
        if (next === undefined) throw new Error(`nothing scripted for ${name}`);
        return next;
      },
    },
    service: {} as BrowserAutomationService,
    session: new ChatSession(),
    sleep: async () => undefined,
  });
  return { a, calls };
}

describe('the live chat finds its chat, opening WhatsApp Web when there is nothing to look at', () => {
  it('"There is no browser tab to look at" opens WhatsApp Web, then finds the chat', async () => {
    const { a, calls } = actions({ find_chat: [NO_TAB, OPENED], open_website: [{ ok: true, summary: 'opened' }] });
    const out = await a.open('+91 98765 08501');
    expect(out).toMatchObject({ kind: 'opened', label: 'Rahul Sharma', verified: true });
    expect(calls.map((c) => c.name)).toEqual(['find_chat', 'open_website', 'find_chat']);
    expect(String(calls[1]?.args['url'])).toMatch(/^https:\/\/web\.whatsapp\.com/);
  });

  it('keeps looking while WhatsApp loads, and does not give up on the first "no tab" either', async () => {
    const { a, calls } = actions({ find_chat: [NO_TAB, NO_TAB, LOADING, LOADING, OPENED], open_website: [{ ok: true, summary: 'opened' }] });
    expect(await a.open('Rahul')).toMatchObject({ kind: 'opened' });
    expect(calls.filter((c) => c.name === 'open_website')).toHaveLength(1); // opened once, not on every look
    expect(calls.filter((c) => c.name === 'find_chat')).toHaveLength(5);
  });

  it('a page that is not a chat app still opens WhatsApp Web (as before)', async () => {
    const { a, calls } = actions({ find_chat: [NOT_CHAT_APP, OPENED], open_website: [{ ok: true, summary: 'opened' }] });
    expect(await a.open('Rahul')).toMatchObject({ kind: 'opened' });
    expect(calls.map((c) => c.name)).toEqual(['find_chat', 'open_website', 'find_chat']);
  });

  it('no browser connected at all is said as that, not as a missing tab', async () => {
    const { a } = actions({ find_chat: [NO_TAB], open_website: [{ ok: false, summary: 'no browser', error: 'No browser', data: { browserUnavailable: true } }] });
    expect(await a.open('Rahul')).toMatchObject({ kind: 'unavailable' });
  });

  it('WhatsApp Web that cannot be opened is said so', async () => {
    const { a } = actions({ find_chat: [NO_TAB], open_website: [{ ok: false, summary: 'could not open', error: 'x' }] });
    expect(await a.open('Rahul')).toMatchObject({ kind: 'failed', say: expect.stringMatching(/couldn.t open WhatsApp Web/) });
  });

  it('WhatsApp asking for the QR code is said, and waiting stops there', async () => {
    const { a, calls } = actions({ find_chat: [NO_TAB, { ok: true, summary: 'login', data: { status: 'needs_login' } }], open_website: [{ ok: true, summary: 'opened' }] });
    expect(await a.open('Rahul')).toMatchObject({ kind: 'login' });
    expect(calls.filter((c) => c.name === 'find_chat')).toHaveLength(2);
  });

  it('any other trouble looking is not mistaken for "no tab": WhatsApp is not opened over it', async () => {
    const other: ToolResult = { ok: false, summary: 'could not look', error: 'I could not look for that chat: the page changed.', data: { status: 'error', reason: 'other' } };
    const { a, calls } = actions({ find_chat: [other] });
    expect(await a.open('Rahul')).toMatchObject({ kind: 'failed' });
    expect(calls.map((c) => c.name)).toEqual(['find_chat']);
  });
});
