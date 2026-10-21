import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rootLogger } from '@main/logging/logger';
import { READER_SCRIPT } from './readerScript';
import type { DocumentText, TextSource } from './types';

const log = rootLogger.child('writing');

/** The few lines the helper and this side say to each other. What it reads is never logged. */
type Answer = Record<string, unknown> & { id?: number };

export type SpawnReader = (scriptPath: string) => ChildProcessWithoutNullStreams;

const defaultSpawn: SpawnReader = (scriptPath) =>
  spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

/**
 * The PowerShell helper that reads Word and a few plain editors (readerScript.ts), kept running while Writing Watch is on and spoken to
 * one JSON line at a time. Started on the first request, started again if it dies, ended by `close`.
 */
export class ReaderProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly waiting = new Map<number, (answer: Answer) => void>();
  private ready: Promise<void> | null = null;
  private readonly scriptPath: string;

  constructor(
    scriptDir: string,
    private readonly spawnReader: SpawnReader = defaultSpawn,
    private readonly timeoutMs = 8000,
    /** Another helper program to run through the same one-JSON-line-at-a-time protocol (the Word control helper does). */
    script: { readonly fileName: string; readonly text: string } = { fileName: 'writing-reader.ps1', text: READER_SCRIPT },
  ) {
    mkdirSync(scriptDir, { recursive: true });
    this.scriptPath = join(scriptDir, script.fileName);
    // A byte-order mark so that Windows PowerShell reads the file as UTF-8.
    const text = `﻿${script.text}`;
    let current = '';
    try {
      current = readFileSync(this.scriptPath, 'utf8');
    } catch {
      current = '';
    }
    if (current !== text) writeFileSync(this.scriptPath, text, 'utf8');
  }

  private start(): Promise<void> {
    if (this.ready !== null) return this.ready;
    this.buffer = '';
    const child = this.spawnReader(this.scriptPath);
    this.child = child;
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the reader did not start')), 15_000);
      this.waiting.set(0, () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('error', (err) => reject(err));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.on('data', () => undefined); // errors are answered as {error}; nothing else is wanted
    child.on('exit', () => {
      if (this.child === child) {
        this.child = null;
        this.ready = null;
        // Anyone still waiting is told there was no answer (null), so the watcher just looks again.
        for (const [id, done] of this.waiting) {
          if (id !== 0) done({ error: 'the reader stopped' });
        }
        this.waiting.clear();
      }
    });
    this.ready.catch(() => this.kill());
    return this.ready;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let at = this.buffer.indexOf('\n');
    while (at !== -1) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      at = this.buffer.indexOf('\n');
      if (line === '') continue;
      let answer: Answer;
      try {
        answer = JSON.parse(line) as Answer;
      } catch {
        continue;
      }
      if (answer['ready'] === true) {
        this.waiting.get(0)?.(answer);
        this.waiting.delete(0);
      } else if (typeof answer.id === 'number') {
        const done = this.waiting.get(answer.id);
        this.waiting.delete(answer.id);
        done?.(answer);
      }
    }
  }

  /** Asks the helper something; null when it did not answer in time or stopped. */
  async ask(cmd: Record<string, unknown>): Promise<Answer | null> {
    try {
      await this.start();
    } catch (err) {
      log.warn('the document reader could not start', { err: String(err) });
      return null;
    }
    const child = this.child;
    if (child === null) return null;
    const id = this.nextId++;
    return new Promise<Answer | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, this.timeoutMs);
      this.waiting.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer['error'] !== undefined ? null : answer);
      });
      try {
        child.stdin.write(`${JSON.stringify({ id, ...cmd })}\n`);
      } catch {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(null);
      }
    });
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.waiting.clear();
    if (child === null) return;
    try {
      child.stdin.write(`${JSON.stringify({ id: 0, cmd: 'quit' })}\n`);
      child.stdin.end();
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }, 500).unref();
  }

  /** Ends the helper. Asking again starts a new one (Writing Watch can be switched off and on). */
  close(): void {
    this.kill();
  }
}

// -------------------------------------------------------------------------------------------------------------- the sources
type MisspelledList = NonNullable<DocumentText['misspelled']>;

/** The start of a paragraph, enough to tell it is still the same one. */
const head = (text: string): string => text.slice(0, 40);

function toDocument(answer: Answer | null): DocumentText | null {
  if (answer === null || answer['found'] !== true || !Array.isArray(answer['paragraphs'])) return null;
  const paragraphs = (answer['paragraphs'] as unknown[]).map((p) => (typeof p === 'string' ? p : ''));
  const app = answer['app'] === 'word' ? 'word' : 'other';
  return {
    app,
    title: typeof answer['title'] === 'string' ? answer['title'] : '',
    paragraphs,
    active: typeof answer['active'] === 'number' ? answer['active'] : 0,
    ...(typeof answer['program'] === 'string' ? { program: answer['program'] } : {}),
  };
}

/** Word, through its own automation interface. */
export class WordSource implements TextSource {
  readonly name = 'Word';
  constructor(private readonly reader: ReaderProcess) {}

  async read(): Promise<DocumentText | null> {
    return toDocument(await this.reader.ask({ cmd: 'word' }));
  }

  async spell(targets: ReadonlyArray<{ readonly paragraph: number; readonly text: string }>): Promise<MisspelledList> {
    const answer = await this.reader.ask({ cmd: 'spell', targets: targets.map((t) => ({ n: t.paragraph, head: head(t.text) })) });
    const list = answer?.['misspelled'];
    if (!Array.isArray(list)) return [];
    return (list as Array<Record<string, unknown>>).flatMap((e) =>
      typeof e['paragraph'] === 'number' && typeof e['word'] === 'string'
        ? [{ paragraph: e['paragraph'], word: e['word'], suggestions: Array.isArray(e['suggestions']) ? (e['suggestions'] as unknown[]).filter((s): s is string => typeof s === 'string') : [] }]
        : [],
    );
  }

  async replace(paragraph: number, from: string, to: string, text: string): Promise<boolean> {
    const answer = await this.reader.ask({ cmd: 'replace', paragraph, from, to, head: head(text) });
    return answer?.['done'] === true;
  }

  close(): void {
    this.reader.close();
  }
}

/** The text box that has the keyboard, in a few plain editors (read only: Eya does not edit these). */
export class FocusedTextSource implements TextSource {
  readonly name = 'Notepad';
  constructor(private readonly reader: ReaderProcess) {}

  async read(): Promise<DocumentText | null> {
    const answer = await this.reader.ask({ cmd: 'focused' });
    const doc = toDocument(answer);
    return doc;
  }

  close(): void {
    this.reader.close();
  }
}
