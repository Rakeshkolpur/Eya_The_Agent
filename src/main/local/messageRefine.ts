import type { AIChatMessage, AIProvider } from '@main/providers/ai/AIProvider';

/**
 * "+91 98765 08501 msg this person, Rakesh told me he will call u night after having dinner, until he said take care, and he asking u, u want anything for diwali" is what a person
 * SAYS to Eya about what to tell someone; it is not the message. Typed as it was said it reads badly ("he asking u, u want anything for diwali"). So Eya writes the message properly,
 * SHOWS it ("I wrote it like this: …"), and sends it only when the person says yes — or changes it when they say what to change. A short message that is already a message
 * ("where are u", "good morning") is left exactly as it was said.
 */

/** Whether what was said is a note about what to say (reported speech, chat shorthand) and not yet the message itself. */
export function needsRefining(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return false;
  if (/^["“'‘].+["”'’]$/s.test(t)) return false; // (said inside quotation marks: it is the message)
  if (/\b(?:told me|asked me|tell (?:him|her|them)|ask (?:him|her|them)|inform (?:him|her|them)|let (?:him|her|them) know|said (?:he|she|that)|wants? (?:to|you|u)\b|will call|is calling|he(?:'s| is)? ?asking|she(?:'s| is)? ?asking|until he said|until she said)\b/i.test(t)) return true;
  if (/\b(?:u|ur|r|pls|plz|msg|wanna|gonna|abt|tmrw|tmw|dis|dat|hv)\b/i.test(t)) return true;
  return false;
}

const SHORTHAND: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bu\b/gi, 'you'],
  [/\bur\b/gi, 'your'],
  [/\bpls\b|\bplz\b/gi, 'please'],
  [/\bmsg\b/gi, 'message'],
  [/\bwanna\b/gi, 'want to'],
  [/\bgonna\b/gi, 'going to'],
  [/\babt\b/gi, 'about'],
  [/\btmrw\b|\btmw\b/gi, 'tomorrow'],
  [/\bdis\b/gi, 'this'],
  [/\bdat\b/gi, 'that'],
  [/\bhv\b/gi, 'have'],
  [/\bn\b/gi, 'and'],
];

/** The words tidied by rule, with no AI: shorthand spelled out, "he asking" -> "he is asking", capitals and a full stop. Used when no AI answers in time. */
export function tidyMessage(raw: string): string {
  let t = raw.replace(/\s+/g, ' ').trim();
  for (const [re, to] of SHORTHAND) t = t.replace(re, to);
  t = t.replace(/\b(he|she|it)\s+(asking|calling|coming|waiting|going)\b/gi, (_m, p: string, v: string) => `${p} is ${v}`);
  t = t.replace(/\b(they|we|you)\s+(asking|calling|coming|waiting|going)\b/gi, (_m, p: string, v: string) => `${p} ${/^you$/i.test(p) || /^they$/i.test(p) || /^we$/i.test(p) ? 'are' : 'is'} ${v}`);
  t = t.replace(/\bi\b/g, 'I').replace(/\b(diwali|deepavali|dussehra|holi|eid|christmas|sankranti|ugadi)\b/gi, (m) => m.charAt(0).toUpperCase() + m.slice(1).toLowerCase());
  t = t.replace(/([.!?,])\1+/g, '$1').replace(/\s+([,.!?])/g, '$1');
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (_m, a: string, b: string) => `${a}${b.toUpperCase()}`);
  if (!/[.!?]$/.test(t)) t += '.';
  return t;
}

const SYSTEM =
  'You write short WhatsApp messages for someone. You are given a rough note of what to tell a person (it may be badly worded, in chat shorthand, or in reported speech). ' +
  'Write the message to send: clear, warm, polite and natural, in the same language as the note. Keep EVERY fact and the same point of view (do not change who "I" or "he" or "she" is, ' +
  'do not make Rakesh speak in the first person unless the note does). Fix spelling and grammar and spell out shorthand (u, ur, pls, msg). Do not add facts, promises, questions or ' +
  'greetings the note does not have. At most 60 words. Reply with the message ONLY: no quotation marks, no explanation, no heading.';

/** Cleans what a model wrote as a message: no quotes round it, no "Here is the message:", not empty and not an apology or a refusal. Null when it cannot be used. */
export function cleanModelMessage(raw: string, original: string): string | null {
  let t = raw.trim().replace(/^```[a-z]*\n?|```$/gi, '').trim();
  t = t.replace(/^(?:here(?:'s| is)(?: the| your)?(?: refined| rewritten)?(?: whatsapp)? message[^:]*:|message:|refined message:)\s*/i, '').trim();
  t = t.replace(/^["“'‘]+|["”'’]+$/g, '').trim();
  if (t === '' || t.length > 700) return null;
  if (/\b(?:i cannot|i can't|i'm sorry|as an ai|language model)\b/i.test(t)) return null;
  // (a rewrite that is much longer than what was said has made things up)
  if (t.length > Math.max(200, original.length * 3)) return null;
  return t;
}

export interface RefineInput {
  /** What the person said to tell. */
  readonly text: string;
  /** The message as Eya last wrote it, when the person asked for a change. */
  readonly draft?: string;
  /** What the person wants changed ("make it shorter", "add that I miss him"). */
  readonly change?: string;
}

/**
 * The refiner: asks the AI to write the message, gives up after `timeoutMs` (the AI may be out of allowance, or a slow small model), and then falls back to the rule-based tidy so the
 * person always sees a readable message and says yes to that.
 */
export function makeRefiner(ai: Pick<AIProvider, 'complete'> | undefined, timeoutMs = 15_000): (input: RefineInput) => Promise<string> {
  return async (input) => {
    const fallback = input.draft !== undefined ? input.draft : tidyMessage(input.text);
    if (ai === undefined) return fallback;
    const user =
      input.draft !== undefined
        ? `The note: ${input.text}\nThe message written so far: ${input.draft}\nThe person asks for this change: ${input.change ?? ''}\nWrite the new message.`
        : `The note: ${input.text}\nWrite the message.`;
    const messages: AIChatMessage[] = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ];
    try {
      const done = await Promise.race([
        ai.complete(messages, []),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      if (done === null) return fallback;
      return cleanModelMessage(done.text, input.text) ?? fallback;
    } catch {
      return fallback;
    }
  };
}
