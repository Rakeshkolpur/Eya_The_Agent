import { describe, it, expect, vi } from 'vitest';

const { registerSchemesAsPrivileged } = vi.hoisted(() => ({ registerSchemesAsPrivileged: vi.fn() }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'C:\\app' },
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged },
}));

import { registerPrivateSchemes } from '../src/main/privateSchemes';

describe("Eya's private web addresses", () => {
  it('are declared together in ONE call (Electron keeps only the last call, which silently dropped the first scheme)', () => {
    registerSchemesAsPrivileged.mockClear();
    registerPrivateSchemes();
    expect(registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
    const declared = registerSchemesAsPrivileged.mock.calls[0]?.[0] as Array<{ scheme: string; privileges: Record<string, boolean> }>;
    expect(declared.map((s) => s.scheme).sort()).toEqual(['eya-app', 'eya-models']);
  });

  it('can be fetched from a worker and read across origins, and are secure origins (needed for isolation and workers)', () => {
    registerPrivateSchemes();
    const declared = registerSchemesAsPrivileged.mock.calls[0]?.[0] as Array<{ scheme: string; privileges: Record<string, boolean> }>;
    for (const s of declared) {
      expect(s.privileges['standard'], s.scheme).toBe(true);
      expect(s.privileges['secure'], s.scheme).toBe(true);
      expect(s.privileges['supportFetchAPI'], s.scheme).toBe(true);
      expect(s.privileges['corsEnabled'], s.scheme).toBe(true);
    }
  });
});
