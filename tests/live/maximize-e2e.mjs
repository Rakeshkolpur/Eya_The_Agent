// Run from the project folder:  node tests/live/maximize-e2e.mjs      (E2E_MODE=preview to run the built app)
// The real app window: minimize, maximize and close are in the top right; Maximize fills the screen's work area (everything but the taskbar),
// Restore goes back, the choice is kept when Eya is put away as a bubble and brought back, and something asking for the app does not shrink it.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, createWriteStream, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT = process.cwd().split('\\').join('/');
const OUT = join(tmpdir(), 'eya-e2e-out');
mkdirSync(OUT, { recursive: true });
const CDP = 9333;
let failures = 0;
const check = (name, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra ?? '').slice(0, 700)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userData = mkdtempSync(join(tmpdir(), 'eya-max-'));
const log = createWriteStream(join(OUT, `max-app-${Date.now()}.log`));
const env = { ...process.env, EYA_OLLAMA_URL: 'http://127.0.0.1:1', EYA_BRIDGE_PORT: '47835', EYA_NO_MIC: '1', EYA_NO_BROWSER_LAUNCH: '1' };
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
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 60000 });
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
        if (await c.evalIn('typeof window.eya !== "undefined" && typeof window.eya.toggleMaximize === "function"').catch(() => false)) return c;
      }
    } catch { /* not up yet */ }
    await sleep(2000);
  }
  throw new Error('the window never appeared');
}

try {
  const main = await connectMain();
  const evalIn = main.evalIn;
  await sleep(7000);
  const toApp = async () => {
    await evalIn('window.eya.setWindowMode("app")');
    await main.send('Page.bringToFront');
    for (let i = 0; i < 20; i++) {
      if (await evalIn("!!document.querySelector('.appwin')").catch(() => false)) break;
      await sleep(300);
    }
    await sleep(600);
  };
  const size = () => evalIn(`({ w: window.outerWidth, h: window.outerHeight, x: window.screenX, y: window.screenY, aw: screen.availWidth, ah: screen.availHeight, ax: screen.availLeft ?? 0, ay: screen.availTop ?? 0 })`);
  const shot = async (name) => { const r = await main.send('Page.captureScreenshot', { format: 'png' }); if (r.result?.data) writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64')); };

  await toApp();
  const labels = await evalIn(`[...document.querySelectorAll('.topbar > button')].map((b) => b.getAttribute('aria-label'))`);
  const tail = labels.slice(-3);
  check('the top right has Minimize, Maximize and Close, in that order', JSON.stringify(tail) === JSON.stringify(['Minimize to the bubble', 'Maximize', 'Close']), labels);
  const s0 = await size();
  check('the app opens as a window with room around it (not filling the screen)', s0.w < s0.aw && s0.h < s0.ah, s0);
  await shot('max-0-normal.png');

  await evalIn(`document.querySelector('.topbar [aria-label="Maximize"]').click()`);
  await sleep(700);
  const s1 = await size();
  check('Maximize fills the whole work area of the screen', s1.w === s1.aw && s1.h === s1.ah && s1.x === s1.ax && s1.y === s1.ay, s1);
  check('the button now says Restore down, and the app knows it is maximized', (await evalIn(`!!document.querySelector('.topbar [aria-label="Restore down"]')`)) === true && (await evalIn('window.eya.getWindowMode().then((m) => m.maximized)')) === true);
  const fill = await evalIn(`(() => { const el = document.querySelector('.appwin'); const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); const app = document.querySelector('.app'); const ar = app.getBoundingClientRect(); return { w: r.width, h: r.height, x: r.x, y: r.y, iw: window.innerWidth, ih: window.innerHeight, appW: ar.width, appH: ar.height, margin: cs.margin, border: cs.border, radius: cs.borderRadius }; })()`);
  check('the page fills the window (no gap at the sides or below)', Math.abs(fill.w - fill.iw) <= 1 && Math.abs(fill.h - fill.ih) <= 1, fill);
  await shot('max-1-maximized.png');

  // putting Eya away as a bubble and bringing the app back: it comes back maximized
  await evalIn(`document.querySelector('.topbar [aria-label="Minimize to the bubble"]').click()`);
  await sleep(700);
  const bubble = await size();
  check('Minimize still puts Eya away as the small bubble', bubble.w < 200 && bubble.h < 200, bubble);
  await toApp();
  const s2 = await size();
  check('and when the app comes back it is maximized, as it was left', s2.w === s2.aw && s2.h === s2.ah, s2);
  // something asking for the app while it is open (a task, the tray) does not shrink it
  await evalIn('window.eya.setWindowMode("app")');
  await sleep(600);
  const s3 = await size();
  check('something asking for the app while it fills the screen does not shrink it', s3.w === s3.aw && s3.h === s3.ah, s3);

  await evalIn(`document.querySelector('.topbar [aria-label="Restore down"]').click()`);
  await sleep(700);
  const s4 = await size();
  check('Restore down gives back the window it was, in the same place', Math.abs(s4.w - s0.w) <= 2 && Math.abs(s4.h - s0.h) <= 2 && Math.abs(s4.x - s0.x) <= 2 && Math.abs(s4.y - s0.y) <= 2, { s0, s4 });
  check('and the button says Maximize again', (await evalIn(`!!document.querySelector('.topbar [aria-label="Maximize"]')`)) === true && (await evalIn('window.eya.getWindowMode().then((m) => m.maximized)')) === false);
  await shot('max-2-restored.png');

  // the conversation and its panels follow the new size
  await evalIn(`document.querySelector('.topbar [aria-label="Maximize"]').click()`);
  await sleep(700);
  check('maximized again, the conversation still has its composer and the sidebar its chat list', (await evalIn(`!!document.querySelector('.cw .composer textarea') && !!document.querySelector('.sidebar .chat-history')`)) === true);
  await evalIn(`document.querySelector('.topbar [aria-label="Restore down"]').click()`);
  await sleep(500);
} catch (e) {
  failures++;
  console.log('FAIL  the run stopped:', e && e.message ? e.message : e);
} finally {
  stopApp();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  console.log('screenshots and the app log are in', OUT);
  process.exit(failures === 0 ? 0 : 1);
}
