import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BrowserAutomationService, ChatMediaResult } from '../src/main/browser/BrowserAutomationService';
import type { LiveChatMessage } from '../src/main/browser/BrowserAutomationService';
import type { AIChatMessage, CompleteOptions } from '../src/main/providers/ai/AIProvider';
import { buildDraftMessages, buildLocalDraftMessages, fallbackLine, generateDraft, mediaReplyLine, outLabel, passOnLine } from '../src/main/livechat/draft';
import type { DraftAI, DraftInput } from '../src/main/livechat/draft';
import { createChatMedia } from '../src/main/livechat/liveChatMedia';
import { asksForOwner, claimsAboutOwner, repeatsRecently, transcript } from '../src/main/livechat/messages';
import { FakeSwitch, rig, settle } from './liveChatFixtures';
import type { Rig } from './liveChatFixtures';

/**
 * A real chat, 6 Nov 2026 (a friend of Rakesh's, replayed with the real models): Eya — a message-taking machine at every turn ("anything else you'd like me to pass on?"),
 * confused about which lines were Rakesh's own, telling a friend about a PDF "I don't have the right tools to view files like that", and, through the small local model, inventing
 * a whole person ("He's a hard worker… I've known him for a long time"). What she must be instead: a friend in the chat. Over a SCRIPTED model, so every case is exact.
 */

const m = (id: string, dir: 'in' | 'out', text: string): LiveChatMessage => ({ id, dir, kind: 'text', text, at: '' });

class Scripted implements DraftAI {
  readonly calls: Array<{ messages: AIChatMessage[]; options: CompleteOptions | undefined }> = [];
  constructor(
    private readonly answers: string[],
    private readonly small = true,
  ) {}
  async complete(messages: readonly AIChatMessage[], _tools: readonly never[], options?: CompleteOptions) {
    this.calls.push({ messages: [...messages], options });
    const next = this.answers.shift();
    if (next === undefined) throw new Error('nothing queued');
    return { text: next, toolCalls: [], ...(this.small ? { local: true as const } : {}) };
  }
}
const json = (reply: string, forOwner = ''): string => JSON.stringify({ for_owner: forOwner, reply });

function input(said: string, before: LiveChatMessage[] = [], extra: Partial<DraftInput> = {}): DraftInput {
  const fresh = [m('fresh', 'in', said)];
  return { context: [...before, ...fresh], fresh, summary: '', tone: 'natural and brief', knows: true, answerByItself: true, ownerName: 'Rakesh', asEya: true, ...extra };
}

describe('she does not make up a person (the small model, asked "tell me about Rakesh")', () => {
  const FABRICATIONS = [
    "Rakesh is fine, thanks for asking. He's been busy with work and family stuff.",
    "He's a good friend of mine, and I've known him for a long time.",
    "He's a hard worker and takes care of his family.",
    "He's also very kind and always there for his friends.",
    'I think nobody is free right now.',
    'Rakesh works at a bank and likes cricket.',
    'I have known him for years.', // (a made-up history, with no "he is" in it)
    "I've known her a long time.",
  ];
  it('every statement about the person is a claim for the small model — the exact sentences it wrote', () => {
    for (const bad of FABRICATIONS) expect(claimsAboutOwner(bad, 'Rakesh', { strict: true, recent: 'Tell me about Rakesh' }), bad).not.toBeNull();
  });

  it('but what a friend may say is never a claim: the name as a possessive, not knowing, asking, wishing well, passing it on', () => {
    for (const fine of [
      "I'm sorry about Rakesh's accident.",
      "That one was me, Eya, Rakesh's AI assistant.",
      "I don't know if he is okay, but I'll ask Rakesh.",
      "I'll let Rakesh know! 😊",
      'I hope your mother feels better soon.',
      'Is he getting better?',
      'Take care of yourself, too!',
    ]) {
      expect(claimsAboutOwner(fine, 'Rakesh', { strict: true, recent: 'Rakesh had an accident' }), fine).toBeNull();
    }
  });

  it('a "he" or "she" about somebody else is not the person (the friend was talking about their brother, not Rakesh)', () => {
    expect(claimsAboutOwner("He's very tired today.", 'Rakesh', { strict: true, recent: 'my brother is sick' })).toBeNull();
    expect(claimsAboutOwner("He's very tired today.", 'Rakesh', { strict: true, recent: 'how is Rakesh doing' })).not.toBeNull();
  });

  it('the strong models are not held to it: "Rakesh is lucky to have a friend like you" is a kind thing to say, and is left alone', () => {
    expect(claimsAboutOwner('Rakesh is lucky to have a friend like you!', 'Rakesh')).toBeNull();
    expect(claimsAboutOwner('Rakesh is lucky to have a friend like you!', 'Rakesh', { strict: true, recent: 'Rakesh' })).not.toBeNull();
  });

  it('asked to tell about Rakesh, a small model that invents him is asked again; if it invents again, she says she cannot speak for him and turns back to the friend', async () => {
    const ai = new Scripted([json("He's a hard worker and takes care of his family."), json("He's a good friend of mine, I've known him for years.")]);
    const out = await generateDraft(ai, input('Tell me about Rakesh'));
    expect(ai.calls).toHaveLength(2);
    expect(out).toMatchObject({ kind: 'draft', text: "I can't really speak for Rakesh, but I'm happy to chat with you! 😊 How are you doing?", forOwner: '' });
  });

  it('a strong model answering the same way is not second-guessed', async () => {
    const out = await generateDraft(new Scripted([json("I can't really tell you much about Rakesh, but he is lucky to have a friend like you!")], false), input('Tell me about Rakesh'));
    expect(out).toMatchObject({ kind: 'draft', text: "I can't really tell you much about Rakesh, but he is lucky to have a friend like you!" });
  });
});

describe('she does not say the same thing again (a small model with nothing new to say)', () => {
  const said = 'I was created using a combination of natural language processing and machine learning algorithms.';
  it('the same thing in other words is a repeat of one of her last messages; something new is not', () => {
    const context = [m('1', 'out', said), m('2', 'in', 'Okay'), m('3', 'out', 'Glad to help! 😊')];
    expect(repeatsRecently('I was created using natural language processing and machine learning.', context)).toBe(true);
    expect(repeatsRecently('Tell me more about what you are studying!', context)).toBe(false);
    expect(repeatsRecently('Okay!', context)).toBe(false); // (too short to be "the same thing")
  });

  it('asked again, and if it says it again she does not send it a third time', async () => {
    const before = [m('a', 'in', 'how were you trained'), m('b', 'out', said)];
    const ai = new Scripted([json(said), json(said)]);
    const out = await generateDraft(ai, input('Yes', before));
    expect(ai.calls).toHaveLength(2);
    expect(out.kind).toBe('none');
  });
});

describe('what is handed to Rakesh is what the words ask for — a question about who texted is not a message for him', () => {
  it('"is this text by Rakesh or his assistant?" is for HER to answer; "where is Rakesh?", "is Rakesh online?" are for him', () => {
    expect(asksForOwner("Is this message from Rakesh himself or from the assistant?", 'Rakesh')).toBe(false);
    for (const q of ['Where is Rakesh?', 'Is Rakesh online?', 'Is Rakesh free tomorrow?', 'Will Rakesh come today?']) expect(asksForOwner(q, 'Rakesh'), q).toBe(true);
  });
});

describe('the lines of the chat are labelled by who wrote them, so that she does not take Rakesh\'s words for hers', () => {
  const context = [m('1', 'in', 'How is your health now?'), m('2', 'out', 'Little good'), m('3', 'out', "Hi, I'm Eya, Rakesh's assistant."), m('4', 'in', 'Why did you message me like this')];

  it('the account\'s own lines are "Eya:" for what she sent and "Rakesh:" for what he typed himself', () => {
    const label = outLabel({ asEya: true, eyaSentIds: ['3'], ownerName: 'Rakesh' });
    expect(typeof label).toBe('function');
    const lines = transcript(context, 30, {}, label);
    expect(lines).toEqual(['Them: How is your health now?', 'Rakesh: Little good', "Eya: Hi, I'm Eya, Rakesh's assistant.", 'Them: Why did you message me like this']);
  });

  it('with no information every outgoing line is hers (as before), and in the person\'s voice it is "Me"', () => {
    expect(outLabel({ asEya: true, ownerName: 'Rakesh' })).toBe('Eya');
    expect(outLabel({ ownerName: 'Rakesh' })).toBe('Me');
    expect(outLabel({ asEya: true, eyaSentIds: [], ownerName: '' })).toBeTypeOf('function');
  });

  it('the cloud prompt and the small model\'s prompt both show the labels, and say what they mean', () => {
    const full = buildDraftMessages(input('Why did you message me like this', context.slice(0, 3), { eyaSentIds: ['3'] }));
    const user = full[1]?.content ?? '';
    expect(user).toMatch(/^Rakesh: Little good$/m);
    expect(user).toMatch(/^Eya: Hi, I'm Eya, Rakesh's assistant\.$/m);
    expect(full[0]?.content).toMatch(/Lines of the conversation that start with "Rakesh:" were typed by Rakesh personally in this same chat; lines that start with "Eya:" are yours/);
    // The small model is NOT shown the lines Rakesh typed himself: shown "Rakesh: what should i tell her" it answered the FRIEND as if the friend were Rakesh ("I don't know anything about
    // your accident, Rakesh") — a 1B model cannot keep three speakers apart. Its own lines are labelled, and the strong models' prompt (above) keeps his, labelled.
    const local = buildLocalDraftMessages(input('Why did you message me like this', context.slice(0, 3), { eyaSentIds: ['3'] }));
    expect(local[1]?.content).not.toMatch(/Little good/);
    expect(local[1]?.content).toMatch(/^Eya: Hi, I'm Eya, Rakesh's assistant\.$/m);
    expect(local[1]?.content).toMatch(/^Them: How is your health now\?$/m);
    // with nothing known about who wrote what, every line is shown (as before)
    const unknown = buildLocalDraftMessages(input('Why did you message me like this', context.slice(0, 3)));
    expect(unknown[1]?.content).toMatch(/Eya: Little good/);
  });
});

describe('through the controller: Rakesh typing in the same chat is shown to her as Rakesh, and hers as hers', () => {
  async function running(): Promise<Rig> {
    const sw = new FakeSwitch();
    sw.on = true;
    const r = rig({ enable: sw.control });
    r.ai.say("Hi, I'm Eya, Rakesh's assistant. 😊 How are you doing?");
    await r.controller.start('Rahul Sharma');
    await settle(40);
    return r;
  }

  it('the request after Rakesh typed a line himself labels it with his name; her own introduction is "Eya:"', async () => {
    const r = await running();
    r.chat.outgoing('go to hell'); // (typed by Rakesh himself, from his phone)
    r.ai.say('Ha, that was Rakesh himself, I am the assistant.');
    r.chat.incoming('Is this message from Rakesh himself or from the assistant?');
    r.chat.changed();
    await settle(40);
    r.advance(12_000);
    await settle(40);
    const asked = r.ai.requests.at(-1) ?? '';
    expect(asked).toMatch(/^Rakesh: go to hell$/m);
    expect(asked).toMatch(/^Eya: Hi, I'm Eya, Rakesh's assistant\. 😊 How are you doing\?$/m);
    expect(asked).toMatch(/^Them: Is this message from Rakesh himself or from the assistant\?$/m);
  });
});

describe('a file she is sent: she has it, and she can still read a plain one when the AI that reads files cannot', () => {
  const DOWNLOADS = join(mkdtempSync(join(tmpdir(), 'eya-friend-')), 'Downloads');
  const write = (name: string, text: string): string => {
    const path = join(DOWNLOADS, name);
    return path;
  };
  void write;

  function wired(look: ChatMediaResult, readable: boolean) {
    const service = { chatMedia: async (_id: string, step: 'look' | 'download') => (step === 'look' ? look : { ok: false, reason: 'failed', message: 'x' }) } as unknown as BrowserAutomationService;
    return createChatMedia({
      service,
      downloadsDir: DOWNLOADS,
      tools: { invoke: async () => (readable ? { ok: true, summary: 'read', data: { answer: 'A study guide.' } } : { ok: false, summary: 'could not read', error: 'Gemini has no allowance left' }) },
    });
  }

  it('Gemini cannot read it (no allowance left), but it is a text file: the start of it is read right here', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eya-friend-dl-'));
    const media = createChatMedia({
      service: {} as unknown as BrowserAutomationService,
      downloadsDir: dir,
      tools: { invoke: async () => ({ ok: false, summary: 'could not read', error: 'no allowance' }) },
    });
    writeFileSync(join(dir, 'notes.txt'), 'Meeting notes\n\nWe agreed to meet on Sunday at the temple, and Meena will bring the sweets.');
    writeFileSync(join(dir, 'guide.pdf'), '%PDF-1.4 binary');
    expect(await media.read(join(dir, 'notes.txt'), 'document', 'notes.txt')).toBe('the first words are: Meeting notes We agreed to meet on Sunday at the temple, and Meena will bring the sweets.');
    // a PDF (or a picture) needs the AI that reads files: without it there is nothing to say about it, and she says so honestly
    expect(await media.read(join(dir, 'guide.pdf'), 'document', 'guide.pdf')).toBeNull();
    expect(await media.read(join(dir, 'notes.txt'), 'image', 'notes.txt')).toBeNull();
  });

  it('when the AI that reads files does read it, that answer is used (the local read is only the fallback)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eya-friend-dl2-'));
    writeFileSync(join(dir, 'notes.txt'), 'plain words');
    const media = createChatMedia({ service: {} as unknown as BrowserAutomationService, downloadsDir: dir, tools: { invoke: async () => ({ ok: true, summary: 'read', data: { answer: 'Meeting notes about Sunday.' } }) } });
    expect(await media.read(join(dir, 'notes.txt'), 'document', 'notes.txt')).toBe('Meeting notes about Sunday.');
  });

  it('a file outside Downloads is never read, by either way', async () => {
    const media = createChatMedia({ service: {} as unknown as BrowserAutomationService, downloadsDir: DOWNLOADS, tools: { invoke: async () => ({ ok: true, summary: 'read', data: { answer: 'x' } }) } });
    const other = join(mkdtempSync(join(tmpdir(), 'eya-elsewhere-')), 'notes.txt');
    writeFileSync(other, 'secret');
    expect(await media.read(other, 'document', 'notes.txt')).toBeNull();
  });

  it('a document with no download button says what the page DID show (its icon names, never a word of the chat), so the next fix knows', async () => {
    const media = wired({ ok: true, via: 'document', name: 'guide.pdf', hasControl: false, icons: ['document-pdf', 'x-viewer'] }, true);
    const out = await media.save('msg-1', 'document');
    expect(out).toEqual({ ok: false, say: 'I could not find the download button on that document (the page showed: document-pdf, x-viewer).' });
    const none = wired({ ok: true, via: 'document', name: 'guide.pdf', hasControl: false }, true);
    expect(await none.save('msg-1', 'document')).toEqual({ ok: false, say: 'I could not find the download button on that document.' });
  });
});

describe('the plain lines no longer ask "anything else to tell Rakesh?" — a friend does not end every message that way', () => {
  it('none of them asks it, and they still never claim anything about him or say she is human', () => {
    const lines = [
      ...(['pass_on', 'about_owner', 'unclear', 'human', 'check_in', 'opening'] as const).map((k) => fallbackLine(k, 'Rakesh')),
      passOnLine('Rakesh', [], false),
      passOnLine('Rakesh', [m('1', 'out', "Sure, I'll let Rakesh know! 😊")], false),
      passOnLine('Rakesh', [], true),
    ];
    for (const line of lines) {
      expect(line, line).not.toMatch(/anything else[^.?!]*(?:tell|pass)|pass(?:ing)? (?:it |that |this )?on\?|want me to tell/i);
      expect(claimsAboutOwner(line, 'Rakesh', { strict: true, recent: 'Rakesh' }), line).toBeNull();
    }
  });
});

describe('a file sent to the small model: the reply is made from what was found in it, not copied from an example', () => {
  const doc = (id: string): LiveChatMessage => ({ id, dir: 'in', kind: 'document', text: 'Agents-Course-Notes.pdf', at: '' });
  const pic = (id: string): LiveChatMessage => ({ id, dir: 'in', kind: 'image', text: '', at: '' });
  const readNote = { kind: 'document' as const, name: 'Agents-Course-Notes.pdf', status: 'read' as const, summary: 'A set of course notes on how software agents choose and use tools. It has twelve pages.' };

  it('a document that was read: thanks, what it is (the first sentence of what the reader found), and why it was sent — never "I cannot open it"', () => {
    expect(mediaReplyLine([doc('d1')], { d1: readNote })).toBe('Thanks for sending "Agents-Course-Notes.pdf"! 😊 A set of course notes on how software agents choose and use tools. Why did you send it?');
  });

  it('a picture that was read; and a file that could not be read says so simply and asks what it is', () => {
    expect(mediaReplyLine([pic('p1')], { p1: { kind: 'image', name: '', status: 'read', summary: 'A photo of two people at a temple' } })).toBe('Thanks for sending the picture! 😊 A photo of two people at a temple. Why did you send it?');
    expect(mediaReplyLine([doc('d1')], { d1: { ...readNote, status: 'saved', summary: '' } })).toBe('Thanks for sending "Agents-Course-Notes.pdf"! 😊 I couldn\'t read it properly this time. What is it about?');
    expect(mediaReplyLine([doc('d1')], { d1: { ...readNote, status: 'failed', summary: '' } })).not.toMatch(/tools|can't open|cannot open/i);
  });

  it('only when the new messages are only files, and something is known about them', () => {
    expect(mediaReplyLine([doc('d1'), m('t', 'in', 'please check this')], { d1: readNote })).toBeNull();
    expect(mediaReplyLine([doc('d1')], undefined)).toBeNull();
    expect(mediaReplyLine([doc('d1')], {})).toBeNull();
    expect(mediaReplyLine([], { d1: readNote })).toBeNull();
  });

  it('the small model\'s own words about a file are not used (it copied "I\'ll let Rakesh know! Is everything okay with the land papers?" for a PDF); a strong model\'s are', async () => {
    const media = { d1: readNote };
    const fresh = [doc('d1')];
    const base: DraftInput = { context: fresh, fresh, summary: '', tone: 'x', knows: true, answerByItself: true, ownerName: 'Rakesh', asEya: true, media };
    const small = await generateDraft(new Scripted([json("Sure, I'll let Rakesh know! 😊 Is everything okay with the land papers?")]), base);
    expect(small).toMatchObject({ kind: 'draft', text: 'Thanks for sending "Agents-Course-Notes.pdf"! 😊 A set of course notes on how software agents choose and use tools. Why did you send it?', forOwner: '' });
    const strong = await generateDraft(new Scripted([json('Oh nice, course notes on agents! Are you studying this for work?')], false), base);
    expect(strong).toMatchObject({ kind: 'draft', text: 'Oh nice, course notes on agents! Are you studying this for work?' });
  });
});

describe('a question is never answered with silence', () => {
  it('a small model that says almost what it said a moment ago is asked again with a new angle; if it still does, she asks them to say a bit more — she does not go quiet on a question', async () => {
    const said = "I help Rakesh with answering questions, providing information on various topics, and engaging in conversations.";
    const before = [m('a', 'in', 'what exactly do you do for him'), m('b', 'out', said)];
    const ai = new Scripted([json("I help Rakesh with answering questions, providing information on many topics, and engaging in conversations."), json(said)]);
    const out = await generateDraft(ai, input('explain it to me properly', before, { eyaSentIds: ['b'] }));
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[1]?.messages.at(-1)?.content).toMatch(/already said almost exactly that a moment ago/);
    expect(out).toMatchObject({ kind: 'draft', text: "Hmm, I'm not sure I understood that well. Could you tell me a bit more? 😊" });
  });

  it('but word for word the SAME message as her last one is still not sent a third time (that is a loop, not an answer)', async () => {
    const said = 'Is there anything you want to talk about today?';
    const before = [m('a', 'in', 'ok'), m('b', 'out', said)];
    const out = await generateDraft(new Scripted([json(said), json(said)]), input('hmm', before, { eyaSentIds: ['b'] }));
    expect(out.kind).toBe('none');
  });
});
