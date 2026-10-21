import type { LocalCommandResult } from '@main/local/LocalCommands';
import type { ReferenceService } from './ReferenceService';

/**
 * Teaching and using references by voice, at once and without the model: "learn this document as my writ petition", "what have you
 * learned", "format this like my writ petition". Only these exact phrasings; never from always-on listening (they read and change the
 * user's document). Filling a half-done document needs the model and goes through the word_reference tool.
 */
export type ReferenceIntent =
  | { readonly kind: 'learn'; readonly name: string | undefined }
  | { readonly kind: 'list' }
  | { readonly kind: 'format'; readonly name: string };

const clean = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[.,!?;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:hey |ok |okay )?eya /, '')
    .replace(/^(?:please|can you|could you|kindly) /, '')
    .replace(/ (?:please|now|for me)$/, '')
    .trim();

const NOUN = '(?:document|file|petition|draft|one|word file|word document|doc)';
const TRAILING = '(?: (?:as )?(?:a |the |my )?(?:reference|template|sample|model|example)(?: (?:document|file))?)?';

/** The name the user gave, without "my" / "a" / "reference": "my writ petition template" -> "writ petition"; "a reference" -> no name. */
const tidyName = (s: string | undefined): string | undefined => {
  const n = (s ?? '').replace(/^(?:a|an|the|my)\s+/, '').replace(/\s+(?:reference|template|sample|model|example)$/, '').trim();
  return /^(?:|a|an|the|my|reference|template|sample|model|example)$/.test(n) ? undefined : n;
};

export function parseReferenceIntent(raw: string): ReferenceIntent | null {
  const text = clean(raw);
  if (text === '' || text.split(' ').length > 18) return null;

  // "learn this document as my writ petition" / "remember this file as a reference" / "use this petition as my template"
  let m = new RegExp(`^(?:learn|study|remember|save|keep|memorize|memorise|use|take)(?: from)? (?:this|that|the open|the current) ${NOUN}(?: as (.+?))?${TRAILING}$`).exec(text);
  if (m !== null) return { kind: 'learn', name: tidyName(m[1]) };
  m = new RegExp(`^(?:this is|here is|here's) (?:my|a|the) (?:old |finished |final |sample |reference )?${NOUN}(?: (?:for|as) (.+?))?(?: (?:reference|template|sample))? (?:learn|remember|study) (?:it|this)$`).exec(text);
  if (m !== null) return { kind: 'learn', name: tidyName(m[1]) };
  m = /^(?:learn|study|remember) (?:how i wrote|how this is written|this reference|this template)(?: as (.+))?$/.exec(text);
  if (m !== null) return { kind: 'learn', name: tidyName(m[1]) };

  if (/^(?:what|which) (?:references|templates|samples|documents|petitions) (?:have you|did you|do you) (?:learned|learnt|learn|remembered|remember|studied|study|saved|save|know)$/.test(text)) return { kind: 'list' };
  if (/^(?:list|show|tell me) (?:my |the )?(?:references|reference documents|templates|samples)$/.test(text)) return { kind: 'list' };
  if (/^what (?:have you|did you) (?:learned|learnt|remembered)$/.test(text)) return { kind: 'list' };

  // "format this like my writ petition" / "make this look like the writ petition" / "apply the writ petition format"
  m = new RegExp(`^(?:format|style|lay out|layout|set up|arrange)(?: (?:this|that|it|the)(?: ${NOUN})?)? (?:like|as|the same as|according to) (?:my |the |a )?(.+?)$`).exec(text);
  if (m !== null && m[1] !== undefined) return { kind: 'format', name: tidyName(m[1]) ?? m[1] };
  m = new RegExp(`^make (?:this|it|the ${NOUN}) (?:look |format(?:ted)? |be )?(?:like|as|the same as) (?:my |the |a )?(.+?)$`).exec(text);
  if (m !== null && m[1] !== undefined) return { kind: 'format', name: tidyName(m[1]) ?? m[1] };
  m = /^apply (?:my |the )?(.+?) (?:format|formatting|layout|style)(?: to (?:this|it|the|this document|the document|this file|this petition))?$/.exec(text);
  if (m !== null && m[1] !== undefined) return { kind: 'format', name: tidyName(m[1]) ?? m[1] };
  return null;
}

export interface ReferenceCommandsHost {
  readonly service: Pick<ReferenceService, 'learn' | 'list' | 'applyFormat'>;
  /** Whether Word is the window the user is working in (the open document is the one meant by "this"). */
  wordIsInFront(): Promise<boolean>;
}

const reply = (spoken: string, ok: boolean): LocalCommandResult => ({ spoken, ok, intent: 'word_reference', tools: [], refs: [] });

/** "Synopsis page 2, list of dates and events page 3 …": short enough to say aloud. */
function spokenMap(sections: ReadonlyArray<{ title: string; startPage?: number; words: number; tableRows: number }>): string {
  const bits = sections
    .filter((s) => (s.words > 0 || s.tableRows > 0) && s.startPage !== undefined && s.startPage > 0)
    .slice(0, 8)
    .map((s) => `${s.title.toLowerCase().replace(/\s+/g, ' ')} on page ${s.startPage}`);
  return bits.join(', ');
}

export class ReferenceCommands {
  constructor(private readonly host: ReferenceCommandsHost) {}

  async tryHandle(text: string, options: { readonly live?: boolean } = {}): Promise<LocalCommandResult | null> {
    if (options.live === true) return null;
    const intent = parseReferenceIntent(text);
    if (intent === null) return null;

    if (intent.kind === 'list') {
      const all = this.host.service.list();
      if (all.length === 0) return reply('I have not learned any reference yet. Open a finished document in Word and say: learn this document as my writ petition.', true);
      return reply(`I know ${all.length === 1 ? 'one reference' : `${all.length} references`}: ${all.map((r) => `${r.name}, ${r.pages} pages`).join('; ')}.`, true);
    }

    // "this" is the document in Word: only when Word is what the user is working in
    if (!(await this.host.wordIsInFront())) return null;

    if (intent.kind === 'learn') {
      const got = await this.host.service.learn(intent.name, undefined);
      if (!got.ok) return reply(`I could not learn it: ${got.why}.`, false);
      const r = got.reference;
      const where = spokenMap(r.sections);
      return reply(`Learned ${r.name}: ${r.source.pages} pages and ${r.sections.length} parts. ${where !== '' ? `${where.charAt(0).toUpperCase()}${where.slice(1)}. ` : ''}Tell me if I have any part wrong.`, true);
    }

    const done = await this.host.service.applyFormat(intent.name, 'all');
    if (!done.ok) return reply(`${done.why}.`, false);
    return reply(`Done. This document is laid out like ${done.reference}: ${done.applied.join(', ')}. Ctrl Z takes it back.`, true);
  }
}
