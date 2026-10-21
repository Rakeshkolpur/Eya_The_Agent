import type { PendingSignal } from './tasks';

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
  readonly resume?: { readonly steps: readonly string[]; readonly note: string };
  /**
   * What was said earlier in this same conversation (the last lines, as the screen shows them), sent when the conversation moves from one
   * AI or one way of talking to another (Gemini Live gave out, ChatGPT takes over), so the new one carries on instead of starting blank.
   */
  readonly history?: ReadonlyArray<{ readonly who: 'user' | 'eya'; readonly text: string }>;
}

export interface AgentUpdate {
  readonly requestId: string;
  readonly state: OrbState;
  readonly message?: string;
}

export interface AgentResult {
  readonly requestId: string;
  readonly ok: boolean;
  readonly spoken: string;
  readonly error?: string;
  /** Present when the request did not simply finish: it should be tried again, or it waits for the person. */
  readonly pending?: PendingSignal;
}

export interface LogEntry {
  readonly ts: number;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly scope: string;
  readonly message: string;
  readonly data?: unknown;
}
