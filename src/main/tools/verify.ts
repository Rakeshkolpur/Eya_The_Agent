import { promises as fs } from 'node:fs';

export interface Verification {
  readonly verified: boolean;
  readonly evidence: string;
}

async function stat(path: string) {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

/** Confirms a file actually exists after a create/copy/move/rename, rather than trusting the call didn't throw. */
export async function verifyFileExists(path: string): Promise<Verification> {
  const s = await stat(path);
  if (s === null) return { verified: false, evidence: 'the file does not exist afterwards' };
  if (!s.isFile()) return { verified: false, evidence: 'that path is not a file' };
  return { verified: true, evidence: `file present, ${s.size} bytes` };
}

export async function verifyFolderExists(path: string): Promise<Verification> {
  const s = await stat(path);
  if (s === null) return { verified: false, evidence: 'the folder does not exist afterwards' };
  if (!s.isDirectory()) return { verified: false, evidence: 'that path is not a folder' };
  return { verified: true, evidence: 'folder present' };
}

/** Confirms a path is really gone after a delete or a move's source. */
export async function verifyAbsent(path: string): Promise<Verification> {
  const s = await stat(path);
  return s === null
    ? { verified: true, evidence: 'no longer exists' }
    : { verified: false, evidence: 'it is still there' };
}
