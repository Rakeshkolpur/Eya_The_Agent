// Run from the project folder:  node tests/live/diagnose-request.mjs      (needs the built app: npx electron-vite build)
// Diagnosis, not a pass/fail test: runs real requests through the real app and writes down everything that happened to each one:
//   the answer in the conversation, the raw words of every AI answer and every tool call (EYA_TRACE_FILE), the log lines, and what the
//   window did (panel, browser). With DIAG_REAL=1 the app uses the AI settings of the real Eya (Gemini keys, backup AI, settings are
//   COPIED into a throwaway profile; nothing is written back); without it a stand-in Google answers every chat with "(stand-in)".
// DIAG_ONLY=1,3 picks scenarios by number. The report is written to %TEMP%\eya-e2e-out\diag-<time>.json.
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT = process.cwd().split('\\').join('/');
const OUT = join(tmpdir(), 'eya-e2e-out');
mkdirSync(OUT, { recursive: true });
const CDP = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const real = process.env.DIAG_REAL === '1';

const userData = mkdtempSync(join(tmpdir(), 'eya-diag-'));
const downloads = mkdtempSync(join(tmpdir(), 'eya-diag-dl-'));
const traceFile = join(userData, 'trace.jsonl');
const logFile = join(OUT, `diag-app-${Date.now()}.log`);
const log = createWriteStream(logFile);
if (real) {
  const from = join(process.env.APPDATA ?? '', 'eya');
  for (const f of ['Local State', 'gemini-keys.bin', 'gemini-key-state.json', 'backup-ai.bin', 'settings.json']) if (existsSync(join(from, f))) copyFileSync(join(from, f), join(userData, f));
}
const env = { ...process.env, EYA_NO_MIC: '1', EYA_TRACE_FILE: traceFile, EYA_BRIDGE_PORT: '47835', EYA_BROWSER_DOWNLOADS: downloads };
if (!real) {
  const { createServer } = await import('node:http');
  const google = createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.method === 'GET' ? { models: [] } : { candidates: [{ content: { role: 'model', parts: [{ text: '(stand-in)' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 1 } }));
    });
  });
  await new Promise((r) => google.listen(0, '127.0.0.1', r));
  env.EYA_GEMINI_API_KEY = 'AIzaSyDIAGDIAGDIAGDIAGDIAGDIAGDIAG1234';
  env.EYA_GEMINI_BASE_URL = `http://127.0.0.1:${google.address().port}/v1beta`;
  env.EYA_OLLAMA_URL = 'http://127.0.0.1:1';
}
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
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 120000 });
    if (r.result?.exceptionDetails) throw new Error('page error: ' + String(r.result.exceptionDetails.exception?.description ?? '').slice(0, 400) + ' in: ' + expression.slice(0, 140));
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
  { n: 1, name: '"Hi" in normal chat (Agent off)', agent: false, text: 'Hi' },
  { n: 2, name: 'a harmless website, Agent on', agent: true, text: 'Open the website example.org and tell me what the main heading on the page says.' },
  { n: 3, name: 'the exact request, Agent off', agent: false, text: 'Open MovieRulz site and play Telugu HD Paradise movie.' },
  { n: 4, name: 'the exact request, Agent on', agent: true, text: 'Open MovieRulz site and play Telugu HD Paradise movie.' },
  { n: 5, name: 'YouTube: a feel-good Telugu song', agent: true, text: 'Open YouTube and play a feel-good Telugu song.' },
  // (the words are given in DIAG_TEXT, so that nothing personal is written in this file)
  { n: 6, name: 'the request in DIAG_TEXT', agent: true, text: process.env.DIAG_TEXT ?? 'Find the Monday cause list of the Telangana High Court and tell me how many cases are listed.' },
];
// How long a request may go on before it is stopped (with the Stop that ends it on the spot), in seconds.
const maxSeconds = Number(process.env.DIAG_MAX_S ?? 240);
const only = (process.env.DIAG_ONLY ?? '').split(',').map((x) => Number(x)).filter(Boolean);
const report = { real, scenarios: [] };

try {
  const main = await connectMain();
  const evalIn = main.evalIn;
  await sleep(8000);
  const ensureApp = async () => {
    for (let i = 0; i < 10; i++) {
      if (await evalIn("!!document.querySelector('.appwin')").catch(() => false)) return;
      await evalIn('window.eya.setWindowMode("app")').catch(() => undefined);
      await main.send('Page.bringToFront');
      await sleep(1500);
    }
  };
  await ensureApp();
  await sleep(1500);
  const dom = async (expr) => { await ensureApp(); return evalIn(expr); };
  const typeText = async (text) => { await dom(`document.querySelector('.composer textarea').focus()`); await main.send('Input.insertText', { text }); await sleep(200); };
  const shot = async (name) => { const r = await main.send('Page.captureScreenshot', { format: 'png' }); if (r.result?.data) writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64')); };

  for (const s of SCENARIOS) {
    if (only.length > 0 && !only.includes(s.n)) continue;
    console.log(`\n=== ${s.n}. ${s.name}: "${s.text}"`);
    await dom(`(() => { const n = document.querySelector('.sidebar .new-chat'); if (n) n.click(); })()`);
    await sleep(600);
    const wantOn = s.agent;
    const isOn = await dom(`document.querySelector('.composer .agent-toggle')?.getAttribute('aria-checked') === 'true'`);
    if (wantOn !== isOn) await dom(`document.querySelector('.composer .agent-toggle').click()`);
    await sleep(300);
    const traceFrom = readTrace().length;
    const logFrom = readFileSync(logFile, 'utf8').split('\n').length;
    const t0 = Date.now();
    let sawPanel = false;
    let sawWorkspace = false;
    await typeText(s.text);
    await dom(`document.querySelector('.composer .ask-go').click()`);
    // wait for the answer: the composer stops saying "working" and Eya's message is there (at most 4 minutes)
    let answered = false;
    for (let i = 0; i < maxSeconds * 2; i++) {
      await sleep(500);
      const st = await dom(`({ panel: !!document.querySelector('aside.dash-side'), ws: !!document.querySelector('.workspace'), working: /Eya is working/.test(document.querySelector('.composer textarea')?.placeholder ?? ''), eya: [...document.querySelectorAll('.conv .msg.eya, .conv [data-role=eya]')].length })`).catch(() => null);
      if (st === null) continue;
      sawPanel ||= st.panel;
      sawWorkspace ||= st.ws;
      const text = await dom(`(document.querySelector('.ws-left .conv') ?? document.querySelector('.conv'))?.innerText ?? ''`);
      if (i > 6 && !st.working && text.split('\n').length > 2 && Date.now() - t0 > 3000) { answered = true; break; }
    }
    // (not finished in time: it is stopped, and the run says so)
    if (!answered) {
      await evalIn('window.eya.stopAll()').catch(() => undefined);
      await sleep(1500);
    }
    await sleep(2500);
    const conv = await dom(`(document.querySelector('.ws-left .conv') ?? document.querySelector('.conv'))?.innerText ?? ''`);
    const panel = await evalIn('window.eya.getBrowserPanel()').catch(() => null);
    const tasks = await evalIn('window.eya.getTasks()').catch(() => null);
    await shot(`diag-${s.n}.png`);
    const trace = readTrace().slice(traceFrom);
    // (kept, for analyze-trace.mjs)
    writeFileSync(join(OUT, `diag-trace-${s.n}.jsonl`), trace.map((x) => JSON.stringify(x)).join('\n'));
    const logs = readFileSync(logFile, 'utf8').split('\n').slice(logFrom).filter((l) => /eya\.(agent|ipc|tools|ai|research|browser|site|nav)|handled|chat answered|recovery/.test(l)).map((l) => l.replace(/^\{"ts":\d+,/, '{').slice(0, 330));
    const one = { n: s.n, name: s.name, agent: s.agent, text: s.text, answered, seconds: Math.round((Date.now() - t0) / 1000), sawPanelOrWorkspace: { panel: sawPanel, workspace: sawWorkspace }, conversation: conv, browserUrl: panel?.url ?? '', browserTitle: panel?.title ?? '', tasks: (tasks?.items ?? []).map((i) => i.request), trace, logs };
    report.scenarios.push(one);
    console.log('answered:', answered, `(${one.seconds}s)  panel/workspace opened:`, sawPanel, sawWorkspace, ' browser:', one.browserUrl || '(none)', ' tasks:', one.tasks.length);
    for (const t of trace) {
      if (t.kind === 'request') console.log(`  [request] mode=${t.mode} "${t.text}"`);
      else if (t.kind === 'ai-request') console.log(`  [ai asked]  tools offered: ${t.tools.length === 0 ? 'none' : t.tools.length > 12 ? t.tools.length + ' tools' : t.tools.join(', ')}; last: ${t.last.map((m) => m.role + ': ' + m.content.replace(/\s+/g, ' ').slice(0, 120)).join(' | ')}`);
      else if (t.kind === 'ai-response') console.log(`  [ai said]   model=${t.model}  TEXT: ${JSON.stringify(t.text).slice(0, 700)}  TOOL CALLS: ${JSON.stringify(t.toolCalls)}`);
      else if (t.kind === 'ai-error') console.log(`  [ai failed] ${t.error}`);
      else if (t.kind === 'discovery') console.log(`  [Eya's own browser step, before the AI]  target=${t.target} opened=${t.opened} page=${JSON.stringify(t.page)} findings=${JSON.stringify(t.findings)} said=${JSON.stringify(t.line)}`);
      else if (t.kind === 'tokens') console.log(`  [tokens for this request]  ${t.total} (${t.prompt} sent + ${t.completion} in the answers) over ${t.calls} AI answer(s), by ${JSON.stringify(t.byProvider)}; since Eya started: ${t.sinceStart}`);
      else if (t.kind === 'diagnosis') console.log(`  [where it went wrong]  ${t.findings.map((f) => `${f.source}: ${String(f.detail).slice(0, 160)}`).join(' | ')}`);
      else if (t.kind === 'tool-call') console.log(`  [tool run]  ${t.name} ${t.args}`);
      else if (t.kind === 'tool-result') console.log(`  [tool got]  ${t.name} ok=${t.ok} summary=${JSON.stringify(t.summary)}${t.error ? ' error=' + JSON.stringify(t.error) : ''}${t.data ? ' data=' + t.data.slice(0, 300) : ''}`);
    }
    console.log('  [what the person saw]', JSON.stringify(conv.split('\n').filter(Boolean).slice(-4)).slice(0, 900));
    if (logs.length > 0) console.log('  [log lines]\n    ' + logs.slice(-14).join('\n    '));
  }
} catch (e) {
  console.log('the run stopped:', e instanceof Error ? e.message : String(e));
} finally {
  const file = join(OUT, `diag-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('\nreport:', file);
  stopApp();
  await sleep(1500);
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* still in use */ }
  process.exit(0);
}
