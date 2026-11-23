// Run from the project folder:  node tests/live/agent-mode-e2e.mjs      (E2E_MODE=preview to run the built app)
// The real app, with a fake Google and a small local internet (*.localhost names): "Hi" in chat stays a conversation (even when the AI is slow),
// an everyday command typed in chat is pointed to Agent mode, and with Agent on a real task runs in Eya's real browser: the panel and the browser
// beside the chat open only then. A refusal made from a site's name alone, before anything was looked at, is sent back to look first.
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

// ------------------------------------------------------------------------------------------------------ the local internet
let port = 0;
const html = (res, title, body) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);
};
const site = createServer((req, res) => {
  const host = String(req.headers.host ?? '').split(':')[0];
  if (host === 'reports-example.localhost') return html(res, 'Reports Example — Official Site', '<h1>Reports Example</h1><p>Welcome to the official website of Reports Example, where every public report is kept.</p><a href="/annual">Annual Report 2024</a> <a href="/about">About us</a>');
  if (host === 'movierulz.localhost') return html(res, 'Movie Downloads', '<h1>Movie Downloads</h1><p>New releases and the latest movies in HD, plenty of text here for the page.</p><a href="/m">Latest releases</a>');
  return html(res, 'Not Found', '<h1>404</h1>');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
port = site.address().port;
const at = (h) => `http://${h}.localhost:${port}/`;

// ------------------------------------------------------------------------------------------------------------ a fake Google
const MAIN = 'AIzaSyMAINMAINMAINMAINMAINMAINMAIN123';
const requests = []; // every chat request: { system, tools, texts, calls }
let chatDelay = 0;
let googleDown = false;
const google = createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [] })); return; }
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const reply = (parts, wait = 0) => setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 8, totalTokenCount: 128 } })); }, wait);
    let body = {};
    try { body = JSON.parse(raw); } catch { /* not JSON */ }
    if (googleDown) { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota, per day.', status: 'RESOURCE_EXHAUSTED' } })); return; }
    if (raw.includes('"AUDIO"')) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 400, message: 'no speech in the test' } })); return; }
    const system = body.systemInstruction?.parts?.map((p) => p.text).join('\n') ?? '';
    if (system === '') { reply([{ text: 'ok' }]); return; }
    const contents = body.contents ?? [];
    const texts = contents.flatMap((c) => (c.parts ?? []).filter((p) => typeof p.text === 'string').map((p) => ({ role: c.role, text: p.text })));
    const calls = contents.flatMap((c) => (c.parts ?? []).filter((p) => p.functionCall).map((p) => p.functionCall.name));
    const responded = contents.some((c) => (c.parts ?? []).some((p) => p.functionResponse));
    const tools = (body.tools ?? []).flatMap((x) => (x.functionDeclarations ?? []).map((d) => d.name));
    const toolAnswers = contents.flatMap((c) => (c.parts ?? []).filter((p) => p.functionResponse).map((p) => JSON.stringify(p.functionResponse)));
    requests.push({ system, tools, texts, calls, responded, toolAnswers });
    const asked = texts.filter((x) => x.role === 'user').map((x) => x.text);
    // (what the person is asking now: the last thing they said, not Eya's own reminder to look first, and not earlier turns)
    const real = asked.filter((x) => !/You answered that you cannot/.test(x));
    const lastUser = real[real.length - 1] ?? '';
    const nudged = asked.some((x) => /You answered that you cannot/.test(x));
    // ---- chat mode
    if (/plain chat mode/.test(system)) {
      reply([{ text: /^hi\b/i.test(lastUser) ? 'Hello! How can I help you today?' : 'Plain chat answer.' }], chatDelay);
      return;
    }
    // ---- agent mode
    if (/annual report from the reports site/.test(lastUser)) {
      if (!responded) return reply([{ functionCall: { name: 'find_and_open_website', args: { url: at('reports-example'), name: 'Reports Example' } } }]);
      return reply([{ text: 'Opened the reports site: the Annual Report 2024 link is on its home page.' }]);
    }
    // (a model that is simply shown the page, or the application's own account of why a site was not opened, and says what it sees)
    if (/Telugu HD Paradise/.test(lastUser)) return reply([{ text: 'I did not open MovieRulz: it gives films away without permission. I can look for where Paradise can be watched legally.' }]);
    if (/movierulz/.test(lastUser)) return reply([{ text: 'I opened it and looked. It lists new releases, but I will not start playback there. The film is on an official platform, which I can open for you.' }]);
    return reply([{ text: /^hi\b/i.test(lastUser) ? 'Hello from agent mode.' : 'Agent answer.' }]);
  });
});
await new Promise((r) => google.listen(0, '127.0.0.1', r));
const googleUrl = `http://127.0.0.1:${google.address().port}/v1beta`;

const userData = mkdtempSync(join(tmpdir(), 'eya-agm-'));
const downloads = mkdtempSync(join(tmpdir(), 'eya-agm-dl-'));
const log = createWriteStream(join(OUT, `agm-app-${Date.now()}.log`));
const env = { ...process.env, EYA_GEMINI_API_KEY: MAIN, EYA_GEMINI_BASE_URL: googleUrl, EYA_OLLAMA_URL: 'http://127.0.0.1:1', EYA_BRIDGE_PORT: '47835', EYA_BROWSER_DOWNLOADS: downloads, EYA_BROWSER_NAV_TIMEOUT_MS: '4000', EYA_NO_MIC: '1', EYA_NO_BROWSER_LAUNCH: '1' };
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
  const click = (sel) => dom(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const waitFor = async (expr, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await dom(expr).catch(() => false)) return true; await sleep(400); } return false; };
  const typeText = async (text) => { await dom(`document.querySelector('.composer textarea').focus()`); await main.send('Input.insertText', { text }); await sleep(200); };
  const sendNow = () => click('.composer .ask-go');
  const goHome = async () => { await dom(`[...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === 'Home').click()`); await sleep(700); };
  const convText = () => dom(`(document.querySelector('.conv') ?? document.body).innerText`);

  // ---------------------------------------------------------------- the screen
  check('the extra "Ask Eya anything" box at the top is gone', await dom(`!document.querySelector('.top-search') && !/Ask Eya anything/.test(document.querySelector('.topbar').innerText)`));
  check('the Agent button is beside the message box and starts off', await dom(`document.querySelector('.composer .agent-toggle')?.getAttribute('aria-checked') === 'false'`));

  // ---------------------------------------------------------------- 1. "Hi" in normal chat, with an AI that is slow over it
  chatDelay = 9500;
  await typeText('Hi');
  await sendNow();
  await sleep(9000);
  const tasksDuring = await evalIn('window.eya.getTasks()');
  const browserDuring = await evalIn('window.eya.getBrowserPanel()');
  check('1. "Hi" in normal chat, even while the AI is slow (9 s): no panel opens, no task is made, no browser is touched', (await dom(`!document.querySelector('aside.dash-side') && !document.querySelector('.workspace')`)) && tasksDuring.items.length === 0 && browserDuring.url === '' && browserDuring.status === 'idle', { tasks: tasksDuring.items.map((i) => i.request), browser: browserDuring.status });
  chatDelay = 0;
  const hiAnswered = await waitFor(`/Hello! How can I help you today\\?/.test(document.querySelector('.conv').innerText)`, 30000);
  check('   and the answer is a normal chat answer', hiAnswered === true, await convText());
  const hiTokens = await dom(`(() => { const e = [...document.querySelectorAll('.conv .msg.eya .msg-tokens')].pop(); return e ? { text: e.textContent, title: e.title } : null; })()`);
  check('   and the answer shows what the request took: 128 tokens (120 sent + 8 in the answer), over 1 AI answer', hiTokens !== null && /128 tokens/.test(hiTokens.text) && /120 tokens sent \+ 8 in the answer, over 1 AI answer$/.test(hiTokens.title), hiTokens);
  const hiRequest = requests.find((x) => x.texts.some((t) => t.text === 'Hi'));
  check('   Eya was given the chat instructions and only the two chat tools (no browser tools)', /plain chat mode/.test(hiRequest?.system ?? '') && JSON.stringify([...(hiRequest?.tools ?? [])].sort()) === JSON.stringify(['analyze_document', 'web_search']), hiRequest);
  const afterHi = await evalIn('window.eya.getTasks()');
  check('   nothing was added to "Tasks in progress"', afterHi.items.length === 0, afterHi.items);

  // ---------------------------------------------------------------- 2. a command typed in chat is pointed to Agent mode (nothing is done, nothing is asked of the AI)
  const asksBefore = requests.length;
  await typeText('order the annual report from the reports site');
  await sendNow();
  const hinted = await waitFor(`/Agent mode/.test(document.querySelector('.conv').innerText) && !!document.querySelector('.agent-suggest')`, 15000);
  const browserNow = await evalIn('window.eya.getBrowserPanel()');
  check('2. a command typed with Agent off is not done: chat says it is for Agent mode and offers the button', hinted === true && requests.length === asksBefore && browserNow.url === '' && !(await dom(`!!document.querySelector('.workspace')`)), { newRequests: requests.length - asksBefore, url: browserNow.url });
  await shot('agm-1-hint.png');

  // ---------------------------------------------------------------- 3. the button: Agent on, and the request carried out in the real browser
  await click('.agent-suggest');
  const workspaceOpened = await waitFor(`!!document.querySelector('.workspace .ws-left') && !!document.querySelector('.workspace .ws-view')`, 60000);
  check('3. "Turn on Agent and do it" switches Agent on and the task opens Eya\'s browser beside the chat', workspaceOpened === true && (await evalIn(`localStorage.getItem('eya.agentMode')`)) === 'on', { mode: await evalIn(`localStorage.getItem('eya.agentMode')`) });
  const done3 = await waitFor(`/Annual Report 2024 link is on its home page/.test(document.querySelector('.ws-left .conv')?.innerText ?? '')`, 60000);
  const panel3 = await evalIn('window.eya.getBrowserPanel()');
  check('   the real page was opened and read, and the answer is in the conversation', done3 === true && /reports-example\.localhost/.test(panel3.url) && /Reports Example/.test(panel3.title), { url: panel3.url, title: panel3.title });
  const agentRequest = requests.find((x) => x.calls.length === 0 && /annual report from the reports site/.test(x.texts.map((t) => t.text).join(' ')) && !/plain chat mode/.test(x.system));
  check('   it went to the AI as an agent task: the browser tools were offered (not the chat instructions)', (agentRequest?.tools ?? []).includes('find_and_open_website') && !/plain chat mode/.test(agentRequest?.system ?? ''), agentRequest?.tools);
  check('   "Your Agent at Work" has the steps in plain words', panel3.steps.some((s) => /The page is open/.test(s.text)) || panel3.log.some((l) => /Opening the requested website/.test(l.text)), { steps: panel3.steps.map((s) => s.text), log: panel3.log.slice(-6).map((l) => l.text) });
  const taskTokens = await dom(`(() => { const e = [...document.querySelectorAll('.ws-left .conv .msg.eya .msg-tokens, .conv .msg.eya .msg-tokens')].pop(); return e ? { text: e.textContent, title: e.title } : null; })()`);
  check('   a task that took two AI answers (open the page, then answer) shows both added up: 256 tokens over 2 AI answers', taskTokens !== null && /256 tokens/.test(taskTokens.text) && /over 2 AI answers$/.test(taskTokens.title), taskTokens);
  await shot('agm-2-agent-task.png');

  // ---------------------------------------------------------------- 4. with Agent on, "Hi" is still only a greeting
  await goHome();
  // (the panel of the task before lingers a few seconds after it ends, by design: wait for it to go, so that what is checked is this "Hi")
  await waitFor(`!document.querySelector('aside.dash-side') && !document.querySelector('.workspace')`, 20000);
  await typeText('Hi');
  await sendNow();
  let panelDuringHi = false;
  let hi2 = false;
  for (let i = 0; i < 75 && !hi2; i++) {
    if (await dom(`!!document.querySelector('aside.dash-side') || !!document.querySelector('.workspace')`)) panelDuringHi = true;
    hi2 = await dom(`/Hello from agent mode\\./.test(document.querySelector('.conv')?.innerText ?? '')`).catch(() => false);
    if (!hi2) await sleep(400);
  }
  await sleep(1500);
  const tasks4 = await evalIn('window.eya.getTasks()');
  check('4. with Agent on, "Hi" is still just answered: no panel, and not shown as a task', hi2 === true && !panelDuringHi && !(await dom(`!!document.querySelector('aside.dash-side')`)) && !tasks4.items.some((i) => i.request === 'Hi'), { items: tasks4.items.map((i) => i.request) });

  // ---------------------------------------------------------------- 5. a site that gives films away, with an exact link: the APPLICATION opens it and looks; the model is only shown it
  await click('.sidebar .new-chat');
  await sleep(500);
  const before5 = requests.length;
  await typeText(`open ${at('movierulz')} and play paradise movie hd telugu`);
  await sendNow();
  const looked = await waitFor(`/I will not start playback there/.test((document.querySelector('.ws-left .conv') ?? document.querySelector('.conv'))?.innerText ?? '')`, 90000);
  const panel5 = await evalIn('window.eya.getBrowserPanel()');
  const mine = requests.slice(before5);
  check('5. the site was found and opened by the application, in the browser, and the page was checked, before the model was asked anything', looked === true && /movierulz\.localhost/.test(panel5.url), { url: panel5.url, answer: (await convText()).slice(-300) });
  check('   the model made no tool call and was never asked to open anything: it was shown the real page, and answered from it', mine.length === 1 && mine[0].calls.length === 0 && mine[0].texts.some((x) => /Eya's own browser step ran/.test(x.text) && /Movie Downloads/.test(x.text)), { requests: mine.length, calls: mine.map((x) => x.calls) });
  check('   and it ends with what it will and will not do, plus the legal way, not a bare refusal', /official platform/.test(await convText()), (await convText()).slice(-300));
  await shot('agm-3-movie.png');

  // ---------------------------------------------------------------- 5b. the exact request, by name only: Eya's own rule (not the model, not the browser) and the lawful options, looked up by the application
  await goHome();
  await click('.sidebar .new-chat');
  await sleep(500);
  const before5b = requests.length;
  const panelBefore5b = await evalIn('window.eya.getBrowserPanel()');
  await typeText('Open MovieRulz site and play Telugu HD Paradise movie.');
  await sendNow();
  const answered5b = await waitFor(`/I did not open MovieRulz: it gives films away/.test((document.querySelector('.ws-left .conv') ?? document.querySelector('.conv'))?.innerText ?? '')`, 180000);
  const mine5b = requests.slice(before5b);
  const panel5b = await evalIn('window.eya.getBrowserPanel()');
  const told = mine5b.flatMap((x) => x.texts.map((y) => y.text)).join(' ');
  check('5b. one request to the model, with no tool call and no persuasion: the application had already done its part', answered5b === true && mine5b.length === 1 && mine5b[0].calls.length === 0 && !/You answered that you cannot/.test(told), { n: mine5b.length });
  check('    the site was NOT opened or searched for (the browser did not move)', panel5b.url === panelBefore5b.url, { before: panelBefore5b.url, after: panel5b.url });
  check('    the model was told it was Eya\'s own rule, not a browser or search error, and what the browser step did', /Eya's own rule about that site, not a browser or search error/.test(told) && /did not open MovieRulz and did not search for it/.test(told), told.slice(-700));
  check('    and the lawful options for the film were looked up by the application and handed to the model (no site name in that search)', /legal place for \\"Telugu HD Paradise movie\\"/.test(told) && /legalOptions/.test(told) && /Do not ask them what they want|nothing was confirmed/.test(told), told.slice(-900));
  await shot('agm-3b-exact.png');

  // ---------------------------------------------------------------- 5c. the AI is out (its allowance is spent): the site is opened anyway, because opening it never depended on the AI
  await goHome();
  await click('.sidebar .new-chat');
  await sleep(500);
  googleDown = true;
  await typeText(`open ${at('reports-example')} and read me the first line`);
  await sendNow();
  const said5c = await waitFor(`/I opened Reports Example/.test((document.querySelector('.ws-left .conv') ?? document.querySelector('.conv'))?.innerText ?? '')`, 90000);
  const panel5c = await evalIn('window.eya.getBrowserPanel()');
  googleDown = false;
  check('5c. with the AI unavailable, the page was still found, opened and checked, and the person is told so first (then why the AI could not go on)', said5c === true && /reports-example\.localhost/.test(panel5c.url), { url: panel5c.url, answer: (await convText()).slice(-400) });

  // ---------------------------------------------------------------- 6. the button is remembered, and goes off again
  await goHome();
  check('6. the Agent button is on and remembered', await dom(`document.querySelector('.composer .agent-toggle').getAttribute('aria-checked') === 'true' && localStorage.getItem('eya.agentMode') === 'on'`));
  await click('.composer .agent-toggle');
  await sleep(250);
  check('   and goes off again, and chat is plain again', await dom(`document.querySelector('.composer .agent-toggle').getAttribute('aria-checked') === 'false' && localStorage.getItem('eya.agentMode') === 'off'`));
} catch (e) {
  failures++;
  console.log('FAIL  the run stopped:', e && e.message ? e.message : e);
} finally {
  stopApp();
  site.close();
  google.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  console.log('screenshots and the app log are in', OUT);
  process.exit(failures === 0 ? 0 : 1);
}
