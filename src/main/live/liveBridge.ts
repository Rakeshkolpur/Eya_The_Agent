import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import type { LiveConfig, LiveToolCallRequest, LiveToolCallResult } from '@shared/ipcContract';
import { DEFAULT_VOICE } from '@shared/constants';
import { liveSystemPrompt } from '@main/agent/prompts';
import { toolResultForModel } from '@main/agent/AgentEngine';
import type { ToolRegistry } from '@main/tools/ToolRegistry';
import type { ToolArgs, ToolResult } from '@main/tools/types';
import { rootLogger } from '@main/logging/logger';

const log = rootLogger.child('live');

// Measured with a spoken "open notepad" (an earlier day): 3.1-flash-live-preview asked for the tool in ~1.1s and began
// speaking in ~1.8s; 3.8-live ~1.5s / 2.2s; the 2.5 native-audio model ~5.6s and leaks its own notes, so it is the last resort.
//
// Re-measured on 2026-10-03 with spoken audio into the real Live API: 3.1-flash-live-preview opens, then the server closes
// EVERY audio session ~9 s in with 1011 "Internal error encountered." (even with no tools and a one-line prompt, so it is the
// model, not Eya's setup), while 3.8-live and the 2.5 model hear, call tools and answer normally. So the one that works comes
// first; the preview stays as a fallback in case it recovers. (LiveConversation also reopens on the next model, and tries a
// model that cut a session off last for a while, so this order is a starting point and not a single point of failure.)
const DEFAULT_LIVE_MODELS = [
  'gemini-3.8-live',
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-latest',
];

export interface LiveBridgeDeps {
  readonly gemini: { liveUrl(): string | null };
  readonly tools: ToolRegistry;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

function parseModels(raw: string | undefined): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : [...DEFAULT_LIVE_MODELS];
}

export function buildLiveConfig(deps: LiveBridgeDeps, voice: unknown): LiveConfig | null {
  const url = deps.gemini.liveUrl();
  if (url === null) return null;
  const safeVoice = typeof voice === 'string' && /^[A-Za-z]{2,24}$/.test(voice) ? voice : DEFAULT_VOICE;
  return {
    url,
    models: parseModels((deps.env ?? process.env)['EYA_LIVE_MODELS']),
    voice: safeVoice,
    systemInstruction: liveSystemPrompt(deps.now?.() ?? new Date()),
    tools: deps.tools.toAISchema().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  };
}

/**
 * The model asks for a tool by name. It goes through the same registry as
 * everything else, so the same argument checks and path rules apply.
 */
/** The model is waiting on the answer, in silence; better an honest "too slow" than minutes of nothing. */
const LIVE_TOOL_TIMEOUT_MS = 40_000;

export async function runLiveTool(
  tools: ToolRegistry,
  req: unknown,
  timeoutMs: number = LIVE_TOOL_TIMEOUT_MS,
): Promise<LiveToolCallResult> {
  const request = req as Partial<LiveToolCallRequest> | null;
  if (
    request === null ||
    typeof request !== 'object' ||
    typeof request.name !== 'string' ||
    typeof request.args !== 'object' ||
    request.args === null ||
    Array.isArray(request.args)
  ) {
    return { content: toolResultForModel({ ok: false, summary: 'bad request', error: 'The tool request was malformed.' }) };
  }
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    tools.invoke(request.name, request.args as ToolArgs),
    new Promise<ToolResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, summary: 'timed out', error: 'That is taking too long, so I stopped waiting for it.' }),
        timeoutMs,
      );
    }),
  ]);
  clearTimeout(timer);
  log.info('live tool', { name: request.name, ok: result.ok, ms: Date.now() - started });
  return { content: toolResultForModel(result) };
}

export function registerLiveBridge(deps: LiveBridgeDeps): void {
  ipcMain.handle(IpcChannels.liveConfig, (_evt, voice: unknown) => buildLiveConfig(deps, voice));
  ipcMain.handle(IpcChannels.liveToolCall, (_evt, req: unknown) => runLiveTool(deps.tools, req));
}
