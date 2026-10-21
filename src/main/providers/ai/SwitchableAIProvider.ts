import type { AIChatMessage, AICompletion, AIProvider, AIToolSpec, CompleteOptions } from './AIProvider';
import { NotConfiguredError } from './failure';

/**
 * A place in the provider chain that can be filled, changed or emptied while Eya runs: the backup AI. Saving a key in Settings puts a
 * provider here immediately (no restart); removing it empties the slot. An empty slot is skipped by the chain without counting as a
 * failure.
 */
export class SwitchableAIProvider implements AIProvider {
  private inner: AIProvider | null = null;
  private readonly listeners: Array<() => void> = [];

  constructor(private readonly emptyName = 'backup') {}

  get name(): string {
    return this.inner?.name ?? this.emptyName;
  }

  set(provider: AIProvider | null): void {
    this.inner = provider;
    for (const listener of this.listeners) listener();
  }

  /** Called after the slot is filled or emptied. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  isReady(): boolean {
    return this.inner !== null && this.inner.isReady();
  }

  currentModel(): string | undefined {
    return this.inner?.currentModel?.();
  }

  async complete(messages: readonly AIChatMessage[], tools: readonly AIToolSpec[], options?: CompleteOptions): Promise<AICompletion> {
    if (this.inner === null) throw new NotConfiguredError('The backup AI');
    return this.inner.complete(messages, tools, options);
  }
}
