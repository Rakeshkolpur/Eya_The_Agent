import { describe, it, expect } from 'vitest';
import { createCloseFileTool } from '../src/main/tools/impl/closeFile';
import type { CloseFileDeps, OpenWindow } from '../src/main/tools/impl/closeFile';

describe('close_file', () => {
  it('closes the one window whose title matches the file name', async () => {
    let windows: OpenWindow[] = [{ pid: 111, title: 'report.docx - Word' }];
    const deps: CloseFileDeps = {
      listWindows: async () => windows,
      closeMainWindow: async (pid) => {
        windows = windows.filter((w) => w.pid !== pid);
        return true;
      },
      sleep: async () => undefined,
    };
    const tool = createCloseFileTool(deps);
    const result = await tool.execute({ path: 'C:\\Users\\me\\Documents\\report.docx' });
    expect(result.ok).toBe(true);
    expect(result.data?.['title']).toBe('report.docx - Word');
  });

  it('matches by bare file name too, without a full path', async () => {
    let windows: OpenWindow[] = [{ pid: 5, title: 'CauseList.pdf - Adobe Acrobat' }];
    const deps: CloseFileDeps = {
      listWindows: async () => windows,
      closeMainWindow: async (pid) => {
        windows = windows.filter((w) => w.pid !== pid);
        return true;
      },
      sleep: async () => undefined,
    };
    const result = await createCloseFileTool(deps).execute({ path: 'CauseList.pdf' });
    expect(result.ok).toBe(true);
  });

  it('says plainly when nothing matches, rather than closing something unrelated', async () => {
    const deps: CloseFileDeps = {
      listWindows: async () => [{ pid: 1, title: 'Untitled - Notepad' }],
      closeMainWindow: async () => true,
      sleep: async () => undefined,
    };
    const result = await createCloseFileTool(deps).execute({ path: 'report.docx' });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('not open');
  });

  it('asks which one when several windows match, rather than guessing', async () => {
    const deps: CloseFileDeps = {
      listWindows: async () => [
        { pid: 1, title: 'CauseList.pdf - Adobe Acrobat' },
        { pid: 2, title: 'CauseList_2026.pdf - Adobe Acrobat' },
      ],
      closeMainWindow: async () => true,
      sleep: async () => undefined,
    };
    const result = await createCloseFileTool(deps).execute({ path: 'causelist' });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('ambiguous');
    expect((result.data?.['candidates'] as unknown[]).length).toBe(2);
  });

  it('reports honestly when the window will not close (e.g. an unsaved-changes prompt)', async () => {
    const deps: CloseFileDeps = {
      listWindows: async () => [{ pid: 9, title: 'report.docx - Word' }], // never actually disappears
      closeMainWindow: async () => true,
      sleep: async () => undefined,
    };
    const result = await createCloseFileTool(deps).execute({ path: 'report.docx' });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('still open');
    expect(result.error).toMatch(/save/);
  });

  it('reports failure if the close request itself is not accepted', async () => {
    const deps: CloseFileDeps = {
      listWindows: async () => [{ pid: 9, title: 'report.docx - Word' }],
      closeMainWindow: async () => false,
      sleep: async () => undefined,
    };
    const result = await createCloseFileTool(deps).execute({ path: 'report.docx' });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('could not close');
  });

  it('requires a path', async () => {
    const deps: CloseFileDeps = { listWindows: async () => [], closeMainWindow: async () => true, sleep: async () => undefined };
    const result = await createCloseFileTool(deps).execute({});
    expect(result.ok).toBe(false);
  });
});
