import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ipcMain } from 'electron';
import { rootLogger } from '@main/logging/logger';
import { IpcChannels } from '@shared/ipcContract';
import { MAX_ATTACHMENT_BYTES, attachmentInfo } from '@shared/attachments';

const log = rootLogger.child('attachments');

export interface SavedAttachment {
  readonly ok: boolean;
  readonly path?: string;
  readonly error?: string;
}

/** A name that is only a name (no folders, no characters Windows refuses). */
export function safeAttachmentName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim().replace(/^\.+/, '');
  return base === '' ? 'attachment' : base.slice(0, 120);
}

/**
 * A file the person attached that has no place on disk (a picture pasted from the clipboard, say) is kept in a folder of its own for as long
 * as it may be asked about, and cleared out after a few days. Files picked or dropped from the disk are used where they are.
 */
export async function saveAttachment(dir: string, name: string, bytes: Uint8Array): Promise<SavedAttachment> {
  const clean = safeAttachmentName(name);
  if (attachmentInfo(clean) === null) return { ok: false, error: 'That kind of file cannot be read.' };
  if (bytes.byteLength === 0) return { ok: false, error: 'That file is empty.' };
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return { ok: false, error: 'That file is too big.' };
  try {
    const folder = join(dir, `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`);
    await fs.mkdir(folder, { recursive: true });
    const path = join(folder, clean);
    await fs.writeFile(path, bytes);
    return { ok: true, path };
  } catch (err) {
    log.warn('could not keep an attachment', { err: String(err) });
    return { ok: false, error: 'Eya could not keep that file.' };
  }
}

/** Removes kept attachments older than `maxAgeMs` (default three days). Never throws. */
export async function purgeAttachments(dir: string, maxAgeMs = 3 * 24 * 3_600_000, now: number = Date.now()): Promise<number> {
  let removed = 0;
  try {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      const stat = await fs.stat(full).catch(() => null);
      if (stat !== null && now - stat.mtimeMs > maxAgeMs) {
        await fs.rm(full, { recursive: true, force: true }).catch(() => undefined);
        removed += 1;
      }
    }
  } catch {
    // no folder yet: nothing to clear
  }
  return removed;
}

export function registerAttachmentsIpc(dir: string): void {
  ipcMain.handle(IpcChannels.attachmentSave, async (_evt, name: unknown, bytes: unknown): Promise<SavedAttachment> => {
    if (typeof name !== 'string') return { ok: false, error: 'Not a file.' };
    const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
    if (data === null) return { ok: false, error: 'Not a file.' };
    return saveAttachment(dir, name, data);
  });
}
