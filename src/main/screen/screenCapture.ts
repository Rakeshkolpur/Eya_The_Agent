/**
 * A picture of what is live on the user's screen — any application, not just a browser: the screen they are on, or one
 * application's window picked by its title. Built on Electron's own desktop capturer, passed in so it can be tested with
 * stand-ins. Nothing here reads or interprets the picture; it only returns the pixels for the user to keep.
 */

export interface ScreenPicture {
  readonly bytes: Buffer;
  readonly mime: 'image/png';
  readonly width: number;
  readonly height: number;
  readonly kind: 'screen' | 'window';
  /** The window's title for a window picture; empty for the screen. Used in the file name and to tell the user what was captured. */
  readonly label: string;
}

export interface ScreenCapture {
  /** Everything showing on the screen the user is on (the one their mouse is on). */
  screen(): Promise<ScreenPicture>;
  /** The open window whose title contains this text (case-insensitive); the frontmost one if several do. */
  window(titlePart: string): Promise<ScreenPicture>;
}

export class ScreenCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenCaptureError';
  }
}

/** The parts of Electron's desktop-capturer source this uses (structural, so a test can stand in for it). */
export interface CaptureSource {
  readonly id: string;
  /** For a window: its title. For a screen: "Screen 1" and so on. */
  readonly name: string;
  readonly display_id: string;
  readonly thumbnail: {
    isEmpty(): boolean;
    getSize(): { width: number; height: number };
    toPNG(): Buffer;
  };
}

export interface CaptureDeps {
  getSources(options: {
    types: Array<'screen' | 'window'>;
    thumbnailSize: { width: number; height: number };
    fetchWindowIcons?: boolean;
  }): Promise<readonly CaptureSource[]>;
  /** The display the mouse is on: its id, size in device-independent pixels, and scale factor (1.25 at 125% scaling). */
  cursorDisplay(): { id: number; size: { width: number; height: number }; scaleFactor: number };
  /**
   * The real size of a window, by its capture source id. The capturer scales a thumbnail to whatever size it is asked for
   * — up as well as down — so a window picture at the window's own size needs this. Null when it cannot be found out.
   */
  windowSize?(sourceId: string): Promise<{ width: number; height: number } | null>;
}

// For finding which windows exist and can be captured: a thumbnail this small costs almost nothing.
const LISTING_SIZE = { width: 16, height: 16 };

function toPicture(source: CaptureSource, kind: 'screen' | 'window', label: string): ScreenPicture {
  const bytes = source.thumbnail.toPNG();
  const { width, height } = source.thumbnail.getSize();
  if (bytes.length < 64 || width < 1 || height < 1) throw new ScreenCaptureError('Windows gave back an empty picture.');
  return { bytes, mime: 'image/png', width, height, kind, label };
}

export function createScreenCapture(deps: CaptureDeps): ScreenCapture {
  return {
    async screen(): Promise<ScreenPicture> {
      const display = deps.cursorDisplay();
      // Ask for the screen's real pixel size (125% scaling means more pixels than the nominal size), or it comes back softened.
      const thumbnailSize = {
        width: Math.max(1, Math.round(display.size.width * display.scaleFactor)),
        height: Math.max(1, Math.round(display.size.height * display.scaleFactor)),
      };
      const sources = await deps.getSources({ types: ['screen'], thumbnailSize });
      const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
      if (source === undefined || source.thumbnail.isEmpty()) {
        throw new ScreenCaptureError('Windows would not let Eya capture the screen right now.');
      }
      return toPicture(source, 'screen', '');
    },

    async window(titlePart: string): Promise<ScreenPicture> {
      const wanted = titlePart.trim().toLowerCase();
      if (wanted === '') throw new ScreenCaptureError('Which window? Say part of its title, for example "Notepad".');
      const listed = await deps.getSources({ types: ['window'], thumbnailSize: LISTING_SIZE, fetchWindowIcons: false });
      // The capturer lists windows front to back, so the first match is the one the user most likely means.
      const matches = listed.filter((s) => s.name.trim() !== '' && s.name.toLowerCase().includes(wanted));
      if (matches.length === 0) {
        throw new ScreenCaptureError(`No open window has "${titlePart.trim()}" in its title. Ask the user which application they mean.`);
      }
      const usable = matches.find((s) => !s.thumbnail.isEmpty());
      if (usable === undefined) {
        throw new ScreenCaptureError(
          `The "${matches[0]?.name ?? titlePart}" window is open but Windows would not let Eya capture it (it may be minimised). Ask the user to bring it to the front, or capture the whole screen instead.`,
        );
      }

      // The picture at the window's OWN size. If that cannot be found out, fall back to the size of the screen the user is on
      // (a window never exceeds it much) — a little soft for a small window, but never an enormous enlargement.
      const real = (await deps.windowSize?.(usable.id).catch(() => null)) ?? null;
      const display = deps.cursorDisplay();
      const bound = real ?? {
        width: Math.max(1, Math.round(display.size.width * display.scaleFactor)),
        height: Math.max(1, Math.round(display.size.height * display.scaleFactor)),
      };
      const sources = await deps.getSources({ types: ['window'], thumbnailSize: bound, fetchWindowIcons: false });
      const fresh = sources.find((s) => s.id === usable.id);
      if (fresh === undefined || fresh.thumbnail.isEmpty()) {
        throw new ScreenCaptureError(`The "${usable.name}" window went away or stopped being capturable just now. Try again.`);
      }
      return toPicture(fresh, 'window', fresh.name);
    },
  };
}
