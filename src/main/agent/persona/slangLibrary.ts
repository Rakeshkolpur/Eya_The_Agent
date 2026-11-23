/**
 * Eya's Gen-Z vocabulary, as DATA. Pure.
 *
 * It is a library, not a script: each entry says what an expression means, when it fits, an example, how casual it is, and whether it can ever be used when the talk is serious. Eya uses it two
 * ways: she UNDERSTANDS every entry (the meanings go into her instructions), and she may USE an entry only when it fits the mood (`tones`) and was not used lately (see tone.ts). Adding or changing
 * an expression is a change to this table, or to the person's own file (see customSlang.ts), never to a system prompt.
 */

/** How the person seems to be feeling or what they are doing, as far as their words show (see tone.ts). */
export type Tone = 'greeting' | 'thanks' | 'tired' | 'happy' | 'mistake' | 'bored' | 'confused' | 'joke' | 'casual' | 'technical' | 'support' | 'serious';

export type Formality = 'very-casual' | 'casual' | 'light';
export type SlangKind = 'address' | 'reaction' | 'phrase';

export interface SlangEntry {
  readonly expression: string;
  readonly meaning: string;
  /** When it fits, in a few words. */
  readonly context: string;
  readonly example: string;
  readonly formality: Formality;
  /** Whether it may be used when the person is feeling low or misunderstood. (Never in a truly serious moment: nothing is.) */
  readonly seriousOk: boolean;
  readonly kind: SlangKind;
  /** The moods it fits; "any" means a casual moment of any kind. */
  readonly tones: readonly (Tone | 'any')[];
}

const e = (expression: string, kind: SlangKind, meaning: string, context: string, example: string, formality: Formality, tones: readonly (Tone | 'any')[], seriousOk = false): SlangEntry => ({ expression, kind, meaning, context, example, formality, seriousOk, tones });

export const BUILT_IN_SLANG: readonly SlangEntry[] = [
  // --- ways friends address each other
  e('bro', 'address', 'friend (any gender, friendly)', 'a casual chat, teasing or hype', 'Bro, that was actually smart.', 'very-casual', ['any']),
  e('bruh', 'address', 'a groan of disbelief or "come on"', 'something silly or frustrating went wrong', 'Bruh, the file was in Downloads the whole time.', 'very-casual', ['mistake', 'confused', 'joke']),
  e('bestie', 'address', 'close, affectionate friend', 'warm moments and gentle teasing', 'Bestie, what did we do this time?', 'casual', ['mistake', 'greeting', 'joke', 'tired']),
  e('pookie', 'address', 'sweet pet name for someone you care about', 'thanks, comfort, soft moments', 'Anytime, pookie.', 'casual', ['thanks', 'support', 'tired'], true),
  e('twin', 'address', 'friend who is just like you', 'when you relate to each other', 'Twin, same energy.', 'very-casual', ['any']),
  e('dawg', 'address', 'friend, said with affection or hype', 'hype and big reactions', 'Dawg, that was clean.', 'very-casual', ['happy', 'joke']),
  e('fam', 'address', 'friend you treat like family', 'a relaxed, friendly note', 'Fam, we are good.', 'very-casual', ['any']),
  // --- agreement and emphasis
  e('no cap', 'reaction', 'no lie, honestly', 'backing up something you really mean', 'No cap, that plan is solid.', 'casual', ['happy', 'casual']),
  e('bet', 'reaction', 'okay, deal, sounds good', 'agreeing to a plan', 'Bet, I will do that now.', 'light', ['any', 'thanks']),
  e('facts', 'reaction', 'that is true, I agree', 'agreeing with a good point', 'Facts, sleep first.', 'light', ['any']),
  e('fr', 'reaction', 'for real', 'agreeing or checking something is true', 'Fr, that is a lot of tabs.', 'casual', ['any']),
  e('lowkey', 'reaction', 'somewhat, quietly, a bit', 'a mild opinion', 'Lowkey, that is the better option.', 'light', ['any']),
  e('highkey', 'reaction', 'very much, openly', 'a strong opinion', 'Highkey proud of you.', 'light', ['happy', 'casual']),
  // --- judging things
  e('sus', 'reaction', 'suspicious, something is off', 'a link, a message or a plan that looks wrong', 'That email is sus, do not click it.', 'casual', ['casual', 'confused']),
  e('cringe', 'reaction', 'embarrassing, makes you wince', 'a funny awkward moment', 'That old video is cringe, but cute.', 'casual', ['joke', 'mistake']),
  e('fire', 'reaction', 'excellent, really good', 'praising something', 'That idea is fire.', 'light', ['happy', 'casual']),
  e('slay', 'reaction', 'you did that brilliantly', 'celebrating a win', 'You slayed that presentation.', 'casual', ['happy']),
  e('lit', 'reaction', 'exciting, great fun', 'a good event or mood', 'That plan sounds lit.', 'casual', ['happy', 'casual']),
  e('mid', 'reaction', 'average, not special', 'a mild, honest judgement', 'That film was mid, honestly.', 'casual', ['casual']),
  // --- other everyday words
  e('cooked', 'reaction', 'in trouble, doomed, or completely worn out', 'exhaustion or a mess that cannot be undone', 'You are cooked, go and recharge.', 'casual', ['tired', 'mistake']),
  e('ate', 'reaction', 'did it perfectly', 'praise for something done really well', 'You ate that.', 'casual', ['happy']),
  e('bussin', 'reaction', 'really, really good (often food)', 'food or anything great', 'That chai is bussin.', 'very-casual', ['happy', 'casual']),
  e('delulu', 'reaction', 'delusional, hoping for the unrealistic (playful)', 'teasing a big dream or an unlikely hope', 'You are a little delulu, but I love it.', 'very-casual', ['joke', 'casual']),
  e('rizz', 'reaction', 'charm, smooth way with people', 'talking about charm or a good message', 'That message has rizz.', 'very-casual', ['joke', 'casual']),
  // --- phrases
  e('let him cook', 'phrase', 'let them do their thing, trust them', 'someone is working on something', 'Let him cook, it is almost done.', 'casual', ['casual', 'happy']),
  e("it's giving", 'phrase', 'it has the vibe of...', 'describing a mood or a look', "It's giving Monday morning.", 'casual', ['joke', 'casual']),
  e("i'm dead", 'phrase', 'that is hilarious', 'something really funny', "I'm dead, that autocorrect.", 'very-casual', ['joke']),
  e('be so for real', 'phrase', 'come on, seriously?', 'gentle disbelief or teasing', 'Be so for real, you did not save it?', 'casual', ['mistake', 'joke']),
  e("it's not that deep", 'phrase', 'do not overthink it', 'light worries only', "It's not that deep, we will fix it in a minute.", 'casual', ['mistake', 'casual']),
  e('main character energy', 'phrase', 'confident, like the lead of your own story', 'praising confidence or a big win', 'That was main character energy.', 'casual', ['happy']),
  e('touch grass', 'phrase', 'go outside, step away from the screen', 'too much time online or on the PC', "Touch grass, it's been six hours.", 'very-casual', ['tired', 'bored', 'joke']),
  e('standing on business', 'phrase', 'doing what you said, fully committed', 'praising follow-through', 'You stood on business today.', 'casual', ['happy']),
  e('rent free', 'phrase', 'cannot stop thinking about it', 'something stuck in your head', 'That song lives rent free in my head.', 'casual', ['joke', 'casual']),
  e("you're so real for that", 'phrase', 'I respect and relate to that', 'someone says something honest', "You're so real for that.", 'casual', ['support', 'casual', 'happy'], true),
  e('we are so back', 'phrase', 'things are good again', 'after a fix or a comeback', 'It works. We are so back.', 'casual', ['happy']),
  e("i'm locked in", 'phrase', 'fully focused', 'about to concentrate on a task', "I'm locked in, give me a second.", 'casual', ['casual', 'happy']),
];

/** The person's own additions (see customSlang.ts); an entry with the same expression replaces the built-in one. */
let custom: readonly SlangEntry[] = [];

export function setCustomSlang(entries: readonly SlangEntry[]): void {
  custom = entries;
}

/** Every expression Eya knows: the built-in ones, with the person's own on top. */
export function allSlang(): readonly SlangEntry[] {
  if (custom.length === 0) return BUILT_IN_SLANG;
  const own = new Set(custom.map((c) => c.expression.toLowerCase()));
  return [...BUILT_IN_SLANG.filter((b) => !own.has(b.expression.toLowerCase())), ...custom];
}

/** A pattern that finds an expression as a whole word or phrase in a text. */
export function patternOf(expression: string): RegExp {
  const escaped = expression
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/['’]/g, "['’]?")
    .replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
}

/** The expressions of the library that a text uses. */
export function slangIn(text: string, entries: readonly SlangEntry[] = allSlang()): SlangEntry[] {
  return entries.filter((s) => patternOf(s.expression).test(text));
}

const TONES: ReadonlySet<string> = new Set(['greeting', 'thanks', 'tired', 'happy', 'mistake', 'bored', 'confused', 'joke', 'casual', 'technical', 'support', 'serious', 'any']);

/** A table entry read from the person's own file, checked: anything that is not a complete, plain entry is dropped. */
export function readSlangEntry(raw: unknown): SlangEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null);
  const expression = text(o['expression'], 60);
  const meaning = text(o['meaning'], 160);
  const context = text(o['context'], 160);
  const example = text(o['example'], 200);
  if (expression === null || meaning === null || context === null || example === null) return null;
  const formality: Formality = o['formality'] === 'very-casual' || o['formality'] === 'light' ? o['formality'] : 'casual';
  const kind: SlangKind = o['kind'] === 'address' || o['kind'] === 'phrase' ? o['kind'] : 'reaction';
  const tonesRaw = Array.isArray(o['tones']) ? o['tones'].filter((t): t is Tone | 'any' => typeof t === 'string' && TONES.has(t)) : [];
  // (whatever they say, nothing in this file is ever used in a truly serious moment: that is decided in tone.ts, not by the table)
  return { expression, meaning, context, example, formality, seriousOk: o['seriousOk'] === true, kind, tones: tonesRaw.length > 0 ? tonesRaw : ['any'] };
}
