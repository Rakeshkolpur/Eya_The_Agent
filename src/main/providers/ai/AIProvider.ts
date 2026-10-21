export interface AIToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** Opaque token some Gemini models require to be echoed back with the call. */
  readonly signature?: string;
}

export interface AIChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  /** assistant: the tool calls it made in this turn. */
  readonly toolCalls?: readonly AIToolCall[];
  /** tool: the function that produced this result. */
  readonly name?: string;
  readonly toolCallId?: string;
}

export interface AIToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export interface AICompletion {
  readonly text: string;
  readonly toolCalls: readonly AIToolCall[];
}

export interface CompleteOptions {
  /**
   * Another provider is ready to take this request: give up quickly rather than walking every model and retrying. Set by the chain so
   * that a limited or overloaded primary costs seconds, not the whole retry ladder.
   */
  readonly failFast?: boolean;
}

export interface AIProvider {
  readonly name: string;
  complete(messages: readonly AIChatMessage[], tools: readonly AIToolSpec[], options?: CompleteOptions): Promise<AICompletion>;
  /** The model that answered last (or would answer next), for showing the user which AI they are talking to. */
  currentModel?(): string | undefined;
  isReady(): boolean;
}
