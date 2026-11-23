// Run from the project folder:  node tests/live/recovery-e2e.mjs      (E2E_MODE=preview to run the built app)
// The real app and its real embedded browser, against a small local internet of made-up sites (*.localhost names, all served from one port):
// a site that works, one that fails twice and then works, an address that now answers "not found" while the site lives on elsewhere (found through
// a local "search engine"), a redirect, a page that lacks what was asked for, a look-alike site, a CAPTCHA, a site that never answers, and downloads
// that finish, break half-way, or turn out to be a web page. The tools are called as the model calls them (window.eya.runLiveTool).
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, createWriteStream, existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
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

// ------------------------------------------------------------------------------------------------- the made-up internet
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4000, 65), Buffer.from('\n%%EOF')]);
const hits = { flaky: 0 };
let searchMode = 'good';
let port = 0;
const html = (res, title, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);
};
const server = createServer((req, res) => {
  const host = String(req.headers.host ?? '').split(':')[0];
  const url = new URL(req.url ?? '/', 'http://x');
  const at = (h) => `http://${h}.localhost:${port}`;
  switch (host) {
    case 'reports-example.localhost':
      if (url.pathname === '/annual') return html(res, 'Annual Report 2024', '<h1>Annual Report 2024</h1><p>The full report is available below as a PDF file.</p><a href="/files/annual-report-2024.pdf">Download Annual Report 2024 (PDF)</a>');
      if (url.pathname === '/files/annual-report-2024.pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="annual-report-2024.pdf"', 'content-length': String(PDF.length) });
        return res.end(PDF);
      }
      return html(res, 'Reports Example — Official Site', '<h1>Reports Example</h1><p>Welcome to the official website of Reports Example, where every public report is kept.</p><a href="/annual">Annual Report 2024</a> <a href="/about">About us</a>');
    case 'reports-old.localhost':
      return html(res, 'Not Found', '<h1>404 Not Found</h1><p>The page you want is not here.</p>', 404);
    case 'flaky.localhost':
      hits.flaky += 1;
      if (hits.flaky <= 4) return req.socket.destroy();
      return html(res, 'Flaky Example', '<h1>Flaky Example</h1><p>This site works now, after a couple of hiccups, and has plenty of text on it.</p><a href="/x">A link</a>');
    case 'moved.localhost':
      res.writeHead(302, { location: `${at('reports-example')}/` });
      return res.end();
    case 'captcha.localhost':
      return html(res, 'Verify', '<main><h1>One more step</h1><div class="g-recaptcha" data-sitekey="t" style="width:304px;height:78px;border:1px solid #999"><iframe title="reCAPTCHA" src="about:blank" style="width:300px;height:74px"></iframe></div><p>I am not a robot</p><button>Continue</button></main>');
    case 'shopdeals-spam.localhost':
      return html(res, 'Best Shop Deals', '<h1>Best Shop Deals</h1><p>Cheap shoes, bags and coats for sale in our online shop today.</p><a href="/s">Shoes</a>');
    case 'search.localhost': {
      const good = `<div class="result"><a class="result__a" href="${at('reports-example')}/">Reports Example — Official Site</a><div class="result__snippet">The official website of Reports Example.</div></div>`;
      const spam = `<div class="result"><a class="result__a" href="${at('shopdeals-spam')}/">Reports Example free coupons and deals</a><div class="result__snippet">coupons for reports example</div></div>`;
      return html(res, 'search', `${searchMode === 'spamonly' ? '' : good}${spam}`);
    }
    case 'dl.localhost':
      if (url.pathname === '/files/broken.pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="broken.pdf"', 'content-length': '900000' });
        res.write(Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(3000, 66)]));
        return setTimeout(() => req.socket.destroy(), 400);
      }
      if (url.pathname === '/files/fake.pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="fake.pdf"' });
        return res.end('<!DOCTYPE html><html><body>Please log in to download this file.</body></html>');
      }
      return html(res, 'Downloads Example', '<h1>Downloads Example</h1><a href="/files/broken.pdf">Download the broken report (PDF)</a> <a href="/files/fake.pdf">Download the members report (PDF)</a>');
    case 'hang.localhost':
      return undefined;
    case 'movierulz.localhost':
      return html(res, 'Movie Downloads', '<h1>Movie Downloads</h1><a href="/f.mp4">Download 720p</a>');
    default:
      return html(res, 'Not Found', '<h1>404</h1>', 404);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
port = server.address().port;
const at = (h, path = '/') => `http://${h}.localhost:${port}${path}`;

const userData = mkdtempSync(join(tmpdir(), 'eya-rec-'));
const downloads = mkdtempSync(join(tmpdir(), 'eya-rec-dl-'));
const logPath = join(OUT, `rec-app-${Date.now()}.log`);
const log = createWriteStream(logPath);
const env = {
  ...process.env,
  EYA_GEMINI_API_KEY: 'AIzaSyBPBPBPBPBPBPBPBPBPBPBPBPBPBPBPBP1',
  EYA_OLLAMA_URL: 'http://127.0.0.1:1',
  EYA_BRIDGE_PORT: '47835',
  EYA_BROWSER_DOWNLOADS: downloads,
  EYA_BROWSER_NAV_TIMEOUT_MS: '2500',
  EYA_TEST_SEARCH_URL: `http://search.localhost:${port}/search?q={q}`,
  EYA_NO_BROWSER_LAUNCH: '1',
  EYA_NO_MIC: '1',
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
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 120000 });
    if (r.result?.exceptionDetails) throw new Error('page error: ' + String(r.result.exceptionDetails.exception?.description ?? '').slice(0, 400));
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
  throw new Error('the debug window never appeared');
}

try {
  const main = await connectMain();
  const evalIn = main.evalIn;
  await sleep(8000);
  await evalIn('window.eya.setWindowMode("app")');
  await main.send('Page.bringToFront');
  await sleep(2500);
  await evalIn(`[...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === 'Browser').click()`);
  await sleep(1500);
  const rawTool = (name, args, heard) => evalIn(`window.eya.runLiveTool(${JSON.stringify({ name, args, heard })}).then(r => r.content)`);
  const tool = async (name, args, heard = 'open the site and get the report for me') => {
    const raw = await rawTool(name, args, heard);
    try { return JSON.parse(raw); } catch { return { ok: false, error: String(raw) }; }
  };
  const panel = () => evalIn('window.eya.getBrowserPanel()');

  // ------------------------------------------------------------------ 1. opens first time
  let r = await tool('find_and_open_website', { url: at('reports-example'), name: 'Reports Example' });
  check('1. a site that opens on the first attempt: opened, checked, no search needed', r.ok === true && r.data?.recovery?.via === 'known' && r.data?.recovery?.verified === true && /Reports Example/.test(r.data?.currentPage?.title ?? ''), r);

  // ------------------------------------------------------------------ 2. a temporary failure, then it works
  r = await tool('find_and_open_website', { url: at('flaky') });
  check('2. a site that drops the first four visits (a hiccup) and then works is opened by trying again, not given up on', r.ok === true && hits.flaky >= 3 && /Flaky Example/.test(r.data?.currentPage?.title ?? ''), { r, visits: hits.flaky });

  // ------------------------------------------------------------------ 3. an outdated address, a verified alternative
  r = await tool('find_and_open_website', { url: at('reports-old'), name: 'Reports Example' });
  check('3. an address that now says "not found": the current address is looked up, checked, and opened', r.ok === true && r.data?.recovery?.via === 'alternative' && r.data?.recovery?.addressChanged === true && /reports-example\.localhost/.test(r.data?.recovery?.finalUrl ?? ''), r);
  check('   and it says what happened, in words', /did not work/.test((r.data?.recovery?.notes ?? []).join(' ')), r.data?.recovery?.notes);
  const p3 = await panel();
  check('   "Your Agent at Work" shows the steps in plain words', p3.log.some((l) => /saved address is unavailable/.test(l.text)) && p3.steps.some((s) => /The page is open/.test(s.text)), { log: p3.log.slice(-8).map((l) => l.text), steps: p3.steps.slice(-6).map((s) => s.text) });

  // ------------------------------------------------------------------ 4. a redirect to the right place
  r = await tool('find_and_open_website', { url: at('moved'), name: 'Reports Example' });
  check('4. a redirect to the correct destination is followed and checked', r.ok === true && r.data?.recovery?.via === 'redirect' && /reports-example/.test(r.data?.currentPage?.url ?? ''), r);

  // ------------------------------------------------------------------ 5. loads, but not what was asked for
  r = await tool('find_and_open_website', { url: at('reports-example'), name: 'Reports Example', expect: 'tax tables, budget speech' });
  check('5. a page that loads but lacks what was asked for is not called success', r.ok === false && /could not find/.test(r.error ?? ''), r);

  // ------------------------------------------------------------------ 6. a search result that is the wrong website
  searchMode = 'spamonly';
  r = await tool('find_and_open_website', { url: at('reports-old'), name: 'Reports Example' });
  check('6. a search result that points to the wrong website is opened, found to be something else, and not used', r.ok === false && /was not the site/.test((r.data?.recovery?.notes ?? []).join(' ')), r);
  searchMode = 'good';

  // ------------------------------------------------------------------ 7. a CAPTCHA
  r = await tool('find_and_open_website', { url: at('captcha'), name: 'Verify Example' });
  check('7. a CAPTCHA is handed to the person: nothing is tried to get past it', r.ok === false && r.data?.needsUser === true && /will not try to get past it/.test(r.error ?? ''), r);

  // ------------------------------------------------------------------ 8. never answers: stops at the limits
  const started = Date.now();
  r = await tool('find_and_open_website', { url: at('hang'), name: 'Hang Example' });
  check('8. a site that never answers stops at the limits, with a reason, not forever, and does not end up on a different site by mistake', r.ok === false && Date.now() - started < 80_000 && !/Reports Example — Official/.test(JSON.stringify(r.data?.currentPage ?? '')), { r, ms: Date.now() - started });

  // ------------------------------------------------------------------ 8b. no site named: only what the person wants
  r = await tool('find_and_open_website', { keywords: 'reports example annual report' }, 'find the annual report of reports example');
  check('12. no site named, only what the person wants: the web is searched, the results are checked, and the page that really has it is opened', r.ok === true && r.data?.recovery?.via === 'search' && /reports-example/.test(r.data?.currentPage?.url ?? ''), r);
  r = await tool('find_and_open_website', { url: 'reports example annual report' }, 'find the annual report of reports example');
  check('    words put where an address belongs are taken as what to look for', r.ok === true && r.data?.recovery?.via === 'search', r);
  r = await tool('find_and_open_website', { keywords: 'zebra giraffe quantum pottery' }, 'find something that is not there');
  check('    when nothing has it, it says what it tried instead of inventing a site', r.ok === false && /none of them had it|found nothing/.test(r.error ?? ''), r);

  // ------------------------------------------------------------------ 8c. an address typed in a request that no longer answers is not opened blindly
  await evalIn(`window.eya.submit({ text: ${JSON.stringify('open ' + at('reports-old'))}, source: 'text', requestId: 'dead-link-1' }).then((x) => x.spoken).catch(() => '')`);
  await sleep(500);
  const appLog = readFileSync(logPath, 'utf8');
  check('13. a typed address that is not answering is not opened blindly in the browser: the assistant takes it to work out the right one', /an address is not answering; the assistant takes it/.test(appLog), appLog.split('\n').filter((l) => /local|address/.test(l)).slice(-5));

  // ------------------------------------------------------------------ 9. a download, from the question to the checked file
  const args = { what: 'the 2024 annual report', url: at('reports-example'), type: 'pdf' };
  r = await tool('download_from_site', args, 'go to the reports site and download the annual report');
  check('9. the download is found through the site, and the person is asked first (nothing is downloaded yet)', r.ok === false && r.summary === 'needs confirmation' && /annual-report-2024\.pdf/.test(r.error ?? '') && readdirSync(downloads).length === 0, r);
  r = await tool('download_from_site', { ...args, confirm: true }, 'yes download it');
  check('   after the yes, it downloads, waits, checks the file and says where it is', r.ok === true && r.summary === 'downloaded' && r.data?.verified === true && existsSync(r.data?.path ?? '') && statSync(r.data.path).size === PDF.length && readFileSync(r.data.path).subarray(0, 4).toString() === '%PDF', r);

  // ------------------------------------------------------------------ 10. a download that breaks half-way, and a page saved as a file
  const dl = { what: 'the broken report', url: at('dl'), type: 'pdf' };
  await tool('download_from_site', dl);
  r = await tool('download_from_site', { ...dl, confirm: true });
  check('10. a download that starts but never finishes is reported as failed, not as downloaded', r.ok === false && /did not finish|stopped sending|not verified/.test(r.error ?? '') && r.summary !== 'downloaded', r);
  const fake = { what: 'the members report', url: at('dl'), type: 'pdf' };
  await tool('download_from_site', fake);
  r = await tool('download_from_site', { ...fake, confirm: true });
  check('    a web page that was saved under a file\'s name is not accepted as the file', r.ok === false && r.summary === 'file not verified' && /web page/.test(r.error ?? ''), r);

  // ------------------------------------------------------------------ 11. a site that gives films away: no download
  r = await tool('download_from_site', { what: 'a new film', url: at('movierulz') });
  check('11. no download from a site that gives films away without permission', r.ok === false && r.summary === 'not allowed' && /without permission/.test(r.error ?? ''), r);
} catch (e) {
  failures++;
  console.log('FAIL  the run stopped:', e && e.message ? e.message : e);
} finally {
  stopApp();
  server.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  console.log('the app log is in', OUT);
  process.exit(failures === 0 ? 0 : 1);
}
