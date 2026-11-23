import { afterEach, describe, expect, it } from 'vitest';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { chatSystemPrompt } from '../src/main/agent/agentMode';
import { loadCustomSlang, MAX_CUSTOM } from '../src/main/agent/persona/customSlang';
import { LOCAL_PERSONA, agentPersona, chatPersona, lexicon, localStyleHint, personaFor, voicePersona } from '../src/main/agent/persona/persona';
import { forSpeech } from '../src/main/agent/persona/speech';
import { BUILT_IN_SLANG, allSlang, patternOf, readSlangEntry, setCustomSlang, slangIn } from '../src/main/agent/persona/slangLibrary';
import type { Tone } from '../src/main/agent/persona/slangLibrary';
import { TONE_LINE, detectTone, recentUse, slangPlan, toneOf } from '../src/main/agent/persona/tone';
import type { Line } from '../src/main/agent/persona/tone';
import { liveSystemPrompt, systemPrompt } from '../src/main/agent/prompts';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { ConversationContext } from '../src/main/context/ConversationContext';
import { LOCAL_SYSTEM, compactForLocal } from '../src/main/providers/ai/localPrompt';
import type { AIChatMessage, AICompletion, AIProvider, AIToolSpec } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import type { AgentRequest } from '../src/shared/types';

/**
 * Eya as a Gen-Z best friend: the vocabulary is a table, the mood is read from the person's words, the amount of slang is decided in code (none in a serious, technical or confused moment, none right
 * after she used some, never what she said lately), and every place she talks (chat, voice, agent, the small local model) gets the same personality fitted to it.
 */

afterEach(() => setCustomSlang([]));

const now = new Date('2026-11-22T10:00:00Z');
const u = (text: string): Line => ({ who: 'user', text });
const e = (text: string): Line => ({ who: 'eya', text });
const EMOJI = /\p{Extended_Pictographic}/u;

describe('the vocabulary library', () => {
  const asked = [
    'bro', 'bruh', 'bestie', 'pookie', 'twin', 'dawg', 'fam', 'no cap', 'bet', 'facts', 'fr', 'lowkey', 'highkey', 'sus', 'cringe', 'fire', 'slay', 'lit', 'mid', 'cooked', 'ate', 'bussin', 'delulu', 'rizz',
    'let him cook', "it's giving", "i'm dead", 'be so for real', "it's not that deep", 'main character energy', 'touch grass', 'standing on business', 'rent free', "you're so real for that", 'we are so back', "i'm locked in",
  ];

  it('has every expression that was asked for, each with the six things that were asked (expression, meaning, context, example, formality, whether it suits serious talk)', () => {
    const have = BUILT_IN_SLANG.map((s) => s.expression);
    for (const x of asked) expect(have, x).toContain(x);
    for (const s of BUILT_IN_SLANG) {
      expect(s.expression.length, s.expression).toBeGreaterThan(0);
      expect(s.meaning.length, s.expression).toBeGreaterThan(5);
      expect(s.context.length, s.expression).toBeGreaterThan(5);
      expect(s.example.length, s.expression).toBeGreaterThan(5);
      expect(['very-casual', 'casual', 'light'], s.expression).toContain(s.formality);
      expect(typeof s.seriousOk).toBe('boolean');
      expect(s.tones.length, s.expression).toBeGreaterThan(0);
    }
  });

  it('has no expression twice', () => {
    const names = BUILT_IN_SLANG.map((s) => s.expression.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('only the gentle ones may be used when the person is feeling low (pookie, "you\'re so real for that")', () => {
    expect(BUILT_IN_SLANG.filter((s) => s.seriousOk).map((s) => s.expression).sort()).toEqual(['pookie', "you're so real for that"]);
  });

  it('finds an expression as a whole word or phrase, not inside another word', () => {
    expect(patternOf('ate').test('you ate that')).toBe(true);
    expect(patternOf('ate').test('it is late and I am a bit irritated')).toBe(false);
    expect(patternOf('lit').test('literally nothing')).toBe(false);
    expect(patternOf("it's giving").test('Its giving Monday')).toBe(true);
    expect(patternOf('no cap').test('NO CAP, that is good')).toBe(true);
    expect(patternOf('fr').test('fr though')).toBe(true);
    expect(patternOf('fr').test('from France')).toBe(false);
    expect(slangIn('bro that was lowkey fire').map((s) => s.expression).sort()).toEqual(['bro', 'fire', 'lowkey']);
  });

  it('explains what each one means, so that she understands it whoever says it', () => {
    const text = lexicon();
    expect(text).toContain('no cap = no lie, honestly');
    expect(text).toContain('touch grass = go outside, step away from the screen');
    expect(text).toContain("it's giving = it has the vibe of...");
    expect(text).toContain('cooked = in trouble, doomed, or completely worn out');
  });
});

describe("the person's own slang file", () => {
  const good = { expression: 'no stress', meaning: 'it is fine, relax', context: 'someone is worried about something small', example: 'No stress, I have got it.', formality: 'light', tones: ['mistake', 'casual'] };

  it('adds their expressions, which she then understands and may use', () => {
    const n = loadCustomSlang('slang.json', () => JSON.stringify([good]));
    expect(n).toBe(1);
    expect(allSlang().some((s) => s.expression === 'no stress')).toBe(true);
    expect(lexicon()).toContain('no stress = it is fine, relax');
    expect(slangPlan('mistake', 'oops', []).ideas.length).toBeGreaterThan(0);
  });

  it('a file shaped as { "entries": [...] } works too, and an entry with the same expression replaces the built-in one', () => {
    const n = loadCustomSlang('slang.json', () => JSON.stringify({ entries: [{ ...good, expression: 'Bet', meaning: 'yes, deal' }] }));
    expect(n).toBe(1);
    expect(allSlang().filter((s) => s.expression.toLowerCase() === 'bet')).toHaveLength(1);
    expect(allSlang().find((s) => s.expression === 'Bet')?.meaning).toBe('yes, deal');
  });

  it('a missing or broken file changes nothing; an incomplete entry is skipped', () => {
    expect(loadCustomSlang('missing.json', () => {
      throw Object.assign(new Error('no file'), { code: 'ENOENT' });
    })).toBe(0);
    expect(loadCustomSlang('bad.json', () => '{ not json')).toBe(0);
    expect(allSlang()).toBe(BUILT_IN_SLANG);
    expect(loadCustomSlang('x.json', () => JSON.stringify([good, { expression: 'half' }, 42, null]))).toBe(1);
  });

  it('keeps at most sixty, and an unknown mood or kind falls back to plain defaults', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...good, expression: `word${i}` }));
    expect(loadCustomSlang('x.json', () => JSON.stringify(many))).toBe(MAX_CUSTOM);
    const entry = readSlangEntry({ ...good, tones: ['nonsense'], kind: 'weird', formality: 'odd' });
    expect(entry).toMatchObject({ tones: ['any'], kind: 'reaction', formality: 'casual', seriousOk: false });
  });
});

interface Scenario {
  readonly name: string;
  readonly say: string;
  readonly history?: readonly Line[];
  readonly tone: Tone;
  /** How many expressions the reply may use. */
  readonly slang: 0 | 1;
  readonly emoji: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  { name: 'a greeting', say: 'Hi.', tone: 'greeting', slang: 1, emoji: true },
  { name: 'a greeting with her name', say: 'hey eya', tone: 'greeting', slang: 1, emoji: true },
  { name: 'exhaustion', say: "I'm completely exhausted.", tone: 'tired', slang: 1, emoji: true },
  { name: 'a mistake', say: 'I made a mistake.', tone: 'mistake', slang: 1, emoji: true },
  { name: 'finishing something', say: 'I completed my project.', tone: 'happy', slang: 1, emoji: true },
  { name: 'finishing a petition (work is happy news too)', say: 'I just finished my petition draft', tone: 'happy', slang: 1, emoji: true },
  { name: 'thanks', say: 'Thank you.', tone: 'thanks', slang: 1, emoji: true },
  { name: 'boredom', say: "I'm bored.", tone: 'bored', slang: 1, emoji: true },
  { name: 'a joke', say: "lol that's so funny 💀", tone: 'joke', slang: 1, emoji: true },
  { name: 'plain small talk', say: 'what are we doing this evening', tone: 'casual', slang: 1, emoji: true },
  { name: 'feeling misunderstood', say: 'Nobody understands me.', tone: 'support', slang: 0, emoji: false },
  { name: 'feeling lonely', say: 'I feel so lonely lately', tone: 'support', slang: 0, emoji: false },
  { name: 'a loss', say: 'My father passed away last week.', tone: 'serious', slang: 0, emoji: false },
  { name: 'a hospital', say: 'My mother is in the hospital and I am scared.', tone: 'serious', slang: 0, emoji: false },
  { name: 'a technical question', say: 'How do I install Python on Windows?', tone: 'technical', slang: 0, emoji: false },
  { name: 'a legal question (he is an advocate)', say: 'Explain the difference between bail and anticipatory bail', tone: 'technical', slang: 0, emoji: false },
  { name: 'a plain factual question', say: "What's the capital of France?", tone: 'technical', slang: 0, emoji: false },
  { name: 'being confused', say: "I don't get this error message", tone: 'confused', slang: 0, emoji: false },
  { name: 'after something serious, an "ok thanks" is not a cue to joke', say: 'ok thanks', history: [u('My mother is in the hospital'), e('I am so sorry. I am here.')], tone: 'serious', slang: 0, emoji: false },
  { name: 'after feeling low, a laugh lightens the mood again', say: 'haha ok that actually helped 😂', history: [u('Nobody understands me.'), e("Hey, I'm listening.")], tone: 'joke', slang: 1, emoji: true },
  { name: 'the person uses slang themselves, so she may answer in kind', say: 'Bro that movie was lowkey fire', history: [u('hi'), e('Yooo, no cap, what is the vibe?')], tone: 'casual', slang: 1, emoji: true },
];

describe('twenty-one conversations: she reads the room, and decides how much slang there is', () => {
  for (const s of SCENARIOS) {
    it(`${s.name}: "${s.say.slice(0, 40)}" is read as ${s.tone}, with ${s.slang === 0 ? 'no slang' : 'at most one expression'}${s.emoji ? '' : ' and no emoji'}`, () => {
      const tone = detectTone(s.say, s.history ?? []);
      expect(tone).toBe(s.tone);
      const plan = slangPlan(tone, s.say, s.history ?? []);
      expect(plan.budget).toBe(s.slang);
      expect(plan.emoji).toBe(s.emoji && !(s.history ?? []).some((l) => l.who === 'eya' && EMOJI.test(l.text)));
      const prompt = chatPersona({ text: s.say, history: s.history ?? [] });
      expect(prompt).toContain(`Right now: ${TONE_LINE[tone]}`);
      expect(prompt).toContain(s.slang === 0 ? 'Slang: none in this reply' : 'Slang: at most one expression');
      if (s.slang === 0) {
        expect(plan.ideas.filter(() => tone !== 'support')).toEqual([]);
        expect(prompt).not.toContain('Ideas that would fit');
        // (when she is gentle with someone who is low, a pet name is the only thing she may reach for)
        if (tone === 'support') for (const idea of plan.ideas) expect(BUILT_IN_SLANG.find((b) => b.expression === idea)?.seriousOk, idea).toBe(true);
      }
    });
  }

  it('a serious moment gets no jokes, no slang, no pet names, no emoji, and no examples of the casual vibe', () => {
    const prompt = chatPersona({ text: 'My father passed away last week.' });
    expect(prompt).toContain('no jokes, no slang, no pet names, no emoji');
    expect(prompt).toContain('Emoji: none in this reply');
    expect(prompt).not.toContain('Brooo, you\'re cooked');
    expect(prompt).not.toContain('Yooo!');
  });

  it('a person who feels misunderstood gets her listening: no jokes, one gentle pet name at most, and the one example that fits', () => {
    const prompt = chatPersona({ text: 'Nobody understands me.' });
    expect(prompt).toContain('no jokes');
    expect(prompt).toContain('one gentle pet name at most');
    expect(prompt).toContain("Hey, I'm listening. Tell me what's going on, pookie.");
    expect(prompt).not.toContain("you're cooked");
  });

  it('a technical question gets the answer first, in simple friendly words, with no slang examples', () => {
    const prompt = chatPersona({ text: 'How do I install Python on Windows?' });
    expect(prompt).toContain('the clear, simple, accurate answer first');
    expect(prompt).not.toContain('The vibe (examples only');
  });

  it('a casual moment gets the best-friend examples, the meanings, and a fresh idea or two', () => {
    const prompt = chatPersona({ text: "I'm completely exhausted." });
    expect(prompt).toContain('The vibe (examples only');
    expect(prompt).toContain("Brooo, you're cooked 😭 Go recharge.");
    expect(prompt).toContain('Slang you understand:');
    expect(prompt).toMatch(/Ideas that would fit, if you want one: \w/);
  });
});

describe('she does not repeat herself', () => {
  it('what she said lately is not offered again, and the model is told not to reuse it', () => {
    const history = [u('hi'), e('Yooo bro, no cap, what is the vibe?'), u('nothing much'), e('Facts. Lowkey a slow day.')];
    const recent = recentUse(history);
    expect([...recent.expressions].sort()).toEqual(['bro', 'facts', 'lowkey', 'no cap']);
    const plan = slangPlan('casual', 'what should we do', history);
    expect(plan.avoid.slice().sort()).toEqual(['bro', 'facts', 'lowkey', 'no cap']);
    for (const idea of plan.ideas) expect(plan.avoid).not.toContain(idea);
    const prompt = chatPersona({ text: 'what should we do', history });
    expect(prompt).toContain('Do not repeat what you said lately: ');
    expect(prompt).toContain('bro');
  });

  it('after a reply with slang, the next has none (so it is every other reply at most, like a real friend) unless the person is using slang themselves', () => {
    const history = [u('hi'), e('Yooo bro, what is the vibe?')];
    expect(slangPlan('casual', 'nothing much, just working', history).budget).toBe(0);
    // (a reply with no word from the table is not "slang": the next may have one)
    expect(slangPlan('casual', 'nothing much, just working', [u('hi'), e('Yooo, what is the vibe?')]).budget).toBe(1);
    expect(slangPlan('casual', 'nothing much, just working', history).why).toContain('none this time');
    expect(slangPlan('casual', 'nothing much, bro, just lowkey working', history).budget).toBe(1);
    expect(slangPlan('casual', 'nothing much, just working', [u('hi'), e('Hello! Good to see you.')]).budget).toBe(1);
  });

  it('emoji are not used in two replies in a row', () => {
    expect(slangPlan('happy', 'I did it', [u('hi'), e('Nice one 🔥')]).emoji).toBe(false);
    expect(slangPlan('happy', 'I did it', [u('hi'), e('Nice one')]).emoji).toBe(true);
  });

  it('the ideas fit the mood: a tired person is not offered a word for a win, and someone who is low is only offered gentle ones', () => {
    const tired = slangPlan('tired', "I'm exhausted", []).ideas;
    expect(tired.length).toBeGreaterThan(0);
    for (const idea of tired) {
      const entry = BUILT_IN_SLANG.find((b) => b.expression === idea);
      expect(entry?.tones.includes('tired') || entry?.tones.includes('any'), idea).toBe(true);
    }
    expect(tired).not.toContain('ate');
    expect(tired).not.toContain('slay');
  });

  it('the ideas change from one message to the next, and are the same for the same message (no randomness)', () => {
    const a = slangPlan('casual', 'what are we doing today', []).ideas;
    expect(slangPlan('casual', 'what are we doing today', []).ideas).toEqual(a);
    const different = new Set(['what are we doing today', 'any plans for tonight', 'tell me something fun', 'my cat is being weird', 'it is raining again'].map((t) => slangPlan('casual', t, []).ideas.join(',')));
    expect(different.size).toBeGreaterThan(2);
  });

  it('a twelve-message conversation: slang never in two replies in a row, never the same expression within three replies, never two emoji in a row, and a spread of words', () => {
    const turns = ['hi', 'nothing much', 'what should I have for dinner', 'my cat is being weird again', 'it is raining here', 'I need a break', 'what are you up to', 'tell me something fun', 'ok that is funny', 'I am going out soon', 'any music for the road', 'see you later'];
    const history: Line[] = [];
    const used: string[][] = [];
    const emojis: boolean[] = [];
    for (const say of turns) {
      const tone = detectTone(say, history);
      const plan = slangPlan(tone, say, history);
      // (a stand-in for the model: it follows the plan, taking the first idea and an emoji when it may)
      const word = plan.budget === 1 ? plan.ideas[0] : undefined;
      const reply = `${word !== undefined ? `${word.charAt(0).toUpperCase()}${word.slice(1)}. ` : ''}Okay, noted.${plan.emoji ? ' 😂' : ''}`;
      history.push(u(say), e(reply));
      used.push(slangIn(reply).map((s) => s.expression));
      emojis.push(EMOJI.test(reply));
    }
    for (let i = 1; i < used.length; i += 1) {
      if ((used[i]?.length ?? 0) > 0) expect(used[i - 1]?.length ?? 0, `replies ${i - 1} and ${i} both had slang`).toBe(0);
      if (emojis[i]) expect(emojis[i - 1], `replies ${i - 1} and ${i} both had an emoji`).toBe(false);
    }
    for (let i = 0; i < used.length; i += 1) for (const x of used[i] ?? []) for (let k = Math.max(0, i - 3); k < i; k += 1) expect(used[k], `"${x}" repeated within three replies`).not.toContain(x);
    const all = used.flat();
    expect(new Set(all).size).toBeGreaterThanOrEqual(3);
    expect(used.filter((x) => x.length > 0).length).toBeLessThanOrEqual(6);
  });
});

describe('when a heavy moment lifts', () => {
  const heavy = [u('My father passed away last week.'), e('I am so sorry. I am here.'), u('ok thanks'), e('Anytime.')];

  it('it stays heavy for a short while, even for a short or neutral message', () => {
    expect(detectTone('ok', heavy)).toBe('serious');
    expect(detectTone('what should I do now', heavy)).toBe('serious');
  });

  it('it lifts when they laugh, share good news, greet, or use slang of their own (two words of it)', () => {
    expect(detectTone('haha', heavy)).toBe('joke');
    expect(detectTone('I finally finished it', heavy)).toBe('happy');
    expect(detectTone('hey eya', heavy)).toBe('greeting');
    expect(detectTone('Bro that movie was lowkey fire', heavy)).toBe('casual');
  });

  it('one slang word in a sad message does not lift it, and a later calm message, two messages on, is read for itself', () => {
    expect(detectTone('bro I just cannot believe it', heavy)).toBe('serious');
    const later = [...heavy, u('what is on TV'), e('Nothing much.'), u('ok'), e('Okay.')];
    expect(detectTone('what is on TV tonight', later)).not.toBe('serious');
  });
});

describe('found on the real local model: an old sad message must not follow someone who has already laughed', () => {
  it('"how do I install Python" after "I feel so lonely" and then "haha ok that helped" is a technical question, not a low moment', () => {
    const history = [u('I feel so lonely lately'), e("I'm here if you need someone to talk to."), u('haha ok that actually helped 😂'), e("It's always good to laugh sometimes.")];
    expect(detectTone('How do I install Python on Windows?', history)).toBe('technical');
    // and without the laugh in between, the low moment still holds
    expect(detectTone('How do I install Python on Windows?', [u('I feel so lonely lately'), e('I am here.'), u('I do not know'), e('Okay.')])).toBe('support');
  });
});

describe('what is shown is not always what is said', () => {
  it('the emoji are left out of what is spoken, and nothing else changes', () => {
    expect(forSpeech("Brooo, you're cooked 😭 Go recharge.")).toBe("Brooo, you're cooked Go recharge.");
    expect(forSpeech('Anytime, pookie 🤝')).toBe('Anytime, pookie');
    expect(forSpeech('WAITTT, you actually ate 🔥 Proud of you!')).toBe('WAITTT, you actually ate Proud of you!');
    expect(forSpeech('Nice 👍🏽 one!')).toBe('Nice one!');
    expect(forSpeech('😂💀')).toBe('');
    expect(forSpeech('Plain words, nothing to remove.')).toBe('Plain words, nothing to remove.');
    expect(forSpeech('Hindi: नमस्ते and Telugu: తెలుగు stay')).toBe('Hindi: नमस्ते and Telugu: తెలుగు stay');
  });

  it('through the engine: the chat shows the emoji, the voice says the words', async () => {
    const spoken: string[] = [];
    const tts: TTSProvider = { ...quietTTS, speak: async (t: string) => void spoken.push(t) };
    const ai = new Recording([{ text: "Anytime, pookie 🤝", toolCalls: [] }]);
    const e2 = new AgentEngine({ router: new IntentRouter(), tools: new ToolRegistry(), composer: new ResponseComposer(), tts, context: new ConversationContext(), ai, now: () => now });
    const r = await e2.handle({ requestId: 'r1', text: 'Thank you.', source: 'text', mode: 'chat' } as AgentRequest, () => undefined);
    await new Promise((res) => setTimeout(res, 20));
    expect(r.spoken).toBe('Anytime, pookie 🤝');
    expect(spoken).toEqual(['Anytime, pookie']);
  });
});

describe('the small local model gets one example of the style, only when it is due', () => {
  it('a greeting, tiredness, a mistake, good news, thanks and boredom each get an example in new-words-please form', () => {
    expect(localStyleHint('Hi.', [])).toBe('Reply in this style, in new words and short: "Yooo! What\'s the vibe today?"');
    expect(localStyleHint("I'm completely exhausted.", [])).toContain("Brooo, you're cooked. Go recharge.");
    expect(localStyleHint('I made a mistake.', [])).toContain('Bestie, what did we do this time?');
    expect(localStyleHint('I completed my project.', [])).toContain('you actually ate');
    expect(localStyleHint('Thank you.', [])).toContain('Anytime, pookie.');
    expect(localStyleHint("I'm bored.", [])).toContain('plot twist');
  });

  it('a serious, technical or confused moment gets "clear and kind, no slang"; someone who is low gets gentleness', () => {
    for (const say of ['My father passed away last week.', 'How do I install Python on Windows?', "I don't get this error message"]) expect(localStyleHint(say, []), say).toContain('no slang, no jokes');
    expect(localStyleHint('Nobody understands me.', [])).toContain('reply gently');
    expect(localStyleHint('Nobody understands me.', [])).not.toContain('Reply in this style');
  });

  it('nothing is added right after she used slang, or when the example is built from words she used lately', () => {
    expect(localStyleHint('Thank you.', [u('hi'), e('Yooo bro, what is up?')])).toBe('');
    expect(localStyleHint("I'm exhausted.", [u('hi'), e('Hello! Good to see you.'), u('I did a lot'), e('That is cooked, honestly.')])).toBe('');
    // (a reply with no word from the table does not count)
    expect(localStyleHint('Thank you.', [u('hi'), e('Hello! Good to see you.')])).toContain('Anytime, pookie.');
  });

  it('it is in the instruction the local model gets, small, and not while a tool is being used', () => {
    const casual = compactForLocal([{ role: 'user', content: 'Hi.' }], []);
    const plain = compactForLocal([{ role: 'user', content: 'what is two plus two' }], []);
    expect(casual.messages[0]?.content).toContain('Yooo! What\'s the vibe today?');
    expect((casual.messages[0]?.content.length ?? 0) - (plain.messages[0]?.content.length ?? 0)).toBeLessThan(120);
    const task = compactForLocal([{ role: 'user', content: 'open notepad' }], [{ name: 'open_application', description: 'open', parameters: {} }]);
    expect(task.messages[0]?.content).not.toContain('Reply in this style');
  });
});

describe('the mood of a single message', () => {
  const cases: Array<[string, Tone]> = [
    ['Hi', 'greeting'], ['hello!', 'greeting'], ['good morning', 'greeting'], ["what's up", 'greeting'], ['how are you', 'greeting'],
    ['thanks', 'thanks'], ['thank you so much', 'thanks'],
    ['I am so tired', 'tired'], ['I made a mistake', 'mistake'], ['oops my bad', 'mistake'],
    ['it worked!', 'happy'], ['I passed the exam', 'happy'], ['finally done with the draft', 'happy'],
    ['I am bored', 'bored'], ['I am confused', 'confused'], ['haha that is funny', 'joke'],
    ['I feel hopeless', 'support'], ['I am so stressed out', 'support'], ['I give up', 'support'],
    ['my grandfather died yesterday', 'serious'], ['I was in an accident', 'serious'], ['she is being harassed at work', 'serious'],
    ['what is the section for cheating in the BNS', 'technical'], ['how to write a regex for an email', 'technical'],
    ['okay then', 'casual'], ['', 'casual'],
  ];
  for (const [text, tone] of cases) {
    it(`"${text}" is ${tone}`, () => {
      expect(toneOf(text)).toBe(tone);
    });
  }
});

describe('each place she talks gets the personality, fitted to it', () => {
  it('every channel says she is an AI that does not pretend to have human feelings or experiences', () => {
    for (const channel of ['chat', 'voice', 'agent', 'local'] as const) expect(personaFor(channel, { text: 'hi' }), channel).toMatch(/feelings/);
  });

  it('chat: a best friend who reads the room, with the old rules about Agent mode, the web and files intact', () => {
    const prompt = chatSystemPrompt(now, { text: 'Hi.' });
    expect(prompt).toMatch(/plain chat mode/);
    expect(prompt).toMatch(/do NOT control the computer or a browser/);
    expect(prompt).toMatch(/Agent button beside the message box/);
    expect(prompt).toMatch(/web_search/);
    expect(prompt).toMatch(/analyze_document/);
    expect(prompt).toContain('smart, funny, Gen-Z best friend');
    expect(prompt).toContain('Not a formal chatbot, not a slang dictionary');
    expect(prompt).toContain('never in every sentence, never forced (bro, bestie and pookie are not punctuation)');
    expect(prompt).not.toMatch(/no emoji\./);
  });

  it('voice: everything is spoken, so no emoji anywhere, and she laughs in words; the live prompt keeps its tool rules', () => {
    const voice = voicePersona();
    expect(voice).toContain('spoken aloud');
    expect(voice).toContain('"haha"');
    expect(EMOJI.test(voice)).toBe(false);
    expect(voice).toContain("Anytime, pookie");
    const live = liveSystemPrompt(now);
    expect(live).toContain(voice);
    expect(live).toMatch(/LIVE CHAT: whenever the user asks for a live chat/);
    expect(live).toMatch(/call quick_command FIRST/);
    expect(live.endsWith(voice)).toBe(true);
  });

  it('agent: action first, one short clear confirmation, a touch of personality, and it stays small because it goes with every step', () => {
    const agent = agentPersona();
    expect(agent).toContain('action-first');
    expect(agent).toContain('one short clear confirmation');
    expect(agent.length).toBeLessThan(300);
    expect(systemPrompt(now)).toContain(agent);
  });

  it('the small local model gets one short sentence (it reads about forty words a second), and still starts with the same instruction', () => {
    expect(LOCAL_PERSONA.split(/\s+/).length).toBeLessThan(30);
    expect(LOCAL_SYSTEM).toContain(LOCAL_PERSONA);
    const local = compactForLocal([{ role: 'system', content: 'long cloud prompt' }, { role: 'user', content: 'hi' }], []);
    expect(local.messages[0]?.content.startsWith(LOCAL_SYSTEM)).toBe(true);
    expect(LOCAL_SYSTEM.length).toBeLessThan(650);
  });

  it('in Hindi or Telugu the same friendly character is kept in that language, without English slang or its table', () => {
    for (const language of ['hindi', 'telugu'] as const) {
      const prompt = chatPersona({ text: 'hi', language });
      expect(prompt).toContain('This slang is for when you speak English');
      expect(prompt).not.toContain('Slang you understand:');
    }
    expect(chatPersona({ text: 'hi', language: 'english' })).toContain('Slang you understand:');
    expect(chatPersona({ text: 'hi', language: 'auto' })).toContain('Slang you understand:');
  });
});

class Recording implements AIProvider {
  readonly name = 'recording';
  readonly systems: string[] = [];
  constructor(private readonly script: AICompletion[]) {}
  isReady(): boolean {
    return true;
  }
  async complete(messages: readonly AIChatMessage[], _tools: readonly AIToolSpec[]): Promise<AICompletion> {
    this.systems.push(String(messages[0]?.content ?? ''));
    const next = this.script.shift();
    if (next === undefined) throw new Error('script exhausted');
    return next;
  }
}
const quietTTS: TTSProvider = { name: 'quiet', init: async () => undefined, speak: async () => undefined, prefetch: () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };

describe('through the real chat engine', () => {
  const engine = (replies: string[]) => {
    const ai = new Recording(replies.map((text) => ({ text, toolCalls: [] })));
    const e2 = new AgentEngine({ router: new IntentRouter(), tools: new ToolRegistry(), composer: new ResponseComposer(), tts: quietTTS, context: new ConversationContext(), ai, now: () => now });
    const send = (text: string, history: Array<{ who: 'user' | 'eya'; text: string }> = []) => e2.handle({ requestId: `r${Math.random().toString(36).slice(2, 6)}`, text, source: 'text', mode: 'chat', history } as AgentRequest, () => undefined);
    return { ai, send };
  };

  it('the instruction sent to the AI is fitted to this message: a greeting is a greeting, a loss is a loss', async () => {
    const { ai, send } = engine(['Yooo! What is the vibe today?', 'I am so sorry. I am here.']);
    await send('Hi.');
    await send('My father passed away last week.');
    expect(ai.systems[0]).toContain(`Right now: ${TONE_LINE.greeting}`);
    expect(ai.systems[1]).toContain(`Right now: ${TONE_LINE.serious}`);
    expect(ai.systems[1]).toContain('Emoji: none in this reply');
  });

  it('what she said in the conversation so far is carried into the instruction: she is told not to reuse it', async () => {
    const { ai, send } = engine(['Anytime.']);
    await send('Thank you.', [{ who: 'user', text: 'hi' }, { who: 'eya', text: 'Yooo bro, what is the vibe?' }]);
    expect(ai.systems[0]).toContain('Do not repeat what you said lately: bro.');
    expect(ai.systems[0]).toContain('Slang: none in this reply');
  });

  it('everything else about chat is as before: an everyday command still gets the Agent-mode hint, not an AI answer', async () => {
    const { ai, send } = engine([]);
    const r = await send('open youtube');
    expect(r.ok).toBe(true);
    expect(r.suggestAgent).toBe(true);
    expect(ai.systems).toEqual([]);
  });
});
