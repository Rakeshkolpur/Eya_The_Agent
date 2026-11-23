import { describe, it, expect } from 'vitest';
import { ISOLATION_HEADERS, withIsolationHeaders } from '../src/main/isolationHeaders';

describe('the cross-origin isolation headers', () => {
  it('are added to a response that has none', () => {
    expect(withIsolationHeaders({ 'content-type': ['text/html'] })).toEqual({
      'content-type': ['text/html'],
      'Cross-Origin-Opener-Policy': ['same-origin'],
      'Cross-Origin-Embedder-Policy': ['credentialless'],
    });
    expect(withIsolationHeaders(undefined)).toEqual({ 'Cross-Origin-Opener-Policy': ['same-origin'], 'Cross-Origin-Embedder-Policy': ['credentialless'] });
  });

  it('replace ones already there, whatever the case of their names, so each appears exactly once', () => {
    // Chromium reports header names in lower case; adding the capitalised name beside them made "same-origin, same-origin" (invalid),
    // which switched isolation off and made the browser refuse to start the speech worker in the installed app.
    for (const present of [
      { 'cross-origin-opener-policy': ['same-origin'], 'cross-origin-embedder-policy': ['credentialless'] },
      { 'Cross-Origin-Opener-Policy': ['unsafe-none'], 'CROSS-ORIGIN-EMBEDDER-POLICY': ['require-corp'] },
    ]) {
      const out = withIsolationHeaders(present);
      const names = Object.keys(out).filter((n) => /cross-origin-(opener|embedder)-policy/i.test(n));
      expect(names.length).toBe(2);
      expect(out['Cross-Origin-Opener-Policy']).toEqual(['same-origin']);
      expect(out['Cross-Origin-Embedder-Policy']).toEqual(['credentialless']);
    }
  });

  it('leave every other header alone, and do not change what it was given', () => {
    const given = { 'content-type': ['application/wasm'], 'cache-control': ['no-cache'], 'cross-origin-opener-policy': ['x'] };
    const copy = JSON.parse(JSON.stringify(given));
    const out = withIsolationHeaders(given);
    expect(out['content-type']).toEqual(['application/wasm']);
    expect(out['cache-control']).toEqual(['no-cache']);
    expect(given).toEqual(copy);
  });

  it('are the same two the protocol handler sends', () => {
    expect(ISOLATION_HEADERS).toEqual({ 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' });
  });
});
