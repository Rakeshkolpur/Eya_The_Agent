import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { rootLogger } from '@main/logging/logger';

const execFileAsync = promisify(execFile);
const log = rootLogger.child('winapi.processes');

export interface RunningProcess {
  readonly imageName: string;
  readonly pid: number;
}

const IMAGE_NAME_RE = /^[A-Za-z0-9_.\-]+\.exe$/;

function assertImageName(name: string): void {
  if (!IMAGE_NAME_RE.test(name)) {
    throw new Error(`Unsafe process image name: ${name}`);
  }
}

export async function listRunningProcesses(filterExe?: string): Promise<RunningProcess[]> {
  const args = ['/FO', 'CSV', '/NH'];
  if (filterExe !== undefined) {
    assertImageName(filterExe);
    // execFile passes argv directly (no cmd.exe hop, no shell quoting), so
    // the space-containing filter stays one argument.
    args.push('/FI', `IMAGENAME eq ${filterExe}`);
  }
  const { stdout } = await execFileAsync('tasklist', args, {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const rows = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const procs: RunningProcess[] = [];
  for (const row of rows) {
    // CSV: "image","pid","session","sessionNum","memUsage"
    const cols = row.split(/","/).map((c) => c.replace(/^"|"$/g, ''));
    const image = cols[0];
    const pidStr = cols[1];
    if (image === undefined || pidStr === undefined) continue;
    const pid = Number.parseInt(pidStr, 10);
    if (Number.isNaN(pid)) continue;
    procs.push({ imageName: image, pid });
  }
  return procs;
}

export async function isProcessRunning(imageName: string): Promise<boolean> {
  try {
    const procs = await listRunningProcesses(imageName);
    return procs.length > 0;
  } catch (err) {
    log.warn('isProcessRunning failed', { imageName, err: String(err) });
    return false;
  }
}

export async function waitForProcess(
  imageName: string,
  timeoutMs = 5000,
  intervalMs = 40,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isProcessRunning(imageName)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export interface StartResult {
  readonly ok: boolean;
  readonly pid?: number;
  readonly error?: string;
}

export function startDetached(command: string, args: readonly string[] = []): StartResult {
  try {
    const child = spawn(command, [...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: false,
    });
    child.unref();
    log.info('spawned process', { command, pid: child.pid });
    return child.pid !== undefined ? { ok: true, pid: child.pid } : { ok: true };
  } catch (err) {
    log.error('spawn failed', { command, err: String(err) });
    return { ok: false, error: String(err) };
  }
}
