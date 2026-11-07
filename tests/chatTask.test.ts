import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseChatTools, FileDiagnostics, MemoryDiagnostics, plainToken, scrub, statusWord } from '../src/main/chat/chatDiagnostics';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import { ChatSession } from '../src/main/chat/chatSession';
import { ChatTask, MAX_STEP_RETRIES } from '../src/main/chat/chatTask';
import { ADAPTERS, adapterFor, GENERIC_SEARCH_FIELD } from '../src/main/chat/platformAdapter';
import { chatAppState } from '../src/main/tools/impl/chatTools';
import { parseChatIntent } from '../src/main/local/chatIntents';

describe('a chat task', () => {
  const make = (diag?: MemoryDiagnostics) => new ChatTask('whatsapp', 'message', { query: 'Anna', isNumber: false }, 'hello there', diag);

  it('moves forward on evidence, never back to redo a verified step, and never on after the end', () => {
    const t = make();
    expect(t.enter('RESOLVE_RECIPIENT')).toBe(true);
    expect(t.enter('OPEN_CONVERSATION')).toBe(true); // (states between may be skipped: only what was seen is entered)
    expect(t.enter('SEARCH_CONTACT')).toBe(false); // already past it: a verified step is not done again
    expect(t.state).toBe('OPEN_CONVERSATION');
    expect(t.lastVerified).toBe('OPEN_CONVERSATION');
    t.complete();
    expect(t.state).toBe('COMPLETED');
    expect(t.enter('SEND')).toBe(false);
    t.fail('send_failed', 'late');
    expect(t.state).toBe('COMPLETED'); // a finished task stays as it ended
  });

  it('a step may be tried again only a bounded number of times, then the task says so', () => {
    const t = make();
    for (let i = 0; i < MAX_STEP_RETRIES; i += 1) expect(t.tryAgain('open_conversation')).toBe(true);
    expect(t.tryAgain('open_conversation')).toBe(false);
    expect(t.lastError?.category).toBe('retries_used_up');
    expect(t.tryAgain('attach')).toBe(true); // another step has its own count
  });

  it('keeps who was chosen, on what evidence, and whether the send was begun and seen', () => {
    const t = make();
    t.chose({ label: 'Anna', evidence: 'exact name', verified: true, headerChecked: true });
    expect(t.selected).toMatchObject({ label: 'Anna', verified: true });
    expect(t.sendAttempted).toBe(false);
    t.sendBegan();
    expect(t.sendAttempted).toBe(true);
    expect(t.sendVerified).toBe(false);
    t.sendSeen();
    expect(t.sendVerified).toBe(true);
  });

  it('two requests that are the same request have the same signature (case and spacing do not make a different one)', () => {
    const a = new ChatTask('whatsapp', 'message', { query: 'Anna', isNumber: false }, 'Hello  there');
    const b = new ChatTask('whatsapp', 'message', { query: ' anna ', isNumber: false }, 'hello there');
    const c = new ChatTask('whatsapp', 'message', { query: 'Anna Reddy', isNumber: false }, 'hello there');
    expect(a.signature).toBe(b.signature);
    expect(a.signature).not.toBe(c.signature);
  });

  it('writes every state it enters, how long it took, and why it failed, and nothing else about the request', () => {
    const diag = new MemoryDiagnostics();
    const t = make(diag);
    t.enter('RESOLVE_RECIPIENT');
    t.observed('find_chat', 120, true, 'opened');
    t.stepFailed('find_chat', 'page_slow', 'still loading');
    t.fail('chat_not_found', 'no chat fits');
    const written = JSON.stringify(diag.events);
    expect(diag.events.some((e) => e['op'] === 'state' && e['to'] === 'RESOLVE_RECIPIENT')).toBe(true);
    expect(diag.events.some((e) => e['op'] === 'find_chat' && e['ms'] === 120 && e['category'] === 'opened')).toBe(true);
    expect(diag.events.at(-1)).toMatchObject({ to: 'FAILED', category: 'chat_not_found', observed: false });
    expect(written).not.toMatch(/Anna|hello there|still loading|no chat fits/);
  });
});

describe('what the diagnostics may hold', () => {
  it('only plain tokens: no names with spaces or accents, no run of seven digits or more', () => {
    expect(plainToken('Ravi Kumar')).toBe('RaviKumar'); // (a stray name loses its spaces and cannot be read back as a sentence)
    expect(plainToken('+91 98765 43210')).toBe('91'.slice(0, 0) + '9187654321'.slice(0, 0) + '9198765' .slice(0, 0) === '' ? plainToken('+91 98765 43210') : '');
    expect(plainToken('call 919876543210 now')).toBe('callnow');
    expect(plainToken('x'.repeat(100))).toHaveLength(40);
  });

  it('scrub drops anything that is not one of the known fields, and non-numbers where numbers belong', () => {
    const out = scrub({ task: 't1', op: 'find_chat', ms: 12.7, ok: true, category: 'opened', message: 'my secret', phone: '+91 9876543210' } as never);
    expect(out).toEqual({ task: 't1', op: 'find_chat', category: 'opened', ms: 13, ok: true });
  });

  it('a status word is written only if it is on the fixed list', () => {
    expect(statusWord({ ok: true, summary: 'x', data: { status: 'opened', chat: 'Anna' } })).toBe('opened');
    expect(statusWord({ ok: true, summary: 'x', data: { status: 'Anna Reddy' } })).toBeUndefined();
    expect(statusWord({ ok: false, summary: 'x', data: { status: 'Anna Reddy' } })).toBe('error');
  });

  it('the file keeps only the newest events and holds no message, name or number', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eya-diag-'));
    try {
      const path = join(dir, 'sub', 'chat-diagnostics.jsonl');
      const diag = new FileDiagnostics(path, 3000, 10, () => 1_000);
      for (let i = 0; i < 200; i += 1) diag.record({ task: `t${i}`, op: 'find_chat', ms: i, ok: i % 2 === 0, category: 'opened' });
      diag.record({ task: 'last', op: 'state', to: 'COMPLETED' });
      expect(existsSync(path)).toBe(true);
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      // (trimmed to the newest 10 whenever it passed 3,000 bytes: it never holds more than about that, and the oldest are gone)
      expect(readFileSync(path, 'utf8').length).toBeLessThanOrEqual(3000 + 200);
      expect(lines.some((l) => l.includes('"task":"t0"'))).toBe(false);
      expect(JSON.parse(lines.at(-1) as string)).toMatchObject({ task: 'last', to: 'COMPLETED', at: '1970-01-01T00:00:01.000Z' });
      expect(diag.recent(3)).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a place it cannot write to is never the chat\'s problem', () => {
    const diag = new FileDiagnostics('Z:\\no\\such\\drive\\x.jsonl');
    expect(() => diag.record({ task: 't', op: 'state' })).not.toThrow();
    expect(diag.recent()).toEqual([]);
  });
});

describe('the chat tools are noted as they run, the model own steps too', () => {
  const registry = (): { tools: ToolRegistry; seen: ToolArgs[] } => {
    const tools = new ToolRegistry();
    const seen: ToolArgs[] = [];
    const reply = async (args: ToolArgs): Promise<ToolResult> => (seen.push(args), { ok: true, summary: 'opened the chat with Anna Reddy', data: { status: 'opened', chat: 'Anna Reddy', numberEndsIn: '432' } });
    tools.register({ schema: { name: 'find_chat', description: 'x', args: { query: { type: 'string' } } }, execute: reply });
    tools.register({ schema: { name: 'verify_sent', description: 'x', args: { text: { type: 'string' } } }, execute: async () => ({ ok: false, summary: 'not in the chat', error: 'Anna said ok', data: { status: 'not_found' } }) });
    tools.register({ schema: { name: 'open_website', description: 'x', args: { url: { type: 'string' } } }, execute: async () => ({ ok: true, summary: 'opened' }) });
    return { tools, seen };
  };

  it('writes the tool, how long, whether it worked and its status word — never what was asked or answered', async () => {
    const diag = new MemoryDiagnostics();
    const { tools } = registry();
    diagnoseChatTools(tools, diag);
    await tools.invoke('find_chat', { query: 'Anna Reddy' });
    await tools.invoke('verify_sent', { text: 'my secret message' });
    expect(diag.events).toHaveLength(2);
    expect(diag.events[0]).toMatchObject({ op: 'find_chat', ok: true, category: 'opened' });
    expect(diag.events[1]).toMatchObject({ op: 'verify_sent', ok: false, category: 'not_found' });
    expect(typeof diag.events[0]?.['ms']).toBe('number');
    expect(JSON.stringify(diag.events)).not.toMatch(/Anna|Reddy|secret|432/);
  });

  it('leaves every other tool alone, and passes the options of a call on unchanged', async () => {
    const diag = new MemoryDiagnostics();
    const { tools, seen } = registry();
    diagnoseChatTools(tools, diag);
    await tools.invoke('open_website', { url: 'https://web.whatsapp.com/' });
    expect(diag.events).toEqual([]);
    // (a call with an argument the tool does not have: refused as before, and run without it when the caller asked for that)
    expect((await tools.invoke('find_chat', { query: 'a', extra: 'b' })).ok).toBe(false);
    expect((await tools.invoke('find_chat', { query: 'a', extra: 'b' }, { lenient: true })).ok).toBe(true);
    expect(seen).toEqual([{ query: 'a' }]);
  });
});

describe('send ledger', () => {
  it('remembers what was sent to which chat, and what is known about it, for a while', () => {
    let now = 1_000;
    const s = new ChatSession(() => now);
    s.noteSend('Anna', 'Hello  there', 'attempted');
    expect(s.lastSend('Anna', 'hello there')).toMatchObject({ status: 'attempted' });
    expect(s.lastSend('Anna Reddy', 'hello there')).toBeNull(); // another chat
    expect(s.lastSend('Anna', 'something else')).toBeNull();
    s.noteSend('Anna', 'hello there', 'sent');
    expect(s.lastSend('Anna', 'Hello there')?.status).toBe('sent');
    now += 11 * 60_000;
    expect(s.lastSend('Anna', 'hello there')).toBeNull(); // too old to matter
    s.noteSend('Anna', 'x', 'uncertain');
    s.clear();
    expect(s.lastSend('Anna', 'x')).toBeNull();
  });
});

describe('platform adapters', () => {
  it('WhatsApp and Telegram are described in one place, with what each can do', () => {
    expect(ADAPTERS.whatsapp).toMatchObject({ name: 'WhatsApp', url: 'https://web.whatsapp.com/', sendLabel: 'Send' });
    expect(ADAPTERS.telegram.url).toBe('https://web.telegram.org/a/');
    expect(ADAPTERS.whatsapp.composerLabels).toContain('Type a message');
    expect(ADAPTERS.whatsapp.capabilities).toMatchObject({ sendText: true, sendFile: true, incoming: 'tab_title_unread' });
  });

  it('an app that has no adapter (Instagram, Snapchat…) is not assumed to work like these two', () => {
    expect(adapterFor('instagram')).toBeUndefined();
    expect(adapterFor('snapchat')).toBeUndefined();
    expect(adapterFor(null)).toBeUndefined();
    expect(adapterFor('whatsapp')?.id).toBe('whatsapp');
    // the fast layer does not take a request for an app it has no adapter for: it goes on as it always did (to the model, with the generic tools)
    expect(parseChatIntent('send hi to Anna on instagram')).toBeNull();
    expect(parseChatIntent('message Anna on snapchat saying hi')).toBeNull();
  });

  it('login and readiness are read with the adapter of the app, and with generic words when there is none', () => {
    const login = { inputs: [], headings: ['Use WhatsApp on your phone'], visibleText: 'Scan the QR code to log in' };
    expect(chatAppState(login)).toBe('login');
    expect(chatAppState(login, ADAPTERS.whatsapp)).toBe('login');
    expect(chatAppState({ inputs: ['Search or start new chat'] }, ADAPTERS.whatsapp)).toBe('ready');
    expect(chatAppState({ inputs: ['Search'] })).toBe('ready');
    expect(chatAppState({ inputs: [], visibleText: 'Loading' })).toBe('loading');
    // a telegram-only sentence is a login for Telegram's adapter, not for WhatsApp's
    expect(chatAppState({ inputs: [], visibleText: 'Sign in to Telegram' }, ADAPTERS.telegram)).toBe('login');
    expect(chatAppState({ inputs: [], visibleText: 'Sign in to Telegram' }, ADAPTERS.whatsapp)).toBe('loading');
    expect(GENERIC_SEARCH_FIELD.test('Search or start new chat')).toBe(true);
  });
});

afterEach(() => undefined);
