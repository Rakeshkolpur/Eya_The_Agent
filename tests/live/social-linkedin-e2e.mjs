// Run from the project folder, after "npx electron-vite build":   E2E_MODE=preview node tests/live/social-linkedin-e2e.mjs
// (23 Nov 2026) Publishing on a LinkedIn-SHAPED page (a local HTTPS mock that answers as www.linkedin.com) in the REAL app and its REAL Eya Browser: draft, picture on the page's file picker, Post asks, a confirm
// without the person's yes does nothing, their yes publishes exactly the text, the same text twice / a client matter / a missing permission are refused, a comment goes the same way, the ledger keeps fingerprints.
// NOT covered: the real LinkedIn (its page is built differently), a signed-in account.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, createWriteStream, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT = process.cwd().split('\\').join('/');
const SP = join(tmpdir(), 'eya-e2e-out');
mkdirSync(SP, { recursive: true });
const CDP = 9343;
let failures = 0;
const check = (name, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra ?? '').slice(0, 900)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));



// ------------------------------------------------------------------------------------------------ a LinkedIn-shaped page over HTTPS, answering as www.linkedin.com
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Feed | LinkedIn</title></head><body>
<header><nav aria-label="Primary"><a href="/feed/">Home</a> <a href="/jobs/">Jobs</a></nav></header>
<main>
  <h1>Feed</h1>
  <button id="start">Start a post</button>
  <div id="overlay" hidden style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:50"></div>
  <div id="modal" role="dialog" aria-label="Create a post" hidden style="position:fixed;top:60px;left:100px;width:600px;background:#fff;z-index:60;padding:12px">
    <h2>Create a post</h2>
    <div id="editor" role="textbox" aria-label="Text editor for creating content" contenteditable="true" style="min-height:60px;border:1px solid #999"></div>
    <button id="media" type="button" aria-label="Add media">Add media</button>
    <div id="preview"></div>
    <button id="post" type="button" disabled>Post</button>
    <button id="close" type="button">Close the box</button>
  </div>
  <section id="feed"></section>
  <article id="theirs"><h3>Priya Sharma</h3><p>Tenants should always ask for a written receipt.</p>
    <div id="cbox" role="textbox" aria-label="Add a comment…" contenteditable="true" style="min-height:30px;border:1px solid #999"></div>
    <button id="comment" type="button">Comment</button>
    <div id="comments"></div>
  </article>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  let imageName = '';
  const log = (kind, text) => fetch('/__posted', { method: 'POST', body: JSON.stringify({ kind, text, image: imageName }) });
  const openBox = () => { $('modal').hidden = false; $('overlay').hidden = false; };
  $('start').onclick = openBox;
  $('close').onclick = () => { $('modal').hidden = true; $('overlay').hidden = true; };
  if (location.search.includes('shareActive=true')) openBox();
  const state = () => fetch('/__state', { method: 'POST', body: JSON.stringify({ editor: $('editor').innerText, image: imageName }) });
  $('editor').oninput = () => { $('post').disabled = $('editor').innerText.trim() === ''; state(); };
  $('media').onclick = () => {
    if (document.getElementById('file')) return;
    const f = document.createElement('input'); f.type = 'file'; f.id = 'file'; f.accept = 'image/*'; f.style.display = 'none';
    f.onchange = () => { imageName = f.files[0] ? f.files[0].name : ''; $('preview').textContent = imageName ? 'Picture: ' + imageName : ''; state(); };
    $('modal').appendChild(f);
  };
  $('post').onclick = () => {
    const text = $('editor').innerText.trim();
    log('post', text);
    const a = document.createElement('article'); a.textContent = text; $('feed').prepend(a);
    $('editor').innerText = ''; $('modal').hidden = true; $('overlay').hidden = true; $('post').disabled = true;
  };
  $('comment').onclick = () => {
    const text = $('cbox').innerText.trim();
    if (text === '') { $('cbox').focus(); return; }
    log('comment', text);
    const c = document.createElement('div'); c.textContent = text; $('comments').appendChild(c); $('cbox').innerText = '';
  };
</script></body></html>`;

const posted = [];
let pageState = { editor: '', image: '' };
const opens = [];
const certDir = mkdtempSync(join(tmpdir(), 'eya-cert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'k.pem'), '-out', join(certDir, 'c.pem'), '-days', '2', '-subj', '/CN=www.linkedin.com'], { stdio: 'ignore' });
const server = https.createServer({ key: readFileSync(join(certDir, 'k.pem')), cert: readFileSync(join(certDir, 'c.pem')) }, (req, res) => {
  if (req.method === 'POST' && req.url === '/__state') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => { pageState = JSON.parse(body); res.end('ok'); });
    return;
  }
  if (req.method === 'GET') opens.push(req.url);
  if (req.method === 'POST' && req.url === '/__posted') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => { posted.push(JSON.parse(body)); res.end('ok'); });
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;


const userData = mkdtempSync(join(tmpdir(), 'eya-typed-'));
// (the person's limits file: no quiet hours, so this runs at any time of day)
writeFileSync(join(userData, 'social.json'), JSON.stringify({ version: 1, drafts: [], ledger: [], profile: {}, pacing: { quiet: { from: 0, to: 0 } } }));
const USERDATA = userData;
const logFile = join(SP, `typed-app-${Date.now()}.log`);
const log = createWriteStream(logFile);
const env = {
  ...process.env,
  EYA_GEMINI_API_KEY: 'AIzaSyBPBPBPBPBPBPBPBPBPBPBPBPBPBPBPBP1',
  EYA_OLLAMA_URL: 'http://127.0.0.1:1',
  EYA_BRIDGE_PORT: '47843',
  EYA_NO_BROWSER_LAUNCH: '1',
  EYA_NO_MIC: '1',
  EYA_LOG_LEVEL: 'debug',
};
delete env.EYA_BACKUP_AI_KEY;
delete env.EYA_BROWSER_HEADLESS;
const app = spawn('cmd.exe', ['/c', 'npx', 'electron-vite', process.env.E2E_MODE === 'preview' ? 'preview' : 'dev', '--', `--remote-debugging-port=${CDP}`, `--user-data-dir=${userData}`, `--host-resolver-rules=MAP www.linkedin.com 127.0.0.1:${PORT}`, '--ignore-certificate-errors'], { cwd: PROJECT, env });
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
  const tool = async (name, args, heard = '') => {
    const raw = await evalIn(`window.eya.runLiveTool(${JSON.stringify({ name, args, heard })}).then((r) => r.content)`);
    try { return JSON.parse(raw); } catch { return { ok: false, error: String(raw) }; }
  };
  const grant = (permission) => evalIn(`window.eya.changePlugin({ kind: "grant", id: "linkedin", permission: ${JSON.stringify(permission)} }).then((r) => r.message)`);
  const revoke = (permission) => evalIn(`window.eya.changePlugin({ kind: "revoke", id: "linkedin", permission: ${JSON.stringify(permission)} }).then((r) => r.message)`);

  // nothing is allowed yet: the permissions are the person's own clicks
  for (const p of ['drafts.write', 'posts.publish', 'comments.publish']) console.log('grant', p, '->', await grant(p));

  // (no page is open yet: social_compose has to open LinkedIn itself — once)

  // a real picture, then a draft with it
  const made = await tool('social_make_image', { title: 'Renting a home? Read this first.', footer: 'Rakesh, Advocate' }, 'make an image');
  check('a picture is made', made.ok === true, made);
  const TEXT = 'Renting a home? Read this first.\n\nThree things to check before you sign: the notice period, the deposit and who pays for repairs.\n\n#rentlaw #tenancy';
  const draft = await tool('social_draft', { text: TEXT, image_path: made.data?.path }, 'write a post about renting, three things to check');
  check('the draft is saved with the picture', draft.ok === true && draft.data?.picture === made.data?.name, draft);

  // ONE call does everything up to (not including) Post — on a page that opens its box by itself and covers "Start a post", like the real one
  const composed = await tool('social_compose', { id: draft.data.id }, 'post it on linkedin');
  check('social_compose puts the draft and the picture in the box in one call', composed.ok === true && composed.data?.status === 'ready_not_published' && /added/.test(composed.data?.picture ?? ''), composed);
  await sleep(500);
  check('the page itself has exactly the draft in its box and the picture on it', pageState.editor.replace(/\s+/g, ' ').trim() === draft.data.text.replace(/\s+/g, ' ').trim() && pageState.image === made.data?.name, pageState);
  check('LinkedIn was opened ONCE (not again and again), and nothing is posted yet', opens.filter((u) => u.startsWith('/feed')).length === 1 && posted.length === 0, { opens, posted: posted.length });
  check('"Start a post" was not clicked (the box was already open and covers it)', !(composed.data?.steps ?? []).some((x) => /Start a post/.test(x)), composed.data?.steps);

  // Post: asked first; the model's confirm alone is not enough; only the person's own yes
  const asked = await tool('click_on_page', { text: 'Post' }, 'post it on linkedin');
  check('clicking Post asks, with the exact text, and nothing is posted', asked.ok === false && /Post this on LinkedIn as you\?/.test(JSON.stringify(asked)) && posted.length === 0, { asked, posted });
  const sneaky = await tool('click_on_page', { text: 'Post', confirm: true }, 'hmm let me think about the hashtags');
  check('a confirm without the person\'s yes does not publish', sneaky.ok === false && posted.length === 0, { sneaky, posted });
  const done = await tool('click_on_page', { text: 'Post', confirm: true }, 'yes');
  check('with the person\'s yes the post goes out', done.ok === true && posted.length === 1, { done, posted });
  check('the page got exactly the drafted text and the picture', posted[0]?.kind === 'post' && posted[0]?.text.replace(/\s+/g, ' ') === draft.data.text.replace(/\s+/g, ' ') && posted[0]?.image === made.data?.name, posted[0]);

  // the same text again, even with a yes: refused (never twice)
  check('"Start a post" opens the box again once the first post is out', (await tool('click_on_page', { text: 'Start a post' }, 'again')).ok === true);
  await tool('fill_on_page', { label: 'Text editor for creating content', value: draft.data.text }, 'again');
  const twice = await tool('click_on_page', { text: 'Post', confirm: true }, 'yes');
  check('the same text is not published twice, even with a yes', twice.ok === false && /already published|too soon|Too soon|limit/i.test(JSON.stringify(twice)) && posted.length === 1, { twice, posted: posted.length });

  // a client matter: refused whatever is said
  await tool('fill_on_page', { label: 'Text editor for creating content', value: 'Won O.S. No. 123/2020 for my client today.' }, 'again');
  const matter = await tool('click_on_page', { text: 'Post', confirm: true }, 'yes');
  check('a client matter (a case number) is refused even with a yes', matter.ok === false && /petition number|case/i.test(JSON.stringify(matter)) && posted.length === 1, { matter, posted: posted.length });

  // a comment on someone else's post (the post box is closed first, as a person does: it would cover the page)
  await tool('click_on_page', { text: 'Close the box' }, 'comment on priya');
  await tool('fill_on_page', { label: 'Add a comment…', value: 'Very true, Priya. A written receipt saves a lot of trouble later.' }, 'comment on priya\'s post');
  const cAsk = await tool('click_on_page', { text: 'Comment' }, 'comment on priya\'s post');
  check('a comment is asked about the same way', cAsk.ok === false && /Post this comment on LinkedIn as you\?/.test(JSON.stringify(cAsk)), cAsk);
  const cDone = await tool('click_on_page', { text: 'Comment', confirm: true }, 'yes post it');
  check('and goes out with the person\'s yes', cDone.ok === true && posted.some((x) => x.kind === 'comment' && /written receipt/.test(x.text)), { cDone, posted });

  // the permission is the person's: taken back, nothing publishes
  console.log('revoke posts.publish ->', await revoke('posts.publish'));
  await tool('click_on_page', { text: 'Start a post' }, 'again');
  await tool('fill_on_page', { label: 'Text editor for creating content', value: 'A completely different post about security deposits and receipts.' }, 'again');
  const noPerm = await tool('click_on_page', { text: 'Post', confirm: true }, 'yes');
  check('with the permission taken back, a post is refused with the reason', noPerm.ok === false && /Publish posts|permission/i.test(JSON.stringify(noPerm)) && posted.filter((x) => x.kind === 'post').length === 1, { noPerm, posted: posted.length });

  // what is kept: only fingerprints
  const kept = readFileSync(join(USERDATA, 'social.json'), 'utf8');
  const file = JSON.parse(kept);
  check('the ledger has the post and the comment as fingerprints, and holds no text', file.ledger.length === 2 && !/receipt|Renting|notice period/.test(JSON.stringify(file.ledger)), file.ledger);

  try { unlinkSync(made.data.path); rmdirSync(dirname(made.data.path)); } catch { /* folder not empty or already gone */ }
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  console.log('app log:', logFile);
} catch (e) {
  failures++;
  console.log('ERROR', e instanceof Error ? e.stack : e);
} finally {
  stopApp();
  server.close();
  process.exit(failures === 0 ? 0 : 1);
}
