import { describe, it, expect } from 'vitest';
import { ScreenCaptureError, createScreenCapture } from '../src/main/screen/screenCapture';
import type { CaptureDeps, CaptureSource } from '../src/main/screen/screenCapture';
import { fakePng } from './screenshotFixtures';

function source(over: Partial<CaptureSource> & { size?: { width: number; height: number }; empty?: boolean } = {}): CaptureSource {
  const size = over.size ?? { width: 1920, height: 1080 };
  const png = fakePng(size.width, size.height, 400);
  return {
    id: over.id ?? 'screen:0:0',
    name: over.name ?? 'Screen 1',
    display_id: over.display_id ?? '1',
    thumbnail: { isEmpty: () => over.empty === true, getSize: () => size, toPNG: () => png },
  };
}

function rig(
  sources: CaptureSource[],
  display = { id: 1, size: { width: 1536, height: 864 }, scaleFactor: 1.25 },
  windowSize?: CaptureDeps['windowSize'],
) {
  const asked: Array<Parameters<CaptureDeps['getSources']>[0]> = [];
  const capture = createScreenCapture({
    getSources: async (o) => {
      asked.push(o);
      return sources;
    },
    cursorDisplay: () => display,
    ...(windowSize !== undefined ? { windowSize } : {}),
  });
  return { capture, asked };
}

describe('capturing the screen the user is on', () => {
  it('asks for the screen\'s real pixel size (nominal size x scale factor), so a scaled display is not softened', async () => {
    const { capture, asked } = rig([source()]);
    await capture.screen();
    expect(asked[0]).toMatchObject({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
  });

  it('picks the display the mouse is on, by id, when there are several', async () => {
    const left = source({ display_id: '1', name: 'Screen 1', size: { width: 1920, height: 1080 } });
    const right = source({ display_id: '2', name: 'Screen 2', size: { width: 2560, height: 1440 } });
    const { capture } = rig([left, right], { id: 2, size: { width: 2560, height: 1440 }, scaleFactor: 1 });
    expect(await capture.screen()).toMatchObject({ kind: 'screen', width: 2560, height: 1440, label: '' });
  });

  it('falls back to the first screen if none carries that display id', async () => {
    const { capture } = rig([source({ display_id: '77', size: { width: 1280, height: 720 } })]);
    expect((await capture.screen()).width).toBe(1280);
  });

  it('hands back the PNG bytes untouched', async () => {
    const s = source();
    const { capture } = rig([s]);
    const pic = await capture.screen();
    expect(pic.mime).toBe('image/png');
    expect(pic.bytes.equals(s.thumbnail.toPNG())).toBe(true);
  });

  it('says so when Windows gives nothing, or an empty picture', async () => {
    await expect(rig([]).capture.screen()).rejects.toThrow(ScreenCaptureError);
    await expect(rig([source({ empty: true })]).capture.screen()).rejects.toThrow(/would not let Eya capture the screen/);
  });
});

describe('capturing one application\'s window', () => {
  const windows = [
    source({ id: 'window:1:0', name: 'Claude', display_id: '', size: { width: 1400, height: 900 } }),
    source({ id: 'window:2:0', name: 'report.docx - Word', display_id: '', size: { width: 1000, height: 700 } }),
    source({ id: 'window:3:0', name: 'Claude - settings', display_id: '', size: { width: 600, height: 400 } }),
    source({ id: 'window:4:0', name: '   ', display_id: '', size: { width: 50, height: 50 } }),
  ];

  it('finds a window by part of its title, ignoring case, and takes the frontmost match', async () => {
    const { capture } = rig(windows);
    expect(await capture.window('claude')).toMatchObject({ kind: 'window', label: 'Claude', width: 1400, height: 900 });
    expect(await capture.window('WORD')).toMatchObject({ label: 'report.docx - Word' });
  });

  it('asks for the picture at the real size of the window — measured: asking for "as big as possible" returns a blurry 5x enlargement', async () => {
    const sizes: string[] = [];
    const { capture, asked } = rig(windows, undefined, async (id) => {
      sizes.push(id);
      return { width: 1440, height: 748 };
    });
    await capture.window('Claude');
    expect(sizes).toEqual(['window:1:0']); // asked about the window that matched, once
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({ types: ['window'], thumbnailSize: { width: 16, height: 16 }, fetchWindowIcons: false }); // just finding it
    expect(asked[1]).toMatchObject({ types: ['window'], thumbnailSize: { width: 1440, height: 748 }, fetchWindowIcons: false }); // the picture
  });

  it('when the size of the window cannot be found out, falls back to the size of the screen (never a huge enlargement)', async () => {
    const none = rig(windows, undefined, async () => null);
    await none.capture.window('Claude');
    expect(none.asked[1]?.thumbnailSize).toEqual({ width: 1920, height: 1080 }); // 1536x864 at 125%
    const broken = rig(windows, undefined, async () => {
      throw new Error('powershell failed');
    });
    await broken.capture.window('Claude');
    expect(broken.asked[1]?.thumbnailSize).toEqual({ width: 1920, height: 1080 });
    const unsupported = rig(windows);
    await unsupported.capture.window('Claude');
    expect(unsupported.asked[1]?.thumbnailSize).toEqual({ width: 1920, height: 1080 });
  });

  it('says so if the window vanishes between finding it and capturing it', async () => {
    let call = 0;
    const capture = createScreenCapture({
      getSources: async () => (++call === 1 ? windows : []),
      cursorDisplay: () => ({ id: 1, size: { width: 1920, height: 1080 }, scaleFactor: 1 }),
      windowSize: async () => ({ width: 800, height: 600 }),
    });
    await expect(capture.window('Claude')).rejects.toThrow(/went away or stopped being capturable/);
  });

  it('skips matches that cannot be captured and uses the next one', async () => {
    const { capture } = rig([
      source({ id: 'window:10:0', name: 'Notes - draft', empty: true, display_id: '' }),
      source({ id: 'window:11:0', name: 'Notes - final', display_id: '', size: { width: 640, height: 480 } }),
    ]);
    expect(await capture.window('notes')).toMatchObject({ label: 'Notes - final' });
  });

  it('says the window is open but could not be captured when every match is empty (e.g. minimised)', async () => {
    const { capture } = rig([source({ name: 'Calculator', empty: true, display_id: '' })]);
    await expect(capture.window('calc')).rejects.toThrow(/open but Windows would not let Eya capture it.*minimised/);
  });

  it('says plainly there is no such window, without listing what else is open (titles can be private)', async () => {
    const { capture } = rig(windows);
    const err = await capture.window('zzz').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ScreenCaptureError);
    expect((err as Error).message).toMatch(/No open window has "zzz" in its title/);
    expect((err as Error).message).not.toMatch(/Word|Claude/);
  });

  it('refuses an empty title, and never matches a window that has no title at all', async () => {
    const { capture } = rig(windows);
    await expect(capture.window('   ')).rejects.toThrow(/Which window/);
    await expect(capture.window('')).rejects.toThrow(/Which window/);
    // The untitled 50x50 window is skipped even though an empty fragment "matches" it.
    const untitledOnly = rig([source({ name: '   ', display_id: '', size: { width: 50, height: 50 } })]).capture;
    await expect(untitledOnly.window('x')).rejects.toThrow(ScreenCaptureError);
  });
});
