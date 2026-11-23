export type MemoryType = 'preference' | 'fact';

export interface Memory {
  readonly id: number;
  readonly type: MemoryType;
  readonly key: string;
  readonly value: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The words a routine is made of. Each is a high-level action carried out through Eya's own tools, found by what is on the page
 * (a link's text, a field's label) — never by where something happened to be on the screen.
 */
export const STEP_ACTIONS = ['open_url', 'open_app', 'find_text', 'click_text', 'type_text', 'select_option', 'download_file', 'save_file', 'verify'] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

/** What a step checks about the world after it ran, before the routine goes on. */
export const VERIFY_KINDS = ['none', 'page_contains', 'url_contains', 'title_contains'] as const;
export type VerifyKind = (typeof VERIFY_KINDS)[number];

export interface NewStep {
  readonly action: StepAction;
  /** A web address, an application name, the text of a link or button, a field's label, or a folder — depending on the action. */
  readonly target: string;
  /** Text to type, an option to choose, or a new file name. */
  readonly value: string;
  /** Press Enter after typing (a search box with no button). */
  readonly submit: boolean;
  readonly verifyKind: VerifyKind;
  readonly verifyText: string;
}

export interface SkillStep extends NewStep {
  readonly position: number;
}

export interface Skill {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
  readonly useCount: number;
  readonly successCount: number;
  readonly failureCount: number;
}

export interface SkillDetail extends Skill {
  readonly triggers: readonly string[];
  readonly steps: readonly SkillStep[];
}

export type RunOutcome = 'success' | 'failed' | 'needs_user' | 'verify_failed';

export interface SkillRun {
  readonly startedAt: string;
  readonly outcome: RunOutcome;
  readonly failedStep: number | null;
  readonly detail: string;
}
