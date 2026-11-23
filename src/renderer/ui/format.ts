/** "2m ago", "1 hour ago", "yesterday", "Oct 3": how long ago something was, the way the Recent screen says it. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(then).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

/** "1.2 MB", "340 KB", "12 B": a file's size the way a person reads it. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** What the status line under Eya's name says. */
export function statusLine(input: { state: string; talk: 'off' | 'connecting' | 'on'; voiceOn: boolean; listening: boolean; wakeReady: boolean }): string {
  if (input.talk === 'connecting') return 'Connecting…';
  if (input.talk === 'on') {
    return input.state === 'speaking' ? 'Speaking…' : input.state === 'working' ? 'Working on it…' : input.state === 'thinking' ? 'Thinking…' : 'Live conversation · listening';
  }
  if (input.state === 'speaking') return 'Speaking…';
  if (input.state === 'working') return 'Working on it…';
  if (input.state === 'thinking') return 'Thinking…';
  if (!input.voiceOn) return 'Voice is off';
  if (!input.listening) return 'Starting up…';
  return input.wakeReady ? 'Ready · Listening for "Hey Eya"' : 'Ready · Listening';
}
