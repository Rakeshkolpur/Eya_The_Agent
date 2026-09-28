import { rootLogger } from '@main/logging/logger';
import type {
  AIChatMessage,
  AICompletion,
  AIProvider,
  AIToolSpec,
} from './AIProvider';

const log = rootLogger.child('ai.chain');

/**
 * Tries providers in order and returns the first successful completion.
 * Order is passed in — put the highest-quality provider first, offline
 * fallbacks after. Only falls through on thrown errors; a valid empty
 * completion is still returned as-is.
 *
 * If every provider fails, the error thrown is the FIRST provider's: that is
 * the real reason ("rate limited", "overloaded"). The backup being offline
 * ("fetch failed") would otherwise hide it.
 */
export class ChainedAIProvider implements AIProvider {
  readonly name = 'chain';

  constructor(private readonly providers: readonly AIProvider[]) {
    if (providers.length === 0) throw new Error('ChainedAIProvider needs at least one provider');
  }

  isReady(): boolean {
    return this.providers.some((p) => p.isReady());
  }

  async complete(
    messages: readonly AIChatMessage[],
    tools: readonly AIToolSpec[],
  ): Promise<AICompletion> {
    let firstError: unknown;
    for (const p of this.providers) {
      try {
        const started = Date.now();
        const result = await p.complete(messages, tools);
        log.debug('provider succeeded', {
          provider: p.name,
          ms: Date.now() - started,
          tools: result.toolCalls.length,
        });
        return result;
      } catch (err) {
        firstError ??= err;
        log.warn('provider failed, trying next', {
          provider: p.name,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    throw firstError ?? new Error('All AI providers failed');
  }
}
