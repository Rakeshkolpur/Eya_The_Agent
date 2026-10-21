import { Notification, ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import { parseTaskAction } from '@shared/tasks';
import type { TaskCompleter, TaskNotice } from './TaskCompleter';

/** What the pages may ask of the tasks: to see them, and to stop, resume or clear (each action is checked first). */
export function registerTasksIpc(completer: TaskCompleter): void {
  ipcMain.handle(IpcChannels.tasksGet, () => completer.snapshot());
  ipcMain.handle(IpcChannels.tasksAct, (_evt, raw: unknown) => {
    const action = parseTaskAction(raw);
    return action === null ? completer.snapshot() : completer.act(action);
  });
}

/** A desktop notification for a task: finished, needs the person, or still being worked on. Clicking it opens Eya. */
export function createTaskNotifier(onClick: () => void): (notice: TaskNotice) => void {
  return (notice) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: notice.title, body: notice.body, silent: false });
    n.on('click', onClick);
    n.show();
  };
}
