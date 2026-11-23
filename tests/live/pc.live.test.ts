/**
 * The PC tools on a REAL Windows: the user's real environment (HKCU\Environment) and the real winget — but only ever with a throwaway variable and a throwaway folder, and the user PATH is
 * put back exactly as it was (value and kind) whatever happens. Nothing is installed and no temporary file is deleted.
 *
 * Opt-in: EYA_LIVE_PC=1 npx vitest run tests/live/pc.live.test.ts
 * NOT covered: an install (it would change this PC), restart_explorer (it would close the person's windows), the machine environment (read only here).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '.' } }));
import { PcJournal } from '../../src/main/pc/PcJournal';
import { ELEVATION_SCRIPT, realPcSystem } from '../../src/main/pc/pcSystem';
import type { EnvEntry } from '../../src/main/pc/pcSystem';
import { createPcTools } from '../../src/main/tools/impl/pcTools';
import type { ToolArgs, ToolResult } from '../../src/main/tools/types';
import { MemIo } from '../pcFixtures';

const live = process.env['EYA_LIVE_PC'] === '1' && process.platform === 'win32';

const ps = (script: string): string => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();

describe.skipIf(!live)('the PC tools on this Windows', () => {
  const sys = realPcSystem();
  const journal = new PcJournal('pc-live.json', new MemIo());
  const tools = createPcTools({ sys, journal });
  const call = async (name: string, args: ToolArgs = {}): Promise<ToolResult> => {
    const tool = tools.find((t) => t.schema.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.execute(args);
  };
  const VAR = `EYA_LIVE_TEST_${Date.now().toString(36).toUpperCase()}_HOME`;
  let folder = '';
  let pathBefore: EnvEntry | undefined;
  const userPath = async (): Promise<EnvEntry | undefined> => Object.entries(await sys.readEnv('user')).find(([n]) => n.toUpperCase() === 'PATH')?.[1];

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'eya-live-pc-'));
    pathBefore = await userPath();
  });

  afterAll(async () => {
    // (whatever happened, the user PATH is exactly what it was, and the throwaway variable is gone)
    if (pathBefore !== undefined) {
      const now = await userPath();
      if (now === undefined || now.value !== pathBefore.value || now.kind !== pathBefore.kind) await sys.writeEnv('Path', pathBefore.value, pathBefore.kind);
    }
    await sys.deleteEnv(VAR).catch(() => undefined);
    rmSync(folder, { recursive: true, force: true });
  }, 60_000);

  it('reads the real environment: the user\'s and the machine\'s, with their kinds', async () => {
    const user = await sys.readEnv('user');
    const machine = await sys.readEnv('machine');
    expect(Object.keys(machine).length).toBeGreaterThan(3);
    expect(Object.keys(machine).some((n) => n.toUpperCase() === 'PATH')).toBe(true);
    expect(typeof user).toBe('object');
    for (const e of Object.values(machine)) expect(['String', 'ExpandString']).toContain(e.kind);
  }, 60_000);

  it('sets a variable: asks first, then writes it to the REAL registry (checked by a fresh PowerShell), and undoes it', async () => {
    const asked = await call('set_environment_variable', { name: VAR, value: folder });
    expect(asked.summary).toBe('needs confirmation');
    expect(ps(`[Environment]::GetEnvironmentVariable('${VAR}','User')`)).toBe('');
    const done = await call('set_environment_variable', { name: VAR, value: folder, confirm: true });
    expect(done.ok, done.error).toBe(true);
    expect(ps(`[Environment]::GetEnvironmentVariable('${VAR}','User')`)).toBe(folder);
    const undone = await call('undo_pc_change', { confirm: true });
    expect(undone.ok, undone.error).toBe(true);
    expect(ps(`[Environment]::GetEnvironmentVariable('${VAR}','User')`)).toBe('');
  }, 120_000);

  it('adds a folder to the REAL user PATH and takes it off again: the PATH is then exactly as it was, value and kind', async () => {
    const added = await call('edit_user_path', { action: 'add', folder, confirm: true });
    expect(added.ok, added.error).toBe(true);
    const during = await userPath();
    expect(during?.value.toLowerCase()).toContain(folder.toLowerCase());
    expect(during?.kind).toBe(pathBefore?.kind ?? 'ExpandString');
    // (a fresh process sees it: the registry really has it)
    expect(ps(`[Environment]::GetEnvironmentVariable('Path','User')`).toLowerCase()).toContain(folder.toLowerCase());
    const undone = await call('undo_pc_change', { confirm: true });
    expect(undone.ok, undone.error).toBe(true);
    const after = await userPath();
    expect(after?.value).toBe(pathBefore?.value);
    expect(after?.kind).toBe(pathBefore?.kind);
  }, 120_000);

  it('looks at the real PC: overview, PATH, environment, disk, network and a program', async () => {
    for (const topic of ['overview', 'path', 'environment', 'disk', 'network']) {
      const r = await call('pc_check', { topic });
      expect(r.ok, `${topic}: ${r.error}`).toBe(true);
      expect(Array.isArray(r.data?.['findings'])).toBe(true);
      console.log(`[pc_check ${topic}]`, (r.data?.['findings'] as string[]).join(' | ') || 'nothing wrong found');
    }
    const overview = (await call('pc_check', { topic: 'overview' })).data?.['facts'] as Record<string, unknown>;
    expect(String(overview['windows'])).toMatch(/Windows/);
    expect((overview['disks'] as unknown[]).length).toBeGreaterThan(0);
    const node = await call('pc_check', { topic: 'tool', program: 'node' });
    expect(node.ok).toBe(true);
    console.log('[pc_check node]', (node.data?.['findings'] as string[]).join(' | '));
    const git = await call('pc_check', { topic: 'tool', program: 'git' });
    console.log('[pc_check git]', (git.data?.['findings'] as string[]).join(' | '));
  }, 180_000);

  it('searches the real winget and asks before installing (nothing is installed)', async () => {
    const found = await call('find_program', { query: 'git' });
    if (!found.ok && /not available/i.test(found.error ?? '')) {
      console.log('[winget] not available on this PC: skipped');
      return;
    }
    expect(found.ok, found.error).toBe(true);
    const ids = (found.data?.['packages'] as Array<{ id: string }>).map((p) => p.id);
    console.log('[find_program git]', ids.join(', '));
    expect(ids).toContain('Git.Git');
    const asked = await call('install_program', { id: 'Git.Git' });
    expect(asked.summary).toBe('needs confirmation');
    expect(asked.error).toMatch(/^Install Git .* from the official Windows Package Manager\?/);
  }, 180_000);

  it('reads the real PC name, whether the account is an administrator and whether a permission box is open; a rename and an uninstall only ASK', async () => {
    const names = await sys.computerNames();
    expect(names.active.toLowerCase()).toBe(hostname().toLowerCase());
    expect(names.pending.length).toBeGreaterThan(0);
    const admin = await sys.adminAccount();
    const box = await sys.permissionBoxOpen();
    console.log(`[names] now ${names.active}, after a restart ${names.pending}; administrator account: ${admin}; permission box open: ${box}`);
    // (checked against Windows' own answer, asked a different way)
    const groups = execFileSync(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'whoami.exe'), ['/groups'], { encoding: 'utf8', windowsHide: true });
    expect(admin).toBe(groups.includes('S-1-5-32-544'));
    expect(box).toBe(false);
    const asked = await call('rename_pc', { name: 'Eya-Live-Test' });
    expect(asked.summary).toBe('needs confirmation');
    expect(asked.error).toContain(`from ${names.pending} to Eya-Live-Test`);
    expect(asked.error).toContain('permission box');
    expect(await sys.computerNames()).toEqual(names);
    const notThere = await call('uninstall_program', { id: 'Eya.Surely.NotInstalled' });
    expect(notThere.summary).toBe('not installed');
    const overview = await call('pc_check', { topic: 'overview' });
    expect((overview.data as { facts: { computerName: string } }).facts.computerName.toLowerCase()).toBe(names.pending.toLowerCase());
  }, 120_000);

  it('the script that asks for the permission box turns a "No" into 1223 whatever the language (real PowerShell; the start of the elevated command is swapped for the error Windows raises, so NO box appears)', () => {
    const swap = (replacement: string): string => ELEVATION_SCRIPT.replace(/\$p = Start-Process[^\n]*\n/, `${replacement}\n`);
    const run = (script: string): number | null => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, EYA_INNER: 'exit 0' } }).status;
    expect(ELEVATION_SCRIPT).toMatch(/\$p = Start-Process/);
    // Windows' own error number inside, under words of another language
    expect(run(swap("throw (New-Object System.InvalidOperationException 'Une erreur est survenue', (New-Object System.ComponentModel.Win32Exception 1223))"))).toBe(1223);
    // the words alone
    expect(run(swap("throw 'This command cannot be run due to the error: The operation was canceled by the user.'"))).toBe(1223);
    // any other error is not taken for a No
    expect(run(swap("throw 'something else went wrong'"))).toBe(1);
    expect(run(swap("throw (New-Object System.InvalidOperationException 'x', (New-Object System.ComponentModel.Win32Exception 5))"))).toBe(1);
    // and when the command started and ended, its own exit code is passed on
    expect(run(swap('$p = [pscustomobject]@{ ExitCode = 3 }'))).toBe(3);
  }, 60_000);

  it('flush_dns on the real PC either works or says it needs administrator rights', async () => {
    const r = await call('flush_dns');
    console.log('[flush_dns]', r.ok ? 'done' : r.error);
    expect(r.ok || /administrator/i.test(r.error ?? '')).toBe(true);
  }, 60_000);

  it('the real temp folder is scanned (and nothing is deleted)', () => {
    const scan = sys.scanTemp(2 * 24 * 3600_000);
    expect(scan.dir.length).toBeGreaterThan(3);
    expect(scan.files).toBeGreaterThanOrEqual(0);
    console.log(`[temp] ${scan.files} files, ${Math.round(scan.bytes / 1048576)} MB, ${scan.oldFiles} old (${Math.round(scan.oldBytes / 1048576)} MB)`);
  });
});
