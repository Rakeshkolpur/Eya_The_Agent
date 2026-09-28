export interface TTSProvider {
  readonly name: string;
  init(): Promise<void>;
  speak(text: string): Promise<void>;
  /** Hint that `text` is about to be spoken so audio can be prepared early. */
  prefetch?(text: string, priority?: 'high' | 'low'): void;
  stop(): void;
  isReady(): boolean;
  dispose(): Promise<void>;
}
