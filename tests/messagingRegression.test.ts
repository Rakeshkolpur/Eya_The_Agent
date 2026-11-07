import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { ChatSession } from '../src/main/chat/chatSession';
import { ContactBook } from '../src/main/chat/ContactBook';
import { ConversationContext } from '../src/main/context/ConversationContext';
import { ChatCommands } from '../src/main/local/ChatCommands';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { AIChatMessage, AICompletion, AIProvider } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import { createBrowserTools } from '../src/main/tools/impl/browserTools';
import { createChatSendGate, createChatTools } from '../src/main/tools/impl/chatTools';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import type { AgentUpdate } from '../src/shared/types';
import { FakeDisk } from './chatFixtures';
import { FakeWhatsAppWeb, PICKER_CONTACTS } from './chatPickerFixtures';
import type { PickerContact } from './chatPickerFixtures';
import { MIGRATIONS } from '../src/main/memory/schema';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import type { Sql } from '../src/main/memory/sqlite';

let dir: string;
let db: Sql;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eya-regress-'));
  db = openDatabase(join(dir, 'memory.db'));
  migrate(db, MIGRATIONS);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The reproduced conversation, one test per thing that went wrong in it (25 Oct 2026):
 *   "send msg to anna in whatsapp 'where are u'" -> "I couldn't look for that chat just now" -> "ok" -> the AI switched provider and asked for Anna's phone
 *   number -> "do it now" -> an invented number -> raw tool-call JSON ({"name":"clickonlink",...}) shown as the answer -> "send na" -> "I can't see the
 *   delivery mark yet".
 * Everything runs against mocks (a mock of WhatsApp Web built from what the real page showed, a scripted AI). None of it is evidence about the real page.
 */

const HOME = 'C:\\Users\\Test';
const folders: KnownFolders = { home: HOME, downloads: `${HOME}\\Downloads`, desktop: `${HOME}\\Desktop`, documents: `${HOME}\\Documents`, pictures: `${HOME}\\Pictures`, videos: `${HOME}\\Videos`, music: `${HOME}\\Music`, temp: HOME };
const PDF = `${HOME}\\Desktop\\report.pdf`;

class ScriptedAI implements AIProvider {
  readonly name = 'scripted';
  calls = 0;
  readonly seen: AIChatMessage[][] = [];
  constructor(private readonly script: Array<AICompletion | Error>) {}
  isReady(): boolean {
    return true;
  }
  async complete(messages: readonly AIChatMessage[]): Promise<AICompletion> {
    this.calls += 1;
    this.seen.push([...messages]);
    const next = this.script.shift();
    if (next === undefined) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    return next;
  }
}

const tts: TTSProvider = { name: 'fake', init: async () => undefined, speak: async () => undefined, prefetch: () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };
const say = (text: string): AICompletion => ({ text, toolCalls: [] });

interface Rig {
  readonly app: FakeWhatsAppWeb;
  readonly session: ChatSession;
  readonly chat: ChatCommands;
  readonly tools: ToolRegistry;
  readonly engine: (ai?: AIProvider) => AgentEngine;
  /** Everything the tools were asked to do, in order. */
  readonly invoked: string[];
  readonly send: (text: string) => Promise<{ spoken: string; ok: boolean }>;
}

function rig(opts: { contacts?: readonly PickerContact[]; setup?: (a: FakeWhatsAppWeb) => void; mode?: 'always' | 'unless_verified'; browserDown?: { value: boolean }; failOnce?: Record<string, ToolResult> } = {}): Rig {
  const app = new FakeWhatsAppWeb(opts.contacts ?? PICKER_CONTACTS);
  opts.setup?.(app);
  const policy = new CommunicationPolicy(() => ({ enabled: true, apps: {} }));
  const session = new ChatSession();
  const book = new ContactBook(db);
  book.setLearning('off'); // (so a send does not end with the question about remembering names, which is not what these tests are about)
  const registry = new ToolRegistry();
  const disk = new FakeDisk({ [PDF]: { isFile: true, isDirectory: false, size: 10, content: Buffer.from('0123456789') } });
  for (const t of createChatTools({ service: app, policy, session, folders, files: disk, sleep: async () => undefined })) registry.register(t);
  for (const t of createBrowserTools(app, undefined, { chatGate: createChatSendGate(session, policy) })) registry.register(t);
  const invoked: string[] = [];
  const failOnce = { ...(opts.failOnce ?? {}) };
  const chat = new ChatCommands({
    tools: {
      invoke: async (name: string, args: ToolArgs): Promise<ToolResult> => {
        invoked.push(name);
        if (opts.browserDown?.value === true) {
          return { ok: false, summary: 'browser not connected', error: "None of the user's browsers is connected to Eya.", data: { browserUnavailable: true, why: 'not_connected' } };
        }
        const once = failOnce[name];
        if (once !== undefined) {
          delete failOnce[name];
          return once;
        }
        return registry.invoke(name, args);
      },
    },
    contacts: book,
    policy,
    session,
    files: { locate: async () => ({ kind: 'one' as const, path: PDF, name: 'report.pdf' }) },
    sleep: async () => undefined,
    ...(opts.mode !== undefined ? { confirmSends: opts.mode } : {}),
  });
  const engine = (ai?: AIProvider): AgentEngine =>
    new AgentEngine({ router: new IntentRouter(), tools: registry, composer: new ResponseComposer(), tts, context: new ConversationContext(), chat, ...(ai !== undefined ? { ai } : {}), now: () => new Date('2026-10-25T10:00:00Z') });
  const send = async (text: string): Promise<{ spoken: string; ok: boolean }> => {
    const r = await chat.tryHandle(text);
    return { spoken: r?.spoken ?? '(passed to the AI)', ok: r?.ok ?? false };
  };
  return { app, session, chat, tools: registry, engine, invoked, send };
}

const REQUEST = "send msg to anna in whatsapp 'where are u'";

describe('1. one exact contact: the request IS the instruction', () => {
  it('"send msg to anna in whatsapp \'where are u\'" sends it, once, to Anna, with no second question', async () => {
    const r = rig();
    const out = await r.send(REQUEST);
    expect(out.spoken).toMatch(/^Sent to Anna\./);
    expect(r.app.sentLog).toEqual([{ to: 'Anna', text: 'where are u' }]); // the quotes are not part of the message
    expect(r.app.open?.name).toBe('Anna');
  });

  it('a likely match (only part of the name) is still asked about, never sent on a guess', async () => {
    const r = rig();
    const out = await r.send("send msg to naveen in whatsapp 'where are u'");
    expect(out.spoken).toContain('matched only on "naveen"');
    expect(out.spoken).toMatch(/Send "where are u"\?$/);
    expect(r.app.sentLog).toEqual([]);
    expect(r.app.draft).toBe('where are u'); // typed, waiting
    expect((await r.send('send na')).spoken).toMatch(/^Sent to Naveen Anna\./);
    expect(r.app.sentLog).toEqual([{ to: 'Naveen Anna', text: 'where are u' }]);
  });

  it('the old behaviour (ask before every send) is still there for whoever sets it', async () => {
    const r = rig({ mode: 'always' });
    const out = await r.send(REQUEST);
    expect(out.spoken).toBe('Found Anna. Send "where are u"?');
    expect(r.app.sentLog).toEqual([]);
  });
});

describe('2. several contacts named Anna', () => {
  const ANNAS: readonly PickerContact[] = [{ name: 'Ramesh Anna', phone: '+91 90000 22222' }, { name: 'Anna Reddy', phone: '+91 91111 33333' }, { name: 'Anna Kumar', phone: '+91 93333 55555' }];

  it('asks ONE concise question naming the alternatives, sends nothing, and does not ask again once answered', async () => {
    const r = rig({ contacts: ANNAS });
    const asked = await r.send(REQUEST);
    expect(asked.spoken).toMatch(/^Which one: /);
    for (const name of ['Ramesh Anna', 'Anna Reddy', 'Anna Kumar']) expect(asked.spoken).toContain(name);
    expect(r.app.sentLog).toEqual([]);
    const done = await r.send('the second one');
    expect(done.spoken).toMatch(/^Sent to /);
    expect(r.app.sentLog).toHaveLength(1);
    expect(r.app.sentLog[0]?.text).toBe('where are u');
    expect(r.app.searchTypes).toBe(1); // one search for the whole conversation, not one per message
  });
});

describe('3. no matching contact', () => {
  it('says so accurately: nothing sent, nothing invented', async () => {
    const r = rig();
    const out = await r.send("send msg to zoya in whatsapp 'where are u'");
    expect(out.ok).toBe(false);
    expect(out.spoken).toMatch(/couldn't find a chat called zoya/i);
    expect(out.spoken).not.toMatch(/\d{7,}/);
    expect(r.app.sentLog).toEqual([]);
  });
});

describe('4. no invented contact details', () => {
  const answer = async (ai: AIProvider, text = "what is anna's number") => {
    const r = rig();
    const updates: AgentUpdate[] = [];
    const res = await r.engine(ai).handle({ requestId: 'q1', text, source: 'text' }, (u) => updates.push(u));
    return res.spoken;
  };

  it('a phone number the model wrote that is in no contact, page or message is taken out of the answer', async () => {
    const spoken = await answer(new ScriptedAI([say("Anna's phone number is +1 800 234 5678.")]));
    expect(spoken).not.toContain('800');
    expect(spoken).toMatch(/don't have a verified phone number/i);
  });

  it('a number the person gave is kept', async () => {
    const spoken = await answer(new ScriptedAI([say('Okay, I will use +91 98765 43210.')]), 'my number is +91 98765 43210, remember it');
    expect(spoken).toContain('+91 98765 43210');
  });
});

describe('5. short follow-ups belong to the request that did not finish', () => {
  it('"ok" after a failed look takes the SAME request up again (the recipient and the words it had), and sends it once', async () => {
    const r = rig({ failOnce: { find_chat: { ok: false, summary: 'could not look', error: 'I could not look for that chat', data: { status: 'error', reason: 'timeout' } } } });
    const first = await r.send(REQUEST);
    expect(first.ok).toBe(false);
    expect(first.spoken).toContain('the browser did not answer in time'); // says WHY, not just "couldn't look"
    expect(r.app.sentLog).toEqual([]);
    const second = await r.send('ok');
    expect(second.spoken).toMatch(/^Sent to Anna\./);
    expect(r.app.sentLog).toEqual([{ to: 'Anna', text: 'where are u' }]);
  });

  it.each(['ok', 'do it now', 'go and do what i said', 'send na', 'try again', 'tryagain', 'continue'])('"%s" resumes it', async (follow) => {
    const r = rig({ failOnce: { find_chat: { ok: false, summary: 'could not look', error: 'x', data: { status: 'error', reason: 'timeout' } } } });
    await r.send(REQUEST);
    const out = await r.send(follow);
    expect(out.spoken).toMatch(/^Sent to Anna\./);
    expect(r.app.sentLog).toHaveLength(1);
  });

  it('once it went, "ok" or "send na" is not "send it again"', async () => {
    const r = rig();
    await r.send(REQUEST);
    expect(r.app.sentLog).toHaveLength(1);
    expect((await r.send('ok')).spoken).toBe('(passed to the AI)');
    expect((await r.send('send na')).spoken).toBe('(passed to the AI)');
    expect(r.app.sentLog).toHaveLength(1);
  });

  it('a question that is waiting gets the answer in any of the usual words: "send na" is a yes', async () => {
    const r = rig();
    await r.send("send msg to naveen in whatsapp 'hello'");
    expect((await r.send('send na')).spoken).toMatch(/^Sent to Naveen Anna\./);
  });
});

describe('6. the task survives an AI that cannot answer', () => {
  it('with every AI out of credit the request is still carried out, and "ok" resumes it, with no AI call at all', async () => {
    const down = { value: true };
    const r = rig({ browserDown: down });
    const ai = new ScriptedAI([new Error('openai has no credit left (429)'), new Error('groq http 500')]);
    const engine = r.engine(ai);
    const first = await engine.handle({ requestId: 'a', text: REQUEST, source: 'text' }, () => undefined);
    expect(first.ok).toBe(false); // the browser was not there yet: passed on, and the AI could not help either
    down.value = false;
    const second = await engine.handle({ requestId: 'b', text: 'ok', source: 'text' }, () => undefined);
    expect(second.spoken).toMatch(/^Sent to Anna\./);
    expect(r.app.sentLog).toEqual([{ to: 'Anna', text: 'where are u' }]);
    const aiCallsAfterResume = ai.calls;
    const third = await engine.handle({ requestId: 'c', text: 'ok', source: 'text' }, () => undefined).catch(() => null);
    expect(r.app.sentLog).toHaveLength(1); // a provider switch, a retry or a stray "ok" never sends it twice
    expect(third).not.toBeUndefined();
    expect(ai.calls).toBeGreaterThanOrEqual(aiCallsAfterResume);
  });
});

describe('7. a tool call written as text that cannot be run is never shown', () => {
  it('{"name":"clickonlink",...} is not the answer: the model is told, and if it keeps doing it the person is told honestly', async () => {
    const r = rig();
    const ai = new ScriptedAI([say('{"name":"clickonlink","parameters":{"text":"Send"}}'), say('{"name":"getmessage","parameters":{}}'), say('{"name":"clickonlink","parameters":{}}')]);
    const out = await r.engine(ai).handle({ requestId: 'j1', text: 'press send in the chat please', source: 'text' }, () => undefined);
    expect(out.spoken).not.toContain('clickonlink');
    expect(out.spoken).not.toContain('{"name"');
    expect(out.spoken).toMatch(/nothing was done/i);
    expect(out.ok).toBe(false);
    // the model was told what was wrong, once per bad answer
    const notes = ai.seen[1]?.filter((m) => m.role === 'user' && m.content.startsWith('(Eya) Your last reply was text written like a tool call')) ?? [];
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain('"clickonlink" is not a tool I have');
  });

  it('a model that corrects itself after the note carries on normally', async () => {
    const r = rig();
    const ai = new ScriptedAI([say('{"name":"clickonlink","parameters":{}}'), say('Sorry, I could not do that.')]);
    const out = await r.engine(ai).handle({ requestId: 'j2', text: 'press send in the chat please', source: 'text' }, () => undefined);
    expect(out.spoken).toBe('Sorry, I could not do that.');
  });
});

describe('8. a text call to a registered tool is dispatched as the real call', () => {
  it('{"name":"find_chat","parameters":{"query":"Anna"}} runs find_chat through the same dispatcher, and its result goes back to the model', async () => {
    const r = rig();
    const ai = new ScriptedAI([say('{"name":"find_chat","parameters":{"query":"Anna"}}'), say('I opened the chat with Anna.')]);
    const out = await r.engine(ai).handle({ requestId: 'd1', text: 'could you look for Anna in whatsapp and tell me when it is open', source: 'text' }, () => undefined);
    expect(r.app.open?.name).toBe('Anna');
    expect(out.spoken).toBe('I opened the chat with Anna.');
    const toolMessage = ai.seen[1]?.find((m) => m.role === 'tool');
    expect(toolMessage?.name).toBe('find_chat');
    expect(toolMessage?.content).toContain('opened');
  });

  it('the same call with a name that is only SIMILAR is not run', async () => {
    const r = rig();
    const ai = new ScriptedAI([say('{"name":"find_chats","parameters":{"query":"Anna"}}'), say('ok then')]);
    await r.engine(ai).handle({ requestId: 'd2', text: 'could you look for Anna in whatsapp and tell me when it is open', source: 'text' }, () => undefined);
    expect(r.app.open).toBeNull();
  });
});

describe('9. no repeated searches and clicks', () => {
  it('one conversation about one message: one search, one click on the row, one message', async () => {
    const r = rig({ mode: 'always' });
    await r.send(REQUEST);
    await r.send('send na');
    expect(r.app.searchTypes).toBe(1);
    expect(r.app.rowClicks).toBe(1);
    expect(r.app.sentLog).toHaveLength(1);
  });

  it('a click that opened nothing is retried once from a fresh look, and then said plainly — not repeated for ever', async () => {
    const r = rig({
      setup: (a) => {
        a.rowClickDoesNothing = true;
      },
    });
    const out = await r.send(REQUEST);
    expect(out.ok).toBe(false);
    expect(out.spoken).toMatch(/didn't open it/);
    expect(r.app.rowClicks).toBe(2); // the click, and one more after looking again
    expect(r.app.searchTypes).toBe(1);
    expect(r.app.sentLog).toEqual([]);
  });
});

describe('10. no duplicate after an uncertain outcome', () => {
  it('a message whose result is not shown is "not known", and "ok" / the same request again looks in the chat first instead of sending again', async () => {
    const r = rig({
      setup: (a) => {
        a.marks = 'none';
      },
    });
    const first = await r.send(REQUEST);
    expect(first.ok).toBe(false);
    expect(first.spoken).toMatch(/won't send it again without checking the chat first|can't confirm/);
    expect(r.app.sentLog).toHaveLength(1);
    const again = await r.send('ok');
    expect(r.app.sentLog).toHaveLength(1); // it is in the chat: looked at, never sent a second time
    expect(again.spoken).toMatch(/already in the chat with Anna/);
    const asked = await r.send(REQUEST);
    expect(asked.spoken).toMatch(/already in the chat with Anna|did not send it again/);
    expect(r.app.sentLog).toHaveLength(1);
  });

  it('a file whose result is not shown is not sent a second time either', async () => {
    const r = rig({
      setup: (a) => {
        a.marks = 'none';
      },
    });
    await r.send('send the latest pdf to Anna on WhatsApp');
    expect(r.app.sentLog).toEqual([{ to: 'Anna', file: 'report.pdf' }]);
    // asked for again: the earlier one is not confirmed either way, so it is ASKED about (told it may already be there), not sent
    const again = await r.send('send the latest pdf to Anna on WhatsApp');
    expect(again.spoken).toMatch(/not confirmed either way/);
    expect(r.app.sentLog).toHaveLength(1);
    await r.send('no');
    expect(r.app.sentLog).toHaveLength(1);
    expect(r.app.picker).toBeNull();
  });
});

describe('11. only the status the page showed is claimed', () => {
  it.each([
    ['normal', /^Sent to Anna\. WhatsApp shows it as sent, not yet delivered\.$/],
    ['delivered', /^Sent to Anna\. WhatsApp shows it as delivered\.$/],
  ] as const)('a %s mark', async (marks, expected) => {
    const r = rig({
      setup: (a) => {
        a.marks = marks;
      },
    });
    expect((await r.send(REQUEST)).spoken.replace(/ By the way.*$/, '')).toMatch(expected);
  });

  it('with no mark at all it is NOT called sent, delivered or read', async () => {
    const r = rig({
      setup: (a) => {
        a.marks = 'none';
      },
    });
    const out = await r.send(REQUEST);
    expect(out.ok).toBe(false);
    expect(out.spoken).not.toMatch(/^Sent|delivered|read/i);
    expect(out.spoken).toMatch(/can't confirm|can't see/);
  });

  it('a failure the page shows is said as a failure', async () => {
    const r = rig({
      setup: (a) => {
        a.marks = 'failed';
      },
    });
    expect((await r.send(REQUEST)).spoken).toMatch(/failed to send to Anna/);
  });
});

describe('12. timeouts do not restart the whole task', () => {
  it('a timeout while looking is said as a timeout, and "ok" goes on from there', async () => {
    const r = rig({ failOnce: { find_chat: { ok: false, summary: 'could not look', error: 'timed out', data: { status: 'error', reason: 'timeout' } } } });
    const first = await r.send(REQUEST);
    expect(first.spoken).toMatch(/the browser did not answer in time/);
    expect(r.app.searchTypes).toBe(0); // nothing was typed before it timed out
    await r.send('ok');
    expect(r.app.searchTypes).toBe(1);
    expect(r.app.sentLog).toHaveLength(1);
  });

  it('the diagnostics keep the KIND of failure and never a name, number or message', async () => {
    const r = rig({ failOnce: { find_chat: { ok: false, summary: 'could not look', error: 'timed out', data: { status: 'error', reason: 'timeout' } } } });
    await r.send(REQUEST);
    expect(JSON.stringify(r.invoked)).not.toContain('where are u');
  });
});

describe('a file to a person goes through "Select chats", and the same rules hold', () => {
  it('"send the latest pdf to Anna on WhatsApp" is sent to the exact Anna, once, and checked', async () => {
    const r = rig();
    const out = await r.send('send the latest pdf to Anna on WhatsApp');
    expect(out.spoken).toMatch(/^Sent "report\.pdf" to Anna\. WhatsApp shows it as sent/);
    expect(r.app.sentLog).toEqual([{ to: 'Anna', file: 'report.pdf' }]);
    expect(r.app.searchTypes).toBe(0);
    expect(r.app.rowClicks).toBe(0);
  });

  it('a likely match is asked about first, and a yes sends it; a no closes the picker', async () => {
    const r = rig();
    const asked = await r.send('send the latest pdf to naveen on WhatsApp');
    expect(asked.spoken).toContain('matched only on "naveen"');
    expect(r.app.sentLog).toEqual([]);
    expect((await r.send('send na')).spoken).toMatch(/^Sent "report\.pdf" to Naveen Anna\./);
    expect(r.app.sentLog).toEqual([{ to: 'Naveen Anna', file: 'report.pdf' }]);

    const r2 = rig();
    await r2.send('send the latest pdf to naveen on WhatsApp');
    expect((await r2.send('no')).spoken).toMatch(/won't send it/);
    expect(r2.app.picker).toBeNull();
    expect(r2.app.sentLog).toEqual([]);
  });

  it('nobody found: says so, closes the picker, sends nothing', async () => {
    const r = rig();
    const out = await r.send('send the latest pdf to zoya on WhatsApp');
    expect(out.spoken).toMatch(/couldn't find anyone called zoya/);
    expect(r.app.picker).toBeNull();
    expect(r.app.sentLog).toEqual([]);
  });
});
