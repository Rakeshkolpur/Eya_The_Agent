import { describe, it, expect } from 'vitest';
import { kindFromRequest, oldFilmYear, parseYoutubeResults, rankVideos, secondsFromLength, viewsFromText } from '../src/main/research/youtube';
import type { YtVideo } from '../src/main/research/youtube';
import { createYoutubeTools } from '../src/main/tools/impl/youtubeTools';
import type { AdsMode, AdsState } from '../src/main/browser/BrowserAutomationService';
import type { PageSnapshot } from '../src/main/browser/pageSnapshot';

const video = (over: Partial<YtVideo> & { id: string; title: string }): YtVideo => ({ channel: 'Some Channel', verified: false, seconds: 240, views: 1_000_000, live: false, ...over });

function resultsHtml(items: object[]): string {
  const data = { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: items } }] } } } } };
  return `<html><script>var ytInitialData = ${JSON.stringify(data)};</script></html>`;
}
const renderer = (id: string, title: string, channel: string, length: string, views: string, extra: object = {}): object => ({
  videoRenderer: {
    videoId: id,
    title: { runs: [{ text: title }] },
    ownerText: { runs: [{ text: channel }] },
    lengthText: { simpleText: length },
    viewCountText: { simpleText: views },
    ...extra,
  },
});

describe('YouTube results', () => {
  it('reads times and view counts', () => {
    expect(secondsFromLength('4:11')).toBe(251);
    expect(secondsFromLength('1:45:30')).toBe(6330);
    expect(secondsFromLength('LIVE')).toBeNull();
    expect(viewsFromText('19,04,00,721 views')).toBe(190400721);
    expect(viewsFromText('2.1M views')).toBe(2_100_000);
  });

  it('parses videos from the page data, with the verified badge and live streams', () => {
    const html = resultsHtml([
      renderer('81qmmlsIE3k', 'Tum Hi Ho Full Song', 'T-Series', '5:00', '217 views', { ownerBadges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_VERIFIED' } }] }),
      renderer('aaaaaaaaaaa', 'Live now', 'Radio', '', '5 watching', { badges: [{ metadataBadgeRenderer: { label: 'LIVE' } }] }),
      { adSlotRenderer: {} },
      renderer('bad', 'not a valid id', 'x', '1:00', '1 view'),
    ]);
    const out = parseYoutubeResults(html);
    expect(out.map((v) => v.id)).toEqual(['81qmmlsIE3k', 'aaaaaaaaaaa']);
    expect(out[0]).toMatchObject({ channel: 'T-Series', verified: true, seconds: 300 });
    expect(out[1]?.live).toBe(true);
    expect(parseYoutubeResults('<html>no data</html>')).toEqual([]);
  });

  it('works out song, film or video from the words', () => {
    expect(kindFromRequest('play Tum Hi Ho song')).toBe('song');
    expect(kindFromRequest('Kesari full movie')).toBe('movie');
    expect(kindFromRequest('how to tie a tie')).toBe('video');
    expect(oldFilmYear('Raja Harishchandra (1913)')).toBe(1913);
    expect(oldFilmYear('Kesari 2019')).toBeNull();
  });
});

describe('choosing the video', () => {
  it('prefers the official channel and a normal song length over mashups, lyric edits and clips', () => {
    const ranked = rankVideos(
      [
        video({ id: 'a1111111111', title: 'Tum Hi Ho (Slowed + Reverb) mashup', channel: 'Lofi Guy', views: 9_000_000 }),
        video({ id: 'b2222222222', title: 'Tum Hi Ho Full Song | Aashiqui 2', channel: 'T-Series', verified: true }),
        video({ id: 'c3333333333', title: 'Tum Hi Ho jukebox', channel: 'Mix', seconds: 3600 }),
        video({ id: 'd4444444444', title: 'Something else entirely', channel: 'T-Series', verified: true }),
      ],
      'Tum Hi Ho song',
      'song',
    );
    expect(ranked[0]?.video.id).toBe('b2222222222');
    expect(ranked.some((r) => r.video.id === 'd4444444444')).toBe(false); // not the title asked for
  });

  it('plays a recent film only from a verified channel and only if it is long enough; an old film may be from anyone', () => {
    const recent = rankVideos(
      [
        video({ id: 'a1111111111', title: 'Kesari Full Movie 2019', channel: 'Random Uploads', seconds: 9000 }),
        video({ id: 'b2222222222', title: 'Kesari - Best Scenes', channel: 'Studio', verified: true, seconds: 900 }),
      ],
      'Kesari full movie',
      'movie',
    );
    expect(recent).toHaveLength(0);
    const official = rankVideos([video({ id: 'c3333333333', title: 'Kesari Full Movie', channel: 'Zee Studios', verified: true, seconds: 9000 })], 'Kesari full movie', 'movie');
    expect(official[0]?.video.id).toBe('c3333333333');
    const old = rankVideos([video({ id: 'd4444444444', title: 'Raja Harishchandra (1913) Full Movie', channel: 'Classics', seconds: 2000 })], 'Raja Harishchandra 1913 full movie', 'movie');
    expect(old[0]?.video.id).toBe('d4444444444');
  });

  it('skips live streams and very short clips', () => {
    const ranked = rankVideos([video({ id: 'a1111111111', title: 'Tum Hi Ho', live: true }), video({ id: 'b2222222222', title: 'Tum Hi Ho', seconds: 20 })], 'Tum Hi Ho song', 'song');
    expect(ranked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------- the tools
const snapshot = { title: 'YouTube' } as PageSnapshot;

function ads(over: Partial<AdsState> = {}): AdsState {
  return { onYouTube: true, title: 't', adShowing: false, waitingForAd: false, skipped: 0, closed: 0, watching: true, video: { paused: false, ended: false, seconds: 3, length: 240 }, ...over };
}

function fakeBrowser(states: AdsState[], opts: { adsMissing?: boolean; adsThrows?: string } = {}) {
  const opened: string[] = [];
  const calls: Array<{ mode: AdsMode; options?: object }> = [];
  let i = 0;
  const base = {
    openWebsite: async (url: string) => {
      opened.push(url);
      return snapshot;
    },
  };
  const browser = (opts.adsMissing === true
    ? base
    : {
        ...base,
        ads: async (mode: AdsMode, options?: object) => {
          calls.push({ mode, ...(options !== undefined ? { options } : {}) });
          if (opts.adsThrows !== undefined) throw new Error(opts.adsThrows);
          const s = states[Math.min(i, states.length - 1)] as AdsState;
          i += 1;
          return s;
        },
      }) as never;
  return { browser, opened, calls };
}

const tools = (browser: never, videos: YtVideo[]) =>
  createYoutubeTools({ browser, search: async () => videos, sleep: async () => undefined, startupMs: 5000 }) as unknown as [
    { execute: (a: Record<string, unknown>) => Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> },
    { execute: (a: Record<string, unknown>) => Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> },
  ];

const official = video({ id: 'b2222222222', title: 'Tum Hi Ho Full Song | Aashiqui 2', channel: 'T-Series', verified: true });

describe('play_on_youtube', () => {
  it('opens the right video, starts the advert helper, and reports that it is playing', async () => {
    const f = fakeBrowser([ads({ adShowing: true, waitingForAd: true }), ads({ adShowing: true, skipped: 1 }), ads({ skipped: 1 })]);
    const [play] = tools(f.browser, [official, video({ id: 'c3333333333', title: 'Tum Hi Ho cover', channel: 'Other' })]);
    const result = await play.execute({ query: 'Tum Hi Ho song' });
    expect(f.opened).toEqual(['https://www.youtube.com/watch?v=b2222222222']);
    expect(f.calls[0]).toEqual({ mode: 'watch', options: { keepPlaying: true, play: true } });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ played: true, adHelper: 'on', advertsSkipped: 1, video: { channel: 'T-Series' } });
  });

  it('plays the next candidate when asked for index 2', async () => {
    const f = fakeBrowser([ads()]);
    const second = video({ id: 'c3333333333', title: 'Tum Hi Ho Aashiqui 2 Video Song', channel: 'Other Channel' });
    const [play] = tools(f.browser, [official, second]);
    await play.execute({ query: 'Tum Hi Ho song', index: 2 });
    expect(f.opened[0]).toBe('https://www.youtube.com/watch?v=c3333333333');
  });

  it('still opens the video when the adverts cannot be skipped here, and says so', async () => {
    const f = fakeBrowser([], { adsMissing: true });
    const [play] = tools(f.browser, [official]);
    const result = await play.execute({ query: 'Tum Hi Ho song' });
    expect(f.opened).toHaveLength(1);
    expect(result.data).toMatchObject({ played: false, adHelper: 'unavailable' });
  });

  it('an out-of-date extension is reported, with the video still opened', async () => {
    const f = fakeBrowser([], { adsThrows: 'The Eya browser extension is out of date' });
    const [play] = tools(f.browser, [official]);
    const result = await play.execute({ query: 'Tum Hi Ho song' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ adHelper: 'unavailable' });
    expect(String(result.data?.['adHelperReason'])).toMatch(/out of date/);
  });

  it('says the browser is waiting for a click when the video is open but paused', async () => {
    const f = fakeBrowser([ads({ video: { paused: true, ended: false, seconds: 0, length: 240 } })]);
    const [play] = tools(f.browser, [official]);
    const result = await play.execute({ query: 'Tum Hi Ho song' });
    expect(result.data?.['played']).toBe(false);
    expect(String(result.data?.['note'])).toMatch(/press play once/);
  });

  it('does not play a pirated "full movie"; it points to the legal route', async () => {
    const f = fakeBrowser([ads()]);
    const [play] = tools(f.browser, [video({ id: 'a1111111111', title: 'Kesari Full Movie 2019', channel: 'Random Uploads', seconds: 9000 })]);
    const result = await play.execute({ query: 'Kesari full movie' });
    expect(f.opened).toHaveLength(0);
    expect(result.summary).toBe('no official full film on YouTube');
    expect(String(result.data?.['note'])).toMatch(/deep_research/);
  });

  it('opens the YouTube search for a request it cannot match', async () => {
    const f = fakeBrowser([ads()]);
    const [play] = tools(f.browser, []);
    const result = await play.execute({ query: 'qwertyuiop song' });
    expect(f.opened[0]).toMatch(/results\?search_query=qwertyuiop/);
    expect(result.data?.['played']).toBe(false);
  });
});

describe('skip_ads', () => {
  it('turns on the helper and reports what it skipped', async () => {
    const f = fakeBrowser([ads({ adShowing: true }), ads({ adShowing: true }), ads({ skipped: 1 })]);
    const [, skip] = tools(f.browser, []);
    const result = await skip.execute({});
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('skipped 1 advert');
    expect(f.calls[0]).toEqual({ mode: 'watch', options: { keepPlaying: true } });
  });

  it('says so on a page that is not YouTube', async () => {
    const f = fakeBrowser([ads({ onYouTube: false })]);
    const [, skip] = tools(f.browser, []);
    const result = await skip.execute({});
    expect(result.summary).toBe('not a YouTube page');
  });

  it('stops watching when asked, and is honest when the browser cannot do it', async () => {
    const f = fakeBrowser([ads({ watching: false })]);
    const [, skip] = tools(f.browser, []);
    expect((await skip.execute({ stop: true })).summary).toBe('stopped watching for adverts');
    const none = tools(fakeBrowser([], { adsMissing: true }).browser, []);
    const result = await none[1].execute({});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/your own browser/);
  });
});
