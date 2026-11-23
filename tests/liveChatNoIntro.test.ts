import { describe, expect, it } from 'vitest';
import type { AIChatMessage, CompleteOptions } from '../src/main/providers/ai/AIProvider';
import type { LiveChatMessage } from '../src/main/browser/BrowserAutomationService';
import {
  buildDraftMessages,
  buildLocalDraftMessages,
  buildLocalNudgeMessages,
  buildLocalOpeningMessages,
  buildNudgeMessages,
  buildOpeningMessages,
  fallbackLine,
  generateDraft,
  generateNudge,
  generateOpening,
} from '../src/main/livechat/draft';
import type { DraftAI, DraftInput } from '../src/main/livechat/draft';
import { asksWhoSheIs, purposeAsksIntro, stripSelfIntro } from '../src/main/livechat/selfIntro';
import { claimsToBeHuman } from '../src/main/livechat/messages';
import { FakeSwitch, rig, settle } from './liveChatFixtures';

/**
 * 22 Nov 2026 — "When live chat, Eya never ever said in starting I am Rakesh's assistant, just directly go ahead chat; in case, between chatting, the other person asks who you
 * are, then tell."  So: she never introduces herself (not in the first message, not in a reply, not in a check-in, and nothing is put in front of what a model wrote); she tells who she
 * is, honestly, when she is ASKED (who are you / who is this / are you a bot / is this Rakesh); and she still never claims to be human or to be Rakesh.
 * Mock chat + mock model: these prove the rule and the checks, not what a real model writes.
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
const json = (reply: string | null): string => JSON.stringify({ for_owner: '', reply });
function eyaInput(said: string, extra: Partial<DraftInput> = {}): DraftInput {
  const fresh = [m('fresh', 'in', said)];
  return { context: fresh, fresh, summary: '', tone: 'natural', knows: true, answerByItself: true, ownerName: 'Rakesh', asEya: true, ...extra };
}
const allText = (msgs: readonly AIChatMessage[]): string => msgs.map((x) => x.content).join('\n');

describe('they are asking who she is — in the words people really use', () => {
  it('"who are you", "who is this", "are you a bot / AI / real", "your name", "is this Rakesh" — English, Hindi and Telugu in English letters, and the scripts', () => {
    for (const q of [
      'Who are you?',
      'who r u',
      'Who is this?',
      "who's this",
      'Who am I talking to?',
      'who is messaging me',
      'Are you a bot?',
      'are you AI?',
      'Are you a real person?',
      'are u human',
      'Is this a bot?',
      'human or bot?',
      "What's your name?",
      'what is your name',
      'Is this Rakesh?',
      'are you Rakesh',
      'Hi, who wrote this?',
      'what are you?',
      'aap kaun ho',
      'tum kaun ho?',
      'kaun bol raha hai',
      'aapka naam kya hai',
      'nuvvu evaru',
      'meeru evaru andi?',
      'evaru nuvvu ra',
      'nee peru enti',
      'neenga yaaru?',
      'आप कौन हैं',
      'మీరు ఎవరు?',
      'நீங்கள் யார்?',
      'who the hell are you',
      'who exactly are you?',
      'Hey who tf are u',
      'r u a robot',
      'are you really a person?',
      'am I talking to a human?',
      'are you chatgpt?',
      'who made you?',
      'introduce yourself',
      'tell me about yourself',
    ]) {
      expect(asksWhoSheIs(q, 'Rakesh'), q).toBe(true);
    }
  });

  it('an ordinary message is not a question about her', () => {
    for (const q of [
      'Hi, how are you?',
      'What are you doing?',
      'what are you up to today',
      'Where are you?',
      'Are you coming tomorrow?',
      'Are you free tonight?',
      'who is coming to the party?',
      'Who won the match?',
      'Tell Rakesh to call me',
      'Is this the right address?',
      'Are you okay?',
      'good morning',
      '',
    ]) {
      expect(asksWhoSheIs(q, 'Rakesh'), q).toBe(false);
    }
  });
});

describe('an introduction nobody asked for is taken out of a reply — and only that', () => {
  it('the usual forms, with the greeting kept', () => {
    const cases: Array<[string, string]> = [
      ["Hi, I'm Eya, Rakesh's assistant. How are you?", 'Hi! How are you?'],
      ["Hi! I am Eya, Rakesh's assistant 😊 What do you need?", 'Hi! 😊 What do you need?'],
      ["Hello, this is Eya, Rakesh's AI assistant. How can I help you today?", 'Hello! How can I help you today?'],
      ["Hey! I'm Eya, an assistant. 😊 How are you doing today?", 'Hey! 😊 How are you doing today?'],
      ["Oh, sorry for the confusion! I'm Eya, the assistant. I'll let Rakesh know.", "Oh, sorry for the confusion! I'll let Rakesh know."],
      ["Eya here! How is your day going?", 'How is your day going?'],
      ["Hi, I'm Eya and I'm Rakesh's assistant. How are you?", 'Hi! How are you?'],
      ["My name is Eya, Rakesh's assistant. Nice to chat with you!", 'Nice to chat with you!'],
      ["I'm Eya, Rakesh's assistant, how are you?", 'how are you?'],
    ];
    for (const [said, want] of cases) expect(stripSelfIntro(said), said).toBe(want);
  });

  it('a reply with nothing but the introduction (and a greeting) is empty, so it can be asked for again', () => {
    for (const said of ["Hi, I'm Eya, Rakesh's assistant.", "I am Eya, Rakesh's assistant.", "Hello! This is Eya.", "Hi! I'm Rakesh's assistant."]) expect(stripSelfIntro(said), said).toBe('');
  });

  it('an ordinary reply is left exactly as it is (no word of it touched)', () => {
    for (const said of [
      'Hi! 😊 How are you doing today?',
      "I'm good, thanks! How about you?",
      "I'm so happy to hear that!",
      "Sure, I'll let Rakesh know! 😊",
      'Rakesh says: I will call you tonight',
      "Haha that's funny, I'm Eyaz's friend too",
      "I'm real glad you wrote!",
      "I'm happy to help",
      'Is there anything else you want me to tell Rakesh?',
      '',
    ]) {
      expect(stripSelfIntro(said), said).toBe(said);
    }
  });

  it('what is taken out never leaves a stray mark behind', () => {
    for (const said of ["Hi, I'm Eya, Rakesh's assistant. How are you?", "Oh! I'm Eya, the assistant. Sorry about that.", "Eya here. Tell me more!", "I'm Eya, Rakesh's assistant! What is up?"]) {
      const out = stripSelfIntro(said);
      expect(out, said).not.toMatch(/(?:^|\s)[.,;:!?]|[,;:]\s*[.!?]|[.!?]\.|\s{2}/);
      expect(out, said).not.toMatch(/Eya|assistant/i);
    }
  });

  it('what the person\'s instruction asks for in so many words is allowed — a bare "you can introduce yourself" is not enough', () => {
    expect(purposeAsksIntro('introduce yourself as my assistant and ask how she is')).toBe(true);
    expect(purposeAsksIntro('tell them you are Eya, my assistant')).toBe(true);
    expect(purposeAsksIntro('say who you are')).toBe(true);
    expect(purposeAsksIntro('you can introduce yourself, based on response respond until i said stop')).toBe(false);
    expect(purposeAsksIntro('she is my close friend, make her happy')).toBe(false);
    expect(purposeAsksIntro(undefined)).toBe(false);
  });
});

describe('what every model is told', () => {
  const input = eyaInput('hello');
  const opening = { context: [], summary: '', tone: 'natural', purpose: 'she is my close friend, make her happy', ownerName: 'Rakesh', asEya: true as const };
  const nudge = { context: [m('1', 'in', 'hi'), m('2', 'out', 'Hi! How are you?')], summary: '', tone: 'natural', ownerName: 'Rakesh', minutes: 15 };

  it('nothing tells her to say who she is, in any prompt (cloud and small model: reply, first message, check-in)', () => {
    const prompts = [
      allText(buildDraftMessages(input)),
      allText(buildLocalDraftMessages(input)),
      allText(buildOpeningMessages(opening)),
      allText(buildLocalOpeningMessages(opening)),
      allText(buildNudgeMessages(nudge)),
      allText(buildLocalNudgeMessages(nudge)),
    ];
    for (const p of prompts) {
      expect(p).not.toMatch(/Say who you are|Say hi and who you are|begin by saying in one short phrase who you are|You have not said who you are yet|must say who you are|start with "Hi, I'm Eya/);
      expect(p).not.toMatch(/Hi, I am Eya, Rakesh's assistant"?\)?\s*,? be warm/i);
      expect(p).not.toMatch(/Speak as yourself, in the first person: "I am Eya/);
      expect(p).not.toMatch(/The other person KNOWS that you, Eya, are/);
      // (the examples she is shown must not teach it either)
      expect(p).not.toMatch(/"reply": "Hi! I'm Eya, /);
    }
  });

  it('every prompt for Eya forbids it, and says to answer honestly only when she is asked', () => {
    expect(allText(buildDraftMessages(input))).toMatch(/NEVER introduce yourself and never say who you are or whose assistant you are/);
    expect(allText(buildDraftMessages(input))).toMatch(/Only when they ask, answer honestly in a few words: you are Eya, Rakesh's assistant, an AI assistant who chats here for Rakesh/);
    expect(allText(buildLocalDraftMessages(input))).toMatch(/Never introduce yourself: do not say your name or whose assistant you are, unless they ask/);
    expect(allText(buildOpeningMessages(opening))).toMatch(/Do NOT say who you are or whose assistant you are/);
    expect(allText(buildLocalOpeningMessages(opening))).toMatch(/Do NOT say who you are, your name, or whose assistant you are/);
    expect(allText(buildNudgeMessages(nudge))).toMatch(/NEVER introduce yourself or say whose assistant you are/);
    expect(allText(buildLocalNudgeMessages(nudge))).toMatch(/Do not introduce yourself or say whose assistant you are/);
    // (the honesty rules stay: never human, never the person)
    for (const p of [allText(buildDraftMessages(input)), allText(buildOpeningMessages(opening)), allText(buildNudgeMessages(nudge))]) {
      expect(p).toMatch(/never claim to be a human|Never claim to be a human/);
    }
  });

  it('when they ask who she is, the prompt says to answer — briefly and honestly — in both the cloud and the small-model prompt', () => {
    const asked = eyaInput('Who are you?');
    expect(allText(buildDraftMessages(asked))).toMatch(/They are asking who you are: answer that honestly and briefly \(you are Eya, Rakesh's assistant, an AI assistant who chats here for Rakesh\)/);
    expect(allText(buildLocalDraftMessages(asked))).toMatch(/They are asking who you are: answer honestly in a few words \(you are Eya, an AI assistant who chats for Rakesh\)/);
    // (the small model's example for it is the honest answer, and "what are you doing" is not answered with an introduction)
    const local = allText(buildLocalDraftMessages(input));
    expect(local).toMatch(/Them: Who are you\?\n\{"for_owner": "", "reply": "I'm Eya, Rakesh's AI assistant\./);
    expect(local).not.toMatch(/Them: What are you doing\?\n[^\n]*I'm Eya/);
    expect(allText(buildDraftMessages(input))).not.toMatch(/They are asking who you are/);
  });
});

describe('what Eya sends', () => {
  it('a reply to an ordinary message has no introduction, whichever model wrote it', async () => {
    for (const small of [true, false]) {
      const out = await generateDraft(new Scripted([json("Hi, I'm Eya, Rakesh's assistant. Doing well, thanks! How about you?")], small), eyaInput('hi, how are you?'));
      expect(out, `small=${small}`).toMatchObject({ kind: 'draft', text: 'Hi! Doing well, thanks! How about you?' });
    }
  });

  it('asked who she is (any of the usual ways), she answers honestly — nothing is taken out of that answer', async () => {
    const answer = "I'm Eya, Rakesh's AI assistant. I chat here for him 😊 What about you?";
    for (const q of ['Who are you?', 'who is this', 'Are you a bot?', 'are you real?', 'Is this Rakesh?', 'aap kaun ho', 'nuvvu evaru']) {
      const out = await generateDraft(new Scripted([json(answer)]), eyaInput(q));
      expect(out, q).toMatchObject({ kind: 'draft', text: answer });
    }
  });

  it('if the model fails on "who are you?", the plain honest line goes; it never says she is a human', async () => {
    const out = await generateDraft(new Scripted(['no json', 'no json']), eyaInput('who are you?'));
    expect(out).toMatchObject({ kind: 'draft', text: fallbackLine('who', 'Rakesh') });
    expect(fallbackLine('who', 'Rakesh')).toMatch(/I'm Eya, Rakesh's AI assistant/);
    expect(fallbackLine('who', '')).toMatch(/I'm Eya, an AI assistant/);
    expect(claimsToBeHuman(fallbackLine('who', 'Rakesh'), 'Rakesh')).toBeNull();
    // and when "are you a person?" gets "I am a real person", it is still put right (unchanged)
    const fixed = await generateDraft(new Scripted([json("Yes I'm a real person, I'm Eya"), json("No, I'm Eya, Rakesh's AI assistant. 😊 What about you?")]), eyaInput('are you a real person?'));
    expect(fixed).toMatchObject({ kind: 'draft', text: "No, I'm Eya, Rakesh's AI assistant. 😊 What about you?" });
  });

  it('the first message has no introduction — and the plain one that goes when no model answer can be used is just a hello', async () => {
    const input = { context: [], summary: '', tone: 'natural', ownerName: 'Rakesh', asEya: true as const };
    const hi = await generateOpening(new Scripted([json("Hi, I'm Eya, Rakesh's assistant. How are you doing?")]), input);
    expect(hi).toMatchObject({ kind: 'draft', text: 'Hi! How are you doing?' });
    // (a strong model whose first message was only an introduction is asked once more too — it is not handed back to the person)
    const strong = new Scripted([json("Hi, I'm Eya, Rakesh's assistant."), json('Hey! How have you been?')], false);
    expect(await generateOpening(strong, input)).toMatchObject({ kind: 'draft', text: 'Hey! How have you been?' });
    expect(strong.calls).toHaveLength(2);
    const plain = await generateOpening(new Scripted(['no json', 'no json']), input);
    expect(plain).toMatchObject({ kind: 'draft', text: 'Hi! 😊 How are you doing today?' });
    expect((plain as { text: string }).text).not.toMatch(/Eya|assistant/i);
  });

  it('a check-in has no introduction either', async () => {
    const out = await generateNudge(new Scripted([json("Hi, I'm Eya, Rakesh's assistant. Just checking in, how are things?")]), { context: [m('1', 'in', 'hi'), m('2', 'out', 'Hi! How are you?')], summary: '', tone: 'natural', ownerName: 'Rakesh', minutes: 15 });
    expect(out).toMatchObject({ kind: 'draft', text: 'Hi! Just checking in, how are things?' });
  });

  it('what is said for Rakesh is untouched: "Rakesh says: …" and passing a message on', async () => {
    const out = await generateDraft(new Scripted([json("Sure, I'll let Rakesh know! 😊")]), eyaInput('Please tell Rakesh to call me tonight'));
    expect(out).toMatchObject({ kind: 'draft', text: "Sure, I'll let Rakesh know! 😊" });
    expect(stripSelfIntro('Rakesh says: I will call you tonight')).toBe('Rakesh says: I will call you tonight');
  });
});

describe('through the live chat controller (mock chat, mock model)', () => {
  function switched() {
    const sw = new FakeSwitch();
    sw.on = true;
    return rig({ enable: sw.control });
  }

  it('the first message that goes out is a hello, even when the model wrote an introduction; a later "who are you?" gets the honest answer', async () => {
    const r = switched();
    r.ai.say("Hi, I'm Eya, Rakesh's assistant. How are you today?").say("I'm Eya, Rakesh's AI assistant. I chat here for him 😊 How is your day?");
    await r.controller.start('Rahul', undefined, 'she is my close friend, make her happy');
    await settle(40);
    expect(r.chat.pressed).toEqual(['Hi! How are you today?']);
    expect(r.chat.pressed.join(' ')).not.toMatch(/Eya|assistant/i);
    r.chat.incoming('wait, who are you?');
    r.chat.changed();
    await settle(40);
    r.advance(12_000);
    await settle(40);
    expect(r.chat.pressed.at(-1)).toBe("I'm Eya, Rakesh's AI assistant. I chat here for him 😊 How is your day?");
    expect(r.ai.requests.at(-1)).toMatch(/They are asking who you are/);
    expect(r.controller.state).toBe('ACTIVE');
  });

  it('with no model answer at all, the first message that goes out is still only a hello', async () => {
    const r = switched();
    r.ai.small = true; // (the plain hello goes only after a small model's unusable answer; a strong model's is handed back as before)
    r.ai.raw('not json at all').raw('not json at all');
    await r.controller.start('Rahul');
    await settle(40);
    expect(r.chat.pressed).toEqual(['Hi! 😊 How are you doing today?']);
  });

  it('the words said to the person about it are about the first message, not about introducing herself', async () => {
    const r = switched();
    r.ai.say('Hi! 😊 How are you doing?');
    await r.controller.start('Rahul');
    await settle(40);
    const said = JSON.stringify(r.controller.view());
    expect(said).not.toMatch(/introducing myself|introduces herself/i);
  });
});
