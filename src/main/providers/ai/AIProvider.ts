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
  /**
   * Set when the provider's own safety system, or the model itself, declined to answer (a blocked prompt, a filtered answer, a stated refusal): the
   * reason it gave. This is the AI model's decision, not a failure of the network, the browser or Eya; it is reported as such and never worked around
   * (no other provider is asked, no wording is tried until it gives in).
   */
  readonly blocked?: string;
  /** Written by the small local model: a task that can tell (a drafted chat reply) holds its answer to a firmer standard. */
  readonly local?: true;
}

/**
 * The answer is ONE JSON object (a drafted chat reply, say), not a chat message. The cloud AIs follow the instructions in `messages`; the small local AI cannot be left to:
 * its generic prompt (see localPrompt.ts) REPLACES a task's instructions with a plain-text chat line, so it would never write the JSON at all — which is how a live chat
 * answered through the local AI got no usable reply to anything (measured, 6 Nov 2026). So a structured task brings what the local AI is to be sent, and the shape it must answer in.
 */
export interface StructuredTask {
  /** The JSON Schema of the object: the local AI is held to it (Ollama's `format`), so what comes back always parses. */
  readonly schema: unknown;
  /** What a small local model is sent INSTEAD of `messages`, kept exactly as written: short instructions with examples, and only the last lines of the conversation. */
  readonly local?: readonly AIChatMessage[];
}

export interface CompleteOptions {
  /** See StructuredTask. Providers that do not need it ignore it. */
  readonly structured?: StructuredTask;
  /**
   * Another provider is ready to take this request: give up quickly rather than walking every model and retrying. Set by the chain so
   * that a limited or overloaded primary costs seconds, not the whole retry ladder.
   */
  readonly failFast?: boolean;
  /**
   * Told the answer so far as it is being written, by a provider that can (the local AI), so the page can show it growing. Providers that
   * only answer all at once never call it.
   */
  readonly onPartial?: (textSoFar: string) => void;
  /**
   * The person stopped the request: give up now. The request to the service is cancelled, no other model or provider is tried, and nothing is rested (a
   * Stop is not a failure of the service). What is thrown is an error named AbortError.
   */
  readonly signal?: AbortSignal;
}

export interface AIProvider {
  readonly name: string;
  complete(messages: readonly AIChatMessage[], tools: readonly AIToolSpec[], options?: CompleteOptions): Promise<AICompletion>;
  /** The model that answered last (or would answer next), for showing the user which AI they are talking to. */
  currentModel?(): string | undefined;
  isReady(): boolean;
}
