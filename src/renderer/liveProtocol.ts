import { bytesToBase64 } from './wav';

/** Gemini Live takes 16kHz mono 16-bit PCM in, and sends 24kHz mono 16-bit PCM back. */
export const LIVE_INPUT_RATE = 16_000;
export const LIVE_INPUT_MIME = `audio/pcm;rate=${LIVE_INPUT_RATE}`;

export interface LiveToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export interface LiveSetupOptions {
  readonly model: string;
  readonly voice: string;
  readonly systemInstruction: string;
  readonly tools: readonly LiveToolDeclaration[];
}

export interface LiveToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface LiveToolResult {
  readonly id: string;
  readonly name: string;
  readonly response: Readonly<Record<string, unknown>>;
}

export type LiveEvent =
  | { readonly type: 'setupComplete' }
  /** What the user said, as the model heard it. */
  | { readonly type: 'heard'; readonly text: string }
  /** What the model said (a transcript of its own audio). */
  | { readonly type: 'said'; readonly text: string }
  | { readonly type: 'audio'; readonly pcm: Uint8Array }
  | { readonly type: 'toolCall'; readonly calls: readonly LiveToolCall[] }
  | { readonly type: 'toolCancel'; readonly ids: readonly string[] }
  | { readonly type: 'voiceActivity'; readonly active: boolean }
  /** The user talked over the model: stop speaking now. */
  | { readonly type: 'interrupted' }
  | { readonly type: 'turnComplete' }
  | { readonly type: 'goAway'; readonly timeLeftMs: number };

export function buildSetup(o: LiveSetupOptions): string {
  return JSON.stringify({
    setup: {
      model: `models/${o.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voice } } },
      },
      systemInstruction: { parts: [{ text: o.systemInstruction }] },
      ...(o.tools.length > 0 ? { tools: [{ functionDeclarations: o.tools }] } : {}),
      // Text of both sides, so the panel can show the conversation.
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  });
}

export function buildAudio(pcm: Uint8Array): string {
  return JSON.stringify({
    realtimeInput: { audio: { mimeType: LIVE_INPUT_MIME, data: bytesToBase64(pcm) } },
  });
}

export function buildToolResponse(results: readonly LiveToolResult[]): string {
  return JSON.stringify({
    toolResponse: {
      functionResponses: results.map((r) => ({ id: r.id, name: r.name, response: r.response })),
    },
  });
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function parseDurationMs(value: unknown): number {
  const match = typeof value === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(value) : null;
  return match?.[1] !== undefined ? Math.round(Number(match[1]) * 1000) : 0;
}

interface ServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    interrupted?: boolean;
    turnComplete?: boolean;
  };
  toolCall?: { functionCalls?: { id?: string; name?: string; args?: Record<string, unknown> }[] };
  toolCallCancellation?: { ids?: string[] };
  voiceActivity?: { type?: string };
  goAway?: { timeLeft?: string };
}

/**
 * Turns one message from the server into events, in the order they matter.
 * Anything unrecognized (usage counts, resumption handles, thinking text) is
 * ignored rather than treated as an error.
 */
export function parseServerMessage(raw: string): LiveEvent[] {
  let msg: ServerMessage;
  try {
    msg = JSON.parse(raw) as ServerMessage;
  } catch {
    return [];
  }
  const events: LiveEvent[] = [];

  if (msg.setupComplete !== undefined) events.push({ type: 'setupComplete' });

  const content = msg.serverContent;
  if (content !== undefined) {
    // A user's words before the model's reply.
    const heard = content.inputTranscription?.text;
    if (typeof heard === 'string' && heard.length > 0) events.push({ type: 'heard', text: heard });
    if (content.interrupted === true) events.push({ type: 'interrupted' });
    for (const part of content.modelTurn?.parts ?? []) {
      const inline = part.inlineData;
      if (inline?.data !== undefined && /^audio\//i.test(inline.mimeType ?? '')) {
        events.push({ type: 'audio', pcm: decodeBase64(inline.data) });
      }
      // Text parts are the model's own notes, not something to show or say.
    }
    const said = content.outputTranscription?.text;
    if (typeof said === 'string' && said.length > 0) events.push({ type: 'said', text: said });
    if (content.turnComplete === true) events.push({ type: 'turnComplete' });
  }

  const calls = msg.toolCall?.functionCalls;
  if (calls !== undefined && calls.length > 0) {
    events.push({
      type: 'toolCall',
      calls: calls.flatMap((c) =>
        typeof c.id === 'string' && typeof c.name === 'string'
          ? [{ id: c.id, name: c.name, args: c.args ?? {} }]
          : [],
      ),
    });
  }

  if (msg.toolCallCancellation?.ids !== undefined) {
    events.push({ type: 'toolCancel', ids: msg.toolCallCancellation.ids });
  }
  const activity = msg.voiceActivity?.type;
  if (activity === 'ACTIVITY_START') events.push({ type: 'voiceActivity', active: true });
  else if (activity === 'ACTIVITY_END') events.push({ type: 'voiceActivity', active: false });
  if (msg.goAway !== undefined) events.push({ type: 'goAway', timeLeftMs: parseDurationMs(msg.goAway.timeLeft) });

  return events;
}
