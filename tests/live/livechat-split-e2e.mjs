// Run from the project folder, after "npx electron-vite build":   E2E_MODE=preview node tests/live/livechat-split-e2e.mjs      (add VIA=voice to say it the way the live voice does; SECOND=0 to skip the second start)
// (23 Nov 2026) The person types "do live chat with <name>" with Eya Browser connected: Eya Browser must open beside Eya by itself (chat on the left, browser on the right). Real app; the real public WhatsApp Web page loads in Eya Browser (QR screen, nothing is signed in, no message is sent).
// NOT covered: a signed-in WhatsApp, a real second person, the microphone.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT = process.cwd().split('\\').join('/');
const SP = join(tmpdir(), 'eya-e2e-out');
mkdirSync(SP, { recursive: true });
const CDP = 9341;
let failures = 0;
const check = (name, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra ?? '').slice(0, 900)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


const userData = mkdtempSync(join(tmpdir(), 'eya-typed-'));
const logFile = join(SP, `typed-app-${Date.now()}.log`);
const log = createWriteStream(logFile);
const env = {
  ...process.env,
  EYA_GEMINI_API_KEY: 'AIzaSyBPBPBPBPBPBPBPBPBPBPBPBPBPBPBPBP1',
  EYA_OLLAMA_URL: 'http://127.0.0.1:1',
  EYA_BRIDGE_PORT: '47842',
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
  const panel = () => evalIn(`window.eya.getBrowserPanel().then((p) => ({ status: p.status, where: p.where, goal: p.goal, current: p.current }))`);
  const live = () => evalIn(`window.eya.liveChatAction({ kind: 'status' }).then((r) => r && r.view ? { state: r.view.state, chat: r.view.chat } : r).catch((e) => String(e))`);

  // the person's chats switch is on (Settings > Chats), WhatsApp allowed, and the browser is Eya Browser
  console.log('chats on ->', JSON.stringify(await evalIn('window.eya.setCommunicationAccess({ enabled: true }).then((s) => s.enabled)')));
  console.log('whatsapp allowed ->', JSON.stringify(await evalIn('window.eya.setCommunicationAccess({ app: { id: "whatsapp", allowed: true } }).then((s) => s.enabled)')));
  console.log('enable live chat ->', JSON.stringify(await evalIn('window.eya.liveChatAction({ kind: "enable_live" }).then((r) => r && r.message)')));
  console.log('browser pref ->', JSON.stringify(await evalIn('window.eya.getSettings().then((s) => s.settings.browser)')));
  await clickNav('Home');
  await sleep(1000);
  // the Agent button: on (a task is carried out, not only chatted about)
  await evalIn(`(() => { const b = document.querySelector('button[aria-label="Agent mode"]'); if (b && !/on/.test(b.className)) b.click(); })()`);
  await sleep(400);
  check('before the request nothing is beside Eya', (await workspace()) === false);

  const said = process.env.SAID ?? 'do live chat with Meera';
  // VIA=voice: what the live VOICE does with what the person says — the real preload -> IPC -> live bridge, tool "quick_command" with the heard words (no audio, no model).
  const VOICE = process.env.VIA === 'voice';
  const speak = async (text) => String(await evalIn('window.eya.runLiveTool(' + JSON.stringify({ name: 'quick_command', args: {}, heard: text, turn: 1 }) + ').then((r) => r.content)')).slice(0, 200);
  const say = async (text) => (VOICE ? 'spoken -> ' + (await speak(text)) : (await setComposer(text)) + ' ' + (await sendComposer()));
  console.log(VOICE ? 'SAY (voice) ->' : 'type ->', said, await say(said));
  // (the ONE question about who she is to the person comes first; the answer is what starts the live chat)
  if (!VOICE) for (let i = 0; i < 40; i++) { if (/Who is .* to you?/.test(String(await evalIn('document.body.innerText')))) break; await sleep(500); }
  const answer = process.env.ANSWER ?? 'friend';
  if (answer !== 'none') console.log('answer ->', answer, await say(answer));
  let opened = false;
  let last = '';
  for (let i = 0; i < 120; i++) {
    const p = await panel();
    const w = await workspace();
    const line = JSON.stringify({ t: i * 0.5, panel: p, workspace: w });
    if (line.replace(/"t":[0-9.]+,/, '') !== last.replace(/"t":[0-9.]+,/, '')) console.log(line);
    last = line;
    if (w) { opened = true; break; }
    await sleep(500);
  }
  console.log('live chat ->', JSON.stringify(await live()));
  console.log('panel log ->', JSON.stringify(await evalIn('window.eya.getBrowserPanel().then((p) => p.log.map((l) => l.kind + ": " + l.text))')));
  console.log('page text (end) ->', String(await evalIn('document.body.innerText')).slice(-700).split('\n').join(' | '));
  check('"do live chat" with Eya Browser connected opens the browser beside Eya (chat left, browser right)', opened, await panel());
  if (opened) {
    const geo = await evalIn(`(() => { const l = document.querySelector('.workspace .ws-left'); const v = document.querySelector('.workspace .ws-view'); if (!l || !v) return null; const a = l.getBoundingClientRect(); const b = v.getBoundingClientRect(); return { left: { x: Math.round(a.x), w: Math.round(a.width) }, right: { x: Math.round(b.x), w: Math.round(b.width) } }; })()`);
    console.log('geometry ->', JSON.stringify(geo));
    check('Eya (chat) is on the left and the browser on the right', geo !== null && geo.left.x < geo.right.x && geo.right.w > 200, geo);
  }
  // SECOND start while WhatsApp is already open in Eya Browser (the person stops the live chat, goes Home and says it again)
  if (opened && process.env.SECOND !== '0') {
    console.log('stop live chat ->', JSON.stringify(await evalIn('window.eya.liveChatAction({ kind: "stop" }).then((r) => r && r.message)')));
    // (the live chat is really over before it is asked for again)
    for (let i = 0; i < 40; i++) { const st = await live(); if (st && (st.state === 'STOPPED' || st.state === 'IDLE')) break; await sleep(500); }
    console.log('live chat after stop ->', JSON.stringify(await live()));
    await clickNav('Home');
    for (let i = 0; i < 80; i++) { const p = await panel(); if (['done', 'idle', 'problem'].includes(p.status)) break; await sleep(500); }
    await sleep(1500);
    console.log('panel after stop ->', JSON.stringify(await panel()), 'workspace', await workspace());
    check('back on Home, nothing is beside Eya', (await workspace()) === false);
    console.log(VOICE ? 'SAY again (voice) ->' : 'type again ->', said, await say(said));
    let again = false;
    let lastLine = '';
    for (let i = 0; i < 80; i++) {
      const p = await panel();
      const w = await workspace();
      const line = JSON.stringify({ panel: p, workspace: w });
      if (line !== lastLine) console.log(line);
      lastLine = line;
      if (w) { again = true; break; }
      await sleep(500);
    }
    console.log('live chat ->', JSON.stringify(await live()));
    console.log('page text (end) ->', String(await evalIn('document.body.innerText')).slice(-500).split('\n').join(' | '));
    check('saying it a SECOND time (WhatsApp already open in Eya Browser) opens the browser beside Eya again', again, await panel());
  }
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  console.log('app log:', logFile);
} catch (e) {
  failures++;
  console.log('ERROR', e instanceof Error ? e.stack : e);
} finally {
  stopApp();
  process.exit(failures === 0 ? 0 : 1);
}
