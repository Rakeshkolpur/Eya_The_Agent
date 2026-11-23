export interface SpeechRecognitionResult {
  readonly text: string;
  readonly final: boolean;
  readonly confidence: number;
}

export interface SpeechRecognitionProvider {
  readonly name: string;
  init(): Promise<void>;
  start(onResult: (r: SpeechRecognitionResult) => void): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
}
