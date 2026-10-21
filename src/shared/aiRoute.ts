/**
 * Which AI is answering Eya's requests right now, and why: what the interface shows next to the AI's name.
 *
 * The chain of providers (Gemini, then the user's backups in order, then a local Ollama) knows this at every moment; this turns it
 * into what a person needs — "Gemini connected", or "OpenRouter · nemotron-3-super-120b-a12b — Gemini limit over" — and the list of
 * models they can pick from. Pure, so the main process (which builds it) and the pages (which show it) agree, and so it can be tested.
 */
export type AiRole = 'gemini' | 'backup' | 'ollama';

/** Gemini as the user should hear about it: usable, its allowance is over, busy for a moment, its key was refused, or no key. */
export type GeminiState = 'ready' | 'limit' | 'busy' | 'refused' | 'no-key';

/** Why an AI that comes earlier in the order was passed over. */
export type PassedWhy = 'limit' | 'busy' | 'refused' | 'credit';

export interface RouteBackup {
  /** What names it: its service ("openrouter"), or for a custom one "custom-<address>". */
  readonly id: string;
  readonly label: string;
  /** The model in use. */
  readonly model: string | null;
  /** Every model that can be picked, the one in use first. */
  readonly models: readonly string[];
}

export interface AiRouteStatus {
  /** Who answers the next request; null when every AI is out and only the on-PC commands work. */
  readonly using: { readonly role: AiRole; readonly id: string | null; readonly label: string; readonly model: string | null } | null;
  readonly gemini: GeminiState;
  /** When Gemini will be tried again (epoch ms), when it is being left alone. */
  readonly geminiBackAt: number | null;
  /** The user's choice: Gemini first and the backups when it is out (auto), or the first backup first. */
  readonly prefer: 'auto' | 'backup';
  /** The AIs that would have answered but are being left alone (their allowance is over, they are busy, or the key was refused). */
  readonly passedOver: readonly { readonly label: string; readonly why: PassedWhy }[];
  /** The backups set up, in the order they are asked. */
  readonly backups: readonly RouteBackup[];
}

/** What the chain says about one provider (see ChainedAIProvider.route). */
export interface RouteEntryLike {
  readonly name: string;
  readonly ready: boolean;
  readonly model?: string;
  readonly restingUntil?: number;
  readonly restKind?: 'daily' | 'rate' | 'overloaded' | 'auth' | 'credit' | 'other';
}

export interface RouteInput {
  /** In the order they are tried right now. */
  readonly entries: readonly RouteEntryLike[];
  readonly geminiKey: boolean;
  readonly backups: readonly RouteBackup[];
  readonly prefer: 'auto' | 'backup';
  readonly now: number;
}

function roleOf(name: string): AiRole {
  return name === 'gemini' ? 'gemini' : name === 'ollama' ? 'ollama' : 'backup';
}

function whyOf(e: RouteEntryLike): PassedWhy {
  return e.restKind === 'daily' || e.restKind === 'rate' ? 'limit' : e.restKind === 'auth' ? 'refused' : e.restKind === 'credit' ? 'credit' : 'busy';
}

export function describeRoute(input: RouteInput): AiRouteStatus {
  const { entries, backups, now } = input;
  const resting = (e: RouteEntryLike): boolean => e.restingUntil !== undefined && e.restingUntil > now;
  const backupOf = (e: RouteEntryLike): RouteBackup | undefined => backups.find((b) => b.id === e.name);
  const labelOf = (e: RouteEntryLike): string => {
    const role = roleOf(e.name);
    return role === 'gemini' ? 'Gemini' : role === 'ollama' ? 'Ollama' : (backupOf(e)?.label ?? e.name);
  };
  // What can answer: Gemini with a key, a backup that is set up (an empty slot is in the list only so the chain can skip it), and Ollama
  // when it is reachable. Whether the last try failed is not asked here: that is what a rest is for, and a rest ends.
  const usable = entries.filter((e) => {
    const role = roleOf(e.name);
    return role === 'gemini' ? input.geminiKey : role === 'ollama' ? e.ready : backupOf(e) !== undefined;
  });
  const nextIndex = usable.findIndex((e) => !resting(e));
  const next = nextIndex >= 0 ? usable[nextIndex] : undefined;

  let using: AiRouteStatus['using'] = null;
  if (next !== undefined) {
    const role = roleOf(next.name);
    const b = role === 'backup' ? backupOf(next) : undefined;
    using = {
      role,
      id: role === 'backup' ? next.name : null,
      label: labelOf(next),
      model: next.model ?? b?.model ?? null,
    };
  }

  // Everything tried before the one that answers, that is being left alone: Gemini's limit, and an earlier backup's.
  const before = nextIndex >= 0 ? usable.slice(0, nextIndex) : usable;
  const passedOver = before.filter(resting).map((e) => ({ label: labelOf(e), why: whyOf(e) }));

  const g = entries.find((e) => e.name === 'gemini');
  let gemini: GeminiState = 'ready';
  if (!input.geminiKey || g === undefined) gemini = 'no-key';
  else if (resting(g)) gemini = whyOf(g) === 'limit' || whyOf(g) === 'credit' ? 'limit' : whyOf(g) === 'refused' ? 'refused' : 'busy';

  return {
    using,
    gemini,
    geminiBackAt: g !== undefined && resting(g) ? (g.restingUntil ?? null) : null,
    prefer: input.prefer,
    passedOver,
    backups,
  };
}

/** "nvidia/nemotron-3-super-120b-a12b:free" → "nemotron-3-super-120b-a12b": what fits on a small badge. */
export function shortModel(id: string | null): string {
  if (id === null || id === '') return '';
  const last = id.split('/').pop() ?? id;
  return last.replace(/:free$/, '');
}

export interface RouteBadge {
  /** The main line: who is connected. */
  readonly text: string;
  /** The small line: why (Gemini's limit is over...). Empty when there is nothing to add. */
  readonly sub: string;
  /** The full words, for the tooltip. */
  readonly title: string;
}

function passedPhrase(passed: AiRouteStatus['passedOver']): string {
  if (passed.length === 0) return '';
  const names = passed.map((p) => p.label).join(' and ');
  const only = passed.length === 1 ? passed[0] : undefined;
  if (only !== undefined) {
    return only.why === 'limit' ? `${names} limit over` : only.why === 'refused' ? `${names} key refused` : only.why === 'credit' ? `${names} has no credit` : `${names} is busy`;
  }
  return passed.every((p) => p.why === 'limit' || p.why === 'credit') ? `${names} limit over` : `${names} unavailable`;
}

export function routeBadge(route: AiRouteStatus | null, whileLoading = 'Connecting…'): RouteBadge {
  if (route === null) return { text: whileLoading, sub: '', title: '' };
  const u = route.using;
  if (u === null) {
    if (route.gemini === 'no-key' && route.backups.length === 0) {
      return { text: 'No AI — local commands only', sub: '', title: 'Add a Gemini key or a backup AI in Settings to chat, read documents and talk live.' };
    }
    return {
      text: 'AI limit reached',
      sub: 'local commands only',
      title: 'Every AI Eya has is out of its allowance for now. Opening apps, files, folders and sites, searching and messaging by name still work.',
    };
  }
  if (u.role === 'gemini' || u.role === 'ollama') {
    const name = u.role === 'gemini' ? 'Gemini' : 'Ollama';
    const model = shortModel(u.model);
    // An AI that came first (the one you chose) was passed over: say so, or it looks as though the choice was ignored.
    const passed = passedPhrase(route.passedOver);
    return {
      text: `${name} connected`,
      sub: passed !== '' ? passed : model,
      title:
        (u.role === 'gemini' ? (model === '' ? 'Gemini is answering.' : `Gemini (${u.model}) is answering.`) : 'The AI on this PC (Ollama) is answering.') +
        (passed !== '' ? ` The AI you chose is not: ${passed}.` : ''),
    };
  }
  const model = shortModel(u.model);
  const passed = passedPhrase(route.passedOver);
  const why = passed !== '' ? passed : route.prefer === 'backup' ? 'your choice' : '';
  return {
    text: model === '' ? u.label : `${u.label} · ${model}`,
    sub: why,
    title: `${u.label}${u.model !== null ? ` (${u.model})` : ''} is answering${why === '' ? '' : ` — ${why}`}.`,
  };
}

const NOTICE_EVERY_MS = 30 * 60_000;

/**
 * What is said, once in a while, when the AI the person chose cannot answer and another one does: otherwise it looks as though the
 * choice is ignored ("why does only Gemini work?"). Said once per reason (again after half an hour, or after it has worked in between),
 * never for a passing busy spell, and never when nothing can answer (that has its own message).
 */
export function createChosenAiNotice(route: () => AiRouteStatus, now: () => number = Date.now): () => string | null {
  const told = new Map<string, number>();
  return () => {
    const r = route();
    const chosen = r.prefer === 'backup' ? r.backups[0] : undefined;
    const passed = chosen === undefined ? undefined : r.passedOver.find((p) => p.label === chosen.label);
    if (chosen === undefined || passed === undefined) {
      told.clear();
      return null;
    }
    if (passed.why === 'busy' || r.using === null) return null;
    const key = `${chosen.id}:${passed.why}`;
    const last = told.get(key);
    if (last !== undefined && now() - last < NOTICE_EVERY_MS) return null;
    told.set(key, now());
    const name = chosen.label;
    const instead = r.using.label;
    switch (passed.why) {
      case 'credit':
        return `${name} has no credit left, so ${instead} is answering for now. Add credit${chosen.id === 'openai' ? ' at platform.openai.com, under Billing,' : ' with them'} and I'll switch straight back.`;
      case 'limit':
        return `${name}'s allowance is used up for now, so ${instead} is answering instead. I'll go back to ${name} when it's back.`;
      default:
        return `${name} refused its key, so ${instead} is answering for now. Paste a new key in Settings and I'll switch back.`;
    }
  };
}
