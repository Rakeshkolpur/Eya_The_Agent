import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';

/**
 * The real Windows layer of the permission box, with every process it would start REPLACED by a recording stub: nothing runs and no permission box can appear from this file, even if a rule
 * were broken. It pins exactly what would be run (one fixed PowerShell, the name only in its environment), and how Windows' answers are read: the PC's names, whether the account is an
 * administrator, whether the box is on the screen, and a "No" by Windows' own error number.
 */

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Record<string, string | undefined> | undefined;
}
interface Answer {
  err: (Error & { code?: number | string; killed?: boolean }) | null;
  stdout: string;
  stderr: string;
}

const h = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[]; env: Record<string, string | undefined> | undefined }>,
  answer: ((): { err: null; stdout: string; stderr: string } => ({ err: null, stdout: '', stderr: '' })) as (file: string, args: string[]) => unknown,
}));

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  type Done = (err: unknown, stdout: string, stderr: string) => void;
  const run = (file: string, args: string[], opts: { env?: Record<string, string | undefined> } | undefined, done: Done): void => {
    h.calls.push({ file, args: [...args], env: opts?.env });
    const a = h.answer(file, [...args]) as { err: unknown; stdout: string; stderr: string };
    done(a.err, a.stdout, a.stderr);
  };
  const execFile = Object.assign((file: string, args: string[], opts: { env?: Record<string, string | undefined> }, cb: Done) => run(file, args, opts, cb), {
    [promisify.custom]: (file: string, args: string[], opts: { env?: Record<string, string | undefined> }) =>
      new Promise((resolve, reject) => run(file, args, opts, (err, stdout, stderr) => (err !== null && err !== undefined ? reject(err) : resolve({ stdout, stderr })))),
  });
  return { execFile, spawn: () => ({ unref: (): void => undefined }) };
});

import { realPcSystem } from '../src/main/pc/pcSystem';

const calls = (): readonly Call[] => h.calls;
const answer = (fn: (file: string, args: string[]) => Partial<Answer>): void => {
  h.answer = (file, args) => ({ err: null, stdout: '', stderr: '', ...fn(file, args) });
};
const failing = (code: number | string | undefined, killed = false): Error & { code?: number | string; killed?: boolean } => Object.assign(new Error('failed'), { ...(code !== undefined ? { code } : {}), killed });

beforeEach(() => {
  h.calls.length = 0;
  answer(() => ({}));
});

describe('renaming goes through one fixed command, handed on through the permission box', () => {
  it('a good name: one PowerShell that asks for the box; the name travels only in its environment', async () => {
    const r = await realPcSystem().renameComputer('Rakhi');
    expect(r).toEqual({ outcome: 'done', code: 0 });
    expect(calls()).toHaveLength(1);
    const c = calls()[0];
    expect(c?.file).toBe('powershell.exe');
    const script = c?.args[(c?.args.indexOf('-Command') ?? -1) + 1] ?? '';
    expect(script).toContain('Start-Process');
    expect(script).toContain('-Verb RunAs');
    expect(script).toContain('-EncodedCommand');
    expect(script).not.toContain('Rakhi');
    expect(c?.env?.['EYA_INNER']).toBe("try { Rename-Computer -NewName 'Rakhi' -Force -ErrorAction Stop; exit 0 } catch { exit 3 }");
  });

  it('a name that is not allowed starts nothing at all', async () => {
    for (const evil of ["a'; calc", 'a b', '', 'x'.repeat(16), '-a', 'a;b', 'a$(calc)', "x'; Remove-Item C:\\ -Recurse; '", 'రాఖీ']) {
      await expect(realPcSystem().renameComputer(evil), JSON.stringify(evil)).rejects.toThrow(/not a name Windows accepts/);
    }
    expect(calls()).toHaveLength(0);
  });

  it('the person clicking No is told by Windows\' own error number (1223), not by its words', async () => {
    answer(() => ({ err: failing(1223) }));
    expect(await realPcSystem().renameComputer('Rakhi')).toEqual({ outcome: 'declined', code: 1223 });
  });

  it('the other ways it ends: Windows refused after a Yes, nobody answered, the command could not start', async () => {
    answer(() => ({ err: failing(3) }));
    expect(await realPcSystem().renameComputer('Rakhi')).toEqual({ outcome: 'failed', code: 3 });
    answer(() => ({ err: failing(undefined, true) }));
    expect(await realPcSystem().renameComputer('Rakhi')).toEqual({ outcome: 'timed_out', code: null });
    answer(() => ({ err: failing('ENOENT') }));
    expect(await realPcSystem().renameComputer('Rakhi')).toEqual({ outcome: 'failed', code: null });
  });

  it('the script itself turns Windows\' "operation was canceled" into 1223, whatever the language', async () => {
    await realPcSystem().renameComputer('Rakhi');
    const c = calls()[0];
    const script = c?.args[(c?.args.indexOf('-Command') ?? -1) + 1] ?? '';
    expect(script).toContain('NativeErrorCode');
    expect(script).toContain('$native -eq 1223');
    expect(script).toContain('exit 1223');
  });
});

describe('reading the PC (nothing is changed)', () => {
  it('the PC\'s names: the one it has now and the one it will have after a restart', async () => {
    answer((file, args) => {
      if (!/reg\.exe$/i.test(file)) return {};
      const key = args.join(' ');
      return { stdout: `\r\nHKEY_LOCAL_MACHINE\\SYSTEM\r\n    ComputerName    REG_SZ    ${key.includes('ActiveComputerName') ? 'OLDNAME' : 'Rakhi'}\r\n\r\n` };
    });
    expect(await realPcSystem().computerNames()).toEqual({ active: 'OLDNAME', pending: 'Rakhi' });
    // (Windows' own reg.exe by its full path, so that no other program of that name can answer)
    expect(calls().every((c) => /[\\/]System32[\\/]reg\.exe$/i.test(c.file) && c.args[0] === 'query')).toBe(true);
  });

  it('when the registry cannot be read it falls back to the name the system gives', async () => {
    answer((file) => (/reg\.exe$/i.test(file) ? { err: failing(1) } : {}));
    expect(await realPcSystem().computerNames()).toEqual({ active: os.hostname(), pending: os.hostname() });
  });

  it('an administrator\'s account is told from a standard user\'s', async () => {
    answer(() => ({ stdout: '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"\r\n' }));
    expect(await realPcSystem().adminAccount()).toBe(true);
    answer(() => ({ stdout: '"Everyone","Well-known group","S-1-1-0","Mandatory group"\r\n' }));
    expect(await realPcSystem().adminAccount()).toBe(false);
    answer(() => ({ err: failing(1) }));
    expect(await realPcSystem().adminAccount()).toBe(false);
    // (Windows' own whoami.exe by its full path: Git for Windows has a whoami of its own that does not understand /groups)
    expect(calls().every((c) => /[\\/]System32[\\/]whoami\.exe$/i.test(c.file))).toBe(true);
  });

  it('the permission box is seen by the process that draws it, and only while it exists', async () => {
    answer(() => ({ stdout: '"consent.exe","4321","Services","0","6,184 K"\r\n' }));
    expect(await realPcSystem().permissionBoxOpen()).toBe(true);
    const c = calls()[0];
    expect(c?.file).toBe('tasklist');
    expect(c?.args).toContain('IMAGENAME eq consent.exe');
    answer(() => ({ stdout: 'INFO: No tasks are running which match the specified criteria.\r\n' }));
    expect(await realPcSystem().permissionBoxOpen()).toBe(false);
  });
});
