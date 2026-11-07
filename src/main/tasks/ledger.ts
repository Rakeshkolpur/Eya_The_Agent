import type { DoneCall } from '@shared/tasks';

/**
 * Keeping a task from doing the same thing twice. When a task is carried on after it was cut off (the AI ran out, a page was slow, Eya was closed), the
 * model is told what was already done, but a model can still do it again. So what changed something and worked is also kept as a record of exact
 * calls (the tool and its arguments), and a call that matches one is answered with "already done" instead of being run a second time.
 */

/**
 * Tools that change something that should not be done twice (a file moved, a folder made, a setting changed, a memory saved, a power action). Reading
 * tools are left out: running them again is harmless. Browser tools are left out too: what a page needs depends on the page as it is now, and the
 * browser has its own guard against repeating a click (see browser/loopGuard.ts).
 */
export const SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  'copy_file',
  'move_file',
  'rename_file',
  'delete_file',
  'delete_folder',
  'create_folder',
  'zip_folder',
  'download_file',
  'empty_recycle_bin',
  'restore_recycle_bin_item',
  'restore_all_recycle_bin_items',
  'permanently_delete_recycle_bin_item',
  'word_write',
  'word_edit',
  'word_format',
  'word_reference',
  'remember',
  'forget_memory',
  'save_routine',
  'update_routine',
  'delete_routine',
  'set_volume',
  'set_brightness',
  'mute_volume',
  'unmute_volume',
  'lock_screen',
  'restart_computer',
  'shutdown_computer',
  'close_application',
  'close_file',
  'attach_file',
  // (a file sent through the app's own "Select chats" step: a task carried on later never sends it a second time)
  'share_file_to_chat',
]);

/** The arguments in a fixed order, so the same call written in a different order is the same call. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** What identifies one call: the tool and its exact arguments (a call that asked for confirmation is not the one that was confirmed). */
export function callKey(name: string, args: unknown): string {
  return `${name}:${stable(args)}`.slice(0, 600);
}

export const MAX_DONE = 40;

/** The records kept with a task: the earlier ones and the new ones, each call once, the latest forty. */
export function mergeDone(older: readonly DoneCall[] | undefined, newer: readonly DoneCall[] | undefined): DoneCall[] {
  const seen = new Set<string>();
  const merged: DoneCall[] = [];
  for (const d of [...(older ?? []), ...(newer ?? [])]) {
    if (seen.has(d.key)) continue;
    seen.add(d.key);
    merged.push(d);
  }
  return merged.slice(-MAX_DONE);
}

/** The lines of what was done: the earlier ones and the new ones, a line that is already there is not added again. */
export function mergeSteps(older: readonly string[], newer: readonly string[] | undefined, keep = 20): string[] {
  const have = new Set(older);
  const out = [...older];
  for (const s of newer ?? []) {
    if (have.has(s)) continue;
    have.add(s);
    out.push(s);
  }
  return out.slice(-keep);
}
