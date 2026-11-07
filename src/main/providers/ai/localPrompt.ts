import { looksLikeAction } from '@main/tasks/pendingSignals';
import type { AIChatMessage, AIToolSpec } from './AIProvider';

/**
 * What the small local model is given. Eya's own instructions for the cloud AIs run to thousands of words (every ability, every rule), and
 * a 1B model on a laptop CPU reads about 40 words a second: that prompt alone would be a minute of silence. So the local model gets a short
 * instruction, the last few lines of the conversation, and — only when the person is asking for something to be done — a handful of the
 * safe everyday tools. Anything the model proposes still goes through Eya's own checked tools (and their "are you sure" questions): the model
 * never runs anything itself.
 */

/** The tools the local model may be offered: opening, finding and a few harmless settings. Nothing that deletes, sends, buys or shuts down. */
export const LOCAL_CORE_TOOLS: readonly string[] = [
  'open_application',
  'close_application',
  'open_website',
  'web_search',
  'find_file',
  'find_folder',
  'open_file',
  'open_folder',
  'create_folder',
  'set_volume',
  'mute_volume',
  'unmute_volume',
];

export const LOCAL_SYSTEM =
  "You are Eya, a friendly assistant on the user's Windows PC. Reply in plain text, in one to three short sentences unless asked for more, with no markdown or lists. " +
  "If you are not sure, say so briefly. You cannot see the screen or any file unless a tool gives it to you.";

const TOOL_LINE = ' When the user asks you to do something on the PC and a tool fits, call that tool; otherwise just answer.';

/** How much of the conversation before the current request goes in: the last few lines, each cut short. */
const MAX_HISTORY = 6;
const HISTORY_CHARS = 500;
const USER_CHARS = 1500;
const TOOL_RESULT_CHARS = 1200;
const TOOL_DESCRIPTION_CHARS = 110;
const PARAM_DESCRIPTION_CHARS = 70;

const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** A tool's schema with its long descriptions cut: the model only needs to know what to call and with what. */
function shrinkSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shrinkSchema);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === 'description' && typeof v === 'string' ? clip(v, PARAM_DESCRIPTION_CHARS) : shrinkSchema(v);
    }
    return out;
  }
  return value;
}

export function shrinkTool(tool: AIToolSpec): AIToolSpec {
  return { name: tool.name, description: clip(tool.description, TOOL_DESCRIPTION_CHARS), parameters: shrinkSchema(tool.parameters) };
}

export interface LocalPrompt {
  readonly messages: AIChatMessage[];
  readonly tools: AIToolSpec[];
}

/**
 * The messages and tools to send to the local model, made from what Eya built for the cloud AIs: the long system text is replaced, earlier
 * conversation is kept short, and tools are limited to the safe everyday set and only offered for a request that asks for something to be done
 * (or while a tool the model asked for is being finished).
 */
export function compactForLocal(messages: readonly AIChatMessage[], tools: readonly AIToolSpec[], languageRule = '', at: Date | null = null): LocalPrompt {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUser = i;
      break;
    }
  }
  const before = lastUser < 0 ? [] : messages.slice(0, lastUser);
  const current = lastUser < 0 ? messages.filter((m) => m.role !== 'system') : messages.slice(lastUser);

  // Earlier lines: only what was said (not the tool traffic of old requests), the last few, each cut short.
  const history: AIChatMessage[] = before
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim() !== '')
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: clip(m.content, HISTORY_CHARS) }));

  // The present request, kept whole: the question, and any tool the model asked for with what came back.
  const now: AIChatMessage[] = current.map((m) => {
    if (m.role === 'user') return { role: 'user', content: clip(m.content, USER_CHARS) };
    if (m.role === 'tool') return { ...m, content: clip(m.content, TOOL_RESULT_CHARS) };
    return m;
  });

  const userText = lastUser < 0 ? '' : (messages[lastUser]?.content ?? '');
  const midTool = now.length > 1;
  const offered = midTool || looksLikeAction(userText) ? tools.filter((t) => LOCAL_CORE_TOOLS.includes(t.name)).map(shrinkTool) : [];

  // (The date and time come last in the instruction, so what comes before them can be reused by the model from one request to the next.)
  const clock = at === null ? '' : `\nNow: ${at.toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' })}.`;
  const system = `${LOCAL_SYSTEM}${offered.length > 0 ? TOOL_LINE : ''}${languageRule === '' ? '' : `\n${languageRule}`}${clock}`;
  return { messages: [{ role: 'system', content: system }, ...history, ...now], tools: offered };
}

// What a small model should not be left to do alone: long or demanding writing, reading and research, and tasks that need to work a
// website or an account through many steps. With cloud AI available these go there; with "Local AI only" they stay (and are answered as well as it can).
const LONG_REQUEST = 1500;
const HEAVY = /\b(research|summari[sz]e|summary of|analy[sz]e|translate|compare|proofread|draft|petition|essay|report|article|presentation|spreadsheet|pdf|excel|word (?:file|document))\b/i;
const MULTI_STEP = /\b(whatsapp|telegram|instagram|gmail|email|e-mail|screenshot|my screen|order|buy|book|cart|checkout|log ?in|sign ?in|fill (?:in|out))\b/i;

/** Whether this request is one for a stronger AI than the small local model (a judgement from the words alone; cheap and predictable). */
export function needsStrongerAI(text: string): boolean {
  const t = text.trim();
  return t.length > LONG_REQUEST || HEAVY.test(t) || MULTI_STEP.test(t);
}
