import { normalizeUtterance } from '@main/memory/normalize';
import type { ToolArgs, ToolResult } from '@main/tools/types';

/** What the tracker needs from memory (MemoryService has it): the same begin / observe / finish a typed request goes through. */
/** A finished live task, for the history on the Recent screen. */
export interface LiveTaskSummary {
  readonly request: string;
  readonly tools: readonly string[];
  readonly urls: readonly string[];
  readonly ok: boolean;
}

export interface LiveTaskSink {
  beginTask(request: string): void;
  observeTool(name: string, args: ToolArgs, result: ToolResult): void;
  finishTask(ok: boolean, options?: { readonly announce?: boolean }): string | null;
}

interface Seen {
  readonly name: string;
  readonly args: ToolArgs;
  readonly result: ToolResult;
}

/** How long after the last tool call a task counts as over, when the user has not asked for anything else. */
export const LIVE_TASK_QUIET_MS = 8_000;

/**
 * In a live conversation the model hears the user and calls tools itself, so nothing hands Eya "a request" to watch. This groups the
 * tool calls into tasks the way the user experienced them: everything done for one thing they said is one task, and it ends when they
 * say something else (or things go quiet). Then it hands that task to memory exactly as a typed request would be — so repeating the
 * same task in conversation earns the same offer to save it as a routine.
 *
 * Calls are held and replayed when the task ends, because the transcript of what the user said can arrive after the first tool call;
 * the fullest wording is the one that is kept.
 */
export class LiveTaskTracker {
  /** What the user said for the task in progress, as fully as it has been heard. */
  private turn: string | null = null;
  private turnNumber: number | null = null;
  private seen: Seen[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sink: LiveTaskSink,
    private readonly quietMs: number = LIVE_TASK_QUIET_MS,
    private readonly onError: (what: string, err: unknown) => void = () => undefined,
    private readonly onTask: (task: LiveTaskSummary) => void = () => undefined,
  ) {}

  /**
   * A tool is about to run. If the user has moved on to something new, the previous task is closed first — so a "yes" or
   * "save this as a routine" this call carries out finds the task it is about.
   */
  before(heard: string | undefined, turn?: number): void {
    this.clearTimer();
    if (this.seen.length > 0 && !this.sameTurn(heard, turn)) this.flush();
  }

  /** A tool has run: it belongs to the task in progress. */
  after(name: string, args: ToolArgs, result: ToolResult, heard: string | undefined, turn?: number): void {
    this.clearTimer();
    const said = heard?.trim() ?? '';
    if (said !== '' && (this.turn === null || said.length >= this.turn.length)) this.turn = said;
    if (turn !== undefined) this.turnNumber = turn;
    this.seen.push({ name, args, result });
    this.timer = setTimeout(() => this.flush(), this.quietMs);
    this.timer.unref?.();
  }

  /** Ends the task in progress now (the conversation is over, or Eya is shutting down). */
  flush(): void {
    this.clearTimer();
    const seen = this.seen;
    const request = this.turn ?? '';
    this.seen = [];
    this.turn = null;
    this.turnNumber = null;
    if (seen.length === 0) return;
    const ok = seen[seen.length - 1]?.result.ok === true;
    try {
      this.onTask({
        request,
        tools: seen.map((s) => s.name),
        urls: seen.filter((s) => s.name === 'open_website' && typeof s.args['url'] === 'string').map((s) => s.args['url'] as string),
        ok,
      });
    } catch (err) {
      this.onError('note a live task in the history', err);
    }
    try {
      this.sink.beginTask(request);
      for (const s of seen) this.sink.observeTool(s.name, s.args, s.result);
      // The offer is spoken aloud by the app (the live model never hears it), so it is announced.
      this.sink.finishTask(ok, { announce: true });
    } catch (err) {
      this.onError('finish a live task', err);
    }
  }

  dispose(): void {
    this.flush();
  }

  /**
   * Is this call part of the task in progress? The turn number answers it when there is one (it tells two identical requests in a
   * row apart). Otherwise the words do: transcripts arrive in pieces, so one may extend the other.
   */
  private sameTurn(heard: string | undefined, turn: number | undefined): boolean {
    if (turn !== undefined && this.turnNumber !== null) return turn === this.turnNumber;
    const now = normalizeUtterance(heard ?? '');
    const before = normalizeUtterance(this.turn ?? '');
    if (now === '' || before === '') return true; // cannot tell: the quiet timer is what separates tasks then
    return before.startsWith(now) || now.startsWith(before);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
