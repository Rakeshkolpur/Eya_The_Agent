import { describe, expect, it } from 'vitest';
import { diagnoseMic, isWorking } from '../src/main/pc/micRules';
import type { MicFacts } from '../src/main/pc/micRules';
import { backgroundTargets, groupApps, leftAlone, targetsByName, treeAround } from '../src/main/pc/processRules';
import type { ProcInfo, RuleContext } from '../src/main/pc/processRules';
import { approvedBytes, approvedIsOff, classifyStartup, matchStartup, shownStartupName, startupToTurnOff } from '../src/main/pc/startupRules';
import type { StartupEntry } from '../src/main/pc/startupRules';

/** The rules for what may be stopped, what may be turned off at start-up, and what a microphone problem looks like. */

const p = (pid: number, name: string, mb: number, o: Partial<ProcInfo> = {}): ProcInfo => ({ pid, parent: 1, name, mb, hasWindow: false, path: `C:\\Users\\Rakesh\\AppData\\Local\\${name}\\${name}.exe`, session: 1, ...o });
const ctx: RuleContext = { selfPids: new Set([900]), windir: 'C:\\Windows', session: 1 };

const procs: ProcInfo[] = [
  p(10, 'msedge', 526, { path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' }),
  p(11, 'msedge', 198, { hasWindow: true, path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' }),
  p(12, 'msedge', 168, { path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' }),
  p(20, 'Spotify', 310),
  p(21, 'Spotify', 90),
  p(30, 'OneDrive', 120),
  p(40, 'explorer', 91, { hasWindow: true, path: 'C:\\Windows\\Explorer.EXE' }),
  p(41, 'ShellExperienceHost', 57, { path: 'C:\\Windows\\SystemApps\\ShellExperienceHost_cw5n1h2txyewy\\ShellExperienceHost.exe' }),
  p(42, 'Mystery', 40, { path: 'C:\\Windows\\System32\\mystery.exe' }),
  p(50, 'MsMpEng', 200, { path: 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\MsMpEng.exe' }),
  p(51, 'avgsvc', 80, { path: 'C:\\Program Files\\AVG\\avgsvc.exe' }),
  p(60, 'claude', 502, { path: 'C:\\Program Files\\WindowsApps\\Claude_6\\claude.exe' }),
  p(61, 'node', 70),
  p(62, 'powershell', 86, { path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }),
  p(70, 'RtkAudUService64', 12),
  p(71, 'BrStMonW', 9, { path: 'C:\\Program Files (x86)\\Brother\\BrStMonW.exe' }),
  p(80, 'WINWORD', 150),
  p(90, 'electron', 56, { hasWindow: true }),
  p(900, 'eya', 120),
  p(0, 'svchost', 30, { session: 0 }),
  p(4, 'System', 1),
];
const groups = groupApps(procs, ctx);
const by = (key: string) => groups.find((g) => g.key === key);

describe('programs are judged as a whole, by name', () => {
  it('Edge is one program with a window somewhere: its windowless processes are its tabs and are not swept', () => {
    const edge = by('msedge');
    expect(edge?.pids).toEqual([10, 11, 12]);
    expect(edge?.mb).toBe(526 + 198 + 168);
    expect(edge?.hasWindow).toBe(true);
    expect(backgroundTargets(groups).map((g) => g.key)).not.toContain('msedge');
  });

  it('only programs with no window anywhere that are not Windows, security, a work tool or a hardware helper are swept', () => {
    // (the printer's status monitor is a harmless background program, so it is swept too)
    expect(backgroundTargets(groups).map((g) => g.key).sort()).toEqual(['brstmonw', 'onedrive', 'spotify']);
  });

  it('the groups are biggest first, with their memory added up', () => {
    expect(groups[0]?.key).toBe('msedge');
    expect(by('spotify')?.mb).toBe(400);
  });

  it("another session's programs and the system pseudo-processes are not the person's", () => {
    expect(by('svchost')).toBeUndefined();
    expect(by('system')).toBeUndefined();
  });

  it('the core of Windows is never stopped; a program Windows merely ships (it lives in C:\\Windows) is left out of a sweep but may be named', () => {
    for (const k of ['explorer', 'shellexperiencehost']) {
      expect(by(k)?.keepBecause, k).toBe('part of Windows');
      expect(by(k)?.neverBecause, k).toBe('part of Windows');
    }
    expect(by('mystery')?.keepBecause).toBe('part of Windows');
    expect(by('mystery')?.neverBecause).toBeNull();
  });

  it('security software is kept, and never stopped even by name', () => {
    for (const k of ['msmpeng', 'avgsvc']) {
      expect(by(k)?.keepBecause, k).toBe('security software');
      expect(by(k)?.neverBecause, k).toContain('security software');
    }
  });

  it('the tools a person works in and hardware helpers are kept in a sweep, but may be stopped when asked for by name', () => {
    for (const k of ['claude', 'node', 'powershell', 'winword', 'electron']) {
      expect(by(k)?.keepBecause, k).toBe('a tool you work in');
      expect(by(k)?.neverBecause, k).toBeNull();
    }
    expect(by('rtkauduservice64')?.keepBecause).toContain('hardware');
    expect(by('rtkauduservice64')?.neverBecause).toBeNull();
  });

  it('Eya herself is never stopped', () => {
    expect(by('eya')?.keepBecause).toBe('Eya itself');
    expect(by('eya')?.neverBecause).toBe('Eya itself');
  });

  it('what a sweep leaves alone is listed with the reason', () => {
    const left = leftAlone(groups);
    expect(left.find((x) => x.name === 'msedge')?.why).toBe('you have it open');
    expect(left.find((x) => x.name === 'Explorer')?.why).toBe('part of Windows');
    expect(left.find((x) => x.name === 'Spotify')).toBeUndefined();
  });
});

describe('programs asked for by name', () => {
  it('"spotify", "one drive" and "microsoft edge" find their programs', () => {
    const r = targetsByName(groups, ['spotify', 'one drive', 'microsoft edge']);
    expect(r.matched.map((g) => g.key).sort()).toEqual(['msedge', 'onedrive', 'spotify']);
    expect(r.refused).toEqual([]);
  });

  it('Windows, Eya and security software are refused with the reason; a program that is not running is said so', () => {
    const r = targetsByName(groups, ['explorer', 'defender', 'msmpeng', 'eya', 'notepad2']);
    expect(r.matched).toEqual([]);
    expect(r.refused.map((x) => x.name).sort()).toEqual(['Explorer', 'MsMpEng', 'eya']);
    expect(r.notRunning).toEqual(['defender', 'notepad2']);
  });

  it('a work tool may be stopped when the person names it', () => {
    expect(targetsByName(groups, ['node']).matched.map((g) => g.key)).toEqual(['node']);
  });

  it('a one-letter query matches nothing (it would match everything)', () => {
    expect(targetsByName(groups, ['a', ''])).toEqual({ matched: [], refused: [], notRunning: [] });
  });
});

describe('a program inside another program is left alone (found on a real PC: a sweep would have stopped these)', () => {
  const EYA = 'C:\\Eya\\eya.exe';
  const list: ProcInfo[] = [
    p(100, 'explorer', 90, { hasWindow: true, path: 'C:\\Windows\\Explorer.EXE', parent: 4 }),
    p(110, 'powershell', 80, { path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', parent: 100 }),
    p(200, 'Teams', 300, { hasWindow: true, parent: 100 }),
    p(201, 'msedgewebview2', 164, { path: 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\msedgewebview2.exe', parent: 200 }),
    p(210, 'msedge', 100, { hasWindow: true, path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\msedge.exe', parent: 100 }),
    p(211, 'chrome-native-host', 2, { parent: 210 }),
    p(300, 'esbuild', 27, { parent: 110 }),
    p(310, 'devserver', 60, { parent: 110 }),
    p(320, 'AnyDesk', 11, { parent: 100 }),
    p(400, 'Spotify', 310, { parent: 100 }),
    p(410, 'OneDrive', 120, { parent: 4 }),
    p(500, 'eya', 120, { hasWindow: true, path: EYA, parent: 100 }),
    p(501, 'eya', 80, { path: EYA, parent: 500 }),
    p(510, 'Notepad2', 20, { parent: 500 }),
    p(520, 'SpotifyHelperByEya', 90, { parent: 500 }),
  ];
  const own = treeAround(list, 500);
  const g = groupApps(list, { selfPids: own, windir: 'C:\\Windows', session: 1 });
  const find = (k: string) => g.find((x) => x.key === k);

  it('an embedded web view, a browser\'s native link and a server a developer started are helpers, and are kept', () => {
    expect(find('msedgewebview2')?.keepBecause).toBe('a helper inside another program');
    expect(find('chrome-native-host')?.keepBecause).toBe('a helper inside another program');
    expect(find('esbuild')?.keepBecause).toBe('a tool you work in');
    expect(find('devserver')?.keepBecause).toBe('a helper of powershell');
  });

  it('remote-access programs are kept in a sweep (stopping one could cut the person off), but may be stopped when named', () => {
    expect(find('anydesk')?.keepBecause).toContain('remote access');
    expect(find('anydesk')?.neverBecause).toBeNull();
    expect(targetsByName(g, ['anydesk']).matched.map((x) => x.key)).toEqual(['anydesk']);
  });

  it('a program the Start menu started (its parent is Windows) is swept: Windows starts everything the person opens', () => {
    expect(find('spotify')?.keepBecause).toBeNull();
    expect(find('onedrive')?.keepBecause).toBeNull();
  });

  it("the programs Eya herself started for the person are the person's, and are swept; her own processes are not", () => {
    expect([...own].sort((a, b) => a - b)).toEqual([500, 501]);
    expect(find('notepad2')?.keepBecause).toBeNull();
    expect(find('spotifyhelperbyeya')?.keepBecause).toBeNull();
    expect(find('eya')?.keepBecause).toBe('Eya itself');
    expect(backgroundTargets(g).map((x) => x.key).sort()).toEqual(['notepad2', 'onedrive', 'spotify', 'spotifyhelperbyeya']);
  });
});

describe("Eya's own tree", () => {
  const A = 'C:\\Eya\\eya.exe';
  const tree: ProcInfo[] = [
    p(5000, 'explorer', 1, { parent: 4, path: 'C:\\Windows\\explorer.exe' }),
    p(5100, 'launcher', 1, { parent: 5000 }),
    p(5200, 'eya', 1, { parent: 5100, path: A }),
    p(5300, 'eya', 1, { parent: 5200, path: A }),
    p(5350, 'eya', 1, { parent: 5300, path: A }),
    p(5400, 'spotify', 1, { parent: 5000 }),
    p(5500, 'notepad', 1, { parent: 5200 }),
  ];

  it('is Eya and her own other processes: not what started her, not the other programs the same parent started, and not a program she started', () => {
    const t = treeAround(tree, 5200);
    expect([...t].sort()).toEqual([5200, 5300, 5350]);
    for (const other of [5000, 5100, 5400, 5500]) expect(t.has(other), String(other)).toBe(false);
  });

  it('cannot loop, even when two processes name each other as their parent', () => {
    const loop: ProcInfo[] = [p(10, 'a', 1, { parent: 11 }), p(11, 'a', 1, { parent: 10 })];
    expect([...treeAround(loop, 10)].sort()).toEqual([10, 11]);
    expect([...treeAround([], 10)]).toEqual([10]);
  });
});

const e = (name: string, command: string, enabled = true): StartupEntry => ({ id: `user-registry:${name}`, name, command, source: 'user-registry', enabled });

describe('start-up entries', () => {
  it('on and off are read from the first byte, as Task Manager does', () => {
    expect([2, 6].map(approvedIsOff)).toEqual([false, false]);
    expect([3, 7].map(approvedIsOff)).toEqual([true, true]);
  });

  it('what is written for "on" is 02 and zeros; for "off" it is 03 and the time as a Windows FILETIME', () => {
    expect(approvedBytes(true, 123)).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const off = approvedBytes(false, 1_700_000_000_000);
    expect(off).toHaveLength(12);
    expect(off.slice(0, 4)).toEqual([3, 0, 0, 0]);
    let ft = 0n;
    for (let i = 7; i >= 0; i -= 1) ft = (ft << 8n) | BigInt(off[4 + i] ?? 0);
    expect(ft).toBe(1_700_000_000_000n * 10_000n + 116_444_736_000_000_000n);
  });

  it('security and driver helpers are kept; the usual extras are safe; the rest is the person\'s call', () => {
    expect(classifyStartup(e('SecurityHealth', 'C:\\Windows\\system32\\SecurityHealthSystray.exe')).cls).toBe('keep');
    expect(classifyStartup(e('RtkAudUService', 'C:\\Windows\\System32\\DriverStore\\realtekservice.inf\\RtkAudUService64.exe')).cls).toBe('keep');
    for (const n of ['OneDrive', 'Spotify', 'Discord', 'Steam', 'MicrosoftEdgeAutoLaunch_A54DD1FBCA0F857FE848E5EEA070E463', 'GoogleChromeAutoLaunch_005CF9F8F153BAA959922BF9913D2923', 'BrotherSoftwareUpdateNotification', 'JioSphereUpdaterTaskUser142.0.7444.162', 'Microsoft.Lists']) {
      expect(classifyStartup(e(n, 'C:\\x\\y.exe')).cls, n).toBe('safe');
    }
    expect(classifyStartup(e('BrStsMon00', 'C:\\Program Files (x86)\\Browny02\\Brother\\BrStMonW.exe /AUTORUN')).cls).toBe('optional');
    expect(classifyStartup(e('Ollama.lnk', 'C:\\Users\\Rakesh\\AppData\\Local\\Programs\\Ollama\\ollama app.exe')).cls).toBe('optional');
    expect(classifyStartup(e('SomethingNew', 'C:\\foo\\bar.exe')).cls).toBe('optional');
  });

  it('"ProgramData" is not AMD: a printer\'s monitor in that folder is the person\'s call, not a driver helper (found on a real PC)', () => {
    expect(classifyStartup(e('Brother iPSMonitor.lnk', 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp\\Brother iPSMonitor.lnk')).cls).toBe('optional');
    expect(classifyStartup(e('AMDRSServ', 'C:\\Program Files\\AMD\\x.exe')).cls).toBe('keep');
    expect(classifyStartup(e('Operations', 'C:\\x\\operations.exe')).cls).toBe('optional');
    expect(classifyStartup(e('Steamboat', 'C:\\x\\y.exe')).cls).toBe('optional');
  });

  it('a security helper stays kept even if its name looks like an updater', () => {
    expect(classifyStartup(e('Windows Defender Update', 'C:\\x.exe')).cls).toBe('keep');
  });

  it('"safe" turns off only the safe ones that are on; "all" everything on except what is kept', () => {
    const list = [e('OneDrive', 'a'), e('Spotify', 'b', false), e('SecurityHealth', 'c'), e('SomethingNew', 'd'), e('Discord', 'e')];
    expect(startupToTurnOff(list, 'safe').map((x) => x.name)).toEqual(['OneDrive', 'Discord']);
    expect(startupToTurnOff(list, 'all').map((x) => x.name)).toEqual(['OneDrive', 'SomethingNew', 'Discord']);
  });

  it('asked by name: found, kept ones refused with the reason, unknown ones said', () => {
    const list = [e('OneDrive', 'C:\\OneDrive.exe'), e('SecurityHealth', 'C:\\SecurityHealthSystray.exe'), e('Spotify', 'C:\\Spotify.exe')];
    const r = matchStartup(list, ['onedrive', 'security', 'zzzz', 'x']);
    expect(r.matched.map((x) => x.name)).toEqual(['OneDrive']);
    expect(r.refused).toEqual([{ name: 'SecurityHealth', why: 'Windows security' }]);
    expect(r.unknown).toEqual(['zzzz']);
  });

  it('the long random tail of a browser entry is dropped when it is said aloud', () => {
    expect(shownStartupName({ name: 'MicrosoftEdgeAutoLaunch_A54DD1FBCA0F857FE848E5EEA070E463' })).toBe('MicrosoftEdgeAutoLaunch');
    expect(shownStartupName({ name: 'Ollama.lnk' })).toBe('Ollama');
    expect(shownStartupName({ name: 'JioSphereUpdaterTaskUser142.0.7444.162' })).toBe('JioSphereUpdaterTaskUser');
  });
});

const healthy: MicFacts = {
  accessUser: 'Allow',
  accessMachine: 'Allow',
  accessDesktopApps: 'Allow',
  policyBlocks: false,
  usedNow: [],
  blockedApps: [],
  devices: [
    { name: 'Microphone Array', state: 1 },
    { name: 'Headset Microphone', state: 8 },
  ],
  defaultDevice: { name: 'Microphone Array', muted: false, volume: 80 },
  audioService: 'Running',
  endpointBuilder: 'Running',
};
const diag = (o: Partial<MicFacts>) => diagnoseMic({ ...healthy, ...o });

describe('what is wrong with the microphone', () => {
  it('nothing: it says so, and that the problem is in the program that cannot hear', () => {
    const d = diag({});
    expect(d.windowsLooksFine).toBe(true);
    expect(d.fixes).toEqual([]);
    expect(d.findings[0]).toContain('Nothing is wrong on the Windows side');
    expect(d.findings[0]).toContain('Microphone Array, not muted, volume 80%');
  });

  it('muted: said, and unmute is the fix', () => {
    const d = diag({ defaultDevice: { name: 'Microphone Array', muted: true, volume: 80 } });
    expect(d.findings.some((f) => /MUTED/.test(f))).toBe(true);
    expect(d.fixes).toEqual(['unmute']);
    expect(d.windowsLooksFine).toBe(false);
  });

  it('turned almost all the way down: said, and the volume is the fix', () => {
    const d = diag({ defaultDevice: { name: 'Microphone Array', muted: false, volume: 3 } });
    expect(d.fixes).toEqual(['volume']);
    expect(d.findings.some((f) => /3%/.test(f))).toBe(true);
  });

  it('access switched off in Privacy: said, and the privacy switch is the fix; the desktop-apps switch too', () => {
    expect(diag({ accessUser: 'Deny' }).fixes).toEqual(['privacy']);
    expect(diag({ accessMachine: 'Deny' }).fixes).toEqual(['privacy']);
    const d = diag({ accessDesktopApps: 'Deny' });
    expect(d.fixes).toEqual(['privacy']);
    expect(d.findings.some((f) => /desktop apps/.test(f))).toBe(true);
  });

  it('a policy that blocks it cannot be fixed from here, and is said so', () => {
    const d = diag({ policyBlocks: true, accessUser: 'Deny' });
    expect(d.fixes).toEqual([]);
    expect(d.findings.some((f) => /policy/.test(f) && /cannot turn it back on/.test(f))).toBe(true);
  });

  it('the Windows Audio service not running: restarting it is the fix', () => {
    const d = diag({ audioService: 'Stopped' });
    expect(d.fixes).toEqual(['restart_audio']);
    expect(d.findings[0]).toContain('Windows Audio service is stopped');
    expect(diag({ endpointBuilder: 'Stopped' }).fixes).toEqual(['restart_audio']);
    expect(diag({ audioService: 'Stopped', endpointBuilder: 'Stopped' }).fixes).toEqual(['restart_audio']);
  });

  it('no microphone at all, or none working: said with what Windows does see', () => {
    expect(diag({ devices: [], defaultDevice: null }).findings.some((f) => /does not see any microphone/.test(f))).toBe(true);
    const d = diag({ devices: [{ name: 'Headset Microphone', state: 8 }, { name: 'Microphone Array', state: 2 }, { name: 'Stereo Mix', state: 268435457 }], defaultDevice: null });
    expect(d.findings.some((f) => /None of the microphones is working/.test(f) && /Headset Microphone \(unplugged\)/.test(f) && /Microphone Array \(turned off\)/.test(f))).toBe(true);
    expect(d.findings.some((f) => /Stereo Mix/.test(f))).toBe(false);
  });

  it('a working microphone with no default chosen: said', () => {
    const d = diag({ defaultDevice: null });
    expect(d.findings.some((f) => /no default one chosen/.test(f))).toBe(true);
    expect(d.windowsLooksFine).toBe(false);
  });

  it('a program that has the microphone open, and programs the person blocked, are named', () => {
    const d = diag({ usedNow: ['Zoom'], blockedApps: ['Microsoft.Teams'] });
    expect(d.findings.some((f) => /Zoom has the microphone open right now/.test(f))).toBe(true);
    expect(d.findings.some((f) => /blocked Microsoft.Teams/.test(f))).toBe(true);
    expect(d.windowsLooksFine).toBe(true);
  });

  it('Stereo Mix (it only repeats what the speakers play) is not a microphone', () => {
    expect(isWorking({ name: 'Stereo Mix', state: 268435457 })).toBe(true);
    expect(diag({ devices: [{ name: 'Stereo Mix', state: 268435457 }], defaultDevice: null }).findings.some((f) => /None of the microphones/.test(f))).toBe(true);
  });
});
