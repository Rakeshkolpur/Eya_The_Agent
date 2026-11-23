// Run from the project folder:  node tests/live/ollama-e2e.mjs
// Needs Ollama running with llama3.2:1b installed (ollama pull llama3.2:1b). The real app, the real Ollama, and a pretend Google for the
// cloud side (so it can be seen when the cloud is, and is not, asked). Takes a few minutes: the app is started three times and a 1B model
// on a laptop CPU is slow.  E2E_MODE=preview tests the built app.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, createWriteStream, writeFileSync, existsSync, readFileSync } from 'node:fs';
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
const MAIN_KEY = 'AIzaSyMAINMAINMAINMAINMAINMAINMAIN123';

// A pretend Google: always answers "cloud answer", and counts how often it was asked.
let cloudCalls = 0;
const google = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[]}'); return; }
    // (only questions to the cloud AI are counted: Eya's cloud voice asks the same server to speak)
    if (!/tts/i.test(req.url ?? '') && !raw.includes('"AUDIO"')) cloudCalls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'cloud answer' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 5 } }));
  });
});
await new Promise((r) => google.listen(0, '127.0.0.1', r));
const googleUrl = `http://127.0.0.1:${google.address().port}/v1beta`;

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 1;
  const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((resolve) => { const n = id++; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  const evalIn = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 240000 });
    if (r.result?.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  return { send, evalIn };
}

/** Starts the app with these settings, runs the scenario, and stops it. */
async function withApp(name, extraEnv, scenario) {
  const userData = mkdtempSync(join(tmpdir(), 'eya-ol-'));
  const log = createWriteStream(join(OUT, `ollama-${name}-${Date.now()}.log`));
  const env = { ...process.env, EYA_GEMINI_API_KEY: MAIN_KEY, EYA_GEMINI_BASE_URL: googleUrl, EYA_BRIDGE_PORT: '47835', EYA_NO_MIC: '1', EYA_NO_BROWSER_LAUNCH: '1', EYA_LOG_LEVEL: 'debug', ...extraEnv };
  delete env.EYA_BACKUP_AI_KEY;
  const app = spawn('cmd.exe', ['/c', 'npx', 'electron-vite', process.env.E2E_MODE === 'preview' ? 'preview' : 'dev', '--', `--remote-debugging-port=${CDP}`, `--user-data-dir=${userData}`], { cwd: PROJECT, env });
  app.stdout.pipe(log);
  app.stderr.pipe(log);
  const stop = () => { try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };
  process.on('exit', stop);
  try {
    let main = null;
    for (let i = 0; i < 120 && main === null; i++) {
      try {
        const targets = await fetch(`http://127.0.0.1:${CDP}/json`).then((r) => r.json());
        for (const t of targets.filter((x) => x.type === 'page')) {
          const c = await attach(t.webSocketDebuggerUrl);
          if (await c.evalIn('typeof window.eya !== "undefined" && typeof window.eya.getLocalAi === "function"').catch(() => false)) { main = c; break; }
        }
      } catch { /* not up yet */ }
      if (main === null) await sleep(2000);
    }
    if (main === null) throw new Error('the window never appeared');
    await sleep(8000);
    await main.evalIn('window.eya.setWindowMode("app")');
    await main.send('Page.bringToFront');
    await sleep(2500);
    const ctx = {
      ...main,
      appLog: () => { try { return readFileSync(log.path, 'utf8'); } catch { return ''; } },
      ensureApp: async () => {
        for (let i = 0; i < 10; i++) {
          if (await main.evalIn("!!document.querySelector('.appwin')").catch(() => false)) return;
          await main.evalIn('window.eya.setWindowMode("app")').catch(() => undefined);
          await main.send('Page.bringToFront');
          await sleep(1500);
        }
      },
      shot: async (file) => { const r = await main.send('Page.captureScreenshot', { format: 'png' }); if (r.result?.data) writeFileSync(join(OUT, file), Buffer.from(r.result.data, 'base64')); },
    };
    await scenario(ctx);
  } catch (e) {
    failures++;
    console.log(`FAIL  harness error (${name}): ` + (e instanceof Error ? e.stack ?? e.message : String(e)));
  } finally {
    stop();
    await sleep(2500);
    try { rmSync(userData, { recursive: true, force: true }); } catch { /* in use */ }
  }
}

const ask = (c, text, id) => c.evalIn(`window.eya.submit({ text: ${JSON.stringify(text)}, source: 'text', requestId: ${JSON.stringify(id)} }).then((r) => r.spoken)`);

// ======================================================================= A. the real Ollama
await withApp('real', { EYA_OLLAMA_MODEL: '', EYA_OLLAMA_URL: 'http://127.0.0.1:11434' }, async (c) => {
  const status = await c.evalIn('window.eya.getLocalAi()');
  check('Ollama is connected and has llama3.2:1b', status.state === 'connected' && status.model === 'llama3.2:1b' && status.models.includes('llama3.2:1b'), status);
  const settings0 = await c.evalIn('window.eya.getSettings()');
  check('the default model is llama3.2:1b', settings0.settings.localModel === 'llama3.2:1b');

  // choose "Local AI only" in the real Settings page
  await c.ensureApp();
  await c.evalIn(`[...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === 'Settings').click()`);
  await sleep(800);
  await c.evalIn(`[...document.querySelectorAll('.settings-nav-item')].find((b) => /Local AI/.test(b.textContent)).click()`);
  await sleep(1500);
  const page = await c.evalIn('document.body.innerText');
  check('Settings has a Local AI (Ollama) page that says Connected and shows the model', /Local AI \(Ollama\)/.test(page) && /Connected/.test(page) && /llama3\.2:1b/.test(page), page.slice(0, 700));
  await c.shot('ollama-settings.png');
  await c.evalIn(`(() => { const s = document.querySelector('select[aria-label="How Eya uses the local AI"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'local-only'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(1500);
  check('choosing "Local AI only" there is saved', (await c.evalIn('window.eya.getSettings()')).settings.aiFirst === 'local-only');
  const route = await c.evalIn('window.eya.getAiRoute()');
  check('the AI badge now says Local AI answers', route.using?.role === 'ollama' && route.prefer === 'local-only' && route.local.ready === true, route);

  // an ordinary chat question, on this PC only, shown as it is written, with the page staying responsive
  await c.evalIn(`window.__updates = []; window.__beat = []; window.eya.onAgentUpdate((u) => window.__updates.push({ at: performance.now(), partial: u.partial ?? null, state: u.state })); setInterval(() => window.__beat.push(performance.now()), 50); 0`);
  await c.evalIn(`[...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === 'Chat').click()`);
  await sleep(600);
  const t0 = Date.now();
  const asked = ask(c, 'In two or three short sentences, what is the capital of France and what is it known for?', 'ol-1');
  let sawBubble = false;
  let sawTyping = false;
  for (let i = 0; i < 400; i++) {
    const s = await c.evalIn(`({ bubble: !!document.querySelector('.msg-bubble.streaming'), typing: !!document.querySelector('.msg-bubble.typing') })`);
    sawBubble = sawBubble || s.bubble;
    sawTyping = sawTyping || s.typing;
    if (await Promise.race([asked.then(() => true), sleep(150).then(() => false)])) break;
  }
  const answer = await asked;
  const took = Date.now() - t0;
  console.log(`      (answer in ${took} ms: ${JSON.stringify(answer)})`);
  check('a real answer from llama3.2:1b on this PC', /paris/i.test(answer), answer);
  check('the cloud AI was not asked (nothing left this PC)', cloudCalls === 0, cloudCalls);
  const updates = await c.evalIn('window.__updates');
  const partials = updates.filter((u) => u.partial !== null);
  check('the answer was shown as it was written (several growing pieces, before it was finished)', partials.length >= 3 && partials[partials.length - 1].partial.length > partials[0].partial.length, partials.length);
  check('the loading indicator showed while waiting, and the written text showed in the conversation as it grew', sawTyping || sawBubble, { sawTyping, sawBubble });
  const gaps = await c.evalIn(`(() => { const b = window.__beat; let max = 0; for (let i = 1; i < b.length; i++) max = Math.max(max, b[i] - b[i - 1]); return Math.round(max); })()`);
  console.log(`      (longest pause of the page while the model worked: ${gaps} ms)`);
  check('the page stayed responsive while the model worked (no pause longer than a second)', gaps < 1000, gaps);
  const ps = execFileSync('ollama', ['ps'], { encoding: 'utf8' });
  check('the model stays loaded in Ollama (keep-alive) with a small context', /llama3\.2:1b/.test(ps) && /2048/.test(ps), ps);

  // the conversation is remembered: a follow-up that only makes sense with the earlier line
  const first = await ask(c, 'My name is Rakesh. Please just say hello to me.', 'ol-2');
  const second = await ask(c, 'What is my name?', 'ol-3');
  console.log(`      (follow-up: ${JSON.stringify(second)})`);
  check('a follow-up is understood from the conversation so far', /rakesh/i.test(second), { first, second });
  await c.shot('ollama-chat.png');

  // everyday commands never need a model
  const before = (c.appLog().match(/local answer/g) ?? []).length;
  const opened = await ask(c, 'open example.com', 'ol-4');
  await sleep(500);
  check('an everyday command (open a site) is done by Eya herself, without asking any AI', (c.appLog().match(/local answer/g) ?? []).length === before && cloudCalls === 0 && opened !== '', { opened, cloudCalls });
  const today = await ask(c, 'What is today\'s date? Answer with the date only.', 'ol-4b');
  console.log(`      (date: ${JSON.stringify(today)})`);
  check('the local AI knows the date and time (it is in its short instruction)', /2026|october|oct|22/i.test(today), today);

  // a harmful request is not carried out
  const dir = mkdtempSync(join(tmpdir(), 'eya-del-'));
  const victim = join(dir, 'important.txt');
  writeFileSync(victim, 'keep me');
  const del = await ask(c, `delete the file ${victim}`, 'ol-5');
  await sleep(1000);
  check('"delete a file" is not done by the small model (no delete ability; if anything is asked, it is a question first)', existsSync(victim), del);
  rmSync(dir, { recursive: true, force: true });

  // hard request while "only": answered here, still no cloud
  const hard = await ask(c, 'Research the history of the Indian constitution and summarize it.', 'ol-6');
  check('with "Local AI only", even a hard request stays on this PC', cloudCalls === 0 && hard !== '', { cloudCalls, hard });

  // local first: the hard request goes to the cloud AI, the ordinary one stays here
  await c.evalIn(`window.eya.setSettings({ aiFirst: 'local' })`);
  await sleep(800);
  const calls1 = cloudCalls;
  const hard2 = await ask(c, 'Research the history of the Indian constitution and summarize it.', 'ol-7');
  check('with "Local AI first", a hard request is handed to the cloud AI', /cloud answer/.test(hard2) && cloudCalls === calls1 + 1, { hard2, cloudCalls });
  const easy = await ask(c, 'In one short sentence, what colour is the sky on a clear day?', 'ol-8');
  check('with "Local AI first", an ordinary question is still answered here', /blue/i.test(easy) && cloudCalls === calls1 + 1, { easy, cloudCalls });

  // automatic: the cloud AI as before
  await c.evalIn(`window.eya.setSettings({ aiFirst: 'auto' })`);
  await sleep(800);
  const calls2 = cloudCalls;
  const viaCloud = await ask(c, 'Say hello in one word.', 'ol-9');
  check('on Automatic the existing cloud AI answers as before', /cloud answer/.test(viaCloud) && cloudCalls === calls2 + 1, { viaCloud, cloudCalls });
});

// ======================================================================= B. Ollama not running
await withApp('down', { EYA_OLLAMA_MODEL: '', EYA_OLLAMA_URL: 'http://127.0.0.1:1' }, async (c) => {
  const status = await c.evalIn('window.eya.getLocalAi()');
  check('with Ollama not running, the status says so and how to start it', status.state === 'not-running' && /ollama serve|Ollama app/.test(status.fix ?? ''), status);
  await c.evalIn(`window.eya.setSettings({ aiFirst: 'local-only' })`);
  await sleep(800);
  const calls = cloudCalls;
  const said = await ask(c, 'hello, how are you?', 'dn-1');
  check('"Local AI only" with Ollama stopped: a useful message, not silence, and no cloud AI', /not running/.test(said) && /ollama serve|Ollama app/.test(said) && cloudCalls === calls, said);
  await c.ensureApp();
  await c.evalIn(`[...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === 'Settings').click()`);
  await sleep(800);
  await c.evalIn(`[...document.querySelectorAll('.settings-nav-item')].find((b) => /Local AI/.test(b.textContent)).click()`);
  await sleep(1500);
  const page = await c.evalIn('document.body.innerText');
  check('the Local AI page shows "Not running" with the command to fix it', /Not running/.test(page) && /ollama serve|Ollama app/.test(page), page.slice(0, 600));
  await c.shot('ollama-down.png');
  await c.evalIn(`window.eya.setSettings({ aiFirst: 'local' })`);
  await sleep(800);
  const route = await c.evalIn('window.eya.getAiRoute()');
  const viaCloud = await ask(c, 'Say hello in one word.', 'dn-2');
  check('"Local AI first" with Ollama stopped: the cloud AI answers instead, and the person is told why', /cloud answer/.test(viaCloud) && route.using?.role === 'gemini', { viaCloud, route: route.using });
});

// ======================================================================= C. model missing, and a model that never answers
await withApp('missing', { EYA_OLLAMA_MODEL: 'definitely-not-installed:1b' }, async (c) => {
  const status = await c.evalIn('window.eya.getLocalAi()');
  check('a model that is not installed is named, with the command to get it', status.state === 'model-missing' && status.fix === 'Run: ollama pull definitely-not-installed:1b', status);
  await c.evalIn(`window.eya.setSettings({ aiFirst: 'local-only' })`);
  await sleep(800);
  const said = await ask(c, 'hello, how are you?', 'ms-1');
  check('asking anyway gives the same plain message', /definitely-not-installed:1b is not installed/.test(said) && /ollama pull/.test(said), said);
});

// a pretend Ollama that accepts the question and never answers
const mute = createServer((req, res) => { req.resume(); if (req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[{"name":"llama3.2:1b"}]}'); } });
await new Promise((r) => mute.listen(0, '127.0.0.1', r));
await withApp('timeout', { EYA_OLLAMA_MODEL: '', EYA_OLLAMA_URL: `http://127.0.0.1:${mute.address().port}`, EYA_OLLAMA_FIRST_WORD_MS: '4000' }, async (c) => {
  await c.evalIn(`window.eya.setSettings({ aiFirst: 'local-only' })`);
  await sleep(800);
  const t0 = Date.now();
  const said = await ask(c, 'hello, how are you?', 'to-1');
  check('a model that never answers is given up on, with a plain message, and the app is not stuck', /did not start answering/.test(said) && Date.now() - t0 < 30_000, { said, ms: Date.now() - t0 });
  check('and the window still answers afterwards', (await c.evalIn('window.eya.getLocalAi()')).state === 'connected');
});
mute.closeAllConnections?.();
mute.close();
google.close();
console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
