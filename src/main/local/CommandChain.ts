import type { LocalCommandResult } from './LocalCommands';

/** Anything that may carry out an everyday request without the model, or answer null to leave it to the next. */
export interface CommandLayer {
  tryHandle(text: string, options?: { readonly live?: boolean }): Promise<LocalCommandResult | null>;
}

/** Several command layers asked in order; the first that takes the request answers it. */
export class CommandChain implements CommandLayer {
  constructor(private readonly layers: readonly CommandLayer[]) {}

  async tryHandle(text: string, options: { readonly live?: boolean } = {}): Promise<LocalCommandResult | null> {
    for (const layer of this.layers) {
      const done = await layer.tryHandle(text, options);
      if (done !== null) return done;
    }
    return null;
  }
}
