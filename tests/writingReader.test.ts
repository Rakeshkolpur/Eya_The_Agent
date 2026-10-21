import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FocusedTextSource, ReaderProcess, WordSource } from '../src/main/writing/ReaderProcess';
import { READER_SCRIPT } from '../src/main/writing/readerScript';

let dir: string;
let fake: string;
const open: ReaderProcess[] = [];

// A stand-in for the PowerShell helper: it speaks the same one-line-of-JSON protocol, with answers the test chooses.
const FAKE_HELPER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
console.log(JSON.stringify({ ready: true }));
let deaths = 0;
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.cmd === 'quit') process.exit(0);
  if (req.cmd === 'word') return console.log(JSON.stringify({ id: req.id, found: true, app: 'word', title: 'Petition.docx', paragraphs: ['One.', 'Two.'], active: 2 }));
  if (req.cmd === 'focused') return console.log(JSON.stringify({ id: req.id, found: true, app: 'other', title: 'notes.txt - Notepad', paragraphs: ['a'], active: 1, program: 'notepad' }));
  if (req.cmd === 'spell') return console.log(JSON.stringify({ id: req.id, seen: req.targets, misspelled: [{ paragraph: req.targets[0].n, word: 'recieved', suggestions: ['received'] }, { bad: true }] }));
  if (req.cmd === 'replace') return console.log(JSON.stringify({ id: req.id, done: req.from === 'the the' }));
  if (req.cmd === 'silent') return; // never answers
  if (req.cmd === 'die') process.exit(1);
  if (req.cmd === 'broken') return console.log(JSON.stringify({ id: req.id, error: 'the helper could not answer' }));
});
`;

const reader = (timeoutMs = 3000): ReaderProcess => {
  const r = new ReaderProcess(join(dir, 'scripts'), () => spawn(process.execPath, [fake], { stdio: ['pipe', 'pipe', 'pipe'] }), timeoutMs);
  open.push(r);
  return r;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eya-reader-'));
  fake = join(dir, 'fake-helper.cjs');
  writeFileSync(fake, FAKE_HELPER);
});
afterEach(() => {
  for (const r of open.splice(0)) r.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the document reader', () => {
  it('writes its helper script where PowerShell can run it (with a byte-order mark, once, unchanged on the next start)', () => {
    reader();
    const path = join(dir, 'scripts', 'writing-reader.ps1');
    expect(readFileSync(path, 'utf8')).toBe(`﻿${READER_SCRIPT}`);
    reader();
    expect(readFileSync(path, 'utf8')).toBe(`﻿${READER_SCRIPT}`);
  });

  it('reads Word as paragraphs, the cursor paragraph and the file name', async () => {
    const doc = await new WordSource(reader()).read();
    expect(doc).toEqual({ app: 'word', title: 'Petition.docx', paragraphs: ['One.', 'Two.'], active: 2 });
  });

  it('reads a plain editor and says which program it is', async () => {
    const doc = await new FocusedTextSource(reader()).read();
    expect(doc).toMatchObject({ app: 'other', program: 'notepad', paragraphs: ['a'] });
  });

  it('brings the speller\'s words, and ignores anything malformed', async () => {
    expect(await new WordSource(reader()).spell([{ paragraph: 4, text: 'Four' }, { paragraph: 5, text: 'Five' }])).toEqual([{ paragraph: 4, word: 'recieved', suggestions: ['received'] }]);
  });

  it('sends the start of each paragraph with a spelling or fix request, so a paragraph that has moved is not mistaken', async () => {
    const r = reader();
    const seen = await r.ask({ cmd: 'spell', targets: [{ n: 3, head: '1. The Petitioner submits that the the order' }] });
    expect(seen?.['seen']).toEqual([{ n: 3, head: '1. The Petitioner submits that the the order' }]);
    const spelled: unknown[] = [];
    const word = new WordSource({ ask: async (cmd: Record<string, unknown>) => (spelled.push(cmd), { misspelled: [] }) } as unknown as ReaderProcess);
    await word.spell([{ paragraph: 3, text: '1. The Petitioner submits that the the order dated 31.02.2026 is illegal and more words after.' }]);
    await word.replace(3, 'the the', 'the', '1. The Petitioner submits that the the order dated 31.02.2026 is illegal and more words after.');
    const start = '1. The Petitioner submits that the the o'; // the first 40 characters: enough to tell it is the same paragraph
    expect(start).toHaveLength(40);
    expect(spelled).toEqual([
      { cmd: 'spell', targets: [{ n: 3, head: start }] },
      { cmd: 'replace', paragraph: 3, from: 'the the', to: 'the', head: start },
    ]);
  });

  it('makes a fix only when Word says it was made', async () => {
    const word = new WordSource(reader());
    expect(await word.replace(2, 'the the', 'the', 'It said the the thing.')).toBe(true);
    expect(await word.replace(2, 'not there', 'x', 'It said the the thing.')).toBe(false);
  });

  it('gives up on a helper that does not answer, instead of waiting for ever', async () => {
    const r = reader(300);
    expect(await r.ask({ cmd: 'silent' })).toBeNull();
    expect((await r.ask({ cmd: 'word' }))?.['found']).toBe(true); // and it still works afterwards
  });

  it('starts a new helper when it died, and treats an error answer as no answer', async () => {
    const r = reader(1500);
    expect(await r.ask({ cmd: 'word' })).not.toBeNull();
    expect(await r.ask({ cmd: 'die' })).toBeNull();
    expect((await r.ask({ cmd: 'word' }))?.['found']).toBe(true);
    expect(await r.ask({ cmd: 'broken' })).toBeNull();
  });

  it('can be closed and used again (Writing Watch switched off and on)', async () => {
    const r = reader();
    expect(await r.ask({ cmd: 'word' })).not.toBeNull();
    r.close();
    expect((await r.ask({ cmd: 'word' }))?.['found']).toBe(true);
  });
});

describe('the helper script itself', () => {
  it('reads nothing but Word and a short list of plain editors, and never a password box', () => {
    expect(READER_SCRIPT).toContain("$Allowed = @('notepad', 'wordpad', 'notepad++', 'soffice', 'soffice.bin', 'write')");
    expect(READER_SCRIPT).toContain('IsPassword');
    for (const forbidden of ['chrome', 'msedge', 'firefox', 'whatsapp', 'outlook']) expect(READER_SCRIPT.toLowerCase()).not.toContain(forbidden);
  });
  it('has no backticks or dollar-braces, so that it can live in a JavaScript template', () => {
    expect(READER_SCRIPT).not.toContain('`');
    expect(READER_SCRIPT).not.toMatch(/\$\{/);
  });
});
