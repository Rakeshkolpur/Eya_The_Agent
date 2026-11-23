import type { LocalCommandResult } from '@main/local/LocalCommands';
import type { StoredTask } from './TaskStore';
import type { TasksSnapshot } from '@shared/tasks';

/** What these commands need from the task completer. */
export interface TaskControl {
  openTasks(): readonly StoredTask[];
  cancel(id?: string): number;
  cancelAll(): number;
  resume(id: string): boolean;
  snapshot(): TasksSnapshot;
}

const result = (spoken: string, ok: boolean, intent: string): LocalCommandResult => ({ spoken, ok, intent, tools: [], refs: [] });

/** The words as they are compared: lower case, no punctuation (apostrophes stay), no "hey Eya" in front or "please" behind. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:hey |hi |ok |okay )?(?:eya )?(?:please )?/, '')
    .replace(/(?: please| now| eya| for me)+$/, '')
    .trim();
}

const CANCEL_ALL =
  /^(?:cancel|stop|drop|abort|forget|clear|end) (?:all|every|everything)(?: (?:of )?(?:the |my |your |these |those )?(?:pending |open |current |running )?(?:tasks?|jobs?|requests?|things))?$/;
const CANCEL_ONE =
  /^(?:cancel|stop|drop|abort|forget|end) (?:the |that |this |my |your )?(?:(?:pending|current|running|last|latest|open) )?(?:task|job|request)$/;
const STOP_WORKING = /^(?:stop|quit|quit working|stop working|stop trying)(?: working| trying)? on (?:it|that|this)$/;
/** Only meant as "stop the task" when a task is open; otherwise it is not for this layer. */
const NEVER_MIND = /^(?:never ?mind(?: about)?(?: it| that| this| the task)?|forget it|drop it|leave it|skip it|don't do it|do not do it)$/;
const STATUS =
  /^(?:what(?:'s| is| are) (?:you|eya) (?:doing|working on)|what(?:'s| is) pending|what(?:'s| is) (?:the )?task status|(?:any|what|which) (?:pending |open |current |running )?(?:tasks?|jobs?)(?: (?:are there|do you have|are pending|are open|are left|left))?|(?:the )?task status|(?:are you )?(?:still )?working on (?:it|something|anything)|how(?:'s| is) (?:it|the task) going|any updates?)$/;
/** "Continue" only means this when something is waiting; otherwise it is an ordinary word for the model. */
const RESUME = /^(?:continue|resume|retry|try again|carry on|go on|keep going)(?: (?:with )?(?:the |that |this |my )?(?:task|job|it))?$/;

const short = (text: string, max = 70): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Spoken or typed control of the tasks Eya is keeping: "cancel the task", "stop all tasks", "never mind", "what are you working on",
 * "continue". Only what was said TO Eya counts, never always-on listening. A phrase that is only a task command while a task is open
 * ("never mind", "continue") is left alone when none is, so it can mean what it usually does.
 */
export class TaskCommands {
  constructor(private readonly tasks: TaskControl) {}

  async tryHandle(text: string, options: { readonly live?: boolean } = {}): Promise<LocalCommandResult | null> {
    if (options.live === true) return null;
    const said = plain(text);
    if (said === '' || said.split(' ').length > 9) return null;
    const open = this.tasks.openTasks();

    if (CANCEL_ALL.test(said)) {
      const n = this.tasks.cancelAll();
      return result(n === 0 ? "There's nothing I'm working on." : `Okay, I've stopped ${n === 1 ? 'the task' : `all ${n} tasks`}.`, true, 'task_cancel');
    }
    if (CANCEL_ONE.test(said) || STOP_WORKING.test(said) || (NEVER_MIND.test(said) && open.length > 0)) {
      const latest = open[0];
      if (latest === undefined) return result("There's nothing I'm working on.", true, 'task_cancel');
      this.tasks.cancel(latest.id);
      return result(`Okay, I've stopped: ${short(latest.request)}.`, true, 'task_cancel');
    }
    if (STATUS.test(said)) return this.status();
    if (RESUME.test(said)) {
      const target = open.find((t) => t.state === 'needs_you' || t.state === 'waiting') ?? this.lastStopped();
      if (target === undefined) return null;
      if (!this.tasks.resume(target.id)) return null;
      return result(`Okay, carrying on with: ${short(target.request)}.`, true, 'task_resume');
    }
    return null;
  }

  private status(): LocalCommandResult {
    const snap = this.tasks.snapshot();
    const open = snap.items.filter((i) => i.state === 'running' || i.state === 'waiting' || i.state === 'needs_you');
    if (open.length === 0) return result("I'm not working on anything right now.", true, 'task_status');
    const line = (i: (typeof open)[number]): string => {
      const what = short(i.request, 50);
      return i.state === 'needs_you' ? `${what}, waiting for you` : i.state === 'waiting' ? `${what}, waiting to try again` : `${what}, working on it`;
    };
    const shown = open.slice(0, 3).map(line);
    const more = open.length > 3 ? `, and ${open.length - 3} more` : '';
    return result(open.length === 1 ? `One task: ${shown[0]}.` : `${open.length} tasks: ${shown.join('; ')}${more}.`, true, 'task_status');
  }

  /** The most recent task that ended without being done: "continue" can pick it up. */
  private lastStopped(): StoredTask | undefined {
    const snap = this.tasks.snapshot().items.find((i) => i.state === 'failed' || i.state === 'cancelled');
    if (snap === undefined) return undefined;
    // `resume` needs only the id; the rest is for the reply.
    return { id: snap.id, request: snap.request, source: 'text', state: snap.state, createdAt: snap.createdAt, updatedAt: snap.updatedAt, attempts: snap.attempts, note: snap.note, steps: [] };
  }
}
