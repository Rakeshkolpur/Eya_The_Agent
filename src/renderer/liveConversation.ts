import type { LiveConfig } from '../shared/ipcContract';
import { FrameBatcher, floatToPcm16 } from './pcm';
import type { PcmPlayback } from './pcmPlayer';
import { LIVE_INPUT_RATE } from './liveProtocol';
import type { LiveEvent, LiveToolCall, LiveToolResult } from './liveProtocol';
import { LiveOpenError } from './liveSession';
import type { LiveCloseInfo, LiveSessionLike } from './liveSession';
import { resample } from './wav';

export type ConversationPhase = 'connecting' | 'listening' | 'thinking' | 'working' | 'speaking';
export type ConversationEnd = 'user' | 'idle' | 'closed' | 'error';

export interface ConversationHandlers {
  onPhase(phase: ConversationPhase): void;
  /** What the user has said so far this turn. */
  onHeard(text: string): void;
  /** What Eya has said so far this turn. */
  onSaid(text: string): void;
  onEnded(reason: ConversationEnd, detail?: string): void;
  /** A tool has been running a while: a chance to say something so the user isn't left in silence. */
  onSlowTool?(toolName: string): void;
}

export interface ConversationDeps {
  getConfig(): Promise<LiveConfig | null>;
  /** Runs a tool in the main process; resolves with the result as JSON text. */
  runTool(name: string, args: Readonly<Record<string, unknown>>): Promise<string>;
  makeSession(): LiveSessionLike;
  createPlayback(): PcmPlayback;
  setFrameSink(sink: ((chunk: Float32Array, sampleRate: number) => void) | null): void;
  /** Ends the conversation after this long with nothing happening. */
  idleMs?: number;
  /** How long after Eya stops speaking the microphone stays muted (her voice fading in the room). */
  echoTailMs?: number;
  /** How long a tool may run before onSlowTool fires. */
  slowToolMs?: number;
  now?: () => number;
}

export type StartResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    return { result: text };
  }
}

/** A short, honest reason for the user when a connection can't be made. */
export function describeOpenFailure(err: unknown): string {
  if (err instanceof LiveOpenError) {
    const detail = `${err.reason} ${err.message}`;
    if (/quota|exhaust|resource|rate|limit|429/i.test(detail)) {
      return 'Live voice has hit its usage limit right now.';
    }
    if (err.kind === 'timeout') return 'Live voice took too long to connect.';
  }
  return 'Live voice is not available right now.';
}

/**
 * A spoken back-and-forth with Gemini Live. The microphone streams up, Eya's
 * voice streams back and plays as it arrives, and tool requests run in the
 * main process. By default it is half-duplex: the microphone is muted while she
 * speaks (and for a moment after), so her own voice can't be mistaken for the
 * user interrupting her. With barge-in on (headphones, or speakers that don't
 * leak into the microphone) the microphone stays open and Gemini's own voice
 * detection stops her the moment the user talks over her.
 */
export class LiveConversation {
  private session: LiveSessionLike | null = null;
  private player: PcmPlayback | null = null;
  private isActive = false;
  private speaking = false;
  private mutedUntil = 0;
  private bargeIn = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly batcher = new FrameBatcher();
  private readonly cancelled = new Set<string>();
  private heardText = '';
  private saidText = '';
  private lastSpoke: 'heard' | 'said' | null = null;
  private toolsRunning = 0;
  private unsubscribers: Array<() => void> = [];

  constructor(
    private readonly deps: ConversationDeps,
    private readonly handlers: ConversationHandlers,
  ) {}

  get active(): boolean {
    return this.isActive;
  }

  async start(): Promise<StartResult> {
    if (this.isActive) return { ok: true };
    this.handlers.onPhase('connecting');

    const config = await this.deps.getConfig();
    if (config === null) return { ok: false, reason: 'Live voice needs a Gemini key.' };

    let firstError: unknown;
    let opened: LiveSessionLike | null = null;
    for (const model of config.models) {
      const session = this.deps.makeSession();
      try {
        await session.open(config.url, {
          model,
          voice: config.voice,
          systemInstruction: config.systemInstruction,
          tools: config.tools,
        });
        opened = session;
        break;
      } catch (err) {
        firstError ??= err;
      }
    }
    if (opened === null) return { ok: false, reason: describeOpenFailure(firstError) };

    this.session = opened;
    this.isActive = true;
    this.speaking = false;
    this.mutedUntil = 0;
    this.heardText = '';
    this.saidText = '';
    this.lastSpoke = null;
    this.toolsRunning = 0;
    this.cancelled.clear();
    this.batcher.reset();
    this.unsubscribers = [
      opened.onEvent((event) => this.handleEvent(event)),
      opened.onClose((info) => this.handleClose(info)),
    ];
    this.deps.setFrameSink((chunk, rate) => this.onFrame(chunk, rate));
    this.handlers.onPhase('listening');
    this.resetIdle();
    return { ok: true };
  }

  /** Lets the user interrupt her mid-sentence: the microphone stays open while she speaks. */
  setBargeIn(on: boolean): void {
    this.bargeIn = on;
    this.batcher.reset();
  }

  get bargeInEnabled(): boolean {
    return this.bargeIn;
  }

  /** Mutes the microphone until `ms` from now (0 lifts it), e.g. while a cue plays that must not be heard as the user. */
  muteMicFor(ms: number): void {
    this.mutedUntil = this.now() + ms;
    this.batcher.reset();
  }

  stop(reason: ConversationEnd = 'user'): void {
    if (!this.isActive) return;
    const session = this.session;
    this.finish(reason);
    session?.close();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private onFrame(chunk: Float32Array, sampleRate: number): void {
    const session = this.session;
    if (!this.isActive || session === null || !session.isOpen) return;
    if ((this.speaking && !this.bargeIn) || this.now() < this.mutedUntil) {
      this.batcher.reset();
      return;
    }
    const block = this.batcher.push(chunk, sampleRate);
    if (block !== null) session.sendAudio(floatToPcm16(resample(block, sampleRate, LIVE_INPUT_RATE)));
  }

  private handleEvent(event: LiveEvent): void {
    if (!this.isActive) return;
    switch (event.type) {
      case 'heard':
        // A new user turn starts a fresh exchange on screen.
        if (this.lastSpoke === 'said') {
          this.heardText = '';
          this.saidText = '';
          this.handlers.onSaid('');
        }
        this.lastSpoke = 'heard';
        this.heardText += event.text;
        this.handlers.onHeard(this.heardText.trim());
        this.resetIdle();
        break;
      case 'said':
        this.lastSpoke = 'said';
        this.saidText += event.text;
        this.handlers.onSaid(this.saidText.trim());
        this.resetIdle();
        break;
      case 'audio':
        if (this.player === null) {
          this.player = this.deps.createPlayback();
          this.speaking = true;
          this.handlers.onPhase('speaking');
        }
        this.player.push(event.pcm);
        this.resetIdle();
        break;
      case 'turnComplete':
        this.finishSpeaking();
        break;
      case 'interrupted':
        this.player?.stop();
        this.player = null;
        this.speaking = false;
        this.mutedUntil = 0;
        this.handlers.onPhase('listening');
        break;
      case 'voiceActivity':
        if (!this.speaking) this.handlers.onPhase(event.active ? 'listening' : 'thinking');
        this.resetIdle();
        break;
      case 'toolCall':
        void this.runTools(event.calls);
        break;
      case 'toolCancel':
        for (const id of event.ids) this.cancelled.add(id);
        break;
      case 'goAway':
      case 'setupComplete':
        break;
    }
  }

  private finishSpeaking(): void {
    const player = this.player;
    if (player === null) {
      if (this.toolsRunning === 0) this.handlers.onPhase('listening');
      return;
    }
    this.player = null;
    player.end();
    void player.finished.then(() => {
      if (!this.isActive) return;
      this.speaking = false;
      this.mutedUntil = this.bargeIn ? 0 : this.now() + (this.deps.echoTailMs ?? 250);
      this.handlers.onPhase('listening');
      this.resetIdle();
    });
  }

  private async runTools(calls: readonly LiveToolCall[]): Promise<void> {
    this.toolsRunning += 1;
    this.handlers.onPhase('working');
    const slowTimer = setTimeout(() => {
      if (this.isActive && !this.speaking) this.handlers.onSlowTool?.(calls[0]?.name ?? '');
    }, this.deps.slowToolMs ?? 2500);
    const results: LiveToolResult[] = [];
    try {
      for (const call of calls) {
        let response: Record<string, unknown>;
        try {
          response = parseJsonObject(await this.deps.runTool(call.name, call.args));
        } catch {
          response = { ok: false, error: 'The tool failed to run.' };
        }
        if (!this.cancelled.has(call.id)) results.push({ id: call.id, name: call.name, response });
      }
    } finally {
      clearTimeout(slowTimer);
      this.toolsRunning -= 1;
    }
    if (!this.isActive) return;
    this.session?.sendToolResults(results);
    if (!this.speaking) this.handlers.onPhase('thinking');
    this.resetIdle();
  }

  private handleClose(info: LiveCloseInfo): void {
    if (info.byUs || !this.isActive) return;
    this.finish('closed', info.reason || `closed (${info.code})`);
  }

  private resetIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    if (!this.isActive) return;
    const idleMs = this.deps.idleMs ?? 30_000;
    this.idleTimer = setTimeout(() => {
      // Mid-speech or mid-task is not idle.
      if (this.speaking || this.toolsRunning > 0) {
        this.resetIdle();
        return;
      }
      this.stop('idle');
    }, idleMs);
  }

  private finish(reason: ConversationEnd, detail?: string): void {
    if (!this.isActive) return;
    this.isActive = false;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    this.deps.setFrameSink(null);
    this.player?.stop();
    this.player = null;
    this.speaking = false;
    this.batcher.reset();
    this.session = null;
    this.handlers.onEnded(reason, detail);
  }
}
