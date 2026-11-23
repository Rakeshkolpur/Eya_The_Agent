// Run from the project folder, after "npx electron-vite build":   E2E_MODE=preview node tests/live/nointro-e2e.mjs   (22 Nov 2026: the Live chat page says Eya writes a plain hello and does NOT introduce herself; she only says who she is when asked)
// Checks only what the person SEES in the real app (Electron): the start form (after ticking "Reply automatically") and the name hint on the Live chat page. NOT covered here: a live chat that is really
// running (it needs WhatsApp Web) or a real model writing the messages (see tests/liveChatNoIntro.test.ts, and tests/live/livechat.localmodel.live.test.ts for the real local model).
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT = process.cwd().split('\\').join('/');
const SP = join(tmpdir(), 'eya-e2e-out');
mkdirSync(SP, { recursive: true });
const CDP = 9336;
let failures = 0;
const check = (name, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra ?? '').slice(0, 900)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userData = mkdtempSync(join(tmpdir(), 'eya-together-'));
const logFile = join(SP, `together-app-${Date.now()}.log`);
const log = createWriteStream(logFile);
const env = {
  ...process.env,
  EYA_GEMINI_API_KEY: 'AIzaSyBPBPBPBPBPBPBPBPBPBPBPBPBPBPBPBP1',
  EYA_OLLAMA_URL: 'http://127.0.0.1:1',
  EYA_BRIDGE_PORT: '47838',
  EYA_NO_BROWSER_LAUNCH: '1',
  EYA_NO_MIC: '1',
  EYA_LOG_LEVEL: 'debug',
};
delete env.EYA_BACKUP_AI_KEY;
delete env.EYA_BROWSER_HEADLESS;
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
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 60000 });
    if (r.result?.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  return { send, evalIn, close: () => ws.close() };
}

async function connectMain() {
  for (let i = 0; i < 120; i++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${CDP}/json`).then((r) => r.json());
      for (const t of targets.filter((x) => x.type === 'page')) {
        const c = await attach(t.webSocketDebuggerUrl);
        if (await c.evalIn('typeof window.eya !== "undefined" && typeof window.eya.liveChatAction === "function"').catch(() => false)) return c;
        c.close();
      }
    } catch { /* not up yet */ }
    await sleep(2000);
  }
  throw new Error('the app window never appeared');
}

try {
  const main = await connectMain();
  const evalIn = main.evalIn;
  await sleep(6000);
  await evalIn('window.eya.setWindowMode("app")');
  await main.send('Page.bringToFront');
  await sleep(2500);
  const clickNav = (label) => evalIn('(() => { const b = [...document.querySelectorAll(".nav-item")].find((x) => x.textContent.trim().startsWith(' + JSON.stringify(label) + ')); if (!b) return "no nav"; b.click(); return "clicked"; })()');
  console.log('open the Live chat page ->', await clickNav('Live chat'));
  await sleep(1500);
  // (the first-message option shows once 'Reply automatically' is ticked)
  await evalIn('(() => { const l = [...document.querySelectorAll("label.livechat-check")].find((x) => /Reply automatically/.test(x.textContent)); l.querySelector("input").click(); })()');
  await sleep(500);
  const text = String(await evalIn('document.body.innerText'));
  check('the start form says Eya writes a friendly hello with no introduction, and only says who she is if asked', /friendly hello, with no introduction/.test(text) && /only says who she is if they ask/.test(text), text.slice(0, 1500));
  check('the old wording (Eya introduces herself in the chat first) is gone', !/introduces herself in the chat first/.test(text) && !/tell me what you want/.test(text), text.slice(0, 600));
  check('the name hint says she says it only when someone asks', /only if someone in the chat asks who she is, Eya says/.test(text) && /she never says it by herself/.test(text), text.slice(0, 1500));
  console.log(failures === 0 ? 'ALL PASSED' : failures + ' FAILED');
} catch (e) {
  failures++;
  console.log('ERROR', String(e).slice(0, 400));
}
process.exit(failures === 0 ? 0 : 1);
