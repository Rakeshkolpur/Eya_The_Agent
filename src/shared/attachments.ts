/**
 * Files attached to a message: which kinds Eya can actually read, how big, and what to say about the rest. One table for the window (what the
 * file picker offers, what is refused on the spot) and for the main process (what the reader is willing to open), so they cannot disagree.
 *
 * Reading is done by the same tool as everywhere else in Eya (analyze_document: the file is sent to Gemini to be read, so it needs a Gemini key),
 * except Word documents, whose text is taken out on this PC first. Nothing here pretends a model can read what it cannot.
 */

export type AttachmentKind = 'image' | 'document' | 'audio' | 'video';

/** What travels with a request: where the file is (a copy Eya keeps for a pasted picture, or the file itself) and what it is. */
export interface AttachmentRef {
  readonly name: string;
  readonly path: string;
  readonly kind: AttachmentKind;
  readonly size: number;
}

/** What the conversation shows next to a message (no path: the screen never needs it). */
export interface AttachmentChip {
  readonly name: string;
  readonly kind: AttachmentKind;
  readonly size: number;
}

/** Inline reading is capped (Gemini takes about 20 MB in one request, and base64 adds a third). */
export const MAX_ATTACHMENT_BYTES = 14 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;

export interface AttachmentInfo {
  readonly kind: AttachmentKind;
  readonly mime: string;
  /** The text is taken out on this PC and read as text (Word documents). */
  readonly extractText?: true;
}

const T = (kind: AttachmentKind, mime: string, extractText?: true): AttachmentInfo => ({ kind, mime, ...(extractText ? { extractText } : {}) });

const TABLE: Readonly<Record<string, AttachmentInfo>> = {
  // pictures
  '.png': T('image', 'image/png'),
  '.jpg': T('image', 'image/jpeg'),
  '.jpeg': T('image', 'image/jpeg'),
  '.webp': T('image', 'image/webp'),
  '.heic': T('image', 'image/heic'),
  '.heif': T('image', 'image/heif'),
  // documents
  '.pdf': T('document', 'application/pdf'),
  '.docx': T('document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', true),
  '.txt': T('document', 'text/plain'),
  '.md': T('document', 'text/plain'),
  '.log': T('document', 'text/plain'),
  '.csv': T('document', 'text/csv'),
  '.json': T('document', 'text/plain'),
  '.xml': T('document', 'text/plain'),
  '.html': T('document', 'text/html'),
  '.htm': T('document', 'text/html'),
  // sound
  '.mp3': T('audio', 'audio/mp3'),
  '.wav': T('audio', 'audio/wav'),
  '.aac': T('audio', 'audio/aac'),
  '.ogg': T('audio', 'audio/ogg'),
  '.flac': T('audio', 'audio/flac'),
  '.aiff': T('audio', 'audio/aiff'),
  '.m4a': T('audio', 'audio/aac'),
  // video
  '.mp4': T('video', 'video/mp4'),
  '.mov': T('video', 'video/mov'),
  '.webm': T('video', 'video/webm'),
  '.avi': T('video', 'video/avi'),
  '.mpeg': T('video', 'video/mpeg'),
  '.mpg': T('video', 'video/mpg'),
  '.wmv': T('video', 'video/wmv'),
  '.3gp': T('video', 'video/3gpp'),
  '.flv': T('video', 'video/x-flv'),
};

/** The file name's ending, lower-case, with its dot ("report.PDF" -> ".pdf"). */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/** What Eya can do with a file of this name, or null when she cannot read that kind. */
export function attachmentInfo(name: string): AttachmentInfo | null {
  return TABLE[extensionOf(name)] ?? null;
}

/** What the file picker offers: exactly the endings Eya can read. */
export const ATTACH_ACCEPT: string = Object.keys(TABLE).join(',');

const KIND_WORD: Readonly<Record<AttachmentKind, string>> = { image: 'picture', document: 'document', audio: 'audio file', video: 'video' };
export const kindWord = (kind: AttachmentKind): string => KIND_WORD[kind];

/** Why a file cannot be attached, in words for the person, or null when it can. */
export function whyNotAttachable(name: string, size: number): string | null {
  const info = attachmentInfo(name);
  if (info === null) {
    const ext = extensionOf(name);
    const sheets = ext === '.xlsx' || ext === '.xls' || ext === '.pptx' || ext === '.ppt' || ext === '.doc';
    return sheets
      ? `Eya cannot read ${ext} files yet. Save it as a PDF or a .docx and attach that.`
      : `Eya cannot read ${ext === '' ? 'that kind of file' : `${ext} files`}. She can read pictures, PDFs, Word (.docx) and text files, audio and video.`;
  }
  if (size <= 0) return 'That file is empty.';
  if (size > MAX_ATTACHMENT_BYTES) return `That ${KIND_WORD[info.kind]} is bigger than the ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB Eya can read in one go.`;
  return null;
}

/**
 * Cleans what the window sent as a message's attachments: at most MAX_ATTACHMENTS, each a plain name, a path, a known kind and a size; anything
 * else is dropped. (The reader still checks every path itself before it opens a file.)
 */
export function cleanAttachments(raw: unknown): AttachmentRef[] {
  if (!Array.isArray(raw)) return [];
  const out: AttachmentRef[] = [];
  for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    const name = typeof r['name'] === 'string' ? r['name'].slice(0, 200) : '';
    const path = typeof r['path'] === 'string' ? r['path'].slice(0, 1000) : '';
    const kind = r['kind'];
    const size = typeof r['size'] === 'number' && Number.isFinite(r['size']) && r['size'] >= 0 ? Math.round(r['size']) : 0;
    if (name === '' || path === '' || (kind !== 'image' && kind !== 'document' && kind !== 'audio' && kind !== 'video')) continue;
    out.push({ name, path, kind, size });
  }
  return out;
}

/** The names of attached files as a kept conversation shows them (no path, nothing readable from disk): what came from a file or the page, made safe. */
export function cleanAttachmentChips(raw: unknown): AttachmentChip[] {
  if (!Array.isArray(raw)) return [];
  const out: AttachmentChip[] = [];
  for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    const name = typeof r['name'] === 'string' ? r['name'].slice(0, 200) : '';
    const kind = r['kind'];
    const size = typeof r['size'] === 'number' && Number.isFinite(r['size']) && r['size'] >= 0 ? Math.round(r['size']) : 0;
    if (name === '' || (kind !== 'image' && kind !== 'document' && kind !== 'audio' && kind !== 'video')) continue;
    out.push({ name, kind, size });
  }
  return out;
}

/** How the instruction for a message with files starts, so a provider that cannot read files can tell. */
export const ATTACHMENTS_MARKER = 'The user attached';

/** The instruction given to the AI with a message that has files attached (never shown to the person). */
export function attachmentsHint(attachments: readonly AttachmentRef[]): string {
  const lines = attachments.map((a, i) => `${i + 1}. "${a.name}" (${kindWord(a.kind)}) at ${a.path}`).join('\n');
  return (
    `${ATTACHMENTS_MARKER} ${attachments.length === 1 ? 'a file' : `${attachments.length} files`} to this message:\n${lines}\n` +
    'To answer about a file, read it with analyze_document using that exact path and the user\'s question (one call per file; for several files ask what is needed of each, then put the answers together). ' +
    'Do not say what is in a file you have not read, and do not guess from its name. If reading fails or the file cannot be read, say so plainly and why. ' +
    'If the user only attached a file with no question, read it and give a short summary.'
  );
}
