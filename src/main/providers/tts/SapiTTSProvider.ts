import { spawn, type ChildProcess } from 'node:child_process';
import { rootLogger } from '@main/logging/logger';
import type { TTSProvider } from './TTSProvider';

const log = rootLogger.child('tts.sapi');

/**
 * Windows SAPI TTS via a long-lived PowerShell host. Interim provider used
 * until Kokoro is wired up; keeps startup <300ms and speaks any queued text.
 *
 * We spawn a single PowerShell process that reads text lines from stdin and
 * speaks each one synchronously. This avoids paying process-startup cost per
 * utterance.
 */
export class SapiTTSProvider implements TTSProvider {
  readonly name = 'sapi';
  private ps: ChildProcess | null = null;
  private ready = false;
  private queue: string[] = [];
  private speaking = false;

  async init(): Promise<void> {
    if (this.ready) return;
    const script = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      '$s.Rate = 0;',
      // Prefer a female voice when available.
      "try { $s.SelectVoiceByHints('Female') } catch {};",
      '[Console]::WriteLine("READY");',
      'while ($true) {',
      '  $line = [Console]::In.ReadLine();',
      '  if ($null -eq $line) { break }',
      '  if ($line.Length -eq 0) { continue }',
      "  if ($line -eq '__STOP__') { $s.SpeakAsyncCancelAll(); continue }",
      '  try { $s.Speak($line) } catch { [Console]::Error.WriteLine($_.Exception.Message) }',
      '  [Console]::WriteLine("DONE");',
      '}',
    ].join(' ');

    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.ps = ps;

    ps.stdout?.setEncoding('utf8');
    ps.stderr?.setEncoding('utf8');

    ps.stderr?.on('data', (chunk: string) => log.warn('sapi stderr', { chunk: chunk.trim() }));
    ps.on('exit', (code) => {
      log.warn('sapi host exited', { code });
      this.ready = false;
      this.ps = null;
    });

    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('SAPI host timeout')), 5000);
      const onData = (chunk: string): void => {
        if (chunk.includes('READY')) {
          clearTimeout(to);
          ps.stdout?.off('data', onData);
          this.ready = true;
          log.info('sapi ready');
          resolve();
        }
      };
      ps.stdout?.on('data', onData);
    });

    // Attach the persistent utterance listener.
    ps.stdout?.on('data', (chunk: string) => {
      if (chunk.includes('DONE')) {
        this.speaking = false;
        this.drain();
      }
    });
  }

  async speak(text: string): Promise<void> {
    if (!this.ready || this.ps === null) return;
    const line = text.replace(/[\r\n]+/g, ' ').trim();
    if (line.length === 0) return;
    this.queue.push(line);
    this.drain();
  }

  stop(): void {
    if (this.ps === null) return;
    this.queue = [];
    this.ps.stdin?.write('__STOP__\n');
    this.speaking = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  async dispose(): Promise<void> {
    if (this.ps === null) return;
    try {
      this.ps.stdin?.end();
    } catch {
      /* ignore */
    }
    this.ps = null;
    this.ready = false;
  }

  private drain(): void {
    if (this.speaking) return;
    const next = this.queue.shift();
    if (next === undefined || this.ps === null) return;
    this.speaking = true;
    this.ps.stdin?.write(`${next}\n`);
  }
}
