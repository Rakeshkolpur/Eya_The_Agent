// Run from the project folder, after 'npx electron-vite build':   E2E_MODE=preview node tests/live/typed-split-e2e.mjs
// A task TYPED in the Eya window that works in Eya Browser opens the browser beside Eya by itself (the split screen) — also the same words asked a second time — and the Settings page has the
// new "Talk while I work" switch. The task here is "open <address> and tell me …": the application opens the page itself, in Eya Browser (the AI behind it is a made-up key, so it ends there).
// NOT covered: the microphone / a real voice (there is none in this test), a live chat (it needs WhatsApp Web).
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT = process.cwd().split('\\').join('/');
const SP = join(tmpdir(), 'eya-e2e-out');
mkdirSync(SP, { recursive: true });
const CDP = 9337;
let failures = 0;
const check = (name, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra ?? '').slice(0, 900)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { startTestSite } = await import(pathToFileURL(`${PROJECT}/tests/fixtures/chrome-test-site/server.mjs`).href);
const site = await startTestSite(0);
const base = `http://127.0.0.1:${site.port}`;

const userData = mkdtempSync(join(tmpdir(), 'eya-typed-'));
const logFile = join(SP, `typed-app-${Date.now()}.log`);
const log = createWriteStream(logFile);
const env = {
  ...process.env,
  EYA_GEMINI_API_KEY: 'AIzaSyBPBPBPBPBPBPBPBPBPBPBPBPBPBPBPBP1',
  EYA_OLLAMA_URL: 'http://127.0.0.1:1',
  EYA_BRIDGE_PORT: '47839',
  EYA_BROWSER_NAV_TIMEOUT_MS: '4000',
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
        if (await c.evalIn('typeof window.eya !== "undefined" && typeof window.eya.getBrowserPanel === "function"').catch(() => false)) return c;
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
  const setComposer = (value) => evalIn(`(() => { const el = document.querySelector('textarea[aria-label="Message Eya"]'); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return 'set'; })()`);
  const sendComposer = () => evalIn(`(() => { const b = document.querySelector('button[aria-label="Send"]'); if (!b || b.disabled) return 'no send'; b.click(); return 'sent'; })()`);
  const workspace = () => evalIn(`!!document.querySelector('.workspace .ws-view')`);
  const waitWorkspace = async (open) => { for (let i = 0; i < 60; i++) { if ((await workspace()) === open) return true; await sleep(500); } return false; };

  await clickNav('Home');
  await sleep(1000);
  // the Agent button: on (the task is carried out with the browser, not only chatted about)
  await evalIn(`(() => { const b = document.querySelector('button[aria-label="Agent mode"]'); if (b && !/on/.test(b.className)) b.click(); })()`);
  await sleep(400);
  check('before a task, nothing is beside Eya', (await workspace()) === false);

  const task = `open ${base}/r/landing and tell me the page title`;
  console.log('type the task ->', await setComposer(task), await sendComposer());
  check('a task typed in the window opens the browser beside Eya by itself', await waitWorkspace(true), await evalIn('document.body.innerText.slice(0, 300)'));

  // leave the split, wait for the task to end, ask the SAME words again: the browser opens beside Eya again
  await evalIn(`(() => { const b = [...document.querySelectorAll('.nav-item')].find((x) => x.textContent.trim().startsWith('Home')); b && b.click(); })()`);
  for (let i = 0; i < 80; i++) {
    const st = await evalIn('window.eya.getBrowserPanel().then((p) => p.status)');
    if (st === 'done' || st === 'idle' || st === 'problem') break;
    await sleep(500);
  }
  await sleep(1500);
  check('the task is over (the Browser page is no longer working)', ['done', 'idle', 'problem'].includes(await evalIn('window.eya.getBrowserPanel().then((p) => p.status)')));
  check('back on Home, nothing is beside Eya', await waitWorkspace(false), await evalIn('document.body.innerText.slice(0, 200)'));
  console.log('type the SAME words again ->', await setComposer(task), await sendComposer());
  check('the same words asked a second time open the browser beside Eya again', await waitWorkspace(true), await evalIn('document.body.innerText.slice(0, 300)'));

  // the new switch
  console.log('open Settings ->', await clickNav('Settings'));
  await sleep(1200);
  const text = String(await evalIn('document.body.innerText'));
  check('Settings has the "Talk while I work" switch, on by default, with what it does', /Talk while I work/.test(text) && /same live mic as the Talk button/.test(text), text.slice(0, 600));
  const on = await evalIn(`(() => { const row = [...document.querySelectorAll('.set-row')].find((r) => /Talk while I work/.test(r.textContent)); const t = row && row.querySelector('[role=switch]'); return t ? t.getAttribute('aria-checked') : null; })()`);
  check('the switch is on', on === 'true', on);
  await evalIn(`(() => { const row = [...document.querySelectorAll('.set-row')].find((r) => /Talk while I work/.test(r.textContent)); row.querySelector('[role=switch]').click(); })()`);
  await sleep(600);
  const off = await evalIn(`window.eya.getSettings().then((s) => s.settings.talkWhileWorking)`);
  check('switching it off is saved', off === false, off);
  await evalIn(`(() => { const row = [...document.querySelectorAll('.set-row')].find((r) => /Talk while I work/.test(r.textContent)); row.querySelector('[role=switch]').click(); })()`);
  await sleep(600);
  check('and on again', (await evalIn(`window.eya.getSettings().then((s) => s.settings.talkWhileWorking)`)) === true);

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  console.log('app log:', logFile);
} catch (e) {
  failures++;
  console.log('ERROR', e instanceof Error ? e.stack : e);
} finally {
  stopApp();
  site.server.close();
  process.exit(failures === 0 ? 0 : 1);
}
