import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import { startDetached } from './processes';

const run = promisify(execFile);

const EXE_NAME = /^[A-Za-z0-9_.\-]+\.exe$/;

const BROWSER_EXE = {
  chrome: 'chrome.exe',
  edge: 'msedge.exe',
  firefox: 'firefox.exe',
} as const;

export type BrowserName = keyof typeof BROWSER_EXE;

/**
 * Where Windows says an app is installed, from its App Paths registration.
 * Avoids guessing install folders, which differ per machine.
 */
export async function findAppExe(exeName: string): Promise<string | null> {
  if (!EXE_NAME.test(exeName)) return null;
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const key = `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`;
      const { stdout } = await run('reg', ['query', key, '/ve'], { windowsHide: true });
      const value = /REG_SZ\s+(.+?)\s*$/m.exec(stdout)?.[1];
      if (value === undefined) continue;
      const path = value.replace(/^"|"$/g, '');
      await fs.access(path);
      return path;
    } catch {
      // Not registered in this hive, or the file is gone; try the next.
    }
  }
  return null;
}

/** Opens `url` in a specific browser. False if that browser can't be found. */
export async function launchBrowser(browser: BrowserName, url: string): Promise<boolean> {
  const exe = await findAppExe(BROWSER_EXE[browser]);
  if (exe === null) return false;
  return startDetached(exe, [url]).ok;
}
