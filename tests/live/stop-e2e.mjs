// Run from the project folder:  node tests/live/stop-e2e.mjs      (E2E_MODE=preview to run the built app)
// The real app, a stand-in AI that can be made slow, and a local web with a page that takes a long time to answer.
// Stop must end what Eya is doing ON THE SPOT, whatever she is in the middle of, and release the chat box: while the AI is being waited for, while a page
// is loading, while she is paused, and from each of the Stop buttons (the chat box, the Browser page's, the panel's, a task's).
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, createWriteStream, writeFileSync } from 'node:fs';
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
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra ?? '').slice(0, 900)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------------ a local web, one page of which is very slow
let port = 0;
const sockets = new Set();
const site = createServer((req, res) => {
  const host = String(req.headers.host ?? '').split(':')[0];
  if (host === 'slow.localhost') {
    // (it starts a reply and never finishes it for a long time)
    setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>Slow Page</title></head><body><h1>Slow Page</h1><p>You waited a long time for this.</p></body></html>'); }, 40_000);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><title>Quick Page</title></head><body><h1>Quick Page</h1><p>Plenty of text on this quick page for it to count as loaded.</p></body></html>');
});
site.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
await new Promise((r) => site.listen(0, '127.0.0.1', r));
port = site.address().port;
const at = (h) => `http://${h}.localhost:${port}/`;

// ------------------------------------------------------------------------------------------------------------ a stand-in AI that can be slow
const MAIN = 'AIzaSyMAINMAINMAINMAINMAINMAINMAIN123';
let aiDelay = 0;
const seen = { requests: 0, cancelled: 0 };
const google = createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [] })); return; }
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    if (raw.includes('"AUDIO"')) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 400, message: 'no speech in the test' } })); return; }
    seen.requests += 1;
    // (a request that the app cancels while it is waiting: its connection closes before an answer was sent)
    res.on('close', () => { if (!res.writableEnded) seen.cancelled += 1; });
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'A long answer that took its time.' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 10 } }));
    }, aiDelay);
  });
});
await new Promise((r) => google.listen(0, '127.0.0.1', r));
const googleUrl = `http://127.0.0.1:${google.address().port}/v1beta`;

const userData = mkdtempSync(join(tmpdir(), 'eya-stop-'));
const downloads = mkdtempSync(join(tmpdir(), 'eya-stop-dl-'));
const log = createWriteStream(join(OUT, `stop-app-${Date.now()}.log`));
const env = { ...process.env, EYA_NO_MIC: '1', EYA_GEMINI_API_KEY: MAIN, EYA_GEMINI_BASE_URL: googleUrl, EYA_OLLAMA_URL: 'http://127.0.0.1:1', EYA_BRIDGE_PORT: '47835', EYA_BROWSER_DOWNLOADS: downloads, EYA_BROWSER_NAV_TIMEOUT_MS: '60000' };
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
  const shot = async (name) => { const r = await main.send('Page.captureScreenshot', { format: 'png' }); if (r.result?.data) writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64')); };
  const dom = async (expr) => { await ensureApp(); return evalIn(expr); };
  const waitFor = async (expr, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await dom(expr).catch(() => false)) return Date.now() - t0; await sleep(100); } return false; };
  const typeText = async (text) => { await dom(`document.querySelector('.composer textarea').focus()`); await main.send('Input.insertText', { text }); await sleep(150); };
  const sendNow = () => dom(`document.querySelector('.composer .ask-go:not(.stop)').click()`);
  const newChat = async () => { await dom(`(() => { const n = document.querySelector('.sidebar .new-chat'); if (n && !n.disabled) n.click(); })()`); await sleep(500); };
  const convText = () => dom(`(document.querySelector('.ws-left .conv') ?? document.querySelector('.conv'))?.innerText ?? ''`);
  const stopButtonShown = () => dom(`!!document.querySelector('.composer .ask-go.stop')`);
  const setAgent = async (on) => { const isOn = await dom(`document.querySelector('.composer .agent-toggle')?.getAttribute('aria-checked') === 'true'`); if (isOn !== on) await dom(`document.querySelector('.composer .agent-toggle').click()`); await sleep(250); };

  // ---------------------------------------------------------------- 1. the chat box: Stop while the AI is being waited for
  await setAgent(false);
  aiDelay = 25_000;
  const before1 = { ...seen };
  await typeText('tell me a very long story about a king');
  await sendNow();
  const shown = await waitFor(`!!document.querySelector('.composer .ask-go.stop')`, 8000);
  check('1. while Eya works, the chat box has a Stop button in place of Send', shown !== false, { shown });
  await sleep(1200); // (the AI request is now really waiting)
  check('   the AI was really being waited for (a request is in flight and not answered)', seen.requests === before1.requests + 1, seen);
  await shot('stop-0-busy.png');
  const t1 = Date.now();
  await dom(`document.querySelector('.composer .ask-go.stop').click()`);
  const released = await waitFor(`!document.querySelector('.composer .ask-go.stop') && /Okay, I stopped\\./.test((document.querySelector('.conv')?.innerText ?? ''))`, 6000);
  const took1 = Date.now() - t1;
  check('   Stop ends it on the spot: the box is released and says "Okay, I stopped." within about a second (not after the 25 s the AI would have taken)', released !== false && took1 < 2500, { took1 });
  await sleep(800);
  check('   the request to the AI was cancelled (its connection closed before any answer)', seen.cancelled === before1.cancelled + 1, seen);
  await sleep(1500);
  check('   and nothing else turns up afterwards: no late answer, the Send button is back', !/long answer that took its time/.test(await convText()) && (await dom(`!!document.querySelector('.composer .ask-go:not(.stop)')`)), (await convText()).slice(-200));
  await shot('stop-1-chat.png');

  // ---------------------------------------------------------------- 2. Stop while a page is loading (the application's own opening of a site)
  await newChat();
  await setAgent(true);
  aiDelay = 0;
  const before2 = seen.requests;
  await typeText(`open ${at('slow')} and read me what it says`);
  await sendNow();
  await waitFor(`!!document.querySelector('.composer .ask-go.stop')`, 8000);
  await sleep(4000); // (the page has been loading for a few seconds and is not going to answer for 40)
  const loading = await evalIn('window.eya.getBrowserPanel()');
  check('2. a page that takes a very long time to load: Eya is waiting for it (the task is on, the browser is busy)', (await stopButtonShown()) === true && /working|Working/i.test(String(loading.statusText ?? loading.status ?? '')), { status: loading.status, text: loading.statusText });
  const t2 = Date.now();
  await dom(`document.querySelector('.composer .ask-go.stop').click()`);
  const released2 = await waitFor(`!document.querySelector('.composer .ask-go.stop') && /Okay, I stopped\\./.test((document.querySelector('.ws-left .conv') ?? document.querySelector('.conv'))?.innerText ?? '')`, 8000);
  const took2 = Date.now() - t2;
  check('   Stop ends it on the spot, long before the page would have answered', released2 !== false && took2 < 3000, { took2 });
  await sleep(1500);
  check('   and the AI was never asked afterwards (nothing more was begun)', seen.requests === before2, { before2, now: seen.requests });
  await shot('stop-2-page.png');

  // ---------------------------------------------------------------- 3. Pause holds the whole request, and Stop ends it even while it is paused
  await newChat();
  await setAgent(false);
  aiDelay = 0;
  const before3 = seen.requests;
  await evalIn(`window.eya.actOnBrowserPanel({ type: 'pause' })`);
  await typeText('say hello to me');
  await sendNow();
  await sleep(3500);
  check('3. while it is paused no AI step is begun (the work is held, not only the browser)', seen.requests === before3 && (await stopButtonShown()) === true, { requests: seen.requests - before3 });
  await evalIn(`window.eya.actOnBrowserPanel({ type: 'resume' })`);
  const answered3 = await waitFor(`/long answer that took its time/.test(document.querySelector('.conv')?.innerText ?? '')`, 15000);
  check('   resuming lets it carry on and finish', answered3 !== false && seen.requests === before3 + 1, { answered3, requests: seen.requests - before3 });
  await sleep(600);
  await evalIn(`window.eya.actOnBrowserPanel({ type: 'pause' })`);
  await typeText('and say goodbye to me');
  await sendNow();
  await sleep(1500);
  const t3 = Date.now();
  await dom(`document.querySelector('.composer .ask-go.stop').click()`);
  const released3 = await waitFor(`!document.querySelector('.composer .ask-go.stop')`, 5000);
  check('   pressing Stop while it is paused ends it at once', released3 !== false && Date.now() - t3 < 2500, { took: Date.now() - t3 });
  await evalIn(`window.eya.actOnBrowserPanel({ type: 'resume' })`);
  await sleep(400);

  // ---------------------------------------------------------------- 4. the Stop of the Browser page and of the panel
  await newChat();
  await setAgent(true);
  aiDelay = 25_000;
  const before4 = { ...seen };
  await typeText('tell me a joke please');
  await sendNow();
  await waitFor(`!!document.querySelector('.composer .ask-go.stop')`, 8000);
  await sleep(1200);
  const t4 = Date.now();
  const stopped4 = await evalIn(`window.eya.actOnBrowserPanel({ type: 'stop' })`);
  const released4 = await waitFor(`!document.querySelector('.composer .ask-go.stop')`, 6000);
  check('4. the Stop of the Browser page / panel (the same call) ends the request on the spot too, not only the browser steps after it', stopped4.ok === true && released4 !== false && Date.now() - t4 < 2500 && seen.cancelled === before4.cancelled + 1, { took: Date.now() - t4, seen });
  aiDelay = 0;

  // ---------------------------------------------------------------- 5. the Stop of a task (the Tasks card): the request behind it ends at once
  await newChat();
  await setAgent(true);
  aiDelay = 40_000;
  await typeText(`open ${at('quick')} and tell me the heading`);
  await sendNow();
  // (the page opens by itself, then the AI is asked and takes its time: a request that has done work is shown as a task after a few seconds)
  const taskShown = await waitFor(`/Tasks in progress|Stop/.test(document.body.innerText) && !!document.querySelector('.composer .ask-go.stop')`, 20000);
  let tasks = await evalIn('window.eya.getTasks()');
  for (let i = 0; i < 40 && tasks.items.filter((x) => x.state === 'running').length === 0; i++) { await sleep(500); tasks = await evalIn('window.eya.getTasks()'); }
  const running = tasks.items.find((x) => x.state === 'running');
  const t5 = Date.now();
  if (running !== undefined) await evalIn(`window.eya.actOnTasks({ kind: 'cancel', id: ${JSON.stringify(running.id)} })`);
  const released5 = await waitFor(`!document.querySelector('.composer .ask-go.stop')`, 6000);
  check('5. Stop on the task itself ends the request behind it on the spot', taskShown !== false && running !== undefined && released5 !== false && Date.now() - t5 < 2500, { had: running?.state, took: Date.now() - t5 });
  tasks = await evalIn('window.eya.getTasks()');
  check('   and it is stopped, not failed and not kept to be tried again', tasks.items.filter((x) => x.state === 'waiting' || x.state === 'failed').length === 0, tasks.items.map((x) => x.state));
  aiDelay = 0;

  // ---------------------------------------------------------------- 6. the next request after a Stop works normally
  await newChat();
  await setAgent(false);
  await typeText('hello again');
  await sendNow();
  const ok6 = await waitFor(`/long answer that took its time/.test(document.querySelector('.conv')?.innerText ?? '')`, 20000);
  check('6. after all that Stops, a new request is answered normally', ok6 !== false, (await convText()).slice(-200));

  // ---------------------------------------------------------------- 7. Stop also silences her while she is reading the answer aloud
  await newChat();
  await typeText('and one more hello');
  await sendNow();
  await waitFor(`/long answer that took its time/.test(document.querySelector('.conv')?.innerText ?? '')`, 20000);
  const speaking = await waitFor(`!!document.querySelector('.composer .stop-speaking')`, 6000);
  const sendStaysUsable = await dom(`!!document.querySelector('.composer .ask-go:not(.stop)')`);
  const t7 = Date.now();
  if (speaking !== false) await dom(`document.querySelector('.composer .stop-speaking').click()`);
  const quiet7 = await waitFor(`!document.querySelector('.composer .stop-speaking')`, 6000);
  check('7. while she is speaking the answer, Send stays usable and a small button silences her; pressing it ends the talking within a couple of seconds', speaking !== false && sendStaysUsable === true && quiet7 !== false && Date.now() - t7 < 3500, { speaking, sendStaysUsable, quiet7, took: Date.now() - t7 });
} catch (e) {
  failures++;
  console.log('FAIL  the run stopped:', e && e.message ? e.message : e);
} finally {
  stopApp();
  for (const s of sockets) s.destroy();
  site.close();
  google.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  console.log('screenshots and the app log are in', OUT);
  process.exit(failures === 0 ? 0 : 1);
}
