import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import type { WritingAction, WritingPatch, WritingState } from '@shared/ipcContract';
import type { WatchState, WritingWatch } from './WritingWatch';

/** What a page is shown of the watcher's state (plain data; the document's own text is only in what the findings quote). */
export function writingView(state: WatchState, cloudAvailable: boolean): WritingState {
  return {
    watching: state.watching,
    source: state.source,
    title: state.title,
    cloudAllowed: state.cloudAllowed && cloudAvailable,
    cloudAvailable,
    findings: state.findings.map((f) => ({
      id: f.id,
      kind: f.kind,
      message: f.message,
      excerpt: f.excerpt,
      paragraph: f.paragraph,
      canFix: f.canFix,
      ...(f.replace !== undefined ? { replace: { from: f.replace.from, to: f.replace.to } } : {}),
    })),
    more: state.more,
    checkedAt: state.checkedAt,
    note: state.note,
  };
}

/** Cleans what a page sends (it is a request from a window, not a trusted call). */
export function cleanPatch(raw: unknown): WritingPatch {
  const p = (raw ?? {}) as Partial<Record<keyof WritingPatch, unknown>>;
  return {
    ...(typeof p.watching === 'boolean' ? { watching: p.watching } : {}),
    ...(typeof p.cloud === 'boolean' ? { cloud: p.cloud } : {}),
  };
}

export function cleanAction(raw: unknown): WritingAction | null {
  const a = (raw ?? {}) as Partial<Record<keyof WritingAction, unknown>>;
  if (typeof a.id !== 'string' || a.id.length === 0 || a.id.length > 64) return null;
  return a.action === 'fix' || a.action === 'ignore' ? { id: a.id, action: a.action } : null;
}

export interface WritingIpcDeps {
  readonly watch: WritingWatch;
  /** Whether a Gemini key exists. */
  readonly cloudAvailable: () => boolean;
  readonly card: { ready(): void; hide(): void; resize(height: number): void };
}

/**
 * The requests the pages (the Settings screen, the card) may make. Switching watching on is only ever something a person does — a click
 * here, the tray menu, or a spoken or typed request to Eya — and it is off again every time Eya starts.
 */
export function registerWritingIpc(deps: WritingIpcDeps): void {
  const { watch } = deps;
  const view = (): WritingState => writingView(watch.state(), deps.cloudAvailable());

  const act = async (raw: unknown): Promise<void> => {
    const action = cleanAction(raw);
    if (action === null) return;
    if (action.action === 'fix') await watch.fix(action.id);
    else watch.dismiss(action.id);
  };

  ipcMain.handle(IpcChannels.writingGet, view);
  ipcMain.handle(IpcChannels.writingSet, (_evt, raw: unknown) => {
    const patch = cleanPatch(raw);
    if (patch.watching === true) watch.start();
    else if (patch.watching === false) watch.stop();
    if (patch.cloud !== undefined) watch.setCloudAllowed(patch.cloud && deps.cloudAvailable());
    return view();
  });
  ipcMain.handle(IpcChannels.writingAct, async (_evt, raw: unknown) => {
    await act(raw);
    return view();
  });
  ipcMain.handle(IpcChannels.writingCheck, () => watch.checkAll());
  // The card
  ipcMain.on(IpcChannels.writingCardReady, () => deps.card.ready());
  ipcMain.on(IpcChannels.writingCardAct, (_evt, raw: unknown) => void act(raw));
  ipcMain.on(IpcChannels.writingCardSize, (_evt, height: unknown) => {
    if (typeof height === 'number' && Number.isFinite(height)) deps.card.resize(height);
  });
  ipcMain.on(IpcChannels.writingCardHide, () => deps.card.hide());
}
