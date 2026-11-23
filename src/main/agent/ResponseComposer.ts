import type { ToolResult } from '@main/tools/types';

export interface ComposeInput {
  readonly userText: string;
  readonly intentTool?: string;
  readonly toolResult?: ToolResult;
  readonly errorHint?: string;
}

/**
 * Turn raw tool results into short, natural, speakable lines. This is the
 * only place we phrase things for the user; tools return technical summaries.
 */
export class ResponseComposer {
  compose(input: ComposeInput): string {
    if (input.errorHint !== undefined) return input.errorHint;

    const result = input.toolResult;
    if (result === undefined) return "I'm not sure how to help with that yet.";

    if (input.intentTool === 'open_application') {
      const app = (result.data?.['app'] as string | undefined) ?? 'that app';
      if (result.ok) return 'Done.';
      if (result.data?.['reason'] === 'not_installed') {
        const alternatives = result.data['alternatives'];
        const alt = Array.isArray(alternatives) ? (alternatives[0] as string | undefined) : undefined;
        return alt !== undefined
          ? `${capitalize(app)} isn't installed, but ${capitalize(alt)} is. Want me to open that?`
          : `${capitalize(app)} isn't installed.`;
      }
      return `I couldn't open ${app}.`;
    }

    if (input.intentTool === 'close_application') {
      const app = (result.data?.['app'] as string | undefined) ?? 'that app';
      const alreadyClosed = result.data?.['alreadyClosed'] === true;
      if (result.ok && alreadyClosed) return `${capitalize(app)} wasn't running.`;
      if (result.ok) return 'Done.';
      if (result.data?.['reason'] === 'still_open') {
        return `${capitalize(app)} is still open. It may be waiting for you to save something.`;
      }
      return `I couldn't close ${app}.`;
    }

    return result.ok ? 'Done.' : "That didn't work.";
  }
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
