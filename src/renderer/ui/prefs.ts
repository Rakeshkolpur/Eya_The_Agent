/** Small choices about how the Eya window looks, kept in this window's own storage (never anything private). Unavailable storage just means the defaults. */

const THEME_KEY = 'eya.theme';
const SPLIT_KEY = 'eya.autoSplit';

export type Theme = 'light' | 'dark';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // blocked storage: the choice lasts until the window closes
  }
}

export function getTheme(): Theme {
  return read(THEME_KEY) === 'dark' ? 'dark' : 'light';
}

export function setTheme(theme: Theme): void {
  write(THEME_KEY, theme);
}

/** Whether Eya opens the browser beside herself when a task starts working on a website (on unless the user turned it off). */
export function getAutoSplit(): boolean {
  return read(SPLIT_KEY) !== 'off';
}

export function setAutoSplit(on: boolean): void {
  write(SPLIT_KEY, on ? 'on' : 'off');
}

/** "Good morning", "Good afternoon", "Good evening", by the hour. */
export function greetingFor(date: Date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return 'Good Evening';
  if (h < 12) return 'Good Morning';
  if (h < 17) return 'Good Afternoon';
  return 'Good Evening';
}
