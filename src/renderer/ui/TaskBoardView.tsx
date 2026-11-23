import React, { useState } from 'react';
import { KIND_WORD, MAX_TASK_TEXT } from '../../shared/taskBoard';
import type { TaskRow } from '../../shared/taskBoard';
import type { AppPage, EyaControl } from '../control';
import { timeAgo } from './format';
import { TASK_EXAMPLES, boardSummary, isOpenRow, rowControls, rowStateWord } from './taskBoardLogic';

/** The box a task's question is answered in: one line, Enter sends it. */
function ReplyBox({ row, c }: { row: TaskRow; c: EyaControl }): React.ReactElement {
  const [text, setText] = useState('');
  const send = (answer: string): void => {
    const words = answer.trim();
    if (words === '') return;
    c.actOnTaskBoard({ kind: 'answer', id: row.id, text: words });
    setText('');
  };
  const { yesNo } = rowControls(row);
  return (
    <div className="tb-reply">
      <div className="tb-reply-row">
        <input
          type="text"
          className="ask-input"
          value={text}
          maxLength={MAX_TASK_TEXT}
          placeholder="Your answer…"
          aria-label={`Your answer for: ${row.title}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send(text);
          }}
        />
        <button type="button" className="task-btn yes" disabled={text.trim() === ''} onClick={() => send(text)}>
          Send
        </button>
      </div>
      {yesNo && (
        <div className="tb-yesno">
          <button type="button" className="task-btn yes" onClick={() => send('yes')}>
            Yes
          </button>
          <button type="button" className="task-btn" onClick={() => send('no')}>
            No
          </button>
        </div>
      )}
    </div>
  );
}

/** One task: what it is, where it is, what it did, what it asks, and its own controls. */
function TaskCard({ row, c, go }: { row: TaskRow; c: EyaControl; go: (page: AppPage) => void }): React.ReactElement {
  const ctl = rowControls(row);
  const open = isOpenRow(row);
  return (
    <li className={`tb-card ${row.state} ${open ? 'open' : 'over'}`} data-kind={row.kind}>
      <div className="tb-top">
        <span className={`tb-kind ${row.kind}`}>{KIND_WORD[row.kind]}</span>
        <span className={`tb-state ${row.state}`}>
          <span className={`task-dot ${row.state === 'paused' ? 'waiting' : row.state === 'cancelled' ? '' : row.state}`} aria-hidden="true" />
          {rowStateWord(row)}
        </span>
        {!open && row.updatedAt > 0 && <span className="tb-when">{timeAgo(new Date(row.updatedAt).toISOString())}</span>}
      </div>
      <div className="tb-title" title={row.title}>
        {row.title}
      </div>
      {row.note !== '' && <div className={`tb-note ${row.asks ? 'ask' : ''}`}>{row.note}</div>}
      {row.live !== undefined && (
        <div className="tb-meta">
          {row.live.replies} {row.live.replies === 1 ? 'reply' : 'replies'} · {row.live.mode}
          {row.live.relation !== null ? ` · ${row.live.relation}` : ''}
        </div>
      )}
      {row.steps.length > 0 && (
        <ul className="tb-steps" aria-label="What was done">
          {row.steps.slice(-3).map((s, i) => (
            <li key={`${i}-${s}`}>{s}</li>
          ))}
        </ul>
      )}
      {row.evidence.length > 0 && (
        <ul className="tb-steps" aria-label="What was seen">
          {row.evidence.map((e, i) => (
            <li key={`${i}-${e}`}>{e}</li>
          ))}
        </ul>
      )}
      {row.where !== null && <div className="tb-meta">{row.where === 'eya' ? 'Works in its own tab of Eya Browser' : 'Works in your browser'}</div>}
      {ctl.answer && <ReplyBox row={row} c={c} />}
      <div className="tb-actions">
        {ctl.resume !== null && (
          <button type="button" className="task-btn yes" onClick={() => c.actOnTaskBoard({ kind: 'resume', id: row.id })}>
            {ctl.resume}
          </button>
        )}
        {ctl.answerInChat && (
          <button type="button" className="task-btn yes" onClick={() => go('chat')}>
            Open the chat
          </button>
        )}
        {ctl.openLiveChat && (
          <button type="button" className="task-btn" onClick={() => go('livechat')}>
            Open live chat
          </button>
        )}
        {ctl.showBrowser && (
          <button type="button" className="task-btn" onClick={() => c.actOnTaskBoard({ kind: 'show_browser', id: row.id })}>
            Show its browser
          </button>
        )}
        {ctl.stop && (
          <button type="button" className="task-btn" onClick={() => c.actOnTaskBoard({ kind: 'stop', id: row.id })}>
            Stop
          </button>
        )}
      </div>
    </li>
  );
}

/** The new-task box: the person types anything and starts it; Enter starts it, Shift+Enter is a new line. */
function NewTask({ c }: { c: EyaControl }): React.ReactElement {
  const [text, setText] = useState('');
  const start = (): void => {
    const words = text.replace(/\s+/g, ' ').trim();
    if (words === '') return;
    c.actOnTaskBoard({ kind: 'start', text: words });
    setText('');
  };
  return (
    <section className="tb-new card" aria-label="New task">
      <label className="tb-new-label" htmlFor="tb-new-text">
        What should Eya do?
      </label>
      <div className="tb-new-row">
        <textarea
          id="tb-new-text"
          className="ask-input tb-new-text"
          rows={2}
          value={text}
          maxLength={MAX_TASK_TEXT}
          placeholder="Type any task: a live chat, an order, something to find out…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              start();
            }
          }}
        />
        <button type="button" className="btn primary" disabled={text.trim() === ''} onClick={start}>
          Start task
        </button>
      </div>
      <div className="tb-examples">
        <span className="tb-examples-label">For example</span>
        {TASK_EXAMPLES.map((ex) => (
          <button key={ex} type="button" className="chip" onClick={() => setText(ex)}>
            {ex}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * The Tasks page's board: the person types any task and it starts on its own; every task (a live chat, an order, a look-up) is a card of its own, side by side, each with its own state,
 * steps, question and controls. They run at the same time and do not wait for each other.
 */
export function TaskBoardView({ c, go }: { c: EyaControl; go: (page: AppPage) => void }): React.ReactElement {
  const rows = c.taskBoard?.rows ?? [];
  const open = rows.filter(isOpenRow);
  const finished = rows.filter((r) => !isOpenRow(r));
  return (
    <div className="tb">
      <NewTask c={c} />
      <div className="tb-head">
        <h2>Running now</h2>
        <span className="tb-summary">{boardSummary(rows)}</span>
        <span className="mem-spacer" />
        {open.length > 1 && (
          <button type="button" className="link" onClick={() => c.actOnTaskBoard({ kind: 'stop_all' })}>
            Stop all
          </button>
        )}
      </div>
      {open.length === 0 ? (
        <div className="empty tb-empty">Nothing is running. Type a task above and it starts on its own: you can start as many as you like, and each one keeps going by itself.</div>
      ) : (
        <ul className="tb-grid" aria-label="Running tasks">
          {open.map((r) => (
            <TaskCard key={r.id} row={r} c={c} go={go} />
          ))}
        </ul>
      )}
      {finished.length > 0 && (
        <>
          <div className="tb-head">
            <h2>Finished lately</h2>
            <span className="mem-spacer" />
            <button type="button" className="link" onClick={() => c.actOnTaskBoard({ kind: 'clear_finished' })}>
              Clear
            </button>
          </div>
          <ul className="tb-grid" aria-label="Finished tasks">
            {finished.map((r) => (
              <TaskCard key={r.id} row={r} c={c} go={go} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
