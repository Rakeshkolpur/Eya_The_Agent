import { readPhoneReference } from '@main/chat/phoneNumbers';

/**
 * Reading a request to start a live chat the way a person actually says it — not only "start live chat with Rahul" but "+91 98765 08501 do live chat with this
 * number, she is my close friend, you can make her happy, she also knows Eya is messaging, ok do" — into what it asks for: who (a number anywhere in the sentence,
 * or a name), what the person wants from the chat (their own words, kept to guide the replies), whether they said the other person knows Eya writes there, and whether
 * Eya is to write first. Pure: no page, no model.
 */

export interface LiveStart {
  /** The chat to watch: a phone number as written, or a name; null when the sentence names nobody (the last one mentioned, or a question, takes over). */
  readonly target: string | null;
  /** What the person said they want from this chat, in their words (never the other person's), or ''. It guides the replies. */
  readonly purpose: string;
  /** The person said, in this request, that the other person knows (and is fine with) Eya messaging there. */
  readonly aware: boolean;
  /** The person said the other person does NOT know (or that it is a secret): the one switch's standing yes is not taken for this chat. */
  readonly unaware: boolean;
  /** Eya is to write the first message (she was asked to cheer someone up, say hello, start the conversation). */
  readonly opening: boolean;
  readonly mode?: 'draft' | 'assisted';
  /** Automatic replies were asked for in words ("reply automatically", "by yourself"). */
  readonly autoAsked: boolean;
}

const LIVE_WORDS = /\blive[\s-]*(?:whatsapp\s+)?chat(?:ting)?\b|\bchat\s+live\b|\blive[\s-]*messag(?:e|es|ing)\b/i;
// A request about the live chat that is not to start one (these have their own handling).
const NOT_A_START = /^(?:please\s+)?(?:stop|end|cancel|quit|finish|close|pause|resume|unpause|confirm|turn\s+off|switch\s+off)\b|^(?:what|how|why|when|where|which|explain|tell\s+me\s+about|is\s+the|are\s+the|does\s+the|did\s+the)\b/i;
const NEGATED = /\b(?:don'?t|do\s+not|never|no\s+need\s+to|not\s+to)\s+(?:\w+\s+){0,2}live[\s-]*chat/i;
// A request that names nobody ("do live chat now go") is a start only when it says to do it; the two words "live chat" alone are not.
const BARE_START = /\b(?:do|start|begin|run|launch|open|activate|enable|go|turn\s+on|switch\s+on|make|set\s*up)\b[^.?!]{0,15}\blive[\s-]*(?:whatsapp\s+)?chat|\blive[\s-]*(?:whatsapp\s+)?chat(?:ting)?\s+(?:now|go|start|begin|please|ok(?:ay)?)\b/i;

const NUMBER = /\+?\d[\d\s().-]{6,}\d/g;

// What a person says to mean "she knows it is Eya (an assistant) writing, and is fine with it". Said with typos too ("she also no Eya msging here").
const AWARE =
  /\b(?:she|he|they|her|him|(?:my\s+)?(?:friend|wife|husband|mom|mum|dad|brother|sister|boss|client))\s+(?:also\s+|already\s+|really\s+|well\s+)?(?:knows?|knew|no|is\s+aware|are\s+aware|aware|agrees?|agreed|understands?|is\s+ok(?:ay)?\s+with|is\s+fine\s+with)\b[^.;]{0,50}?\b(?:eya|ai|a\.i\.|bot|assistant|msg|msging|message|messaging|chat|chatting|this)\b/i;
const NOT_AWARE = /\b(?:doesn'?t|does\s+not|don'?t|do\s+not|never|not|won'?t|isn'?t|wasn'?t)\s+(?:\w+\s+)?(?:know|aware|told|agree|understand)\b|\bwithout\s+(?:her|him|them)\s+knowing\b|\bsecret(?:ly)?\b|\b(?:don'?t|do\s+not)\s+tell\b/i;

// Writing first: the person asked her to cheer someone up, to say hello, to start the conversation, to talk to them.
const OPENING =
  /\b(?:make|cheer|keep|entertain)\b[^.;]{0,24}\b(?:happy|smile|laugh|company|entertained|better|engaged|busy)\b|\bcheer\b|\b(?:say\s+(?:hi|hello|hey)|greet|start\s+(?:the\s+)?(?:chat|conversation|talking)|talk\s+first|message\s+first|write\s+first)\b|\b(?:chat|talk|speak)\s+(?:with|to)\s+(?:her|him|them)\b/i;

const AUTO_WORDS = /\b(?:auto(?:matic(?:ally)?)?|by\s+(?:your|her|him|them)self|without\s+asking(?:\s+me)?|on\s+your\s+own)\b|\breply\s+automatically\b/i;

// Words that end a name in "live chat with Rahul Sharma and he …".
const NAME_STOP = new Set(['and', 'because', 'she', 'he', 'they', 'who', 'as', 'so', 'ok', 'okay', 'please', 'now', 'in', 'on', 'for', 'u', 'you', 'is', 'also', 'this', 'that', 'the', 'a', 'an', 'go', 'do', 'with', 'to', 'via', 'using', 'it', 'her', 'him', 'them', 'my', 'i', 'then', 'but', 'since', 'cause', 'coz', 'if', 'when', 'will', 'can', 'should', 'let', 'make', 'cheer', 'say', 'talk', 'tell', 'ask', 'keep', 'be', 'wish', 'entertain', 'chat', 'send', 'text', 'message', 'reply', 'write', 'help', 'give', 'get', 'just', 'too', 'really', 'very', 'know', 'knows', 'are', 'was', 'has', 'have', 'good', 'nice']);
const NOT_NAMES = new Set(['this', 'that', 'the', 'a', 'an', 'number', 'her', 'him', 'them', 'me', 'it', 'someone', 'somebody', 'anyone', 'person', 'contact', 'friend', 'whatsapp', 'telegram']);
const RELATION = /^(?:(?:my|our)\s+)?(?:(?:close|best|good|dear|old)\s+)?(?:friend|colleague|client|buddy|brother|sister|boss|mom|mum|dad|wife|husband|girlfriend|boyfriend|cousin|uncle|aunt)\s+/i;

/** The number written in the sentence (as written), if there is a whole one. */
function numberIn(text: string): string | null {
  for (const m of text.matchAll(NUMBER)) {
    const written = m[0].trim();
    const reading = readPhoneReference(written);
    if (reading !== null && (reading.kind === 'international' || reading.kind === 'national')) return written;
  }
  return null;
}

/** A name after "live chat with …", stopping where the sentence goes on to something else. */
function nameIn(text: string): string | null {
  const m = /\b(?:live[\s-]*(?:whatsapp\s+)?chat(?:ting)?|chat\s+live)\s+(?:with|to|for)\s+(.+)$/i.exec(text);
  if (m?.[1] === undefined) return null;
  const rest = m[1].replace(RELATION, '').trim();
  const words: string[] = [];
  for (const raw of rest.split(/\s+/)) {
    const clean = raw.replace(/^["“'‘(]+|["”'’),.!?;:]+$/g, '');
    if (clean === '' || NAME_STOP.has(clean.toLowerCase()) || /\d/.test(clean)) break;
    words.push(clean);
    if (words.length === 3 || /[,.!?;:]$/.test(raw)) break;
  }
  const first = words[0]?.toLowerCase();
  if (first === undefined || NOT_NAMES.has(first)) return null;
  return words.join(' ');
}

/** What the person wants from the chat: the sentence without the number, the command words and the app, in their words. */
function purposeOf(text: string, written: string | null): string {
  let rest = text;
  if (written !== null) rest = rest.replace(written, ' ');
  rest = rest
    .replace(/\b(?:please\s+)?(?:do|start|begin|go|make|open|run|continue|resume|begin)\s+(?:a\s+|the\s+|my\s+)?live[\s-]*(?:whatsapp\s+)?chat(?:ting)?\b/gi, ' ')
    .replace(/\blive[\s-]*(?:whatsapp\s+)?chat(?:ting)?\b/gi, ' ')
    .replace(/\b(?:with|to|for)\s+(?:this|that|the)\s+(?:number|person|contact|friend|chat)\b/gi, ' ')
    .replace(/\b(?:in|on|via|using|through)\s+(?:my\s+)?(?:whatsapp|telegram)\b/gi, ' ')
    .replace(/[,;]\s*(?:ok(?:ay)?|now|go|please|do|start)(?:\s+(?:ok(?:ay)?|now|go|please|do|start))*\s*[.!]*\s*$/i, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:!-]+|[\s,.;:!-]+$/g, '')
    .trim();
  return rest.split(/\s+/).filter(Boolean).length >= 3 ? rest.slice(0, 280) : '';
}

/** A request to start a live chat, read from what the person said — or null when the sentence is not one. */
export function parseLiveStart(raw: string): LiveStart | null {
  const text = raw.trim().replace(/\s+/g, ' ');
  if (text === '' || !LIVE_WORDS.test(text)) return null;
  if (NOT_A_START.test(text) || NEGATED.test(text)) return null;

  const written = numberIn(text);
  const target = written ?? nameIn(text);
  if (target === null && !BARE_START.test(text)) return null;
  const modeWord = /\b(?:in\s+|on\s+|with\s+)?(draft|assisted)(?:\s+mode)?\b/i.exec(text)?.[1]?.toLowerCase();
  const unaware = NOT_AWARE.test(text);
  const aware = AWARE.test(text) && !unaware;
  const purpose = purposeOf(text, written);
  const opening = OPENING.test(text) && !NOT_AWARE.test(text);
  return {
    target,
    purpose,
    aware,
    unaware,
    opening,
    ...(modeWord === 'draft' || modeWord === 'assisted' ? { mode: modeWord } : {}),
    autoAsked: AUTO_WORDS.test(text),
  };
}
