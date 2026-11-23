// Run from the project folder:  node tests/live/workspace-e2e.mjs      (E2E_MODE=preview to run the built app)
// The real app + a fake Google. Drives the new Home workspace the way a person does: the file picker, drag and drop, paste, remove, send, the model
// list, Maximize / Restore, the Panels button, the eye buttons, the folded sidebar, a narrow window, and Recent Tasks. The fake Google asks Eya to read
// each attached file (a tool call to analyze_document) and records exactly what arrives: the type and the bytes of every file.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, createWriteStream, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { deflateRawSync, crc32 } from 'node:zlib';

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

// ---- the files that get attached
const files = mkdtempSync(join(tmpdir(), 'eya-files-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function makeDocx(text) {
  const xml = Buffer.from(`<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  const body = deflateRawSync(xml);
  const name = Buffer.from('word/document.xml');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(xml), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(xml.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(xml), 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(xml.length, 24); central.writeUInt16LE(name.length, 28);
  const start = local.length + name.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(start, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}
const F = {
  txt: join(files, 'notes.txt'),
  docx: join(files, 'letter.docx'),
  png: join(files, 'photo.png'),
  mp3: join(files, 'talk.mp3'),
  mp4: join(files, 'clip.mp4'),
  xlsx: join(files, 'sheet.xlsx'),
  empty: join(files, 'empty.txt'),
  drop: join(files, 'dropped.txt'),
  pdf: join(files, 'order.pdf'),
};
writeFileSync(F.txt, 'The hearing is on 14 March.');
writeFileSync(F.docx, makeDocx('Hello from Word'));
writeFileSync(F.png, PNG);
writeFileSync(F.mp3, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40, 7)]));
writeFileSync(F.mp4, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(40, 9)]));
writeFileSync(F.xlsx, 'PK-not-really');
writeFileSync(F.empty, '');
writeFileSync(F.drop, 'Dropped from the desktop.');
writeFileSync(F.pdf, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(30, 65)]));
const many = [];
for (let i = 1; i <= 8; i++) { const p = join(files, `extra${i}.txt`); writeFileSync(p, `extra ${i}`); many.push(p); }

// ---- a fake Google
const MAIN = 'AIzaSyMAINMAINMAINMAINMAINMAINMAIN123';
const analyses = []; // what analyze_document sent: { mime, bytes, question }
const chats = []; // the system text of every chat request
const chatLog = []; // the conversation part of every chat request
let lastChatBody = '';
let lastToolNames = [];
let analyzeDelay = 0;
let chatDelay = 0; // how long the fake takes to answer a chat request
const google = createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [] })); return; }
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const reply = (parts) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 10 } })); };
    let body = {};
    try { body = JSON.parse(raw); } catch { /* not JSON */ }
    if (raw.includes('"AUDIO"')) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 400, message: 'no speech in the test' } })); return; }
    const contents = body.contents ?? [];
    const inline = contents[0]?.parts?.find((p) => p.inline_data);
    if (inline) {
      const bytes = Buffer.from(inline.inline_data.data, 'base64');
      const question = contents[0].parts.find((p) => typeof p.text === 'string')?.text ?? '';
      analyses.push({ mime: inline.inline_data.mime_type, bytes, question });
      setTimeout(() => reply([{ text: inline.inline_data.mime_type === 'text/plain' ? `READ[text/plain] ${bytes.toString('utf8').slice(0, 60)}` : `READ[${inline.inline_data.mime_type}] ${bytes.length} bytes` }]), analyzeDelay);
      return;
    }
    const system = body.systemInstruction?.parts?.map((p) => p.text).join('\n') ?? '';
    if (system !== '') lastToolNames = (body.tools ?? []).flatMap((x) => (x.functionDeclarations ?? []).map((d) => d.name));
    if (system === '') { reply([{ text: 'ok' }]); return; }
    chats.push(system);
    chatLog.push(JSON.stringify(contents));
    lastChatBody = JSON.stringify(contents);
    const slow = chatDelay;
    const answer = (parts) => setTimeout(() => reply(parts), slow);
    const m = system.indexOf('The user attached');
    if (m < 0) { answer([{ text: 'Plain answer (no files).' }]); return; }
    const paths = [...system.slice(m).matchAll(/^\d+\. ".*?" \(.*?\) at (.+)$/gm)].map((x) => x[1].trim());
    const called = new Set();
    const results = [];
    for (const c of contents) for (const p of c.parts ?? []) {
      if (p.functionCall?.name === 'analyze_document') called.add(p.functionCall.args?.path);
      if (p.functionResponse?.name === 'analyze_document') results.push(JSON.stringify(p.functionResponse.response).slice(0, 100));
    }
    const next = paths.find((p) => !called.has(p));
    if (next !== undefined) { answer([{ functionCall: { name: 'analyze_document', args: { path: next, question: 'Answer the question about this file.' } } }]); return; }
    answer([{ text: `FINAL: read ${paths.length} file(s). ${results.slice(-paths.length).join(' | ')}` }]);
  });
});
await new Promise((r) => google.listen(0, '127.0.0.1', r));
const googleUrl = `http://127.0.0.1:${google.address().port}/v1beta`;

const userData = mkdtempSync(join(tmpdir(), 'eya-ws-'));
const log = createWriteStream(join(OUT, `ws-app-${Date.now()}.log`));
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
    if (r.result?.exceptionDetails) throw new Error('page error: ' + String(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails)).slice(0, 500) + ' in: ' + expression.slice(0, 160));
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
        if (await c.evalIn('typeof window.eya !== "undefined" && typeof window.eya.pathForFile === "function"').catch(() => false)) return c;
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
  const ensureApp = async () => {
    for (let i = 0; i < 10; i++) {
      if (await evalIn("!!document.querySelector('.appwin')").catch(() => false)) return;
      await evalIn('window.eya.setWindowMode("app")').catch(() => undefined);
      await main.send('Page.bringToFront');
      await sleep(1500);
    }
  };
  const dom = async (expr) => { await ensureApp(); return evalIn(expr); };
  const click = (sel) => dom(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const clickText = (sel, re) => dom(`[...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => ${re}.test(b.textContent)).click()`);
  const waitFor = async (expr, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await dom(expr).catch(() => false)) return true; await sleep(400); } return false; };
  const chipNames = () => dom(`[...document.querySelectorAll('.attach-chip .attach-name')].map((n) => n.textContent)`);
  const notes = () => dom(`[...document.querySelectorAll('.composer-note')].map((n) => n.textContent.trim())`);
  const setFiles = async (paths) => {
    await ensureApp();
    const doc = await main.send('DOM.getDocument', { depth: 0 });
    const q = await main.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '.composer input[type=file]' });
    await main.send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: paths });
    await sleep(900);
  };
  const clearDraft = async () => {
    while ((await dom(`document.querySelectorAll('.attach-x[aria-label^="Remove"]').length`)) > 0) await dom(`document.querySelector('.attach-x[aria-label^="Remove"]').click()`);
    await dom(`[...document.querySelectorAll('.composer-note .attach-x')].forEach((b) => b.click())`);
  };
  const typeText = async (text) => {
    await dom(`document.querySelector('.composer textarea').focus()`);
    await main.send('Input.insertText', { text });
    await sleep(200);
  };
  const sendNow = async () => { await click('.composer .ask-go'); };
  const userMsgs = () => dom(`document.querySelectorAll('.conv .msg.user').length`);

  // ---------------------------------------------------------------- 1. the workspace itself
  await sleep(1000);
  await shot('ws-1-home.png');
  check('Home is the conversation workspace with its composer', await dom(`!!document.querySelector('.cw .composer textarea') && !!document.querySelector('.cw .conv')`));
  check('the old welcome hero, ask box and Quick Actions row are gone', await dom(`!document.querySelector('.hero') && !document.querySelector('[data-section=hero]') && !document.querySelector('[data-section=quickActions]') && !document.querySelector('.ask-area')`));
  check('the composer has the clip, the model list, the microphone and send', await dom(`!!document.querySelector('.composer [aria-label="Attach files"]') && !!document.querySelector('.composer .ai-picker select') && !!document.querySelector('.composer [aria-label="Talk to Eya"]') && !!document.querySelector('.composer [aria-label="Send"]')`));
  check('the empty conversation offers a few quiet suggestions, not a tools row', await dom(`document.querySelectorAll('.cw-suggest .suggest').length >= 4 && document.querySelectorAll('.cw-suggest .suggest').length <= 8`));
  await dom(`document.querySelector('.cw-suggest .suggest').click()`);
  await sleep(250);
  check('a suggestion that starts a job switches Agent on and fills the box', await dom(`document.querySelector('.composer .agent-toggle').getAttribute('aria-checked') === 'true' && document.querySelector('.composer textarea').value.length > 3`));
  await dom(`document.querySelector('.composer .agent-toggle').click()`);
  await dom(`(() => { const t = document.querySelector('.composer textarea'); t.focus(); t.select(); })()`);
  await main.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await main.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await sleep(200);
  check('send waits until there is something to send', await dom(`document.querySelector('.composer .ask-go').disabled === true`));
  check('the model list says which AI is connected', /Gemini/.test(await dom(`document.querySelector('.composer .ai-picker .ai-badge-main').textContent`)), await dom(`document.querySelector('.composer .ai-picker').textContent`));

  // growing box
  const h0 = await dom(`document.querySelector('.composer textarea').offsetHeight`);
  await typeText('first line\nsecond line\nthird line\nfourth line');
  const h1 = await dom(`document.querySelector('.composer textarea').offsetHeight`);
  check('the box grows as lines are typed', h1 > h0 + 20, { h0, h1 });
  await dom(`(() => { const t = document.querySelector('.composer textarea'); t.focus(); t.select(); })()`);
  await main.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await main.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await sleep(200);
  check('and goes back to one line when it is emptied', (await dom(`document.querySelector('.composer textarea').offsetHeight`)) <= h0 + 2, await dom(`document.querySelector('.composer textarea').value`));

  // ---------------------------------------------------------------- 2. layout, Agent mode, and the panel that opens only for an agent task
  check('on opening there is the sidebar and the conversation and nothing else: no panel on the right, nothing under the chat', await dom(`!document.querySelector('aside.dash-side') && !document.querySelector('[data-section=recentTasks]') && document.querySelector('.dash2').classList.contains('no-right') && !document.querySelector('.cw-btn')`));
  const cwOpen = await dom(`Math.round(document.querySelector('.cw').getBoundingClientRect().width)`);
  const mainOpen = await dom(`Math.round(document.querySelector('.mainarea').getBoundingClientRect().width)`);
  check('the conversation takes all the room to the right of the sidebar', cwOpen >= mainOpen - 60, { cwOpen, mainOpen });
  check('no Maximize and no Panels button on the chat (it needs neither)', await dom(`![...document.querySelectorAll('.cw button')].some((b) => /Maximize|Restore|^\\s*Panels\\s*$/.test(b.textContent))`));
  check('there is exactly one toggle for the sidebar, in the sidebar, and none in the top bar', await dom(`document.querySelectorAll('.sidebar .side-toggle').length === 1 && !document.querySelector('.topbar [aria-label*="sidebar"]')`));
  check('the sidebar has New chat and the list of chats', await dom(`!!document.querySelector('.sidebar .new-chat') && !!document.querySelector('.sidebar .chat-history')`));
  check('the extra "Ask Eya anything" box at the top is gone (the message box in the conversation is the one place to ask)', await dom(`!document.querySelector('.top-search') && !/Ask Eya anything/.test(document.querySelector('.topbar').innerText)`));
  check('the Agent button is beside the message box, and it starts off', await dom(`document.querySelector('.composer .agent-toggle')?.getAttribute('aria-checked') === 'false' && /Message Eya/.test(document.querySelector('.composer textarea').placeholder)`));

  await click('.side-toggle');
  await sleep(350);
  check('the toggle folds the sidebar to its icons, and the conversation widens', await dom(`document.querySelector('.shell').classList.contains('side-folded') && document.querySelector('.sidebar').offsetWidth < 100 && !document.querySelector('.sidebar .chat-history')`));
  check('the folded sidebar keeps New chat as a plus and the toggle', await dom(`!!document.querySelector('.sidebar .new-chat') && !!document.querySelector('.sidebar .side-toggle')`));
  await shot('ws-2-folded.png');
  await click('.side-toggle');
  await sleep(350);
  check('and it opens again', await dom(`!document.querySelector('.shell').classList.contains('side-folded') && document.querySelector('.sidebar').offsetWidth > 150 && !!document.querySelector('.sidebar .chat-history')`));

  // a plain chat answer is not a task: the panel stays shut while she answers it, and no tool is offered but the two chat may use
  let sawPanelDuringChat = false;
  await typeText('what is two plus two');
  await sendNow();
  for (let i = 0; i < 12; i++) {
    if (await dom(`!!document.querySelector('aside.dash-side')`)) sawPanelDuringChat = true;
    if (/Plain answer \(no files\)\./.test(await dom(`document.querySelector('.conv').innerText`))) break;
    await sleep(300);
  }
  await sleep(1300);
  check('an ordinary chat answer works in the conversation alone: the panel never opens for it', !sawPanelDuringChat && (await dom(`/Plain answer \\(no files\\)\\./.test(document.querySelector('.conv').innerText)`)), { sawPanelDuringChat });
  check('with Agent off Eya was given the chat instructions and only the two chat tools (no browser, no files)', /plain chat mode/.test(chats[chats.length - 1] ?? '') && JSON.stringify([...lastToolNames].sort()) === JSON.stringify(['analyze_document', 'web_search']), { lastToolNames, system: (chats[chats.length - 1] ?? '').slice(0, 120) });

  // the old fault: a slow AI turned "Hi" into a task and opened the panel
  chatDelay = 9500;
  await typeText('Hi');
  await sendNow();
  await sleep(9000);
  const slowTasks = await evalIn('window.eya.getTasks()');
  check('"Hi" that the AI is slow over (9 seconds) is still only a conversation: no panel, no task, nothing "in progress"', (await dom(`!document.querySelector('aside.dash-side') && !document.querySelector('.topbar [aria-label*="panel on the right"]')`)) && slowTasks.items.length === 0, { items: slowTasks.items.map((i) => i.request) });
  chatDelay = 0;
  await waitFor(`(document.querySelector('.conv').innerText.match(/Plain answer/g) ?? []).length >= 2`, 30000);

  // an everyday command in chat: said to need Agent at once, with the button, and nothing is done
  const chatsBefore = chats.length;
  await typeText('open the telangana cause list');
  await sendNow();
  check('an everyday command typed with Agent off is not done and not guessed at: chat says it needs Agent, at once, with a button to switch it on', (await waitFor(`/Agent mode|Agent on/.test(document.querySelector('.conv').innerText) && !!document.querySelector('.agent-suggest')`, 20000)) && chats.length === chatsBefore, { asked: chats.length - chatsBefore });

  // a file read in chat is allowed (analyze_document), and still no panel and no task
  analyzeDelay = 3800;
  await setFiles([many[0]]);
  await typeText('read this slowly for me');
  await sendNow();
  let sawPanelInChat = false;
  for (let i = 0; i < 100; i++) {
    if (await dom(`!!document.querySelector('aside.dash-side')`)) sawPanelInChat = true;
    if (/FINAL: read 1 file/.test((await dom(`document.querySelector('.conv').innerText`)).split('read this slowly for me').pop() ?? '')) break;
    await sleep(400);
  }
  await sleep(1500);
  check('with Agent off, reading a file works and still does not open the panel or make a task', !sawPanelInChat && (await evalIn('window.eya.getTasks()')).items.length === 0 && /FINAL: read 1 file/.test((await dom(`document.querySelector('.conv').innerText`)).split('read this slowly for me').pop() ?? ''), { sawPanelInChat });

  await waitFor(`!/Eya is working/.test(document.querySelector('.composer textarea').placeholder)`, 40000);
  // the Agent button: on, remembered, and the cards of the Layout menu do not open the panel by themselves
  await click('.composer .agent-toggle');
  await sleep(250);
  check('the Agent button switches Agent on, and the choice is remembered', await dom(`document.querySelector('.composer .agent-toggle').getAttribute('aria-checked') === 'true' && localStorage.getItem('eya.agentMode') === 'on' && /Tell Eya what to do/.test(document.querySelector('.composer textarea').placeholder)`));
  await click('.layout-menu > button');
  await sleep(300);
  await dom(`[...document.querySelectorAll('.layout-pop li')].find((li) => /Gemini keys/.test(li.textContent)).querySelector('[role=switch]').click()`);
  await sleep(400);
  check('switching a card on in the Layout menu opens nothing by itself: the panel is for a running agent task', await dom(`!document.querySelector('aside.dash-side')`));
  await dom(`[...document.querySelectorAll('.layout-pop button')].find((b) => /Back to default/.test(b.textContent)).click()`);
  await dom(`document.querySelector('.layout-menu > button').click()`);
  await sleep(200);

  // an agent task: Eya reads a file (a slow one), the panel opens on the right with what she is doing
  await setFiles([many[1]]);
  await typeText('read this slowly for me too');
  await sendNow();
  const opened = await waitFor(`!!document.querySelector('aside.dash-side')`, 12000);
  check('with Agent on, when a task works, the panel opens on the right by itself', opened === true);
  if (opened) {
    await sleep(500);
    await shot('ws-3-task-panel.png');
    check('it shows "Your Agent at Work" with the question and the step she is on, and "Tasks in progress"', await dom(`!!document.querySelector('aside.dash-side [data-section=agentTimeline]') && /read this slowly for me too/.test(document.querySelector('[data-section=agentTimeline]').innerText) && !!document.querySelector('[data-section=agentTimeline] .tl-steps .now') && !!document.querySelector('aside.dash-side [data-section=agentList]')`), await dom(`document.querySelector('aside.dash-side')?.innerText.slice(0, 300)`));
    const panelW = await dom(`Math.round(document.querySelector('aside.dash-side').getBoundingClientRect().width)`);
    check('the panel is roomy, not small (at least 340 px wide)', panelW >= 340, { panelW });
    check('the Gemini keys, Popular Apps, Recent Files and Today cards are not in it', await dom(`!['aiKeys', 'popularApps', 'recentFiles', 'todayActivity'].some((id) => document.querySelector('[data-section=' + id + ']'))`));
    check('the conversation is still beside it, and the top bar has the button to close the panel', await dom(`!!document.querySelector('.cw .composer textarea') && !!document.querySelector('.topbar [aria-label="Close the panel on the right"]')`));
    // a card switched on in the Layout menu joins the panel while the task goes on
    await click('.layout-menu > button');
    await sleep(250);
    await dom(`[...document.querySelectorAll('.layout-pop li')].find((li) => /Gemini keys/.test(li.textContent)).querySelector('[role=switch]').click()`);
    await sleep(300);
    check('a card switched on in the Layout menu appears in the panel while the agent works', await dom(`!!document.querySelector('aside.dash-side [data-section=aiKeys]')`));
    await dom(`[...document.querySelectorAll('.layout-pop button')].find((b) => /Back to default/.test(b.textContent)).click()`);
    await dom(`document.querySelector('.layout-menu > button').click()`);
    await sleep(250);
    await click('.topbar [aria-label="Close the panel on the right"]');
    await sleep(300);
    check('the person can close it, and the conversation takes the room back', await dom(`!document.querySelector('aside.dash-side') && document.querySelector('.dash2').classList.contains('no-right') && !!document.querySelector('.topbar [aria-label="Show what Eya is doing"]')`));
    await click('.topbar [aria-label="Show what Eya is doing"]');
    await sleep(300);
    check('and open it again while the task goes on', await dom(`!!document.querySelector('aside.dash-side')`));
  }
  const finished = await waitFor(`/FINAL: read 1 file/.test(document.querySelector('.conv').innerText.split('read this slowly for me too').pop() ?? '')`, 60000);
  check('the task finishes and the answer is in the conversation', finished === true);
  analyzeDelay = 0;
  if (opened) {
    check('the panel stays a few seconds so the ending can be read (the answer is in it)', await dom(`!!document.querySelector('aside.dash-side') && /FINAL: read 1 file/.test(document.querySelector('[data-section=agentTimeline]').innerText)`), await dom(`document.querySelector('aside.dash-side')?.innerText.slice(0, 300) ?? 'no panel'`));
    check('and then it goes by itself, with its button', await waitFor(`!document.querySelector('aside.dash-side') && !document.querySelector('.topbar [aria-label*="panel on the right"], .topbar [aria-label="Show what Eya is doing"]')`, 15000));
  }
  // back to chat for the rest of the checks
  await click('.composer .agent-toggle');
  await sleep(250);
  check('Agent switches off again', await dom(`document.querySelector('.composer .agent-toggle').getAttribute('aria-checked') === 'false' && localStorage.getItem('eya.agentMode') === 'off'`));

  await main.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  await shot('ws-4-narrow.png');
  check('in a narrow window the conversation keeps the room and nothing runs off the side', await dom(`!document.querySelector('aside.dash-side') && !!document.querySelector('.cw .composer textarea') && document.documentElement.scrollWidth <= window.innerWidth + 2`), await dom(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })`));
  await main.send('Emulation.clearDeviceMetricsOverride');
  await sleep(700);

  // ---------------------------------------------------------------- 3. files: pick, preview, refuse, remove, limits
  await setFiles([F.txt, F.docx, F.png, F.mp3, F.mp4, F.xlsx, F.empty]);
  const names1 = await chipNames();
  check('the file picker adds pictures, Word, text, audio and video as chips', ['notes.txt', 'letter.docx', 'photo.png', 'talk.mp3', 'clip.mp4'].every((n) => names1.includes(n)) && names1.length === 5, names1);
  check('a picture shows its own thumbnail, the others an icon and what they are', await dom(`!!document.querySelector('.attach-chip .attach-thumb') && /Audio|audio/.test(document.querySelector('.attach-chip.k-audio')?.textContent ?? '') && /Video|video/.test(document.querySelector('.attach-chip.k-video')?.textContent ?? '')`));
  const n1 = await notes();
  check('an Excel file is refused in plain words and an empty file too, nothing is attached for them', n1.some((t) => /xlsx/i.test(t) && /PDF|docx/i.test(t)) && n1.some((t) => /empty/i.test(t)) && !names1.includes('sheet.xlsx') && !names1.includes('empty.txt'), n1);
  await shot('ws-4-chips.png');
  await setFiles([F.txt]);
  check('attaching the same file twice does not duplicate it', (await chipNames()).filter((n) => n === 'notes.txt').length === 1, await chipNames());
  await dom(`[...document.querySelectorAll('.attach-chip')].find((c) => /clip\\.mp4/.test(c.textContent)).querySelector('.attach-x').click()`);
  await sleep(300);
  check('a chip is removed with its x', !(await chipNames()).includes('clip.mp4') && (await chipNames()).length === 4, await chipNames());
  await clearDraft();
  await setFiles(many);
  check('no more than 8 files at a time, and it says so', (await chipNames()).length === 8, await chipNames());
  await clearDraft();
  check('removing everything leaves a clean box', (await chipNames()).length === 0 && (await dom(`document.querySelector('.composer .ask-go').disabled`)) === true);

  // ---------------------------------------------------------------- 4. send files with a question: what Google really receives
  await setFiles([F.txt, F.docx, F.png, F.mp3, F.pdf]);
  const sentBefore = await userMsgs();
  await typeText('What do these say?');
  chatDelay = 1800;
  check('send is ready with text and files', (await dom(`document.querySelector('.composer .ask-go').disabled`)) === false);
  await sendNow();
  check('the message appears in the conversation with its files and the box is empty again', await waitFor(`document.querySelectorAll('.conv .msg.user').length === ${sentBefore + 1} && document.querySelectorAll('.conv .sent-file').length >= 5 && document.querySelector('.composer textarea').value === '' && document.querySelectorAll('.attach-chip').length === 0`, 15000), await dom(`document.querySelector('.conv').innerText.slice(0, 300)`));
  check('while Eya works there is a loading indicator, and a Stop button in place of Send', await dom(`!!document.querySelector('.msg-bubble.typing, .msg-bubble.streaming') && !!document.querySelector('.composer .ask-go.stop') && !document.querySelector('.composer .ask-go:not(.stop)')`), await dom(`document.querySelector('.conv').innerText.slice(-200)`));
  chatDelay = 0;
  const gotAnswer = await waitFor(`/FINAL: read 5 file/.test(document.querySelector('.conv').innerText)`, 90000);
  await shot('ws-5-answer.png');
  check('Eya answers in the same conversation, after reading all five files', gotAnswer, await dom(`document.querySelector('.conv').innerText.slice(-500)`));
  const by = (mime) => analyses.filter((a) => a.mime === mime);
  check('the text file reached Google as text, byte for byte', analyses.some((a) => a.mime === 'text/plain' && a.bytes.toString('utf8') === 'The hearing is on 14 March.'), analyses.map((a) => a.mime));
  check('the Word file reached Google as its words', analyses.some((a) => a.mime === 'text/plain' && a.bytes.toString('utf8') === 'Hello from Word'), analyses.map((a) => [a.mime, a.bytes.length]));
  check('the picture reached Google as the same picture', by('image/png').some((a) => a.bytes.equals(PNG)), analyses.map((a) => a.mime));
  check('the audio reached Google as audio, the PDF as a PDF', by('audio/mp3').length === 1 && by('audio/mp3')[0].bytes.length === 43 && by('application/pdf').length === 1, analyses.map((a) => [a.mime, a.bytes.length]));
  check('the AI was told about all five files before it answered', chats.some((s) => s.includes('The user attached 5 files')), chats.map((s) => s.slice(0, 80)));

  // video on its own
  await setFiles([F.mp4]);
  await typeText('what is in this clip');
  await sendNow();
  check('a video is sent as a video', (await waitFor(`/FINAL: read 1 file/.test(document.querySelector('.conv').innerText.split('what is in this clip').pop() ?? '')`, 90000)) && by('video/mp4').length === 1 && by('video/mp4')[0].bytes.length === 52, analyses.map((a) => [a.mime, a.bytes.length]));

  // ---------------------------------------------------------------- 5. drag and drop, with no question typed
  await ensureApp();
  const box = await dom(`(() => { const r = document.querySelector('.cw .conv').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  const dragData = { items: [], files: [F.drop], dragOperationsMask: 1 };
  await main.send('Input.dispatchDragEvent', { type: 'dragEnter', x: box.x, y: box.y, data: dragData });
  await main.send('Input.dispatchDragEvent', { type: 'dragOver', x: box.x, y: box.y, data: dragData });
  await sleep(300);
  const overlay = await dom(`!!document.querySelector('.drop-overlay')`);
  await shot('ws-6-drop.png');
  await main.send('Input.dispatchDragEvent', { type: 'drop', x: box.x, y: box.y, data: dragData });
  await sleep(900);
  check('dragging a file over the workspace shows where to drop it', overlay === true);
  check('dropping it attaches the real file', (await chipNames()).includes('dropped.txt'), await chipNames());
  const asksBefore = analyses.length;
  await sendNow();
  check('with files and no words, Eya is asked to summarise the file', await waitFor(`/Summarize this file\\./.test(document.querySelector('.conv').innerText)`, 15000));
  check('and it reads the dropped file', (await waitFor(`/FINAL: read 1 file/.test(document.querySelector('.conv').innerText.split('Summarize this file.').pop() ?? '')`, 90000)) && analyses.slice(asksBefore).some((a) => a.bytes.toString('utf8') === 'Dropped from the desktop.'), analyses.slice(asksBefore).map((a) => a.mime));

  // ---------------------------------------------------------------- 6. paste a picture (it has no place on disk)
  await dom(`(() => { const t = document.querySelector('.composer textarea'); const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(${JSON.stringify([...PNG])})], 'image.png', { type: 'image/png' })); t.focus(); t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  await sleep(1200);
  check('a pasted picture becomes a chip with a preview', (await chipNames()).includes('image.png') && (await dom(`!!document.querySelector('.attach-chip .attach-thumb')`)), await chipNames());
  const kept = join(userData, 'attachments');
  check('it was kept by Eya in its own folder so it can be read', existsSync(kept) && readdirSync(kept).length >= 1, existsSync(kept) ? readdirSync(kept) : 'no folder');
  const asks2 = analyses.length;
  await typeText('what is in this screenshot');
  await sendNow();
  check('the pasted picture is read, bytes intact', (await waitFor(`/FINAL: read 1 file/.test(document.querySelector('.conv').innerText.split('what is in this screenshot').pop() ?? '')`, 90000)) && analyses.slice(asks2).some((a) => a.mime === 'image/png' && a.bytes.equals(PNG)), analyses.slice(asks2).map((a) => [a.mime, a.bytes.length]));

  // ---------------------------------------------------------------- 7. the model list, and an AI that cannot read files
  await dom(`(() => { const s = document.querySelector('.composer .ai-picker select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'local-only'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(1200);
  check('the model list switches the AI (Local AI only)', await dom(`document.querySelector('.composer .ai-picker select').value === 'local-only'`));
  await setFiles([F.txt]);
  const problem = await dom(`document.querySelector('.composer-note.bad')?.textContent ?? ''`);
  check('with the local AI alone, the file is not pretended to be readable: it says why and Send stays off', /Local AI only cannot read/.test(problem) && (await dom(`document.querySelector('.composer .ask-go').disabled`)) === true, problem);
  await shot('ws-7-local-only.png');
  await dom(`(() => { const s = document.querySelector('.composer .ai-picker select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'auto'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(1200);
  check('back on Automatic the same file can be sent again', (await dom(`document.querySelector('.composer-note.bad')`)) === null && (await dom(`document.querySelector('.composer .ask-go').disabled`)) === false);
  await clearDraft();

  // ---------------------------------------------------------------- 8. new chat and the chat history
  const items = () => dom(`[...document.querySelectorAll('.chat-item')].map((li) => ({ title: li.querySelector('.chat-title, .chat-rename')?.textContent ?? '', on: li.classList.contains('on') }))`);
  const firstTitle = 'what is two plus two';
  await sleep(1200);
  const list1 = await items();
  check('the conversation so far is kept in the list, titled from the first thing said, and marked as the open one', list1.length === 1 && list1[0].title === firstTitle && list1[0].on === true, list1);
  const savedFile = join(userData, 'chats.json');
  check('and it is on this PC in Eya\'s data folder', existsSync(savedFile) && /what is two plus two/.test(readFileSync(savedFile, 'utf8')), existsSync(savedFile));
  const oldCount = await dom(`document.querySelectorAll('.conv .msg').length`);

  await click('.sidebar .new-chat');
  await sleep(500);
  check('New chat starts empty: no messages, the greeting is back, and the old chat stays in the list', await dom(`document.querySelectorAll('.conv .msg').length === 0 && !!document.querySelector('.cw-empty')`) && (await items()).length === 1 && (await items())[0].on === false, await items());
  const cutBefore = chatLog.length;
  await typeText('how are you feeling today');
  await sendNow();
  check('a message in the new chat is answered', await waitFor(`/Plain answer \\(no files\\)\\./.test(document.querySelector('.conv').innerText)`, 30000));
  const seen = chatLog.slice(cutBefore).join(' ');
  check('the new chat starts with a clean memory: Eya was not given the old conversation', !/what is in this screenshot/.test(seen) && !/Summarize this file/.test(seen) && !/What do these say/.test(seen), seen.slice(0, 300));
  await sleep(1200);
  const list2 = await items();
  check('both chats are listed, the newest on top and open', list2.length === 2 && list2[0].title === 'how are you feeling today' && list2[0].on === true && list2[1].title === firstTitle, list2);
  await shot('ws-5-history.png');

  await dom(`[...document.querySelectorAll('.chat-open')].find((b) => /two plus two/.test(b.textContent)).click()`);
  await sleep(600);
  check('opening the old chat brings its messages back, with the file names it had', await dom(`document.querySelectorAll('.conv .msg').length === ${oldCount} && /read this slowly for me/.test(document.querySelector('.conv').innerText) && /FINAL: read 1 file/.test(document.querySelector('.conv').innerText) && document.querySelectorAll('.conv .sent-file').length >= 2`), await dom(`document.querySelector('.conv').innerText.slice(0, 200)`));
  const beforeOld = await userMsgs();
  await typeText('thanks now say it simply');
  await sendNow();
  check('carrying on in the old chat works', await waitFor(`document.querySelectorAll('.conv .msg.user').length === ${beforeOld + 1} && /Plain answer/.test(document.querySelector('.conv').innerText.split('thanks now say it simply').pop() ?? '')`, 30000));
  const body = lastChatBody;
  check('and Eya was given the end of that old conversation, so she understands the follow-up', /what is in this screenshot/.test(body) && !/how are you feeling today/.test(body), body.slice(0, 300));
  await sleep(1200);

  // rename
  await dom(`document.querySelector('.chat-item.on .chat-actions button[aria-label^="Rename"]').click()`);
  await sleep(250);
  await dom(`document.querySelector('.chat-rename').select()`);
  await main.send('Input.insertText', { text: 'Hearing dates' });
  await main.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await main.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(700);
  const afterRename = await items();
  check('a chat can be renamed, and carrying on in it does not undo the name', afterRename.some((i) => i.title === 'Hearing dates'), afterRename);
  const stored = await evalIn(`window.eya.listChats()`);
  check('the new name is the one kept on the PC', stored.some((c) => c.title === 'Hearing dates') && stored.length === 2, stored);

  // delete one that is not open, asked first
  await dom(`[...document.querySelectorAll('.chat-item')].find((li) => /how are you feeling today/.test(li.textContent)).querySelector('.chat-actions button[aria-label^="Delete"]').click()`);
  await sleep(250);
  check('deleting asks first', await dom(`!!document.querySelector('.chat-ask') && /Delete this chat\\?/.test(document.querySelector('.chat-ask').textContent)`));
  await dom(`document.querySelector('.chat-ask [aria-label="Keep it"]').click()`);
  await sleep(250);
  check('and "keep" leaves it alone', (await items()).length === 2);
  await dom(`[...document.querySelectorAll('.chat-item')].find((li) => /how are you feeling today/.test(li.textContent)).querySelector('.chat-actions button[aria-label^="Delete"]').click()`);
  await sleep(200);
  await dom(`document.querySelector('.chat-ask [aria-label="Yes, delete it"]').click()`);
  await sleep(700);
  const afterDelete = await items();
  check('"yes" deletes it, from the list and from the PC', afterDelete.length === 1 && afterDelete[0].title === 'Hearing dates' && !/how are you feeling today/.test(readFileSync(savedFile, 'utf8')), afterDelete);
  // delete the open one: the conversation clears
  await dom(`document.querySelector('.chat-item.on .chat-actions button[aria-label^="Delete"]').click()`);
  await sleep(200);
  await dom(`document.querySelector('.chat-ask [aria-label="Yes, delete it"]').click()`);
  await sleep(700);
  check('deleting the open chat clears the screen for a new one', (await items()).length === 0 && await dom(`document.querySelectorAll('.conv .msg').length === 0`));

  // keeping chats can be switched off
  await evalIn(`window.eya.setSettings({ keepChats: false })`);
  await sleep(500);
  await typeText('this one is private');
  await sendNow();
  await waitFor(`/Plain answer/.test(document.querySelector('.conv').innerText)`, 30000);
  await sleep(1800);
  check('with "Keep my chats" off a new conversation is not saved', (await items()).length === 0 && !/this one is private/.test(existsSync(savedFile) ? readFileSync(savedFile, 'utf8') : ''), await items());
  await evalIn(`window.eya.setSettings({ keepChats: true })`);
  await click('.sidebar .new-chat');
  await sleep(400);

  // Settings → Privacy has the switch and Delete all chats
  await clickText('.nav-item', '/^\\s*Settings/');
  await sleep(600);
  await clickText('.settings-nav-item', '/Privacy/');
  await sleep(500);
  check('Settings → Privacy has "Keep my chats" and "Delete all chats"', await dom(`/Keep my chats/.test(document.body.innerText) && /Delete all chats/.test(document.body.innerText)`));
  await clickText('.nav-item', '/^\\s*Home\\s*$/');
  await sleep(500);

  // the Recent Tasks section is still there for whoever switches it on
  await click('.layout-menu > button');
  await sleep(200);
  await dom(`[...document.querySelectorAll('.layout-pop li')].find((li) => /Recent Tasks/.test(li.textContent)).querySelector('[role=switch]').click()`);
  await sleep(400);
  check('Recent Tasks can be switched on under the conversation (two rows)', await dom(`!!document.querySelector('.dash-left [data-section=recentTasks]') && document.querySelectorAll('[data-section=recentTasks] .task-row').length <= 2`));
  await dom(`[...document.querySelectorAll('.layout-pop button')].find((b) => /Back to default/.test(b.textContent)).click()`);
  await dom(`document.querySelector('.layout-menu > button').click()`);
  await sleep(300);

  // ---------------------------------------------------------------- 9. the other pages are still there, and the Chat page shares the workspace
  await clickText('.nav-item', '/^\\s*Chat\\s*$/');
  await sleep(700);
  check('the Chat page is the same workspace (its own composer; the new empty chat is what it shows)', await dom(`!!document.querySelector('.chat-page .cw .composer textarea') && !!document.querySelector('.chat-page .conv') && !!document.querySelector('.sidebar .chat-history')`));
  for (const page of ['Browser', 'Live Screen', 'Files', 'Memory', 'Settings']) {
    const there = await dom(`[...document.querySelectorAll('.nav-item')].some((b) => b.textContent.trim().startsWith(${JSON.stringify(page)}))`);
    if (!there) { check(`the ${page} page is in the sidebar`, false); continue; }
    await clickText('.nav-item', `new RegExp('^\\\\s*${page}')`);
    await sleep(600);
    check(`the ${page} page still opens`, await dom(`!!document.querySelector('.appwin') && document.body.innerText.length > 40`));
  }
  await clickText('.nav-item', '/^\\s*Home\\s*$/');
  await sleep(600);

  // ---------------------------------------------------------------- 10. dark theme
  if (await dom(`!document.querySelector('.appwin.dark')`)) await click('[aria-label="Switch between light and dark"]');
  await sleep(700);
  await shot('ws-8-dark.png');
  check('the dark theme keeps the workspace readable: dark window, light text in the box and in the greeting', await dom(`(() => { const lum = (c) => { const m = /rgba?\\((\\d+), (\\d+), (\\d+)/.exec(c); return m ? (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 : -1; }; return lum(getComputedStyle(document.querySelector('.appwin')).backgroundColor) < 110 && lum(getComputedStyle(document.querySelector('.composer textarea')).color) > 150 && lum(getComputedStyle(document.querySelector('.cw-empty h1')).color) > 150; })()`), await dom(`[getComputedStyle(document.querySelector('.appwin')).backgroundColor, getComputedStyle(document.querySelector('.composer textarea')).color, getComputedStyle(document.querySelector('.cw-empty h1')).color]`));
  await dom(`localStorage.removeItem('eya.theme'); localStorage.removeItem('eya.hiddenSections2'); 0`);
} catch (e) {
  failures++;
  console.log('FAIL  the run stopped:', e && e.message ? e.message : e);
} finally {
  stopApp();
  google.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  console.log('screenshots and the app log are in', OUT);
  process.exit(failures === 0 ? 0 : 1);
}
