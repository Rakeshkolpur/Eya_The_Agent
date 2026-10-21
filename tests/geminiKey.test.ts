import { describe, it, expect } from 'vitest';
import { GeminiKeyService, GeminiKeyStore, checkGeminiKey, keyHint, looksLikeGeminiKey } from '../src/main/config/geminiKey';
import type { KeyCheck, KeyCrypto, KeyFiles } from '../src/main/config/geminiKey';

const KEY = 'AIzaSyD-example_key_0123456789abcdefghij';
const OTHER = 'AIzaSyD-another_key_9876543210zyxwvutsrq';

/** "Encryption" that is visibly not plain text and can be told to fail, so the tests can see what reaches the disk. */
function crypto(available = true): KeyCrypto & { calls: number } {
  return {
    calls: 0,
    isAvailable: () => available,
    encrypt(text) {
      this.calls += 1;
      return Buffer.from(`ENC:${Buffer.from(text).toString('base64')}`);
    },
    decrypt(data) {
      const s = data.toString();
      if (!s.startsWith('ENC:')) throw new Error('not ours');
      return Buffer.from(s.slice(4), 'base64').toString();
    },
  };
}

function files(): KeyFiles & { disk: Map<string, Buffer> } {
  const disk = new Map<string, Buffer>();
  return {
    disk,
    read: (p) => disk.get(p) ?? null,
    write: (p, d) => void disk.set(p, d),
    remove: (p) => void disk.delete(p),
  };
}

function setup(opts: { env?: Record<string, string>; saved?: string; available?: boolean; check?: (k: string) => Promise<KeyCheck> } = {}) {
  const c = crypto(opts.available ?? true);
  const f = files();
  const store = new GeminiKeyStore('key.bin', c, f);
  if (opts.saved !== undefined) f.disk.set('key.bin', c.encrypt(opts.saved));
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? {}) };
  const service = new GeminiKeyService({ store, env, ...(opts.check !== undefined ? { check: opts.check } : {}) });
  service.start();
  return { service, env, disk: f.disk, store };
}

describe('what a Gemini key looks like', () => {
  it('accepts a normal key and refuses anything else', () => {
    expect(looksLikeGeminiKey(KEY)).toBe(true);
    for (const bad of ['', 'short', 'has spaces in it AIzaSyD-example_key_0123456789abc', 'AIza!@#$%^&*()_+=-0123456789abcdef', 'x'.repeat(200), 'line\nbreak0123456789abcdefghij']) {
      expect(looksLikeGeminiKey(bad), bad).toBe(false);
    }
  });

  it('shows only the last four characters', () => {
    expect(keyHint(KEY)).toBe('…ghij');
    expect(keyHint(KEY)).not.toContain('AIza');
  });
});

describe('the saved key file', () => {
  it('is encrypted: the key never reaches the disk as text', () => {
    const { store, disk } = setup();
    expect(store.save(KEY)).toBe(true);
    const raw = disk.get('key.bin')?.toString() ?? '';
    expect(raw.startsWith('ENC:')).toBe(true);
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain('AIzaSyD');
    expect(store.load()).toBe(KEY);
  });

  it('is never written when Windows cannot protect it', () => {
    const { store, disk } = setup({ available: false });
    expect(store.canSave).toBe(false);
    expect(store.save(KEY)).toBe(false);
    expect(disk.size).toBe(0);
  });

  it('refuses a malformed key, and reads nothing from a file it cannot decrypt (another user or machine) or one that is damaged', () => {
    const { store, disk } = setup();
    expect(store.save('nope')).toBe(false);
    disk.set('key.bin', Buffer.from('written by someone else'));
    expect(store.load()).toBeNull();
    disk.set('key.bin', Buffer.alloc(0));
    expect(store.load()).toBeNull();
    disk.set('key.bin', Buffer.from(`ENC:${Buffer.from('not a key').toString('base64')}`));
    expect(store.load()).toBeNull();
  });

  it('can be removed, and removing what is not there is fine', () => {
    const { store, disk } = setup({ saved: KEY });
    store.clear();
    expect(disk.size).toBe(0);
    expect(() => store.clear()).not.toThrow();
  });
});

describe('the key Eya uses', () => {
  it('puts a saved key where the rest of Eya looks for it, at start-up', () => {
    const { service, env } = setup({ saved: KEY });
    expect(env['EYA_GEMINI_API_KEY']).toBe(KEY);
    expect(service.status()).toEqual({ source: 'saved', hint: '…ghij', pendingRestart: false, canSave: true });
  });

  it('lets a key from the environment or a .env file win, as it always did', () => {
    const { service, env } = setup({ saved: KEY, env: { EYA_GEMINI_API_KEY: OTHER } });
    expect(env['EYA_GEMINI_API_KEY']).toBe(OTHER);
    expect(service.status()).toMatchObject({ source: 'env', hint: '…tsrq', pendingRestart: false });
  });

  it('says there is none when there is none, and treats a blank environment value as none', () => {
    expect(setup().service.status()).toEqual({ source: 'none', hint: null, pendingRestart: false, canSave: true });
    expect(setup({ env: { EYA_GEMINI_API_KEY: '   ' } }).service.status().source).toBe('none');
  });

  it('never gives the page the key, only where it came from and its last four characters', () => {
    const { service } = setup({ saved: KEY });
    expect(JSON.stringify(service.status())).not.toContain('AIza');
    expect(JSON.stringify(service.status())).not.toContain('SyD');
  });
});

describe('saving a key from Settings', () => {
  it('checks it with Google, saves it protected, and says it applies on the next start', async () => {
    const asked: string[] = [];
    const { service, disk } = setup({ check: async (k) => (asked.push(k), 'valid') });
    const result = await service.set(`  ${KEY}\n`);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Restart Eya to start using it/);
    expect(asked).toEqual([KEY]); // trimmed
    expect(disk.get('key.bin')?.toString().startsWith('ENC:')).toBe(true);
    expect(result.status).toMatchObject({ source: 'none', pendingRestart: true }); // not in use yet
    expect(JSON.stringify(result)).not.toContain('AIza');
  });

  it('does not save a key Google rejects', async () => {
    const { service, disk } = setup({ check: async () => 'invalid' });
    const result = await service.set(KEY);
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toMatch(/not valid/);
    expect(disk.size).toBe(0);
  });

  it('still saves when Google cannot be reached, and says it could not check', async () => {
    const { service } = setup({ check: async () => 'unreachable' });
    const result = await service.set(KEY);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/couldn't reach Google/);
    expect((await setup({ check: () => Promise.reject(new Error('boom')) }).service.set(KEY)).ok).toBe(true); // a throwing check is "unreachable", not a crash
  });

  it('refuses nonsense and non-strings without touching anything', async () => {
    const { service, disk } = setup({ check: async () => 'valid' });
    for (const bad of ['', 'abc', 42, null, undefined, { key: KEY }]) expect((await service.set(bad)).ok, String(bad)).toBe(false);
    expect(disk.size).toBe(0);
  });

  it('saves nothing when Windows cannot protect it', async () => {
    const { service, disk } = setup({ available: false, check: async () => 'valid' });
    const result = await service.set(KEY);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/can't protect/);
    expect(disk.size).toBe(0);
  });

  it('keeps the environment key in charge, and says so', async () => {
    const { service } = setup({ env: { EYA_GEMINI_API_KEY: OTHER }, check: async () => 'valid' });
    const result = await service.set(KEY);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/environment or \.env file is used instead/);
    expect(result.status.pendingRestart).toBe(false);
  });

  it('replacing a key in use waits for a restart, and removing it does too', async () => {
    const { service, disk } = setup({ saved: KEY, check: async () => 'valid' });
    const replaced = await service.set(OTHER);
    expect(replaced.status).toMatchObject({ source: 'saved', hint: '…ghij', pendingRestart: true }); // still running on the old one
    const removed = service.clear();
    expect(removed.ok).toBe(true);
    expect(removed.message).toMatch(/stops using it the next time/);
    expect(disk.size).toBe(0);
    expect(removed.status.pendingRestart).toBe(true);
  });
});

describe('asking Google if a key is accepted', () => {
  const answer = (status: number): typeof fetch => (async () => new Response('{}', { status })) as unknown as typeof fetch;

  it('reads the answer: accepted, rejected, or no answer', async () => {
    expect(await checkGeminiKey(KEY, answer(200))).toBe('valid');
    for (const status of [400, 401, 403]) expect(await checkGeminiKey(KEY, answer(status)), String(status)).toBe('invalid');
    for (const status of [429, 500, 503]) expect(await checkGeminiKey(KEY, answer(status)), String(status)).toBe('unreachable'); // says nothing about the key
    expect(await checkGeminiKey(KEY, (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch)).toBe('unreachable');
  });

  it('sends the key only to Google, as a properly encoded query value', async () => {
    let url = '';
    await checkGeminiKey('AIza_a-b', (async (u: string) => ((url = u), new Response('{}', { status: 200 }))) as unknown as typeof fetch);
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=AIza_a-b');
  });
});
