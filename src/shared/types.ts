import type { AttachmentRef } from './attachments';
import type { DoneCall, PendingSignal } from './tasks';

export type OrbState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'working'
  | 'speaking'
  | 'error';

export interface AgentRequest {
  readonly text: string;
  readonly source: 'text' | 'voice';
  readonly requestId: string;
  /** Came from always-on listening, so it may not have been meant for Eya. */
  readonly live?: boolean;
  /** Set when Eya is carrying on a task that was interrupted, by herself: what had been done, so it is not done twice. */
  readonly resume?: { readonly steps: readonly string[]; readonly note: string; readonly done?: readonly DoneCall[] };
  /**
   * What was said earlier in this same conversation (the last lines, as the screen shows them), sent when the conversation moves from one
   * AI or one way of talking to another (Gemini Live gave out, ChatGPT takes over), so the new one carries on instead of starting blank.
   */
  readonly history?: ReadonlyArray<{ readonly who: 'user' | 'eya'; readonly text: string }>;
  /** Files the person attached to this message. Such a request goes to the AI (never to the quick commands) and the AI is told how to read them. */
  readonly attachments?: readonly AttachmentRef[];
  /**
   * 'chat': plain conversation (Agent mode is off): the answer only, nothing is done on the computer or in a browser, nothing becomes a task.
   * 'agent' (or nothing, as voice and the quick panel always were): the request is carried out with the tools.
   */
  readonly mode?: 'chat' | 'agent';
}

export interface AgentUpdate {
  readonly requestId: string;
  readonly state: OrbState;
  readonly message?: string;
  /** The answer so far, while it is still being written (the local AI answers word by word). Shown as it grows; never spoken until it is whole. */
  readonly partial?: string;
}

export interface AgentResult {
  readonly requestId: string;
  readonly ok: boolean;
  readonly spoken: string;
  readonly error?: string;
  /** Present when the request did not simply finish: it should be tried again, or it waits for the person. */
  readonly pending?: PendingSignal;
  /** A reply in chat mode that points to Agent mode (the screen offers a button to switch it on and carry the request out). */
  readonly suggestAgent?: boolean;
  /** What this request took from the AI: how many answers came back for it and how many tokens they used (the prompt, the answer, and the total). */
  readonly tokens?: { readonly calls: number; readonly prompt: number; readonly completion: number; readonly total: number; readonly cached?: number };
  /** Where each thing that went wrong came from: the AI model declining, the AI being out, Eya's own rule, the search, the page not opening, another tool. */
  readonly diagnosis?: ReadonlyArray<{ readonly source: string; readonly detail: string }>;
}

export interface LogEntry {
  readonly ts: number;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly scope: string;
  readonly message: string;
  readonly data?: unknown;
}
