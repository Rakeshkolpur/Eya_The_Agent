// Run from the project folder, after 'npx electron-vite build':   E2E_MODE=preview node tests/live/together-e2e.mjs
// TOGETHER on the real app (Electron): the Live chat page offers to be in the chat too, and the new requests (set_together, dictate, hold, release) go through the real preload -> IPC ->
// live chat hub and are refused in plain words when no live chat is running (nothing is sent, nothing starts). NOT covered here: a live chat that is really running (it needs WhatsApp Web),
// the microphone and a real voice model (see the unit and real-Chromium tests for the behaviour itself).
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
  const clickNav = (label) => evalIn(`(() => { const b = [...document.querySelectorAll('.nav-item')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) return 'no nav ' + ${JSON.stringify(label)}; b.click(); return 'clicked'; })()`);

  console.log('open the Live chat page ->', await clickNav('Live chat'));
  await sleep(1500);
  const text = String(await evalIn('document.body.innerText'));
  check('the Live chat page offers to be in the chat too (together), with what it does', /I will be in this chat too \(together\)/.test(text) && /my microphone stays on/.test(text), text.slice(0, 700));
  check('the checkbox for it is there and starts unticked', (await evalIn(`(() => { const l = [...document.querySelectorAll('label.livechat-check')].find((x) => /in this chat too \\(together\\)/.test(x.textContent)); const i = l && l.querySelector('input[type=checkbox]'); return i ? i.checked : null; })()`)) === false);
  await evalIn(`(() => { const l = [...document.querySelectorAll('label.livechat-check')].find((x) => /in this chat too \\(together\\)/.test(x.textContent)); l.querySelector('input').click(); })()`);
  await sleep(300);
  check('it can be ticked on the start form', (await evalIn(`(() => { const l = [...document.querySelectorAll('label.livechat-check')].find((x) => /in this chat too \\(together\\)/.test(x.textContent)); return l.querySelector('input').checked; })()`)) === true);

  // the new requests go through the real preload -> IPC -> hub, and with no live chat running they say so in plain words and do nothing
  const a = await evalIn('window.eya.liveChatAction({ kind: "set_together", on: true })');
  check('set_together with no live chat running says so', a && a.ok === false && /no live chat running/.test(a.message), a);
  const d = await evalIn('window.eya.liveChatAction({ kind: "dictate", text: "I will come at 5", send: true })');
  check('dictate with no live chat running sends nothing and says so', d && d.ok === false && /no live chat running/.test(d.message), d);
  const h = await evalIn('window.eya.liveChatAction({ kind: "hold" })');
  check('hold with no live chat running says so', h && h.ok === false && /no live chat running/.test(h.message), h);
  const r = await evalIn('window.eya.liveChatAction({ kind: "release" })');
  check('release with no live chat running is harmless', r && r.ok === true && /not holding/.test(r.message), r);
  const bad = await evalIn('window.eya.liveChatAction({ kind: "dictate", text: "" })');
  check('an empty dictation is refused before it reaches the chat', bad && bad.ok === false, bad);
  const view = await evalIn('window.eya.getLiveChat()');
  check('the live chat view says it is not together (and not held)', view && (view.together ?? false) === false && (view.held ?? false) === false, view);

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  console.log('app log:', logFile);
} catch (e) {
  failures++;
  console.log('ERROR', e instanceof Error ? e.stack : e);
} finally {
  stopApp();
  process.exit(failures === 0 ? 0 : 1);
}
