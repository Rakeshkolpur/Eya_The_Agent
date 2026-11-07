import React from 'react';
import type { TaskView } from '../../shared/tasks';
import type { EyaControl } from '../control';
import { timeAgo } from './format';

const STATE_LABEL: Record<TaskView['state'], string> = {
  running: 'Working on it',
  waiting: 'Waiting to try again',
  needs_you: 'Needs you',
  done: 'Done',
  failed: "Couldn't finish",
  cancelled: 'Stopped',
};

/** Where a task done through a plugin is, in words: the order is received, working it out, doing it, checking it went. */
const PHASE_LABEL: Record<NonNullable<TaskView['plugin']>['phase'], string> = {
  received: 'Received',
  planning: 'Working out who and what',
  executing: 'Doing it',
  verifying: 'Checking it went through',
  completed: 'Done',
  waiting_clarification: 'Waiting for your answer',
  waiting_permission: 'Waiting for your permission',
  failed: "Couldn't finish",
  cancelled: 'Stopped',
  uncertain: 'Not sure it went: look in the chat',
};

/** The word for where a task is: for a plugin task its phase, for any other its state. */
const stateWord = (t: TaskView): string => (t.plugin !== null ? PHASE_LABEL[t.plugin.phase] : STATE_LABEL[t.state]);

const isOpen = (t: TaskView): boolean => t.state === 'running' || t.state === 'waiting' || t.state === 'needs_you';

/** The buttons for one task: stop it, answer its question, or carry on. */
function Actions({ c, t }: { c: EyaControl; t: TaskView }): React.ReactElement | null {
  if (t.state === 'needs_you' && t.asks) {
    return (
      <span className="task-actions">
        <button type="button" className="task-btn yes" onClick={() => void c.submit('yes', undefined, { agent: true })}>
          Yes
        </button>
        <button type="button" className="task-btn" onClick={() => void c.submit('no', undefined, { agent: true })}>
          No
        </button>
        <button type="button" className="task-btn" onClick={() => c.actOnTasks({ kind: 'cancel', id: t.id })}>
          Stop
        </button>
      </span>
    );
  }
  if (t.state === 'needs_you' && t.plugin !== null) {
    // (what it sent, or may have sent, is looked at first when the person asks again: it is never carried on from here)
    return (
      <span className="task-actions">
        <button type="button" className="task-btn" onClick={() => c.actOnTasks({ kind: 'cancel', id: t.id })}>
          Dismiss
        </button>
      </span>
    );
  }
  if (t.state === 'needs_you') {
    return (
      <span className="task-actions">
        <button type="button" className="task-btn yes" onClick={() => c.actOnTasks({ kind: 'resume', id: t.id })}>
          Continue
        </button>
        <button type="button" className="task-btn" onClick={() => c.actOnTasks({ kind: 'cancel', id: t.id })}>
          Stop
        </button>
      </span>
    );
  }
  if (isOpen(t)) {
    return (
      <span className="task-actions">
        <button type="button" className="task-btn" onClick={() => c.actOnTasks({ kind: 'cancel', id: t.id })}>
          Stop
        </button>
      </span>
    );
  }
  if ((t.state === 'failed' || t.state === 'cancelled') && t.plugin === null) {
    return (
      <span className="task-actions">
        <button type="button" className="task-btn" onClick={() => c.actOnTasks({ kind: 'resume', id: t.id })}>
          Try again
        </button>
      </span>
    );
  }
  return null;
}

/**
 * The tasks Eya is keeping for the person. As a card (the Home page): every open task and the few that ended lately. As a strip (the quick
 * panel): just the one that most needs a look — a question waiting for their yes first. Renders nothing when there is nothing to show.
 */
export function TasksCard({ c, variant }: { c: EyaControl; variant: 'card' | 'strip' }): React.ReactElement | null {
  const snap = c.tasks;
  if (snap === null || snap.items.length === 0) return null;
  const open = snap.items.filter(isOpen);

  if (variant === 'strip') {
    const first = open.find((t) => t.state === 'needs_you') ?? open[0];
    if (first === undefined) return null;
    return (
      <div className={`task-strip ${first.state}`} role="status">
        <div className="task-strip-text">
          <div className="task-strip-title" title={first.request}>
            {open.length > 1 ? `${open.length} tasks · ` : ''}
            {first.request}
          </div>
          <div className="task-strip-note" title={first.note}>
            {first.state === 'needs_you' ? first.note : `${stateWord(first)}${first.note !== '' ? ` — ${first.note}` : ''}`}
          </div>
        </div>
        <Actions c={c} t={first} />
      </div>
    );
  }

  const finished = snap.items.filter((t) => !isOpen(t)).slice(0, 4);
  const shown = [...open, ...finished];
  return (
    <section className="tasks-card card" aria-label="Tasks">
      <div className="card-head">
        <h2>Tasks</h2>
        {open.length > 1 ? (
          <button type="button" className="link" onClick={() => { c.stopAll(); c.actOnTasks({ kind: 'cancel_all' }); }}>
            Stop all
          </button>
        ) : finished.length > 0 && open.length === 0 ? (
          <button type="button" className="link" onClick={() => c.actOnTasks({ kind: 'clear_finished' })}>
            Clear
          </button>
        ) : null}
      </div>
      <ul className="task-list">
        {shown.map((t) => (
          <li key={t.id} className={`task ${t.state}`}>
            <div className="task-main">
              <span className={`task-dot ${t.state}`} aria-hidden="true" />
              <div className="task-text">
                <div className="task-title" title={t.request}>
                  {t.request}
                </div>
                <div className="task-note" title={t.note}>
                  {stateWord(t)}
                  {t.note !== '' ? ` — ${t.note}` : ''}
                  {!isOpen(t) ? ` · ${timeAgo(new Date(t.updatedAt).toISOString())}` : ''}
                </div>
                {t.plugin !== null && t.plugin.evidence.length > 0 && (
                  <ul className="task-evidence" aria-label="What was seen">
                    {t.plugin.evidence.slice(-3).map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <Actions c={c} t={t} />
          </li>
        ))}
      </ul>
    </section>
  );
}
