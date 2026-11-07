import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTACHMENTS_MARKER,
  ATTACH_ACCEPT,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  attachmentInfo,
  attachmentsHint,
  cleanAttachments,
  whyNotAttachable,
} from '../src/shared/attachments';
import { docxText } from '../src/main/tools/impl/docx';
import { purgeAttachments, safeAttachmentName, saveAttachment } from '../src/main/files/attachmentsIpc';
import { AttachedFiles } from '../src/main/files/attachedFiles';
import { createDocumentTool } from '../src/main/tools/impl/documentTools';
import type { DocumentBrain } from '../src/main/tools/impl/documentTools';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { ConversationContext } from '../src/main/context/ConversationContext';
import { ChainedAIProvider } from '../src/main/providers/ai/ChainedAIProvider';
import { LocalAiDeclinedError, OllamaAIProvider, OllamaError } from '../src/main/providers/ai/OllamaAIProvider';
import type { AIChatMessage, AICompletion, AIProvider } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import type { AgentRequest } from '../src/shared/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eya-attach-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A real .docx (a zip with word/document.xml), built here: stored or deflated. */
function makeDocx(xml: string, method: 0 | 8 = 8): Buffer {
  const name = Buffer.from('word/document.xml');
  const raw = Buffer.from(xml, 'utf8');
  const data = method === 8 ? deflateRawSync(raw) : raw;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12);
  eocd.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}

describe('what can be attached', () => {
  it('knows the kinds Eya can read, whatever the capitals', () => {
    expect(attachmentInfo('Photo.JPG')).toMatchObject({ kind: 'image', mime: 'image/jpeg' });
    expect(attachmentInfo('c:\\x\\order.pdf')).toMatchObject({ kind: 'document', mime: 'application/pdf' });
    expect(attachmentInfo('letter.docx')?.extractText).toBe(true);
    expect(attachmentInfo('notes.txt')).toMatchObject({ kind: 'document', mime: 'text/plain' });
    expect(attachmentInfo('voice.mp3')).toMatchObject({ kind: 'audio' });
    expect(attachmentInfo('clip.mp4')).toMatchObject({ kind: 'video', mime: 'video/mp4' });
    for (const no of ['budget.xlsx', 'deck.pptx', 'setup.exe', 'archive.zip', 'noextension', '.hidden']) expect(attachmentInfo(no), no).toBeNull();
  });

  it('offers the file picker exactly what can be read', () => {
    for (const ext of ['.pdf', '.png', '.docx', '.mp3', '.mp4', '.txt']) expect(ATTACH_ACCEPT.split(',')).toContain(ext);
    expect(ATTACH_ACCEPT).not.toContain('.xlsx');
    expect(ATTACH_ACCEPT).not.toContain('.exe');
  });

  it('says why a file cannot go, in words, and never pretends', () => {
    expect(whyNotAttachable('a.pdf', 1000)).toBeNull();
    expect(whyNotAttachable('budget.xlsx', 1000)).toMatch(/cannot read \.xlsx files yet\. Save it as a PDF or a \.docx/);
    expect(whyNotAttachable('setup.exe', 1000)).toMatch(/cannot read \.exe files/);
    expect(whyNotAttachable('a.mp4', MAX_ATTACHMENT_BYTES + 1)).toMatch(/video is bigger than the 14 MB/);
    expect(whyNotAttachable('a.pdf', 0)).toBe('That file is empty.');
  });

  it('cleans what the window sends: known kinds only, at most eight, nothing odd', () => {
    const ok = { name: 'a.pdf', path: 'C:\\x\\a.pdf', kind: 'document', size: 10 };
    expect(cleanAttachments([ok, { ...ok, kind: 'program' }, { ...ok, name: '' }, { ...ok, path: 7 }, null, 'x', { ...ok, size: -5 }])).toEqual([ok, { ...ok, size: 0 }]);
    expect(cleanAttachments('nope')).toEqual([]);
    expect(cleanAttachments(Array.from({ length: 20 }, () => ok))).toHaveLength(MAX_ATTACHMENTS);
  });

  it('tells the AI where each file is and not to guess what is in it', () => {
    const hint = attachmentsHint([{ name: 'order.pdf', path: 'C:\\x\\order.pdf', kind: 'document', size: 10 }]);
    expect(hint.startsWith(ATTACHMENTS_MARKER)).toBe(true);
    expect(hint).toContain('"order.pdf" (document) at C:\\x\\order.pdf');
    expect(hint).toContain('analyze_document');
    expect(hint).toMatch(/Do not say what is in a file you have not read/);
  });
});

describe('the words of a Word document', () => {
  it('takes them out, paragraph by paragraph, tabs and entities included', () => {
    const xml = '<w:document><w:body><w:p><w:r><w:t>Dear Sir,</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Rent &amp; deposit</w:t></w:r><w:r><w:tab/><w:t>Rs. 5,000</w:t></w:r></w:p><w:p><w:r><w:t>Caf&#233;</w:t></w:r></w:p></w:body></w:document>';
    for (const method of [0, 8] as const) expect(docxText(makeDocx(xml, method))).toBe('Dear Sir,\nRent & deposit\tRs. 5,000\nCafé');
  });

  it('is null for anything that is not a readable .docx', () => {
    expect(docxText(Buffer.from('this is not a zip'))).toBeNull();
    expect(docxText(Buffer.alloc(0))).toBeNull();
    const damaged = makeDocx('<w:p><w:t>x</w:t></w:p>');
    expect(docxText(damaged.subarray(0, damaged.length - 30))).toBeNull();
  });
});

describe('keeping a pasted file', () => {
  it('keeps it under a safe name in a folder of its own, and refuses what cannot be read or is too big', async () => {
    const saved = await saveAttachment(dir, '..\\..\\evil:name?.png', Buffer.from('png-bytes'));
    expect(saved.ok).toBe(true);
    expect(saved.path?.startsWith(dir)).toBe(true);
    expect(saved.path).not.toContain('..');
    expect(readFileSync(saved.path as string, 'utf8')).toBe('png-bytes');
    expect(safeAttachmentName('a/b\\c:d*e.pdf')).toBe('c_d_e.pdf');
    expect(safeAttachmentName('')).toBe('attachment');
    expect((await saveAttachment(dir, 'setup.exe', Buffer.from('x'))).ok).toBe(false);
    expect((await saveAttachment(dir, 'a.png', Buffer.alloc(0))).ok).toBe(false);
    expect((await saveAttachment(dir, 'a.png', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))).ok).toBe(false);
  });

  it('clears kept files after a few days, and leaves newer ones', async () => {
    const old = (await saveAttachment(dir, 'old.png', Buffer.from('x'))).path as string;
    const fresh = (await saveAttachment(dir, 'new.png', Buffer.from('x'))).path as string;
    const oldFolder = join(old, '..');
    const past = new Date(Date.now() - 5 * 24 * 3_600_000);
    utimesSync(oldFolder, past, past);
    expect(await purgeAttachments(dir)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(await purgeAttachments(join(dir, 'missing'))).toBe(0);
  });
});

describe('reading an attached file', () => {
  let folders: KnownFolders;
  beforeEach(() => {
    folders = { home: dir, downloads: dir, desktop: dir, documents: dir, pictures: dir, videos: dir, music: dir, temp: dir };
  });
  function brain(): { brain: DocumentBrain; calls: Array<{ mime: string; bytes: Buffer; question: string }> } {
    const calls: Array<{ mime: string; bytes: Buffer; question: string }> = [];
    return {
      calls,
      brain: {
        hasKey: () => true,
        analyzeFile: async (data, mime, question) => (calls.push({ mime, bytes: Buffer.from(data, 'base64'), question }), 'It says hello.'),
        groundedSearch: async () => ({ text: '', sources: [] }),
      },
    };
  }

  it('sends audio and video as what they are, a Word file as its words, and a kept picture without the folder rules', async () => {
    const kept = join(dir, 'attachments');
    mkdirSync(join(kept, 'x1'), { recursive: true });
    const pic = join(kept, 'x1', 'pasted.png');
    writeFileSync(pic, 'PNG!');
    const elsewhere = join(dir, 'Downloads');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'talk.mp3'), 'MP3!');
    writeFileSync(join(elsewhere, 'clip.mp4'), 'MP4!');
    writeFileSync(join(elsewhere, 'letter.docx'), makeDocx('<w:p><w:r><w:t>Hello from Word</w:t></w:r></w:p>'));
    const { brain: b, calls } = brain();
    const tool = createDocumentTool(folders, b, { attachmentsDir: kept });
    for (const [file, mime] of [[join(elsewhere, 'talk.mp3'), 'audio/mp3'], [join(elsewhere, 'clip.mp4'), 'video/mp4'], [pic, 'image/png']] as const) {
      const r = await tool.execute({ path: file, question: 'What is this?' });
      expect(r.ok, `${file}: ${r.error}`).toBe(true);
      expect(calls[calls.length - 1]?.mime).toBe(mime);
    }
    const word = await tool.execute({ path: join(elsewhere, 'letter.docx'), question: 'Summarize' });
    expect(word.ok).toBe(true);
    expect(calls[calls.length - 1]?.mime).toBe('text/plain');
    expect(calls[calls.length - 1]?.bytes.toString('utf8')).toBe('Hello from Word');
    expect(calls[calls.length - 1]?.question).toBe('Summarize');
  });

  it('reads a file the person attached even from a folder that is otherwise protected, but only that file, and never a secret', async () => {
    const hidden = join(dir, 'AppData', 'Local', 'Temp');
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, 'mail-attachment.txt'), 'From an e-mail.');
    writeFileSync(join(hidden, 'neighbour.txt'), 'Not attached.');
    writeFileSync(join(hidden, 'secrets.txt'), 'hunter2');
    const { brain: b, calls } = brain();
    const attached = new AttachedFiles();
    const tool = createDocumentTool(folders, b, { attached });
    // without the attachment the folder rules say no (so the test proves what it is about)
    expect((await tool.execute({ path: join(hidden, 'mail-attachment.txt'), question: 'Summarize' })).ok).toBe(false);
    attached.allow([join(hidden, 'mail-attachment.txt'), join(hidden, 'secrets.txt')]);
    const ok = await tool.execute({ path: join(hidden, 'mail-attachment.txt'), question: 'Summarize' });
    expect(ok.ok, ok.error).toBe(true);
    expect(calls[0]?.bytes.toString('utf8')).toBe('From an e-mail.');
    // a different spelling of the same path is the same file (Windows ignores case)
    if (process.platform === 'win32') expect((await tool.execute({ path: join(hidden, 'MAIL-ATTACHMENT.TXT'), question: 'Summarize' })).ok).toBe(true);
    // the file next to it was not attached, a secret is refused even when attached
    expect((await tool.execute({ path: join(hidden, 'neighbour.txt'), question: 'Summarize' })).ok).toBe(false);
    expect((await tool.execute({ path: join(hidden, 'secrets.txt'), question: 'Summarize' })).ok).toBe(false);
    expect(calls.map((c) => c.bytes.toString('utf8'))).not.toContain('hunter2');
  });

  it('forgets the oldest attached paths after a while', () => {
    const attached = new AttachedFiles();
    attached.allow(Array.from({ length: 205 }, (_, i) => join(dir, `f${i}.txt`)));
    expect(attached.has(join(dir, 'f0.txt'))).toBe(false);
    expect(attached.has(join(dir, 'f204.txt'))).toBe(true);
    expect(attached.has('')).toBe(false);
  });

  it('says so when a Word file cannot be read, and does not send anything', async () => {
    writeFileSync(join(dir, 'broken.docx'), 'not a zip');
    const { brain: b, calls } = brain();
    const r = await createDocumentTool(folders, b).execute({ path: join(dir, 'broken.docx'), question: 'Summarize' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not read the words in that Word file/);
    expect(calls).toEqual([]);
  });
});

class Say implements AIProvider {
  readonly name = 'scripted';
  readonly seen: AIChatMessage[][] = [];
  isReady = (): boolean => true;
  async complete(messages: readonly AIChatMessage[]): Promise<AICompletion> {
    this.seen.push([...messages]);
    return { text: 'ok', toolCalls: [] };
  }
}
const silent: TTSProvider = { name: 'fake', init: async () => undefined, speak: async () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };

describe('a message with files attached, in the engine', () => {
  function engine(ai: AIProvider, opened: string[]): AgentEngine {
    const tools = new ToolRegistry();
    tools.register({ schema: { name: 'open_application', description: 'open', args: { name: { type: 'string', required: true } }, status: 'x' }, execute: async (a) => (opened.push(String(a['name'])), { ok: true, summary: 'open', data: { app: 'notepad' } }) });
    return new AgentEngine({ router: new IntentRouter(), tools, composer: new ResponseComposer(), tts: silent, context: new ConversationContext(), ai, now: () => new Date('2026-10-23T10:00:00Z') });
  }
  const req = (text: string, attachments?: AgentRequest['attachments']): AgentRequest => ({ text, source: 'text', requestId: 'r1', ...(attachments !== undefined ? { attachments } : {}) });
  const FILE = { name: 'order.pdf', path: 'C:\\Users\\me\\Downloads\\order.pdf', kind: 'document' as const, size: 1234 };

  it('goes to the AI, which is told where the file is; the quick commands never see it', async () => {
    const ai = new Say();
    const opened: string[] = [];
    const e = engine(ai, opened);
    await e.handle(req('open notepad', [FILE]), () => undefined);
    expect(opened).toEqual([]); // "open notepad" is not done: it was said with a file
    const system = ai.seen[0]?.[0]?.content ?? '';
    expect(system).toContain(ATTACHMENTS_MARKER);
    expect(system).toContain(FILE.path);
    expect(system).toContain('analyze_document');
    // the user's own words reach the AI untouched
    expect(ai.seen[0]?.[ai.seen[0].length - 1]).toEqual({ role: 'user', content: 'open notepad' });
    // without a file the same words are the quick command, as always
    await e.handle(req('open notepad'), () => undefined);
    expect(opened).toEqual(['notepad']);
    expect(ai.seen).toHaveLength(1);
  });

  it('notes the attached files so the document tool may read them where they are', async () => {
    const attached = new AttachedFiles();
    const tools = new ToolRegistry();
    const e = new AgentEngine({ router: new IntentRouter(), tools, composer: new ResponseComposer(), tts: silent, context: new ConversationContext(), ai: new Say(), attached, now: () => new Date('2026-10-23T10:00:00Z') });
    await e.handle(req('what does it say', [FILE]), () => undefined);
    expect(attached.has(FILE.path)).toBe(true);
    await e.handle(req('hello there'), () => undefined);
    expect(attached.has('C:\\Users\\me\\Downloads\\other.pdf')).toBe(false);
  });

  it('remembers the file for the next message ("and the second page?")', async () => {
    const ai = new Say();
    const e = engine(ai, []);
    await e.handle(req('what is the total?', [FILE]), () => undefined);
    await e.handle(req('and the date?'), () => undefined);
    const second = ai.seen[1] ?? [];
    expect(second[0]?.content).toContain(FILE.path); // "the file most recently touched is …"
    expect(second.some((m) => m.role === 'user' && m.content.includes('[attached: order.pdf]'))).toBe(true);
  });
});

describe('the local AI and attached files', () => {
  const withFile: AIChatMessage[] = [
    { role: 'system', content: attachmentsHint([{ name: 'a.pdf', path: 'C:\\a.pdf', kind: 'document', size: 5 }]) },
    { role: 'user', content: 'what does it say' },
  ];

  it('hands the request to a cloud AI that can read the file, or says it cannot, and never answers as if it had read it', async () => {
    const p = new OllamaAIProvider({ baseUrl: 'http://127.0.0.1:1' });
    expect(await p.complete(withFile, [], { failFast: true }).catch((e: unknown) => e)).toBeInstanceOf(LocalAiDeclinedError);
    const only = new OllamaAIProvider({ baseUrl: 'http://127.0.0.1:1', mayHandOver: () => false });
    const err = (await only.complete(withFile, [], { failFast: true }).catch((e: unknown) => e)) as OllamaError;
    expect(err).toBeInstanceOf(OllamaError);
    expect(err.kind).toBe('cannot-read-files');
    expect(err.userMessage).toMatch(/cannot read attached files/);
    // alone (nothing to hand it to): the same plain message
    const alone = (await p.complete(withFile, []).catch((e: unknown) => e)) as OllamaError;
    expect(alone.kind).toBe('cannot-read-files');
  });

  it('in the chain, "Local AI first" gives the file to the cloud AI', async () => {
    const cloud: AIProvider = { name: 'gemini', isReady: () => true, complete: async () => ({ text: 'read it', toolCalls: [] }) };
    const local = new OllamaAIProvider({ baseUrl: 'http://127.0.0.1:1' });
    const chain = new ChainedAIProvider([cloud, local]);
    chain.setPreferred(local);
    expect((await chain.complete(withFile, [])).text).toBe('read it');
  });
});
