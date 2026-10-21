import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import type { FileActionResult, FilesListing, FilesView } from '@shared/ipcContract';
import type { FilesService } from './filesService';

const VIEWS: readonly FilesView[] = ['recent', 'documents', 'images', 'folders'];
const MAX_PATH = 1024;

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);

/** Only a known tab, and plain bounded strings, get through from the page. */
export function registerFilesIpc(files: FilesService): void {
  const nothing = (error: string): FilesListing => ({ title: 'Files', folder: null, parent: null, items: [], truncated: false, error });
  const refused: FileActionResult = { ok: false, message: 'That was not something I can do with a file.' };

  ipcMain.handle(IpcChannels.filesList, (_evt, view: unknown) => (typeof view === 'string' && (VIEWS as readonly string[]).includes(view) ? files.list(view as FilesView) : nothing('Unknown list.')));
  ipcMain.handle(IpcChannels.filesBrowse, (_evt, path: unknown) => {
    const p = text(path, MAX_PATH);
    return p === null ? nothing('That is not a folder I can show.') : files.browse(p);
  });
  ipcMain.handle(IpcChannels.filesSearch, (_evt, query: unknown) => {
    const q = text(query, 400);
    return q === null ? nothing('Type a file name to look for.') : files.search(q);
  });
  ipcMain.handle(IpcChannels.filesOpen, (_evt, path: unknown) => {
    const p = text(path, MAX_PATH);
    return p === null ? refused : files.open(p);
  });
  ipcMain.handle(IpcChannels.filesReveal, (_evt, path: unknown) => {
    const p = text(path, MAX_PATH);
    return p === null ? refused : files.reveal(p);
  });
  ipcMain.handle(IpcChannels.filesAsk, (_evt, path: unknown, question: unknown) => {
    const p = text(path, MAX_PATH);
    const q = text(question ?? '', 2000);
    return p === null || q === null ? refused : files.ask(p, q);
  });
  ipcMain.handle(IpcChannels.filesThumbs, (_evt, paths: unknown) =>
    Array.isArray(paths) ? files.thumbnails(paths.filter((p): p is string => typeof p === 'string' && p.length <= MAX_PATH).slice(0, 24)) : {},
  );
}
