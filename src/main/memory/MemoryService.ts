import { rootLogger } from '@main/logging/logger';
import { ContactBook } from '@main/chat/ContactBook';
import type { ToolArgs, ToolResult } from '@main/tools/types';
import { ActivityStore } from './ActivityStore';
import { CandidateStore } from './CandidateStore';
import { parseControl, parseRemember } from './controlCommands';
import type { ControlIntent } from './controlCommands';
import { MemoryRejected, MemoryStore } from './MemoryStore';
import { slugify, normalizeKey, contentTokens, normalizeUtterance } from './normalize';
import { migrate, openDatabaseSafely } from './sqlite';
import type { Sql } from './sqlite';
import { MIGRATIONS } from './schema';
import { SkillRejected, SkillStore } from './SkillStore';
import { SkillExecutor } from './skillExecutor';
import type { RoutineOutcome, ToolInvoker } from './skillExecutor';
import { SkillMatcher } from './skillMatcher';
import type { SkillMatch } from './skillMatcher';
import { signatureOf, TaskRecorder } from './taskRecorder';
import type { BeginOptions, TaskSuggestion } from './taskRecorder';
import type { Memory, MemoryType, NewStep, Skill, SkillDetail, SkillStep } from './types';

const log = rootLogger.child('memory');

const SUGGESTION_LIFE_MS = 10 * 60_000;
const CONFIRM_LIFE_MS = 2 * 60_000;

/** What a command turned out to be, when memory handled it (or part of it) before the model was asked. */
export type LocalOutcome =
  /** Done here: say this. */
  | { readonly kind: 'answered'; readonly spoken: string; readonly ok: boolean; readonly routine?: string }
  /** A routine stopped partway (it needs the user, or something changed): carry on with the normal agent, given this context. */
  | { readonly kind: 'handoff'; readonly hint: string; readonly replacing?: NonNullable<BeginOptions['replacing']>; readonly prefix?: readonly NewStep[]; readonly routine: string };

export type MemoryEvent = { readonly type: 'changed' } | { readonly type: 'suggestion'; readonly text: string };

export interface MemoryServiceDeps {
  readonly tools: ToolInvoker;
  readonly now?: () => Date;
  /** True for a step that involves something private (a chat app): never learned from. */
  readonly isPrivateStep?: (step: NewStep) => boolean;
  /** Told when the panel's picture of memory changes, or when Eya has something to offer. */
  readonly notify?: (event: MemoryEvent) => void;
  readonly onStep?: (index: number, step: SkillStep) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface PendingSuggestion {
  readonly suggestion: TaskSuggestion;
  readonly at: number;
}

interface PendingDelete {
  readonly id: number;
  readonly name: string;
  readonly at: number;
}

function toNewStep(s: SkillStep): NewStep {
  return { action: s.action, target: s.target, value: s.value, submit: s.submit, verifyKind: s.verifyKind, verifyText: s.verifyText };
}

interface FailureContext {
  readonly replacing: NonNullable<BeginOptions['replacing']>;
  readonly prefix: readonly NewStep[];
}

export function describeSteps(steps: readonly SkillStep[]): string {
  return steps
    .map((s) => {
      const what =
        s.action === 'open_url' ? `open ${s.target}` :
        s.action === 'open_app' ? `open the app ${s.target}` :
        s.action === 'find_text' ? `find "${s.target}" on the page` :
        s.action === 'click_text' ? `click "${s.target}"` :
        s.action === 'download_file' ? `click "${s.target}" to download a file` :
        s.action === 'type_text' ? `type "${s.value}" into "${s.target}"${s.submit ? ' and press Enter' : ''}` :
        s.action === 'select_option' ? `choose "${s.value}" in "${s.target}"` :
        s.action === 'save_file' ? `save the downloaded file to ${s.target}` :
        `check ${s.verifyKind.replace('_', ' ')} "${s.verifyText}"`;
      const check = s.action !== 'verify' && s.verifyKind !== 'none' ? ` (then check ${s.verifyKind.replace('_', ' ')} "${s.verifyText}")` : '';
      return `${s.position}. ${what}${check}`;
    })
    .join('\n');
}

/**
 * Eya's memory, as one thing the rest of the app talks to: the database, what is remembered, the saved routines, the lookup that
 * recognises one, the runner that carries one out, and the watcher that notices a task worth saving.
 *
 * It never decides anything a model should: matching a routine is a lookup, running one is a loop over ordinary tools, and every
 * question to the user (save this? delete that?) is a plain yes/no handled here. Anything it cannot finish is handed back, with
 * what it learned, for the normal agent to carry on from.
 */
export class MemoryService {
  readonly memories: MemoryStore;
  readonly skills: SkillStore;
  readonly candidates: CandidateStore;
  /** The short list of what Eya did, for the Recent screen. */
  readonly activity: ActivityStore;
  /** The names of chats Eya learned (names only, and only after the user said yes). */
  readonly contacts: ContactBook;
  readonly matcher: SkillMatcher;
  readonly recorder: TaskRecorder;
  readonly executor: SkillExecutor;

  private readonly now: () => Date;
  private pendingSuggestion: PendingSuggestion | null = null;
  private pendingDelete: PendingDelete | null = null;
  private lastRoutineId: number | null = null;
  private lastFailure: FailureContext | null = null;

  constructor(
    private readonly db: Sql,
    private readonly deps: MemoryServiceDeps,
  ) {
    this.now = deps.now ?? (() => new Date());
    const clock = () => this.now().toISOString();
    this.memories = new MemoryStore(db, clock);
    this.skills = new SkillStore(db, clock);
    this.candidates = new CandidateStore(db);
    this.activity = new ActivityStore(db, clock);
    this.contacts = new ContactBook(db, clock);
    this.matcher = new SkillMatcher(this.skills);
    this.matcher.refresh();
    this.recorder = new TaskRecorder({
      candidates: this.candidates,
      isSaved: (signature) => this.skills.listDetails().some((d) => signatureOf(d.steps) === signature),
      ...(deps.isPrivateStep !== undefined ? { isPrivate: deps.isPrivateStep } : {}),
      now: this.now,
    });
    this.executor = new SkillExecutor(deps.tools, {
      now: this.now,
      ...(deps.onStep !== undefined ? { onStep: deps.onStep } : {}),
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    });
    const changed = () => this.deps.notify?.({ type: 'changed' });
    this.memories.onChange(changed);
    this.skills.onChange(changed);
    this.contacts.onChange(changed);
  }

  /** Opens (creating if needed) the database file at `path` and brings it to the latest schema. Throws if it cannot be used at all. */
  static open(path: string, deps: MemoryServiceDeps): MemoryService {
    const { db, movedAside } = openDatabaseSafely(path);
    if (movedAside !== null) log.warn('the memory database was damaged; it was moved aside and a new one started', { movedAside });
    try {
      const result = migrate(db, MIGRATIONS);
      log.info('memory database ready', { path, schema: result.to, migratedFrom: result.from });
    } catch (err) {
      db.close();
      throw err;
    }
    return new MemoryService(db, deps);
  }

  close(): void {
    this.matcher.dispose();
    this.db.close();
  }

  // ------------------------------------------------------------------------------------- before the model
  /**
   * Called first for every command that reaches the agent (after the instant app-opening shortcuts): is it a memory command, or a
   * saved routine? If so it is handled right here with no model. Otherwise null, and the request goes on to the model as usual.
   */
  async tryHandle(text: string): Promise<LocalOutcome | null> {
    const controlled = await this.control(text);
    if (controlled !== null) return controlled;
    const hit = this.matcher.match(text);
    if (hit === null || !hit.strong) return null;
    return this.runMatched(hit);
  }

  /** The routine a command means, if it is clear enough to run without asking a model (for tests and the hint to the model). */
  match(text: string): SkillMatch | null {
    return this.matcher.match(text);
  }

  private async runMatched(hit: SkillMatch): Promise<LocalOutcome> {
    return this.runSkill(hit.skill);
  }

  /** Runs one routine now, records how it went, and says what to do next. */
  async runSkill(skill: Skill): Promise<LocalOutcome> {
    const detail = this.skills.detail(skill.id);
    if (detail === undefined) return { kind: 'answered', spoken: "I can't find that routine any more.", ok: false };
    if (!detail.enabled) return { kind: 'answered', spoken: `The routine "${detail.name}" is switched off. Turn it on first.`, ok: false, routine: detail.name };
    this.lastRoutineId = detail.id;
    log.info('running routine', { name: detail.name, steps: detail.steps.length });
    const outcome: RoutineOutcome = await this.executor.run(detail);
    switch (outcome.status) {
      case 'done':
        this.skills.recordRun(detail.id, 'success');
        log.info('routine done', { name: detail.name });
        return { kind: 'answered', spoken: outcome.spoken, ok: true, routine: detail.name };
      case 'needs_user': {
        this.skills.recordRun(detail.id, 'needs_user', outcome.atStep, outcome.question);
        log.info('routine paused for the user', { name: detail.name, step: outcome.atStep });
        return {
          kind: 'handoff',
          routine: detail.name,
          hint: this.handoffHint(detail, outcome.atStep, outcome.completed, `it needs the user's say-so: ${outcome.question}`),
        };
      }
      case 'failed': {
        if (outcome.kind === 'blocked') {
          // Not the routine's fault and not for a model to retry: the same step has just run several times in a row, and the guard
          // against going round in circles said stop. Say so plainly; leave the routine's record and the user's task alone.
          log.warn('routine stopped by the loop guard', { name: detail.name, step: outcome.atStep });
          return {
            kind: 'answered',
            ok: false,
            routine: detail.name,
            spoken: "I've just done that same step a few times in a row, so I stopped rather than go round in circles. Give it a couple of minutes and ask me again.",
          };
        }
        this.skills.recordRun(detail.id, outcome.kind === 'verification' ? 'verify_failed' : 'failed', outcome.atStep, outcome.reason);
        log.warn('routine failed; handing over to the normal agent', { name: detail.name, step: outcome.atStep, kind: outcome.kind, reason: outcome.reason });
        const replacing = { skillId: detail.id, name: detail.name, signature: signatureOf(detail.steps) };
        const prefix = detail.steps.slice(0, outcome.completed).map(toNewStep);
        this.lastFailure = { replacing, prefix };
        return {
          kind: 'handoff',
          routine: detail.name,
          replacing,
          prefix,
          hint: this.handoffHint(detail, outcome.atStep, outcome.completed, outcome.reason),
        };
      }
    }
  }

  private handoffHint(skill: SkillDetail, atStep: number, completed: number, why: string): string {
    return (
      `A saved routine, "${skill.name}", was started for this request and stopped at step ${atStep} of ${skill.steps.length} (${completed} done): ${why}\n` +
      `The routine's steps were:\n${describeSteps(skill.steps)}\n` +
      'Carry on from where it stopped, using your normal tools and what is on the screen now, to finish what the user asked. Follow the usual confirmation rules (never confirm anything for the user). ' +
      'Do not make the user repeat the request, and do not mention the routine unless it helps.'
    );
  }

  // ----------------------------------------------------------------------------------- user control phrases
  private hasPending(): boolean {
    return this.freshSuggestion() !== null || this.freshDelete() !== null;
  }

  private freshSuggestion(): PendingSuggestion | null {
    const p = this.pendingSuggestion;
    if (p === null) return null;
    if (this.now().getTime() - p.at > SUGGESTION_LIFE_MS) {
      this.pendingSuggestion = null;
      return null;
    }
    return p;
  }

  private freshDelete(): PendingDelete | null {
    const p = this.pendingDelete;
    if (p === null) return null;
    if (this.now().getTime() - p.at > CONFIRM_LIFE_MS) {
      this.pendingDelete = null;
      return null;
    }
    return p;
  }

  private answer(spoken: string, ok = true): LocalOutcome {
    return { kind: 'answered', spoken, ok };
  }

  /** An outcome that keeps whether it worked ("I don't have a task to save yet" is not a success). */
  private answerWith(r: { readonly ok: boolean; readonly spoken: string; readonly routine?: string }): LocalOutcome {
    return { kind: 'answered', spoken: r.spoken, ok: r.ok, ...(r.routine !== undefined ? { routine: r.routine } : {}) };
  }

  private async control(text: string): Promise<LocalOutcome | null> {
    const intent = parseControl(text, this.hasPending());
    if (intent === null) return null;
    return this.applyControl(intent);
  }

  private applyControl(intent: ControlIntent): LocalOutcome | null {
    switch (intent.kind) {
      case 'yes': {
        const del = this.freshDelete();
        const sug = this.freshSuggestion();
        // The question asked most recently is the one being answered.
        if (del !== null && (sug === null || del.at >= sug.at)) {
          this.pendingDelete = null;
          this.skills.delete(del.id);
          return this.answer(`Deleted the routine "${del.name}".`);
        }
        if (sug !== null) return this.answerWith(this.acceptSuggestion());
        return null;
      }
      case 'no': {
        const del = this.freshDelete();
        const sug = this.freshSuggestion();
        if (del !== null && (sug === null || del.at >= sug.at)) {
          this.pendingDelete = null;
          return this.answer(`Okay, I'll keep "${del.name}".`);
        }
        if (sug !== null) return this.answerWith(this.declineSuggestion());
        return null;
      }
      case 'list_memories':
        return this.answer(this.describeMemories());
      case 'list_routines':
        return this.answer(this.describeRoutines());
      case 'forget_routine': {
        const skill = intent.name !== null ? this.skills.find(intent.name) : this.lastRoutine();
        if (skill === undefined) {
          return this.answer(intent.name !== null ? `I don't have a routine called "${intent.name}". Say "show my routines" to hear them.` : 'Which routine? Say "show my routines" to hear them, then "delete the routine" and its name.', false);
        }
        this.pendingDelete = { id: skill.id, name: skill.name, at: this.now().getTime() };
        return this.answer(`Delete the routine "${skill.name}"? Say yes to confirm.`);
      }
      case 'save_routine': {
        const sug = this.freshSuggestion();
        if (sug !== null && intent.name === null) return this.answerWith(this.acceptSuggestion());
        return this.answerWith(this.saveLastTask(intent.name !== null ? { name: intent.name } : {}));
      }
      case 'remember_this': {
        const sug = this.freshSuggestion();
        if (sug !== null) return this.answerWith(this.acceptSuggestion());
        if (this.recorder.lastTask() !== null) return this.answerWith(this.saveLastTask({}));
        return this.answer('What should I remember? For example, say "remember that Ravi is my brother\'s contact", or "always save PDFs to the Desktop".');
      }
      case 'dont_remember': {
        if (this.freshSuggestion() !== null) return this.answerWith(this.declineSuggestion());
        const last = this.recorder.lastTask();
        if (last !== null) {
          this.recorder.decline(last.signature);
          return this.answer("Okay, I won't remember that, and I won't offer to save it.");
        }
        return null;
      }
      case 'remember': {
        try {
          const saved = this.memories.save(intent.type, intent.key, intent.value);
          return this.answer(saved.created ? `Okay, I'll remember that.` : `Okay, I've updated that.`);
        } catch (err) {
          if (err instanceof MemoryRejected) return this.answer(err.message, false);
          throw err;
        }
      }
      case 'forget_memory': {
        const spoken = this.forgetMemory(intent.key);
        return spoken === null ? null : this.answer(spoken); // nothing by that name is remembered: not a memory command, let the normal agent deal with it
      }
    }
  }

  /** Forgets the memory that `what` names (its key, or the one memory that shares the most words with it). Null if none clearly matches. */
  forgetMemory(what: string): string | null {
    const direct = this.memories.deleteByKey(what);
    if (direct.length > 0) return "Okay, I've forgotten that.";
    const words = new Set(contentTokens(normalizeKey(what)));
    if (words.size === 0) return null;
    const close = this.memories
      .list()
      .map((m) => ({ m, overlap: contentTokens(normalizeKey(`${m.key} ${m.value}`)).filter((w) => words.has(w)).length }))
      .filter((x) => x.overlap >= Math.max(1, Math.min(words.size, 2)))
      .sort((a, b) => b.overlap - a.overlap);
    const best = close[0];
    if (best !== undefined && (close[1] === undefined || best.overlap > close[1].overlap)) {
      this.memories.delete(best.m.id);
      return `Okay, I've forgotten "${best.m.value}".`;
    }
    return null;
  }

  /** Keeps what the user asked to be remembered ("Ravi is my brother's contact", "always save PDFs to Desktop"). */
  rememberStatement(statement: string, type?: MemoryType): { readonly ok: boolean; readonly spoken: string } {
    const parsed = parseRemember(statement);
    if (parsed === null) return { ok: false, spoken: 'I did not catch what to remember.' };
    try {
      const saved = this.memories.save(type ?? parsed.type, parsed.key, parsed.value);
      return { ok: true, spoken: saved.created ? "Okay, I'll remember that." : "Okay, I've updated that." };
    } catch (err) {
      if (err instanceof MemoryRejected) return { ok: false, spoken: err.message };
      throw err;
    }
  }

  /** The routine a name or a spoken phrase means: by name first, then by its wordings (a model that chose to run it need not be as sure as the matcher). */
  findRoutine(nameOrPhrase: string): Skill | undefined {
    return this.skills.find(nameOrPhrase) ?? this.matcher.match(nameOrPhrase)?.skill;
  }

  private lastRoutine(): Skill | undefined {
    return this.lastRoutineId === null ? undefined : this.skills.get(this.lastRoutineId);
  }

  describeMemories(): string {
    const all = this.memories.list();
    if (all.length === 0) return 'I haven\'t been asked to remember anything yet. Say "remember that" and then what to keep.';
    const shown = all.slice(0, 5).map((m) => `${m.type === 'preference' ? 'Preference' : 'Fact'}: ${m.value}`);
    const more = all.length > shown.length ? ` And ${all.length - shown.length} more; open the Memory panel to see them all.` : '';
    return `I remember ${all.length} thing${all.length === 1 ? '' : 's'}. ${shown.join('. ')}.${more}`;
  }

  describeRoutines(): string {
    const all = this.skills.list();
    if (all.length === 0) return 'You have no saved routines yet. When you repeat a task, I will offer to save it.';
    const names = all.slice(0, 6).map((s) => `${s.name.replace(/_/g, ' ')}${s.enabled ? '' : ' (off)'}`);
    const more = all.length > names.length ? `, and ${all.length - names.length} more` : '';
    return `You have ${all.length} routine${all.length === 1 ? '' : 's'}: ${names.join(', ')}${more}.`;
  }

  // ------------------------------------------------------------------------- learning and saving routines
  /** A task is starting: start watching it (see TaskRecorder). */
  beginTask(request: string, options: BeginOptions = {}): void {
    this.recorder.begin(request, options);
  }

  observeTool(name: string, args: ToolArgs, result: ToolResult): void {
    // A routine the model ran through run_routine stopped partway and it is finishing the job: that finish may be a better routine.
    if (name === 'run_routine' && result.data?.['routineStatus'] === 'failed' && this.lastFailure !== null && this.lastFailure.replacing.skillId === result.data['skillId']) {
      this.recorder.adoptFailure(this.lastFailure.replacing, this.lastFailure.prefix);
      this.lastFailure = null;
      return;
    }
    this.recorder.observe(name, args, result);
  }

  /**
   * The task is over. If this was the Nth time the same thing worked, Eya now has a question to put to the user: returns its text (and
   * tells the panel). The user answers with "yes" / "no" (or the buttons, or "save this as a routine").
   */
  finishTask(ok: boolean, options: { readonly announce?: boolean } = {}): string | null {
    const suggestion = this.recorder.finish(ok);
    if (suggestion === null) return null;
    this.pendingSuggestion = { suggestion, at: this.now().getTime() };
    const text = this.suggestionText(suggestion);
    log.info('offering to save a routine', { kind: suggestion.kind, count: suggestion.count });
    this.deps.notify?.({ type: 'changed' }); // the panel shows the offer with Yes / No
    // A caller that speaks the returned text itself (a typed or transcribed request) passes announce: false; a live conversation, where
    // the model never hears the offer, leaves it on so the app says it.
    if (options.announce !== false) this.deps.notify?.({ type: 'suggestion', text });
    return text;
  }

  suggestionText(s: TaskSuggestion): string {
    return s.kind === 'update'
      ? `That worked a little differently this time. Would you like me to update the routine "${s.replacing?.name ?? 'it'}" with what I just did?`
      : "You've done this several times. Would you like me to save it as a routine?";
  }

  currentSuggestion(): { readonly text: string; readonly kind: 'save' | 'update' } | null {
    const p = this.freshSuggestion();
    return p === null ? null : { text: this.suggestionText(p.suggestion), kind: p.suggestion.kind };
  }

  hasPendingSuggestion(): boolean {
    return this.freshSuggestion() !== null;
  }

  /** The user said yes to the pending offer: save the routine (or update the one that failed). */
  acceptSuggestion(): { readonly ok: boolean; readonly spoken: string; readonly routine?: string } {
    const p = this.freshSuggestion();
    if (p === null) return { ok: false, spoken: "I wasn't asking about saving anything just now." };
    this.pendingSuggestion = null;
    this.deps.notify?.({ type: 'changed' });
    const s = p.suggestion;
    try {
      if (s.kind === 'update' && s.replacing !== undefined) {
        if (this.skills.get(s.replacing.skillId) === undefined) return this.createFrom(s.phrases, s.steps, null, null);
        this.skills.replaceSteps(s.replacing.skillId, s.steps);
        this.candidates.remove(s.signature);
        this.lastRoutineId = s.replacing.skillId;
        return { ok: true, spoken: `Done. I've updated "${s.replacing.name.replace(/_/g, ' ')}".`, routine: s.replacing.name };
      }
      return this.createFrom(s.phrases, s.steps, null, s.signature);
    } catch (err) {
      return this.explain(err);
    }
  }

  declineSuggestion(): { readonly ok: boolean; readonly spoken: string } {
    const p = this.freshSuggestion();
    this.pendingSuggestion = null;
    if (p === null) return { ok: true, spoken: 'Okay.' };
    this.candidates.decline(p.suggestion.signature);
    this.deps.notify?.({ type: 'changed' });
    return { ok: true, spoken: "Okay, I won't ask about that again." };
  }

  /** "Save this as a routine": what Eya just did (the last successful task she could learn from) becomes a routine, now. */
  saveLastTask(options: { readonly name?: string; readonly triggers?: readonly string[] }): { readonly ok: boolean; readonly spoken: string; readonly routine?: string } {
    const last = this.recorder.lastTask();
    if (last === null) {
      return { ok: false, spoken: 'I don\'t have a task to save yet. Do it once, and then say "save this as a routine".' };
    }
    try {
      const phrases = [{ norm: normalizeUtterance(last.request), text: last.request }, ...(options.triggers ?? []).map((t) => ({ norm: normalizeUtterance(t), text: t }))];
      return this.createFrom(phrases, last.steps, options.name ?? null, last.signature);
    } catch (err) {
      return this.explain(err);
    }
  }

  private createFrom(
    phrases: ReadonlyArray<{ readonly norm: string; readonly text: string }>,
    steps: readonly NewStep[],
    name: string | null,
    signature: string | null,
  ): { ok: boolean; spoken: string; routine?: string } {
    const sig = signature ?? signatureOf(steps);
    const existing = this.skills.listDetails().find((d) => signatureOf(d.steps) === sig);
    if (existing !== undefined) return { ok: true, spoken: `I already have that as "${existing.name.replace(/_/g, ' ')}".`, routine: existing.name };
    const top = phrases[0]?.text ?? name ?? 'routine';
    let base = name !== null ? name.trim() : slugify(top);
    if (base === '') base = 'routine';
    let finalName = base;
    for (let n = 2; this.skills.getByName(finalName) !== undefined && n < 50; n += 1) finalName = `${base}_${n}`;
    // Wordings: the ones the user actually used, minus any that already run another routine.
    const triggers: string[] = [];
    for (const p of phrases.slice(0, 5)) {
      if (p.norm === '' || triggers.some((t) => normalizeUtterance(t) === p.norm)) continue;
      const owner = this.skills.findByTrigger(p.text);
      if (owner === undefined) triggers.push(p.text);
    }
    if (triggers.length === 0) triggers.push(finalName.replace(/_/g, ' '));
    const created = this.skills.create({ name: finalName, description: `Saved from "${top.slice(0, 80)}"`, triggers, steps });
    this.candidates.remove(sig);
    this.recorder.forgetLast();
    this.lastRoutineId = created.id;
    log.info('routine saved', { name: created.name, steps: created.steps.length, triggers: created.triggers.length });
    return { ok: true, spoken: `Saved as "${created.name.replace(/_/g, ' ')}". Next time you say "${created.triggers[0]}", I'll just do it. Say "show my routines" any time.`, routine: created.name };
  }

  private explain(err: unknown): { ok: false; spoken: string } {
    if (err instanceof SkillRejected || err instanceof MemoryRejected) return { ok: false, spoken: err.message };
    throw err;
  }

  // ----------------------------------------------------------------------------------------- for the model
  /** What the agent should know on top of its instructions: relevant memories and the routines it can run. Empty when there is nothing. */
  promptBlock(request: string, options: { readonly forLive?: boolean } = {}): string {
    const lines: string[] = [];
    const memories = options.forLive === true ? [...this.memories.list('preference'), ...this.memories.list('fact')].slice(0, 20) : this.memories.relevant(request, 14);
    if (memories.length > 0) {
      lines.push('What the user has asked you to remember (use it where it applies; do not read it out unless asked):');
      for (const m of memories) lines.push(`- ${m.type === 'preference' ? 'Preference' : 'Fact'}: ${m.value.slice(0, 200)}`);
    }
    const routines = this.skills.listDetails().filter((s) => s.enabled).slice(0, 15);
    if (routines.length > 0) {
      lines.push('Saved routines (when the user asks for one of these, call run_routine at once instead of doing it step by step):');
      for (const r of routines) lines.push(`- ${r.name.replace(/_/g, ' ')} — say: ${r.triggers.slice(0, 3).map((t) => `"${t}"`).join(', ')}`);
    }
    return lines.join('\n');
  }

  /** A saved routine a command is CLOSE to but not sure enough to run alone — worth telling the model about. */
  possibleRoutineHint(text: string): string | null {
    const hit = this.matcher.match(text);
    if (hit === null || hit.strong) return null;
    return `The user's request is close to the saved routine "${hit.skill.name.replace(/_/g, ' ')}" (you can run it with run_routine if that is what they meant).`;
  }

  // ------------------------------------------------------------------------------------------------ for the panel
  snapshot(): { readonly memories: readonly Memory[]; readonly routines: readonly (SkillDetail & { readonly recent: ReadonlyArray<{ readonly outcome: string; readonly detail: string }> })[]; readonly suggestion: { readonly text: string; readonly kind: 'save' | 'update' } | null } {
    return {
      memories: this.memories.list(),
      routines: this.skills.listDetails().map((d) => ({ ...d, recent: this.skills.recentRuns(d.id, 3).map((r) => ({ outcome: r.outcome, detail: r.detail })) })),
      suggestion: this.currentSuggestion(),
    };
  }
}
