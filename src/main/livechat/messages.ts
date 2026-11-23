import { createHash } from 'node:crypto';
import type { LiveChatMessage } from '@main/browser/BrowserAutomationService';

/**
 * What the live chat does with the messages it reads: which are new, which were edited, which need an answer at all, and whether a drafted answer says only what the
 * conversation supports. Pure: no page, no model, no files — so every rule here is tested on its own.
 */

export const MAX_HANDLED = 300;
export const MAX_CONTEXT = 30;

/**
 * What became of a picture or a document the other person sent: it was saved in the Downloads folder and read (`read`), saved but could not be read (`saved`), could not
 * be got at all (`failed`), or was not looked at (`skipped`: too many at once). `summary` is what a model said it shows or says: it is the OTHER PERSON'S content, so it is
 * only ever shown to the model as data and never followed.
 */
export interface MediaNote {
  readonly kind: 'image' | 'document';
  /** The file's own name (never a path). */
  readonly name: string;
  readonly status: 'read' | 'saved' | 'failed' | 'skipped';
  readonly summary: string;
}

export const textHash = (m: Pick<LiveChatMessage, 'kind' | 'text'>): string => createHash('sha1').update(`${m.kind}\u0001${m.text}`).digest('hex').slice(0, 12);

/** What the tracker remembers about the chat: which incoming messages were looked at, and what each message said when it was first seen (to notice an edit). */
export interface Tracker {
  /** Message ids that need no answer from now on: the ones there when the session began, and the ones a reply was drafted for or judged not to need one. */
  readonly handled: readonly string[];
  /** id → hash of what it said, for the last messages seen. */
  readonly hashes: Readonly<Record<string, string>>;
}

export const EMPTY_TRACKER: Tracker = { handled: [], hashes: {} };

export interface Scan {
  /** Incoming messages not yet looked at (not handled), oldest first: a message stays here until a reply was drafted for it or it was judged to need none. */
  readonly fresh: readonly LiveChatMessage[];
  /** Incoming messages already known whose words changed (an edit). */
  readonly edited: readonly LiveChatMessage[];
  /** Messages the account sent that were not seen before. */
  readonly outgoing: readonly LiveChatMessage[];
  readonly next: Tracker;
}

/** The first look at a chat: everything that is there is old. Nothing in it is answered. */
export function baseline(read: readonly LiveChatMessage[]): Tracker {
  const hashes: Record<string, string> = {};
  for (const m of read) hashes[m.id] = textHash(m);
  return { handled: read.filter((m) => m.dir === 'in').map((m) => m.id).slice(-MAX_HANDLED), hashes: trimHashes(hashes, read) };
}

function trimHashes(hashes: Record<string, string>, read: readonly LiveChatMessage[]): Record<string, string> {
  const keep = new Set(read.slice(-MAX_HANDLED).map((m) => m.id));
  const out: Record<string, string> = {};
  for (const [id, h] of Object.entries(hashes)) if (keep.has(id)) out[id] = h;
  return out;
}

/** What is new in what was just read. An id seen before is never new again, however many times the page reports the same change. */
export function scan(tracker: Tracker, read: readonly LiveChatMessage[]): Scan {
  const handled = new Set(tracker.handled);
  const fresh: LiveChatMessage[] = [];
  const edited: LiveChatMessage[] = [];
  const outgoing: LiveChatMessage[] = [];
  const hashes: Record<string, string> = { ...tracker.hashes };
  for (const m of read) {
    const hash = textHash(m);
    const before = tracker.hashes[m.id];
    // (an incoming message is "fresh" for as long as it has not been handled — not only the first time it is seen — so a message whose reply could not be
    // drafted is tried again, and the same message reported twice by the page is still only one message)
    if (m.dir === 'in' && !handled.has(m.id)) fresh.push(m);
    if (before === undefined) {
      if (m.dir === 'out') outgoing.push(m);
    } else if (before !== hash && m.dir === 'in') {
      edited.push(m);
    }
    hashes[m.id] = hash;
  }
  return { fresh, edited, outgoing, next: { handled: [...tracker.handled], hashes: trimHashes(hashes, read) } };
}

/** The same tracker with these incoming messages taken out of "looked at" (an edit made the earlier look out of date): they are fresh again. */
export function unmark(tracker: Tracker, ids: readonly string[]): Tracker {
  const drop = new Set(ids);
  return { handled: tracker.handled.filter((id) => !drop.has(id)), hashes: tracker.hashes };
}

/** The same tracker with these incoming messages marked as looked at. */
export function markHandled(tracker: Tracker, ids: readonly string[]): Tracker {
  const set = new Set([...tracker.handled, ...ids]);
  return { handled: [...set].slice(-MAX_HANDLED), hashes: tracker.hashes };
}

// ------------------------------------------------------------------------------------------------------------------ does it need an answer?
const ACKNOWLEDGEMENT =
  /^(?:ok(?:ay)?|k+|kk+|thanks?|thank you|thx|ty|tq|cool|fine|sure|yes|yep|yeah|no|nope|alright|got it|noted|done|hmm+|haha+|lol|👍|🙏|👌|😊|🙂|😂|❤️|❤|✅)(?:[\s!.🙏👍👌😊🙂]*)$/iu;

/** The words of an answer ("yes", "no", "ok") — as opposed to a thank-you or a thumbs-up, which close a topic rather than answer a question. */
const ANSWER_WORD = /^(?:ok(?:ay)?|k+|kk+|cool|fine|sure|yes|yep|yeah|no|nope|alright|hmm+)(?:[\s!.🙏👍👌😊🙂]*)$/iu;

export interface ReplyNeed {
  readonly needed: boolean;
  /** Why not, in a few words, when it is not. */
  readonly why: string;
}

/**
 * Was the message just before these new ones a QUESTION that Eya (or the person) asked? "yes" or "no" or "ok" after "Anything else you want me to tell Rakesh?" is an answer,
 * and an answer is replied to — it is not the closing "ok" of a conversation. (Only the very next message counts: an old question does not make a later "ok" an answer.)
 */
export function askedJustBefore(context: readonly LiveChatMessage[], fresh: readonly LiveChatMessage[]): boolean {
  const first = fresh[0];
  if (first === undefined) return false;
  const at = context.findIndex((m) => m.id === first.id);
  const before = at > 0 ? context[at - 1] : undefined;
  return before !== undefined && before.dir === 'out' && before.kind === 'text' && /[?؟]/.test(before.text);
}

/**
 * Whether this burst of new incoming messages could need a reply. A sticker, a voice note, a deleted message, or only "ok" and "thanks" do not; anything with
 * words in it might, and the model (or the person) decides. A question always does.
 */
export function needsReply(fresh: readonly LiveChatMessage[], options: { readonly media?: boolean; readonly afterQuestion?: boolean } = {}): ReplyNeed {
  if (fresh.length === 0) return { needed: false, why: 'nothing new' };
  const withWords = fresh.filter((m) => m.kind === 'text' && m.text.trim() !== '');
  if (withWords.length === 0) {
    // (when pictures and documents are looked at, one the person sends is something to answer: what is it, and what do they want done with it)
    if (options.media === true && fresh.some((m) => m.dir === 'in' && (m.kind === 'image' || m.kind === 'document'))) return { needed: true, why: 'a picture or document they sent' };
    const kinds = [...new Set(fresh.map((m) => m.kind))];
    return { needed: false, why: kinds.length === 1 && kinds[0] === 'deleted' ? 'a message that was deleted' : 'no words to answer (a sticker, voice note, picture or deleted message)' };
  }
  if (withWords.some((m) => m.text.includes('?') || m.text.includes('؟'))) return { needed: true, why: 'a question' };
  if (withWords.every((m) => ACKNOWLEDGEMENT.test(m.text.trim()))) {
    // (the question just before them was answered with a word: that is a message to answer, so the chat goes on)
    if (options.afterQuestion === true && withWords.some((m) => ANSWER_WORD.test(m.text.trim()))) return { needed: true, why: 'an answer to the question just asked' };
    return { needed: false, why: 'only an acknowledgement ("ok", "thanks")' };
  }
  return { needed: true, why: 'a message' };
}

// ---------------------------------------------------------------------------------------------------------------------- comparing what was typed with what the page shows
/**
 * A message without its emoji, its joiners and its extra spaces. WhatsApp draws an emoji as a little picture, not as text: what the page gives back for a message Eya sent
 * "Hi! 😊 How are you?" is "Hi! How are you?", so the two are compared WITHOUT emoji — otherwise a lively reply with an emoji in it would never be recognised as the one that
 * was sent (and the live chat would stop as "not sure it went").
 */
export function plainText(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Cf}|\p{Variation_Selector}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------------------------------------------------- what the model may say
const FIGURE = /\d[\d,.:/-]*\d|\d/g;
const LINK = /https?:\/\/\S+|www\.\S+|\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi;

/**
 * A reply may not bring in a figure, a time, an amount, a link or an address that the conversation does not contain: that is a fact made up for the person.
 * Returns what was made up, or null when the reply stays within the conversation. (A one-digit number, like "2", is allowed: "give me 2 minutes".)
 */
export function inventedFacts(reply: string, conversation: string): string | null {
  const known = conversation.toLowerCase().replace(/\s+/g, ' ');
  const figures = (reply.match(FIGURE) ?? []).filter((f) => f.replace(/\D/g, '').length >= 2);
  for (const f of figures) if (!known.includes(f.toLowerCase())) return f;
  for (const l of reply.match(LINK) ?? []) if (!known.includes(l.toLowerCase())) return l;
  return null;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What Eya may not say as herself, because she cannot know it: where the person she writes for is, what they are doing, what they will do ("Rakesh will call you", "he is
 * online now"), or that something is already done ("I told Rakesh", "I have informed him"). "I will tell Rakesh" is exactly what she CAN say, so it is not caught.
 * The strongest models keep to this when told; a small local one does not (measured: "I told Rakesh that you called, and he's now online"), so this is checked on every
 * reply, whoever wrote it. Returns the offending words, or null.
 */
export function claimsAboutOwner(reply: string, owner: string, options: { readonly strict?: boolean; readonly recent?: string } = {}): string | null {
  const name = owner.trim();
  const subject = `(?:${name !== '' ? `${escapeRe(name)}|` : ''}he|she)`;
  const states = 'online|offline|available|unavailable|free|busy|home|here|there|outside|driving|sleeping|eating|working|resting|in\\s+(?:a|the)\\s+\\w+|at\\s+\\w+|on\\s+(?:his|her)\\s+way|coming|back|nearby|ready|reading|looking|watching';
  const filler = '(?:now\\s+|just\\s+|currently\\s+|still\\s+|not\\s+|also\\s+|already\\s+)*';
  const is = new RegExp(`\\b${subject}(?:'s|\\s+is|\\s+was|\\s+will\\s+be|'ll\\s+be|\\s+has\\s+been|\\s+seems\\s+to\\s+be)\\s+${filler}(?:${states})\\b`, 'gi');
  const will = new RegExp(`\\b${subject}(?:\\s+will|'ll|\\s+would|\\s+shall|\\s+is\\s+going\\s+to|'s\\s+going\\s+to|\\s+can|\\s+should)\\s+${filler}(?:definitely\\s+|surely\\s+|soon\\s+|gladly\\s+)?(?:call|come|reply|respond|answer|get\\s+back|meet|talk|visit|join|see|send|help|pay|give|do|contact|message|text|ring|check|handle|arrange|fix|bring|take|go)\\b`, 'gi');
  const done = /\bI(?:'ve|\s+have)?\s+(?:already\s+|just\s+|now\s+)?(?:told|informed|called|rang|sent|messaged|spoke\s+to|talked\s+to|reached|contacted|forwarded|passed|notified|asked)\b/gi;
  // ("I do not know if he is free", "I am not sure whether he will call" say the opposite of a claim: they are exactly what she SHOULD say)
  const hedged = /\b(?:if|whether|know|sure|think|wonder|when|unless|maybe|perhaps|ask)\b/i;
  const patterns = [is, will, done];
  if (options.strict === true) {
    // The small local model, asked "tell me about Rakesh", wrote: "He's a hard worker and takes care of his family. He's also very kind", "I've known him for a long time", "Rakesh is fine, he's
    // been busy with work" — a whole person made up. For it, ANY statement about the person (what they are, have, do, like, know) is a claim; the name's own possessive ("Rakesh's
    // assistant", "Rakesh's accident") is not one. A he/she counts only when the person is the one being talked about (named in the last few lines).
    const verbs = 'is|was|seems|looks|has|had|does|did|takes|works|loves|likes|knows|always|usually|really|likely|must|might|may|got|gets|keeps|stays|lives';
    const talkedAbout = name === '' || new RegExp(escapeRe(name), 'i').test(`${options.recent ?? ''} ${reply}`);
    const forName = name !== '' ? new RegExp(`\\b${escapeRe(name)}\\s+(?:${verbs})\\b`, 'gi') : null;
    const forPronoun = talkedAbout ? new RegExp(`\\b(?:he|she)(?:'s|\\s+(?:${verbs}))\\b`, 'gi') : null;
    const known = /\bI(?:'ve|\s+have)\s+known\s+(?:him|her|them)\b/gi;
    // (an excuse made up for the person's silence: "nobody is free right now")
    const everyone = /\b(?:nobody|no\s+one|everyone|everybody)\s+(?:is|was|are)\b/gi;
    patterns.push(...[forName, forPronoun, known, everyone].filter((re): re is RegExp => re !== null));
  }
  // (a hedge in front excuses "he is free" — "I do not know if he is free" — but not an excuse invented outright, or a claim to have done or known something)
  const unhedged = new Set<RegExp>(patterns.filter((re) => re === done || re.source.startsWith('\\b(?:nobody') || re.source.includes('known')));
  for (const re of patterns) {
    for (const hit of reply.matchAll(re)) {
      const before = reply.slice(Math.max(0, hit.index - 30), hit.index);
      if (!unhedged.has(re) && hedged.test(before)) continue;
      return hit[0].trim();
    }
  }
  return null;
}

/**
 * Is this reply (nearly) the same as one of her last few messages? A small model with nothing new to say says the same thing again ("I was created using a combination of natural
 * language processing and machine learning algorithms…", three times in a row). Exact repeats of the LAST message are `repeatsLast`; this also catches the same thing in other words.
 */
export function repeatsRecently(reply: string, context: readonly LiveChatMessage[], count = 3, similarity = 0.6): boolean {
  const mine = context.filter((m) => m.dir === 'out' && m.kind === 'text' && m.text.trim() !== '').slice(-count);
  return words(reply).length >= 4 && mine.some((m) => wordOverlap(reply, m.text) >= similarity);
}

/**
 * Eya never claims to be a human, and never claims to be the person. A small model asked "are you a bot?" answered "I am a real person" (measured). Returns the offending words, or
 * null. ("I am not a real person, I am Eya" is exactly right, so a "not" in front clears it; "I am Rakesh's assistant" is right too.)
 */
export function claimsToBeHuman(reply: string, owner: string): string | null {
  const name = owner.trim();
  const res = [
    /\bI(?:'m|\s+am)\s+(?:a\s+|an\s+)?(?:(?:real|actual|living)\s+(?:person|human|man|woman|guy|girl|being)|human|person)\b/i,
    /\bI(?:'m|\s+am)\s+not\s+(?:a\s+|an\s+)?(?:bot|robot|ai|machine|computer|assistant)\b/i,
    ...(name !== '' ? [new RegExp(`\\bI(?:'m|\\s+am)\\s+${escapeRe(name)}\\b(?!['’]s)`, 'i')] : []),
  ];
  for (const re of res) {
    const hit = re.exec(reply);
    if (hit !== null) return hit[0].trim();
  }
  return null;
}

const words = (s: string): string[] => plainText(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w !== '');

/** How much two texts share: the words they have in common over the words in either (0 to 1). */
export function wordOverlap(a: string, b: string): number {
  const x = new Set(words(a));
  const y = new Set(words(b));
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

/**
 * A reply that only says their own words back ("Kya kar raha ho? Aaj milte hain kya?" to "Kya kar rahe ho? Aaj milte hain kya?", or those words with "sorry" after them): it answers
 * nothing. Either the two are nearly the same, or the reply contains nearly all of a longer message of theirs.
 */
export function echoesThem(reply: string, fresh: readonly LiveChatMessage[]): boolean {
  if (words(reply).length < 3) return false;
  const theirs = fresh.filter((m) => m.kind === 'text').map((m) => m.text).join(' ');
  if (wordOverlap(reply, theirs) >= 0.7) return true;
  const theirWords = new Set(words(theirs));
  if (theirWords.size < 5) return false;
  const mine = new Set(words(reply));
  let kept = 0;
  for (const w of theirWords) if (mine.has(w)) kept += 1;
  return kept / theirWords.size >= 0.9;
}

/**
 * Does what they wrote ask for something to be handed to the person Eya writes for — "tell Rakesh to call me", "ask him to bring the papers", "call me back", a question about
 * Rakesh by name? The model is asked to notice this itself ("for_owner"); a small one often does not (measured: it left it empty for "Tell Rakesh to answer my calls"). So the words
 * themselves are a second pair of eyes — never the only one: this only ever ADDS a note for the person (their own words, exactly), and never changes what they asked.
 */
export function asksForOwner(text: string, owner: string): boolean {
  const name = owner.trim();
  // (a question about where he is, whether he is free, when he will come: not "is this text by Rakesh or his assistant?", which is a question for HER to answer)
  const aboutHim = name !== '' && /[?؟]/.test(text) && new RegExp(`\\b${escapeRe(name)}\\b`, 'i').test(text) && /\b(?:where|when|what\s+time|how\s+long|free|busy|available|online|around|home|there|coming|reachable|reply|call|come|visit)\b/i.test(text);
  return asksToPassOn(text, owner) || aboutHim;
}

/**
 * The plain request to hand something on: "tell Rakesh …", "let him know …", "ask her to …", "pass this to him", "call me back". The person they mean must come RIGHT after the verb
 * ("tell Rakesh", not "tell me Rakesh's password": that asks Eya to tell THEM, and is exactly what an attempt to get something out of her looks like).
 */
export function asksToPassOn(text: string, owner: string): boolean {
  const name = owner.trim();
  const them = `(?:${name !== '' ? `${escapeRe(name)}|` : ''}him|her|sir|madam|boss|bhai|bro|anna|akka)`;
  const patterns = [
    new RegExp(`\\b(?:tell|inform|remind|ask|message|convey|notify)\\s+(?:to\\s+)?${them}\\b(?!['’]s\\b)`, 'i'),
    new RegExp(`\\blet\\s+${them}\\s+know\\b`, 'i'),
    new RegExp(`\\bgive\\s+${them}\\s+(?:a\\s+|my\\s+|this\\s+|the\\s+)?(?:message|msg|note)\\b`, 'i'),
    new RegExp(`\\bpass(?:\\s+\\w+){0,3}?\\s+to\\s+${them}\\b`, 'i'),
    /\b(?:call|phone|ring|ping|get\s+back\s+to|come\s+to|meet)\s+(?:me|us)\b|\bcall\s+(?:me\s+)?back\b|\b(?:my|our)\s+calls?\b/i,
  ];
  return patterns.some((re) => re.test(text));
}

/**
 * Does the reply PROMISE to pass something on ("I will tell Rakesh", "I'll ask him")? Then there must be something to pass on: a promise with nothing recorded for the person would
 * be untrue. (A small model copies "I don't know that, but I will ask Rakesh" from its example into an ordinary greeting.)
 */
export function promisesToPassOn(reply: string, owner: string): boolean {
  const name = owner.trim();
  const them = `(?:${name !== '' ? `${escapeRe(name)}|` : ''}him|her|them|the\\s+owner)`;
  return new RegExp(`\\bI(?:'ll|\\s+will)\\s+(?:ask|tell|pass|let|inform|remind)\\b[^.?!]{0,40}\\b${them}\\b`, 'i').test(reply);
}

/** Is this reply the very message Eya sent last, word for word? (A small model that is shown "Anything else?" answers "Anything else?".) */
export function repeatsLast(reply: string, context: readonly LiveChatMessage[]): boolean {
  const last = [...context].reverse().find((m) => m.dir === 'out' && m.kind === 'text' && m.text.trim() !== '');
  if (last === undefined) return false;
  const norm = (s: string): string => plainText(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  const a = norm(reply);
  return a !== '' && a === norm(last.text);
}

/** A phrase about a file in a transcript, on ONE line, with nothing in it that could pass for the transcript's own marks (a bracket, a line break). */
const mediaWords = (s: string, max: number): string => s.replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function mediaLine(m: LiveChatMessage, note: MediaNote | undefined): string {
  if (note === undefined || note.status === 'skipped') return `[${m.kind}]`;
  const what = note.kind === 'image' ? 'picture' : `document "${mediaWords(note.name, 80)}"`;
  const who = m.dir === 'in' ? 'they sent' : 'I sent';
  if (note.status === 'read' && note.summary !== '') return `[${what} ${who} — it shows or says: ${mediaWords(note.summary, 300)}]`;
  if (note.status === 'failed') return `[${what} ${who} — I could not open it]`;
  return `[${what} ${who} — saved, but I could not read it]`;
}

/**
 * The last messages of the chat as lines for the model: who said it, and only text (a sticker or voice note is said as such, never described; a picture or document that
 * was looked at is said as what was found in it).
 */
export function transcript(messages: readonly LiveChatMessage[], max = MAX_CONTEXT, media: Readonly<Record<string, MediaNote>> = {}, me: string | ((m: LiveChatMessage) => string) = 'Me'): string[] {
  const label = (m: LiveChatMessage): string => (m.dir === 'in' ? 'Them' : typeof me === 'string' ? me : me(m));
  return messages.slice(-max).map((m) => `${label(m)}: ${m.kind === 'text' ? m.text.replace(/\s+/g, ' ').trim() : mediaLine(m, media[m.id])}`);
}

/** The rolling context kept for the session: the last messages, with each id once, in order. */
export function rollContext(context: readonly LiveChatMessage[], read: readonly LiveChatMessage[], max = MAX_CONTEXT): LiveChatMessage[] {
  const byId = new Map<string, LiveChatMessage>();
  for (const m of [...context, ...read]) byId.set(m.id, m);
  const ordered: LiveChatMessage[] = [];
  // (the order is the page's: what was read last is the truth for the messages it still shows; older ones keep their place before them)
  const readIds = new Set(read.map((m) => m.id));
  for (const m of context) if (!readIds.has(m.id)) ordered.push(m);
  for (const m of read) ordered.push(byId.get(m.id) ?? m);
  return ordered.slice(-max);
}

/** The incoming messages in what was read that have not been looked at, oldest first. */
export function unhandled(tracker: Tracker, read: readonly LiveChatMessage[]): LiveChatMessage[] {
  const handled = new Set(tracker.handled);
  return read.filter((m) => m.dir === 'in' && !handled.has(m.id));
}
