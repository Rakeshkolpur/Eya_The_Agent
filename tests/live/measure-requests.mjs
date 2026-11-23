// Run from the project folder:  node tests/live/measure-requests.mjs [label]      (needs the built app: npx electron-vite build)
// Measures what one request costs Eya itself, with an instant stand-in AI (so the AI's own speed is not in the numbers):
//   - how long until the answer is returned to the window (speech included, as it was before / is now),
//   - how many AI calls it made, how big the instructions, tool schemas and messages sent were (characters; about 4 per token).
// Writes %TEMP%\eya-e2e-out\measure-<label>.json. Nothing here touches the person's files: the requests only ask questions or open example.org.
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT = process.cwd().split('\\').join('/');
const OUT = join(tmpdir(), 'eya-e2e-out');
mkdirSync(OUT, { recursive: true });
const label = process.argv[2] ?? 'run';
const CDP = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userData = mkdtempSync(join(tmpdir(), 'eya-measure-'));
const downloads = mkdtempSync(join(tmpdir(), 'eya-measure-dl-'));
const traceFile = join(userData, 'trace.jsonl');
const log = createWriteStream(join(OUT, `measure-app-${Date.now()}.log`));

// the stand-in AI: answers at once, and reports the usage a real one would (the size of what it was sent, about 4 characters a token)
let aiCalls = 0;
const google = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    res.writeHead(req.method === 'GET' ? 200 : raw.includes('"AUDIO"') ? 400 : 200, { 'content-type': 'application/json' });
    if (req.method === 'GET') return res.end(JSON.stringify({ models: [] }));
    if (raw.includes('"AUDIO"')) return res.end(JSON.stringify({ error: { code: 400, message: 'no speech in the test' } }));
    aiCalls += 1;
    // (the biggest request seen, kept so what it is made of can be looked at)
    try {
      const body = JSON.parse(raw);
      const decls = (body.tools ?? []).flatMap((x) => x.functionDeclarations ?? []);
      if (decls.length >= (globalThis.__biggest ?? 0)) {
        globalThis.__biggest = decls.length;
        writeFileSync(join(OUT, 'measure-biggest-' + label + '.json'), JSON.stringify({ systemChars: (body.systemInstruction?.parts ?? []).map((p) => p.text).join('').length, system: (body.systemInstruction?.parts ?? []).map((p) => p.text).join(' '), tools: decls.map((d) => ({ name: d.name, chars: JSON.stringify(d).length, descriptionChars: String(d.description ?? '').length })) }, null, 1));
      }
    } catch { /* not a chat request */ }
    const prompt = Math.round(raw.length / 4);
    res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Stand-in answer.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: 4, totalTokenCount: prompt + 4 } }));
  });
});
await new Promise((r) => google.listen(0, '127.0.0.1', r));
const env = { ...process.env, EYA_NO_MIC: '1', EYA_TRACE_FILE: traceFile, EYA_BRIDGE_PORT: '47835', EYA_BROWSER_DOWNLOADS: downloads, EYA_GEMINI_API_KEY: 'AIzaSyMEASUREMEASUREMEASUREMEASURE1234', EYA_GEMINI_BASE_URL: `http://127.0.0.1:${google.address().port}/v1beta`, EYA_OLLAMA_URL: 'http://127.0.0.1:1' };
const app = spawn('cmd.exe', ['/c', 'npx', 'electron-vite', 'preview', '--', `--remote-debugging-port=${CDP}`, `--user-data-dir=${userData}`], { cwd: PROJECT, env });
app.stdout.pipe(log);
app.stderr.pipe(log);
const stopApp = () => { try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };
process.on('exit', stopApp);

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 1;
  const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((resolve) => { const n = id++; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  const evalIn = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 180000 });
    if (r.result?.exceptionDetails) throw new Error('page error: ' + String(r.result.exceptionDetails.exception?.description ?? '').slice(0, 300));
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  return { send, evalIn };
}
async function connectMain() {
  for (let i = 0; i < 120; i++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${CDP}/json`).then((r) => r.json());
      for (const t of targets.filter((x) => x.type === 'page')) {
        const c = await attach(t.webSocketDebuggerUrl);
        if (await c.evalIn('typeof window.eya !== "undefined" && typeof window.eya.runLiveTool === "function"').catch(() => false)) return c;
      }
    } catch { /* not up yet */ }
    await sleep(2000);
  }
  throw new Error('the window never appeared');
}

const readTrace = () => (existsSync(traceFile) ? readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const SCENARIOS = [
  { name: 'chat: Hi', mode: 'chat', text: 'Hi' },
  { name: 'chat: a question', mode: 'chat', text: 'what is two plus two' },
  { name: 'agent: a question (core tools only)', mode: 'agent', text: 'tell me a joke' },
  { name: 'agent: open a site and read it (browser group)', mode: 'agent', text: 'Open the website example.org and tell me what the main heading says.' },
  { name: 'agent: Word formatting (word group)', mode: 'agent', text: 'make the heading bold in my petition document' },
  { name: 'agent: files (files group)', mode: 'agent', text: 'copy the file report.pdf into my downloads folder' },
  { name: 'agent: a film (research + browser groups)', mode: 'agent', text: 'find the full movie Paradise and play it' },
  { name: 'agent: a long multi-area job (everything)', mode: 'agent', text: 'open the telangana high court website, download the cause list, save it in a new folder, rename it and message Ravi on whatsapp that it is ready' },
];

const rows = [];
try {
  const main = await connectMain();
  await sleep(9000);
  for (const s of SCENARIOS) {
    const from = readTrace().length;
    const callsBefore = aiCalls;
    const requestId = `m_${Math.random().toString(36).slice(2, 8)}`;
    const t0 = Date.now();
    const result = await main.evalIn(`window.eya.submit({ text: ${JSON.stringify(s.text)}, source: 'text', requestId: ${JSON.stringify(requestId)}, mode: ${JSON.stringify(s.mode)} }).then((r) => ({ ok: r.ok, spoken: r.spoken, tokens: r.tokens ?? null }))`);
    const ms = Date.now() - t0;
    const trace = readTrace().slice(from).filter((t) => t.kind === 'ai-request');
    const row = {
      scenario: s.name,
      text: s.text,
      msToAnswer: ms,
      aiCalls: aiCalls - callsBefore,
      tools: trace[0]?.tools?.length ?? 0,
      systemChars: trace[0]?.systemChars ?? 0,
      toolChars: trace[0]?.toolChars ?? 0,
      firstCallChars: (trace[0]?.systemChars ?? 0) + (trace[0]?.toolChars ?? 0) + (trace[0]?.messageChars ?? 0),
      tokens: result?.tokens?.total ?? 0,
      answer: String(result?.spoken ?? '').slice(0, 90),
    };
    rows.push(row);
    console.log(`${s.name.padEnd(52)} ${String(ms).padStart(6)} ms  ai calls ${row.aiCalls}  tools ${String(row.tools).padStart(2)}  system ${String(row.systemChars).padStart(6)} + tools ${String(row.toolChars).padStart(6)} chars  tokens ${row.tokens}`);
    await sleep(1500);
  }
} catch (e) {
  console.log('the run stopped:', e instanceof Error ? e.message : String(e));
} finally {
  const file = join(OUT, `measure-${label}.json`);
  writeFileSync(file, JSON.stringify({ label, at: new Date().toISOString(), rows }, null, 2));
  console.log('\nreport:', file);
  stopApp();
  google.close();
  await sleep(1500);
  try { rmSync(userData, { recursive: true, force: true }); rmSync(downloads, { recursive: true, force: true }); } catch { /* still in use */ }
  process.exit(0);
}
