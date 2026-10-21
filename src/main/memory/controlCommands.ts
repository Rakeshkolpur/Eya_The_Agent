import { normalizeKey, normalizeUtterance } from './normalize';
import type { MemoryType } from './types';

/**
 * The phrases a person uses to manage Eya's memory ("what do you remember?", "show my routines", "forget this routine",
 * "remember that Ravi is my brother's contact", "save this as a routine"). Recognised by plain patterns, so they work instantly,
 * offline, and never cost a model call.
 */

export type ControlIntent =
  | { readonly kind: 'list_memories' }
  | { readonly kind: 'list_routines' }
  | { readonly kind: 'forget_routine'; readonly name: string | null }
  | { readonly kind: 'save_routine'; readonly name: string | null }
  | { readonly kind: 'remember'; readonly type: MemoryType; readonly key: string; readonly value: string }
  | { readonly kind: 'remember_this' }
  | { readonly kind: 'dont_remember' }
  | { readonly kind: 'forget_memory'; readonly key: string }
  | { readonly kind: 'yes' }
  | { readonly kind: 'no' };

const YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|please|do it|go ahead|save it|yes save it|yes please|sounds good|why not|absolutely|of course|confirm|delete it|yes delete it|yes delete)(?: please)?$/;
const NO = /^(?:no|nope|nah|not now|no thanks|no thank you|dont|do not|cancel|never mind|nevermind|skip|skip it|maybe later|leave it|keep it)$/;

const PREFERENCE_START = /^(?:always|never|by default|i prefer|prefer|whenever|my default|default to|i like (?:you )?to|use|i want (?:you )?to (?:always|never))\b/;
const FACT_VERBS = /^(.{2,60}?)\s+(?:is|are|was|were|means|lives|works|has|have|stays|owns|drives|uses|likes|loves|hates|born|called|named)\s+.+$/;

function words(text: string, max: number): string {
  return text.split(' ').filter((w) => w !== '').slice(0, max).join(' ');
}

/** Splits "Always save downloaded PDFs to Desktop" / "Ravi is my brother's contact" into a short key and the full statement. */
export function parseRemember(statement: string): { type: MemoryType; key: string; value: string } | null {
  const value = statement.trim().replace(/[.!\s]+$/, '');
  if (value === '') return null;
  const plain = normalizeKey(value);
  if (plain === '') return null;
  if (PREFERENCE_START.test(plain)) {
    // The key is what the preference is ABOUT ("save downloaded pdfs"), not where it goes, so a changed mind updates it.
    const about = plain.replace(/^(?:always|never|by default|i prefer to|i prefer|prefer to|prefer|whenever|my default|default to|i like you to|i like to|use|i want you to always|i want you to never|i want to always|i want to never)\s+/, '');
    const split = /^(.+?)\s+(?:to|in|on|as|with|using|at|for)\s+.+$/.exec(about);
    const key = words(split?.[1] ?? about, 6);
    return { type: 'preference', key: key === '' ? words(plain, 6) : key, value };
  }
  const fact = FACT_VERBS.exec(plain);
  return { type: 'fact', key: words(fact?.[1] ?? plain, 5), value };
}

/** Pulls the statement out of "remember that …", "please remember: …", "note that …", "keep in mind that …". */
function rememberedStatement(raw: string): string | null {
  const m = /^\s*(?:hey eya[,.]?\s*|eya[,.]?\s*)?(?:please\s+)?(?:remember(?:\s+that)?|note(?:\s+that)?|keep in mind(?:\s+that)?|don'?t forget(?:\s+that)?)\s*[:,-]?\s+(.+)$/i.exec(raw.trim());
  return m?.[1]?.trim() ?? null;
}

/**
 * What, if anything, this is — among the memory-management phrases. `pending` says whether Eya just asked a yes/no question about
 * memory (save this routine? delete that one?): only then is a bare "yes" or "no" hers to take.
 */
export function parseControl(raw: string, pending: boolean): ControlIntent | null {
  const text = normalizeUtterance(raw);
  if (text === '') return null;

  if (pending) {
    if (YES.test(text)) return { kind: 'yes' };
    if (NO.test(text)) return { kind: 'no' };
  }

  if (/^(?:what (?:do|did) you (?:remember|know|have saved)(?: about me)?|what have you (?:remembered|saved|learned)(?: about me)?|what do you remember about me|what are my (?:saved )?(?:memories|preferences)|(?:show|list|tell) (?:me )?(?:my |all )?(?:saved )?(?:memories|memory|preferences|facts)|what is in your memory|show what you remember|what do you remember)$/.test(text)) {
    return { kind: 'list_memories' };
  }
  if (/^(?:(?:show|list|tell|read) (?:me )?(?:all )?(?:my |the )?(?:saved )?(?:routines|skills|routine list)|what (?:routines|skills) do i have|what (?:routines|skills) (?:have i|did i) (?:saved|made)|(?:show|list) (?:me )?what routines you know|my routines|my saved routines)$/.test(text)) {
    return { kind: 'list_routines' };
  }

  const forgetRoutine = /^(?:forget|delete|remove|erase|drop)(?: about)?(?: (?:this|that|the last|the))? (?:routine|skill)(?: (?:called|named))?(?: (.+))?$/.exec(text);
  if (forgetRoutine !== null) {
    const name = forgetRoutine[1]?.trim() ?? '';
    return { kind: 'forget_routine', name: name === '' || name === 'this' || name === 'that' ? null : name };
  }
  const forgetNamed = /^(?:forget|delete|remove) (?:the )?(.+?) routine$/.exec(text);
  if (forgetNamed !== null) return { kind: 'forget_routine', name: forgetNamed[1] === 'this' || forgetNamed[1] === 'that' ? null : (forgetNamed[1] ?? null) };

  const saveRoutine = /^(?:save|keep|store|remember|make) (?:this|that|it|what you just did)(?: as)?(?: a)? routine(?: (?:called|named) (.+))?$/.exec(text) ?? /^(?:save|remember) (?:this|that) as (?:a )?routine(?: (?:called|named) (.+))?$/.exec(text);
  if (saveRoutine !== null) return { kind: 'save_routine', name: saveRoutine[1]?.trim() || null };
  if (/^(?:save|remember) (?:this|that) (?:task|workflow|flow)$/.test(text)) return { kind: 'save_routine', name: null };

  if (/^(?:dont|do not|never) (?:remember|save|keep|store|learn) (?:this|that|it)(?: as a routine)?(?: again)?$/.test(text) || /^(?:no )?(?:dont|do not) (?:ask|offer|suggest)(?: me)?(?: about)?(?: this| that)?(?: again)?$/.test(text) || /^forget (?:this|that|it)$/.test(text)) {
    return { kind: 'dont_remember' };
  }

  if (/^(?:remember|note|keep in mind) (?:this|that|it)$/.test(text)) return { kind: 'remember_this' };
  const statement = rememberedStatement(raw);
  if (statement !== null) {
    const parsed = parseRemember(statement);
    if (parsed !== null) return { kind: 'remember', ...parsed };
  }

  // Only "forget": "delete that file" must never be taken for a memory command. (The service also checks something by that name is remembered.)
  const forgetMemory = /^forget (?:about |that |what i said about |what you know about |my )?(.{2,80})$/.exec(text);
  if (forgetMemory !== null && !/\b(?:routine|skill|everything|all)\b/.test(forgetMemory[1] as string)) return { kind: 'forget_memory', key: (forgetMemory[1] as string).trim() };
  return null;
}
