import { MAX_BACKUPS, backupId, backupLabelFor, backupPreset, isBackupAiProvider, providerFromKey } from '@shared/backupAi';
import type { BackupAiProvider } from '@shared/backupAi';
import type { BackupAiEntry, BackupAiInput, BackupAiResult, BackupAiStatus } from '@shared/ipcContract';
import type { KeyCrypto, KeyFiles } from './geminiKey';
import { keyHint } from './geminiKey';

/**
 * The user's own backup AIs (other online services Eya switches to when Gemini's allowance is spent). There can be several, each with
 * its own key: more keys, more allowance.
 *
 * Kept like the Gemini key: one small file in Eya's data folder, encrypted by Windows for this user (safeStorage). If Windows cannot
 * protect it, nothing is saved. The page only ever sees which service, which model, and the last four characters of each key.
 */

export interface BackupAiConfig {
  readonly provider: BackupAiProvider;
  readonly apiKey: string;
  readonly model: string;
  /** The service address (without /chat/completions). */
  readonly baseUrl: string;
  /** Other models to try, in order, when `model` fails for its own reasons (OpenRouter's free models). */
  readonly fallbackModels?: readonly string[];
}

/** What identifies a config: its service, or for a custom one its address. */
export function configId(c: Pick<BackupAiConfig, 'provider' | 'baseUrl'>): string {
  return backupId(c.provider, c.baseUrl);
}

/**
 * OpenRouter's free models that are worth asking, best first: the preferred ones that are on offer, then the rest of the free
 * models that can use tools (skipping the very small ones, which cannot follow Eya's tools), then its free router as the last resort.
 * Only ":free" models — never one that would spend credit.
 */
export function rankFreeModels(ids: readonly string[], preferred: readonly string[], limit = 12): string[] {
  const size = (id: string): number => {
    const sizes = [...id.matchAll(/(\d+(?:\.\d+)?)b(?![a-z])/gi)].map((m) => Number(m[1]));
    return sizes.length === 0 ? Number.POSITIVE_INFINITY : Math.max(...sizes);
  };
  const free = ids.filter((m) => m.endsWith(':free') && size(m) >= 20);
  const first = preferred.filter((p) => free.includes(p));
  const rest = free.filter((m) => !first.includes(m));
  const router = ids.includes('openrouter/free') ? ['openrouter/free'] : [];
  // The router goes last and always makes the list (it is the one that can still answer when the named ones are all busy).
  const named = [...new Set([...first, ...rest])].slice(0, router.length > 0 ? limit - 1 : limit);
  return [...named, ...router];
}

/**
 * OpenAI lists everything it offers under one key (chat, speech, images, embeddings, dated copies of each). The chat models fit for a
 * spoken assistant that uses tools, best first: the ones this app prefers that the account really has, then the rest of the "gpt-"
 * models by version, newest first, the quicker "mini" of a version before its full model. No dated copies, no audio, image, search or
 * code-only models, and no "nano" (too small to follow the tools).
 */
export function rankOpenAIChatModels(ids: readonly string[], preferred: readonly string[], limit = 8): string[] {
  const usable = ids.filter(
    (id) =>
      /^gpt-\d/.test(id) &&
      !/^gpt-3/.test(id) &&
      !/(audio|realtime|transcribe|diariz|tts|image|search|instruct|codex|embedding|moderation|nano|computer|deep-research)/i.test(id) &&
      !/-\d{4}-\d{2}-\d{2}$/.test(id) &&
      !/-\d{4}$/.test(id),
  );
  const version = (id: string): number => Number(/^gpt-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  const first = preferred.filter((p) => usable.includes(p));
  const rest = usable
    .filter((id) => !first.includes(id))
    .sort((a, b) => version(b) - version(a) || Number(/-mini/.test(b)) - Number(/-mini/.test(a)) || a.localeCompare(b));
  return [...first, ...rest].slice(0, limit);
}

const KEY_PATTERN = /^[A-Za-z0-9_.:\-]{16,300}$/;

export function looksLikeBackupKey(text: string): boolean {
  return KEY_PATTERN.test(text);
}

/** A plain-text address that only ever points at this PC (a local server like LM Studio or Ollama's OpenAI port). */
export function isLoopbackUrl(url: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url);
}

export function isAcceptableBaseUrl(url: string): boolean {
  return /^https:\/\/[^\s/]+(\/\S*)?$/i.test(url) || isLoopbackUrl(url);
}

function parseOne(raw: unknown): BackupAiConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<Record<keyof BackupAiConfig, unknown>>;
  if (!isBackupAiProvider(r.provider)) return null;
  if (typeof r.apiKey !== 'string' || typeof r.model !== 'string' || typeof r.baseUrl !== 'string') return null;
  if (r.apiKey === '' || r.model === '' || !isAcceptableBaseUrl(r.baseUrl)) return null;
  const more = Array.isArray(r.fallbackModels) ? r.fallbackModels.filter((m): m is string => typeof m === 'string' && m !== '') : [];
  return {
    provider: r.provider,
    apiKey: r.apiKey,
    model: r.model,
    baseUrl: r.baseUrl,
    ...(more.length > 0 ? { fallbackModels: more } : {}),
  };
}

/** The saved text: a list of backups, or (what earlier versions wrote) one backup on its own. */
function parseStored(text: string): BackupAiConfig[] {
  try {
    const raw = JSON.parse(text) as unknown;
    const list = Array.isArray((raw as { backups?: unknown } | null)?.backups) ? ((raw as { backups: unknown[] }).backups) : [raw];
    const out: BackupAiConfig[] = [];
    for (const item of list) {
      const c = parseOne(item);
      if (c !== null && !out.some((o) => configId(o) === configId(c))) out.push(c);
    }
    return out.slice(0, MAX_BACKUPS);
  } catch {
    return [];
  }
}

export class BackupAiStore {
  constructor(
    private readonly path: string,
    private readonly crypto: KeyCrypto,
    private readonly files: KeyFiles,
  ) {}

  get canSave(): boolean {
    try {
      return this.crypto.isAvailable();
    } catch {
      return false;
    }
  }

  load(): BackupAiConfig[] {
    const data = this.files.read(this.path);
    if (data === null || data.length === 0) return [];
    try {
      return parseStored(this.crypto.decrypt(data));
    } catch {
      return [];
    }
  }

  save(configs: readonly BackupAiConfig[]): boolean {
    if (!this.canSave) return false;
    try {
      this.files.write(this.path, this.crypto.encrypt(JSON.stringify({ version: 2, backups: configs })));
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    try {
      this.files.remove(this.path);
    } catch {
      // nothing there to remove
    }
  }
}

/** What asking a service about a key came to: fine, refused, no such address, or no answer. */
export type KeyVerdict = 'valid' | 'invalid' | 'notfound' | 'unreachable';

export type ProbeVerdict = 'ok' | 'invalid' | 'forbidden' | 'missing' | 'nocredit' | 'unreachable';

export interface BackupAiServiceDeps {
  readonly store: BackupAiStore;
  readonly env: NodeJS.ProcessEnv;
  /** Asks the service whether the key is accepted and which models it offers. Never throws. */
  readonly check: (
    baseUrl: string,
    apiKey: string,
  ) => Promise<{
    readonly verdict: KeyVerdict;
    readonly models: readonly string[];
    readonly toolModels?: readonly string[];
    readonly detail?: string;
  }>;
  /**
   * Sends one tiny test message, for services whose model list is public (so the list proves nothing about the key). Optional:
   * without it a key that passed `check` is saved.
   */
  readonly probe?: (baseUrl: string, apiKey: string, model: string) => Promise<ProbeVerdict>;
  /** Puts the backups to work, in order, straight away (an empty list takes them all out). */
  readonly apply: (configs: readonly BackupAiConfig[]) => void;
  /**
   * Called when a test shows a backup works, and when the person chooses one: whatever the chain was holding against it (a rest after a
   * refused key or an empty account) is forgotten, so it is asked at once. With no id, every rest is forgotten.
   */
  readonly clearRests?: (id?: string) => void;
  /** Called when a test shows a backup cannot answer (no credit, key refused): the chain rests it at once, so the badge and the lists say so before a request has to fail. */
  readonly noteFailure?: (id: string, kind: 'credit' | 'auth') => void;
  /** Another address for a well-known service (a proxy, or a test server on this PC), when one was set for it; else the service's own. */
  readonly baseUrlFor?: (provider: BackupAiProvider) => string | undefined;
}

/**
 * The model to use: the user's own choice, else the best of the service's preferred ones that it really offers.
 *
 * Models are renamed and retired all the time, so when none of the preferred ones is on offer the choice comes from the service's own
 * list: for OpenRouter only its free (":free") models that can call tools — never a paid one, which would spend the user's credit —
 * and elsewhere a large general chat model.
 */
export function chooseModel(
  provider: BackupAiProvider,
  asked: string | undefined,
  offered: readonly string[],
  toolCapable?: readonly string[],
): string | null {
  const own = asked?.trim() ?? '';
  if (own !== '') return own;
  const preferred = backupPreset(provider).models;
  if (provider === 'openai') {
    const best = rankOpenAIChatModels(toolCapable ?? offered, preferred)[0];
    if (best !== undefined) return best;
  }
  const free = provider === 'openrouter';
  const pool = (toolCapable ?? offered).filter((m) => !free || m.endsWith(':free'));
  const hit = preferred.find((m) => pool.includes(m));
  if (hit !== undefined) return hit;
  const general = pool.find((m) =>
    /llama.*(70|405)b|gpt-oss-120b|mistral-(small|medium|large)|qwen.*(32|72)b|gemma-\d+-\d+b|nemotron.*(120|550)b|gpt-4|gemini-.*(flash|pro)|deepseek-(chat|v\d)|grok/i.test(m),
  );
  if (general !== undefined) return general;
  // OpenRouter: any free model that can use tools is better than naming one that is not there.
  if (free && pool.length > 0) return pool[0] ?? null;
  return preferred[0] ?? offered[0] ?? null;
}

interface Entry {
  config: BackupAiConfig;
  /** Where it came from: saved in Settings (can be removed there), or the environment / a .env file (which wins). */
  source: 'saved' | 'env';
}

export class BackupAiService {
  private entries: Entry[] = [];

  constructor(private readonly deps: BackupAiServiceDeps) {}

  /** Call once at start-up. A key in the environment (a .env file) comes first, as for Gemini; saved ones follow. */
  start(): void {
    const { env, store } = this.deps;
    const fromEnv = env['EYA_BACKUP_AI_KEY']?.trim() ?? '';
    const entries: Entry[] = [];
    if (fromEnv !== '') {
      const asked = env['EYA_BACKUP_AI_PROVIDER']?.trim().toLowerCase() ?? 'groq';
      const provider: BackupAiProvider = isBackupAiProvider(asked) ? asked : 'groq';
      const preset = backupPreset(provider);
      const baseUrl = env['EYA_BACKUP_AI_URL']?.trim() || preset.baseUrl;
      const model = env['EYA_BACKUP_AI_MODEL']?.trim() || preset.models[0] || '';
      if (model !== '' && isAcceptableBaseUrl(baseUrl)) entries.push({ config: { provider, apiKey: fromEnv, model, baseUrl }, source: 'env' });
    }
    for (const config of store.load()) {
      if (entries.length >= MAX_BACKUPS) break;
      if (!entries.some((e) => configId(e.config) === configId(config))) entries.push({ config, source: 'saved' });
    }
    this.entries = entries;
    this.applyAll();
    // OpenRouter's free models come and go: look at today's list in the background so the ones that are asked are ones that exist.
    void this.refreshModels();
  }

  /** Re-reads OpenRouter's current free models and puts them to work. Never throws; does nothing for other services. */
  async refreshModels(): Promise<void> {
    for (const entry of [...this.entries]) {
      const c = entry.config;
      if (c.provider !== 'openrouter') continue;
      const r = await this.deps.check(c.baseUrl, c.apiKey).catch(() => null);
      if (r === null || r.verdict !== 'valid' || entry.config !== c || !this.entries.includes(entry)) continue;
      const ranked = rankFreeModels(r.toolModels ?? r.models, backupPreset('openrouter').models);
      if (ranked.length === 0) continue;
      // The model first chosen may have been retired since: then the best one on offer takes its place.
      const stillThere = r.models.includes(c.model) || c.model === 'openrouter/free';
      const model = stillThere ? c.model : (ranked[0] ?? c.model);
      entry.config = { ...c, model, fallbackModels: ranked.filter((m) => m !== model) };
      this.applyAll();
    }
  }

  status(): BackupAiStatus {
    const entries: BackupAiEntry[] = this.entries.map((e) => this.entryStatus(e));
    const first = entries[0];
    return {
      configured: entries.length > 0,
      entries,
      max: MAX_BACKUPS,
      canSave: this.deps.store.canSave,
      // The first backup, in the fields the pages used when there could only be one.
      provider: first?.provider ?? null,
      label: first?.label ?? null,
      model: first?.model ?? null,
      extraModels: first?.extraModels ?? 0,
      models: first?.models ?? [],
      hint: first?.hint ?? null,
      baseUrl: first?.baseUrl ?? null,
      source: first?.source ?? 'none',
    };
  }

  private entryStatus(e: Entry): BackupAiEntry {
    const c = e.config;
    return {
      id: configId(c),
      provider: c.provider,
      label: backupLabelFor(c.provider, c.baseUrl),
      model: c.model,
      models: [c.model, ...(c.fallbackModels ?? [])],
      extraModels: c.fallbackModels?.length ?? 0,
      hint: keyHint(c.apiKey),
      baseUrl: c.provider === 'custom' ? c.baseUrl : null,
      source: e.source,
    };
  }

  /** The key of one backup AI, for the main process only (it is never sent to a page): the voice uses the OpenAI one. Null when there is none. */
  keyFor(id: string): string | null {
    const entry = this.entries.find((e) => configId(e.config) === id);
    return entry?.config.apiKey ?? null;
  }

  /** Adds a backup AI (or replaces the one for the same service with this key). */
  async set(raw: unknown): Promise<BackupAiResult> {
    const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof BackupAiInput, unknown>>;
    if (!this.deps.store.canSave) {
      return this.result(false, "Windows can't protect a saved key on this account, so I haven't saved it. You can put it in a .env file instead (EYA_BACKUP_AI_KEY).");
    }
    if (!isBackupAiProvider(input.provider)) return this.result(false, 'Choose which service the key is for. Nothing was saved.');
    let provider: BackupAiProvider = input.provider;
    // A key with a telltale start says which service it is for. Pasting an OpenRouter key while "Mistral" is still selected is the
    // commonest slip, and "Mistral says the key is not valid" sends people the wrong way.
    const pasted = typeof input.key === 'string' ? input.key.trim() : '';
    const detected = providerFromKey(pasted);
    const switchedFrom = detected !== undefined && provider !== 'custom' && detected !== provider ? provider : undefined;
    if (detected !== undefined && provider !== 'custom') provider = detected;
    const preset = backupPreset(provider);
    const baseUrl = (provider === 'custom' ? (typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '') : (this.deps.baseUrlFor?.(provider) ?? preset.baseUrl)).replace(/\/+$/, '');
    if (!isAcceptableBaseUrl(baseUrl)) {
      return this.result(false, 'The address must start with https:// (or be a server on this PC, like http://localhost:1234/v1). Nothing was saved.');
    }
    const label = backupLabelFor(provider, baseUrl);
    const id = backupId(provider, baseUrl);
    const switchedNote = switchedFrom === undefined ? '' : ` (That key is for ${label}, not ${backupPreset(switchedFrom).label}, so I used ${label}.)`;
    let apiKey = pasted;
    if (apiKey === '' && provider === 'custom' && isLoopbackUrl(baseUrl)) apiKey = 'local-server';
    if (apiKey !== 'local-server' && !looksLikeBackupKey(apiKey)) {
      return this.result(false, "That doesn't look like a key (it is one long run of letters and numbers, copied whole). Nothing was saved.");
    }
    const replacing = this.entries.some((e) => configId(e.config) === id);
    if (!replacing && this.entries.length >= MAX_BACKUPS) {
      return this.result(false, `You already have ${MAX_BACKUPS} backup AIs. Remove one first. Nothing was saved.`);
    }
    const verdict: Awaited<ReturnType<BackupAiServiceDeps['check']>> = await this.deps
      .check(baseUrl, apiKey)
      .catch(() => ({ verdict: 'unreachable' as KeyVerdict, models: [] as string[] }));
    if (verdict.verdict === 'invalid') {
      const said = verdict.detail !== undefined && verdict.detail !== '' ? ` (it said: ${verdict.detail})` : '';
      // A key that does not begin the way this service's keys do is most often another service's key (Groq and Grok are easy to mix up).
      const start = preset.keyStart;
      const odd =
        start !== undefined && apiKey !== 'local-server' && !apiKey.startsWith(start)
          ? ` A ${label} key starts with "${start}", and this one starts with "${apiKey.slice(0, 4)}": it may be for another service.`
          : '';
      return this.result(
        false,
        `${label} says that key is not valid${said}, so I did not save it. Check it was copied whole and that Service is the one the key came from.${odd}${switchedNote}`,
      );
    }
    if (verdict.verdict === 'notfound') {
      const said = verdict.detail !== undefined && verdict.detail !== '' ? ` (it said: ${verdict.detail})` : '';
      return this.result(false, `${label} did not recognise that address${said}, so I did not save it. Check the address.${switchedNote}`);
    }
    const asked = typeof input.model === 'string' ? input.model : undefined;
    let model = chooseModel(provider, asked, verdict.models, verdict.toolModels);
    if (model === null) return this.result(false, 'Tell me which model to use for this service (its model name). Nothing was saved.');

    // OpenRouter: every free model that can use tools is a fallback, so one that is rate limited upstream or down does not stop Eya.
    // Other services: their other preferred models that they really offer, so there is something to choose from (and to fall back to).
    const ranked =
      provider === 'openrouter'
        ? rankFreeModels(verdict.toolModels ?? verdict.models, preset.models)
        : provider === 'openai'
          ? rankOpenAIChatModels(verdict.models, preset.models)
          : preset.models.filter((m) => verdict.models.includes(m)).slice(0, 5);

    // A model list says little about a key (some services list their models to anyone, and some accept any key for the list), so every
    // key gets one tiny test message with the model Eya would use: a key that is wrong, or a model it may not use, is found now and not
    // on the day Gemini runs out. A model that is refused for this key (403) or that does not exist is not the end: the next one is tried.
    let note = verdict.verdict === 'unreachable' ? ` (I couldn't reach ${label} to check it just now.)` : '';
    if (this.deps.probe !== undefined && apiKey !== 'local-server') {
      const own = asked !== undefined && asked.trim() !== '';
      const others = own ? [] : (provider === 'openrouter' ? ranked : preset.models.filter((m) => verdict.models.includes(m))).filter((m) => m !== model).slice(0, 4);
      const candidates = [model, ...others];
      let outcome: ProbeVerdict = 'unreachable';
      for (const candidate of candidates) {
        outcome = await this.deps.probe(baseUrl, apiKey, candidate).catch((): ProbeVerdict => 'unreachable');
        if (outcome === 'ok') {
          model = candidate;
          break;
        }
        if (outcome === 'invalid' || outcome === 'unreachable' || outcome === 'nocredit') break;
      }
      if (outcome === 'invalid') return this.result(false, `${label} says that key is not valid, so I did not save it.${switchedNote}`);
      if (outcome === 'missing') return this.result(false, `${label} did not accept the model "${model}". Type a model name that service offers. Nothing was saved.`);
      if (outcome === 'forbidden') return this.result(false, `${label} refused the test message: this key is not allowed to use ${own ? `"${model}"` : 'its models here'}. Check the key (and that its account is set up for use), or type another model. Nothing was saved.${switchedNote}`);
      if (outcome === 'unreachable') note = ` (I couldn't send ${label} a test message just now, so I don't know yet that it works.)`;
      // The key is fine, the account is empty: saved all the same (the key works the moment credit is added), but said plainly.
      if (outcome === 'nocredit') note = ` (But ${label} says this account has no credit left, so it cannot answer yet. Add credit with ${label}${provider === 'openai' ? ' (platform.openai.com → Billing)' : ''} and it works at once.)`;
    }
    const fallbackModels = ranked.filter((m) => m !== model);
    const config: BackupAiConfig = { provider, apiKey, model, baseUrl, ...(fallbackModels.length > 0 ? { fallbackModels } : {}) };

    const existing = this.entries.find((e) => configId(e.config) === id);
    if (existing !== undefined && existing.source === 'env') {
      // The environment's key for this service wins; the saved one is kept for when it is gone.
      const saved = [...this.entries.filter((e) => e.source === 'saved').map((e) => e.config), config];
      if (!this.deps.store.save(saved)) return this.result(false, "I couldn't save the key. Nothing was changed.");
      return this.result(true, `Saved, but the key from your environment or .env file is used for ${label} instead.`);
    }
    const next = existing !== undefined ? this.entries.map((e) => (e === existing ? { ...e, config } : e)) : [...this.entries, { config, source: 'saved' as const }];
    if (!this.persist(next)) return this.result(false, "I couldn't save the key. Nothing was changed.");
    this.entries = next;
    this.applyAll();
    const first = next.length > 1 ? ` It is backup number ${next.findIndex((e) => configId(e.config) === id) + 1}: Eya asks them in order.` : '';
    return this.result(
      true,
      `Saved. Eya will use ${label} (${model}) whenever Gemini has run out for the day or is overloaded. No restart needed.${first}${note}${switchedNote}`,
    );
  }

  /**
   * Sends a real test message to a saved backup and says what came of it: it works (and with which model), its key is refused, none
   * of its models answers, or it cannot be reached. A model the service refuses is passed over for the next one, and the one that
   * works is put first. A backup that works has whatever was held against it forgotten, so it is asked again at once.
   */
  async test(id?: string): Promise<BackupAiResult> {
    const entry = id === undefined ? this.entries[0] : this.entries.find((e) => configId(e.config) === id);
    if (entry === undefined) return this.result(false, 'There is no such backup AI. Add a key first.');
    const probe = this.deps.probe;
    if (probe === undefined) return this.result(false, "Testing isn't available here.");
    const c = entry.config;
    const label = backupLabelFor(c.provider, c.baseUrl);
    const models = [c.model, ...(c.fallbackModels ?? [])].slice(0, 6);
    for (const m of models) {
      const outcome = await probe(c.baseUrl, c.apiKey, m).catch((): ProbeVerdict => 'unreachable');
      if (outcome === 'ok') {
        this.deps.clearRests?.(configId(c));
        if (m === c.model) return this.result(true, `${label} works (${m}).`);
        const moved = this.choose(m, configId(c), false);
        return moved.ok
          ? this.result(true, `${label} works. Its first model (${c.model}) is not available to this key, so Eya now asks ${m} first.`)
          : this.result(true, `${label} works with ${m}.`);
      }
      if (outcome === 'invalid') {
        this.deps.noteFailure?.(configId(c), 'auth');
        return this.result(false, `${label} refused this key: it is not valid any more (wrong, cancelled or out of credit). Paste a new key below and Save; it replaces this one.`);
      }
      if (outcome === 'unreachable') return this.result(false, `I couldn't reach ${label} just now. Check the internet and test again.`);
      if (outcome === 'nocredit') {
        this.deps.noteFailure?.(configId(c), 'credit');
        return this.result(false, `${label} accepted the key, but the account has no credit left, so it cannot answer. Add credit with ${label}${c.provider === 'openai' ? ' (platform.openai.com → Billing)' : ''} and it works at once.`);
      }
      // forbidden or missing: this model is not available to this key; the next one may be.
    }
    return this.result(false, `${label} accepted the key but none of its models answered (they are refused for this key, or no longer exist). Type a model name in Model and Save again.`);
  }

  /** Use this one of a backup's models first (the others stay as fallbacks). Only a model already in the list can be chosen. */
  setModel(raw: unknown, id?: string): BackupAiResult {
    return this.choose(raw, id, false);
  }

  /** Use this model of this backup, and ask that backup before the others. */
  use(raw: unknown, id?: string): BackupAiResult {
    return this.choose(raw, id, true);
  }

  private choose(raw: unknown, id: string | undefined, toFront: boolean): BackupAiResult {
    const entry = id === undefined ? this.entries[0] : this.entries.find((e) => configId(e.config) === id);
    if (entry === undefined) return this.result(false, 'There is no such backup AI. Add a key first.');
    const c = entry.config;
    const wanted = typeof raw === 'string' ? raw.trim() : '';
    const known = [c.model, ...(c.fallbackModels ?? [])];
    if (wanted === '' || !known.includes(wanted)) return this.result(false, 'That model is not in the list.');
    const others = known.filter((m) => m !== wanted);
    const updated: Entry = { ...entry, config: { ...c, model: wanted, ...(others.length > 0 ? { fallbackModels: others } : {}) } };
    let next = this.entries.map((e) => (e === entry ? updated : e));
    if (toFront) next = [updated, ...next.filter((e) => e !== updated)];
    // A choice about a key that lives in the environment lasts until Eya restarts: the environment is not ours to rewrite.
    if (!this.persist(next)) return this.result(false, "I couldn't save that choice. Nothing was changed.");
    this.entries = next;
    this.applyAll();
    // Choosing it is asking for it: a rest it was given earlier (the account was empty, the key refused) must not keep it from being tried now.
    if (toFront) this.deps.clearRests?.(configId(updated.config));
    return this.result(true, `Using ${wanted} first.`);
  }

  /** Removes one saved backup (by id), or every saved one when no id is given. Keys from the environment cannot be removed here. */
  clear(id?: string): BackupAiResult {
    const target = id === undefined ? this.entries.filter((e) => e.source === 'saved') : this.entries.filter((e) => configId(e.config) === id);
    if (target.length === 0) return this.result(true, 'Nothing to remove.');
    if (target.every((e) => e.source === 'env')) {
      return this.result(false, 'That key comes from your environment or .env file, so remove it there.');
    }
    const next = this.entries.filter((e) => !target.includes(e) || e.source === 'env');
    if (!this.persist(next)) return this.result(false, "I couldn't save that change. Nothing was changed.");
    this.entries = next;
    this.applyAll();
    return this.result(true, id === undefined ? 'Removed. Eya has no saved backup AIs now.' : 'Removed.');
  }

  /** Saves the saved ones, in order (environment ones are not written to disk). Removes the file when none are left. */
  private persist(entries: readonly Entry[]): boolean {
    const saved = entries.filter((e) => e.source === 'saved').map((e) => e.config);
    if (saved.length === 0) {
      this.deps.store.clear();
      return true;
    }
    return this.deps.store.save(saved);
  }

  private applyAll(): void {
    this.deps.apply(this.entries.map((e) => e.config));
  }

  private result(ok: boolean, message: string): BackupAiResult {
    return { ok, message, status: this.status() };
  }
}
