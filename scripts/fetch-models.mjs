// Downloads the speech-recognition model (Whisper tiny.en, ~74 MB) into models/ so the installer can carry it and Eya hears you with no
// internet and no first-run download. Idempotent and checked: every file is compared with scripts/models.lock.json (size and SHA-256), a
// wrong or partial file is fetched again, and a file that does not match what was locked is refused rather than shipped.
//
//   node scripts/fetch-models.mjs            download what is missing, verify everything
//   node scripts/fetch-models.mjs --lock     (re)write the lock file from what is on disk (after deliberately updating a model)
//
// The wake-word model (models/kws) is small and lives in the repository itself.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const lockPath = join(here, 'models.lock.json');
const REPO = 'onnx-community/whisper-tiny.en';
// Exactly what the app asks for: the processor build (q8) and the graphics-chip build (full-precision encoder + q8 decoder).
const FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
  'onnx/encoder_model.onnx',
];

const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : {};
const writeLock = process.argv.includes('--lock');

async function sha256(path) {
  const hash = createHash('sha256');
  await pipeline(Readable.from(readFileSync(path)), hash);
  return hash.digest('hex');
}

async function download(url, to) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || response.body === null) throw new Error(`${url} -> HTTP ${response.status}`);
  mkdirSync(dirname(to), { recursive: true });
  const part = `${to}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
  renameSync(part, to);
}

let failed = false;
const nextLock = {};
for (const file of FILES) {
  const key = `${REPO}/${file}`;
  const target = join(root, 'models', ...key.split('/'));
  const expected = lock[key];
  const good = async () => {
    if (!existsSync(target)) return false;
    if (expected === undefined) return statSync(target).size > 0;
    return statSync(target).size === expected.size && (await sha256(target)) === expected.sha256;
  };
  if (!(await good())) {
    process.stdout.write(`fetching ${key} ... `);
    await download(`https://huggingface.co/${REPO}/resolve/main/${file}`, target);
    console.log('done');
    if (!(await good())) {
      console.error(`  !! ${key} does not match scripts/models.lock.json (expected ${expected?.size} bytes, sha256 ${expected?.sha256}). Refusing to use it.`);
      failed = true;
      continue;
    }
  }
  nextLock[key] = { size: statSync(target).size, sha256: await sha256(target) };
  console.log(`ok  ${key}  ${(nextLock[key].size / 1048576).toFixed(1)} MB`);
}

if (writeLock || Object.keys(lock).length === 0) {
  writeFileSync(lockPath, JSON.stringify(nextLock, null, 2) + '\n');
  console.log(`wrote ${lockPath}`);
}
if (failed) process.exit(1);
