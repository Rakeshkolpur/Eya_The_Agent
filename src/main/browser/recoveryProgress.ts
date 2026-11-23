import type { RecoveryEvent } from './navigationRecovery';

/** The part of the browser panel the progress goes to. */
export interface ProgressPanel {
  progress(kind: 'now' | 'done' | 'warn', text: string): void;
  blocked(text: string): void;
}

/**
 * Shows what the recovery of a page (or a download) is doing in "Your Agent at Work": the thing being worked on right now as the current
 * line, what went well as a ticked step, what did not as a crossed one, and what only the person can settle as what the task is waiting for.
 */
export function showRecoveryEvent(panel: ProgressPanel, event: RecoveryEvent): void {
  switch (event.kind) {
    case 'opening':
    case 'searching':
    case 'verifying':
    case 'locating':
    case 'checking':
    case 'download_started':
      panel.progress('now', event.message);
      return;
    case 'loaded':
    case 'redirect':
    case 'content_found':
    case 'download_completed':
      panel.progress('done', event.message);
      return;
    case 'recovering':
    case 'failed':
      panel.progress('warn', event.message);
      return;
    case 'needs_you':
      panel.blocked(event.message);
      return;
  }
}
