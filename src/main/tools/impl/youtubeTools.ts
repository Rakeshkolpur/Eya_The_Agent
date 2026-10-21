import { rootLogger } from '@main/logging/logger';
import type { AdsState, BrowserAdHelper, BrowserAutomationService } from '@main/browser/BrowserAutomationService';
import { kindFromRequest, rankVideos } from '@main/research/youtube';
import type { YtKind, YtVideo } from '@main/research/youtube';
import type { Tool, ToolArgs, ToolResult } from '../types';

const log = rootLogger.child('youtube-tool');

type BrowserService = BrowserAutomationService & Partial<BrowserAdHelper>;

export interface YoutubeToolDeps {
  readonly browser: BrowserService;
  /** The results page of a YouTube search, as a list of videos. */
  readonly search: (query: string) => Promise<readonly YtVideo[]>;
  /** Tests make waiting instant. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the video to really start, through adverts (an advert that cannot be skipped runs to its end). */
  readonly startupMs?: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const KINDS: readonly YtKind[] = ['song', 'movie', 'video'];
const watchUrl = (id: string): string => `https://www.youtube.com/watch?v=${id}`;

const friendly = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The adverts' part of a result: what was skipped and what was waited through. */
function adsLine(state: AdsState | null, note: string | null): Record<string, unknown> {
  if (state === null) return { adHelper: 'unavailable', ...(note !== null ? { adHelperReason: note } : {}) };
  return { adHelper: 'on', advertsSkipped: state.skipped, overlayAdvertsClosed: state.closed, stillInAnAdvert: state.adShowing };
}

export function createYoutubeTools(deps: YoutubeToolDeps): Tool[] {
  const sleep = deps.sleep ?? realSleep;
  const startupMs = deps.startupMs ?? 40_000;

  const playOnYoutube: Tool = {
    schema: {
      name: 'play_on_youtube',
      status: 'Finding it on YouTube…',
      description:
        'Play a song, film or video on YouTube for the user: it searches YouTube, picks the right result (the official one of the right length, ' +
        'not a mashup, trailer or clip), opens it in the user\'s own browser, SKIPS the skippable adverts by itself and keeps checking while it plays, ' +
        'and waits through any advert that cannot be skipped. Use it for "play <song>", "play <film> on YouTube", "put on <video>". ' +
        'Do not ask the user to skip adverts or click anything: this does it. If the user says it is the wrong one, call again with the same query and ' +
        'index 2 (then 3). For a film the user wants to WATCH for free, the full-length official upload is chosen when there is one.',
      args: {
        query: { type: 'string', required: true, description: 'What to play, in the user\'s words, e.g. "Tum Hi Ho Aashiqui 2".' },
        type: { type: 'string', enum: KINDS, description: 'song, movie or video. Leave it out and it is worked out from the words.' },
        index: { type: 'number', description: 'Which candidate to play: 1 (default) is the best match; 2 or 3 when the user says it is the wrong one.' },
        browser: { type: 'string', enum: ['chrome', 'edge'], description: 'Only when the user names a browser. Leave it out and Chrome is used.' },
      },
    },
    async execute(args: ToolArgs): Promise<ToolResult> {
      const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
      if (query === '') return { ok: false, summary: 'nothing to play', error: 'Tell me what to play.' };
      const kind: YtKind = (KINDS as readonly string[]).includes(String(args['type'])) ? (args['type'] as YtKind) : kindFromRequest(query);
      const index = typeof args['index'] === 'number' && args['index'] >= 1 ? Math.min(5, Math.floor(args['index'])) : 1;

      let videos: readonly YtVideo[];
      try {
        videos = await deps.search(query);
      } catch {
        videos = [];
      }
      const ranked = rankVideos(videos, query, kind);
      const chosen = ranked[index - 1]?.video;
      if (chosen === undefined && kind === 'movie') {
        // A recent film is played only from a verified (studio or distributor) channel; the "full movie" uploads by anyone else are mostly pirated.
        return {
          ok: true,
          summary: 'no official full film on YouTube',
          data: {
            played: false,
            reason: 'no official full-length upload',
            note: "I couldn't find an official full-length upload of that film on YouTube (the ones by other channels are mostly pirated copies, so I don't play those). Offer to check where it can be watched legally with deep_research (kind media, no_site true).",
          },
        };
      }
      if (chosen === undefined) {
        // YouTube would not list it (or it is not on YouTube): open its own search page so the person can see what there is.
        const searchPage = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        try {
          await deps.browser.openWebsite(searchPage, args['browser'] === 'edge' ? { browser: 'edge' } : args['browser'] === 'chrome' ? { browser: 'chrome' } : undefined);
        } catch (err) {
          return { ok: false, summary: 'could not open YouTube', error: friendly(err) };
        }
        return { ok: true, summary: 'opened the YouTube search', data: { played: false, reason: 'no clear match', note: "I couldn't tell which result is it, so I opened YouTube's search for it. Say which one and I'll play it." } };
      }

      const url = watchUrl(chosen.id);
      const opening = args['browser'] === 'edge' ? { browser: 'edge' as const } : args['browser'] === 'chrome' ? { browser: 'chrome' as const } : undefined;
      try {
        await deps.browser.openWebsite(url, opening);
      } catch (err) {
        return { ok: false, summary: 'could not open YouTube', error: friendly(err) };
      }

      // From here the page's own Skip button is pressed as soon as it appears, and the video is started if the browser left it waiting.
      let state: AdsState | null = null;
      let note: string | null = null;
      if (typeof deps.browser.ads === 'function') {
        let waited = 0;
        try {
          state = await deps.browser.ads('watch', { keepPlaying: true, play: true });
          // Wait for the video the person asked for to be really playing: through a skippable advert (pressed within a second or two of
          // its Skip button appearing, about five seconds into it) and through one that cannot be skipped.
          while (waited < startupMs) {
            if (!state.adShowing && state.video !== null && !state.video.paused && state.video.seconds >= 1) break;
            await sleep(1500);
            waited += 1500;
            state = await deps.browser.ads('once', { play: true });
          }
        } catch (err) {
          note = friendly(err);
          state = null;
        }
      } else {
        note = "Skipping adverts only works in the user's own browser with the Eya extension.";
      }
      const playing = state !== null && state.video !== null && !state.video.paused && !state.adShowing;
      log.info('play_on_youtube', { kind, index, playing, skipped: state?.skipped ?? 0 });
      return {
        ok: true,
        summary: playing ? `playing ${chosen.title}` : `opened ${chosen.title}`,
        data: {
          played: playing,
          video: { title: chosen.title, channel: chosen.channel, url },
          alternatives: ranked.slice(index, index + 2).map((r) => ({ title: r.video.title, channel: r.video.channel })),
          ...adsLine(state, note),
          ...(playing || state === null ? {} : { note: state.adShowing ? 'An advert that cannot be skipped is still playing; it will start by itself when that ends.' : 'It is open but not playing: the browser is probably waiting for one click on the play button (Chrome blocks sound from a page the user has not clicked on). Tell the user to press play once; allowing sound for youtube.com in the site settings stops that.' }),
        },
      };
    },
  };

  const skipAds: Tool = {
    schema: {
      name: 'skip_ads',
      status: 'Skipping the advert…',
      description:
        'Skip the advert on the YouTube page that is open now (presses its own Skip button and closes its overlay adverts), and keep doing that while the page ' +
        'plays, so the user never has to. Use it when an advert is in the way ("skip the ad", "the ad is playing"), after opening a YouTube video with open_website, ' +
        'or to switch it off (stop: true). It only presses buttons the page itself offers; an advert with no Skip button is waited through. Works in the user\'s own browser.',
      args: {
        stop: { type: 'boolean', description: 'True to stop watching for adverts on this page.' },
      },
    },
    async execute(args: ToolArgs): Promise<ToolResult> {
      if (typeof deps.browser.ads !== 'function') {
        return { ok: false, summary: 'not available', error: "I can skip adverts only in your own browser (Chrome or Edge with the Eya extension), not in this window." };
      }
      try {
        if (args['stop'] === true) {
          const state = await deps.browser.ads('stop');
          return { ok: true, summary: 'stopped watching for adverts', data: { ...adsLine(state, null), watching: state.watching } };
        }
        const first = await deps.browser.ads('watch', { keepPlaying: true });
        if (!first.onYouTube) {
          return { ok: true, summary: 'not a YouTube page', data: { onYouTube: false, note: 'This page is not YouTube, so there is no Skip button for me to press. Close a pop-up with click_on_page if one is in the way.' } };
        }
        // Give a Skip button that is about to appear a few seconds, but never hold the user up for long.
        let state = first;
        let waited = 0;
        while (state.adShowing && waited < 12_000) {
          await sleep(1000);
          waited += 1000;
          state = await deps.browser.ads('once');
        }
        return {
          ok: true,
          summary: state.skipped > 0 ? `skipped ${state.skipped} advert${state.skipped === 1 ? '' : 's'}` : state.adShowing ? 'an advert is still playing' : 'no advert in the way',
          data: { ...adsLine(state, null), watching: state.watching },
        };
      } catch (err) {
        return { ok: false, summary: 'could not skip', error: friendly(err) };
      }
    },
  };

  return [playOnYoutube, skipAds];
}

