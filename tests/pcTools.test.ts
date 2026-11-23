import { describe, expect, it, vi } from 'vitest';
import { FakePc, pcRig, wingetThatKnows } from './pcFixtures';

vi.mock('electron', () => ({ app: { getPath: () => '.' } }));

/**
 * "If the user has a problem on the PC — installing, setting an environment variable, a setting that is not working — Eya fixes it." Over a PRETEND Windows: what the tools look at, what they refuse, that
 * every change asks first with its exact words, is read back, is written down, and can be undone.
 */

const JDK = 'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.9.9-hotspot';
const GIT = { name: 'Git', id: 'Git.Git', version: '2.43.0', publisher: 'The Git Development Community' };

function withJava(sys: FakePc): void {
  sys.file(`${JDK}\\bin\\java.exe`, `${JDK}\\bin\\javac.exe`);
  sys.dirs['c:\\program files\\eclipse adoptium'] = ['jdk-17.0.9.9-hotspot'];
}

describe('set_environment_variable', () => {
  it('asks first with the old and the new value, and changes nothing until the person says yes', async () => {
    const { sys, call, journal } = pcRig();
    withJava(sys);
    sys.user['JAVA_HOME'] = { value: 'C:\\old', kind: 'String' };
    const asked = await call('set_environment_variable', { name: 'JAVA_HOME', value: JDK });
    expect(asked.ok).toBe(false);
    expect(asked.summary).toBe('needs confirmation');
    expect(asked.error).toMatch(/Set the JAVA_HOME variable for your user to C:\\Program Files\\Eclipse Adoptium\\jdk-17\.0\.9\.9-hotspot\? It is now C:\\old\./);
    expect(asked.data).toMatchObject({ status: 'permission_required', action: 'set_environment_variable', target: 'JAVA_HOME' });
    expect(sys.writes).toEqual([]);
    expect(journal.list()).toEqual([]);
  });

  it('with the yes it sets it, reads it back, writes it down, and says a new terminal is needed', async () => {
    const { sys, call, journal } = pcRig();
    withJava(sys);
    const done = await call('set_environment_variable', { name: 'JAVA_HOME', value: JDK, confirm: true });
    expect(done.ok, done.error).toBe(true);
    expect(sys.writes).toEqual([{ name: 'JAVA_HOME', value: JDK, kind: 'String' }]);
    expect(done.data).toMatchObject({ changed: true, verified: true, evidence: 'read back from the registry' });
    expect(String(done.data?.['note'])).toMatch(/NEW terminal/);
    expect(journal.list()).toHaveLength(1);
    expect(journal.list()[0]).toMatchObject({ kind: 'env', name: 'JAVA_HOME', before: { exists: false }, after: { exists: true, value: JDK } });
  });

  it('a value Windows quietly refused is NOT reported as set', async () => {
    const { sys, call, journal } = pcRig();
    withJava(sys);
    sys.writeIgnored = true;
    const done = await call('set_environment_variable', { name: 'JAVA_HOME', value: JDK, confirm: true });
    expect(done.ok).toBe(false);
    expect(done.summary).toBe('could not confirm');
    expect(journal.list()).toEqual([]);
  });

  it('refuses what is wrong, in words: the bin folder, a missing folder, PATH, a name Windows relies on', async () => {
    const { sys, call } = pcRig();
    withJava(sys);
    const bin = await call('set_environment_variable', { name: 'JAVA_HOME', value: `${JDK}\\bin`, confirm: true });
    expect(bin.error).toMatch(/not its "bin" folder: use .*jdk-17\.0\.9\.9-hotspot instead/);
    expect((await call('set_environment_variable', { name: 'ANDROID_HOME', value: 'C:\\nowhere', confirm: true })).error).toMatch(/does not exist/);
    expect((await call('set_environment_variable', { name: 'PATH', value: 'C:\\x', confirm: true })).error).toMatch(/PATH tool/);
    expect((await call('set_environment_variable', { name: 'COMSPEC', value: 'C:\\evil.exe', confirm: true })).error).toMatch(/Windows itself relies on/);
    expect((await call('set_environment_variable', { name: 'bad name', value: 'x', confirm: true })).ok).toBe(false);
    expect(sys.writes).toEqual([]);
  });

  it('the same value again changes nothing', async () => {
    const { sys, call } = pcRig();
    sys.user['EDITOR'] = { value: 'vim', kind: 'String' };
    const r = await call('set_environment_variable', { name: 'EDITOR', value: 'vim', confirm: true });
    expect(r).toMatchObject({ ok: true, summary: 'already set' });
    expect(sys.writes).toEqual([]);
  });

  it('a value with %VARIABLES% is kept expandable; the existing name\'s own case is kept', async () => {
    const { sys, call } = pcRig();
    sys.folder('C:\\Users\\Rakesh\\tools');
    sys.user['Tools_Home'] = { value: 'C:\\old', kind: 'String' };
    const r = await call('set_environment_variable', { name: 'TOOLS_HOME', value: '%USERPROFILE%\\tools', confirm: true });
    expect(r.ok, r.error).toBe(true);
    expect(sys.writes[0]).toEqual({ name: 'Tools_Home', value: '%USERPROFILE%\\tools', kind: 'ExpandString' });
  });

  it('a private name: the value is never in the question, the answer or the record, and it cannot be undone', async () => {
    const { sys, call, journal } = pcRig();
    const asked = await call('set_environment_variable', { name: 'OPENAI_API_KEY', value: 'sk-very-secret-123' });
    expect(asked.error).toContain('(hidden: it is private)');
    expect(JSON.stringify(asked)).not.toContain('sk-very-secret-123');
    const done = await call('set_environment_variable', { name: 'OPENAI_API_KEY', value: 'sk-very-secret-123', confirm: true });
    expect(done.ok).toBe(true);
    expect(sys.user['OPENAI_API_KEY']?.value).toBe('sk-very-secret-123');
    expect(JSON.stringify(done)).not.toContain('sk-very-secret-123');
    expect(JSON.stringify(journal.list())).not.toContain('sk-very-secret-123');
    const undo = await call('undo_pc_change', { confirm: true });
    expect(undo.error).toMatch(/did not keep the value/);
  });

  it('says when a machine-wide one also exists (the user\'s wins)', async () => {
    const { sys, call } = pcRig();
    sys.folder('C:\\x');
    sys.machine['MY_HOME'] = { value: 'C:\\machine', kind: 'String' };
    const r = await call('set_environment_variable', { name: 'MY_HOME', value: 'C:\\x', confirm: true });
    expect(String(r.data?.['note'])).toMatch(/machine-wide MY_HOME also exists: yours wins/);
  });
});

describe('remove_environment_variable', () => {
  it('asks first, removes with the yes, verifies, and records it', async () => {
    const { sys, call, journal } = pcRig();
    sys.user['OLD_VAR'] = { value: 'something', kind: 'String' };
    const asked = await call('remove_environment_variable', { name: 'OLD_VAR' });
    expect(asked.error).toMatch(/Remove the OLD_VAR variable from your user variables\? It is now something\./);
    expect(sys.deletes).toEqual([]);
    const done = await call('remove_environment_variable', { name: 'OLD_VAR', confirm: true });
    expect(done.ok, done.error).toBe(true);
    expect(sys.user['OLD_VAR']).toBeUndefined();
    expect(journal.list()[0]).toMatchObject({ what: 'removed OLD_VAR', before: { exists: true, value: 'something' }, after: { exists: false } });
  });

  it('not set; set only machine-wide (which needs administrator rights); protected names', async () => {
    const { sys, call } = pcRig();
    expect((await call('remove_environment_variable', { name: 'NOPE', confirm: true })).error).toBe('NOPE is not set.');
    sys.machine['ONLY_MACHINE'] = { value: 'x', kind: 'String' };
    expect((await call('remove_environment_variable', { name: 'ONLY_MACHINE', confirm: true })).error).toMatch(/machine-wide, which needs administrator rights/);
    expect((await call('remove_environment_variable', { name: 'USERPROFILE', confirm: true })).error).toMatch(/Windows itself relies on/);
    expect(sys.deletes).toEqual([]);
  });
});

describe('edit_user_path', () => {
  const NODE = 'C:\\Program Files\\nodejs';

  it('add: asks first; with the yes the folder goes at the end, the kind is kept, it is read back and recorded', async () => {
    const { sys, call, journal } = pcRig();
    sys.folder(NODE);
    sys.user['Path'] = { value: '%USERPROFILE%\\bin;C:\\tools', kind: 'ExpandString' };
    const asked = await call('edit_user_path', { action: 'add', folder: NODE });
    expect(asked.error).toMatch(/C:\\Program Files\\nodejs is added at the end of the PATH\. Change your user PATH like that\?/);
    expect(sys.writes).toEqual([]);
    const done = await call('edit_user_path', { action: 'add', folder: NODE, confirm: true });
    expect(done.ok, done.error).toBe(true);
    expect(sys.writes).toEqual([{ name: 'Path', value: `%USERPROFILE%\\bin;C:\\tools;${NODE}`, kind: 'ExpandString' }]);
    expect(done.data).toMatchObject({ changed: true, verified: true });
    expect(journal.list()[0]).toMatchObject({ kind: 'path', before: { value: '%USERPROFILE%\\bin;C:\\tools' } });
  });

  it('add at the start; a folder already there, or one that does not exist, changes nothing', async () => {
    const { sys, call } = pcRig();
    sys.folder(NODE, 'C:\\tools');
    sys.user['Path'] = { value: 'C:\\tools', kind: 'String' };
    await call('edit_user_path', { action: 'add', folder: NODE, position: 'start', confirm: true });
    expect(sys.writes[0]?.value).toBe(`${NODE};C:\\tools`);
    sys.writes.length = 0;
    expect(await call('edit_user_path', { action: 'add', folder: 'c:\\TOOLS\\', confirm: true })).toMatchObject({ ok: true, summary: 'nothing to change' });
    expect((await call('edit_user_path', { action: 'add', folder: 'C:\\Missing', confirm: true })).error).toMatch(/does not exist/);
    expect((await call('edit_user_path', { action: 'add', folder: 'nodejs', confirm: true })).ok).toBe(false);
    expect((await call('edit_user_path', { action: 'add', folder: 'C:\\a;C:\\b', confirm: true })).ok).toBe(false);
    expect(sys.writes).toEqual([]);
  });

  it('remove, and clean (which says what it will take off before it does)', async () => {
    const { sys, call } = pcRig();
    sys.folder('C:\\a', 'C:\\b');
    sys.user['Path'] = { value: 'C:\\a;C:\\gone;C:\\b;c:\\A', kind: 'String' };
    const askClean = await call('edit_user_path', { action: 'clean' });
    expect(askClean.error).toMatch(/1 folder that no longer exists and 1 repeated entry\. \(C:\\gone; c:\\A\)/);
    await call('edit_user_path', { action: 'clean', confirm: true });
    expect(sys.user['Path']?.value).toBe('C:\\a;C:\\b');
    expect(await call('edit_user_path', { action: 'clean', confirm: true })).toMatchObject({ summary: 'nothing to change' });
    await call('edit_user_path', { action: 'remove', folder: 'C:\\B', confirm: true });
    expect(sys.user['Path']?.value).toBe('C:\\a');
  });

  it('a PATH Windows kept differently is not reported as changed', async () => {
    const { sys, call, journal } = pcRig();
    sys.folder('C:\\a');
    sys.user['Path'] = { value: 'C:\\b', kind: 'String' };
    sys.writeIgnored = true;
    const r = await call('edit_user_path', { action: 'add', folder: 'C:\\a', confirm: true });
    expect(r.summary).toBe('could not confirm');
    expect(journal.list()).toEqual([]);
  });
});

describe('undo_pc_change', () => {
  it('puts the variable back as it was — after asking — and only the person\'s own state is ever overwritten with what was theirs', async () => {
    const { sys, call, journal } = pcRig();
    sys.folder('C:\\x', 'C:\\y');
    sys.user['MY_HOME'] = { value: 'C:\\x', kind: 'String' };
    await call('set_environment_variable', { name: 'MY_HOME', value: 'C:\\y', confirm: true });
    const asked = await call('undo_pc_change', {});
    expect(asked.error).toMatch(/Undo "set MY_HOME"\? MY_HOME goes back to C:\\x\./);
    expect(sys.user['MY_HOME']?.value).toBe('C:\\y');
    const done = await call('undo_pc_change', { confirm: true });
    expect(done.ok, done.error).toBe(true);
    expect(sys.user['MY_HOME']?.value).toBe('C:\\x');
    expect(journal.find()).toBeUndefined();
    expect((await call('undo_pc_change', { confirm: true })).error).toMatch(/nothing I changed that can be undone/);
  });

  it('a variable that was not there before is removed again', async () => {
    const { sys, call } = pcRig();
    sys.folder('C:\\x');
    await call('set_environment_variable', { name: 'NEW_HOME', value: 'C:\\x', confirm: true });
    expect(sys.user['NEW_HOME']).toBeDefined();
    const asked = await call('undo_pc_change', {});
    expect(asked.error).toMatch(/removed again \(it was not set before\)/);
    await call('undo_pc_change', { confirm: true });
    expect(sys.user['NEW_HOME']).toBeUndefined();
  });

  it('the PATH goes back too', async () => {
    const { sys, call } = pcRig();
    sys.folder('C:\\a', 'C:\\b');
    sys.user['Path'] = { value: 'C:\\a', kind: 'String' };
    await call('edit_user_path', { action: 'add', folder: 'C:\\b', confirm: true });
    await call('undo_pc_change', { confirm: true });
    expect(sys.user['Path']?.value).toBe('C:\\a');
  });

  it('refuses when something else changed it since: nothing of the person\'s is overwritten', async () => {
    const { sys, call } = pcRig();
    sys.folder('C:\\x');
    await call('set_environment_variable', { name: 'MY_HOME', value: 'C:\\x', confirm: true });
    sys.user['MY_HOME'] = { value: 'C:\\changed-by-someone', kind: 'String' };
    const r = await call('undo_pc_change', { confirm: true });
    expect(r.summary).toBe('changed since');
    expect(sys.user['MY_HOME']?.value).toBe('C:\\changed-by-someone');
  });

  it('an install and cleared files cannot be undone from here, and it says so', async () => {
    const { sys, call, journal } = pcRig();
    sys.runner = wingetThatKnows([GIT]);
    await call('install_program', { id: 'Git.Git', confirm: true });
    const id = journal.find()?.id;
    expect((await call('undo_pc_change', { ...(id !== undefined ? { id } : {}), confirm: true })).error).toMatch(/Windows Settings, Apps/);
    await call('clear_temp_files', { confirm: true });
    expect((await call('undo_pc_change', { confirm: true })).error).toMatch(/cannot be brought back/);
  });

  it('list_pc_changes says what was changed and what can still be undone', async () => {
    const { sys, call } = pcRig();
    sys.folder('C:\\x');
    expect((await call('list_pc_changes')).summary).toBe('nothing changed yet');
    await call('set_environment_variable', { name: 'MY_HOME', value: 'C:\\x', confirm: true });
    const list = await call('list_pc_changes');
    expect(list.data?.['changes']).toMatchObject([{ what: 'set MY_HOME', undone: false, canUndo: true }]);
  });
});

describe('programs: find_program and install_program', () => {
  it('find_program searches winget (its own source) and returns exact ids', async () => {
    const { sys, call } = pcRig();
    sys.runner = wingetThatKnows([GIT, { name: 'Node.js LTS', id: 'OpenJS.NodeJS.LTS', version: '20.11', publisher: 'OpenJS' }]);
    const r = await call('find_program', { query: 'git' });
    expect(r.ok, r.error).toBe(true);
    expect(r.data?.['packages']).toEqual([{ name: 'Git', id: 'Git.Git', version: '2.43.0' }]);
    expect(sys.runs[0]?.args).toContain('--source');
    expect(sys.runs[0]?.args).toContain('winget');
    expect((await call('find_program', { query: '--help' })).ok).toBe(false);
    expect((await call('find_program', { query: 'a;b' })).ok).toBe(false);
    expect((await call('find_program', { query: 'zzzzz' })).summary).toBe('nothing found');
  });

  it('install_program: asks first, naming the program, its version and its maker; nothing is installed yet', async () => {
    const { sys, call } = pcRig();
    sys.runner = wingetThatKnows([GIT]);
    const asked = await call('install_program', { id: 'Git.Git' });
    expect(asked.error).toBe(
      'Install Git 2.43.0 by The Git Development Community from the official Windows Package Manager? Windows will probably show its own permission box ("Do you want to allow this app to make changes to your device?"): click Yes on it. I will tell you when it appears. It can take a few minutes.',
    );
    expect(asked.data).toMatchObject({ status: 'permission_required', action: 'install_program' });
    expect(sys.runs.some((r) => r.args[0] === 'install')).toBe(false);
  });

  it('with the yes it installs from the winget source only, checks the list, and records it', async () => {
    const { sys, call, journal } = pcRig();
    sys.runner = wingetThatKnows([GIT]);
    const done = await call('install_program', { id: 'Git.Git', confirm: true });
    expect(done.ok, done.error).toBe(true);
    expect(done.data).toMatchObject({ verified: true, evidence: 'winget lists it as installed', id: 'Git.Git' });
    const install = sys.runs.find((r) => r.args[0] === 'install');
    expect(install?.args).toEqual(['install', '--id', 'Git.Git', '--exact', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity']);
    expect(install?.timeoutMs).toBeGreaterThanOrEqual(10 * 60_000);
    expect(journal.list()[0]).toMatchObject({ kind: 'install', what: 'installed Git 2.43.0' });
  });

  it('it is not "installed" because winget said so: it must be in the list afterwards', async () => {
    const { sys, call, journal } = pcRig();
    const base = wingetThatKnows([GIT]);
    sys.runner = (file, args) => (args[0] === 'install' ? { code: 1603, stdout: 'Installer failed with exit code: 1603', stderr: '', timedOut: false } : base(file, args));
    const r = await call('install_program', { id: 'Git.Git', confirm: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Git was not installed.*exit code: 1603/);
    expect(journal.list()).toEqual([]);
  });

  it('a package that is not there, an id that is not an id, no winget, a wait that never ends', async () => {
    const { sys, call } = pcRig();
    sys.runner = wingetThatKnows([GIT]);
    expect((await call('install_program', { id: 'Nope.Nope', confirm: true })).summary).toBe('no such package');
    for (const bad of ['https://x.example/a.exe', '--source x', 'Git.Git; calc', '..\\evil']) expect((await call('install_program', { id: bad, confirm: true })).summary, bad).toBe('not a package id');
    expect(sys.runs.some((r) => r.args[0] === 'install')).toBe(false);
    sys.runner = () => ({ code: null, stdout: '', stderr: '', timedOut: false });
    expect((await call('install_program', { id: 'Git.Git', confirm: true })).summary).toBe('winget is not available');
    const base = wingetThatKnows([GIT]);
    sys.runner = (file, args) => (args[0] === 'install' ? { code: null, stdout: '', stderr: '', timedOut: true } : base(file, args));
    expect((await call('install_program', { id: 'Git.Git', confirm: true })).summary).toBe('took too long');
  });

  it('says when a restart is needed', async () => {
    const { sys, call } = pcRig();
    const base = wingetThatKnows([GIT]);
    sys.runner = (file, args) => (args[0] === 'install' ? { ...base(file, args), stdout: 'Successfully installed. Restart your PC to finish.' } : base(file, args));
    expect((await call('install_program', { id: 'Git.Git', confirm: true })).data).toMatchObject({ restartNeeded: true });
  });
});

describe('the quick fixes', () => {
  it('flush_dns: done when Windows says so; administrator rights are said in words', async () => {
    const { sys, call } = pcRig();
    sys.runner = () => ({ code: 0, stdout: 'Windows IP Configuration\nSuccessfully flushed the DNS Resolver Cache.', stderr: '', timedOut: false });
    expect(await call('flush_dns')).toMatchObject({ ok: true, data: { verified: true } });
    expect(sys.runs[0]).toMatchObject({ file: 'ipconfig', args: ['/flushdns'] });
    sys.runner = () => ({ code: 1, stdout: 'Could not flush the DNS Resolver Cache: Access is denied.', stderr: '', timedOut: false });
    expect((await call('flush_dns')).error).toMatch(/administrator.*ipconfig \/flushdns/);
  });

  it('clear_temp_files: how many and how much first; deleted only with the yes; recorded', async () => {
    const { sys, call, journal } = pcRig();
    const asked = await call('clear_temp_files', {});
    expect(asked.error).toMatch(/Delete 60 temporary files \(about 800 MB\) from C:\\Users\\Rakesh\\AppData\\Local\\Temp that have not been used for 2 days\?/);
    expect(sys.tempCleared).toBe(0);
    const done = await call('clear_temp_files', { confirm: true });
    expect(done.ok).toBe(true);
    expect(done.data).toMatchObject({ removed: 58, keptInUse: 2, verified: true });
    expect(sys.tempCleared).toBe(1);
    expect(journal.list()[0]?.kind).toBe('temp');
    sys.temp = { ...sys.temp, oldFiles: 0, oldBytes: 0 };
    expect((await call('clear_temp_files', { confirm: true })).summary).toBe('nothing to clear');
  });

  it('restart_explorer: asks first; with the yes it stops and starts it and checks it is back', async () => {
    const { sys, call } = pcRig();
    const asked = await call('restart_explorer', {});
    expect(asked.error).toMatch(/Open File Explorer windows will close/);
    expect(sys.runs).toEqual([]);
    sys.running.delete('explorer.exe');
    const done = await call('restart_explorer', { confirm: true });
    expect(done.ok, done.error).toBe(true);
    expect(sys.runs[0]).toMatchObject({ file: 'taskkill', args: ['/F', '/IM', 'explorer.exe'] });
    expect(sys.started).toEqual(['explorer.exe']);
  });
});

describe('pc_check: what is wrong', () => {
  it('"node is not recognized": installed, but its folder is not on the PATH — and what to do about it', async () => {
    const { sys, call } = pcRig();
    sys.file('C:\\Program Files\\nodejs\\node.exe');
    const r = await call('pc_check', { topic: 'tool', program: 'Node.js' });
    expect(r.ok).toBe(true);
    const findings = (r.data?.['findings'] as string[]).join(' ');
    expect(findings).toMatch(/node is installed in C:\\Program Files\\nodejs but that folder is not on your PATH/);
    expect(findings).toMatch(/edit_user_path/);
    expect(r.data?.['facts']).toMatchObject({ installedFolders: ['C:\\Program Files\\nodejs'], notOnPath: ['C:\\Program Files\\nodejs'], onPath: [] });
  });

  it('a program that works: its version and where it is', async () => {
    const { sys, call } = pcRig();
    sys.onPath['git'] = ['C:\\Program Files\\Git\\cmd\\git.exe'];
    sys.runner = () => ({ code: 0, stdout: 'git version 2.43.0.windows.1\n', stderr: '', timedOut: false });
    const r = await call('pc_check', { topic: 'tool', program: 'git' });
    expect((r.data?.['findings'] as string[])[0]).toBe('git works: git version 2.43.0.windows.1 (found at C:\\Program Files\\Git\\cmd\\git.exe).');
  });

  it('not installed anywhere: it says so and names the winget package', async () => {
    const { call } = pcRig();
    const r = await call('pc_check', { topic: 'tool', program: 'python' });
    expect((r.data?.['findings'] as string[])[0]).toMatch(/python is not installed.*Python\.Python\.3\.12.*install_program/);
  });

  it('python that is only the Microsoft Store shortcut is told apart from the real one', async () => {
    const { sys, call } = pcRig();
    sys.onPath['python'] = ['C:\\Users\\Rakesh\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'];
    sys.runner = () => ({ code: 9009, stdout: '', stderr: 'Python was not found; run without arguments to install from the Microsoft Store', timedOut: false });
    const r = await call('pc_check', { topic: 'tool', program: 'python' });
    expect((r.data?.['findings'] as string[])[0]).toMatch(/only the Microsoft Store shortcut.*Python\.Python\.3\.12/);
  });

  it('java: a JAVA_HOME that is wrong says what it should be', async () => {
    const { sys, call } = pcRig();
    withJava(sys);
    sys.user['JAVA_HOME'] = { value: `${JDK}\\bin`, kind: 'String' };
    const r = await call('pc_check', { topic: 'tool', program: 'java' });
    const findings = (r.data?.['findings'] as string[]).join(' ');
    expect(findings).toMatch(/JAVA_HOME is wrong: JAVA_HOME is the Java folder itself, not its "bin" folder/);
    expect(findings).toContain(`It should be ${JDK}`);
    expect((await call('pc_check', { topic: 'tool', program: 'java' })).data?.['facts']).toMatchObject({ javaHomeCandidates: [JDK] });
    delete sys.user['JAVA_HOME'];
    expect(((await call('pc_check', { topic: 'tool', program: 'java' })).data?.['findings'] as string[]).join(' ')).toContain(`JAVA_HOME is not set. It should be ${JDK}`);
  });

  it('a program Eya does not know is not run', async () => {
    const { sys, call } = pcRig();
    const r = await call('pc_check', { topic: 'tool', program: 'calc.exe & del *' });
    expect((r.data?.['findings'] as string[])[0]).toMatch(/I only check these programs/);
    expect(sys.runs).toEqual([]);
  });

  it('path: folders that do not exist and repeats, and that the user PATH can be cleaned', async () => {
    const { sys, call } = pcRig();
    sys.folder('C:\\a');
    sys.user['Path'] = { value: 'C:\\a;C:\\gone;C:\\a', kind: 'String' };
    const r = await call('pc_check', { topic: 'path' });
    const findings = (r.data?.['findings'] as string[]).join(' ');
    expect(findings).toMatch(/user PATH has 1 folder that no longer exist: C:\\gone/);
    expect(findings).toMatch(/lists 1 folder twice/);
    expect(findings).toMatch(/edit_user_path.*clean/);
  });

  it('environment: a variable that points nowhere; private values are hidden', async () => {
    const { sys, call } = pcRig();
    sys.user['ANDROID_HOME'] = { value: 'C:\\Android\\sdk', kind: 'String' };
    sys.user['API_KEY'] = { value: 'sk-secret', kind: 'String' };
    const r = await call('pc_check', { topic: 'environment' });
    expect((r.data?.['findings'] as string[]).join(' ')).toMatch(/ANDROID_HOME points at C:\\Android\\sdk, which does not exist/);
    expect(JSON.stringify(r)).not.toContain('sk-secret');
  });

  it('overview: low disk, a restart waiting, no winget — each said as what to do', async () => {
    const { sys, call } = pcRig();
    sys.diskList = [{ drive: 'C:', freeGb: 2.1, totalGb: 475 }];
    sys.os = { ...sys.os, pendingReboot: true, uptimeHours: 500 };
    sys.runner = () => ({ code: null, stdout: '', stderr: '', timedOut: false });
    const findings = ((await call('pc_check', { topic: 'overview' })).data?.['findings'] as string[]).join(' ');
    expect(findings).toMatch(/only 2\.1 GB free/);
    expect(findings).toMatch(/waiting for a restart/);
    expect(findings).toMatch(/not been restarted for 21 days/);
    expect(findings).toMatch(/winget.*not available/);
  });

  it('disk and network', async () => {
    const { sys, call } = pcRig();
    expect(((await call('pc_check', { topic: 'disk' })).data?.['findings'] as string[]).join(' ')).toMatch(/800 MB of old temporary files.*clear_temp_files/);
    sys.net = { dns: false, internet: true, proxy: null, adapters: 1 };
    expect(((await call('pc_check', { topic: 'network' })).data?.['findings'] as string[]).join(' ')).toMatch(/DNS.*flush_dns/);
    sys.net = { dns: true, internet: false, proxy: 'proxy.example:8080', adapters: 1 };
    expect(((await call('pc_check', { topic: 'network' })).data?.['findings'] as string[]).join(' ')).toMatch(/proxy.*proxy\.example:8080/i);
    sys.net = { dns: false, internet: false, proxy: null, adapters: 0 };
    expect(((await call('pc_check', { topic: 'network' })).data?.['findings'] as string[]).join(' ')).toMatch(/No network connection is active/);
  });

  it('an unknown topic is refused', async () => {
    const { call } = pcRig();
    expect((await call('pc_check', { topic: 'everything' })).ok).toBe(false);
  });
});

describe('what these tools are: typed, ask-first, and nothing about security', () => {
  it('every tool that changes something needs the yes, and says so in its schema', () => {
    const { tools } = pcRig();
    const changing = ['set_environment_variable', 'remove_environment_variable', 'edit_user_path', 'install_program', 'uninstall_program', 'rename_pc', 'clear_temp_files', 'restart_explorer', 'undo_pc_change'];
    for (const n of changing) {
      const t = tools.find((x) => x.schema.name === n);
      expect(t?.schema.requiresConfirmation, n).toBe(true);
      expect('confirm' in (t?.schema.args ?? {}), n).toBe(true);
    }
    expect(tools.map((t) => t.schema.name).sort()).toEqual([...changing, 'find_program', 'flush_dns', 'list_pc_changes', 'pc_check'].sort());
  });

  it('there is no tool for a shell command, the registry, the firewall, Defender, services or the hosts file', () => {
    const { tools } = pcRig();
    for (const t of tools) {
      expect(t.schema.name).not.toMatch(/command|shell|registry|firewall|defender|service|hosts|policy|uac/i);
      expect(Object.keys(t.schema.args)).not.toContain('command');
    }
  });
});
