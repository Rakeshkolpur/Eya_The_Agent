import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'C:\\app', getPath: () => 'C:\\data' } }));

import { join } from 'node:path';
import { dotEnvCandidates } from '../src/main/config/env';

const where = { cwd: 'C:\\dev\\project', appPath: 'C:\\dev\\project\\out', exeDir: 'C:\\Users\\me\\AppData\\Local\\Programs\\Eya', userData: 'C:\\Users\\me\\AppData\\Roaming\\Eya' };

describe('where a .env file is looked for', () => {
  it('from source: the project folder it was started in, then the app folder', () => {
    expect(dotEnvCandidates(false, where)).toEqual([join(where.cwd, '.env'), join(where.appPath, '.env')]);
  });

  it('installed: beside Eya.exe and in her own data folder, never the folder she happened to be started from', () => {
    const found = dotEnvCandidates(true, where);
    expect(found).toEqual([join(where.exeDir, '.env'), join(where.userData, '.env')]);
    expect(found).not.toContain(join(where.cwd, '.env'));
  });
});
