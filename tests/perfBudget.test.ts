import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { parseChatIntent } from '../src/main/local/chatIntents';
import { parseLocalIntent } from '../src/main/local/localIntents';
import { LocalCommands } from '../src/main/local/LocalCommands';
import { FileIndex } from '../src/main/local/FileIndex';
import { ContactBook } from '../src/main/chat/ContactBook';
import { MIGRATIONS } from '../src/main/memory/schema';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import { MotionClock } from '../src/renderer/motion';

/**
 * Speed budgets for the everyday fast paths (Eya's promise is "within 50 to 500 ms, locally"). Each limit is several times what was
 * measured on a small laptop (Core i3, 7.7 GB), so a slow machine or a busy test run does not fail it, but a change that makes
 * something genuinely slow — a disk read where there was a memory lookup, a model call, a process started — does.
 *
 * What cannot be checked here and has its own script: the app's idle memory and CPU (scripts/idle-footprint.ps1, run against the
 * running app) — the budget for that is idle CPU under 3% of one core, and memory under 1 GB (Balanced) / 800 MB (Light).
 */

/** Average milliseconds per call over `runs` calls (after a short warm-up). */
function perCall(runs: number, fn: (i: number) => unknown): number {
  for (let i = 0; i < Math.min(50, runs); i += 1) fn(i);
  const started = performance.now();
  for (let i = 0; i < runs; i += 1) fn(i);
  return (performance.now() - started) / runs;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PHRASES = [
  'open youtube',
  'search amazon for phone cases',
  'open my downloads folder',
  'find my latest pdf',
  'open the invoice pdf in downloads',
  'download https://example.com/a.pdf',
  'what is the weather like today',
  'plan my weekend and book a table for four',
  "message Ravi that I'll be late",
  'send good morning to Amma on WhatsApp',
  'open chrome',
];

describe('understanding a request takes microseconds, not a model call', () => {
  it('the app shortcut router, the everyday-command parser and the chat parser', () => {
    const router = new IntentRouter();
    const route = perCall(5000, (i) => router.match(PHRASES[i % PHRASES.length] as string));
    const local = perCall(5000, (i) => parseLocalIntent(PHRASES[i % PHRASES.length] as string));
    const chat = perCall(5000, (i) => parseChatIntent(PHRASES[i % PHRASES.length] as string));
    // eslint-disable-next-line no-console
    console.log(`  parse cost per request: router ${route.toFixed(4)} ms, everyday commands ${local.toFixed(4)} ms, chat ${chat.toFixed(4)} ms`);
    expect(route).toBeLessThan(1);
    expect(local).toBeLessThan(1);
    expect(chat).toBeLessThan(1);
  });
});

describe('the in-memory file index', () => {
  it('builds from disk quickly enough to be ready soon after start-up, and searches in a few milliseconds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eya-perf-'));
    dirs.push(root);
    for (let d = 0; d < 40; d += 1) {
      mkdirSync(join(root, `folder ${d}`), { recursive: true });
      for (let f = 0; f < 125; f += 1) writeFileSync(join(root, `folder ${d}`, `file ${f} ${f % 9 === 0 ? 'invoice' : 'misc'}.pdf`), 'x');
    }
    const index = new FileIndex({ roots: [root], watch: null, rescanEveryMs: 0 });
    const started = performance.now();
    await index.build();
    const buildMs = performance.now() - started;
    expect(index.status().files).toBe(5000);
    const byName = perCall(300, () => index.search({ tokens: ['invoice'], extensions: ['pdf'], limit: 5 }));
    const latest = perCall(300, () => index.search({ tokens: [], extensions: ['pdf'], limit: 5 }));
    // eslint-disable-next-line no-console
    console.log(`  file index: 5000 files built in ${Math.round(buildMs)} ms; name search ${byName.toFixed(2)} ms; "latest pdf" ${latest.toFixed(2)} ms`);
    expect(buildMs).toBeLessThan(5000);
    expect(byName).toBeLessThan(10);
    expect(latest).toBeLessThan(10);
    index.stop();
  }, 60_000);

  it('answers "find my resume" end to end (parse, search, wording) in a few milliseconds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eya-perf-'));
    dirs.push(root);
    mkdirSync(join(root, 'Documents'), { recursive: true });
    for (let i = 0; i < 2000; i += 1) writeFileSync(join(root, 'Documents', `report ${i}.docx`), 'x');
    writeFileSync(join(root, 'Documents', 'Resume 2025.pdf'), 'x');
    const index = new FileIndex({ roots: [root], watch: null, rescanEveryMs: 0 });
    await index.build();
    const folders = { home: root, desktop: root, documents: join(root, 'Documents'), downloads: root, pictures: root, videos: root, music: root, temp: root };
    const local = new LocalCommands({ tools: { invoke: async () => ({ ok: true, summary: 'ok' }) }, index, folders });
    let spoken = '';
    const ms = await (async () => {
      const started = performance.now();
      for (let i = 0; i < 200; i += 1) spoken = (await local.tryHandle('find my resume'))?.spoken ?? '';
      return (performance.now() - started) / 200;
    })();
    // eslint-disable-next-line no-console
    console.log(`  "find my resume" among 2001 files: ${ms.toFixed(2)} ms each — "${spoken}"`);
    expect(spoken).toMatch(/Resume 2025\.pdf/);
    expect(ms).toBeLessThan(25);
    index.stop();
  }, 60_000);
});

describe('the saved chat names', () => {
  it('turn a spoken name into a chat quickly even with 2,000 saved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eya-perf-'));
    dirs.push(dir);
    const db = openDatabase(join(dir, 'memory.db'));
    migrate(db, MIGRATIONS);
    const book = new ContactBook(db);
    book.setLearning('on');
    const first = ['Ravi', 'Priya', 'Amit', 'Sita', 'Rahul', 'Meera', 'Anil', 'Sunita', 'Vikram', 'Neha'];
    const last = ['Kumar', 'Singh', 'Sharma', 'Verma', 'Iyer', 'Rao', 'Reddy', 'Patel', 'Gupta', 'Nair'];
    const names: string[] = [];
    for (let a = 0; a < 10; a += 1) for (let b = 0; b < 10; b += 1) for (let c = 0; c < 20; c += 1) names.push(`${first[a]} ${last[b]} ${String.fromCharCode(65 + c)}`);
    book.learn('whatsapp', names);
    expect(book.countFor('whatsapp')).toBe(2000);
    const ms = perCall(40, (i) => book.resolve('whatsapp', ['priya singh a', 'meera', 'amit verma', 'zorro'][i % 4] as string));
    // eslint-disable-next-line no-console
    console.log(`  resolving a name among 2000 saved chats: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(250);
    db.close();
  }, 60_000);
});

describe('the motion clock', () => {
  it('does its few steps a second without measurable cost, and costs nothing when nothing moves', () => {
    const vars = new Map<string, string>();
    const clock = new MotionClock({ root: { style: { setProperty: (n, v) => void vars.set(n, v), removeProperty: (n) => void vars.delete(n) }, dataset: {} }, setInterval: () => 1, clearInterval: () => undefined }, 4);
    const release = clock.hold();
    release();
    const ms = perCall(5000, () => {
      const r = clock.hold();
      r();
    });
    expect(ms).toBeLessThan(0.5);
    expect(clock.running).toBe(false);
  });
});
