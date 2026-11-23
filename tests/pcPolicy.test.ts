import { describe, expect, it, vi } from 'vitest';
import { checkName, checkPathFolder, checkValue, expectsFolder, isProtectedName, isSecretName, joinPath, kindFor, looksLikeFolder, pathAdd, pathClean, pathKey, pathRemove, shownValue, splitPath } from '../src/main/pc/envPolicy';
import { PcJournal } from '../src/main/pc/PcJournal';
import { isPackageId, isSearchQuery, listsPackage, parseSearch, parseShow, tailOf } from '../src/main/pc/winget';
import { MemIo } from './pcFixtures';

vi.mock('electron', () => ({ app: { getPath: () => '.' } }));

/** The rules about what Eya may change on this PC (pure), how a PATH is edited, what winget says, and the record of changes. */

const noFolders = { folderExists: () => false, fileExists: () => false };
const jdk = { folderExists: (f: string) => /jdk-17/i.test(f), fileExists: (f: string) => /jdk-17.*\\bin\\java\.exe$/i.test(f) };

describe('which variables may be set', () => {
  it('a plain name is fine; a bad one is refused with the rule', () => {
    expect(checkName('JAVA_HOME')).toEqual({ ok: true });
    expect(checkName('My_Var2')).toEqual({ ok: true });
    for (const bad of ['', '1ABC', 'A B', 'A=B', 'A;B', 'NAME-WITH-DASH', 'x'.repeat(129)]) expect(checkName(bad).ok, bad).toBe(false);
  });

  it('PATH has its own tool; the names Windows relies on are never set', () => {
    const p = checkName('path');
    expect(p).toMatchObject({ ok: false });
    expect(p.ok === false && p.say).toMatch(/PATH tool/);
    for (const n of ['COMSPEC', 'SystemRoot', 'USERPROFILE', 'windir', 'TEMP', 'tmp', 'APPDATA', 'PATHEXT', 'ProgramFiles(x86)'.replace('(x86)', '')]) {
      expect(isProtectedName(n), n).toBe(true);
    }
    expect(checkName('SystemRoot').ok).toBe(false);
    expect(checkName('JAVA_HOME').ok).toBe(true);
  });

  it('a name that looks private is a secret: its value is never shown', () => {
    for (const n of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD', 'my_secret', 'AWS_SESSION', 'PRIVATE_THING']) expect(isSecretName(n), n).toBe(true);
    for (const n of ['JAVA_HOME', 'NODE_ENV', 'EDITOR']) expect(isSecretName(n), n).toBe(false);
    expect(shownValue('OPENAI_API_KEY', 'sk-123')).toBe('(hidden: it is private)');
    expect(shownValue('JAVA_HOME', 'C:\\jdk')).toBe('C:\\jdk');
    expect(shownValue('X', 'a'.repeat(300))).toHaveLength(201);
  });
});

describe('what is a sensible value', () => {
  it('JAVA_HOME is the Java folder, never its bin folder — and it must really be a Java folder', () => {
    const bin = checkValue('JAVA_HOME', 'C:\\Program Files\\Java\\jdk-17\\bin', jdk);
    expect(bin.ok).toBe(false);
    expect(bin.ok === false && bin.say).toMatch(/not its "bin" folder: use C:\\Program Files\\Java\\jdk-17 instead/);
    expect(checkValue('JAVA_HOME', 'C:\\Program Files\\Java\\jdk-17', jdk)).toEqual({ ok: true });
    expect(checkValue('JAVA_HOME', 'C:\\Program Files\\Java\\jdk-17\\', jdk)).toEqual({ ok: true });
    const missing = checkValue('JAVA_HOME', 'C:\\nope\\jdk', jdk);
    expect(missing.ok === false && missing.say).toMatch(/does not exist/);
    const noJava = checkValue('JAVA_HOME', 'C:\\Program Files\\Java\\jdk-17', { folderExists: () => true, fileExists: () => false });
    expect(noJava.ok === false && noJava.say).toMatch(/no bin\\java\.exe/);
    expect(checkValue('JAVA_HOME', 'jdk17', jdk).ok).toBe(false);
  });

  it('a variable that points at a folder needs the folder to exist; anything else is free', () => {
    expect(expectsFolder('ANDROID_HOME')).toBe(true);
    expect(expectsFolder('MY_TOOL_HOME')).toBe(true);
    expect(expectsFolder('NODE_ENV')).toBe(false);
    const gone = checkValue('ANDROID_HOME', 'C:\\Android\\sdk', noFolders);
    expect(gone.ok === false && gone.say).toMatch(/does not exist, so ANDROID_HOME would point at nothing/);
    expect(checkValue('ANDROID_HOME', 'C:\\Android\\sdk', { ...noFolders, folderExists: () => true })).toEqual({ ok: true });
    expect(checkValue('NODE_ENV', 'production', noFolders)).toEqual({ ok: true });
    expect(checkValue('GREETING', 'C:\\not-a-folder-but-a-string', noFolders)).toEqual({ ok: true });
  });

  it('an empty, huge or line-broken value is refused', () => {
    expect(checkValue('X', '', noFolders).ok).toBe(false);
    expect(checkValue('X', 'a'.repeat(2001), noFolders).ok).toBe(false);
    expect(checkValue('X', 'a\nb', noFolders).ok).toBe(false);
    expect(checkValue('X', 'a\u0000b', noFolders).ok).toBe(false);
  });

  it('a value with a %VARIABLE% is kept as an expandable one, or Windows would use the percent signs as they are', () => {
    expect(kindFor('%USERPROFILE%\\tools')).toBe('ExpandString');
    expect(kindFor('C:\\tools')).toBe('String');
    expect(kindFor('C:\\tools', 'ExpandString')).toBe('ExpandString');
  });
});

describe('the PATH', () => {
  it('is split and joined without losing a thing, and entries are compared the way Windows does', () => {
    expect(splitPath('C:\\a;;C:\\b; C:\\c ;')).toEqual(['C:\\a', 'C:\\b', 'C:\\c']);
    expect(joinPath(['C:\\a', 'C:\\b'])).toBe('C:\\a;C:\\b');
    expect(pathKey('C:/Tools/')).toBe(pathKey('c:\\tools'));
  });

  it('only a plain folder may be put on it', () => {
    expect(checkPathFolder('C:\\Program Files\\nodejs')).toEqual({ ok: true });
    expect(checkPathFolder('%USERPROFILE%\\bin')).toEqual({ ok: true });
    for (const bad of ['', '   ', 'nodejs', 'C:\\a;C:\\b', 'C:\\a"b', 'C:\\*', 'C:\\', 'C:', '\\\\server\\share', 'C:\\a|b']) expect(checkPathFolder(bad).ok, bad).toBe(false);
    expect(looksLikeFolder('C:\\x'.padEnd(300, 'a'))).toBe(false);
  });

  it('add: at the end or the start; already there (any case, any slash) changes nothing', () => {
    const a = pathAdd(['C:\\a'], 'C:\\b', 'end');
    expect(a).toMatchObject({ changed: true, entries: ['C:\\a', 'C:\\b'] });
    expect(pathAdd(['C:\\a'], 'C:/b/', 'start').entries).toEqual(['C:\\b', 'C:\\a']);
    expect(pathAdd(['C:\\A\\'], 'c:\\a', 'end')).toMatchObject({ changed: false });
  });

  it('remove: takes the entry off whatever its case; not there changes nothing', () => {
    expect(pathRemove(['C:\\a', 'C:\\b'], 'c:\\B\\')).toMatchObject({ changed: true, entries: ['C:\\a'] });
    expect(pathRemove(['C:\\a'], 'C:\\z')).toMatchObject({ changed: false });
  });

  it('clean: takes off what is not there and what is repeated (the first stays), and says how many', () => {
    const exists = (e: string): boolean => !/gone/i.test(e);
    const c = pathClean(['C:\\a', 'C:\\gone1', 'c:\\A\\', 'C:\\b', 'C:\\gone2', 'C:\\b'], exists);
    expect(c.entries).toEqual(['C:\\a', 'C:\\b']);
    expect(c.missing).toEqual(['C:\\gone1', 'C:\\gone2']);
    expect(c.duplicates).toEqual(['c:\\A\\', 'C:\\b']);
    expect(c.say).toBe('The PATH has 2 folders that no longer exist and 2 repeated entries.');
    expect(pathClean(['C:\\a', 'C:\\b'], () => true)).toMatchObject({ changed: false, say: 'The PATH is clean: every folder on it exists and none is repeated.' });
  });
});

describe('what winget says', () => {
  const table = [
    'Name                       Id                       Version  Match      Source',
    '---------------------------------------------------------------------------------',
    'Git                        Git.Git                  2.43.0   Tag: git   winget',
    'GitHub Desktop             GitHub.GitHubDesktop     3.3.6    Tag: git   winget',
    'Git Extensions             GitExtensionsTeam.GitExt 5.2.1    Tag: git   winget',
  ].join('\r\n');

  it('the search table becomes rows by the header\'s columns', () => {
    expect(parseSearch(table)).toEqual([
      { name: 'Git', id: 'Git.Git', version: '2.43.0' },
      { name: 'GitHub Desktop', id: 'GitHub.GitHubDesktop', version: '3.3.6' },
      { name: 'Git Extensions', id: 'GitExtensionsTeam.GitExt', version: '5.2.1' },
    ]);
    expect(parseSearch(table, 2)).toHaveLength(2);
    expect(parseSearch('No package found matching input criteria.')).toEqual([]);
    expect(parseSearch('')).toEqual([]);
  });

  it('show: the name, the id, the version and the maker', () => {
    expect(parseShow('Found Git [Git.Git]\nVersion: 2.43.0\nPublisher: The Git Development Community\nHomepage: https://git-scm.com')).toEqual({ name: 'Git', id: 'Git.Git', version: '2.43.0', publisher: 'The Git Development Community' });
    expect(parseShow('No package found matching input criteria.')).toBeNull();
    expect(parseShow('Found Evil [not an id; rm -rf]')).toBeNull();
  });

  it('only an id is passed on: never a url, a path, an option or a pipe', () => {
    for (const ok of ['Git.Git', 'Microsoft.VisualStudioCode', 'OpenJS.NodeJS.LTS', '7zip.7zip']) expect(isPackageId(ok), ok).toBe(true);
    for (const bad of ['', 'a', '-h', '--source', 'https://x.example/a.exe', 'C:\\x.exe', 'Git.Git; calc', 'a b', 'a|b', '../x']) expect(isPackageId(bad), bad).toBe(false);
    for (const ok of ['git', 'vs code', 'node.js', 'c++', '7zip']) expect(isSearchQuery(ok), ok).toBe(true);
    for (const bad of ['', '-source', '--help', 'a;b', 'x'.repeat(61), '$(calc)']) expect(isSearchQuery(bad), bad).toBe(false);
  });

  it('installed means the id is in the list', () => {
    expect(listsPackage('Name  Id  Version\n----\nGit  Git.Git  2.43.0', 'Git.Git')).toBe(true);
    expect(listsPackage('No installed package found matching input criteria.', 'Git.Git')).toBe(false);
    expect(tailOf('line1\nline2\n \\ \nInstaller failed with exit code: 1603\n')).toMatch(/Installer failed with exit code: 1603/);
    expect(tailOf('x'.repeat(2000), 50).length).toBeLessThanOrEqual(50);
  });
});

describe('the record of what was changed', () => {
  it('keeps what it was before and after, survives a restart, and ignores damage', () => {
    const io = new MemIo();
    const a = new PcJournal('j.json', io, () => 1000, () => 'id1');
    a.record({ kind: 'env', name: 'JAVA_HOME', what: 'set JAVA_HOME', before: { exists: false, value: '', kind: 'String' }, after: { exists: true, value: 'C:\\jdk', kind: 'String' } });
    const b = new PcJournal('j.json', io);
    expect(b.list()).toHaveLength(1);
    expect(b.find()).toMatchObject({ id: 'id1', name: 'JAVA_HOME', undone: false, after: { value: 'C:\\jdk' } });
    b.markUndone('id1');
    expect(new PcJournal('j.json', io).find()).toBeUndefined();
    expect(new PcJournal('j.json', io).find('id1')?.undone).toBe(true);
    io.files.set('bad.json', '{not json');
    expect(new PcJournal('bad.json', io).list()).toEqual([]);
    io.files.set('odd.json', JSON.stringify([{ id: 1 }, { id: 'x', at: 1, kind: 'weird', name: 'n', what: 'w' }, { id: 'ok', at: 2, kind: 'install', name: 'Git.Git', what: 'installed Git' }]));
    expect(new PcJournal('odd.json', io).list().map((c) => c.id)).toEqual(['ok']);
  });

  it('keeps only the last fifty', () => {
    let n = 0;
    const j = new PcJournal('j.json', new MemIo(), () => 1, () => `i${++n}`);
    for (let i = 0; i < 60; i += 1) j.record({ kind: 'install', name: 'x', what: 'w', before: null, after: null });
    expect(j.list()).toHaveLength(50);
    expect(j.list()[0]?.id).toBe('i11');
  });
});
