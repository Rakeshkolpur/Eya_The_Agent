import type { GeminiKeyResult, GeminiKeyStatus } from '@shared/ipcContract';

/**
 * The user's own Gemini key, for an installed Eya (which has no .env file beside it).
 *
 * Where it lives: one small file in Eya's data folder, encrypted by Windows for this user (DPAPI, through Electron's safeStorage), so a
 * copy of the file is useless on another PC or account and it is never in plain text on disk. If Windows cannot protect it, nothing is
 * saved at all: the key is never written unprotected.
 *
 * What the page ever sees: whether there is a key, where it came from, and its last four characters. Never the key itself.
 *
 * A key in the environment (a .env file, when run from source) takes priority over the saved one, as it always did.
 */

/** What encrypting needs from Windows; Electron's `safeStorage` fits. */
export interface KeyCrypto {
  isAvailable(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

/** What reading and writing the file needs from the disk. */
export interface KeyFiles {
  read(path: string): Buffer | null;
  write(path: string, data: Buffer): void;
  remove(path: string): void;
}

export type KeyCheck = 'valid' | 'invalid' | 'unreachable';

const KEY_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;

export function looksLikeGeminiKey(text: string): boolean {
  return KEY_PATTERN.test(text);
}

/** "…abcd": enough to recognise, nothing that could be used. */
export function keyHint(key: string): string {
  return `…${key.slice(-4)}`;
}

export class GeminiKeyStore {
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

  /** The saved key, or null if there is none, it cannot be read, or it was made by another user or machine. */
  load(): string | null {
    const data = this.files.read(this.path);
    if (data === null || data.length === 0) return null;
    try {
      const key = this.crypto.decrypt(data).trim();
      return looksLikeGeminiKey(key) ? key : null;
    } catch {
      return null;
    }
  }

  save(key: string): boolean {
    if (!this.canSave || !looksLikeGeminiKey(key)) return false;
    try {
      this.files.write(this.path, this.crypto.encrypt(key));
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

export interface GeminiKeyServiceDeps {
  readonly store: GeminiKeyStore;
  readonly env: NodeJS.ProcessEnv;
  /** Asks Google whether a key is accepted. Optional: without it a well-formed key is saved unchecked. */
  readonly check?: (key: string) => Promise<KeyCheck>;
}

const ENV_NAME = 'EYA_GEMINI_API_KEY';

export class GeminiKeyService {
  private source: GeminiKeyStatus['source'] = 'none';
  private inUse: string | null = null;
  /** The key saved right now, and the one that was saved when Eya started (what she is running with, unless the environment has one). */
  private saved: string | null = null;
  private savedAtStart: string | null = null;

  constructor(private readonly deps: GeminiKeyServiceDeps) {}

  /** Call once at start-up, before anything reads the key: puts the saved key where the rest of Eya looks for it. */
  start(): void {
    const { env, store } = this.deps;
    this.saved = store.load();
    this.savedAtStart = this.saved;
    const fromEnv = env[ENV_NAME];
    if (fromEnv !== undefined && fromEnv.trim() !== '') {
      this.source = 'env';
      this.inUse = fromEnv.trim();
    } else if (this.saved !== null) {
      env[ENV_NAME] = this.saved;
      this.source = 'saved';
      this.inUse = this.saved;
    }
  }

  status(): GeminiKeyStatus {
    return {
      source: this.source,
      hint: this.inUse === null ? null : keyHint(this.inUse),
      // A key saved or removed since start-up only takes effect on the next start (and never matters while the environment's key wins).
      pendingRestart: this.source !== 'env' && this.saved !== this.savedAtStart,
      canSave: this.deps.store.canSave,
    };
  }

  async set(raw: unknown): Promise<GeminiKeyResult> {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!this.deps.store.canSave) {
      return this.result(false, "Windows can't protect a saved key on this account, so I haven't saved it. You can put it in a .env file instead.");
    }
    if (!looksLikeGeminiKey(key)) {
      return this.result(false, "That doesn't look like a Gemini key (it's 30-ish letters and numbers, often starting with AIza). Nothing was saved.");
    }
    let note = '';
    if (this.deps.check !== undefined) {
      const verdict = await this.deps.check(key).catch((): KeyCheck => 'unreachable');
      if (verdict === 'invalid') return this.result(false, 'Google says that key is not valid, so I did not save it. Check it was copied whole.');
      if (verdict === 'unreachable') note = " (I couldn't reach Google to check it just now.)";
    }
    if (!this.deps.store.save(key)) return this.result(false, "I couldn't save the key. Nothing was changed.");
    this.saved = key;
    if (this.source === 'env') return this.result(true, `Saved, but the key from your environment or .env file is used instead.${note}`);
    return this.result(true, `Saved and protected by Windows. Restart Eya to start using it.${note}`);
  }

  clear(): GeminiKeyResult {
    this.deps.store.clear();
    this.saved = null;
    return this.result(true, this.source === 'saved' ? 'Removed. Eya stops using it the next time she starts.' : 'Removed the saved key.');
  }

  private result(ok: boolean, message: string): GeminiKeyResult {
    return { ok, message, status: this.status() };
  }
}

/** Asks Google whether a key is accepted (a cheap request that lists one model). Never throws. */
export async function checkGeminiKey(key: string, fetchFn: typeof fetch = fetch, timeoutMs = 8000): Promise<KeyCheck> {
  try {
    const response = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return 'valid';
    if (response.status === 400 || response.status === 401 || response.status === 403) return 'invalid';
    return 'unreachable'; // a server error or a limit says nothing about the key
  } catch {
    return 'unreachable';
  }
}
