// Run from the project folder:  node tests/live/token-economy-e2e.mjs      (needs the built app: npx electron-vite build)
// The real app, the real tools and Eya Browser, a small court-site stand-in on this PC, and a scripted stand-in for the AI (so no allowance is spent and
// the run is the same every time). It checks what a request about a website costs:
//   - how many AI calls it makes, and how big each is (instructions + tool schemas + conversation, in characters; about 4 a token),
//   - that after the first step the tools and instructions about the PC itself are set aside, and come back when asked for,
//   - that a link covered by a drop-down menu is followed instead of costing a step,
//   - that a tool given an argument it does not have runs without it,
//   - that the figure the app shows for the request is the sum of what the AI reported.
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT = process.cwd().split('\\').join('/');
const OUT = join(tmpdir(), 'eya-e2e-out');
mkdirSync(OUT, { recursive: true });
const CDP = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  (' + detail + ')'}`);
};

const userData = mkdtempSync(join(tmpdir(), 'eya-economy-'));
const downloads = mkdtempSync(join(tmpdir(), 'eya-economy-dl-'));
const traceFile = join(userData, 'trace.jsonl');
const log = createWriteStream(join(OUT, `economy-app-${Date.now()}.log`));

// ---- the court site: a menu that drops down over the "Cause List" link, and a list of seven cases on the page that link leads to
const seen = [];
const CASES = 7;
const site = createServer((req, res) => {
  seen.push(req.url);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (req.url === '/causelist') {
    const rows = Array.from({ length: CASES }, (_, i) => `<tr><td>${i + 1}</td><td>WP ${1200 + i * 17}/2026</td><td>Court ${1 + (i % 3)}</td></tr>`).join('');
    return res.end(`<!doctype html><title>Cause List - Test High Court</title><h1>Cause List for Monday 26-10-2026</h1><p>Advocate code 21295</p><table><thead><tr><th>S.No</th><th>Case</th><th>Court</th></tr></thead><tbody>${rows}</tbody></table>`);
  }
  res.end(`<!doctype html><title>Test High Court</title><body style="margin:0"><nav style="position:relative;height:50px;padding:10px"><a href="/causelist">Cause List</a> | <a href="/about">About</a></nav><h1>High Court of Test</h1><p>Welcome to the court.</p>
<div style="position:fixed;left:0;top:0;width:100%;height:90px;background:#ddd;z-index:99">Case Status Information</div></body>`);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}/`;

// ---- the stand-in AI: says what a model would do at each step, and reports the usage a real one would (the size of what it was sent / 4)
const calls = [];
let steps = 0;
const USER_TEXT = `tell me how many cases listed for monday, check in the high court site ${SITE} advocate code is 21295`;
const script = [
  { name: 'find_and_open_website', args: { url: SITE, name: 'High Court of Test' } },
  { name: 'click_on_page', args: { text: 'Cause List' } },
  { name: 'read_page', args: { n: 2 } }, // (an argument the tool does not have, on purpose)
  null, // the answer
];
const google = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET') return res.end(JSON.stringify({ models: [] }));
    if (raw.includes('"AUDIO"')) return res.end(JSON.stringify({ error: { code: 400, message: 'no speech in the test' } }));
    const body = JSON.parse(raw);
    const decls = (body.tools ?? []).flatMap((x) => x.functionDeclarations ?? []);
    const system = (body.systemInstruction?.parts ?? []).map((p) => p.text).join('');
    const conversation = JSON.stringify(body.contents ?? []).length;
    const prompt = Math.round((system.length + JSON.stringify(body.tools ?? []).length + conversation) / 4);
    calls.push({ tools: decls.map((d) => d.name), systemChars: system.length, toolChars: JSON.stringify(body.tools ?? []).length, conversationChars: conversation, system, prompt, contents: body.contents });
    const next = script[Math.min(steps, script.length - 1)];
    steps += 1;
    const usage = { promptTokenCount: prompt, candidatesTokenCount: 12, totalTokenCount: prompt + 12 };
    if (next === null) return res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: `There are ${CASES} cases listed for Monday under advocate code 21295.` }] }, finishReason: 'STOP' }], usageMetadata: usage }));
    res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: next.name, args: next.args }, thoughtSignature: 'sig' }] }, finishReason: 'STOP' }], usageMetadata: usage }));
  });
});
await new Promise((r) => google.listen(0, '127.0.0.1', r));

const env = {
  ...process.env,
  EYA_NO_MIC: '1',
  EYA_TRACE_FILE: traceFile,
  EYA_BRIDGE_PORT: '47835',
  EYA_BROWSER_DOWNLOADS: downloads,
  EYA_BROWSER_MODE: 'eya_browser',
  EYA_NO_BROWSER_LAUNCH: '1',
  EYA_GEMINI_API_KEY: 'AIzaSyECONOMYECONOMYECONOMYECONOMY1234',
  EYA_GEMINI_BASE_URL: `http://127.0.0.1:${google.address().port}/v1beta`,
  EYA_OLLAMA_URL: 'http://127.0.0.1:1',
};
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
        if (await c.evalIn('typeof window.eya !== "undefined" && typeof window.eya.submit === "function"').catch(() => false)) return c;
      }
    } catch { /* not up yet */ }
    await sleep(2000);
  }
  throw new Error('the window never appeared');
}
const readTrace = () => (existsSync(traceFile) ? readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

try {
  const main = await connectMain();
  await sleep(9000);
  const t0 = Date.now();
  const result = await main.evalIn(`window.eya.submit({ text: ${JSON.stringify(USER_TEXT)}, source: 'text', requestId: 'econ1', mode: 'agent' }).then((r) => ({ ok: r.ok, spoken: r.spoken, tokens: r.tokens ?? null }))`);
  const ms = Date.now() - t0;
  console.log(`\nanswer after ${(ms / 1000).toFixed(1)} s: "${String(result?.spoken ?? '').slice(0, 100)}"\n`);

  console.log('step  tools  instructions  tool schemas  conversation   total~tokens');
  calls.forEach((c, i) => console.log(`${String(i).padStart(3)}  ${String(c.tools.length).padStart(5)}  ${String(c.systemChars).padStart(12)}  ${String(c.toolChars).padStart(12)}  ${String(c.conversationChars).padStart(12)}  ${String(c.prompt).padStart(12)}`));
  console.log('');

  const PC = ['find_file', 'open_file', 'open_folder', 'find_folder', 'window_control', 'list_windows', 'clipboard_read', 'open_application'];
  check('the request took the four AI calls it needs (open, click, read, answer)', calls.length === 4, `${calls.length} calls`);
  check('the answer is what the stand-in AI said', /7 cases/.test(String(result?.spoken)), String(result?.spoken).slice(0, 60));
  check('the first step is offered everything, the PC tools included', PC.every((n) => calls[0]?.tools.includes(n)));
  check('the next steps are not offered the tools about the PC', [1, 2, 3].every((i) => PC.every((n) => !calls[i]?.tools.includes(n))), calls.slice(1).map((c) => c.tools.length).join('/'));
  check('they are still offered the tools for the page, the web and load_tools', [1, 2, 3].every((i) => ['click_on_page', 'read_page', 'web_search', 'load_tools'].every((n) => calls[i]?.tools.includes(n))));
  check('and the instructions about the PC are set aside, with a line saying how to get them back', [1, 2, 3].every((i) => !calls[i]?.system.includes('Finding and opening files anywhere') && calls[i]?.system.includes('pc = ')) && calls[0]?.system.includes('Finding and opening files anywhere'));
  const fixed = (i) => (calls[i]?.systemChars ?? 0) + (calls[i]?.toolChars ?? 0);
  check('each step after the first carries at least 9,000 characters less than the first', fixed(1) <= fixed(0) - 9000 && fixed(2) <= fixed(0) - 9000, `${fixed(0)} then ${fixed(1)}`);
  check('the covered link was followed (the site was asked for the page behind it)', seen.includes('/causelist'), seen.join(' '));
  const trace = readTrace();
  const results = trace.filter((t) => t.kind === 'tool-result');
  check('the click on the covered link worked', results.find((r) => r.name === 'click_on_page')?.ok === true, JSON.stringify(results.find((r) => r.name === 'click_on_page') ?? {}).slice(0, 160));
  check('the argument the tool does not have was set aside: the read worked and said so, at no cost of a step', results.find((r) => r.name === 'read_page')?.ok === true && JSON.stringify(calls[3]?.contents ?? []).includes('ignoredArgs'), JSON.stringify(results.find((r) => r.name === 'read_page') ?? {}).slice(0, 120));
  check('the page script counted the rows of the list (so the answer is not a count by eye of the six shown)', JSON.stringify(calls[3]?.contents ?? []).includes('dataRows') && JSON.stringify(calls[3]?.contents ?? []).replace(/\\"/g, '"').includes('"dataRows":' + CASES), `${CASES} cases in the table`);
  const reported = calls.reduce((n, c) => n + c.prompt + 12, 0);
  check('the figure the app shows for the request is the sum of what the AI reported', result?.tokens?.total === reported, `${result?.tokens?.total} vs ${reported}`);
  check('it was not sent anything twice: one usage report per AI call', trace.filter((t) => t.kind === 'usage').length === calls.length, `${trace.filter((t) => t.kind === 'usage').length} reports`);
  writeFileSync(join(OUT, 'economy-calls.json'), JSON.stringify(calls.map((c) => ({ ...c, system: undefined, contents: undefined })), null, 1));
} catch (e) {
  checks.push({ name: 'the run', ok: false });
  console.log('the run stopped:', e instanceof Error ? e.message : String(e));
} finally {
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  stopApp();
  google.close();
  site.close();
  await sleep(1500);
  try { rmSync(userData, { recursive: true, force: true }); rmSync(downloads, { recursive: true, force: true }); } catch { /* still in use */ }
  process.exit(failed === 0 ? 0 : 1);
}
