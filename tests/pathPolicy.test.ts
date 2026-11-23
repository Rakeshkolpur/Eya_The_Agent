import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkItemName,
  checkPath,
  checkReadablePath,
  isBlockedFileName,
  isExecutablePath,
  isKnownFolderRoot,
  isOtherUserProfileDir,
  isSystemDirName,
  resolveChildPath,
  resolveFolder,
} from '../src/main/security/pathPolicy';
import type { KnownFolders } from '../src/main/security/pathPolicy';

const home = join(tmpdir(), 'eya-policy-home');
const folders: KnownFolders = {
  home,
  desktop: join(home, 'Desktop'),
  documents: join(home, 'Documents'),
  downloads: join(home, 'Downloads'),
  pictures: join(home, 'Pictures'),
  videos: join(home, 'Videos'),
  music: join(home, 'Music'),
  temp: join(home, 'AppData', 'Local', 'Temp'),
};

describe('checkPath', () => {
  it('allows files and folders inside the home folder', () => {
    expect(checkPath(join(home, 'Downloads', 'report.pdf'), folders).ok).toBe(true);
    expect(checkPath(join(home, 'Documents'), folders).ok).toBe(true);
    expect(checkPath(home, folders).ok).toBe(true);
  });

  it('rejects paths outside the home folder', () => {
    expect(checkPath('C:\\Windows\\System32\\config\\SAM', folders).ok).toBe(false);
    expect(checkPath(join(tmpdir(), 'somewhere-else', 'a.txt'), folders).ok).toBe(false);
  });

  it('is not fooled by a sibling folder that shares the home prefix', () => {
    expect(checkPath(`${home}-evil${join('/', 'a.txt')}`, folders).ok).toBe(false);
  });

  it('is not fooled by parent-directory tricks', () => {
    expect(checkPath(join(home, 'Downloads', '..', '..', 'outside.txt'), folders).ok).toBe(false);
    // Stays inside once resolved, so it is fine.
    expect(checkPath(join(home, 'Downloads', '..', 'Documents', 'a.txt'), folders).ok).toBe(true);
  });

  it('blocks credential folders anywhere under home', () => {
    expect(checkPath(join(home, '.ssh', 'known_hosts'), folders).ok).toBe(false);
    expect(checkPath(join(home, '.aws', 'credentials'), folders).ok).toBe(false);
    expect(checkPath(join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Login Data'), folders).ok).toBe(false);
    expect(checkPath(join(home, 'Documents', '.ssh', 'notes.txt'), folders).ok).toBe(false);
  });

  it('blocks secret files, including the .env holding the API key', () => {
    for (const name of ['.env', '.env.local', 'id_rsa', 'server.pem', 'wallet.key', 'vault.kdbx', 'credentials.json', 'secrets.txt', '.npmrc']) {
      expect(checkPath(join(home, 'Documents', name), folders).ok, name).toBe(false);
    }
  });

  it('does not over-block ordinary files with similar names', () => {
    for (const name of ['environment.txt', 'credentials-report.pdf', 'secretary.docx', 'keynote.pptx', 'monkey.png']) {
      expect(checkPath(join(home, 'Documents', name), folders).ok, name).toBe(true);
    }
  });

  it('rejects an empty path', () => {
    expect(checkPath('   ', folders).ok).toBe(false);
  });
});

describe('resolveFolder', () => {
  it('maps friendly names, ignoring case and spaces', () => {
    expect(resolveFolder('Downloads', folders)).toBe(folders.downloads);
    expect(resolveFolder('  DESKTOP ', folders)).toBe(folders.desktop);
    expect(resolveFolder('home', folders)).toBe(home);
  });

  it('accepts an absolute path and rejects unknown names', () => {
    expect(resolveFolder(join(home, 'Projects'), folders)).toBe(join(home, 'Projects'));
    expect(resolveFolder('my secret stash', folders)).toBeNull();
  });

  it('resolves "temp", but checkPath then correctly refuses it: it always sits under AppData', () => {
    // `temp` exists in KnownFolders for internal use (the wake-word model's own
    // temp files), not as a folder a tool should offer the user — it is never
    // actually reachable, by the same rule that protects a browser's saved
    // passwords, also stored under AppData. Tool descriptions deliberately
    // don't mention it as an option; this documents why it would fail if asked for.
    const resolved = resolveFolder('temp', folders);
    expect(resolved).toBe(folders.temp);
    expect(checkPath(resolved ?? '', folders).ok).toBe(false);
  });
});

describe('isExecutablePath / isBlockedFileName', () => {
  it('flags things that run code', () => {
    for (const p of ['a.exe', 'A.BAT', 'x.ps1', 'y.lnk', 'z.msi', 'w.vbs', 'q.js']) {
      expect(isExecutablePath(p), p).toBe(true);
    }
    for (const p of ['a.pdf', 'b.txt', 'c.docx', 'd.png']) expect(isExecutablePath(p), p).toBe(false);
  });

  it('matches secret names', () => {
    expect(isBlockedFileName('.env')).toBe(true);
    expect(isBlockedFileName('report.pdf')).toBe(false);
  });
});

describe('checkItemName', () => {
  it('accepts ordinary file and folder names', () => {
    for (const name of ['Cases', 'Case_List.pdf', "Today's Cause List.pdf", 'High Court']) {
      expect(checkItemName(name).ok, name).toBe(true);
    }
  });

  it('rejects a name that is actually a path', () => {
    for (const name of ['../evil', 'a/b.txt', 'a\\b.txt', '..', '.', '']) {
      expect(checkItemName(name).ok, name).toBe(false);
    }
  });

  it('rejects characters Windows forbids in a name, and reserved device names', () => {
    for (const name of ['a:b.txt', 'a*b.txt', 'a?b.txt', 'a"b.txt', 'a<b>.txt', 'trailing.']) {
      expect(checkItemName(name).ok, name).toBe(false);
    }
    // A trailing space is trimmed away first, same as every other string argument.
    expect(checkItemName('Cases ')).toEqual({ ok: true, name: 'Cases' });
    for (const name of ['CON', 'con.txt', 'PRN', 'COM1', 'LPT1.docx']) {
      expect(checkItemName(name).ok, name).toBe(false);
    }
  });
});

describe('resolveChildPath', () => {
  it('combines a parent folder and a bare name into an allowed path', () => {
    const result = resolveChildPath(folders.desktop, 'Cases', folders);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(join(folders.desktop, 'Cases'));
  });

  it('refuses a name that tries to escape the parent folder', () => {
    expect(resolveChildPath(folders.desktop, '../../evil', folders).ok).toBe(false);
  });

  it('still enforces the parent folder being inside home', () => {
    expect(resolveChildPath('C:\\Windows', 'Cases', folders).ok).toBe(false);
  });
});

describe('isSystemDirName', () => {
  it('flags Windows/program internals, case-insensitively', () => {
    for (const name of ['Windows', 'PROGRAM FILES', 'Program Files (x86)', 'ProgramData', '$Recycle.Bin', 'System Volume Information']) {
      expect(isSystemDirName(name), name).toBe(true);
    }
  });

  it('does not flag an ordinary folder that merely sounds similar', () => {
    for (const name of ['My Programs', 'Windows Notes', 'Program']) {
      expect(isSystemDirName(name), name).toBe(false);
    }
  });
});

describe('isOtherUserProfileDir', () => {
  // A clean, synthetic "C:\Users\TestUser"-shaped home, deliberately not
  // nested under the real OS tmpdir (which sits under AppData — a name
  // that's legitimately blocked everywhere, and would confuse these
  // cross-account checks with an unrelated protection). No filesystem
  // access happens here, so the path need not actually exist.
  const home2 = 'C:\\FakeUsers\\TestUser';
  const folders2: KnownFolders = { ...folders, home: home2 };
  const usersRoot = 'C:\\FakeUsers';

  it('flags a sibling profile folder, not this user\'s own home', () => {
    expect(isOtherUserProfileDir(join(usersRoot, 'someone-else', 'Documents', 'a.txt'), folders2)).toBe(true);
    expect(isOtherUserProfileDir(join(home2, 'Documents', 'a.txt'), folders2)).toBe(false);
  });

  it('does not flag the shared Public profile', () => {
    expect(isOtherUserProfileDir(join(usersRoot, 'Public', 'Videos', 'a.mp4'), folders2)).toBe(false);
  });

  it('does not flag a path that is not under the users root at all', () => {
    expect(isOtherUserProfileDir('D:\\somewhere-unrelated\\a.txt', folders2)).toBe(false);
  });
});

describe('checkReadablePath', () => {
  it('applies the exact same rules as checkPath inside the home folder', () => {
    expect(checkReadablePath(join(home, 'Downloads', 'report.pdf'), folders)).toEqual(checkPath(join(home, 'Downloads', 'report.pdf'), folders));
    expect(checkReadablePath(join(home, '.ssh', 'known_hosts'), folders).ok).toBe(false);
  });

  it('allows an ordinary file or folder elsewhere on the PC, outside the home folder', () => {
    expect(checkReadablePath('D:\\Movies\\ConCity.mp4', folders).ok).toBe(true);
    expect(checkReadablePath('D:\\Office\\petition.pdf', folders).ok).toBe(true);
  });

  it('still blocks secrets anywhere, not just inside home', () => {
    expect(checkReadablePath('D:\\Backup\\.env', folders).ok).toBe(false);
    expect(checkReadablePath('D:\\Backup\\id_rsa', folders).ok).toBe(false);
    expect(checkReadablePath('D:\\Backup\\credentials.json', folders).ok).toBe(false);
  });

  it('blocks Windows/program internals on any drive', () => {
    expect(checkReadablePath('C:\\Windows\\System32\\cmd.exe', folders).ok).toBe(false);
    expect(checkReadablePath('C:\\Program Files\\App\\thing.txt', folders).ok).toBe(false);
    expect(checkReadablePath('D:\\$Recycle.Bin\\x', folders).ok).toBe(false);
  });

  it('blocks another account\'s own profile, but not the shared Public one', () => {
    const home2 = 'C:\\FakeUsers\\TestUser';
    const folders2: KnownFolders = { ...folders, home: home2 };
    expect(checkReadablePath('C:\\FakeUsers\\someone-else\\Documents\\a.txt', folders2).ok).toBe(false);
    expect(checkReadablePath('C:\\FakeUsers\\Public\\a.txt', folders2).ok).toBe(true);
  });

  it('rejects an empty path', () => {
    expect(checkReadablePath('   ', folders).ok).toBe(false);
  });
});

describe('isKnownFolderRoot', () => {
  it('recognizes every special folder itself', () => {
    expect(isKnownFolderRoot(folders.desktop, folders)).toBe(true);
    expect(isKnownFolderRoot(folders.downloads, folders)).toBe(true);
    expect(isKnownFolderRoot(home, folders)).toBe(true);
  });

  it('does not flag an ordinary folder inside one', () => {
    expect(isKnownFolderRoot(join(folders.desktop, 'Cases'), folders)).toBe(false);
  });
});
