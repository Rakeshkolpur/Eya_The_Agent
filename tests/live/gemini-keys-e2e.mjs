// Run from the project folder:  node tests/live/gemini-keys-e2e.mjs
// Real app + a fake Google: several Gemini keys are added from the page, the first one is "out of allowance for the day", and the next one must answer.
// Also checks that the keys are visible on Home and reachable from there and from the sidebar.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, createWriteStream, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const PROJECT = process.cwd().split('\\').join('/');
const OUT = join(tmpdir(), 'eya-e2e-out');
mkdirSync(OUT, { recursive: true });
const CDP = 9333;
let failures = 0;
const check = (name, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra ?? '').slice(0, 800)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAIN = 'AIzaSyMAINMAINMAINMAINMAINMAINMAIN123';
const FATHER = 'AIzaSyFATHERFATHERFATHERFATHERFATHER12';
const BROTHER = 'AIzaSyBROTHERBROTHERBROTHERBROTHER1234';
const SISTER = 'AIzaSySISTERSISTERSISTERSISTERSISTER12';
const asked = [];
// A fake Google: every key is "valid"; the person's own key has no allowance left today; the others answer with their name.
const google = createServer((req, res) => {
  const key = String(req.headers['x-goog-api-key'] ?? new URL(req.url, 'http://x').searchParams.get('key') ?? '');
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [] }));
    return;
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    asked.push(key.slice(0, 12));
    if (key === MAIN) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric generate_content_free_tier_requests, limit: 20, PerDay' } }));
      return;
    }
    const who = key.includes('FATHER') ? 'father' : key.includes('BROTHER') ? 'brother' : 'sister';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: `Four. (answered with the ${who} key)` }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 10 } }));
  });
});
await new Promise((r) => google.listen(0, '127.0.0.1', r));
const googleUrl = `http://127.0.0.1:${google.address().port}/v1beta`;

const userData = mkdtempSync(join(tmpdir(), 'eya-keys-'));
const log = createWriteStream(join(OUT, `keys-app-${Date.now()}.log`));
const env = { ...process.env, EYA_GEMINI_API_KEY: MAIN, EYA_GEMINI_BASE_URL: googleUrl, EYA_OLLAMA_URL: 'http://127.0.0.1:1', EYA_BRIDGE_PORT: '47835', EYA_NO_MIC: '1', EYA_NO_BROWSER_LAUNCH: '1' };
delete env.EYA_BACKUP_AI_KEY;
const app = spawn('cmd.exe', ['/c', 'npx', 'electron-vite', process.env.E2E_MODE === 'preview' ? 'preview' : 'dev', '--', `--remote-debugging-port=${CDP}`, `--user-data-dir=${userData}`], { cwd: PROJECT, env });
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
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 90000 });
    if (r.result?.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
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
        if (await c.evalIn('typeof window.eya !== "undefined" && typeof window.eya.getGeminiKeys === "function"').catch(() => false)) return c;
      }
    } catch { /* not up yet */ }
    await sleep(2000);
  }
  throw new Error('the window never appeared');
}

try {
  const main = await connectMain();
  const evalIn = main.evalIn;
  await sleep(8000);
  await evalIn('window.eya.setWindowMode("app")');
  await main.send('Page.bringToFront');
  await sleep(3000);
  const shot = async (name) => { const r = await main.send('Page.captureScreenshot', { format: 'png' }); if (r.result?.data) writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64')); };
  // (the window can drop back to its small shapes while Eya greets: put it back before reading the page)
  const ensureApp = async () => {
    for (let i = 0; i < 10; i++) {
      if (await evalIn("!!document.querySelector('.appwin')").catch(() => false)) return;
      await evalIn('window.eya.setWindowMode("app")').catch(() => undefined);
      await main.send('Page.bringToFront');
      await sleep(1500);
    }
  };
  const text = async () => { await ensureApp(); return evalIn('document.body.innerText'); };
  const dom = async (expr) => { await ensureApp(); return evalIn(expr); };

  let before = await evalIn('window.eya.getGeminiKeys()');
  check('the person\'s own key is in the list to begin with', before.entries.length === 1 && before.entries[0].main === true, before);

  // several keys at once, one per line, each with a name (the way they are pasted from a chat)
  const added = await evalIn(`window.eya.addGeminiKeys({ lines: ${JSON.stringify(`Father ${FATHER}\nBrother: ${BROTHER}\nSister - ${SISTER}`)} })`);
  check('three more keys are saved from one paste', added.ok === true && added.status.entries.length === 4, added);
  check('they keep the names given', ['Father', 'Brother', 'Sister'].every((n) => added.status.entries.some((e) => e.name === n)), added.status.entries.map((e) => e.name));
  await sleep(1500);

  // (the keys card on Home is one of the cards that belong to the panel of a running agent task: the keys are looked at from the sidebar and Settings)
  check('the AI picker is on Home', await dom(`!!document.querySelector('.cw .composer .ai-picker')`));
  check('the sidebar says how many keys are used one after another', /4 Gemini keys, used one after another/.test(await text()), (await text()).slice(0, 400));
  await dom(`document.querySelector('.ai-card-btn').click()`);
  await sleep(1500);
  const settingsText = await text();
  check('the AI card in the sidebar opens the keys, one after another', ['Father', 'Brother', 'Sister'].every((n) => settingsText.includes(n)), settingsText.slice(0, 500));
  await shot('keys-settings.png');
  await dom(`[...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === 'Home').click()`);
  await sleep(600);

  // one is used until its allowance for the day is spent, then the next takes over
  const answer = await evalIn(`window.eya.submit({ text: 'what is two plus two', source: 'text', requestId: 'keys-1' }).then((r) => r.spoken)`);
  check('the first key had no allowance left, so the next one answered', /Four\./.test(String(answer)) && /father key/.test(String(answer)), { answer, asked });
  check('Google was asked with the person\'s own key first, then Father\'s', asked[0] === MAIN.slice(0, 12) && asked.includes(FATHER.slice(0, 12)), asked);
  await sleep(800);
  const after = await evalIn('window.eya.getGeminiKeys()');
  const stateOf = (name) => after.entries.find((e) => e.name === name);
  const mainEntry = after.entries.find((e) => e.main);
  check('the list says so: own key used up for today, Father\'s answering now', mainEntry?.state === 'used-up' && stateOf('Father')?.inUse === true && stateOf('Father')?.requests >= 1, after.entries);
  const asksBefore = asked.length;
  const second = await evalIn(`window.eya.submit({ text: 'and what is three plus three', source: 'text', requestId: 'keys-2' }).then((r) => r.spoken)`);
  check('the next question goes straight to Father (the used-up key is left alone)', /father key/.test(String(second)) && asked.slice(asksBefore).every((k) => k === FATHER.slice(0, 12)), { second, asked: asked.slice(asksBefore) });
  await dom(`document.querySelector('.ai-card-btn').click()`);
  await sleep(1500);
  check('the keys page shows which key is answering now', /answering now/i.test(await text()), (await text()).slice(0, 600));
  await shot('keys-settings-after.png');
} catch (e) {
  failures++;
  console.log('FAIL  harness error: ' + (e instanceof Error ? e.stack ?? e.message : String(e)));
} finally {
  stopApp();
  google.close();
  await sleep(1500);
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* in use */ }
}
console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
