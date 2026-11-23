/**
 * The shop, food and travel sites people ask Eya to use with THEIR account ("open swiggi and login", "login filpkart and order …", "book tickets on bookmyshow"). When a request
 * names one of them, the application opens it itself and reads whether the person is signed in BEFORE the model is asked anything (see discovery.ts), so that the model is told what the
 * page really shows. The names are typed by a person: "swiggi", "filpkart", "book my show" must still find the site.
 *
 * The addresses are the sites' own well-known official ones, and are only tried (the page that opens is checked to be that site, as for any address).
 */
export interface AccountSite {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  /** The names a person types, joined without spaces ("bookmyshow" covers "book my show"). */
  readonly aliases: readonly string[];
}

export const ACCOUNT_SITES: readonly AccountSite[] = [
  { id: 'flipkart', name: 'Flipkart', url: 'https://www.flipkart.com/', aliases: ['flipkart', 'flipcart', 'filpkart'] },
  { id: 'amazon', name: 'Amazon', url: 'https://www.amazon.in/', aliases: ['amazon', 'amazonin', 'amazone', 'amzon'] },
  { id: 'swiggy', name: 'Swiggy', url: 'https://www.swiggy.com/', aliases: ['swiggy', 'swigy', 'swiggi', 'swiggie'] },
  { id: 'zomato', name: 'Zomato', url: 'https://www.zomato.com/', aliases: ['zomato', 'zomoto', 'zommato'] },
  { id: 'myntra', name: 'Myntra', url: 'https://www.myntra.com/', aliases: ['myntra', 'mintra'] },
  { id: 'meesho', name: 'Meesho', url: 'https://www.meesho.com/', aliases: ['meesho', 'mesho', 'meeshoo'] },
  { id: 'bigbasket', name: 'BigBasket', url: 'https://www.bigbasket.com/', aliases: ['bigbasket'] },
  { id: 'blinkit', name: 'Blinkit', url: 'https://blinkit.com/', aliases: ['blinkit', 'blinket', 'grofers'] },
  { id: 'zepto', name: 'Zepto', url: 'https://www.zeptonow.com/', aliases: ['zepto'] },
  { id: 'bookmyshow', name: 'BookMyShow', url: 'https://in.bookmyshow.com/', aliases: ['bookmyshow', 'bms'] },
  { id: 'irctc', name: 'IRCTC', url: 'https://www.irctc.co.in/nget/train-search', aliases: ['irctc'] },
  { id: 'makemytrip', name: 'MakeMyTrip', url: 'https://www.makemytrip.com/', aliases: ['makemytrip', 'mmt'] },
  { id: 'goibibo', name: 'Goibibo', url: 'https://www.goibibo.com/', aliases: ['goibibo'] },
  { id: 'redbus', name: 'redBus', url: 'https://www.redbus.in/', aliases: ['redbus'] },
  { id: 'nykaa', name: 'Nykaa', url: 'https://www.nykaa.com/', aliases: ['nykaa'] },
  { id: 'ajio', name: 'AJIO', url: 'https://www.ajio.com/', aliases: ['ajio'] },
];

/** The words of a request that mean "use my account there" (as opposed to a passing mention of a name). */
const ACTION = /\b(?:open|launch|visit|go to|log ?in|login|sign ?in|order|buy|purchase|book|checkout|check ?out|cart|track|reorder)\b/i;
const LOGIN = /\b(?:log ?in|login|sign ?in)\b/i;
const SPEND = /\b(?:order|buy|purchase|book|checkout|check ?out|cart|reorder)\b/i;

export type AccountIntent = 'login' | 'order' | 'open';

/** The words around a plain "open <site>": politeness, the verb, "the", "site", where to open it. Anything else is a task. */
const BARE_FILLER = new Set(['hey', 'eya', 'please', 'can', 'could', 'would', 'will', 'you', 'kindly', 'open', 'launch', 'visit', 'go', 'to', 'the', 'site', 'website', 'app', 'page', 'now', 'in', 'on', 'my', 'chrome', 'edge', 'browser', 'tab', 'for', 'me', 'a', 'new']);

export interface AccountPlan {
  readonly site: AccountSite;
  readonly intent: AccountIntent;
  /** A phone number the person gave to log in with (ten digits, as they wrote it). */
  readonly phone?: string;
  readonly email?: string;
  /** All that was said was "open <site>" (no task on it): the application opens it and says what it found, with no model call. */
  readonly bare?: true;
}

/** Optimal string alignment distance: one slip is a missing, extra or wrong letter, or two letters swapped ("filpkart"). */
export function slips(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min((d[i - 1] as number[])[j]! + 1, (d[i] as number[])[j - 1]! + 1, (d[i - 1] as number[])[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, (d[i - 2] as number[])[j - 2]! + 1);
      (d[i] as number[])[j] = best;
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

/**
 * The site a word (or two or three words run together: "book my show") names. A short name must be exact or one of the typos listed for it: a slip allowance there would turn
 * "tomato" into Zomato and "mantra" into Myntra. Only a LONG name (Flipkart, BookMyShow, MakeMyTrip, BigBasket) tolerates a slip or two ("filpkart"), and only when it starts with the
 * same letter, as typing slips do.
 */
export function siteNamed(word: string): AccountSite | null {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (w.length < 3) return null;
  for (const site of ACCOUNT_SITES) {
    for (const alias of site.aliases) {
      if (w === alias) return site;
      if (alias.length >= 8 && w[0] === alias[0] && Math.abs(w.length - alias.length) <= 2 && slips(w, alias) <= 2) return site;
    }
  }
  return null;
}

/** The site a request is about and what it wants there, or null when no known site is named with a word that means "use it" (a passing mention is left to the model). */
export function planAccountSite(text: string): AccountPlan | null {
  if (!ACTION.test(text)) return null;
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== '');
  let site: AccountSite | null = null;
  let matchedAt = 0;
  let matchedWords = 0;
  for (let i = 0; i < words.length && site === null; i += 1) {
    // (a name typed as one word, or as two or three: "book my show", "make my trip", "red bus")
    for (const n of [1, 2, 3]) {
      const joined = words.slice(i, i + n).join('');
      if (joined.length < 3 || (n > 1 && joined.length < 6)) continue;
      site = siteNamed(joined);
      if (site !== null) {
        matchedAt = i;
        matchedWords = n;
        break;
      }
    }
  }
  if (site === null) return null;
  const phone = /(?<!\d)(?:\+?91[\s-]?)?([6-9]\d{9})(?!\d)/.exec(text.replace(/(\d)[\s-](?=\d)/g, '$1'))?.[1];
  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(text)?.[0];
  const intent: AccountIntent = LOGIN.test(text) && !SPEND.test(text) ? 'login' : SPEND.test(text) ? 'order' : 'open';
  const rest = words.filter((_, k) => k < matchedAt || k >= matchedAt + matchedWords);
  const bare = intent === 'open' && rest.every((w) => BARE_FILLER.has(w));
  return { site, intent, ...(phone !== undefined ? { phone } : {}), ...(email !== undefined ? { email } : {}), ...(bare ? { bare: true as const } : {}) };
}
