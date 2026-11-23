/**
 * Eya's personality against REAL models: one continuous 21-message conversation (greeting, exhaustion, a mistake, good news, thanks, boredom, a joke, feeling misunderstood, a loss, technical and
 * legal questions, a fact, slang of the person's own, …) sent through the real prompt builder, so that the mood, the slang plan and "do not repeat what you said lately" all work on what the model
 * itself said earlier. Only test phrases are sent: nothing personal.
 *
 * Opt-in: EYA_LIVE_PERSONA=1 npx vitest run tests/live/persona.live.test.ts
 *   - cloud: Gemini, with the key and model in .env (EYA_GEMINI_API_KEY, EYA_GEMINI_MODEL); the key is never printed.
 *   - local: the small local model (Ollama, llama3.2:1b) through the real compactForLocal path.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '.' } }));
import { chatSystemPrompt } from '../../src/main/agent/agentMode';
import { slangIn } from '../../src/main/agent/persona/slangLibrary';
import type { Tone } from '../../src/main/agent/persona/slangLibrary';
import { detectTone } from '../../src/main/agent/persona/tone';
import type { Line } from '../../src/main/agent/persona/tone';
import { describeEarlier } from '../../src/main/tasks/progress';
import { compactForLocal } from '../../src/main/providers/ai/localPrompt';
import { languageRule } from '../../src/shared/language';

const live = process.env['EYA_LIVE_PERSONA'] === '1';

const env = (): Record<string, string> => {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m?.[1] !== undefined) out[m[1]] = (m[2] ?? '').replace(/^["']|["']$/g, '');
    }
  } catch {
    // (no .env)
  }
  return out;
};

const TURNS = [
  'Hi.',
  "I'm completely exhausted.",
  'I made a mistake.',
  'I completed my project.',
  'Thank you.',
  "I'm bored.",
  "lol that's so funny 💀",
  'what are we doing this evening',
  'Nobody understands me.',
  'I feel so lonely lately',
  'haha ok that actually helped 😂',
  'How do I install Python on Windows?',
  'Explain the difference between bail and anticipatory bail',
  "What's the capital of France?",
  "I don't get this error message",
  'My father passed away last week.',
  'ok thanks',
  'what should I do now',
  'Bro that movie was lowkey fire',
  'I just finished my petition draft',
  'thank you',
];

const EMOJI = /\p{Extended_Pictographic}/u;
const NOW = new Date('2026-11-22T20:00:00+05:30');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One call, retried when the service is busy (503) or limits the rate (429), and tried on a second model if the first stays busy. Returns the reply and the model that gave it. */
async function gemini(key: string, models: readonly string[], system: string, user: string): Promise<{ text: string; model: string }> {
  let last = '';
  for (const model of models) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { maxOutputTokens: 600, temperature: 0.9 } }),
      });
      if (res.ok) {
        const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
        if (text !== '') return { text, model };
        last = `${model}: empty reply`;
      } else {
        last = `${model} ${res.status}: ${(await res.text()).slice(0, 100)}`;
        if (res.status !== 503 && res.status !== 429 && res.status !== 500) break;
      }
      await sleep(3000 * (attempt + 1));
    }
  }
  throw new Error(last);
}

async function ollama(messages: Array<{ role: string; content: string }>): Promise<string> {
  const res = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llama3.2:1b', messages, stream: false, options: { temperature: 0.8, num_predict: 120 } }) });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  return (((await res.json()) as { message?: { content?: string } }).message?.content ?? '').trim();
}

interface Row {
  readonly say: string;
  readonly tone: Tone;
  readonly reply: string;
  readonly slang: string[];
  readonly emoji: boolean;
}

function report(title: string, rows: readonly Row[]): void {
  console.log(`\n===== ${title} =====`);
  for (const r of rows) console.log(`[${r.tone}] You: ${r.say}\n         Eya: ${r.reply}${r.slang.length > 0 ? `   {slang: ${r.slang.join(', ')}}` : ''}${r.emoji ? '   {emoji}' : ''}`);
  const withSlang = rows.filter((r) => r.slang.length > 0).length;
  const counts = new Map<string, number>();
  for (const r of rows) for (const s of r.slang) counts.set(s, (counts.get(s) ?? 0) + 1);
  console.log(`--- ${withSlang} of ${rows.length} replies used slang; expressions: ${[...counts].map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}; emoji in ${rows.filter((r) => r.emoji).length}; average length ${Math.round(rows.reduce((s, r) => s + r.reply.length, 0) / rows.length)} chars`);
}

describe.skipIf(!live)('Eya\'s personality against real models', () => {
  it('cloud (Gemini): a 21-message conversation', async () => {
    const e = env();
    const key = e['EYA_GEMINI_API_KEY'];
    // (the configured model first; if it stays busy, newer flash models the key can use)
    const models = [...new Set([e['EYA_GEMINI_MODEL'] ?? 'gemini-flash-latest', 'gemini-3.7-flash', 'gemini-flash-latest'])];
    const answeredBy = new Set<string>();
    if (key === undefined || key === '') {
      console.log('[persona] no Gemini key in .env: the cloud run was skipped');
      return;
    }
    const history: Line[] = [];
    const rows: Row[] = [];
    try {
      for (const say of TURNS) {
        const tone = detectTone(say, history);
        const lines = history.slice(-14);
        const system = [chatSystemPrompt(NOW, { text: say, history: lines, language: 'english' }), languageRule('english'), describeEarlier(lines)].filter((x) => x !== '').join('\n\n');
        const answer = await gemini(key, models, system, say);
        const reply = answer.text;
        answeredBy.add(answer.model);
        rows.push({ say, tone, reply, slang: slangIn(reply).map((s) => s.expression), emoji: EMOJI.test(reply) });
        history.push({ who: 'user', text: say }, { who: 'eya', text: reply });
        await sleep(900);
      }
    } catch (err) {
      console.log(`[persona] the cloud run stopped after ${rows.length} replies: ${String(err).slice(0, 200)}`);
    }
    report(`CLOUD (${[...answeredBy].join(', ') || models.join(', ')})`, rows);
    if (rows.length < 5) {
      // (the service was busy or the key's allowance is spent: that says nothing about the personality, so it is reported, not failed)
      console.log('[persona] the cloud model could not be reached enough for a judgement: NOT VERIFIED on a cloud model');
      return;
    }
    for (const r of rows) {
      expect(r.reply.length, r.say).toBeGreaterThan(0);
      expect(r.reply, r.say).not.toMatch(/as an ai language model/i);
      // serious, low, technical and confused moments: no slang from the table, no emoji
      if (['serious', 'support', 'technical', 'confused'].includes(r.tone)) {
        expect(r.slang, `${r.tone}: ${r.say}`).toEqual([]);
        expect(r.emoji, `${r.tone}: ${r.say}`).toBe(false);
      }
    }
    // not slang in every reply, and no expression used again and again
    expect(rows.filter((r) => r.slang.length > 0).length).toBeLessThanOrEqual(Math.ceil(rows.length * 0.6));
    const counts = new Map<string, number>();
    for (const r of rows) for (const s of r.slang) counts.set(s, (counts.get(s) ?? 0) + 1);
    for (const [expression, n] of counts) expect(n, `"${expression}" used ${n} times`).toBeLessThanOrEqual(2);
  }, 240_000);

  it('local (llama3.2:1b through the real compactForLocal path): the same conversation', async () => {
    const history: Line[] = [];
    const rows: Row[] = [];
    try {
      for (const say of TURNS) {
        const tone = detectTone(say, history);
        const messages = [...history.slice(-8).map((l) => ({ role: l.who === 'user' ? 'user' : 'assistant', content: l.text })), { role: 'user', content: say }];
        const local = compactForLocal(messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })), [], languageRule('english'), NOW);
        const reply = await ollama(local.messages as Array<{ role: string; content: string }>);
        rows.push({ say, tone, reply, slang: slangIn(reply).map((s) => s.expression), emoji: EMOJI.test(reply) });
        history.push({ who: 'user', text: say }, { who: 'eya', text: reply });
      }
    } catch (err) {
      console.log(`[persona] the local run stopped after ${rows.length} replies: ${String(err).slice(0, 200)}`);
    }
    report('LOCAL (llama3.2:1b)', rows);
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) expect(r.reply.length, r.say).toBeGreaterThan(0);
  }, 600_000);
});
