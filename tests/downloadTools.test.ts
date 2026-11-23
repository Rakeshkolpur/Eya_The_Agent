import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDownloadTool, isPrivateHost, nameFromDisposition, safeFileName } from '../src/main/tools/impl/downloadTools';
import type { DownloadNotice } from '../src/main/tools/impl/downloadTools';
import type { KnownFolders } from '../src/main/security/pathPolicy';

let dir: string;
let folders: KnownFolders;
let server: Server;
let base: string;
let requests: string[];

const PDF = Buffer.from('%PDF-1.4 pretend document');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eya-dl-'));
  folders = { home: dir, desktop: join(dir, 'Desktop'), documents: join(dir, 'Documents'), downloads: join(dir, 'Downloads'), pictures: dir, videos: dir, music: dir, temp: dir };
  requests = [];
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const url = req.url ?? '';
    if (url === '/report.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': PDF.length });
      res.end(PDF);
    } else if (url === '/named') {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Quarterly Report.pdf"' });
      res.end(PDF);
    } else if (url === '/evil') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="setup.exe"' });
      res.end('MZ');
    } else if (url === '/traversal') {
      res.writeHead(200, { 'content-disposition': 'attachment; filename="..\\..\\Startup\\x.txt"' });
      res.end('hi');
    } else if (url === '/missing') {
      res.writeHead(404);
      res.end('no');
    } else if (url === '/redirect') {
      res.writeHead(302, { location: '/report.pdf' });
      res.end();
    } else if (url === '/big') {
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.write(Buffer.alloc(2048));
      setTimeout(() => res.end(Buffer.alloc(2048)), 250);
    } else if (url === '/stall') {
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.write(Buffer.alloc(100)); // then nothing, ever
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('plain');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const tool = (options: Partial<Parameters<typeof createDownloadTool>[0]> = {}) =>
  createDownloadTool({ folders, allowPrivateHosts: true, markFromWeb: false, waitMs: 3000, ...options });
const downloads = (): string[] => (existsSync(folders.downloads) ? readdirSync(folders.downloads) : []);

describe('download_file', () => {
  it('downloads a file into Downloads under the name in the address', async () => {
    const result = await tool().execute({ url: `${base}/report.pdf`, confirm: true });
    expect(result.ok).toBe(true);
    expect(result.data?.['name']).toBe('report.pdf');
    expect(result.data?.['sizeBytes']).toBe(PDF.length);
    expect(readFileSync(join(folders.downloads, 'report.pdf'))).toEqual(PDF);
    expect(downloads()).toEqual(['report.pdf']); // no half-written file left behind
  });

  it('uses the name the server asks for, and follows a redirect', async () => {
    const named = await tool().execute({ url: `${base}/named`, confirm: true });
    expect(named.data?.['name']).toBe('Quarterly Report.pdf');
    const redirected = await tool().execute({ url: `${base}/redirect`, confirm: true });
    expect(redirected.ok).toBe(true);
    expect(redirected.data?.['name']).toBe('report.pdf');
  });

  it('never overwrites: a second copy gets a number', async () => {
    await tool().execute({ url: `${base}/report.pdf`, confirm: true });
    const again = await tool().execute({ url: `${base}/report.pdf`, confirm: true });
    expect(again.data?.['name']).toBe('report (1).pdf');
    expect(downloads().sort()).toEqual(['report (1).pdf', 'report.pdf']);
  });

  it('gives a file with no name or ending one from its type', async () => {
    const result = await tool().execute({ url: `${base}/`, confirm: true });
    expect(result.ok).toBe(true);
    expect(result.data?.['name']).toBe('download from 127 0 0 1.txt');
  });

  it('saves under the name asked for', async () => {
    const result = await tool().execute({ url: `${base}/report.pdf`, filename: 'mine.pdf', confirm: true });
    expect(result.data?.['name']).toBe('mine.pdf');
    expect((await tool().execute({ url: `${base}/report.pdf`, filename: '..\\x.pdf', confirm: true })).summary).toBe('bad name');
  });

  it('asks first, and downloads nothing without the user\'s yes', async () => {
    const result = await tool().execute({ url: `${base}/report.pdf` });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('needs confirmation');
    expect(result.data).toMatchObject({ status: 'permission_required', action: 'download_file' });
    expect(requests).toEqual([]); // not even a request was made
    expect(downloads()).toEqual([]);
    expect((await tool().execute({ url: `${base}/report.pdf`, confirm: false })).summary).toBe('needs confirmation');
  });

  it('refuses programs and scripts, whether the address or the server names them', async () => {
    expect((await tool().execute({ url: 'https://example.com/setup.exe', confirm: true })).summary).toBe('program refused');
    expect((await tool().execute({ url: 'https://example.com/run.ps1', confirm: true })).summary).toBe('program refused');
    const sneaky = await tool().execute({ url: `${base}/evil`, confirm: true });
    expect(sneaky.summary).toBe('program refused');
    expect(downloads()).toEqual([]);
  });

  it('cannot be tricked into writing outside Downloads', async () => {
    const result = await tool().execute({ url: `${base}/traversal`, confirm: true });
    expect(result.ok).toBe(true);
    expect(result.data?.['name']).toBe('x.txt');
    expect(readdirSync(folders.downloads)).toEqual(['x.txt']);
    expect(existsSync(join(dir, 'Startup'))).toBe(false);
  });

  it('only takes web addresses', async () => {
    for (const url of ['file:///C:/Windows/win.ini', 'ftp://example.com/a.zip', 'javascript:alert(1)', 'https://user:pw@example.com/a.pdf', 'not a url']) {
      expect((await tool().execute({ url, confirm: true })).summary, url).toBe('bad url');
    }
  });

  it('will not fetch from this computer or the local network', async () => {
    const strict = createDownloadTool({ folders, markFromWeb: false });
    for (const url of ['http://localhost/a.pdf', 'http://127.0.0.1:8080/a.pdf', 'http://192.168.1.1/a.pdf', 'http://10.0.0.5/a.pdf', 'http://[::1]/a.pdf', 'http://printer.local/a.pdf']) {
      expect((await strict.execute({ url, confirm: true })).summary, url).toBe('not allowed');
    }
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('172.32.0.1')).toBe(false);
    expect(isPrivateHost('172.16.0.1')).toBe(true);
  });

  it('reports a missing file, an unreachable server and a file that is too big', async () => {
    expect((await tool().execute({ url: `${base}/missing`, confirm: true })).error).toMatch(/error 404/);
    const closed = createDownloadTool({ folders, allowPrivateHosts: true, markFromWeb: false, connectMs: 500 });
    expect((await closed.execute({ url: 'http://127.0.0.1:1/x.pdf', confirm: true })).summary).toBe('could not connect');
    const small = tool({ maxBytes: 10 });
    expect((await small.execute({ url: `${base}/report.pdf`, confirm: true })).summary).toBe('too large');
    const tooMuch = await tool({ maxBytes: 3000 }).execute({ url: `${base}/big`, confirm: true });
    expect(tooMuch.ok).toBe(false);
    expect(downloads()).toEqual([]); // and nothing half-written is left
  });

  it('keeps going in the background when it is slow, then says it is done', async () => {
    const notices: DownloadNotice[] = [];
    const slow = tool({ waitMs: 30, notify: (n) => notices.push(n) });
    const result = await slow.execute({ url: `${base}/big`, confirm: true });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ inProgress: true, name: 'big.zip' });
    expect(downloads()).toEqual(['big.zip.eya-part']); // not mistaken for a finished file while it is arriving
    await new Promise((r) => setTimeout(r, 600));
    expect(downloads()).toEqual(['big.zip']);
    expect(notices).toEqual([{ name: 'big.zip', ok: true }]);
  });

  it('gives up on a download that stops sending, and cleans up', async () => {
    const notices: DownloadNotice[] = [];
    const stalls = tool({ waitMs: 20, stallMs: 150, notify: (n) => notices.push(n) });
    const result = await stalls.execute({ url: `${base}/stall`, confirm: true });
    expect(result.data).toMatchObject({ inProgress: true });
    await new Promise((r) => setTimeout(r, 500));
    expect(downloads()).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.ok).toBe(false);
  });

  it('limits how many run at once', async () => {
    const busy = tool({ waitMs: 20, maxConcurrent: 1, stallMs: 2000 });
    expect((await busy.execute({ url: `${base}/big`, confirm: true })).ok).toBe(true);
    expect((await busy.execute({ url: `${base}/report.pdf`, confirm: true })).summary).toBe('busy');
    await new Promise((r) => setTimeout(r, 600));
    expect((await busy.execute({ url: `${base}/report.pdf`, confirm: true })).ok).toBe(true);
  });

  it('marks the file as coming from the internet on Windows', async () => {
    if (process.platform !== 'win32') return;
    const marked = createDownloadTool({ folders, allowPrivateHosts: true, markFromWeb: true, waitMs: 3000 });
    const result = await marked.execute({ url: `${base}/report.pdf`, confirm: true });
    const path = String(result.data?.['path']);
    expect(readFileSync(`${path}:Zone.Identifier`, 'utf8')).toMatch(/ZoneId=3/);
  });
});

describe('download helpers', () => {
  it('reads the file name from Content-Disposition', () => {
    expect(nameFromDisposition('attachment; filename="a b.pdf"')).toBe('a b.pdf');
    expect(nameFromDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")).toBe('résumé.pdf');
    expect(nameFromDisposition('attachment; filename=plain.txt')).toBe('plain.txt');
    expect(nameFromDisposition(null)).toBeUndefined();
    expect(nameFromDisposition('inline')).toBeUndefined();
  });

  it('makes any candidate a safe file name', () => {
    expect(safeFileName('/files/a%20b.pdf', null, 'x.com')).toBe('a b.pdf');
    expect(safeFileName('..\\..\\evil.txt', null, 'x.com')).toBe('evil.txt');
    expect(safeFileName('a<b>:c?.txt', null, 'x.com')).toBe('a_b__c_.txt');
    expect(safeFileName('', 'application/pdf', 'www.example.com')).toBe('download from example com.pdf');
    expect(safeFileName('con.txt', null, 'x.com')).toBe('download from x com'); // a name Windows reserves is not used
    expect(safeFileName('/files/report', 'application/pdf', 'x.com')).toBe('report.pdf'); // no ending: taken from the type
  });
});
