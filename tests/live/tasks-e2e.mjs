// Run from the project folder, after 'npx electron-vite build':   E2E_MODE=preview node tests/live/tasks-e2e.mjs
// The Tasks page in the REAL app (Electron): the box to start any task, a card for each task, two tasks started one after the other and both on the list, each working in a tab
// of its own in Eya Browser. The tasks here are ones the application does by itself with no AI ("open <address>"), against the local test site; "user" clicks and typing go
// through the page's own DOM over the debugging port. NOT covered: a task that asks a question, a real model, the real Flipkart / WhatsApp.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT = process.cwd().split('\\').join('/');
const SP = join(tmpdir(), 'eya-e2e-out');
mkdirSync(SP, { recursive: true });
const CDP = 9335;
let failures = 0;
const check = (name, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra ?? '').slice(0, 900)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { startTestSite } = await import(pathToFileURL(`${PROJECT}/tests/fixtures/chrome-test-site/server.mjs`).href);
const site = await startTestSite(0);
const base = `http://127.0.0.1:${site.port}`;

const userData = mkdtempSync(join(tmpdir(), 'eya-tasks-'));
const downloads = mkdtempSync(join(tmpdir(), 'eya-tasks-dl-'));
const logFile = join(SP, `tasks-app-${Date.now()}.log`);
const log = createWriteStream(logFile);
const env = {
  ...process.env,
  EYA_GEMINI_API_KEY: 'AIzaSyBPBPBPBPBPBPBPBPBPBPBPBPBPBPBPBP1',
  EYA_OLLAMA_URL: 'http://127.0.0.1:1',
  EYA_BRIDGE_PORT: '47837',
  EYA_BROWSER_DOWNLOADS: downloads,
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
        if (await c.evalIn('typeof window.eya !== "undefined" && typeof window.eya.getTaskBoard === "function"').catch(() => false)) return c;
        c.close();
      }
    } catch { /* not up yet */ }
    await sleep(2000);
  }
  throw new Error('the app window never appeared');
}

const pages = async () => (await fetch(`http://127.0.0.1:${CDP}/json`).then((r) => r.json())).filter((x) => x.type === 'page' && x.url.startsWith(base));

try {
  const main = await connectMain();
  const evalIn = main.evalIn;
  await sleep(6000);
  await evalIn('window.eya.setWindowMode("app")');
  await main.send('Page.bringToFront');
  await sleep(2500);
  const clickNav = (label) => evalIn(`(() => { const b = [...document.querySelectorAll('.nav-item')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) return 'no nav ' + ${JSON.stringify(label)}; b.click(); return 'clicked'; })()`);
  const setBox = (value) => evalIn(`(() => { const el = document.getElementById('tb-new-text'); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return 'set'; })()`);
  const clickText = (label) => evalIn(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && !x.disabled); if (!b) return 'no button ' + ${JSON.stringify(label)}; b.click(); return 'clicked'; })()`);
  const cards = () => evalIn(`[...document.querySelectorAll('.tb-card')].map((c) => ({ kind: c.getAttribute('data-kind'), cls: c.className, title: c.querySelector('.tb-title')?.textContent ?? '', state: c.querySelector('.tb-state')?.textContent ?? '', note: c.querySelector('.tb-note')?.textContent ?? '', where: [...c.querySelectorAll('.tb-meta')].map((m) => m.textContent).join('|'), buttons: [...c.querySelectorAll('button')].map((b) => b.textContent.trim()) }))`);
  const board = () => evalIn('window.eya.getTaskBoard()');

  console.log('open the Tasks page ->', await clickNav('Tasks'));
  await sleep(1200);
  let text = String(await evalIn('document.body.innerText'));
  check('the Tasks page has the box to start any task, the examples, and says nothing is running', /What should Eya do\?/.test(text) && /Start task/.test(text) && /Live chat with Anna on WhatsApp/.test(text) && /Nothing is running/.test(text), text.slice(0, 600));
  check('Start task is switched off while the box is empty', (await evalIn(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Start task')?.disabled`)) === true);

  // an example fills the box
  await clickText('Order a pair of running shoes on Flipkart');
  await sleep(200);
  check('tapping an example fills the box', (await evalIn(`document.getElementById('tb-new-text').value`)) === 'Order a pair of running shoes on Flipkart');
  await setBox('');

  // two tasks, one after the other. ("open <address> and tell me the title": the application opens the page itself, in the task's own place, and then needs the AI for the rest —
  // there is none here (a made-up key), so the tasks stay open: that is what the cards of open tasks are checked on.)
  await setBox(`open ${base}/phones.html and tell me the page title`);
  console.log('start task 1 ->', await clickText('Start task'));
  await sleep(300);
  console.log('   window after Start:', JSON.stringify(await evalIn('({ mode: document.documentElement.getAttribute("data-mode") ?? document.body.className, h1: document.querySelector("h1")?.textContent ?? "", text: document.body.innerText.slice(0, 160) })').catch((e) => String(e).slice(0, 80))));
  check('the box is empty again after Start', (await evalIn(`document.getElementById('tb-new-text').value`)) === '');
  await setBox(`open ${base}/causelist.html and tell me the page title`);
  console.log('start task 2 ->', await clickText('Start task'));

  let rows = [];
  for (let i = 0; i < 60; i++) {
    rows = (await board()).rows;
    if (rows.length === 2 && rows.every((r) => r.where === 'eya')) break;
    await sleep(1000);
  }
  const ui = await cards();
  check('both tasks are on the board at once, each as its own card', rows.length === 2 && ui.length === 2, { rows: rows.map((r) => [r.title, r.state, r.where, r.note]), ui });
  check('each works in Eya Browser (the board knows where)', rows.length === 2 && rows.every((r) => r.where === 'eya'), rows.map((r) => [r.title, r.state, r.where, r.note]));
  const pgs = await pages();
  const urls = pgs.map((p) => p.url);
  check('the two pages are open AT THE SAME TIME, in two tabs of Eya Browser', pgs.length === 2 && urls.some((u) => u.includes('/phones.html')) && urls.some((u) => u.includes('/causelist.html')), urls);
  // (the cards are drawn from pushes of the board: give the page a moment)
  for (let i = 0; i < 20 && (await cards()).some((c) => c.where === ''); i++) await sleep(250);
  const ui2 = await cards();
  check('the cards say where each works (its own tab of Eya Browser), as soon as the task has its page', ui2.length === 2 && ui2.every((c) => /own tab of Eya Browser/.test(c.where)), ui2.map((c) => c.where));
  check('every card offers Show its browser, and each task still going also offers Stop', ui2.length === 2 && ui2.every((c) => c.buttons.includes('Show its browser') && (!/Working on it|Waiting|Needs you|Paused/.test(c.state) || c.buttons.includes('Stop'))), ui2.map((c) => [c.state, c.buttons]));
  text = String(await evalIn('document.body.innerText'));
  check('the board has its headings: the box, the running list or the finished list, and the History under them', /What should Eya do\?/.test(text) && (/Running now/.test(text) && /History/.test(text)), text.slice(0, 700));
  console.log('   (how the two ended, with no AI behind them:', JSON.stringify((await board()).rows.map((r) => [r.state, r.note.slice(0, 50)])) + ')');

  // Show its browser takes the person to that task's tab (a request the person made: it always goes)
  console.log('show browser ->', await clickText('Show its browser'));
  await sleep(1800);
  check('"Show its browser" opens the Browser page', (await evalIn(`!!document.querySelector('.workspace') || !!document.querySelector('.bp-surface')`)) === true, await evalIn('document.body.innerText.slice(0, 300)'));
  await clickNav('Tasks');
  await sleep(800);

  // Stop ends that task only. (A third task is started for it, so there is something still going: the other two may already have ended for want of an AI.)
  await setBox(`open ${base}/forms.html and tell me the page title`);
  console.log('start task 3 ->', await clickText('Start task'));
  let third = null;
  for (let i = 0; i < 40; i++) {
    third = (await board()).rows.find((r) => r.title.includes('forms.html'));
    if (third !== undefined && third.where === 'eya') break;
    await sleep(500);
  }
  check('a third task is on the board with a tab of its own: three pages open in Eya Browser at the same time', third !== undefined && third.where === 'eya' && (await pages()).length === 3, { third, pages: (await pages()).map((p) => p.url) });
  const before = (await board()).rows;
  const openBefore = before.filter((r) => r.state === 'running' || r.state === 'waiting' || r.state === 'needs_you');
  if (openBefore.length > 0) {
    const target = openBefore[0];
    console.log('stop one ->', await evalIn(`(() => { const c = [...document.querySelectorAll('.tb-card')].find((x) => x.querySelector('.tb-title')?.textContent === ${JSON.stringify(target.title)}); const b = c && [...c.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Stop'); if (!b) return 'no Stop on that card'; b.click(); return 'clicked'; })()`));
    await sleep(1500);
    const after = (await board()).rows;
    check('Stop stopped ONLY the task on that card; every other task kept the state it had', after.find((r) => r.id === target.id)?.state === 'cancelled' && before.filter((r) => r.id !== target.id).every((r) => after.find((x) => x.id === r.id)?.state === r.state), { before: before.map((r) => [r.title.slice(-20), r.state]), after: after.map((r) => [r.title.slice(-20), r.state]) });
    check('the stopped task has Try again on its card', (await cards()).some((c) => c.title === target.title && c.buttons.includes('Try again')), await cards());
  } else {
    console.log('   (nothing was still going to stop: all three had ended without an AI; the Stop rule is covered by the unit tests)');
  }
  // Stop all, then clearing the finished ones
  await evalIn('window.eya.actOnTaskBoard({ kind: "stop_all" })');
  await sleep(1200);
  rows = (await board()).rows;
  check('Stop all leaves nothing running', rows.every((r) => r.state !== 'running' && r.state !== 'waiting' && r.state !== 'needs_you'), rows.map((r) => [r.title.slice(-20), r.state]));
  console.log('clear ->', await clickText('Clear'));
  await sleep(800);
  check('Clear removes the finished tasks from the board', (await board()).rows.length === 0 && (await cards()).length === 0, await board());

  // text that is too long is not started (the box holds at most 600 characters)
  check('the box holds at most 600 characters', (await evalIn(`document.getElementById('tb-new-text').maxLength`)) === 600);

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
