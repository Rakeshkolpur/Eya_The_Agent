export interface TurnRef {
  readonly kind: 'application' | 'file' | 'folder' | 'result' | 'text';
  readonly value: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface Turn {
  readonly at: number;
  readonly userText: string;
  readonly intent?: string;
  readonly toolUsed?: string;
  /** What Eya said back, so a follow-up like "open the first one" has context. */
  readonly reply?: string;
  readonly ok: boolean;
  readonly refs: readonly TurnRef[];
}

/**
 * ConversationContext keeps recent turns so anaphora ("open the first result",
 * "download that") can bind to concrete referents. Milestone 1 just records
 * turns; resolvers come as more intents land.
 */
export class ConversationContext {
  private readonly turns: Turn[] = [];
  private readonly maxTurns = 20;

  push(turn: Turn): void {
    this.turns.push(turn);
    if (this.turns.length > this.maxTurns) this.turns.shift();
  }

  recent(): readonly Turn[] {
    return this.turns;
  }

  lastRefOfKind(kind: TurnRef['kind']): TurnRef | undefined {
    for (let i = this.turns.length - 1; i >= 0; i -= 1) {
      const turn = this.turns[i];
      if (turn === undefined) continue;
      const match = [...turn.refs].reverse().find((r) => r.kind === kind);
      if (match !== undefined) return match;
    }
    return undefined;
  }

  /**
   * Every ref of a kind from the most recent turn that had any — the "search
   * session" a multi-result find_file leaves behind, so "the second one" or
   * "the cause list one" can be resolved from the full list, not just the
   * single newest match `lastRefOfKind` would give.
   */
  lastRefsOfKind(kind: TurnRef['kind']): readonly TurnRef[] {
    for (let i = this.turns.length - 1; i >= 0; i -= 1) {
      const turn = this.turns[i];
      if (turn === undefined) continue;
      const matches = turn.refs.filter((r) => r.kind === kind);
      if (matches.length > 0) return matches;
    }
    return [];
  }
}
