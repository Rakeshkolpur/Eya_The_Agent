/**
 * How far a site can be trusted for what Eya is asked to find, judged from its address alone, and which sites she never visits or
 * recommends at all. A judgement from the domain is crude, but it is the right first cut: a court's own site, a national archive or a
 * university is a better place to look for a judgment, a paper or a public record than a site that is mostly adverts.
 */

export type SiteKind = 'official' | 'legal' | 'archive' | 'education' | 'reference' | 'news' | 'streaming' | 'general' | 'poor';

export interface SiteTrust {
  readonly domain: string;
  readonly kind: SiteKind;
  /** 0 to 100. */
  readonly score: number;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

const OFFICIAL = /(^|\.)(gov\.in|nic\.in|gov|gov\.uk|gov\.au|gov\.ca|europa\.eu|un\.org|who\.int|worldbank\.org|imf\.org|oecd\.org|sci\.gov\.in|ecourts\.gov\.in|indiacode\.nic\.in|legislative\.gov\.in|egazette\.gov\.in|rbi\.org\.in|sebi\.gov\.in)$/;
const COURT_WORDS = /(^|[.-])(courts?|judiciary|judgments?|judgements?|highcourt|hcservices|ecourts|supremecourt|tribunal)([.-]|$)/;
const LEGAL_FREE = new Set([
  'indiankanoon.org',
  'scobserver.in',
  'livelaw.in',
  'barandbench.com',
  'lawtrend.in',
  'lawbeat.in',
  'verdictum.in',
  'courtlistener.com',
  'law.cornell.edu',
  'bailii.org',
  'worldlii.org',
  'canlii.org',
  'austlii.edu.au',
  'casetext.com',
  'justia.com',
]);
const ARCHIVE = new Set([
  'archive.org',
  'scholar.archive.org',
  'wikisource.org',
  'wikimedia.org',
  'commons.wikimedia.org',
  'gutenberg.org',
  'openstax.org',
  'doaj.org',
  'arxiv.org',
  'core.ac.uk',
  'europepmc.org',
  'ncbi.nlm.nih.gov',
  'pmc.ncbi.nlm.nih.gov',
  'loc.gov',
  'dli.gov.in',
  'ndl.gov.in',
  'nationalarchives.gov.uk',
  'zenodo.org',
  'osf.io',
  'ssrn.com',
]);
const EDUCATION = /(^|\.)(edu|ac\.in|ac\.uk|edu\.in|edu\.au|ac\.jp)$/;
const REFERENCE = new Set(['wikipedia.org', 'en.wikipedia.org', 'britannica.com', 'investopedia.com', 'khanacademy.org', 'merriam-webster.com']);
const NEWS = new Set([
  'bbc.com',
  'bbc.co.uk',
  'reuters.com',
  'thehindu.com',
  'indianexpress.com',
  'hindustantimes.com',
  'timesofindia.indiatimes.com',
  'ndtv.com',
  'livemint.com',
  'theprint.in',
  'scroll.in',
  'thewire.in',
  'economictimes.indiatimes.com',
  'business-standard.com',
  'apnews.com',
  'theguardian.com',
  'nytimes.com',
  'washingtonpost.com',
]);
/** Official platforms where films and shows can be watched legally (some free with adverts, some for a fee or a subscription). */
const STREAMING: Readonly<Record<string, string>> = {
  'youtube.com': 'YouTube',
  'netflix.com': 'Netflix',
  'primevideo.com': 'Prime Video',
  'hotstar.com': 'JioHotstar',
  'jiocinema.com': 'JioCinema',
  'zee5.com': 'ZEE5',
  'sonyliv.com': 'SonyLIV',
  'mxplayer.in': 'MX Player',
  'airtelxstream.in': 'Airtel Xstream',
  'sunnxt.com': 'Sun NXT',
  'aha.video': 'aha',
  'hoichoi.tv': 'hoichoi',
  'tv.apple.com': 'Apple TV',
  'play.google.com': 'Google Play Movies',
  'disneyplus.com': 'Disney+',
  'hbomax.com': 'Max',
  'max.com': 'Max',
  'peacocktv.com': 'Peacock',
  'tubitv.com': 'Tubi',
  'pluto.tv': 'Pluto TV',
  'plex.tv': 'Plex',
  'roku.com': 'The Roku Channel',
  'crunchyroll.com': 'Crunchyroll',
  'mubi.com': 'MUBI',
  'jiosaavn.com': 'JioSaavn',
  'gaana.com': 'Gaana',
  'music.youtube.com': 'YouTube Music',
  'open.spotify.com': 'Spotify',
  'spotify.com': 'Spotify',
  'music.apple.com': 'Apple Music',
  'wynk.in': 'Wynk Music',
  'hungama.com': 'Hungama',
  'archive.org': 'Internet Archive',
};

/**
 * Sites Eya never visits, searches in or recommends: the ones that exist to give away other people's films, music, books, papers and
 * programs without permission (torrent and "free movie download" sites, cracked software, shadow libraries). Looking for the genuine,
 * legal place to get something is the job; these are not that, and they are also where the malware and the scam pop-ups live.
 */
const BLOCKED =
  /(torrent|piratebay|thepiratebay|1337x|rarbg|limetorrents|torlock|kickass|yts\.|yify|eztv|nyaa\.si|tamilrockers|tamilyogi|tamilblasters|isaimini|moviesda|movierulz|filmyzilla|filmywap|filmyhit|7starhd|worldfree4u|bolly4u|vegamovies|hdhub4u|katmoviehd|kmhd|mkvcinemas|9xmovies|9xflix|coolmoviez|downloadhub|skymovieshd|moviesflix|moviesmod|bollyflix|khatrimaza|jalshamoviez|mp4moviez|okjatt|jio-?rockers|todaypk|fmovies|123movies|gomovies|putlocker|solarmovie|soap2day|yesmovies|cuevana|lookmovie|primewire|watchseries|ibomma|telegram-?movies|crack(ed|watch)|fitgirl|dodi-?repacks|igg-?games|oceanofgames|steamunlocked|getintopc|filecr|haxnode|keygen|warez|nulled|libgen|library\.lol|z-?lib|1lib|b-ok|bookfi|sci-?hub|annas-?archive|pdfdrive|ebookee|freepdf|downloadlynet|mp3juices|mp3skull|mp3-?download|djpunjab|pagalworld|songspk|mr-jatt|webmusic|wapking|djmaza|naasongs|starmusiq|masstamilan|kuttyweb)/i;

export function isBlockedSite(url: string): boolean {
  const domain = domainOf(url);
  return domain !== '' && BLOCKED.test(domain);
}

/** The name of an official platform when the address is one ("Netflix", "ZEE5"), else null. */
export function streamingPlatform(url: string): string | null {
  const d = domainOf(url);
  for (const [host, name] of Object.entries(STREAMING)) if (d === host || d.endsWith(`.${host}`)) return name;
  return null;
}

export function trustOf(url: string): SiteTrust {
  const domain = domainOf(url);
  const at = (kind: SiteKind, score: number): SiteTrust => ({ domain, kind, score });
  if (domain === '') return at('poor', 0);
  if (BLOCKED.test(domain)) return at('poor', 0);
  if (OFFICIAL.test(domain)) return at('official', 95);
  if (COURT_WORDS.test(domain)) return at('official', 88);
  if (LEGAL_FREE.has(domain) || [...LEGAL_FREE].some((d) => domain.endsWith(`.${d}`))) return at('legal', 82);
  if (ARCHIVE.has(domain) || [...ARCHIVE].some((d) => domain.endsWith(`.${d}`))) return at('archive', 80);
  if (EDUCATION.test(domain)) return at('education', 78);
  if (REFERENCE.has(domain) || [...REFERENCE].some((d) => domain.endsWith(`.${d}`))) return at('reference', 72);
  if (streamingPlatform(url) !== null) return at('streaming', 70);
  if (NEWS.has(domain) || [...NEWS].some((d) => domain.endsWith(`.${d}`))) return at('news', 62);
  if (/\.(xyz|top|click|icu|buzz|loan|win|bid|stream|download|party|gq|tk|ml|cf|ga)$/.test(domain)) return at('poor', 15);
  return at('general', 42);
}
