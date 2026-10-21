"""Save a screenshot of the whole Windows desktop, or of one application's window, with PyAutoGUI.

Install (Pillow is needed explicitly on newer Pythons, where pyautogui does not pull it in):

    pip install pyautogui pillow

Use:

    from capture_screenshot import capture_screenshot

    capture_screenshot()                                   # whole desktop -> Desktop\\Screenshot <date time>.png
    capture_screenshot("shot.png")                         # whole desktop -> that file
    capture_screenshot("D:/shots")                         # whole desktop -> a file named for the time, in that folder
    capture_screenshot(window_title="Notepad")             # just the Notepad window, to the Desktop
    capture_screenshot("notepad.png", window_title="Notepad")

From a terminal:

    python capture_screenshot.py                           # whole desktop
    python capture_screenshot.py "Notepad"                 # one window (a part of its title is enough)
    python capture_screenshot.py "Notepad" -o notepad.png

Windows only for the window mode (it relies on PyGetWindow, which PyAutoGUI offers on Windows). The whole-desktop
mode is plain PyAutoGUI and works anywhere it does.
"""

from __future__ import annotations

import argparse
import ctypes
import re
import sys
import time
from ctypes import wintypes
from datetime import datetime
from pathlib import Path

_WINDOWS = sys.platform == "win32"

if _WINDOWS:
    # Per-monitor DPI awareness, set BEFORE pyautogui is imported (it would otherwise settle for "system" awareness):
    # on scaled or mixed-DPI displays it keeps window coordinates and screenshot pixels in agreement. If the program
    # that imports this has already chosen an awareness, Windows refuses the change and nothing happens.
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass

try:
    import pyautogui
    from PIL import Image
except ModuleNotFoundError as exc:  # pyautogui does not always bring Pillow with it
    raise ModuleNotFoundError(f"{exc.name!r} is not installed. Install what this needs with:  pip install pyautogui pillow") from exc

__all__ = ["capture_screenshot", "WindowNotFoundError"]


class WindowNotFoundError(LookupError):
    """No open, visible window matched the title that was asked for."""


# --------------------------------------------------------------------------------------------- where to save
def _desktop_folder() -> Path:
    """The user's real Desktop folder, even when OneDrive has moved it."""
    if _WINDOWS:
        buffer = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
        # CSIDL_DESKTOPDIRECTORY = 0x10
        if ctypes.windll.shell32.SHGetFolderPathW(None, 0x10, None, 0, buffer) == 0 and buffer.value:
            return Path(buffer.value)
    return Path.home() / "Desktop"


def _safe_label(text: str, limit: int = 60) -> str:
    """A window title made safe to put in a file name (Windows forbids  < > : " / \\ | ? *  and control characters)."""
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', " ", text)
    return re.sub(r"\s+", " ", cleaned).strip(" .")[:limit].strip(" .")


def _target_path(save_path: str | Path | None, label: str | None) -> Path:
    """Where to write. A folder (or nothing) gets a timestamped name; anything with an extension is the file itself."""
    stamp = datetime.now().strftime("%Y-%m-%d %H.%M.%S")
    name = f"Screenshot - {_safe_label(label)} - {stamp}.png" if label and _safe_label(label) else f"Screenshot {stamp}.png"
    if save_path is None:
        return _desktop_folder() / name
    target = Path(save_path).expanduser()
    if target.is_dir() or not target.suffix or str(save_path).endswith(("/", "\\")):
        return target / name
    if target.suffix.lower() not in Image.registered_extensions():
        raise ValueError(f"Cannot save a picture as {target.suffix!r}; use .png, .jpg, .bmp, .gif, .tiff or .webp")
    return target


def _save_without_overwriting(image: Image.Image, path: Path) -> Path:
    """Saves `image`, and never replaces a file that is already there: a taken name becomes 'name (2).png'."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fmt = Image.registered_extensions()[path.suffix.lower()]
    for n in range(1, 10_000):
        candidate = path if n == 1 else path.with_name(f"{path.stem} ({n}){path.suffix}")
        try:
            with open(candidate, "xb") as handle:  # "x": fail rather than overwrite, even if another process races us
                image.save(handle, format=fmt)
            return candidate
        except FileExistsError:
            continue
    raise FileExistsError(f"Too many files already named like {path.name!r} in {path.parent}")


# ------------------------------------------------------------------------------------------- finding a window
def _is_cloaked(hwnd: int) -> bool:
    """True for a window Windows keeps 'visible' but never draws (a suspended app, a window on another virtual desktop)."""
    cloaked = wintypes.DWORD(0)
    DWMWA_CLOAKED = 14
    try:
        ok = ctypes.windll.dwmapi.DwmGetWindowAttribute(wintypes.HWND(hwnd), DWMWA_CLOAKED, ctypes.byref(cloaked), ctypes.sizeof(cloaked)) == 0
    except Exception:
        return False
    return ok and cloaked.value != 0


def _find_window(title: str, exact: bool):
    """The best open window whose title contains `title` (case-insensitive), or equals it when `exact`."""
    wanted = title.casefold()
    matches = []
    for win in pyautogui.getWindowsWithTitle(title):
        shown = (win.title or "").strip()
        if not shown or not win.visible or _is_cloaked(win._hWnd):
            continue
        if exact and shown.casefold() != wanted:
            continue
        if not win.isMinimized and (win.width <= 0 or win.height <= 0):
            continue
        matches.append(win)
    if not matches:
        others = sorted({t.strip() for t in pyautogui.getAllTitles() if t.strip()})[:10]
        hint = f" Open windows include: {others}" if others else ""
        raise WindowNotFoundError(f"No open window has a title {'equal to' if exact else 'containing'} {title!r}.{hint}")
    # The window in front wins; otherwise the largest.
    return max(matches, key=lambda w: (bool(w.isActive), 0 if w.isMinimized else w.width * w.height))


def _visible_box(win) -> tuple[int, int, int, int]:
    """The window's visible rectangle. GetWindowRect includes ~7 invisible pixels of resize border on each side; the
    DWM 'extended frame bounds' are the edges you actually see."""
    rect = wintypes.RECT()
    DWMWA_EXTENDED_FRAME_BOUNDS = 9
    try:
        if ctypes.windll.dwmapi.DwmGetWindowAttribute(wintypes.HWND(win._hWnd), DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(rect), ctypes.sizeof(rect)) == 0:
            return rect.left, rect.top, rect.right, rect.bottom
    except Exception:
        pass
    return win.left, win.top, win.right, win.bottom


def _virtual_screen() -> tuple[int, int, int, int]:
    """Left, top, width, height of the area covered by ALL monitors (left/top are negative if a monitor sits left of / above the main one)."""
    metrics = ctypes.windll.user32.GetSystemMetrics
    return metrics(76), metrics(77), metrics(78), metrics(79)  # SM_X/Y/CX/CYVIRTUALSCREEN


def _bring_forward(win, bring_to_front: bool, settle_seconds: float) -> None:
    """Un-minimise the window and put it in front, so nothing is drawn over it when the picture is taken."""
    if win.isMinimized:
        win.restore()
    if bring_to_front:
        try:
            win.activate()
        except Exception:
            # Windows refuses to hand the foreground to a background process; minimise-then-restore usually works around it.
            win.minimize()
            time.sleep(0.2)
            win.restore()
    time.sleep(settle_seconds)  # let the window finish repainting before the shot


def _capture_window(title: str, *, exact: bool, bring_to_front: bool, settle_seconds: float) -> tuple[Image.Image, str]:
    if not _WINDOWS:
        raise OSError("Capturing a single window is supported on Windows only. Leave window_title out to capture the whole screen.")
    win = _find_window(title, exact)
    _bring_forward(win, bring_to_front, settle_seconds)

    left, top, right, bottom = _visible_box(win)  # read AFTER restoring: the window may have moved
    vx, vy, vw, vh = _virtual_screen()
    # A window can hang off the edge of the screen (a maximised one overhangs by a few pixels): keep what is on screen.
    left, top, right, bottom = max(left, vx), max(top, vy), min(right, vx + vw), min(bottom, vy + vh)
    if right <= left or bottom <= top:
        raise RuntimeError(f"The window {win.title!r} is entirely off-screen, so there is nothing to capture.")

    desktop = pyautogui.screenshot(allScreens=True)  # every monitor; its top-left pixel is the virtual screen's top-left
    sx, sy = desktop.width / vw, desktop.height / vh  # 1.0 unless the process is not DPI-aware
    box = (round((left - vx) * sx), round((top - vy) * sy), round((right - vx) * sx), round((bottom - vy) * sy))
    return desktop.crop(box), win.title


# ----------------------------------------------------------------------------------------------- the function
def capture_screenshot(
    save_path: str | Path | None = None,
    window_title: str | None = None,
    *,
    exact_title: bool = False,
    all_monitors: bool = True,
    bring_to_front: bool = True,
    settle_seconds: float = 0.5,
) -> Path:
    """Take a screenshot right now and save it as an image. Returns the path it was saved to.

    save_path      A file (``shot.png`` — the extension picks the format), a folder (a name made from the time is used),
                   or None for the Desktop. An existing file is never overwritten: ``shot (2).png`` is used instead.
    window_title   None captures the whole desktop. Otherwise the open window whose title contains this text
                   (case-insensitive; the window in front wins if several match) is captured, cropped to its visible edges.
    exact_title    Require the whole title to match, not just contain the text.
    all_monitors   Whole-desktop mode only: True (default) captures every monitor side by side, False just the main one.
    bring_to_front Window mode: restore it if minimised and bring it to the front first, so no other window covers it.
                   With False the picture is whatever is on screen where the window is, other windows' overlap included.
    settle_seconds Window mode: how long to wait after bringing it forward before the shot, so it has finished repainting.

    Raises WindowNotFoundError if no window matches, ValueError for an unsupported file type, OSError for window mode
    off Windows.
    """
    if window_title is not None:
        if not window_title.strip():
            raise ValueError("window_title is empty; leave it out (None) to capture the whole desktop")
        image, label = _capture_window(window_title, exact=exact_title, bring_to_front=bring_to_front, settle_seconds=settle_seconds)
    else:
        image, label = pyautogui.screenshot(allScreens=all_monitors), None
    return _save_without_overwriting(image, _target_path(save_path, label))


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Save a screenshot of the whole desktop or of one window.")
    parser.add_argument("window", nargs="?", help="part of a window's title; leave out for the whole desktop")
    parser.add_argument("-o", "--output", help="file or folder to save to (default: the Desktop)")
    parser.add_argument("--exact", action="store_true", help="the title must match exactly, not just contain the text")
    parser.add_argument("--main-monitor", action="store_true", help="whole-desktop mode: only the main monitor")
    parser.add_argument("--no-front", action="store_true", help="do not bring the window to the front first")
    args = parser.parse_args(argv)
    try:
        saved = capture_screenshot(args.output, args.window, exact_title=args.exact, all_monitors=not args.main_monitor, bring_to_front=not args.no_front)
    except (WindowNotFoundError, ValueError, OSError, RuntimeError) as err:
        print(f"Could not take the screenshot: {err}", file=sys.stderr)
        return 1
    print(f"Saved {saved}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
