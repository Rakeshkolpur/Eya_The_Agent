import { allSlang, slangIn } from './slangLibrary';
import type { SlangEntry, Tone } from './slangLibrary';

/**
 * Reading the room, and keeping the slang natural. Pure, rule-based, and instant: no AI call, so it adds no delay.
 *
 * `detectTone` says what kind of moment this is from the person's words (and the last few things they said: a serious moment is not left behind just because the next message is short).
 * `recentUse` counts the slang and emoji Eya used in her last replies, and `slangPlan` turns the two into a plain instruction for THIS reply: how much slang (none, or at most one), which
 * expressions not to repeat, and a few that would fit. The model is told, and the table is the only place the words live.
 */

export interface Line {
  readonly who: 'user' | 'eya';
  readonly text: string;
}

const SERIOUS =
  /\b(died|passed away|funeral|cancer|hospital|icu|surgery|accident|suicid\w*|kill myself|end my life|self[- ]?harm|abus(e|ed|ive)|assault\w*|rape\w*|miscarriage|diagnos\w+|lost my (job|father|mother|dad|mom|brother|sister|wife|husband|son|daughter|baby|friend)|bankrupt\w*|panic attack|can'?t breathe|emergency|threat(en\w*|s)?|harass\w*|blackmail\w*|funeral|grief|grieving|mourning)\b/i;

const SUPPORT =
  /\b(nobody|no one) (understands|gets|cares|listens|knows)\b|\bi feel (alone|lonely|empty|lost|useless|worthless|hopeless|invisible|like a failure)\b|\b(depress\w*|anxious|anxiety|stressed out|overwhelmed|burn(ed|t)? ?out|hopeless|worthless|heartbroken|lonely)\b|\bcan'?t take (it|this) anymore\b|\bi give up\b|\btired of everything\b|\bi hate my life\b|\b(so sad|crying|cried)\b|\bnot okay\b|\bnot ok\b/i;

const TIRED = /\b(exhaust\w*|tired|sleepy|drained|worn out|no energy|can'?t keep my eyes|dead tired)\b/i;

const HAPPY =
  /\b(i (just )?(finished|completed|passed|won|cleared|did it|made it|nailed|solved|fixed|cracked|got (the|a|an|my) \w+)|finally (done|finished|got|passed|worked)|good news|got (promoted|selected)|it worked|we won|so happy|excited|yay|hurray)\b/i;

const MISTAKE = /\b(made a mistake|messed up|screwed up|my bad|oops|i (deleted|lost|broke|forgot)|i was wrong|by mistake|wrong (file|mail|number|person))\b/i;

const BORED = /\b(bored|boring|nothing to do|so dull)\b/i;

const CONFUSED = /\b(confused|i don'?t (get|understand)|makes no sense|what do you mean|you lost me|no idea what)\b/i;

const THANKS = /\b(thanks|thank you|thx|thank u|tysm|much appreciated|ty)\b/i;

const GREETING = /^\W*(hi+|hello+|hey+|yo+|hola|sup|wassup|namaste|howdy|good (morning|afternoon|evening)|what'?s up|how are you|how r u)(\s+(eya|there|buddy))?\W*$/i;

const JOKE = /\b(lol|lmao|rofl|haha+|hehe+|joke|funny)\b|😂|🤣|💀/i;

const TECHNICAL =
  /\b(how (do|can|to|does|would|should)|why (is|does|do|did)|explain|difference between|error|exception|bug|code|function|install|configure|api|database|server|script|regex|algorithm|compile|debug|docker|git|python|javascript|formula|calculate|convert|section \d+|article \d+|ipc|crpc|bnss|bns|affidavit|writ|jurisdiction|petition|bail (application|provision)|limitation|precedent|windows (setting|update)|what (is|are|does) (a|an|the)\b)/i;

const SEVERITY: Readonly<Record<Tone, number>> = { serious: 3, support: 2, technical: 1, confused: 1, tired: 0, happy: 0, mistake: 0, bored: 0, joke: 0, thanks: 0, greeting: 0, casual: 0 };

/** What one message is, on its own. */
export function toneOf(text: string): Tone {
  const t = text.trim();
  if (t === '') return 'casual';
  if (SERIOUS.test(t)) return 'serious';
  if (SUPPORT.test(t)) return 'support';
  if (GREETING.test(t)) return 'greeting';
  if (HAPPY.test(t)) return 'happy';
  if (MISTAKE.test(t)) return 'mistake';
  if (TIRED.test(t)) return 'tired';
  if (BORED.test(t)) return 'bored';
  if (CONFUSED.test(t)) return 'confused';
  if (TECHNICAL.test(t) && (t.length > 18 || /\?$/.test(t))) return 'technical';
  // (a plain question about a fact: who, what, when, where, which, why, how)
  if (/^(who|what|when|where|which|why|how)\b/i.test(t) && /\?\s*$/.test(t) && t.length > 18) return 'technical';
  if (THANKS.test(t) && t.length < 60) return 'thanks';
  if (JOKE.test(t)) return 'joke';
  return 'casual';
}

/**
 * The mood of this moment: what they just said, unless one of their last two messages was serious or low (then it stays that way until they clearly lighten it: a joke, good news, a
 * greeting). A "thanks" or an "ok" after a heavy moment is not a cue to start joking.
 */
/** A message that lifts the mood: good news, a laugh, a greeting, or slang of their own (two words of it, so one "bro" in a sad message does not count). */
const lifts = (text: string): boolean => {
  const t = toneOf(text);
  return t === 'happy' || t === 'joke' || t === 'greeting' || slangIn(text).length >= 2;
};

export function detectTone(text: string, history: readonly Line[] = []): Tone {
  const now = toneOf(text);
  // The last two things they said, newest first: a heavy one counts only if nothing after it lifted the mood ("haha ok that helped" ends it).
  let heaviest: Tone = 'casual';
  for (const line of history.filter((l) => l.who === 'user').slice(-2).reverse()) {
    if (lifts(line.text)) break;
    const t = toneOf(line.text);
    if (SEVERITY[t] > SEVERITY[heaviest]) heaviest = t;
  }
  if ((heaviest === 'serious' || heaviest === 'support') && SEVERITY[now] < SEVERITY[heaviest] && !lifts(text)) return heaviest;
  return now;
}

/** One instruction for the mood: how to answer this person right now. */
export const TONE_LINE: Readonly<Record<Tone, string>> = {
  greeting: 'They are greeting you: one short, warm, curious line that asks what the vibe or plan is today. Do not list what you can do.',
  thanks: 'They thanked you: a brief, easy "anytime" kind of reply, nothing more.',
  tired: 'They are worn out: be sympathetic first and light second, and tell them to rest or recharge.',
  happy: 'They did something good: celebrate it with real energy in one line and tell them you are proud.',
  mistake: 'They made a mistake: tease them gently in one line, then ask what happened and help; never make them feel bad.',
  bored: 'They are bored: be playful and ask what the plan is, or suggest something to do.',
  confused: 'They are confused: slow down and explain simply and kindly; no slang.',
  joke: 'They are joking: joke back briefly.',
  casual: 'Casual chat: short and natural, with friendly teasing if it fits.',
  technical: 'A real question: put the clear, simple, accurate answer first, in a friendly tone with no slang.',
  support: 'They sound low or misunderstood: be mature, warm and attentive; no jokes; tell them you are listening and ask what is going on; one gentle pet name at most.',
  serious: 'A serious or sensitive moment: be mature, kind and respectful; no jokes, no slang, no pet names, no emoji; listen and help.',
};

/** Moods in which slang is never used. */
const NO_SLANG: ReadonlySet<Tone> = new Set(['serious', 'technical', 'confused']);

const EMOJI = /\p{Extended_Pictographic}/u;

export interface RecentUse {
  /** The expressions in Eya's last few replies, most recent first. */
  readonly expressions: readonly string[];
  /** Whether her very last reply had slang, or an emoji. */
  readonly lastHadSlang: boolean;
  readonly lastHadEmoji: boolean;
  /** How many of her last three replies had slang. */
  readonly slangReplies: number;
}

/** What Eya has been saying lately, from the conversation so far. */
export function recentUse(history: readonly Line[], entries: readonly SlangEntry[] = allSlang()): RecentUse {
  const replies = history.filter((l) => l.who === 'eya').slice(-3).reverse();
  const used = replies.map((l) => slangIn(l.text, entries).map((s) => s.expression));
  return {
    expressions: [...new Set(used.flat())],
    lastHadSlang: (used[0]?.length ?? 0) > 0,
    lastHadEmoji: replies[0] !== undefined && EMOJI.test(replies[0].text),
    slangReplies: used.filter((u) => u.length > 0).length,
  };
}

export interface SlangPlan {
  /** How many expressions this reply may use. */
  readonly budget: 0 | 1;
  readonly emoji: boolean;
  readonly avoid: readonly string[];
  readonly ideas: readonly string[];
  readonly why: string;
}

/** A small deterministic number from a text, so that the ideas offered change from one message to the next without any randomness (and tests are stable). */
function seedOf(text: string): number {
  let h = 7;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * How much slang this reply may have. None in a serious, technical or confused moment; none when her last reply already had some (so it is every other reply at most, like a real
 * friend), unless the person is using slang themselves; and the expressions of her last replies are never offered again.
 */
export function slangPlan(tone: Tone, text: string, history: readonly Line[], entries: readonly SlangEntry[] = allSlang()): SlangPlan {
  const recent = recentUse(history, entries);
  const mirrors = slangIn(text, entries).length > 0;
  const avoid = recent.expressions;
  const soft = tone === 'support';
  let budget: 0 | 1 = 1;
  let why = 'a little slang is fine if it fits';
  if (NO_SLANG.has(tone) || tone === 'serious') {
    budget = 0;
    why = 'this is not the moment for slang';
  } else if (soft) {
    budget = 0;
    why = 'be gentle; no slang';
  } else if (recent.lastHadSlang && !mirrors) {
    budget = 0;
    why = 'you used slang in your last reply, so none this time';
  }
  const allowed = entries.filter((s) => !avoid.includes(s.expression) && (s.tones.includes(tone) || s.tones.includes('any')) && (soft ? s.seriousOk : true));
  const start = allowed.length === 0 ? 0 : seedOf(`${text}|${history.length}`) % allowed.length;
  const rotated = [...allowed.slice(start), ...allowed.slice(0, start)];
  const ideas = budget === 0 && !soft ? [] : rotated.slice(0, 4).map((s) => s.expression);
  const emoji = tone !== 'serious' && tone !== 'technical' && tone !== 'confused' && tone !== 'support' && !recent.lastHadEmoji;
  return { budget, emoji, avoid, ideas, why };
}
