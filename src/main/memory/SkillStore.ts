import type { Sql } from './sqlite';
import { looksSensitive, normalizeKey, normalizeUtterance } from './normalize';
import { STEP_ACTIONS, VERIFY_KINDS } from './types';
import type { NewStep, RunOutcome, Skill, SkillDetail, SkillRun, SkillStep } from './types';

const MAX_TRIGGERS = 12;
const MAX_STEPS = 30;
const MAX_TEXT = 200;
const KEEP_RUNS = 20;

interface SkillRow {
  id: number;
  name: string;
  description: string;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  use_count: number;
  success_count: number;
  failure_count: number;
}

interface StepRow {
  position: number;
  action: string;
  target: string;
  value: string;
  submit: number;
  verify_kind: string;
  verify_text: string;
}

const toSkill = (r: SkillRow): Skill => ({
  id: r.id,
  name: r.name,
  description: r.description,
  enabled: r.enabled === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastUsedAt: r.last_used_at,
  useCount: r.use_count,
  successCount: r.success_count,
  failureCount: r.failure_count,
});

const toStep = (r: StepRow): SkillStep => ({
  position: r.position,
  action: r.action as SkillStep['action'],
  target: r.target,
  value: r.value,
  submit: r.submit === 1,
  verifyKind: r.verify_kind as SkillStep['verifyKind'],
  verifyText: r.verify_text,
});

export type SkillRejectedWhy = 'name' | 'name_taken' | 'trigger' | 'trigger_taken' | 'steps' | 'step' | 'not_found';

export class SkillRejected extends Error {
  constructor(
    readonly why: SkillRejectedWhy,
    message: string,
    /** For trigger_taken: the routine that already answers to that wording. */
    readonly otherSkill?: string,
  ) {
    super(message);
    this.name = 'SkillRejected';
  }
}

/** Checks one step is something a routine can actually do, and says plainly why not when it is not. */
export function validateStep(step: NewStep, index: number): void {
  const n = index + 1;
  if (!(STEP_ACTIONS as readonly string[]).includes(step.action)) throw new SkillRejected('step', `Step ${n}: "${step.action}" is not something a routine can do.`);
  if (!(VERIFY_KINDS as readonly string[]).includes(step.verifyKind)) throw new SkillRejected('step', `Step ${n}: unknown kind of check "${step.verifyKind}".`);
  const need = (what: string, text: string) => {
    if (text.trim() === '') throw new SkillRejected('step', `Step ${n} (${step.action}) needs ${what}.`);
    if (text.length > MAX_TEXT) throw new SkillRejected('step', `Step ${n}: the ${what} is too long.`);
  };
  switch (step.action) {
    case 'open_url':
      need('a web address', step.target);
      if (!/^https?:\/\//i.test(step.target.trim())) throw new SkillRejected('step', `Step ${n}: a routine can only open normal http or https addresses.`);
      break;
    case 'open_app':
      need('an application name', step.target);
      break;
    case 'find_text':
    case 'click_text':
    case 'download_file':
      need('the text to look for', step.target);
      break;
    case 'type_text':
    case 'select_option':
      need("the field's label", step.target);
      need('the text or option', step.value);
      if (looksSensitive(step.target) || looksSensitive(step.value)) throw new SkillRejected('step', `Step ${n}: a routine never types passwords, codes or card numbers.`);
      break;
    case 'save_file':
      need('a folder', step.target);
      break;
    case 'verify':
      if (step.verifyKind === 'none') throw new SkillRejected('step', `Step ${n}: a check needs to say what to check.`);
      break;
  }
  if (step.verifyKind !== 'none') need('the text to check for', step.verifyText);
}

/**
 * Routines: what each one is called, the wordings that run it, the steps it takes (each with its own check), and how it has been
 * doing. Every change goes through here, is all-or-nothing, and tells listeners (the matcher's lookup, the panel) that something moved.
 */
export class SkillStore {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly db: Sql,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------------------------------------------- reading
  list(): Skill[] {
    return this.db.all<SkillRow>('SELECT * FROM skills ORDER BY name COLLATE NOCASE').map(toSkill);
  }

  get(id: number): Skill | undefined {
    const r = this.db.get<SkillRow>('SELECT * FROM skills WHERE id = ?', [id]);
    return r === undefined ? undefined : toSkill(r);
  }

  getByName(name: string): Skill | undefined {
    const r = this.db.get<SkillRow>('SELECT * FROM skills WHERE name = ? COLLATE NOCASE', [name.trim()]);
    return r === undefined ? undefined : toSkill(r);
  }

  triggersOf(id: number): string[] {
    return this.db.all<{ trigger_text: string }>('SELECT trigger_text FROM skill_triggers WHERE skill_id = ? ORDER BY id', [id]).map((r) => r.trigger_text);
  }

  stepsOf(id: number): SkillStep[] {
    return this.db.all<StepRow>('SELECT position, action, target, value, submit, verify_kind, verify_text FROM skill_steps WHERE skill_id = ? ORDER BY position', [id]).map(toStep);
  }

  detail(id: number): SkillDetail | undefined {
    const skill = this.get(id);
    return skill === undefined ? undefined : { ...skill, triggers: this.triggersOf(id), steps: this.stepsOf(id) };
  }

  detailByName(name: string): SkillDetail | undefined {
    const skill = this.getByName(name);
    return skill === undefined ? undefined : this.detail(skill.id);
  }

  listDetails(): SkillDetail[] {
    return this.list().map((s) => ({ ...s, triggers: this.triggersOf(s.id), steps: this.stepsOf(s.id) }));
  }

  /** Every wording that runs an ENABLED routine, in its plain form — what the matcher looks things up in. */
  enabledTriggers(): Array<{ readonly skillId: number; readonly text: string; readonly norm: string }> {
    return this.db
      .all<{ skill_id: number; trigger_text: string; trigger_norm: string }>(
        'SELECT t.skill_id, t.trigger_text, t.trigger_norm FROM skill_triggers t JOIN skills s ON s.id = t.skill_id WHERE s.enabled = 1',
      )
      .map((r) => ({ skillId: r.skill_id, text: r.trigger_text, norm: r.trigger_norm }));
  }

  /** The routine (enabled or not) that answers to exactly this wording. */
  findByTrigger(text: string): Skill | undefined {
    const norm = normalizeUtterance(text);
    if (norm === '') return undefined;
    const r = this.db.get<SkillRow>('SELECT s.* FROM skills s JOIN skill_triggers t ON t.skill_id = s.id WHERE t.trigger_norm = ?', [norm]);
    return r === undefined ? undefined : toSkill(r);
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT count(*) AS n FROM skills')?.n ?? 0;
  }

  // ------------------------------------------------------------------------------------------------- writing
  private cleanName(name: string): string {
    const n = name.trim().replace(/\s+/g, ' ');
    if (n === '' || n.length > 80) throw new SkillRejected('name', 'A routine needs a short name.');
    return n;
  }

  /** Normalises and checks wordings: none empty, none already meaning a different routine, no duplicates, not too many. */
  private cleanTriggers(texts: readonly string[], forSkill: number | null): Array<{ text: string; norm: string }> {
    const out: Array<{ text: string; norm: string }> = [];
    for (const raw of texts) {
      const text = raw.trim().replace(/\s+/g, ' ');
      const norm = normalizeUtterance(text);
      if (norm === '') continue;
      if (text.length > 120) throw new SkillRejected('trigger', 'A wording for a routine should be a short phrase.');
      if (out.some((t) => t.norm === norm)) continue;
      const other = this.db.get<{ id: number; name: string }>('SELECT s.id, s.name FROM skill_triggers t JOIN skills s ON s.id = t.skill_id WHERE t.trigger_norm = ?', [norm]);
      if (other !== undefined && other.id !== forSkill) {
        throw new SkillRejected('trigger_taken', `"${text}" already runs the routine "${other.name}".`, other.name);
      }
      out.push({ text, norm });
    }
    if (out.length === 0) throw new SkillRejected('trigger', 'A routine needs at least one phrase that runs it.');
    if (out.length > MAX_TRIGGERS) throw new SkillRejected('trigger', `A routine can have at most ${MAX_TRIGGERS} phrases.`);
    return out;
  }

  private cleanSteps(steps: readonly NewStep[]): NewStep[] {
    if (steps.length === 0) throw new SkillRejected('steps', 'A routine needs at least one step.');
    if (steps.length > MAX_STEPS) throw new SkillRejected('steps', `A routine can have at most ${MAX_STEPS} steps.`);
    steps.forEach((s, i) => validateStep(s, i));
    return steps.map((s) => ({ ...s, target: s.target.trim(), value: s.value.trim(), verifyText: s.verifyText.trim() }));
  }

  private insertSteps(skillId: number, steps: readonly NewStep[]): void {
    steps.forEach((s, i) =>
      this.db.run('INSERT INTO skill_steps (skill_id, position, action, target, value, submit, verify_kind, verify_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        skillId,
        i + 1,
        s.action,
        s.target,
        s.value,
        s.submit ? 1 : 0,
        s.verifyKind,
        s.verifyText,
      ]),
    );
  }

  create(input: { readonly name: string; readonly description?: string; readonly triggers: readonly string[]; readonly steps: readonly NewStep[] }): SkillDetail {
    const name = this.cleanName(input.name);
    if (this.getByName(name) !== undefined) throw new SkillRejected('name_taken', `There is already a routine called "${name}".`, name);
    const triggers = this.cleanTriggers(input.triggers, null);
    const steps = this.cleanSteps(input.steps);
    const at = this.clock();
    const id = this.db.transaction(() => {
      const r = this.db.run('INSERT INTO skills (name, description, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)', [name, (input.description ?? '').trim().slice(0, 300), at, at]);
      for (const t of triggers) this.db.run('INSERT INTO skill_triggers (skill_id, trigger_text, trigger_norm) VALUES (?, ?, ?)', [r.lastInsertRowid, t.text, t.norm]);
      this.insertSteps(r.lastInsertRowid, steps);
      return r.lastInsertRowid;
    });
    this.changed();
    return this.detail(id) as SkillDetail;
  }

  private touch(id: number): void {
    this.db.run('UPDATE skills SET updated_at = ? WHERE id = ?', [this.clock(), id]);
  }

  private mustExist(id: number): Skill {
    const s = this.get(id);
    if (s === undefined) throw new SkillRejected('not_found', 'There is no such routine.');
    return s;
  }

  setEnabled(id: number, enabled: boolean): void {
    this.mustExist(id);
    this.db.run('UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ?', [enabled ? 1 : 0, this.clock(), id]);
    this.changed();
  }

  rename(id: number, name: string): void {
    this.mustExist(id);
    const n = this.cleanName(name);
    const clash = this.getByName(n);
    if (clash !== undefined && clash.id !== id) throw new SkillRejected('name_taken', `There is already a routine called "${n}".`, n);
    this.db.run('UPDATE skills SET name = ?, updated_at = ? WHERE id = ?', [n, this.clock(), id]);
    this.changed();
  }

  setDescription(id: number, description: string): void {
    this.mustExist(id);
    this.db.run('UPDATE skills SET description = ?, updated_at = ? WHERE id = ?', [description.trim().slice(0, 300), this.clock(), id]);
    this.changed();
  }

  /** Replaces all of a routine's wordings at once. */
  setTriggers(id: number, texts: readonly string[]): void {
    this.mustExist(id);
    const triggers = this.cleanTriggers(texts, id);
    this.db.transaction(() => {
      this.db.run('DELETE FROM skill_triggers WHERE skill_id = ?', [id]);
      for (const t of triggers) this.db.run('INSERT INTO skill_triggers (skill_id, trigger_text, trigger_norm) VALUES (?, ?, ?)', [id, t.text, t.norm]);
      this.touch(id);
    });
    this.changed();
  }

  addTrigger(id: number, text: string): void {
    this.setTriggers(id, [...this.triggersOf(id), text]);
  }

  removeTrigger(id: number, text: string): void {
    const norm = normalizeUtterance(text);
    const left = this.triggersOf(id).filter((t) => normalizeUtterance(t) !== norm);
    this.setTriggers(id, left);
  }

  /** Replaces a routine's steps (an improved workflow), keeping its name, wordings and history. */
  replaceSteps(id: number, steps: readonly NewStep[]): void {
    this.mustExist(id);
    const clean = this.cleanSteps(steps);
    this.db.transaction(() => {
      this.db.run('DELETE FROM skill_steps WHERE skill_id = ?', [id]);
      this.insertSteps(id, clean);
      this.touch(id);
    });
    this.changed();
  }

  delete(id: number): boolean {
    const r = this.db.run('DELETE FROM skills WHERE id = ?', [id]);
    if (r.changes > 0) this.changed();
    return r.changes > 0;
  }

  // ---------------------------------------------------------------------------------------------- run history
  /** Records how a run went: counts, when it was last used, and a short line in the history (kept to the latest few). */
  recordRun(id: number, outcome: RunOutcome, failedStep: number | null = null, detail = ''): void {
    this.mustExist(id);
    const at = this.clock();
    const ok = outcome === 'success';
    this.db.transaction(() => {
      this.db.run(
        `UPDATE skills SET use_count = use_count + 1, success_count = success_count + ?, failure_count = failure_count + ?, last_used_at = ? WHERE id = ?`,
        [ok ? 1 : 0, ok || outcome === 'needs_user' ? 0 : 1, at, id],
      );
      this.db.run('INSERT INTO skill_runs (skill_id, started_at, outcome, failed_step, detail) VALUES (?, ?, ?, ?, ?)', [id, at, outcome, failedStep, detail.slice(0, 300)]);
      this.db.run('DELETE FROM skill_runs WHERE skill_id = ? AND id NOT IN (SELECT id FROM skill_runs WHERE skill_id = ? ORDER BY id DESC LIMIT ?)', [id, id, KEEP_RUNS]);
    });
    this.changed();
  }

  recentRuns(id: number, limit = 10): SkillRun[] {
    return this.db
      .all<{ started_at: string; outcome: RunOutcome; failed_step: number | null; detail: string }>('SELECT started_at, outcome, failed_step, detail FROM skill_runs WHERE skill_id = ? ORDER BY id DESC LIMIT ?', [id, limit])
      .map((r) => ({ startedAt: r.started_at, outcome: r.outcome, failedStep: r.failed_step, detail: r.detail }));
  }

  /** Finds a routine by its name or any of its wordings (loosely: both reduced to their plain form). */
  find(nameOrPhrase: string): Skill | undefined {
    return this.getByName(nameOrPhrase) ?? this.findByTrigger(nameOrPhrase) ?? this.list().find((s) => normalizeKey(s.name.replace(/_/g, ' ')) === normalizeKey(nameOrPhrase));
  }
}
