/**
 * What Eya says while something takes a moment, so she sounds like a person doing it and not a machine reporting that it is busy.
 *
 * "Working on it." said the same way every time is the sound of a program. A person says what they are doing ("okay, opening Flipkart"),
 * says something different the next time, and says something honest when it is slow ("this site is being slow, one sec"). These are short
 * on purpose: they cover a few seconds, they are not a conversation. Pure, so it can be tested; `random` is injectable.
 */

export type CueStage = 'start' | 'slow' | 'long';

export interface CueRequest {
  /** The tool that is running (open_website, find_file, ...), when known. */
  readonly tool?: string;
  /** Its arguments (an address, a file name), to name the place or thing. Never read for anything else. */
  readonly args?: Readonly<Record<string, unknown>> | undefined;
  /** Just started (default), still going after a few seconds, or going on for a long time. */
  readonly stage?: CueStage;
}

type Family = 'web' | 'search' | 'research' | 'fill' | 'click' | 'look' | 'files' | 'chat' | 'download' | 'word' | 'youtube' | 'screen' | 'generic';

const BRANDS: Readonly<Record<string, string>> = {
  whatsapp: 'WhatsApp',
  youtube: 'YouTube',
  flipkart: 'Flipkart',
  amazon: 'Amazon',
  myntra: 'Myntra',
  meesho: 'Meesho',
  bookmyshow: 'BookMyShow',
  irctc: 'IRCTC',
  redbus: 'redBus',
  makemytrip: 'MakeMyTrip',
  goibibo: 'Goibibo',
  zomato: 'Zomato',
  swiggy: 'Swiggy',
  gmail: 'Gmail',
  google: 'Google',
  indiankanoon: 'Indian Kanoon',
  ecourts: 'eCourts',
  telegram: 'Telegram',
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  paytm: 'Paytm',
  phonepe: 'PhonePe',
  github: 'GitHub',
};

/** The name a person would say for the site an address belongs to ("https://www.flipkart.com/x" → "Flipkart"), or null. */
export function siteName(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.replace(/^www\./, '').split('.').filter((l) => l !== '');
  if (labels.length === 0) return null;
  // The brand is the last label before the ending (flipkart.com, accounts.google.co.in → google, web.whatsapp.com → whatsapp).
  const endings = new Set(['com', 'in', 'org', 'net', 'co', 'gov', 'nic', 'edu', 'ac', 'io', 'app', 'tv']);
  const core = [...labels].reverse().find((l) => !endings.has(l)) ?? labels[0] ?? '';
  if (core === '' || /^\d+$/.test(core)) return null;
  return BRANDS[core] ?? core.charAt(0).toUpperCase() + core.slice(1);
}

function familyOf(tool: string | undefined): Family {
  switch (tool) {
    case undefined:
    case '':
      return 'generic';
    case 'open_website':
    case 'open_url':
      return 'web';
    case 'web_search':
      return 'search';
    case 'deep_research':
      return 'research';
    case 'fill_on_page':
      return 'fill';
    case 'click_on_page':
      return 'click';
    case 'inspect_page':
    case 'read_page':
    case 'find_on_page':
    case 'scroll_page':
      return 'look';
    case 'find_file':
    case 'find_folder':
    case 'open_file':
    case 'open_folder':
    case 'read_file':
    case 'analyze_document':
      return 'files';
    case 'find_chat':
    case 'attach_file':
    case 'verify_sent':
    case 'quick_command':
      return 'chat';
    case 'download_file':
      return 'download';
    case 'play_on_youtube':
    case 'skip_ads':
      return 'youtube';
    case 'describe_screen':
    case 'take_screenshot':
    case 'screen_click':
    case 'screen_elements':
      return 'screen';
    default:
      return tool.startsWith('word_') ? 'word' : 'generic';
  }
}

/** {site} is filled with the place's name; a phrase with {site} is used only when the place is known. */
const START: Readonly<Record<Family, readonly string[]>> = {
  web: ['Okay, opening {site}.', 'Sure, pulling up {site}.', 'Alright, {site} coming up.', 'Okay, let me open {site} for you.', 'Okay, opening that.', 'Sure, one moment, opening it.'],
  search: ['Hmm, let me look that up.', 'Okay, searching for it.', 'Let me check that for you.', 'Sure, give me a second to search.'],
  research: ["Okay, let me look into this properly. It might take a minute.", "Alright, I'll go through a few sites for this.", 'Hmm, give me a minute, I am digging around for it.'],
  fill: ['Okay, filling that in.', 'Got it, typing that in.', 'Sure, putting that in.'],
  click: ['Okay, clicking through.', 'Got it, on that now.', 'Alright, going ahead.'],
  look: ["Let me see what's on this page.", 'Okay, taking a look.', 'Hmm, let me read through this.'],
  files: ['Let me find it on your PC.', 'Okay, looking for that file.', 'Hmm, checking your files.'],
  chat: ['Okay, finding the chat.', 'Sending it across, one moment.', 'Alright, let me get that to them.'],
  download: ['Okay, downloading that now.', 'Sure, grabbing it for you.'],
  word: ['Okay, writing that into your document.', 'Sure, updating the document now.', 'Got it, working on your document.'],
  youtube: ['Okay, finding it on YouTube.', 'Sure, let me pull that up on YouTube.', 'Alright, getting it playing.'],
  screen: ['Let me take a look at the screen.', 'Okay, checking your screen.'],
  generic: ['Okay, one moment.', 'Sure, give me a second.', 'Alright, on it.', 'Got it, let me do that.', 'Hmm, let me check.'],
};

const SLOW: readonly string[] = ["Still on it, just a moment.", "Bear with me, it's loading.", 'The page is a bit slow, hang on.', 'Almost there, one more second.', 'Just a little longer.'];
const SLOW_SITE: readonly string[] = ['{site} is being a bit slow, hang on.', 'Still waiting on {site}, one moment.', "{site} is taking its time, almost there."];
const LONG: readonly string[] = [
  "This is taking a bit longer than usual, but I'm still on it.",
  "Sorry, it's slow today. I'm still at it, and I'll tell you the moment it's done.",
  'Still going. The site is really taking its time.',
];

/**
 * Picks the phrase. Remembers the last few, so the same words never come twice running; a phrase that needs the place's name is used
 * only when the name is known.
 */
export class CuePicker {
  private recent: string[] = [];

  constructor(private readonly random: () => number = Math.random) {}

  pick(request: CueRequest = {}): string {
    const stage = request.stage ?? 'start';
    const site = siteName(request.args?.['url']);
    const pool =
      stage === 'start'
        ? START[familyOf(request.tool)]
        : stage === 'slow'
          ? [...SLOW, ...(site !== null ? SLOW_SITE : [])]
          : LONG;
    const usable = pool.filter((p) => site !== null || !p.includes('{site}'));
    const fresh = usable.filter((p) => !this.recent.includes(p));
    const from = fresh.length > 0 ? fresh : usable;
    // A phrase naming the place is preferred when there is one: it is the one that sounds like someone who knows what they are doing.
    const named = from.filter((p) => p.includes('{site}'));
    const choices = site !== null && named.length > 0 && stage === 'start' ? named : from;
    const chosen = choices[Math.min(choices.length - 1, Math.floor(this.random() * choices.length))] ?? 'Okay, one moment.';
    this.recent = [...this.recent, chosen].slice(-4);
    return chosen.replace('{site}', site ?? 'that');
  }
}
