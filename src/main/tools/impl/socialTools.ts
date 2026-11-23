import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { BrowserAutomationService, BrowserFileAttach } from '@main/browser/BrowserAutomationService';
import type { PageSnapshot } from '@main/browser/pageSnapshot';
import { rootLogger } from '@main/logging/logger';
import type { PublishGate } from '@main/social/PublishGate';
import { checkReadablePath, isExecutablePath } from '@main/security/pathPolicy';
import type { KnownFolders } from '@main/security/pathPolicy';
import { currentUserWords } from '@main/security/userWords';
import { remainingToday } from '@main/social/pacing';
import { checkSocialText, hasErrors, IMAGE_EXTENSIONS, preview, sayProblems, tidyPostText } from '@main/social/socialRules';
import type { SocialKind } from '@main/social/socialRules';
import { siteById, siteOfUrl } from '@main/social/socialSites';
import type { SocialSiteId } from '@main/social/socialSites';
import type { SocialDraft, SocialStore } from '@main/social/SocialStore';
import type { Tool, ToolArgs, ToolResult } from '../types';
import { mimeFor } from './chatTools';
import type { FileAccess } from './chatTools';

const log = rootLogger.child('social');

/**
 * Writing for the person on LinkedIn (and Fiverr next): the drafts, the picture, and putting the picture on the page. What goes OUT is never decided here — it is the click on Post / Comment /
 * Reply, held by the PublishGate to the person's own yes, the permission they gave the plugin and the limits (see social/PublishGate.ts). These tools only prepare.
 */
export interface SocialImageSpec {
  readonly title: string;
  readonly subtitle: string;
  readonly footer: string;
  readonly theme: 'dark' | 'light' | 'blue' | 'warm';
  readonly width: number;
  readonly height: number;
}

export interface SocialToolDeps {
  readonly store: SocialStore;
  readonly service: BrowserAutomationService;
  readonly folders: KnownFolders;
  readonly files?: FileAccess;
  /** Draws the picture (Eya's own window, off screen): a PNG. Absent: no picture can be made. */
  readonly render?: (spec: SocialImageSpec) => Promise<Buffer>;
  /** Where made pictures are kept. */
  readonly imageFolder: string;
  readonly now?: () => number;
  /** What was typed into the post box is remembered by the gate, so the click on Post asks about exactly that text. */
  readonly publishGate?: PublishGate;
  readonly sleep?: (ms: number) => Promise<void>;
}

const realFiles: FileAccess = {
  async stat(path) {
    try {
      const s = await stat(path);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
    } catch {
      return null;
    }
  },
  async read(path, offset, length) {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

const str = (args: ToolArgs, key: string): string | undefined => {
  const v = args[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

const KINDS: readonly SocialKind[] = ['post', 'comment', 'reply'];
const THEMES = ['dark', 'light', 'blue', 'warm'] as const;
/** Opens LinkedIn's "Create a post" box by itself. */
const COMPOSER_URL = 'https://www.linkedin.com/feed/?shareActive=true';
const SIZES: Readonly<Record<string, readonly [number, number]>> = { linkedin: [1200, 627], square: [1080, 1080], fiverr: [1280, 769] };

/** "#law, tips  #court" → ["law", "tips", "court"]. */
export function parseHashtags(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return [...new Set(raw.split(/[\s,;]+/).map((h) => h.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')).filter((h) => h.length >= 2))].slice(0, 30);
}

/** The whole text to publish: the first line (when one is given and the text does not start with it), the body, and the hashtags on a last line unless the text already has them. */
export function composeText(input: { readonly title?: string; readonly text: string; readonly hashtags: readonly string[] }): string {
  let text = tidyPostText(input.text);
  const title = (input.title ?? '').trim();
  if (title !== '' && !text.toLowerCase().startsWith(title.toLowerCase())) text = `${title}\n\n${text}`;
  const missing = input.hashtags.filter((h) => !new RegExp(`#${h}(?![\\p{L}\\p{N}_])`, 'iu').test(text));
  return missing.length > 0 ? `${text}\n\n${missing.map((h) => `#${h}`).join(' ')}` : text;
}

const ym = (t: number): string => new Date(t).toISOString().slice(0, 10);
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'post';

export function createSocialTools(deps: SocialToolDeps): Tool[] {
  const now = deps.now ?? Date.now;
  const files = deps.files ?? realFiles;

  /** Checks a picture's path (an image in the person's own folders) and returns what is known about it. */
  async function checkImage(raw: string): Promise<{ readonly ok: true; readonly path: string; readonly size: number } | { readonly ok: false; readonly error: string }> {
    const checked = checkReadablePath(raw, deps.folders);
    if (!checked.ok) return { ok: false, error: `I won't use that picture: ${checked.reason}.` };
    if (isExecutablePath(checked.path)) return { ok: false, error: 'That is a program, not a picture.' };
    const ext = extname(checked.path).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) return { ok: false, error: `A picture must be ${IMAGE_EXTENSIONS.join(', ')} (this is "${ext || 'no type'}").` };
    const info = await files.stat(checked.path);
    if (info === null || !info.isFile) return { ok: false, error: `There is no picture at that path ("${basename(checked.path)}").` };
    if (info.size <= 0) return { ok: false, error: 'That picture file is empty.' };
    return { ok: true, path: checked.path, size: info.size };
  }

  const draftTool: Tool = {
    schema: {
      name: 'social_draft',
      status: 'Writing the draft…',
      description:
        "Keep a draft of something to publish in the person's name on LinkedIn: a POST, a COMMENT on someone else's post, or a REPLY to a comment on their own post. This only SAVES and CHECKS it — nothing is published. " +
        'ALWAYS save the text here first, show the person the preview (and the picture, if any) in a few words and ask what to change; only publish once they are happy. The checks refuse client matters ' +
        '(case numbers, phone numbers, e-mails), promises of a result, and too-long text; fix what it says and save again with action "update". action: save (default), update (id + changed fields), ' +
        'get (id), list (recent drafts and what may still be published today), skip (id). The text must come only from what the person told you and their profile (social_profile): no invented figures, ' +
        'cases, results or qualifications. A post is written for people to READ: a first line that makes them stop, short paragraphs, plain words, and three to five hashtags at the end.',
      args: {
        action: { type: 'string', enum: ['save', 'update', 'get', 'list', 'skip'], description: 'What to do (default save).' },
        site: { type: 'string', enum: ['linkedin'], description: 'The site (LinkedIn for now).' },
        kind: { type: 'string', enum: [...KINDS], description: 'post, comment (on someone else\'s post) or reply (to a comment on their own post). Default post.' },
        text: { type: 'string', description: 'The text to publish, exactly as it should read.' },
        title: { type: 'string', description: 'Optional first line (the hook of a post). Put at the start unless the text already begins with it.' },
        hashtags: { type: 'string', description: 'Hashtags, separated by spaces or commas, without or with the # (added on a last line when the text lacks them).' },
        image_path: { type: 'string', description: 'The full path of a picture to attach (from social_make_image or a file the person named).' },
        alt_text: { type: 'string', description: 'A short description of the picture, for people who cannot see it.' },
        target_url: { type: 'string', description: 'For a comment or reply: the page of the post.' },
        target_who: { type: 'string', description: 'For a comment or reply: who wrote what is being answered.' },
        target_excerpt: { type: 'string', description: 'For a comment or reply: the words being answered (a few lines).' },
        id: { type: 'string', description: 'The draft id (for update, get, skip).' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const action = str(args, 'action') ?? 'save';
      const siteId = (str(args, 'site') ?? 'linkedin') as SocialSiteId;
      if (siteById(siteId) === null) return { ok: false, summary: 'unknown site', error: 'Only LinkedIn can be written for just now.' };

      if (action === 'list') {
        const open_ = deps.store.drafts({ status: 'draft' }).slice(-8);
        return {
          ok: true,
          summary: `${open_.length} draft(s)`,
          data: {
            drafts: open_.map((d) => ({ id: d.id, kind: d.kind, text: preview(d.text, 160), hasPicture: d.imagePath !== '', problems: d.problems.filter((p) => p.severity === 'error').length })),
            mayStillPublishToday: remainingToday(deps.store.ledger(), siteId, now(), deps.store.pacing()),
          },
        };
      }

      if (action === 'get' || action === 'skip' || action === 'update') {
        const id = str(args, 'id');
        const old = id === undefined ? null : deps.store.draft(id);
        if (old === null) return { ok: false, summary: 'no such draft', error: 'There is no draft with that id. Use action "list" to see them.' };
        if (action === 'get') return { ok: true, summary: `draft ${old.id}`, data: describe(old) };
        if (action === 'skip') {
          deps.store.update(old.id, { status: 'skipped' });
          return { ok: true, summary: 'skipped', data: { id: old.id, status: 'skipped' } };
        }
        return saveDraft({ ...args, kind: old.kind, site: old.site }, old);
      }
      return saveDraft(args, null);
    },
  };

  async function saveDraft(args: ToolArgs, old: SocialDraft | null): Promise<ToolResult> {
    const kind = ((str(args, 'kind') ?? 'post') as SocialKind);
    if (!KINDS.includes(kind)) return { ok: false, summary: 'bad kind', error: 'The kind must be post, comment or reply.' };
    const rawText = str(args, 'text') ?? (old !== null ? old.text : undefined);
    if (rawText === undefined) return { ok: false, summary: 'no text', error: 'The text to publish is required.' };
    const hashtags = args['hashtags'] !== undefined ? parseHashtags(str(args, 'hashtags')) : old !== null ? old.hashtags.map((h) => h.replace(/^#/, '')) : [];
    const text = composeText({ ...(str(args, 'title') !== undefined ? { title: str(args, 'title') as string } : {}), text: rawText, hashtags });
    let imagePath = args['image_path'] !== undefined ? (str(args, 'image_path') ?? '') : old?.imagePath ?? '';
    let imageBytes: number | undefined;
    if (imagePath !== '') {
      const image = await checkImage(imagePath);
      if (!image.ok) return { ok: false, summary: 'bad picture', error: image.error };
      imagePath = image.path;
      imageBytes = image.size;
    }
    const profile = deps.store.profile();
    const target = {
      url: str(args, 'target_url') ?? old?.target.url ?? '',
      who: str(args, 'target_who') ?? old?.target.who ?? '',
      excerpt: str(args, 'target_excerpt') ?? old?.target.excerpt ?? '',
    };
    const problems = checkSocialText({
      kind,
      text,
      sources: [currentUserWords(), ...profile.facts, profile.name, profile.headline, target.excerpt, target.who],
      hashtags,
      imagePath,
      ...(imageBytes !== undefined ? { imageBytes } : {}),
    });
    const fields = { text, title: str(args, 'title') ?? old?.title ?? '', hashtags: hashtags.map((h) => `#${h}`), imagePath, altText: str(args, 'alt_text') ?? old?.altText ?? '', target, problems };
    const draft = old !== null ? deps.store.update(old.id, fields) : deps.store.add({ site: 'linkedin', kind, ...fields });
    if (draft === null) return { ok: false, summary: 'no such draft', error: 'The draft is gone.' };
    return {
      ok: !hasErrors(problems),
      summary: hasErrors(problems) ? 'saved, but it must be fixed' : `draft ${draft.id} saved`,
      ...(hasErrors(problems) ? { error: `${sayProblems(problems)} Nothing can be published until this is fixed: change the text and save again with action "update" and this id.` } : {}),
      data: { ...describe(draft), next: hasErrors(problems) ? 'Fix the problems first.' : nextSteps(draft) },
    };
  }

  function describe(d: SocialDraft): Record<string, unknown> {
    return {
      id: d.id,
      kind: d.kind,
      status: d.status,
      text: d.text,
      characters: d.text.length,
      picture: d.imagePath !== '' ? basename(d.imagePath) : null,
      pictureAlt: d.altText !== '' ? d.altText : null,
      target: d.target.who !== '' || d.target.url !== '' ? d.target : null,
      problems: d.problems.map((p) => `${p.severity === 'error' ? 'MUST FIX' : 'check'}: ${p.text}`),
    };
  }

  function nextSteps(d: SocialDraft): string {
    const warn = d.problems.length > 0 ? ' Tell the person what to check (the "problems" list).' : '';
    if (d.kind === 'post') {
      return (
        `Show the person the text${d.imagePath !== '' ? ' and say which picture goes with it' : ''} and ask if it is ready.${warn} When they say so, call social_compose with this id ONCE: it opens LinkedIn's post box, types exactly this text${d.imagePath !== '' ? ' and adds the picture' : ''}. ` +
        'Do not open the site yourself, do not click "Start a post", do not search the web, do not ask the person to click. Then ask if it should go out, and only after their own yes click_on_page "Post": the page gate asks them to confirm that exact text.'
      );
    }
    return `Show the person the text and ask if it is ready.${warn} When they say so: open the post${d.target.url !== '' ? ` (${d.target.url})` : ''}, click its Comment/Reply box, fill it with EXACTLY this text, then click Comment/Reply: the page gate asks for their yes to that exact text.`;
  }

  // ------------------------------------------------------------------------------------------------ social_compose
  const wait = deps.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  /** Is the "Create a post" box open? (23 Nov 2026: on the real LinkedIn it is open by itself when the address ends in ?shareActive=true.) */
  const boxOpen = (p: PageSnapshot): boolean =>
    [...p.dialogs, ...p.headings].some((t) => /create a post|what do you want to talk about|share your thoughts/i.test(t)) || p.inputs.some((i) => /text editor for creating content|what do you want to talk about/i.test(i));
  const onLinkedIn = (p: PageSnapshot | null): p is PageSnapshot => p !== null && siteOfUrl(p.url)?.id === 'linkedin';
  const look = async (): Promise<PageSnapshot | null> => {
    try {
      return await deps.service.inspectPage();
    } catch {
      return null;
    }
  };
  /** The names of the page's fields that could be the post box, best first, then what LinkedIn's box is called. */
  const boxLabels = (p: PageSnapshot | null): string[] => {
    const known = ['Text editor for creating content', 'What do you want to talk about?'];
    const seen = (p?.inputs ?? []).filter((i) => /editor|talk about|what do you want|share|write|post/i.test(i)).slice(0, 4);
    return [...new Set([...seen, ...known])];
  };
  const OBSTACLES = ['dismiss', 'not now', 'skip', 'got it', 'maybe later', 'no thanks'];
  const press = async (name: string): Promise<boolean> => {
    try {
      return (await deps.service.clickOnPage(name)).ok;
    } catch {
      return false;
    }
  };
  const MEDIA_BUTTON = /^(add media|add a photo|add photo|photo|photos|add an image|image|media)$/i;

  async function composeDraft(d: SocialDraft): Promise<ToolResult> {
    const steps: string[] = [];
    let page = await look();
    if (!onLinkedIn(page) || !boxOpen(page)) {
      try {
        page = await deps.service.openWebsite(COMPOSER_URL);
        steps.push("opened LinkedIn's post box");
      } catch (err) {
        return { ok: false, summary: 'could not open LinkedIn', error: `LinkedIn would not open (${err instanceof Error ? err.message : String(err)}). Tell the person; do not open it again and again.` };
      }
    } else {
      steps.push('the post box was already open');
    }
    // Wait for the box. The address opens it by itself; if it does not, the feed's own "Start a post" is pressed ONCE, and a pop-up in the way is closed — never anything else, never twice.
    let startedBox = false;
    let obstacles = 0;
    for (let i = 0; i < 8 && page !== null && !boxOpen(page); i += 1) {
      const buttons = page.buttons.map((b) => b.toLowerCase());
      if (i >= 2 && !startedBox && buttons.some((b) => b === 'start a post')) {
        startedBox = true;
        steps.push(`pressed "Start a post" once: ${(await press('Start a post')) ? 'done' : 'it did not work'}`);
      } else if (i >= 3 && obstacles < 2) {
        // (the button is pressed under its own name, as the page spells it)
        const way = page.buttons.find((b) => OBSTACLES.includes(b.trim().toLowerCase()));
        if (way !== undefined) {
          obstacles += 1;
          steps.push(`closed a pop-up in the way ("${way}"): ${(await press(way)) ? 'done' : 'it did not work'}`);
        }
      }
      await wait(1000);
      page = (await look()) ?? page;
    }
    // Put the text in. A few names, the page's own field names first: each tried once.
    let filledLabel: string | null = null;
    const refused: string[] = [];
    for (const label of boxLabels(page)) {
      try {
        const r = await deps.service.fillOnPage(label, d.text);
        if (r.ok) {
          filledLabel = label;
          page = r.snapshot;
          break;
        }
        refused.push(label);
      } catch {
        refused.push(label);
      }
    }
    if (filledLabel === null) {
      const seen = { dialogs: (page?.dialogs ?? []).map((t) => t.slice(0, 60)).slice(0, 5), inputs: (page?.inputs ?? []).slice(0, 12), buttons: (page?.buttons ?? []).slice(0, 20), url: page?.url ?? '' };
      // (only the NAMES of controls, never a word of what is written on the page: so what LinkedIn calls its post box can be seen, and fixed, from the log)
      log.warn('the post box was not found', { tried: refused, ...seen });
      return {
        ok: false,
        summary: 'could not find the post box',
        error: 'I opened LinkedIn but could not find its post box to type in. Do NOT try again, do not open the site again and do not ask the person to click: look at the window once with describe_screen, say in one sentence what is on it, and stop.',
        data: { status: 'no_post_box', steps, tried: refused, seen },
      };
    }
    steps.push(`typed the text into "${filledLabel}"`);
    deps.publishGate?.typed(page, filledLabel, d.text);

    let picture: string | null = null;
    if (d.imagePath !== '') {
      const added = await addPicture(d.imagePath);
      picture = added.ok ? `${basename(d.imagePath)} added` : `NOT added: ${added.why}`;
      steps.push(added.ok ? 'added the picture' : `could not add the picture (${added.why})`);
    }
    const withPicture = picture !== null && !picture.startsWith('NOT') ? ' with its picture' : '';
    const pictureFailed = picture !== null && picture.startsWith('NOT') ? ' (the picture could not be added: say so)' : '';
    return {
      ok: true,
      summary: 'the post is in the box (not published)',
      data: {
        status: 'ready_not_published',
        steps,
        text: d.text,
        picture,
        next: `Nothing is published yet. Tell the person in a few words that the post is in LinkedIn's box${withPicture}${pictureFailed}, ask if it should go out, and only after their own yes click_on_page "Post": the page gate asks them to confirm that exact text.`,
      },
    };
  }

  /** Puts the picture on the open page's file picker: the page's own media button is pressed first (LinkedIn makes the picker only then). */
  async function addPicture(path: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly why: string }> {
    const image = await checkImage(path);
    if (!image.ok) return { ok: false, why: image.error };
    const attacher = deps.service as Partial<BrowserFileAttach>;
    if (typeof attacher.attachFile !== 'function') return { ok: false, why: 'this browser cannot take a file from Eya' };
    const name = basename(image.path);
    const request = { name, mime: mimeFor(name), size: image.size, read: (o: number, l: number) => files.read(image.path, o, l), prefer: 'media' as const };
    let last = 'the page has no file picker';
    // (first as it is: the picker may exist already; then after pressing the page's own media button)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt === 1) {
        const page = await look();
        const media = (page?.buttons ?? []).find((b) => MEDIA_BUTTON.test(b.trim()));
        if (media === undefined || !(await press(media))) return { ok: false, why: last };
        await wait(800);
      }
      try {
        const r = await attacher.attachFile(request);
        if (r.ok) return { ok: true };
        last = r.message;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
    }
    return { ok: false, why: last };
  }

  const composeTool: Tool = {
    schema: {
      name: 'social_compose',
      status: 'Putting the post in LinkedIn…',
      description:
        'Put a saved POST draft into LinkedIn\'s post box, ALL STEPS IN ONE CALL: it opens LinkedIn\'s post box (the box opens by itself from the address; the feed\'s "Start a post" is pressed at most once; a pop-up in the way is ' +
        'closed), types exactly the draft text into it and adds the draft\'s picture if it has one. It does NOT publish. Use it instead of open_website / click_on_page "Start a post" / fill_on_page for a LinkedIn ' +
        'post, and call it ONCE: never open the site again, never click "Start a post" yourself, never search the web for how, never ask the person to click anything. Afterwards, ask them if it should go out; ' +
        'only after their own yes click_on_page "Post" (the page gate asks them to confirm that exact text).',
      args: { id: { type: 'string', description: 'The draft id from social_draft (default: the newest open post draft).' } },
    },
    async execute(args): Promise<ToolResult> {
      const id = str(args, 'id');
      const draft = id !== undefined ? deps.store.draft(id) : ([...deps.store.drafts({ status: 'draft' })].reverse().find((d) => d.kind === 'post') ?? null);
      if (draft === null) return { ok: false, summary: 'no draft', error: 'There is no post draft to put in LinkedIn. Save one with social_draft first.' };
      if (draft.kind !== 'post') return { ok: false, summary: 'not a post', error: 'social_compose is for a post. For a comment or reply, open the post, fill its box and click Comment / Reply.' };
      const problems = checkSocialText({ kind: draft.kind, text: draft.text, ...(draft.imagePath !== '' ? { imagePath: draft.imagePath } : {}) });
      if (hasErrors(problems)) return { ok: false, summary: 'the draft must be fixed', error: `${sayProblems(problems.filter((p) => p.severity === 'error'))} Change the draft with social_draft (update) first.` };
      return composeDraft(draft);
    },
  };

  const imageTool: Tool = {
    schema: {
      name: 'social_make_image',
      status: 'Making the picture…',
      description:
        'Make a clean picture for a post (a card with a headline, an optional second line and a small footer, such as the person\'s name) and save it as a PNG in the "Eya posts" folder in Pictures. ' +
        'Use it when the person asks for an image and gave none. It only draws text: nothing from the internet, no faces, no logos. Then pass the returned path as image_path to social_draft.',
      args: {
        title: { type: 'string', required: true, description: 'The headline on the picture (a short sentence; at most about 90 characters reads well).' },
        subtitle: { type: 'string', description: 'An optional second line.' },
        footer: { type: 'string', description: 'An optional small line at the bottom (the person\'s name or topic).' },
        theme: { type: 'string', enum: [...THEMES], description: 'Colours: dark (default), light, blue or warm.' },
        size: { type: 'string', enum: Object.keys(SIZES), description: 'linkedin 1200x627 (default), square 1080x1080, fiverr 1280x769.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const title = str(args, 'title');
      if (title === undefined) return { ok: false, summary: 'no headline', error: 'A headline for the picture is required.' };
      if (deps.render === undefined) return { ok: false, summary: 'not available', error: 'Pictures cannot be made here.' };
      const [width, height] = SIZES[str(args, 'size') ?? 'linkedin'] ?? SIZES['linkedin']!;
      const themeArg = str(args, 'theme');
      const theme = (THEMES as readonly string[]).includes(themeArg ?? '') ? (themeArg as SocialImageSpec['theme']) : 'dark';
      try {
        const png = await deps.render({ title: title.slice(0, 160), subtitle: (str(args, 'subtitle') ?? '').slice(0, 200), footer: (str(args, 'footer') ?? '').slice(0, 80), theme, width: width!, height: height! });
        await mkdir(deps.imageFolder, { recursive: true });
        const path = join(deps.imageFolder, `${ym(now())}-${slug(title)}-${now().toString(36).slice(-4)}.png`);
        await writeFile(path, png);
        return { ok: true, summary: `made ${basename(path)}`, data: { path, name: basename(path), width, height, bytes: png.length, next: 'Pass this path as image_path to social_draft, and show the person what it says.' } };
      } catch (err) {
        return { ok: false, summary: 'could not make the picture', error: `The picture could not be made (${err instanceof Error ? err.message : String(err)}).` };
      }
    },
  };

  const attachTool: Tool = {
    schema: {
      name: 'social_attach_image',
      status: 'Adding the picture…',
      description:
        'Put a picture on the open LinkedIn page\'s own file picker (the post box\'s photo/media step) so the page shows it in the post. It does NOT publish anything. First open the post box and click its ' +
        '"Add media" / photo button so the page has a file picker; then call this with the picture\'s path (from social_draft or social_make_image). It checks that the picture is an image in the ' +
        "person's own folders and that the open page is LinkedIn, and tells you whether the page took it.",
      args: { path: { type: 'string', required: true, description: 'The full path of the picture.' } },
    },
    async execute(args): Promise<ToolResult> {
      const raw = str(args, 'path');
      if (raw === undefined) return { ok: false, summary: 'no picture', error: 'The path of the picture is required.' };
      const image = await checkImage(raw);
      if (!image.ok) return { ok: false, summary: 'not allowed', error: image.error };
      let page;
      try {
        page = await deps.service.inspectPage();
      } catch {
        return { ok: false, summary: 'no page', error: 'There is no open page. Open LinkedIn first.' };
      }
      const site = siteOfUrl(page.url);
      if (site === null) return { ok: false, summary: 'not a social site', error: `The open page is not LinkedIn (${page.url}), so I will not put a picture on it.` };
      const attacher = deps.service as Partial<BrowserFileAttach>;
      if (typeof attacher.attachFile !== 'function') return { ok: false, summary: 'not available', error: 'This browser cannot take a file from Eya.' };
      const name = basename(image.path);
      const result = await attacher.attachFile({ name, mime: mimeFor(name), size: image.size, read: (o, l) => files.read(image.path, o, l), prefer: 'media' });
      if (!result.ok) {
        return {
          ok: false,
          summary: result.reason === 'no_file_input' ? 'no file picker yet' : 'could not attach',
          error: `${result.message}${result.reason === 'no_file_input' ? ' Open the post box and click its photo / "Add media" button first, then try again.' : ''}`,
          data: { status: 'not_attached', reason: result.reason },
        };
      }
      return { ok: true, summary: `added ${name} to the page (not published)`, data: { status: 'attached_not_published', file: name, site: site.name, next: 'Look at the page (inspect_page) to see the picture in the post, then continue.' } };
    },
  };

  const profileTool: Tool = {
    schema: {
      name: 'social_profile',
      status: 'Checking the profile…',
      description:
        'What the person has told Eya about themselves for their public writing: name, headline, tone, and FACTS (true things a post may say about them: their practice areas, years, courts, services). ' +
        'action get (default) reads it; action set saves what the person told you. Never save a fact the person did not say. A post may state only these facts about the person — nothing else.',
      args: {
        action: { type: 'string', enum: ['get', 'set'], description: 'get (default) or set.' },
        name: { type: 'string', description: 'Their name as it appears on LinkedIn.' },
        headline: { type: 'string', description: 'Their headline.' },
        tone: { type: 'string', description: 'How they like to sound (plain, warm, formal…).' },
        facts: { type: 'string', description: 'True facts about them, one per line, to REPLACE the saved ones. add_facts adds instead.' },
        add_facts: { type: 'string', description: 'True facts to add to the saved ones, one per line.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      if ((str(args, 'action') ?? 'get') === 'set') {
        const lines = (s: string | undefined): string[] => (s ?? '').split(/\n+/).map((l) => l.trim()).filter((l) => l !== '');
        const current = deps.store.profile();
        const facts = args['facts'] !== undefined ? lines(str(args, 'facts')) : [...current.facts, ...lines(str(args, 'add_facts'))];
        const saved = deps.store.setProfile({
          ...(str(args, 'name') !== undefined ? { name: str(args, 'name') as string } : {}),
          ...(str(args, 'headline') !== undefined ? { headline: str(args, 'headline') as string } : {}),
          ...(str(args, 'tone') !== undefined ? { tone: str(args, 'tone') as string } : {}),
          facts: [...new Set(facts)],
        });
        return { ok: true, summary: 'profile saved', data: { ...saved } };
      }
      const p = deps.store.profile();
      return { ok: true, summary: p.name !== '' || p.facts.length > 0 ? 'profile' : 'profile is empty', data: { ...p, note: p.facts.length === 0 ? 'No facts saved yet: ask the person what a post may say about them.' : undefined } };
    },
  };

  return [draftTool, composeTool, imageTool, attachTool, profileTool];
}
