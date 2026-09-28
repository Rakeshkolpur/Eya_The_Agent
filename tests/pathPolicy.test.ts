import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkPath,
  isBlockedFileName,
  isExecutablePath,
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
