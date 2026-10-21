import { stripPoliteness } from '@main/agent/IntentRouter';

/**
 * Recognising chat requests — "message Ravi that I'll be late", "send hi to Amma on WhatsApp", "open Priya's chat",
 * "remember my WhatsApp contacts" — without a language model. Pure: no page, no database. It only claims a request when the verb
 * and a person are both clear; everything else (and anything about sending a FILE) goes to the model as before.
 *
 * The message is returned exactly as it was said — capitals, apostrophes and all — because it is sent word for word.
 */

export type ChatAppId = 'whatsapp' | 'telegram';

export const CHAT_APPS: Readonly<Record<ChatAppId, { readonly name: string; readonly url: string }>> = {
  whatsapp: { name: 'WhatsApp', url: 'https://web.whatsapp.com/' },
  telegram: { name: 'Telegram', url: 'https://web.telegram.org/a/' },
};

export type ChatIntent =
  /** `rest` is the whole "name and message" part when it was split at a word like "that" — so a split that fits no saved name can be redone. */
  | { readonly kind: 'message'; readonly app: ChatAppId | null; readonly name: string; readonly text: string; readonly rest?: string }
  /** "message Ravi I'll be late": where the name ends is for the saved chat names to say. */
  | { readonly kind: 'message_unsplit'; readonly app: ChatAppId | null; readonly rest: string }
  | { readonly kind: 'open_chat'; readonly app: ChatAppId | null; readonly name: string }
  /**
   * "send the latest pdf to Akka": `file` is the words for the file, found on this PC. `file` null: "send it to Uber" — the file that was
   * just found or talked about. `app` null: no app was named.
   */
  | { readonly kind: 'send_file'; readonly app: ChatAppId | null; readonly name: string; readonly file: string | null }
  /** "when I say akka I mean Lakshmi Akka" (`name` is that chat) or "call this chat akka" (`name` is null: the chat that is open). */
  | { readonly kind: 'alias'; readonly app: ChatAppId | null; readonly alias: string; readonly name: string | null }
  | { readonly kind: 'learn'; readonly app: ChatAppId | null }
  | { readonly kind: 'forget'; readonly app: ChatAppId | null }
  | { readonly kind: 'stop_learning' }
  | { readonly kind: 'count' };

const APP_WORD = /\b(whatsapp|telegram)\b/i;
const NOT_A_NAME = new Set(['me', 'myself', 'him', 'her', 'them', 'it', 'this', 'that', 'us', 'you', 'everyone', 'everybody', 'someone', 'somebody', 'anyone']);
// Sending a file is a different job (attach_file, with its own questions): never treat it as a typed message.
const FILE_CUE = /\.(?:pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|mp4|mp3|zip|txt|csv)\b|\b(?:file|files|document|documents|photo|photos|picture|pictures|pic|pics|image|images|video|videos|pdf|report|invoice|screenshot|attachment|folder|resume|certificate)\b/i;
const MAX_TEXT = 1000;
const MAX_NAME_WORDS = 4;

function appOf(text: string): ChatAppId | null {
  const m = APP_WORD.exec(text);
  return m === null ? null : (m[1]?.toLowerCase() as ChatAppId);
}

/** Removes "on WhatsApp" / "in Telegram" / "via WhatsApp" wherever it sits, returning what is left and the app. */
function takeApp(text: string): { readonly text: string; readonly app: ChatAppId | null } {
  const app = appOf(text);
  if (app === null) return { text, app: null };
  const without = text.replace(/\s*\b(?:on|in|via|using|through|over|from|with)\s+(?:my\s+)?(?:whatsapp|telegram)\b/i, ' ').replace(/\b(?:whatsapp|telegram)\s+(?=(?:message|msg|text)\b)/i, ' ');
  return { text: without.replace(/\s{2,}/g, ' ').trim(), app };
}

function cleanName(raw: string): string | null {
  let name = raw.replace(/^(?:to|for|my)\s+/i, '').replace(/[:,\-–—]+$/, '').replace(/['’]s\s*$/i, '').trim();
  name = name.replace(/^["“'‘]+|["”'’]+$/g, '').trim();
  const words = name.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0 || words.length > MAX_NAME_WORDS) return null;
  if (words.length === 1 && NOT_A_NAME.has(words[0]?.toLowerCase() ?? '')) return null;
  if (/[?!@]|https?:|\d{4,}/.test(name)) return null;
  return name;
}

function cleanText(raw: string): string | null {
  // A speech recogniser ends a sentence with a full stop; a message rarely does. Anything else (!, ?, ...) is kept as said.
  let text = raw.trim().replace(/^[:,\-–—]+\s*/, '').replace(/([^.])\.$/, '$1').trim();
  const quoted = /^["“'‘](.+)["”'’]$/s.exec(text);
  if (quoted?.[1] !== undefined && !/["“”]/.test(quoted[1])) text = quoted[1].trim();
  if (text.length === 0 || text.length > MAX_TEXT) return null;
  return text;
}

// Where a name ends and the message begins, when the person said so.
const SEPARATOR = /\s+(?:saying|says|that says|and say|and tell (?:him|her|them)|with the message|asking|that)\s+|\s*:\s+/i;

function splitAtSeparator(rest: string): { readonly name: string; readonly text: string } | null {
  const m = SEPARATOR.exec(rest);
  if (m === null) {
    // "Ravi, I'll be late": a comma straight after a short name.
    const comma = /^([^,]{1,30}),\s+(.+)$/s.exec(rest);
    if (comma?.[1] === undefined || comma[2] === undefined || comma[1].trim().split(/\s+/).length > MAX_NAME_WORDS) return null;
    return { name: comma[1], text: comma[2] };
  }
  const name = rest.slice(0, m.index);
  const text = rest.slice(m.index + m[0].length);
  return name.trim() === '' || text.trim() === '' ? null : { name, text };
}

function message(app: ChatAppId | null, nameRaw: string, textRaw: string, rest?: string): ChatIntent | null {
  const name = cleanName(nameRaw);
  const text = cleanText(textRaw);
  return name === null || text === null ? null : { kind: 'message', app, name, text, ...(rest !== undefined ? { rest } : {}) };
}

function unsplit(app: ChatAppId | null, restRaw: string): ChatIntent | null {
  const rest = restRaw.trim();
  if (rest === '') return null;
  const parts = splitAtSeparator(rest);
  if (parts !== null) return message(app, parts.name, parts.text, rest);
  if (NOT_A_NAME.has((rest.split(/\s+/)[0] ?? '').toLowerCase())) return null; // "message me later"
  return rest.split(/\s+/).length >= 2 ? { kind: 'message_unsplit', app, rest } : null;
}

const LEARN = /^(?:learn|read|remember|save|scan|get|memorise|memorize)\s+(?:all\s+)?(?:the\s+)?(?:my\s+)?(?:(?:whatsapp|telegram)\s+)?(?:contacts?|contact names|chat names|chats?|people|names)\b/i;
const LEARN_NAMES_IN = /^(?:learn|remember|read|save)\s+(?:the\s+)?names\s+(?:in|on|from)\s+(?:my\s+)?(?:whatsapp|telegram)\b/i;
const FORGET = /^(?:forget|delete|clear|erase|remove|wipe)\s+(?:all\s+)?(?:the\s+)?(?:my\s+)?(?:(?:whatsapp|telegram)\s+)?(?:contacts?|contact names|chat names|chat list)\b/i;
const STOP_LEARNING = /^(?:stop|don'?t|do not|never|no longer)\s+(?:remember(?:ing)?|learn(?:ing)?|keep(?:ing)?|sav(?:e|ing)|stor(?:e|ing))\s+(?:any\s+|the\s+)?(?:my\s+)?(?:contacts?|contact names|chat names|names|chats)\b/i;
const COUNT = /^(?:how many (?:contacts|chats|chat names|names)(?: do you (?:know|remember|have))?|what (?:contacts|chats|chat names) do you (?:know|remember|have)|do you (?:know|remember) my (?:contacts|chat names))\b/i;

// Teaching what a word means. Only phrasings that cannot be anything else ("remember that Ravi is my brother's contact" is a memory, not this).
const ALIAS_SAY = /^(?:when|if|whenever)\s+i\s+say\s+(.+?),?\s+(?:i\s+mean|it\s+means|that\s+means)\s+(.+)$/i;
const ALIAS_BY = /^(?:by|with)\s+(.+?)\s+i\s+mean\s+(.+)$/i;
const ALIAS_THIS = /^(?:call|name|save|remember|set)\s+(?:this|the\s+open|the\s+current)\s+(?:chat|contact|person|conversation)\s+(?:as\s+|to\s+)?(.+)$/i;
const ALIAS_THIS_IS = /^this\s+(?:chat|contact|person|conversation)\s+is\s+(?:my\s+)?(.+)$/i;

function aliasIntent(command: string): ChatIntent | null {
  const said = ALIAS_SAY.exec(command) ?? ALIAS_BY.exec(command);
  if (said?.[1] !== undefined && said[2] !== undefined) {
    const meant = takeApp(said[2]);
    const alias = cleanName(said[1]);
    const name = cleanName(meant.text);
    return alias === null || name === null ? null : { kind: 'alias', app: meant.app ?? appOf(command), alias, name };
  }
  const here = ALIAS_THIS.exec(command) ?? ALIAS_THIS_IS.exec(command);
  if (here?.[1] !== undefined) {
    const named = takeApp(here[1]);
    const alias = cleanName(named.text);
    return alias === null ? null : { kind: 'alias', app: named.app ?? appOf(command), alias, name: null };
  }
  return null;
}

// A thing that can be sent as a file — and not a folder (a folder has to be zipped first, which is the model's job).
const SENDABLE_FILE = /\.(?:pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|mp4|mp3|zip|txt|csv)\b|\b(?:file|files|document|documents|photo|photos|picture|pictures|pic|pics|image|images|video|videos|pdf|report|invoice|screenshot|attachment|resume|certificate|scan|certificates)\b/i;

/** "send the latest pdf to Akka", "share resume.pdf with Amma on WhatsApp", "send Ravi my passport scan". */
function sendFileIntent(body: string): ChatIntent | null {
  if (/\bfolder\b/i.test(body)) return null;
  // "send it to Uber", "send that file to Amma", "send for Uber": the file that was just found. (Before the typed-message rules, which
  // would take "it" for a message.)
  const sendIt =
    /^(?:send|share|forward|whatsapp|telegram)\s+(?:(?:it|that|this|them|those|the\s+file|that\s+file|this\s+file|the\s+document|that\s+document|this\s+document|the\s+attachment)\s+)?(?:to|for|with)\s+(.+)$/is.exec(body);
  if (sendIt?.[1] !== undefined) {
    const taken = takeApp(sendIt[1]);
    const name = cleanName(taken.text);
    return name === null ? null : { kind: 'send_file', app: taken.app ?? appOf(body), name, file: null };
  }
  const toPerson = /^(?:send|share|forward|whatsapp|telegram)\s+(.+?)\s+(?:to|with)\s+(.+)$/is.exec(body);
  if (toPerson?.[1] !== undefined && toPerson[2] !== undefined && SENDABLE_FILE.test(toPerson[1]) && !/^(?:a\s+)?(?:message|msg|text|note)\b/i.test(toPerson[1])) {
    const taken = takeApp(toPerson[2]);
    const name = cleanName(taken.text);
    const file = toPerson[1].replace(/^(?:me\s+)?(?:the|my|a|an|this|that)\s+/i, '').trim();
    return name === null || file === '' ? null : { kind: 'send_file', app: taken.app ?? appOf(body), name, file };
  }
  const personFile = /^send\s+(.+?)\s+(?:the|my|this|that|a|an)\s+(.+)$/is.exec(body);
  if (personFile?.[1] !== undefined && personFile[2] !== undefined && SENDABLE_FILE.test(personFile[2]) && !/^(?:a\s+)?(?:message|msg|text|note)\b/i.test(personFile[2])) {
    const taken = takeApp(personFile[2]);
    const name = cleanName(personFile[1]);
    return name === null || taken.text === '' ? null : { kind: 'send_file', app: taken.app ?? appOf(body), name, file: taken.text.trim() };
  }
  return null;
}

/**
 * What chat request this is, if it is one this layer carries out; null for anything else. People say things like "Uber chat is there
 * na? Send for Uber." — a question and then the request — so when the whole does not parse, the last sentences are tried.
 */
export function parseChatIntent(raw: string): ChatIntent | null {
  const whole = parseOneChatIntent(raw);
  if (whole !== null) return whole;
  const sentences = raw.trim().split(/(?<=[.?!])\s+/).filter((x) => x !== '');
  if (sentences.length < 2 || sentences.length > 4) return null;
  for (let from = sentences.length - 1; from >= 1; from -= 1) {
    const tail = parseOneChatIntent(sentences.slice(from).join(' '));
    if (tail !== null && (tail.kind === 'send_file' || tail.kind === 'message' || tail.kind === 'open_chat' || tail.kind === 'alias')) return tail;
  }
  return null;
}

function parseOneChatIntent(raw: string): ChatIntent | null {
  // `body` is exactly what was said (a message in it is sent word for word); `command` has the closing full stop or "!" taken off, for
  // the phrases that are only commands.
  const body = stripPoliteness(raw.trim());
  const command = body.replace(/[.!]+$/, '').trim();
  if (command === '') return null;

  if (COUNT.test(command)) return { kind: 'count' };
  const alias = aliasIntent(command);
  if (alias !== null) return alias;
  if (STOP_LEARNING.test(command)) return { kind: 'stop_learning' };
  if (LEARN.test(command) || LEARN_NAMES_IN.test(command)) return { kind: 'learn', app: appOf(command) };
  if (FORGET.test(command)) return { kind: 'forget', app: appOf(command) };

  // open Ravi's chat / open the chat with Ravi / open Ravi on WhatsApp
  const openChat =
    /^(?:open|show|go to|pull up)\s+(?:the\s+|my\s+)?(?:chat|conversation)s?\s+(?:with|of|for)\s+(.+)$/i.exec(command) ??
    /^(?:open|show|go to|pull up)\s+(.+?)['’]?s?\s+(?:chat|conversation)(?:\s+.*)?$/i.exec(command);
  if (openChat?.[1] !== undefined) {
    const taken = takeApp(openChat[1]);
    const name = cleanName(taken.text);
    return name === null ? null : { kind: 'open_chat', app: taken.app ?? appOf(command), name };
  }
  const openOnApp = /^(?:open|show|go to|pull up)\s+(.+?)\s+(?:on|in)\s+(whatsapp|telegram)$/i.exec(command);
  if (openOnApp?.[1] !== undefined && openOnApp[2] !== undefined) {
    const name = cleanName(openOnApp[1]);
    return name === null ? null : { kind: 'open_chat', app: openOnApp[2].toLowerCase() as ChatAppId, name };
  }

  // send a message to Ravi saying ... / send Ravi a message saying ...
  const sendTo = /^(?:send|write|drop|shoot)\s+(?:(?:a|an)\s+)?(?:(?:whatsapp|telegram)\s+)?(?:message|msg|text|note)\s+to\s+(.+)$/is.exec(body);
  if (sendTo?.[1] !== undefined) {
    const taken = takeApp(sendTo[1]);
    return unsplit(taken.app ?? appOf(body), taken.text);
  }
  const sendPerson = /^send\s+(.+?)\s+(?:a|an)\s+(?:(?:whatsapp|telegram)\s+)?(?:message|msg|text)\b\s*(.*)$/is.exec(body);
  if (sendPerson?.[1] !== undefined) {
    const name = cleanName(sendPerson[1]);
    const rest = (sendPerson[2] ?? '').replace(/^(?:saying|that says|that|:)\s*/i, '');
    const taken = takeApp(rest);
    return name === null ? null : message(taken.app ?? appOf(body), name, taken.text);
  }

  // a file: send the latest pdf to Akka / share resume.pdf with Amma on WhatsApp (before "whatsapp Ravi …", which is a typed message)
  const file = sendFileIntent(command);
  if (file !== null) return file;

  // message Ravi that ... / whatsapp Ravi ... / text Ravi ...
  const verb = /^(?:message|msg|text|whatsapp|telegram|ping|dm)\s+(.+)$/is.exec(body);
  if (verb?.[1] !== undefined) {
    const taken = takeApp(verb[1]);
    const app = taken.app ?? appOf(body) ?? (/^telegram\b/i.test(body) ? 'telegram' : /^whatsapp\b/i.test(body) ? 'whatsapp' : null);
    return unsplit(app, taken.text);
  }

  // tell Ravi I'm late / let Ravi know I'm late
  const letKnow = /^let\s+(.+?)\s+know\s+(?:that\s+)?(.+)$/is.exec(body);
  if (letKnow?.[1] !== undefined && letKnow[2] !== undefined) {
    const taken = takeApp(letKnow[2]);
    return message(taken.app ?? appOf(body), letKnow[1], taken.text);
  }
  const tell = /^tell\s+(.+)$/is.exec(body);
  if (tell?.[1] !== undefined) {
    const taken = takeApp(tell[1]);
    return unsplit(taken.app ?? appOf(body), taken.text);
  }

  // send hi to Ravi on WhatsApp / say good morning to Amma on WhatsApp — text first. Never a file, and only when it is clearly a chat.
  const textFirst = /^(?:send|say)\s+(?:(?:a|an)\s+)?(?:(?:message|msg|text)\s+)?(?:saying\s+)?(.+)\s+to\s+(.+)$/is.exec(body);
  if (textFirst?.[1] !== undefined && textFirst[2] !== undefined && !FILE_CUE.test(body)) {
    const taken = takeApp(textFirst[2]);
    // Without "on WhatsApp" this could be anything ("send the news to the printer"): leave it to the model unless an app was named.
    if (taken.app === null && appOf(body) === null) return null;
    return message(taken.app ?? appOf(body), taken.text, textFirst[1]);
  }
  return null;
}

const YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|send|send it|send now|go ahead|do it|confirm|confirmed|correct|right|that'?s right)(?: please| now| it| send| send it| go ahead)?$/;
const NO = /^(?:no|nope|nah|cancel|stop|don'?t|do not|don'?t send|do not send|never ?mind|discard|forget it|not now)(?: please| it| that| send| send it)?$/;

/** A reply to a question just asked: yes, no, or neither (a new request). */
export function parseYesNo(raw: string): 'yes' | 'no' | null {
  const text = raw.toLowerCase().replace(/[.,!?;:"]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:hey eya|eya|hey|okay eya)\s+/, '');
  if (YES.test(text)) return 'yes';
  if (NO.test(text)) return 'no';
  return null;
}
