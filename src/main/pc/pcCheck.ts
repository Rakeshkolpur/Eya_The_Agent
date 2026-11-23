import { checkValue, expectsFolder, isSecretName, joinPath, pathClean, pathKey, shownValue, splitPath } from './envPolicy';
import type { EnvEntry, PcSystem } from './pcSystem';

/**
 * Looking at this PC to find out what is wrong — read only. What it finds is said in plain sentences (`findings`) that the model can pass on, with the facts behind them. It never changes
 * anything and never runs anything but a fixed list of version checks of well-known programs.
 */
export const CHECK_TOPICS = ['overview', 'environment', 'path', 'tool', 'disk', 'network'] as const;
export type CheckTopic = (typeof CHECK_TOPICS)[number];

export interface CheckResult {
  readonly topic: CheckTopic;
  /** What was found, in sentences a person can act on. Empty: nothing wrong was found. */
  readonly findings: readonly string[];
  readonly facts: Readonly<Record<string, unknown>>;
}

/** A well-known program: how to ask its version, and where it usually lives when it is installed. Only these are ever run. */
interface ToolSpec {
  readonly exe: string;
  readonly args: readonly string[];
  /** A `.cmd` program needs the command interpreter. */
  readonly via: 'direct' | 'cmd';
  /** The file that is in its folder (to tell whether it is installed). */
  readonly file: string;
  /** The folders it usually installs into (a * stands for one folder name, or part of one). */
  readonly folders: readonly string[];
  /** The winget package that installs it. */
  readonly winget?: string;
}

const JAVA_FOLDERS = ['%ProgramFiles%\\Java\\*\\bin', '%ProgramFiles%\\Eclipse Adoptium\\*\\bin', '%ProgramFiles%\\Microsoft\\jdk-*\\bin', '%ProgramFiles%\\Zulu\\*\\bin', '%ProgramFiles%\\Amazon Corretto\\*\\bin', '%ProgramFiles%\\BellSoft\\*\\bin'];
const PYTHON_FOLDERS = ['%LOCALAPPDATA%\\Programs\\Python\\Python*', '%ProgramFiles%\\Python*'];
const NODE_FOLDERS = ['%ProgramFiles%\\nodejs', '%ProgramFiles(x86)%\\nodejs', '%LOCALAPPDATA%\\Programs\\nodejs'];

export const TOOLS: Readonly<Record<string, ToolSpec>> = {
  node: { exe: 'node', args: ['--version'], via: 'direct', file: 'node.exe', folders: NODE_FOLDERS, winget: 'OpenJS.NodeJS.LTS' },
  npm: { exe: 'npm', args: ['--version'], via: 'cmd', file: 'npm.cmd', folders: NODE_FOLDERS, winget: 'OpenJS.NodeJS.LTS' },
  npx: { exe: 'npx', args: ['--version'], via: 'cmd', file: 'npx.cmd', folders: NODE_FOLDERS, winget: 'OpenJS.NodeJS.LTS' },
  python: { exe: 'python', args: ['--version'], via: 'direct', file: 'python.exe', folders: PYTHON_FOLDERS, winget: 'Python.Python.3.12' },
  pip: { exe: 'pip', args: ['--version'], via: 'direct', file: 'pip.exe', folders: PYTHON_FOLDERS.map((f) => `${f}\\Scripts`), winget: 'Python.Python.3.12' },
  py: { exe: 'py', args: ['--version'], via: 'direct', file: 'py.exe', folders: ['%LOCALAPPDATA%\\Programs\\Python\\Launcher', '%windir%'], winget: 'Python.Python.3.12' },
  git: { exe: 'git', args: ['--version'], via: 'direct', file: 'git.exe', folders: ['%ProgramFiles%\\Git\\cmd', '%ProgramFiles%\\Git\\bin', '%LOCALAPPDATA%\\Programs\\Git\\cmd'], winget: 'Git.Git' },
  java: { exe: 'java', args: ['-version'], via: 'direct', file: 'java.exe', folders: JAVA_FOLDERS, winget: 'EclipseAdoptium.Temurin.17.JDK' },
  javac: { exe: 'javac', args: ['-version'], via: 'direct', file: 'javac.exe', folders: JAVA_FOLDERS, winget: 'EclipseAdoptium.Temurin.17.JDK' },
  mvn: { exe: 'mvn', args: ['-version'], via: 'cmd', file: 'mvn.cmd', folders: [], winget: 'Apache.Maven' },
  gradle: { exe: 'gradle', args: ['--version'], via: 'cmd', file: 'gradle.bat', folders: [], winget: 'Gradle.Gradle' },
  dotnet: { exe: 'dotnet', args: ['--version'], via: 'direct', file: 'dotnet.exe', folders: ['%ProgramFiles%\\dotnet'], winget: 'Microsoft.DotNet.SDK.8' },
  go: { exe: 'go', args: ['version'], via: 'direct', file: 'go.exe', folders: ['%ProgramFiles%\\Go\\bin'], winget: 'GoLang.Go' },
  rustc: { exe: 'rustc', args: ['--version'], via: 'direct', file: 'rustc.exe', folders: ['%USERPROFILE%\\.cargo\\bin'], winget: 'Rustlang.Rustup' },
  cargo: { exe: 'cargo', args: ['--version'], via: 'direct', file: 'cargo.exe', folders: ['%USERPROFILE%\\.cargo\\bin'], winget: 'Rustlang.Rustup' },
  docker: { exe: 'docker', args: ['--version'], via: 'direct', file: 'docker.exe', folders: ['%ProgramFiles%\\Docker\\Docker\\resources\\bin'], winget: 'Docker.DockerDesktop' },
  winget: { exe: 'winget', args: ['--version'], via: 'direct', file: 'winget.exe', folders: ['%LOCALAPPDATA%\\Microsoft\\WindowsApps'] },
  code: { exe: 'code', args: ['--version'], via: 'cmd', file: 'code.cmd', folders: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\bin'], winget: 'Microsoft.VisualStudioCode' },
  pwsh: { exe: 'pwsh', args: ['--version'], via: 'direct', file: 'pwsh.exe', folders: ['%ProgramFiles%\\PowerShell\\7'], winget: 'Microsoft.PowerShell' },
  curl: { exe: 'curl', args: ['--version'], via: 'direct', file: 'curl.exe', folders: ['%windir%\\System32'] },
  ffmpeg: { exe: 'ffmpeg', args: ['-version'], via: 'direct', file: 'ffmpeg.exe', folders: [], winget: 'Gyan.FFmpeg' },
  adb: { exe: 'adb', args: ['version'], via: 'direct', file: 'adb.exe', folders: [], winget: 'Google.PlatformTools' },
};

/** The program name as a person says it ("Node.js", "node js", "Python 3", "VS Code") → one of the known names, or null. */
export function toolNameFrom(said: string): string | null {
  const t = said.toLowerCase().replace(/\.exe$|\.cmd$/g, '').replace(/[^a-z0-9. ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t in TOOLS) return t;
  const aliases: Record<string, string> = { 'node.js': 'node', nodejs: 'node', 'node js': 'node', 'python3': 'python', 'python 3': 'python', 'python3.12': 'python', jdk: 'java', jre: 'java', 'vs code': 'code', vscode: 'code', 'visual studio code': 'code', 'powershell 7': 'pwsh', powershell7: 'pwsh', maven: 'mvn', '.net': 'dotnet', dotnet: 'dotnet', golang: 'go', rust: 'rustc', 'docker desktop': 'docker' };
  return aliases[t] ?? null;
}

/** Turns a folder pattern into the folders that exist (one * stands for a folder name or part of one). */
export function expandFolders(sys: PcSystem, pattern: string): string[] {
  const segments = sys.expand(pattern).split('\\');
  let paths: string[] = [segments[0] ?? ''];
  for (const seg of segments.slice(1)) {
    const next: string[] = [];
    for (const base of paths) {
      if (!seg.includes('*')) {
        next.push(`${base}\\${seg}`);
        continue;
      }
      const re = new RegExp(`^${seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
      for (const name of sys.listDirs(`${base}\\`).filter((n) => re.test(n))) next.push(`${base}\\${name}`);
    }
    paths = next;
  }
  return paths.filter((p) => sys.folderExists(p));
}

const firstLine = (r: { stdout: string; stderr: string }): string => (`${r.stdout}\n${r.stderr}`.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '').slice(0, 160);

// ------------------------------------------------------------------------------------------------------------------------------------ the topics
async function overview(sys: PcSystem): Promise<CheckResult> {
  const [os, disks, winget, names] = await Promise.all([sys.osInfo(), sys.disks(), sys.run('winget', ['--version'], 8_000), sys.computerNames()]);
  const findings: string[] = [];
  if (names.active.toLowerCase() !== names.pending.toLowerCase()) findings.push(`This PC has been renamed to ${names.pending}; it is still called ${names.active} until it is restarted.`);
  const c = disks.find((d) => d.drive === 'C:');
  if (c !== undefined && c.freeGb < 5) findings.push(`The C: drive has only ${c.freeGb} GB free, which is why installs and updates can fail. Clearing temporary files may help (clear_temp_files), or uninstall something you do not use.`);
  if (os.pendingReboot) findings.push('Windows is waiting for a restart to finish an install or an update. Restart the PC first: many "not working" problems after an install are just this.');
  if (os.uptimeHours > 336) findings.push(`This PC has not been restarted for ${Math.round(os.uptimeHours / 24)} days. A restart often clears odd problems.`);
  if (winget.code !== 0) findings.push('The Windows Package Manager (winget) is not available here, so I cannot install programs for you. Installing "App Installer" from the Microsoft Store brings it.');
  return { topic: 'overview', findings, facts: { computerName: names.pending, computerNameNow: names.active, windows: os.windows, build: os.build, user: os.user, administrator: os.isAdmin, uptimeHours: os.uptimeHours, ramGb: os.ramGb, freeRamGb: os.freeRamGb, restartPending: os.pendingReboot, disks, winget: winget.code === 0 ? firstLine(winget) : 'not available' } };
}

async function environment(sys: PcSystem): Promise<CheckResult> {
  const [user, machine] = await Promise.all([sys.readEnv('user'), sys.readEnv('machine')]);
  const findings: string[] = [];
  const rows: Array<{ name: string; scope: 'user' | 'machine'; value: string; folderExists?: boolean }> = [];
  const add = (scope: 'user' | 'machine', vars: Record<string, EnvEntry>): void => {
    for (const [name, e] of Object.entries(vars)) {
      if (name.toUpperCase() === 'PATH') continue; // (the PATH has its own check)
      const row: { name: string; scope: 'user' | 'machine'; value: string; folderExists?: boolean } = { name, scope, value: shownValue(name, e.value) };
      if (expectsFolder(name) && !isSecretName(name) && /^(?:[A-Za-z]:\\|%)/.test(e.value.trim())) {
        row.folderExists = sys.folderExists(e.value.trim());
        if (!row.folderExists) findings.push(`${name} points at ${e.value.trim()}, which does not exist.`);
      }
      rows.push(row);
    }
  };
  add('user', user);
  add('machine', machine);
  const java = user['JAVA_HOME'] ?? machine['JAVA_HOME'];
  if (java !== undefined) {
    const v = checkValue('JAVA_HOME', java.value, { folderExists: (f) => sys.folderExists(f), fileExists: (f) => sys.fileExists(f) });
    if (!v.ok) findings.push(`JAVA_HOME is wrong: ${v.say}`);
  }
  return { topic: 'environment', findings, facts: { count: rows.length, variables: rows.slice(0, 80), note: 'Values of private-looking names are hidden. PATH is checked separately.' } };
}

async function pathCheck(sys: PcSystem): Promise<CheckResult> {
  const [user, machine] = await Promise.all([sys.readEnv('user'), sys.readEnv('machine')]);
  const findings: string[] = [];
  const facts: Record<string, unknown> = {};
  for (const [scope, vars] of [['user', user], ['machine', machine]] as const) {
    const entry = Object.entries(vars).find(([n]) => n.toUpperCase() === 'PATH')?.[1];
    const entries = entry === undefined ? [] : splitPath(entry.value);
    const clean = pathClean(entries, (e) => sys.folderExists(e));
    const seen = new Set<string>();
    facts[scope] = entries.slice(0, 60).map((e) => {
      const key = pathKey(e);
      const duplicate = seen.has(key);
      seen.add(key);
      return { entry: e, exists: sys.folderExists(e), duplicate };
    });
    facts[`${scope}Length`] = joinPath(entries).length;
    if (clean.missing.length > 0) findings.push(`The ${scope} PATH has ${clean.missing.length} folder${clean.missing.length === 1 ? '' : 's'} that no longer exist: ${clean.missing.slice(0, 5).join('; ')}${clean.missing.length > 5 ? '; …' : ''}.`);
    if (clean.duplicates.length > 0) findings.push(`The ${scope} PATH lists ${clean.duplicates.length} folder${clean.duplicates.length === 1 ? '' : 's'} twice.`);
    if (joinPath(entries).length > 2000) findings.push(`The ${scope} PATH is ${joinPath(entries).length} characters long: some programs cut it at 2047, so folders at its end may not be found.`);
  }
  if (findings.some((f) => f.startsWith('The user PATH'))) findings.push('I can clean the user PATH for you (edit_user_path with action "clean"); the machine PATH needs administrator rights, which I do not use.');
  return { topic: 'path', findings, facts };
}

async function toolCheck(sys: PcSystem, said: string): Promise<CheckResult> {
  const name = toolNameFrom(said);
  if (name === null) {
    return { topic: 'tool', findings: [`I only check these programs: ${Object.keys(TOOLS).join(', ')}. For another one, ask what it does and I will look it up.`], facts: { known: Object.keys(TOOLS) } };
  }
  const spec = TOOLS[name] as ToolSpec;
  const findings: string[] = [];
  const onPath = await sys.where(spec.exe);
  // (the real program, not the Microsoft Store shortcut that opens the Store instead)
  const real = onPath.filter((p) => !/\\WindowsApps\\/i.test(p) || name === 'winget');
  const storeOnly = onPath.length > 0 && real.length === 0;
  let version = '';
  let versionFailed = false;
  if (onPath.length > 0) {
    const r = spec.via === 'cmd' ? await sys.run('cmd.exe', ['/d', '/s', '/c', `${spec.exe} ${spec.args.join(' ')}`], 15_000) : await sys.run(spec.exe, spec.args, 15_000);
    version = firstLine(r);
    versionFailed = r.code !== 0 || r.timedOut || version === '';
  }
  const installed: string[] = [];
  for (const pattern of spec.folders) for (const folder of expandFolders(sys, pattern)) if (sys.fileExists(`${folder}\\${spec.file}`)) installed.push(folder);
  const missingFromPath = installed.filter((f) => !onPath.some((p) => pathKey(p).startsWith(pathKey(f))));
  if (storeOnly) {
    findings.push(`"${spec.exe}" here is only the Microsoft Store shortcut, not the real program: it opens the Store instead of running. ${spec.winget !== undefined ? `Installing the real one fixes it: winget package ${spec.winget} (install_program).` : ''}`.trim());
  } else if (onPath.length > 0 && !versionFailed) {
    findings.push(`${spec.exe} works: ${version} (found at ${real[0] ?? onPath[0]}).`);
  } else if (onPath.length > 0) {
    findings.push(`${spec.exe} is on the PATH (${real[0] ?? onPath[0]}) but asking its version failed${version !== '' ? `: ${version}` : ''}. Its installation may be damaged; reinstalling it usually fixes this.`);
  } else if (installed.length > 0) {
    findings.push(`${spec.exe} is installed in ${installed[0]} but that folder is not on your PATH, which is why a terminal says "'${spec.exe}' is not recognized". I can add the folder to your user PATH (edit_user_path). After that, open a NEW terminal.`);
  } else {
    findings.push(`${spec.exe} is not installed (I looked on the PATH and in its usual folders).${spec.winget !== undefined ? ` I can install it with winget: ${spec.winget} (install_program, after you say yes).` : ' I can look for it with find_program.'}`);
  }
  const facts: Record<string, unknown> = { program: spec.exe, onPath, version: version === '' ? null : version, installedFolders: installed, notOnPath: missingFromPath, wingetPackage: spec.winget ?? null };
  if (name === 'java' || name === 'javac') {
    const [user, machine] = await Promise.all([sys.readEnv('user'), sys.readEnv('machine')]);
    const home = user['JAVA_HOME'] ?? machine['JAVA_HOME'];
    const candidates = installed.map((f) => f.replace(/\\bin$/i, ''));
    facts['javaHome'] = home?.value ?? null;
    facts['javaHomeCandidates'] = candidates;
    if (home === undefined) {
      findings.push(candidates.length > 0 ? `JAVA_HOME is not set. It should be ${candidates[0]} (set_environment_variable).` : 'JAVA_HOME is not set (and I could not find a Java installation to point it at).');
    } else {
      const v = checkValue('JAVA_HOME', home.value, { folderExists: (f) => sys.folderExists(f), fileExists: (f) => sys.fileExists(f) });
      if (!v.ok) findings.push(`JAVA_HOME is wrong: ${v.say}${candidates.length > 0 ? ` It should be ${candidates[0]}.` : ''}`);
    }
  }
  return { topic: 'tool', findings, facts };
}

async function disk(sys: PcSystem): Promise<CheckResult> {
  const disks = await sys.disks();
  const temp = sys.scanTemp(2 * 24 * 3600_000);
  const findings: string[] = [];
  for (const d of disks) if (d.freeGb < 5) findings.push(`${d.drive} has only ${d.freeGb} GB free of ${d.totalGb} GB.`);
  if (temp.oldBytes > 500 * 1024 * 1024) findings.push(`${Math.round(temp.oldBytes / (1024 * 1024))} MB of old temporary files are in ${temp.dir}: I can clear them (clear_temp_files).`);
  return { topic: 'disk', findings, facts: { disks, temp: { folder: temp.dir, files: temp.files, mb: Math.round(temp.bytes / (1024 * 1024)), oldFiles: temp.oldFiles, oldMb: Math.round(temp.oldBytes / (1024 * 1024)) } } };
}

async function network(sys: PcSystem): Promise<CheckResult> {
  const n = await sys.network();
  const findings: string[] = [];
  if (n.adapters === 0) findings.push('No network connection is active (no adapter has an address). Check the Wi-Fi or the cable first.');
  else if (!n.dns && !n.internet) findings.push('This PC has a network connection but cannot reach the internet at all. Restart the router, or check the Wi-Fi password and any VPN.');
  else if (!n.dns) findings.push('Names are not being looked up (DNS), although the internet is reachable. Flushing the DNS cache may help (flush_dns), or set the DNS to 8.8.8.8 in the network settings.');
  else if (!n.internet) findings.push('Names are looked up but the web is not reachable: a proxy, a VPN or a firewall may be in the way.');
  if (n.proxy !== null) findings.push(`A proxy is set (${n.proxy}). If browsing or installs fail, a wrong proxy is a common cause.`);
  return { topic: 'network', findings, facts: { ...n } };
}

/** Looks at this PC for one topic (read only). `name`: the program, for the tool topic. */
export async function runCheck(sys: PcSystem, topic: CheckTopic, name = ''): Promise<CheckResult> {
  switch (topic) {
    case 'overview':
      return overview(sys);
    case 'environment':
      return environment(sys);
    case 'path':
      return pathCheck(sys);
    case 'tool':
      return toolCheck(sys, name);
    case 'disk':
      return disk(sys);
    case 'network':
      return network(sys);
  }
}
