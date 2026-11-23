import { describe, expect, it } from 'vitest';
import { LocalCommands } from '../src/main/local/LocalCommands';
import { parseLocalIntent } from '../src/main/local/localIntents';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';

/**
 * "Open YouTube and play a feel-good Telugu song" cost two to five model calls of about 16,000 tokens each, to end at one tool call
 * (play_on_youtube, which searches, picks, opens, skips the adverts and checks it started). It is now recognised by its shape and
 * carried out with no model. These tests pin what is claimed, what is left to the model, and that what is said is what the tool reported.
 */

const playOf = (text: string): { query: string; browser?: string } | null => {
  const intent = parseLocalIntent(text);
  return intent?.kind === 'play' ? { query: intent.query, ...(intent.browser !== undefined ? { browser: intent.browser } : {}) } : null;
};

describe('what is taken for "play it on YouTube"', () => {
  it('knows the ways of saying it, typos included', () => {
    expect(playOf('Open YouTube and play a feel-good Telugu song.')?.query).toBe('feel-good telugu song');
    expect(playOf('open youtube and play Tum Hi Ho')?.query).toBe('tum hi ho');
    expect(playOf('go to youtube then play naatu naatu song')?.query).toBe('naatu naatu song');
    expect(playOf('play tum hi ho on youtube')?.query).toBe('tum hi ho');
    expect(playOf('Could you please play some old Telugu songs in YouTube?')?.query).toBe('old telugu songs');
    expect(playOf('play on youtube kesariya')?.query).toBe('kesariya');
    expect(playOf('paly feel good telugu songs in youtub')?.query).toBe('feel good telugu songs');
    expect(playOf('watch the rrr trailer on the youtube website')?.query).toBe('rrr trailer');
    expect(playOf('hey eya open you tube and put on some relaxing music')?.query).toBe('relaxing music');
  });

  it('carries a browser the user named', () => {
    expect(playOf('play kesariya on youtube in edge')).toEqual({ query: 'kesariya', browser: 'edge' });
    expect(playOf('open youtube and play kesariya on chrome')).toEqual({ query: 'kesariya', browser: 'chrome' });
    // (play_on_youtube starts Chrome or Edge only)
    expect(playOf('play kesariya on youtube in firefox')).toBeNull();
  });

  it('leaves everything else to what handled it before', () => {
    // YouTube is not named: a bare "play <name>" is a file on this PC
    expect(parseLocalIntent('play kesariya')).toBeNull();
    expect(parseLocalIntent('play the video in my downloads')).toBeNull();
    // nothing to look for: what to play is the assistant's to choose
    expect(playOf('open youtube and play something')).toBeNull();
    expect(playOf('play music on youtube')).toBeNull();
    expect(playOf('play it on youtube')).toBeNull();
    // opening and searching are still opening and searching
    expect(parseLocalIntent('open youtube')?.kind).toBe('open_site');
    expect(parseLocalIntent('search cats on youtube')?.kind).toBe('search');
    // two jobs in one: not this one
    expect(playOf('play kesariya on youtube and open gmail')).toBeNull();
  });
});

describe('carrying it out', () => {
  const folders = { home: 'C:/h', desktop: 'C:/h/d', documents: 'C:/h/doc', downloads: 'C:/h/dl', pictures: 'C:/h/p', videos: 'C:/h/v', music: 'C:/h/m', temp: 'C:/t' } as KnownFolders;

  function local(answer: ToolResult): { run: (text: string, live?: boolean) => ReturnType<LocalCommands['tryHandle']>; calls: { name: string; args: ToolArgs }[] } {
    const calls: { name: string; args: ToolArgs }[] = [];
    const commands = new LocalCommands({
      tools: { invoke: async (name, args) => (calls.push({ name, args }), answer) },
      index: { ready: true, search: () => ({ hits: [], total: 0 }) as never, searchFolders: () => [] },
      folders,
    });
    return { run: (text, live) => commands.tryHandle(text, { live: live === true }), calls };
  }

  it('is one call to play_on_youtube, and says what it reported: playing', async () => {
    const t = local({ ok: true, summary: 'playing', data: { played: true, video: { title: 'Pachchandanam Telugu Song', channel: 'x', url: 'https://www.youtube.com/watch?v=abc' } } });
    const done = await t.run('Open YouTube and play a feel-good Telugu song.');
    expect(t.calls).toEqual([{ name: 'play_on_youtube', args: { query: 'feel-good telugu song' } }]);
    expect(done).toMatchObject({ ok: true, intent: 'play_on_youtube', tools: ['play_on_youtube'], urls: ['https://www.youtube.com/watch?v=abc'] });
    expect(done?.spoken).toBe('Playing Pachchandanam Telugu Song on YouTube.');
  });

  it('passes the browser the user named', async () => {
    const t = local({ ok: true, summary: 'playing', data: { played: true, video: { title: 'Kesariya', url: 'u' } } });
    await t.run('play kesariya on youtube in edge');
    expect(t.calls[0]?.args).toEqual({ query: 'kesariya', browser: 'edge' });
  });

  it('does not say "playing" when the video is only open', async () => {
    const waiting = local({ ok: true, summary: 'opened', data: { played: false, video: { title: 'Kesariya', url: 'u' }, stillInAnAdvert: false } });
    expect((await waiting.run('play kesariya on youtube'))?.spoken).toMatch(/opened Kesariya.*waiting for one click on play/);
    const advert = local({ ok: true, summary: 'opened', data: { played: false, video: { title: 'Kesariya', url: 'u' }, stillInAnAdvert: true } });
    expect((await advert.run('play kesariya on youtube'))?.spoken).toMatch(/advert that can't be skipped/);
  });

  it('says plainly when YouTube would not give a clear match', async () => {
    const t = local({ ok: true, summary: 'opened the YouTube search', data: { played: false, reason: 'no clear match' } });
    expect((await t.run('play kesariya on youtube'))?.spoken).toMatch(/opened YouTube's search/);
  });

  it('tells the person what to do when the browser would not answer, instead of asking a model to meet the same wall', async () => {
    const t = local({ ok: false, summary: 'browser not connected', error: 'long text for a model', data: { browserUnavailable: true, why: 'no_extension' } });
    const done = await t.run('play kesariya on youtube');
    expect(done).toMatchObject({ ok: false, intent: 'play_on_youtube' });
    expect(done?.spoken).toMatch(/couldn't reach your browser/);
    expect(done?.spoken).not.toMatch(/long text/);
  });

  it('a Stop is the end of it', async () => {
    const t = local({ ok: false, summary: 'stopped by the user', error: 'stopped', data: { stoppedByUser: true } });
    expect(await t.run('play kesariya on youtube')).toMatchObject({ ok: false, spoken: 'Okay, I stopped.' });
  });

  it('hands over to the model what needs a decision (a film with no official upload) or failed for another reason', async () => {
    const film = local({ ok: true, summary: 'no official full film on YouTube', data: { played: false, reason: 'no official full-length upload' } });
    expect(await film.run('play paradise movie on youtube')).toBeNull();
    const broken = local({ ok: false, summary: 'could not open YouTube', error: 'something else' });
    expect(await broken.run('play kesariya on youtube')).toBeNull();
  });

  it('is never done from always-on listening (it fetches from the internet)', async () => {
    const t = local({ ok: true, summary: 'playing', data: { played: true, video: { title: 'x', url: 'u' } } });
    expect(await t.run('play kesariya on youtube', true)).toBeNull();
    expect(t.calls).toEqual([]);
  });
});
