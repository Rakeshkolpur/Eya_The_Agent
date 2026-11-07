/**
 * Replays a REAL exported WhatsApp chat through Eya's drafting, with the real models — to see, on a conversation that actually happened, how she would answer now.
 *
 * Opt-in (the export is a person's private chat: it is read from a path given here and is never kept in the repository):
 *   EYA_REPLAY_CHAT="C:\path\WhatsApp Chat with …\chat.txt" EYA_REPLAY_MODEL=gemini,ollama EYA_REPLAY_FROM=79 npx vitest run tests/live/livechat.replay.live.test.ts
 *
 * Everything in the export up to line EYA_REPLAY_FROM is the conversation as it was. From that line on, what the OTHER person wrote is replayed one burst at a time and answered by
 * the model; what was typed by the account's owner himself in the same chat (EYA_REPLAY_TYPED, line numbers) is put back in as his; and the old assistant's replies are only printed,
 * for comparison — they are not part of the context the new replies are written from.
 * NOT covered: the real WhatsApp page, the real PDF (a plausible summary stands in for what the reader would have found), a second real person.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GeminiAIProvider } from '../../src/main/providers/ai/GeminiAIProvider';
import { OllamaAIProvider } from '../../src/main/providers/ai/OllamaAIProvider';
import { generateDraft, generateOpening } from '../../src/main/livechat/draft';
import type { DraftAI, DraftOutcome } from '../../src/main/livechat/draft';
import type { LiveChatMessage } from '../../src/main/browser/BrowserAutomationService';
import type { MediaNote } from '../../src/main/livechat/messages';

const FILE = process.env['EYA_REPLAY_CHAT'] ?? '';
const MODELS = (process.env['EYA_REPLAY_MODEL'] ?? 'gemini').split(',').map((s) => s.trim());
const FROM = Number(process.env['EYA_REPLAY_FROM'] ?? '0');
const TYPED = new Set((process.env['EYA_REPLAY_TYPED'] ?? '').split(',').filter(Boolean).map(Number));
const OWNER = process.env['EYA_REPLAY_OWNER'] ?? 'Rakesh';
const d = FILE !== '' && FROM > 0 ? describe : describe.skip;

interface Line {
  readonly n: number;
  readonly sender: string;
  text: string;
}

function parse(path: string): Line[] {
  const raw = readFileSync(path, 'utf8').split(/\r?\n/);
  const out: Line[] = [];
  raw.forEach((l, i) => {
    const m = /^(\d{2}\/\d{2}\/\d{2}), (\d{2}:\d{2}) - ([^:]+?): (.*)$/.exec(l);
    if (m !== null) out.push({ n: i + 1, sender: m[3] ?? '', text: m[4] ?? '' });
    else if (out.length > 0 && l.trim() !== '') (out[out.length - 1] as Line).text += `\n${l}`;
  });
  return out;
}

/** Loads the project's .env into the process (the key is never printed). */
function loadEnv(): void {
  try {
    for (const l of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l);
      if (m !== null && process.env[m[1] as string] === undefined) process.env[m[1] as string] = (m[2] as string).replace(/^["']|["']$/g, '');
    }
  } catch {
    // no .env: the provider will say it has no key
  }
}

const PASS_ON_ASK = /(anything|something) else[^.?!]*(tell|pass)|pass(?:ing)? (?:it |that |this )?on|anything[^.?!]*(?:tell|pass)[^.?!]*(?:him|rakesh)/i;

d('replaying a real chat through the new Eya', () => {
  for (const model of MODELS) {
    it(`${model}: answers the friend as a friend, not as a message-taker`, async () => {
      loadEnv();
      const provider = model === 'ollama' ? new OllamaAIProvider() : new GeminiAIProvider();
      const ai: DraftAI = { complete: (messages, tools, options) => provider.complete(messages, tools, options) };
      const lines = parse(FILE);
      const toMsg = (l: Line, dir: 'in' | 'out'): LiveChatMessage => {
        const sticker = /\(file attached\)$/.test(l.text) || /^<Media omitted>$/.test(l.text.split('\n')[0] ?? '');
        const isDoc = /\.pdf\s*$/i.test(l.text);
        return { id: `m${l.n}`, dir, kind: isDoc ? 'document' : sticker ? 'sticker' : 'text', text: isDoc ? l.text.split('\n').pop() ?? '' : sticker ? '' : l.text, at: '' };
      };
      const isOwner = (l: Line): boolean => l.sender === OWNER;
      // the conversation as it was, before the assistant joined
      const context: LiveChatMessage[] = lines.filter((l) => l.n < FROM).map((l) => toMsg(l, isOwner(l) ? 'out' : 'in'));
      const eyaSent: string[] = [];
      const media: Record<string, MediaNote> = {};
      const rows: string[] = [];
      const newReplies: string[] = [];

      // (each step is printed as soon as it is known: a model that runs out of allowance half-way — the free Gemini keys do — still shows what it did answer)
      const show = (s: string): void => {
        rows.push(s);
        // eslint-disable-next-line no-console
        console.log(`[${model}] ${s}`);
      };
      let stopped = '';

      // 1. the first message, written into a conversation in progress
      let opening: DraftOutcome | null = null;
      try {
        opening = await generateOpening(ai, { context, summary: '', tone: 'natural and brief', purpose: 'a friend of mine, be warm and make them happy', knows: true, ownerName: OWNER, asEya: true, eyaSentIds: eyaSent });
      } catch (err) {
        stopped = String(err).slice(0, 120);
      }
      if (opening !== null) {
        const openText = opening.kind === 'draft' ? opening.text : `(${opening.kind})`;
        show(`OPENING (after the real conversation up to line ${FROM - 1}):\n   NEW EYA: ${openText}`);
        newReplies.push(openText);
        context.push({ id: 'sim_open', dir: 'out', kind: 'text', text: openText, at: '' });
        eyaSent.push('sim_open');
      }

      // 2. the rest, one burst of the other person's messages at a time
      const rest = lines.filter((l) => l.n >= FROM);
      let i = 0;
      let step = 0;
      while (i < rest.length && stopped === '') {
        const l = rest[i] as Line;
        if (isOwner(l)) {
          if (TYPED.has(l.n)) {
            context.push({ id: `m${l.n}`, dir: 'out', kind: 'text', text: l.text, at: '' }); // typed by the owner himself, in the same chat
            show(`   (typed by ${OWNER} himself: ${l.text})`);
          } else {
            show(`   OLD EYA: ${l.text.replace(/\n/g, ' ')}`);
          }
          i += 1;
          continue;
        }
        const burst: LiveChatMessage[] = [];
        while (i < rest.length && !isOwner(rest[i] as Line)) {
          const m = toMsg(rest[i] as Line, 'in');
          burst.push(m);
          if (m.kind === 'document') media[m.id] = { kind: 'document', name: m.text, status: 'read', summary: 'A study guide about how software agents decide which tool to use.' };
          i += 1;
        }
        context.push(...burst);
        let out: DraftOutcome;
        try {
          out = await generateDraft(ai, { context, fresh: burst, summary: '', tone: 'natural and brief', knows: true, answerByItself: true, ownerName: OWNER, asEya: true, media, eyaSentIds: eyaSent });
        } catch (err) {
          stopped = String(err).slice(0, 120);
          break;
        }
        step += 1;
        const text = out.kind === 'draft' ? out.text : `(${out.kind}: ${'reason' in out ? out.reason : ''})`;
        show(`FRIEND: ${burst.map((b) => (b.kind === 'text' ? b.text : `[${b.kind}${b.kind === 'document' ? ` ${b.text}` : ''}]`)).join(' / ')}\n   NEW EYA: ${text}${out.kind === 'draft' && out.forOwner !== '' ? `   [note for ${OWNER}: ${out.forOwner}]` : ''}`);
        newReplies.push(text);
        if (out.kind === 'draft') {
          const id = `sim_${step}`;
          context.push({ id, dir: 'out', kind: 'text', text, at: '' });
          eyaSent.push(id);
        }
      }
      if (stopped !== '') {
        // eslint-disable-next-line no-console
        console.log(`[${model}] STOPPED: ${stopped}`);
      }

      // What must hold whatever the wording: a reply every time, no "I cannot open files", and she is not a message-taker.
      expect(newReplies.length).toBeGreaterThan(0);
      expect(newReplies.every((r) => !r.startsWith('('))).toBe(true);
      expect(newReplies.join(' ')).not.toMatch(/(can'?t|cannot|not able to|unable to) (open|view|read|access) (the |that |this )?(file|document|pdf)/i);
      const asks = newReplies.filter((r) => PASS_ON_ASK.test(r)).length;
      // eslint-disable-next-line no-console
      console.log(`${model}: ${asks} of ${newReplies.length} replies ask about passing something on (the real chat had ${'about 14 of 19'})`);
      expect(asks).toBeLessThanOrEqual(Math.ceil(newReplies.length * 0.25));
    }, 600_000);
  }
});
