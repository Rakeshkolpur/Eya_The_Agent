import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { app } from 'electron';
import { rootLogger } from '@main/logging/logger';
import { WakeWordDetector } from './keywordSpotter';
import type { KeywordSpotterBinding } from './keywordSpotter';

const log = rootLogger.child('wake');

const MODEL_DIR_NAME = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';

/**
 * Loads the on-device wake-word model ("hey Eya", heard as sound, not text).
 * Both the native module and the model files are optional at runtime: on a
 * machine where the native addon can't load (unsupported platform, a blocked
 * DLL, ...) this returns null and Eya falls back to noticing her name in
 * whatever a normal utterance transcribes to, as she always did.
 *
 * NOTE: this project has no production packaging step yet (it only runs via
 * `npm run dev`), so the model is read straight from the project's own
 * `models/kws` folder via `app.getAppPath()`. Packaging would need to ship
 * that folder, and the `sherpa-onnx-node` / `sherpa-onnx-win-x64` native
 * files, alongside the built app.
 */
export function loadWakeWordDetector(): WakeWordDetector | null {
  try {
    // A dynamic require, not a static bundler import: the native addon must
    // only be touched by code that runs in the main process.
    const require = createRequire(import.meta.url);
    const binding = require('sherpa-onnx-node') as unknown as KeywordSpotterBinding;
    const dir = join(app.getAppPath(), 'models', 'kws', MODEL_DIR_NAME);
    const detector = new WakeWordDetector({
      binding,
      readBpeModel: (path) => readFileSync(path),
      model: {
        encoder: join(dir, 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        decoder: join(dir, 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        joiner: join(dir, 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        tokens: join(dir, 'tokens.txt'),
        bpeModel: join(dir, 'bpe.model'),
      },
    });
    log.info('wake word model loaded');
    return detector;
  } catch (err) {
    log.warn('wake word model unavailable; falling back to hearing the name in transcribed speech', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
