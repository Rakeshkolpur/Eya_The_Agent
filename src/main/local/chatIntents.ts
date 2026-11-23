import { stripPoliteness } from '@main/agent/IntentRouter';
import { parseFileFinding } from '@main/chat/chatFiles';
import type { FileRequest } from '@main/chat/chatFiles';
import { readPhoneReference } from '@main/chat/phoneNumbers';
import { ADAPTERS } from '@main/chat/platformAdapter';
import { readContextReference, splitLeadingContext } from '@main/chat/recipientResolver';
import type { ChatAppId } from '@main/chat/platformAdapter';
import { parseLiveStart } from '@main/livechat/liveChatRequest';
import type { LiveRelation } from '@shared/liveChat';

/**
 * Recognising chat requests — "message Ravi that I'll be late", "send hi to Amma on WhatsApp", "open Priya's chat",
 * "remember my WhatsApp contacts" — without a language model. Pure: no page, no database. It only claims a request when the verb
 * and a person are both clear; everything else (and anything about sending a FILE) goes to the model as before.
 *
 * The message is returned exactly as it was said — capitals, apostrophes and all — because it is sent word for word.
 */

// (what is particular to each app — its address, the labels of its boxes, its login screen — is in chat/platformAdapter.ts)
export type { ChatAppId } from '@main/chat/platformAdapter';

export const CHAT_APPS: Readonly<Record<ChatAppId, { readonly name: string; readonly url: string }>> = {
  whatsapp: { name: ADAPTERS.whatsapp.name, url: ADAPTERS.whatsapp.url },
  telegram: { name: ADAPTERS.telegram.name, url: ADAPTERS.telegram.url },
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
  | { readonly kind: 'send_file'; readonly app: ChatAppId | null; readonly name: string; readonly file: string | null; readonly deictic?: boolean; readonly fileType?: string }
  /** "when I say akka I mean Lakshmi Akka" (`name` is that chat) or "call this chat akka" (`name` is null: the chat that is open). */
  | { readonly kind: 'alias'; readonly app: ChatAppId | null; readonly alias: string; readonly name: string | null }
  /** "check this file where it is in WhatsApp", "find the resume I sent last week": where a file is, among the chats (see chat/chatFiles.ts). */
  | { readonly kind: 'find_files'; readonly app: ChatAppId | null; readonly request: FileRequest }
  /** "Start live chat with Rahul", "stop live chat", "pause live chat", "confirm live chat": the Live Chat Companion (see livechat/). */
  | {
      readonly kind: 'live_chat';
      readonly app: ChatAppId | null;
      readonly action: 'start' | 'stop' | 'pause' | 'resume' | 'status' | 'confirm' | 'choose' | 'auto';
      /** Who the other person is to the person (said, or answered when asked): how Eya sounds. */
      readonly relation?: LiveRelation;
      /** "stop all live chats": every one that is running, not only the one shown. */
      readonly all?: boolean;
      /** Who: a name or a phone number as said. Absent on a start: nobody was named ("do live chat now go"), so the last one mentioned is used, or the person is asked. */
      readonly name?: string;
      readonly mode?: 'draft' | 'assisted';
      readonly autoAsked?: boolean;
      readonly choice?: number;
      /** What the person said they want from the chat, in their words ("she is my close friend, make her happy"). */
      readonly purpose?: string;
      /** They said Eya is to write the first message. */
      readonly opening?: boolean;
      /** They said, in this request, that the other person knows Eya is messaging there. */
      readonly aware?: boolean;
      /** They said the other person does NOT know (or that it is a secret). */
      readonly unaware?: boolean;
      /** They said they are in the chat too (see LiveChatView.together). */
      readonly together?: boolean;
    }
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
  // (only the words that name the app are taken out, with ONE space left where they were: the rest keeps its own spacing, since a message is sent as said)
  const joined = (m: string, at: number, whole: string): string => (at === 0 || at + m.length >= whole.length ? '' : ' ');
  const without = text.replace(/\s*\b(?:on|in|via|using|through|over|from|with)\s+(?:my\s+)?(?:whatsapp|telegram)\b/i, joined).replace(/\b(?:whatsapp|telegram)\s+(?=(?:message|msg|text)\b)/i, joined);
  return { text: without.trim(), app };
}

function cleanName(raw: string): string | null {
  let name = raw.replace(/^(?:to|for|my)\s+/i, '').replace(/[:,\-–—]+$/, '').replace(/['’]s\s*$/i, '').trim();
  name = name.replace(/^["“'‘]+|["”'’]+$/g, '').trim();
  // A phone number is who a message is for — a whole one in any of its forms, the end of one ("ending 3900"), one read out ("nine three six…") — and so is a
  // reference to the conversation ("him", "the same person I messaged yesterday"). Whether it is a valid number, and who it is, is the recipient resolver's to say.
  const number = readPhoneReference(name);
  if (number !== null && (number.kind !== 'partial' || number.digits.length >= 3)) return name;
  if (readContextReference(name) !== null) return name;
  const words = name.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0 || words.length > MAX_NAME_WORDS) return null;
  if (words.length === 1 && NOT_A_NAME.has(words[0]?.toLowerCase() ?? '')) return null;
  if (/[?!@]|https?:|\d{4,}/.test(name)) return null;
  return name;
}

/** A message exactly as it was said, without the quotation marks it was said inside (and a speech recogniser's closing full stop). */
export function cleanMessageText(raw: string): string | null {
  return cleanText(raw);
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
  // "anna, msg where are u": a comma, then the word for a message, then the message.
  const marked = /^([^,]{1,40}),\s*(?:msg|message|text|saying)[:,]?\s+(.+)$/is.exec(rest);
  if (marked?.[1] !== undefined && marked[2] !== undefined && marked[1].trim().split(/\s+/).length <= MAX_NAME_WORDS) return { name: marked[1], text: marked[2] };
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
  // "anna 'where are u'" / "Ravi "I'll be late"": the quotation marks say where the message is, so there is nothing to guess.
  const quoted = /^(.+?)[\s,]+["“‘'](.+)["”’']\s*$/s.exec(rest);
  if (quoted?.[1] !== undefined && quoted[2] !== undefined && quoted[1].trim().split(/\s+/).length <= MAX_NAME_WORDS) {
    const viaQuotes = message(app, quoted[1], quoted[2], rest);
    if (viaQuotes !== null) return viaQuotes;
  }
  const parts = splitAtSeparator(rest);
  // (a split at a word like "asking" or "that" that gives no usable name — "+91 98765 08501 he asking u, …" — is not the end of it: the rest is tried the other ways)
  const viaSeparator = parts === null ? null : message(app, parts.name, parts.text, rest);
  if (viaSeparator !== null) return viaSeparator;
  // "tell him I'm late", "message the last person I messaged hello": the person is the conversation's, and the message is what follows, as it was said.
  const lead = splitLeadingContext(rest);
  if (lead !== null) return message(app, lead.phrase, lead.text);
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

// Only a kind of file ("pdf", "document", "photo"): it names no file, so the file meant is the one just found or talked about.
// ("report", "invoice", "resume" are what files are CALLED, so "my report" names a file and is looked for; "the pdf" and "this file" do not.)
const BARE_KIND = /^(?:pdf|pdfs|file|document|doc|docx|photo|picture|pic|image|video|screenshot|attachment)$/i;

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
    if (name === null || file === '') return null;
    // "this PDF", "that file", "the pdf": the file being talked about, not one called "pdf" (a bare kind of file names no file).
    const deictic = /^(?:me\s+)?(?:this|that|these|those)\b/i.test(toPerson[1].trim()) || BARE_KIND.test(file);
    return { kind: 'send_file', app: taken.app ?? appOf(body), name, file, ...(deictic ? { deictic: true, fileType: file.toLowerCase() } : {}) };
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
// "+91 98765 08501 msg this person, <what to say>": the number FIRST, then a word for a message, then "this person" (or him / her), then what to say. It is the same request as
// "message +91 98765 08501 <what to say>" and is read as that.
const NUMBER_FIRST = /^(?:please\s+)?(\+?\d[\d\s().-]{7,}\d)\s*[,:]?\s*(?:please\s+)?(?:msg|message|text|whatsapp|send\s+(?:a\s+)?(?:msg|message|text))\s+(?:to\s+)?(?:this\s+(?:person|number|contact|friend)|him|her|them)\s*[,:-]?\s*(.+)$/is;

export function parseChatIntent(raw: string): ChatIntent | null {
  const numberFirst = NUMBER_FIRST.exec(raw.trim());
  if (numberFirst?.[1] !== undefined && numberFirst[2] !== undefined) {
    const rebuilt = parseOneChatIntent(`message ${numberFirst[1].trim()} ${numberFirst[2].trim()}`);
    if (rebuilt !== null) return rebuilt;
  }
  const whole = parseOneChatIntent(raw);
  if (whole !== null) return whole;
  const sentences = raw.trim().split(/(?<=[.?!])\s+/).filter((x) => x !== '');
  if (sentences.length < 2 || sentences.length > 4) return null;
  for (let from = sentences.length - 1; from >= 1; from -= 1) {
    const tail = parseOneChatIntent(sentences.slice(from).join(' '));
    if (tail !== null && (tail.kind === 'send_file' || tail.kind === 'message' || tail.kind === 'open_chat' || tail.kind === 'alias' || tail.kind === 'find_files' || tail.kind === 'live_chat')) return tail;
  }
  return null;
}

// Another app named in the request ("... on Instagram", "via Snapchat", "by email"): this layer has an adapter for WhatsApp and Telegram only, and a request for
// another app is not a request for WhatsApp with a strange name in it. It goes on to the model, as before.
const OTHER_APP =
  /\b(?:on|in|via|using|through|over|from|with|by)\s+(?:my\s+)?(?:instagram|insta|snapchat|snap|messenger|facebook|fb|discord|slack|teams|skype|signal|sms|e-?mail|gmail|linkedin|twitter)\b/i;

// "Open WhatsApp and send hello to Ravi": the app is named by the opening words, and the request is what follows them.
const OPENING_WORDS = /^(?:open|launch|start|go to|switch to)\s+(?:my\s+)?(whatsapp|telegram)(?:\s+web)?\s*(?:,|\band then\b|\band\b|\bthen\b)\s+/i;

// What people put in front of the request when they say it again ("i said send msg ...", "just send ...", "ok now send ...").
const LEAD_IN = /^(?:(?:i\s+(?:said|told\s+you(?:\s+to)?|asked\s+you\s+to|want\s+you\s+to|wanted\s+you\s+to)|just|ok(?:ay)?|now|then|please|go\s+and|go\s+ahead\s+and)[,:]?\s+)+/i;

function parseOneChatIntent(raw: string, named: ChatAppId | null = null): ChatIntent | null {
  const polite = stripPoliteness(raw.trim().replace(LEAD_IN, ''));
  const opened = OPENING_WORDS.exec(polite);
  if (opened?.[1] !== undefined) {
    const app = opened[1].toLowerCase() as ChatAppId;
    // (the app was named by the opening words, so what follows needs no "on WhatsApp" of its own to be a chat request)
    const inner = parseOneChatIntent(polite.slice(opened[0].length), app);
    if (inner === null) return null;
    return 'app' in inner && inner.app === null ? { ...inner, app } : inner;
  }
  if (OTHER_APP.test(polite) && appOf(polite) === null) return null;
  // `body` is exactly what was said (a message in it is sent word for word); `command` has the closing full stop or "!" taken off, for
  // the phrases that are only commands.
  const body = stripPoliteness(raw.trim().replace(LEAD_IN, ''));
  const command = body.replace(/[.!]+$/, '').trim();
  if (command === '') return null;

  if (COUNT.test(command)) return { kind: 'count' };
  const alias = aliasIntent(command);
  if (alias !== null) return alias;
  if (STOP_LEARNING.test(command)) return { kind: 'stop_learning' };
  if (LEARN.test(command) || LEARN_NAMES_IN.test(command)) return { kind: 'learn', app: appOf(command) };
  if (FORGET.test(command)) return { kind: 'forget', app: appOf(command) };

  // the live chat companion: "start live chat with Rahul" (before anything that would take "chat with Rahul" for something else)
  const live = liveChatIntent(command);
  if (live !== null) return live;

  // where is that file among the chats: "check this file where it is in WhatsApp", "find the resume pdf I sent last week" (never a send)
  const finding = parseFileFinding(command);
  if (finding !== null) return { kind: 'find_files', app: finding.app ?? named, request: finding };

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
  const sendTo = /^(?:send|write|drop|shoot)\s+(?:(?:a|an)\s+)?(?:(?:whatsapp|telegram)\s+)?(?:message|msg|text|note)\s+(?:(?:in|on|via|using|through)\s+(?:my\s+)?(?:whatsapp|telegram)\s+)?to\s+(.+)$/is.exec(body);
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
    if (taken.app === null && appOf(body) === null && named === null) return null;
    return message(taken.app ?? appOf(body) ?? named, taken.text, textFirst[1]);
  }
  return null;
}

const YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|send|send it|send now|go ahead|do it|confirm|confirmed|correct|right|that'?s right|proceed)(?: please| pls| plz| now| it| send| send it| go ahead| na| naa| once| ra| da)*$/;
const NO = /^(?:no|nope|nah|cancel|stop|don'?t|do not|don'?t send|do not send|never ?mind|discard|forget it|not now)(?: please| it| that| send| send it)?$/;

// "ok", "do it now", "send na", "go and do what I said", "try again": about the request that did not finish, not a new one.
const CONTINUE = /^(?:ok(?:ay)?|yes|yeah|yep|sure|do it|do that|go ahead|go|continue|carry on|proceed|try again|tryagain|retry|again|once more|just do it|send|send it|(?:go (?:and )?)?do (?:what|as) i (?:said|told you|asked|wanted))(?: now| na| naa| please| pls| plz| again| once more| it| quickly| fast| da| ra)*$/;

/** Is this a short "go on with it" for the request that did not finish ("ok", "do it now", "send na", "go and do what I said")? */
export function isContinuation(raw: string): boolean {
  const text = raw.toLowerCase().replace(/[.,!?;:"']/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:hey eya|eya|hey|okay eya)\s+/, '');
  return text !== '' && text.length <= 40 && CONTINUE.test(text);
}

// The ways a yes is spelled when typed fast or said in a mix of languages ("ya", "yaa send", "haan", "avunu"): one of those spellings, then only the small words a yes is
// followed by ("send", "it", "now", "please", "na", "go ahead"). Anything else after it is not a yes: "yes but change it", and "ok now go" (which is about doing something, not
// about the question that is waiting).
const YES_SPELLING = /^(?:yes+|yess+|ye+a+h?|yeh|yah|yep|yup|ya+|yas|sure|ok+|okay|okey|kk?|haan|han|haa|avunu|avnu|correct|right|confirm(?:ed)?)(?: (?:send|sent|it|now|please|pls|plz|na|naa|ra|da|once|sir|go ahead))*$/;

/** A reply to a question just asked: yes, no, or neither (a new request). */
export function parseYesNo(raw: string): 'yes' | 'no' | null {
  const text = raw.toLowerCase().replace(/[.,!?;:"]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:hey eya|eya|hey|okay eya)\s+/, '');
  if (YES.test(text) || YES_SPELLING.test(text)) return 'yes';
  if (NO.test(text)) return 'no';
  return null;
}

/**
 * A person who has already said yes and is asked again says so, often crossly ("send why are you asking me again"): that is a yes to the send, not a new request. Only for the question
 * about a send that is waiting; never with a no in it.
 */
export function isImpatientYes(raw: string): boolean {
  const t = raw.toLowerCase();
  return /\b(?:send|sent|yes|ya|yeah|ok|okay|go ahead|do it)\b/.test(t) && /\b(?:again|already|told you|i said|said yes|why)\b/.test(t) && !/\b(?:don'?t|dont|do not|no|not|cancel|stop|never)\b/.test(t);
}

/** A reply to the message that was written for the person that asks for a change in it ("make it shorter", "add that I miss him"), and not a yes, a no or a new request. */
export function looksLikeEdit(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 4 || t.length > 240) return false;
  return /^(?:change|make|add|remove|replace|write|say|instead|rephrase|shorter|longer|more|less|don'?t say|also|and also|put)\b|\b(?:shorter|longer|rewrite|rephrase|more polite|more formal|more casual|change it|add that|remove that|instead)\b/i.test(t);
}

// ---------------------------------------------------------------------------------------------------------------------- the live chat
// "Start live chat with my friend Rahul", "stop live chat", "pause the live chat", "confirm live chat". The person's own words: a model's tool call is never how a
// chat is confirmed or chosen, so these come only from here (or from the Live chat page).
const LIVE_WORDS = /\blive\s+(?:whatsapp\s+)?chat(?:s|ting)?\b/i;
const LIVE_STOP = /^(?:please\s+)?(?:stop|end|close|finish|quit|turn\s+off|switch\s+off|cancel)\s+(?:the\s+|my\s+)?live\s+(?:whatsapp\s+)?chat(?:\s+companion)?$/i;
// "stop all live chats" / "stop every live chat": all of them, when several run at once
const LIVE_STOP_ALL = /^(?:please\s+)?(?:stop|end|close|finish|quit|cancel)\s+(?:all|every|both)(?:\s+(?:the|my|of\s+the))?\s+live\s+(?:whatsapp\s+)?chat(?:s|ting)?(?:\s+companion)?$/i;
const LIVE_PAUSE = /^(?:please\s+)?pause\s+(?:the\s+|my\s+)?live\s+(?:whatsapp\s+)?chat(?:\s+companion)?$/i;
const LIVE_RESUME = /^(?:please\s+)?(?:resume|continue|restart|unpause)\s+(?:the\s+|my\s+)?live\s+(?:whatsapp\s+)?chat(?:\s+companion)?$/i;
const LIVE_STATUS = /^(?:(?:what(?:'s|\s+is)\s+)?(?:the\s+)?live\s+(?:whatsapp\s+)?chat\s+(?:status|state)|is\s+(?:the\s+)?live\s+(?:whatsapp\s+)?chat\s+(?:on|running|active)|how\s+is\s+(?:the\s+)?live\s+(?:whatsapp\s+)?chat(?:\s+going)?)$/i;
const LIVE_CONFIRM = /^(?:please\s+)?(?:confirm|yes\s+(?:to\s+)?)\s*(?:the\s+)?live\s+(?:whatsapp\s+)?chat(?:\s+(?:chat|contact|person))?$/i;
const LIVE_CHOOSE = /^(?:live\s+(?:whatsapp\s+)?chat\s+)(?:option|pick|choose|number|choice)\s+(\d{1,2})$/i;

// What a person says after a live chat could not start, once they have done what was needed: "I opened that chat, you can do now", "ok now go", "try again". It is the same
// request again (with the last person named), not a new one — and it is carried out here, so that the answer is Eya's own words and not an AI's retelling of them.
const OPENED_IT = /\bopen(?:ed|d|e)?\b.{0,20}\b(?:chat|it|that)\b|\b(?:chat|it)\b.{0,12}\b(?:is|was)\b.{0,10}\bopen|\bit['’]?s\s+open/i;
const GO_NOW = /^(?:ok(?:ay)?\W+|now\W+|so\W+)*(?:(?:you|u)\s+can\s+)?(?:do|start|go|try|continue|retry)\b(?:\s+(?:it|that|live chat|the live chat))?(?:\s+(?:now|again|once more|please|go))*\W*$/i;
export function isLiveRetry(raw: string): boolean {
  const t = raw.trim().replace(/\s+/g, ' ');
  if (t === '' || t.length > 90 || t.split(' ').length > 14) return false;
  return OPENED_IT.test(t) || GO_NOW.test(t);
}

// "turn on auto reply" / "reply automatically": asks the question that switches automatic replies on for the live chat that is running (nothing is switched on by these words alone)
const LIVE_AUTO = /^(?:please\s+)?(?:(?:turn\s+on|switch\s+on|enable|start)\s+(?:the\s+)?auto(?:matic)?[\s-]*repl(?:y|ies)|reply\s+automatically|answer\s+automatically)(?:\s+(?:in|for|on)\s+(?:the\s+|this\s+)?(?:live\s+)?chat)?$/i;

// What the person says to have Eya answer the person in the live chat: "tell her I will call at 6", "tell him that I am busy", "say to them hello", "let her know I am coming",
// "reply to her: ok done", "reply: I will check". Only a pronoun (or "that person") names who — a real name is a message to somebody (handled as one). This is NOT one of the chat
// intents: "tell him …" is also how a message to the person messaged earlier is asked for, so these words are looked at (by ChatCommands) only while a live chat is running.
const RELAY_TO = String.raw`(?:her|him|them|she|he|that\s+person|the\s+person|this\s+person)`;
const RELAY_VERB = String.raw`(tell|say(?:\s+to)?|reply(?:\s+to)?|answer|respond(?:\s+to)?|let|ask|inform|message|msg|text)`;
const RELAY_LEAD = String.raw`(?:(?:ok(?:ay)?|now|please|then|and|so|also)\W+)*`;
const LIVE_RELAY = new RegExp(String.raw`^${RELAY_LEAD}${RELAY_VERB}\s+(${RELAY_TO})(?:\s+know)?\b\s*(?:that\b|:|,|-)?\s*(\S.*)$`, 'i');
const LIVE_REPLY = /^(?:(?:ok(?:ay)?|now|please|then|and|so)\W+)*(?:reply|answer|respond)\s*(?::|,|-|with\b|that\b)\s*(\S.*)$/i;

/**
 * "Show my notes", "what are my notes", "any messages for me from the chat", "read my live chat notes", "clear my notes": the notes Eya kept for the person from their live chats.
 * "note" alone is too common a word (\"make a note that…\" is the memory's), so it needs "my … notes" or "notes from the live chat", or a "messages for me".
 */
export function parseNotesCommand(command: string): 'show' | 'clear' | null {
  const t = command.trim().toLowerCase().replace(/[?.!]+$/g, '').replace(/\s+/g, ' ');
  if (t === '' || t.length > 80) return null;
  if (/^(?:please\s+)?(?:clear|delete|remove|erase)\s+(?:all\s+)?(?:of\s+)?my\s+(?:live\s*chat\s+)?(?:notes|messages)(?:\s+from\s+(?:the\s+)?(?:live\s*)?chats?)?$/.test(t)) return 'clear';
  if (/^(?:please\s+)?(?:show|read|tell|give|open|list|check)(?:\s+me)?\s+(?:all\s+)?(?:of\s+)?my\s+(?:live\s*chat\s+)?(?:notes|messages|important\s+messages)(?:\s+(?:from|of)\s+(?:the\s+)?(?:live\s*)?chats?)?$/.test(t)) return 'show';
  if (/^(?:what\s+(?:are|were)|do\s+i\s+have\s+any|any|have\s+i\s+got\s+any)\s+(?:my\s+)?(?:new\s+)?(?:live\s*chat\s+)?(?:notes|messages\s+for\s+me|important\s+messages)(?:\s+(?:from|in)\s+(?:the\s+)?(?:live\s*)?chats?)?$/.test(t)) return 'show';
  if (/^(?:any|do\s+i\s+have\s+(?:any\s+)?)\s*(?:new\s+)?(?:notes|messages)\s+from\s+(?:the\s+|my\s+)?(?:live\s*)?chats?$/.test(t)) return 'show';
  return null;
}

/**
 * "Delete that message", "delete the last message for everyone", "delete it only for me", "unsend that", "remove my last message from here": the last message the account sent in the
 * live chat that is running. `scope`: for everyone / only for the person, or null when they did not say (then they are asked). `many`: "delete all the messages" — not done, said so.
 * Only while a live chat runs (ChatCommands asks); "delete it" alone is NOT this (it could be a file).
 */
export function parseDeleteMessage(command: string): { readonly scope: 'me' | 'everyone' | null; readonly many?: true } | null {
  const t = command.trim().toLowerCase().replace(/[.!?,]+$/g, '').replace(/\s+/g, ' ');
  if (t === '' || t.length > 140) return null;
  const lead = String.raw`^(?:(?:please|pls|ok(?:ay)?|now|and|then|also)\W+)*(?:(?:can|could|would|will)\s+(?:you|u)\s+)?`;
  const everyone = /\b(?:for\s+)?(?:everyone|everybody|both(?:\s+sides)?|all\s+of\s+us)\b/.test(t);
  const mine = /\b(?:for\s+me(?:\s+only)?|only\s+(?:for\s+)?me|just\s+(?:for\s+)?me|(?:from|on)\s+my\s+(?:side|phone)|only\s+here|just\s+here|from\s+here|here\s+only|only\s+in\s+(?:my|this)\s+(?:phone|side|chat))\b/.test(t);
  const scope = everyone ? 'everyone' : mine ? 'me' : null;
  // many at once is not done: one message, the one they are shown
  if (new RegExp(lead + String.raw`(?:delete|remove|clear|erase)\s+(?:all|every|both)\b.*\b(?:messages|msgs|texts|chat|conversation)\b`).test(t)) return { scope: null, many: true };
  const withObject = new RegExp(lead + String.raw`(?:delete|remove|unsend|revoke|take\s+back|undo)\s+(?:the\s+|that\s+|this\s+|my\s+|your\s+|his\s+|her\s+)*(?:last\s+|latest\s+|previous\s+|recent\s+|sent\s+|wrong\s+)*(?:message|msg|text|reply)\b`);
  const unsend = new RegExp(lead + String.raw`(?:unsend|revoke|take\s+back)\s*(?:it|that|this|the\s+last\s+one|the\s+last)?\b`);
  const scoped = new RegExp(lead + String.raw`(?:delete|remove)\s+(?:it|that|this|the\s+last\s+one)?\s*(?:for\s+(?:everyone|everybody|me)|only\s+(?:for\s+)?me|just\s+(?:for\s+)?me|only\s+here|just\s+here)\b`);
  if (withObject.test(t) || unsend.test(t) || scoped.test(t)) return { scope };
  return null;
}

/** The answer to "for everyone, or only for you?": which way, or no. */
export function parseDeleteScope(reply: string): 'me' | 'everyone' | 'no' | null {
  const t = reply.trim().toLowerCase().replace(/[.!?,]+$/g, '').replace(/\s+/g, ' ');
  if (t === '' || t.length > 80) return null;
  if (/^(?:no|nope|nah|cancel|stop|never\s*mind|leave\s+it|keep\s+it|don'?t|do\s+not|neither)\b/.test(t)) return 'no';
  if (/\b(?:for\s+)?(?:everyone|everybody|both)\b/.test(t)) return 'everyone';
  if (/\b(?:for\s+me|only\s+me|just\s+me|me\s+only|only\s+(?:for\s+)?me|only\s+here|just\s+here|here|my\s+side|mine)\b/.test(t)) return 'me';
  return null;
}

/** What a person said for the other person in a live chat, as the words to send, or null. "tell her to call me" becomes "please call me". Pure. */
export function parseRelay(command: string): { readonly text: string; readonly to?: string; readonly unclear?: true } | null {
  const said = command.trim().replace(/\s+/g, ' ');
  if (said === '' || said.length > 700) return null;
  const toIt = LIVE_RELAY.exec(said);
  const bare = toIt === null ? LIVE_REPLY.exec(said) : null;
  const raw = (toIt?.[3] ?? bare?.[1] ?? '').trim();
  if (raw === '') return null;
  return relayWords(toIt?.[1], raw, toIt?.[2]);
}

/** The words for the other person from what was said after the verb and who: "to call me" → "please call me"; "ask her if she is free" → "Are you free?". `unclear`: asked, but not in a shape that can be turned into a question safely. */
function relayWords(verb: string | undefined, raw: string, to: string | undefined): { readonly text: string; readonly to?: string; readonly unclear?: true } {
  const asking = verb !== undefined && /^ask$/i.test(verb);
  const toWho = to !== undefined ? { to: to.toLowerCase() } : {};
  if (/^to\s+\S/i.test(raw)) return { text: `please ${raw.replace(/^to\s+/i, '')}`, ...toWho };
  if (!asking) return { text: raw, ...toWho };
  const question = askAsQuestion(raw);
  return question === null ? { text: '', unclear: true, ...toWho } : { text: question, ...toWho };
}

const AUXILIARY: Readonly<Record<string, string>> = { is: 'are', are: 'are', was: 'were', were: 'were', will: 'will', can: 'can', could: 'could', would: 'would', has: 'have', have: 'have', did: 'did', does: 'do', do: 'do' };
const capital = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

/** "if she is free tonight" → "Are you free tonight?"; "what time she is coming" → "What time are you coming?"; anything else cannot be turned into a question safely (null). */
function askAsQuestion(raw: string): string | null {
  const t = raw.trim().replace(/[?.!]+$/, '');
  const yesNo = /^(?:if|whether)\s+(?:she|he|they)\s+(is|are|was|were|will|can|could|would|has|have|did|does|do)\s+(.+)$/i.exec(t);
  if (yesNo?.[1] !== undefined && yesNo[2] !== undefined) return `${capital(AUXILIARY[yesNo[1].toLowerCase()] ?? yesNo[1])} you ${yesNo[2]}?`;
  const wh = /^(what|when|where|why|how|who|which)\b(.*?)\s+(?:she|he|they)\s+(is|are|was|were|will|can|could|would|has|have|did|does|do)\b(.*)$/i.exec(t);
  if (wh?.[1] !== undefined && wh[3] !== undefined) return `${capital(wh[1])}${wh[2] ?? ''} ${AUXILIARY[wh[3].toLowerCase()] ?? wh[3]} you${wh[4] ?? ''}?`.replace(/\s+/g, ' ');
  return null;
}

/**
 * The same, for a live chat NAMED: "tell Rahul I am late", "ask Priya if she is free". `names` are the names of the live chats that are running; only one of them counts as naming
 * somebody (any other name is a message to somebody else, handled as one). Longest name first, so "Rahul Sharma" is not cut at "Rahul".
 */
export function parseRelayNamed(command: string, names: readonly string[]): { readonly text: string; readonly name: string; readonly unclear?: true } | null {
  const said = command.trim().replace(/\s+/g, ' ');
  if (said === '' || said.length > 700) return null;
  const escaped = (n: string): string => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const name of [...new Set(names)].filter((n) => n.trim() !== '').sort((a, b) => b.length - a.length)) {
    const m = new RegExp(String.raw`^${RELAY_LEAD}${RELAY_VERB}\s+(${escaped(name)})(?![\p{L}\p{N}])(?:\s+know)?\s*(?:that\b|:|,|-)?\s*(\S.*)$`, 'iu').exec(said);
    const raw = (m?.[3] ?? '').trim();
    if (m === null || raw === '') continue;
    const words = relayWords(m[1], raw, undefined);
    return words.unclear === true ? { text: '', name, unclear: true } : { text: words.text, name };
  }
  return null;
}


// ------------------------------------------------------------------------------------------------------------------------------------ together
/**
 * What a person says while they sit with Eya in a live chat ("together"): the words are theirs, so these are read ONLY while a live chat runs with together on (ChatCommands asks), and only
 * when the sentence is plainly one of these. Anything else is left to the other layers and the model, as before.
 *  - dictate: "send this: I will come at 5", "send this message ok see you", "no, send this: …", "type this …" (`send` false: ready, not sent), "send this to her: …"
 *  - edit: "change it to …"; send_it: "send it"; cancel: "don't send it", "cancel", "no"; hold: "wait", "let me reply"; release: "go ahead", "you reply"; read: "what did she say"
 *  - on / off: "together mode", "I'm here too", "turn off together mode"
 */
export type TogetherCommand =
  | { readonly kind: 'on' }
  | { readonly kind: 'off' }
  | { readonly kind: 'dictate'; readonly text: string; readonly send: boolean }
  | { readonly kind: 'edit'; readonly text: string }
  | { readonly kind: 'send_it' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'hold' }
  | { readonly kind: 'release' }
  | { readonly kind: 'read' };

// What may come before the command itself ("no, send this …", "ok wait, …", "hey Eya, …").
const TG_LEAD = String.raw`^(?:(?:no|nope|nah|not\s+that|wait|sorry|actually|oh|ok(?:ay)?|hey|eya|please|pls|now|and|then|just|yes|yeah|so)\b[\s,.:-]*)*`;
const TG_VERB = String.raw`(send|type|write|put|text|message|reply|say)`;
const TG_TAIL = String.raw`(?:\s+instead)?(?:\s+to\s+(?:her|him|them|the\s+chat))?(?:\s+(?:as|saying))?\s*([:,-])?\s*(.*)$`;
// "send this …" / "type the following …": the words follow. "send that message …" needs the word for it, since "send that" alone means the reply that is waiting.
const DICTATE_THIS = new RegExp(TG_LEAD + TG_VERB + String.raw`\s+(?:this|the\s+following)(?:\s+(?:message|msg|text|reply|one|line|thing|sentence))?` + TG_TAIL, 'i');
const DICTATE_THAT = new RegExp(TG_LEAD + TG_VERB + String.raw`\s+(?:that|the)\s+(?:message|msg|text|reply|line|sentence)` + TG_TAIL, 'i');
const DICTATE_COLON = new RegExp(TG_LEAD + String.raw`(send|type|text|message|reply)\s*(:)\s*(.+)$`, 'i');
const TG_EDIT = /^(?:(?:no|nope|nah|ok(?:ay)?|hey|eya|please)\b[\s,.:-]*)*(?:change|make|edit|update|replace)\s+(?:it|that|this|the\s+(?:message|msg|text|reply))(?:\s+(?:to|into|with|as)\s*:?|\s*:)\s*(.+)$/i;
const TG_SEND_IT = new RegExp(TG_LEAD + String.raw`(?:(?:go\s+ahead\s+and\s+|just\s+)?send(?:\s+(?:it|that|this|the\s+(?:message|msg|reply)))?(?:\s+(?:now|please|then|out))*|type\s+(?:it|that)\s+and\s+send)\s*$`, 'i');
const TG_CANCEL = /^(?:(?:no|nope|nah|ok(?:ay)?|hey|eya|please)\b[\s,.:-]*)*(?:don'?t\s+send(?:\s+(?:it|that|this))?|do\s+not\s+send(?:\s+(?:it|that|this))?|cancel(?:\s+(?:it|that|this|the\s+message))?|discard(?:\s+(?:it|that|this))?|scrap\s+(?:it|that)|forget\s+(?:it|that)|never\s*mind|delete\s+(?:the\s+)?draft|no|nope|nah)\s*$/i;
const TG_HOLD = /^(?:(?:ok(?:ay)?|hey|eya|please|no|nope)\b[\s,.:-]*)*(?:wait(?:\s+wait)*(?:\s+(?:a\s+)?(?:second|sec|moment|minute|bit))?|hold\s+(?:on|it|up)(?:\s+(?:a\s+)?(?:second|sec|moment|minute|bit))?|hang\s+on|one\s+(?:second|sec|moment|minute)|just\s+(?:a\s+)?(?:second|sec|moment|minute)|not\s+yet|don'?t\s+(?:reply|answer|respond)(?:\s+(?:yet|now|to\s+(?:her|him|them)))?|let\s+me\s+(?:reply|answer|respond|type|write|do\s+(?:it|this))(?:\s+(?:myself|first|now))?|i(?:'ll|\s+will)\s+(?:reply|answer|respond|type|write)(?:\s+(?:myself|it|first|now|this))?)(?:\s+(?:please|wait))*\s*$/i;
const TG_RELEASE = /^(?:(?:ok(?:ay)?|hey|eya|please|yes|yeah|now)\b[\s,.:-]*)*(?:go\s+ahead|you\s+(?:reply|answer|respond|go|can\s+(?:reply|answer|respond))|carry\s+on|go\s+on|continue|reply\s+now|answer\s+now|you\s+(?:talk|handle\s+it|take\s+over))(?:\s+(?:now|please))*\s*$/i;
const TG_READ = /^(?:(?:ok(?:ay)?|hey|eya|please)\b[\s,.:-]*)*(?:what(?:'s|\s+is|\s+did|\s+was|\s+has)?\s+(?:she|he|they)\s+(?:say|said|saying|write|wrote|writing|ask|asked|send|sent|want|wants)(?:\s+(?:now|just\s+now|again|last|lately))?|(?:read|tell|show)(?:\s+me)?\s+(?:her|his|their|the\s+last|the\s+latest|the\s+new)\s+(?:last\s+|latest\s+|new\s+)?(?:message|msg|text)|read\s+(?:it|that)\s+(?:again|out)|what\s+(?:is|was)\s+the\s+(?:last|latest|new)\s+(?:message|msg))\s*$/i;
const TG_OFF = /\b(?:turn|switch)\s+off\s+(?:the\s+)?together|\b(?:stop|end|disable|exit|leave)\s+(?:the\s+)?together(?:\s+mode)?\b|\btogether\s+mode\s+off\b|\bi\s*(?:am|'m|’m)\s+(?:leaving|going\s+now|not\s+here(?:\s+any\s*more)?)\b/i;
const TG_ON = /\b(?:let(?:'|’)?s|we\s+can|can\s+we)\s+(?:\w+\s+){0,2}together\b|\btogether\s+mode\b|\b(?:turn|switch)\s+on\s+(?:the\s+)?together\b|\bi\s*(?:am|'m|’m)\s+(?:here|there|with\s+you)\s+(?:too|also|now|as\s+well)\b|\bsit\s+with\s+me\b|\bi\s*(?:will|'ll|’ll)\s+(?:also\s+)?(?:be\s+)?(?:here|there|in\s+the\s+chat)\s+(?:too|also)\b/i;

/** The words of a dictated message cleaned up: the quotes round them off, the spaces made single. */
function dictated(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().replace(/^["“'‘]+|["”'’]+$/g, '').trim();
}

/** What a person said while together with Eya in a live chat, or null when it is none of these. Pure. */
export function parseTogether(command: string): TogetherCommand | null {
  const said = command.trim().replace(/\s+/g, ' ');
  if (said === '' || said.length > 700) return null;
  if (said.length <= 160) {
    if (TG_OFF.test(said)) return { kind: 'off' };
    if (TG_ON.test(said)) return { kind: 'on' };
  }
  const plain = said.replace(/[.!?]+$/g, '').trim();
  if (plain.length <= 80) {
    if (TG_SEND_IT.test(plain)) return { kind: 'send_it' };
    if (TG_CANCEL.test(plain)) return { kind: 'cancel' };
    if (TG_HOLD.test(plain)) return { kind: 'hold' };
    if (TG_RELEASE.test(plain)) return { kind: 'release' };
    if (TG_READ.test(plain)) return { kind: 'read' };
  }
  const edit = TG_EDIT.exec(said);
  if (edit?.[1] !== undefined) {
    const text = dictated(edit[1]);
    return text === '' ? null : { kind: 'edit', text };
  }
  // The words to send. A file is not a message ("send this file to Anna"), and "send this to Anna" is a message to somebody else: only a separator (a colon, a dash) lets the words be anything.
  const colon = DICTATE_COLON.exec(said);
  const m = colon ?? DICTATE_THIS.exec(said) ?? DICTATE_THAT.exec(said);
  if (m === null) return null;
  const verb = (m[1] ?? '').toLowerCase();
  const separated = colon !== null || m[2] === ':' || m[2] === '-';
  const text = dictated(colon !== null ? (m[3] ?? '') : (m[3] ?? ''));
  if (text === '' || text.length > 600) return null;
  if (!separated && (/^to\b/i.test(text) || FILE_CUE.test(text))) return null;
  return { kind: 'dictate', text, send: verb !== 'type' && verb !== 'write' && verb !== 'put' };
}

function liveChatIntent(command: string): ChatIntent | null {
  if (LIVE_AUTO.test(command)) return { kind: 'live_chat', app: appOf(command), action: 'auto' };
  const start = parseLiveStart(command);
  if (!LIVE_WORDS.test(command) && start === null) return null;
  const app = appOf(command);
  if (LIVE_STOP_ALL.test(command)) return { kind: 'live_chat', app, action: 'stop', all: true };
  if (LIVE_STOP.test(command)) return { kind: 'live_chat', app, action: 'stop' };
  if (LIVE_PAUSE.test(command)) return { kind: 'live_chat', app, action: 'pause' };
  if (LIVE_RESUME.test(command)) return { kind: 'live_chat', app, action: 'resume' };
  if (LIVE_STATUS.test(command)) return { kind: 'live_chat', app, action: 'status' };
  if (LIVE_CONFIRM.test(command)) return { kind: 'live_chat', app, action: 'confirm' };
  const choose = LIVE_CHOOSE.exec(command);
  if (choose?.[1] !== undefined) return { kind: 'live_chat', app, action: 'choose', choice: Number(choose[1]) };
  if (start === null) return null;
  // A start, said the way people say it ("+91 98765 08501 do live chat with this number, she is my close friend, make her happy, she knows it is Eya"): who may be anywhere
  // in the sentence or not there at all (then the last one named, or a question, takes over). "In auto mode" is understood and not obeyed on its own: automatic replies
  // are switched on only by the person's own yes (or their own statement that the other person knows), for a chat that is confirmed.
  let name: string | undefined;
  if (start.target !== null) {
    const cleaned = cleanName(start.target);
    if (cleaned === null) return null;
    name = cleaned;
  }
  return {
    kind: 'live_chat',
    app,
    action: 'start',
    ...(name !== undefined ? { name } : {}),
    ...(start.mode !== undefined ? { mode: start.mode } : {}),
    ...(start.autoAsked ? { autoAsked: true } : {}),
    ...(start.purpose !== '' ? { purpose: start.purpose } : {}),
    ...(start.opening ? { opening: true } : {}),
    ...(start.aware ? { aware: true } : {}),
    ...(start.unaware ? { unaware: true } : {}),
    ...(start.together ? { together: true } : {}),
  };
}
