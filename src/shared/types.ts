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
}

export interface LogEntry {
  readonly ts: number;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly scope: string;
  readonly message: string;
  readonly data?: unknown;
}
