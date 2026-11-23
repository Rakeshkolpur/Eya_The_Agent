/**
 * The Windows side of the PC tools on a REAL Windows: the running programs, the start-up entries, the microphone, services and commands — but only ever with a throwaway start-up entry and a
 * throwaway program of its own, and the microphone is only written with the value it already has. Nothing of the person's is stopped or turned off. No permission box is shown.
 *
 * Opt-in: EYA_LIVE_PC=1 npx vitest run tests/live/win.live.test.ts
 * NOT covered here: restarting a service and an administrator command (both show Windows' permission box).
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '.' } }));
import { diagnoseMic } from '../../src/main/pc/micRules';
import { backgroundTargets, groupApps, treeAround } from '../../src/main/pc/processRules';
import { classifyStartup } from '../../src/main/pc/startupRules';
import { realWinSystem } from '../../src/main/pc/winSystem';

const live = process.env['EYA_LIVE_PC'] === '1' && process.platform === 'win32';
const ps = (script: string): string => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
const stamp = Date.now().toString(36).toUpperCase();

describe.skipIf(!live)('the Windows side of the PC tools on this Windows', () => {
  const sys = realWinSystem();
  const RUN_NAME = `EyaLiveTest_${stamp}`;
  const folder = mkdtempSync(join(tmpdir(), 'eya-live-win-'));
  const children: number[] = [];

  afterAll(() => {
    // (whatever happened: the throwaway start-up entry and its approval are gone, and no throwaway program is left running)
    try {
      ps(`Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${RUN_NAME}' -ErrorAction SilentlyContinue; Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' -Name '${RUN_NAME}' -ErrorAction SilentlyContinue`);
    } catch {
      // (nothing to remove)
    }
    for (const pid of children) {
      try {
        process.kill(pid);
      } catch {
        // (already gone)
      }
    }
    rmSync(folder, { recursive: true, force: true });
  }, 60_000);

  it('lists the real running programs, with Eya\'s own process and what started it', async () => {
    const procs = await sys.listProcesses();
    expect(procs.length).toBeGreaterThan(50);
    const me = procs.find((p) => p.pid === process.pid);
    expect(me, 'this test process is in the list').toBeDefined();
    expect(me?.parent).toBeGreaterThan(4);
    expect(procs.some((p) => p.hasWindow)).toBe(true);
    expect(procs.some((p) => /explorer/i.test(p.name) && p.path !== '')).toBe(true);
    const tree = treeAround(procs, process.pid);
    expect(tree.has(process.pid)).toBe(true);
    // (what started it is judged by its own rules, not counted as Eya)
    expect(tree.has(me?.parent ?? -1)).toBe(false);
    const session = me?.session ?? 1;
    const groups = groupApps(procs, { selfPids: tree, windir: process.env['SystemRoot'] ?? 'C:\\Windows', session });
    const explorer = groups.find((g) => g.key === 'explorer');
    expect(explorer?.neverBecause).toBe('part of Windows');
    const swept = backgroundTargets(groups);
    // never anything with a window, never Windows, never this process's own tree
    for (const g of swept) {
      expect(g.hasWindow, g.name).toBe(false);
      expect(g.keepBecause, g.name).toBeNull();
      expect(g.pids.some((pid) => tree.has(pid)), g.name).toBe(false);
    }
    console.log(`[processes] ${procs.length} running, ${groups.length} programs; a sweep would stop: ${swept.map((g) => `${g.name} (${g.mb} MB)`).join(', ') || 'nothing'}`);
    console.log(`[processes] kept in a sweep: ${groups.filter((g) => g.keepBecause !== null || g.hasWindow).slice(0, 8).map((g) => `${g.name} (${g.keepBecause ?? 'open'})`).join(', ')}`);
  }, 60_000);

  it('reads the real start-up entries and judges them', async () => {
    const entries = await sys.startupEntries();
    for (const e of entries) {
      expect(typeof e.name).toBe('string');
      expect(typeof e.enabled).toBe('boolean');
      expect(['user-registry', 'machine-registry', 'machine-registry-32', 'user-folder', 'machine-folder']).toContain(e.source);
    }
    console.log(`[startup] ${entries.map((e) => `${e.name} ${e.enabled ? 'ON' : 'off'} (${classifyStartup(e).cls})`).join('; ')}`);
  }, 60_000);

  it('turns a THROWAWAY start-up entry off and on, and Windows\' own approval value (the one Task Manager reads) says so', async () => {
    ps(`New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${RUN_NAME}' -Value 'C:\\Windows\\System32\\notepad.exe' -PropertyType String -Force | Out-Null`);
    const approvedFirstByte = (): string => ps(`$v = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' -ErrorAction SilentlyContinue).'${RUN_NAME}'; if ($v) { $v[0] } else { 'none' }`);
    const find = async () => (await sys.startupEntries()).find((e) => e.name === RUN_NAME);
    expect((await find())?.enabled).toBe(true);
    await sys.setStartupEnabled({ name: RUN_NAME, source: 'user-registry' }, false);
    expect((await find())?.enabled).toBe(false);
    expect(approvedFirstByte()).toBe('3');
    expect(ps(`(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run').'${RUN_NAME}'.Length`)).toBe('12');
    await sys.setStartupEnabled({ name: RUN_NAME, source: 'user-registry' }, true);
    expect((await find())?.enabled).toBe(true);
    expect(approvedFirstByte()).toBe('2');
    // the entry itself was never touched
    expect(ps(`(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').'${RUN_NAME}'`)).toBe('C:\\Windows\\System32\\notepad.exe');
  }, 90_000);

  it('stops a THROWAWAY program of its own (one with no window), and nothing else', async () => {
    const exe = join(folder, `eya-live-sleeper-${stamp}.exe`);
    copyFileSync(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'ping.exe'), exe);
    const child = spawn(exe, ['-t', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
    if (child.pid !== undefined) children.push(child.pid);
    await new Promise((r) => setTimeout(r, 1500));
    const before = await sys.listProcesses();
    const mine = before.find((p) => p.pid === child.pid);
    expect(mine?.hasWindow).toBe(false);
    expect(mine?.path.toLowerCase()).toBe(exe.toLowerCase());
    const groups = groupApps(before, { selfPids: treeAround(before, process.pid), windir: process.env['SystemRoot'] ?? 'C:\\Windows', session: mine?.session ?? 1 });
    const swept = backgroundTargets(groups);
    const group = groups.find((g) => g.key === `eya-live-sleeper-${stamp}`.toLowerCase());
    expect(group, 'the throwaway program is a group of its own').toBeDefined();
    expect(swept.includes(group!), 'a sweep would stop it').toBe(true);
    await sys.stopProcesses(group!.pids, 'close');
    await new Promise((r) => setTimeout(r, 800));
    const after = await sys.listProcesses();
    expect(after.some((p) => p.pid === child.pid)).toBe(false);
    // everything else that was running is still running
    const stillThere = before.filter((p) => p.pid !== child.pid && p.pid > 4).filter((p) => after.some((a) => a.pid === p.pid)).length;
    expect(stillThere).toBeGreaterThan(before.length - 15);
  }, 90_000);

  it('looks at the real microphone and says what it finds (a write only repeats the value it already has)', async () => {
    const facts = await sys.micFacts();
    const d = diagnoseMic(facts);
    console.log(`[mic] access user=${facts.accessUser} desktop=${facts.accessDesktopApps} policy=${facts.policyBlocks}; devices: ${facts.devices.map((x) => `${x.name}:${x.state}`).join(', ')}; default: ${JSON.stringify(facts.defaultDevice)}; audio=${facts.audioService}/${facts.endpointBuilder}; in use: ${facts.usedNow.join(',') || '-'}`);
    for (const f of d.findings) console.log(`[mic] finding: ${f}`);
    expect(Array.isArray(facts.devices)).toBe(true);
    expect(facts.audioService.length).toBeGreaterThan(0);
    if (facts.defaultDevice !== null) {
      expect(facts.defaultDevice.volume).toBeGreaterThanOrEqual(0);
      expect(facts.defaultDevice.volume).toBeLessThanOrEqual(100);
      // (writing the value it already has: the write path works and changes nothing)
      await sys.setMicMuted(facts.defaultDevice.muted);
      await sys.setMicVolume(facts.defaultDevice.volume);
      const again = await sys.micFacts();
      expect(again.defaultDevice?.muted).toBe(facts.defaultDevice.muted);
      expect(Math.abs((again.defaultDevice?.volume ?? -50) - facts.defaultDevice.volume)).toBeLessThanOrEqual(1);
    }
  }, 120_000);

  it('reads the status of real services (the audio ones are what the microphone needs)', async () => {
    const s = await sys.serviceStatus(['Audiosrv', 'AudioEndpointBuilder', 'NoSuchServiceEya']);
    expect(s['Audiosrv']).toBeDefined();
    expect(s['NoSuchServiceEya']).toBe('Missing');
    // a name that is not a plain service name is not even looked up
    expect(await sys.serviceStatus(["x'; calc"])).toEqual({});
  }, 60_000);

  it('runs a command that only looks, and reports one that fails and one that takes too long', async () => {
    const ok = await sys.runCommand('Get-Date -Format yyyy', { admin: false, timeoutMs: 20_000 });
    expect(ok.outcome).toBe('done');
    expect(ok.output).toMatch(/^20\d\d$/);
    const bad = await sys.runCommand('exit 5', { admin: false, timeoutMs: 20_000 });
    expect(bad.outcome).toBe('failed');
    expect(bad.code).toBe(5);
    const slow = await sys.runCommand('Start-Sleep -Seconds 30', { admin: false, timeoutMs: 1500 });
    expect(slow.outcome).toBe('timed_out');
  }, 60_000);

  it('memory is real', () => {
    const m = sys.memory();
    expect(m.totalMb).toBeGreaterThan(1000);
    expect(m.freeMb).toBeGreaterThan(0);
    expect(m.freeMb).toBeLessThan(m.totalMb);
  });
});
