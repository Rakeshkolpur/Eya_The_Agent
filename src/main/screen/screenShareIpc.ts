import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import type { ScreenAskMode, ScreenAskRequest, ScreenAskResult } from '@shared/ipcContract';
import type { ActivityInput } from '@main/memory/activityLog';
import type { ToolArgs, ToolResult } from '@main/tools/types';
import type { ScreenShare } from './screenShare';

const MODES: readonly ScreenAskMode[] = ['analyze', 'explain', 'next', 'ask'];
const MAX_QUESTION = 500;

/** What the Recent list calls each kind of question. The question's own words are never kept, so "ask" is the same generic line. */
const TITLE: Record<ScreenAskMode, string> = {
  analyze: "What's on my screen",
  explain: 'Explain my screen',
  next: 'What to do next on my screen',
  ask: 'Asked about my screen',
};

/** Only a known mode and a short, plain question get through from the page. */
export function cleanAskRequest(raw: unknown): ScreenAskRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as { mode?: unknown; question?: unknown };
  if (typeof r.mode !== 'string' || !(MODES as readonly string[]).includes(r.mode)) return null;
  const question = typeof r.question === 'string' ? r.question.trim().slice(0, MAX_QUESTION) : '';
  return { mode: r.mode as ScreenAskMode, ...(question !== '' ? { question } : {}) };
}

export interface ScreenShareIpcDeps {
  readonly share: ScreenShare;
  readonly invokeTool: (name: string, args: ToolArgs) => Promise<ToolResult>;
  readonly activity?: { record(input: ActivityInput): void };
}

export function registerScreenShareIpc(deps: ScreenShareIpcDeps): void {
  const { share } = deps;
  ipcMain.handle(IpcChannels.screenShareStart, () => share.start());
  ipcMain.handle(IpcChannels.screenShareStop, () => share.stop('user'));
  ipcMain.handle(IpcChannels.screenShareGet, () => share.status());
  ipcMain.on(IpcChannels.screenShareTouch, () => share.touch());

  ipcMain.handle(IpcChannels.screenShareAsk, async (_evt, raw: unknown): Promise<ScreenAskResult> => {
    const request = cleanAskRequest(raw);
    if (request === null) return { ok: false, error: 'That was not something I can answer about the screen.' };
    const result = await share.ask(request);
    // The history gets a title only: what the screen showed (or what came back) is never kept.
    try {
      deps.activity?.record({ request: '', label: request.mode === 'ask' ? TITLE.ask : TITLE[request.mode], tools: ['describe_screen'], ok: result.ok });
    } catch {
      // The history is a convenience.
    }
    return result;
  });

  // Capture is the user pressing a button — that press is their yes — so the screenshot tool is called already confirmed.
  ipcMain.handle(IpcChannels.screenShareCapture, async () => {
    const result = await deps.invokeTool('take_screenshot', { confirm: true });
    return { ok: result.ok, message: result.ok ? 'Saved a picture of your screen on the Desktop.' : (result.error ?? result.summary) };
  });
}
