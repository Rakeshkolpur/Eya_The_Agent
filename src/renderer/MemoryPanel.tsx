import React, { useState } from 'react';
import type { ChatNamesView, MemoryAction, MemoryActionResult, MemoryItemView, MemorySnapshot, RoutineView } from '../shared/ipcContract';

type Act = (action: MemoryAction) => Promise<MemoryActionResult>;
type Run = (action: MemoryAction) => Promise<boolean>;

/** "check_todays_cause_list" reads better as words; the stored name is only touched when the user renames it. */
const label = (name: string): string => name.replace(/_/g, ' ');

function RoutineCard({ r, run }: { r: RoutineView; run: Run }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [phrase, setPhrase] = useState('');
  const [sure, setSure] = useState(false);

  const saveName = async (): Promise<void> => {
    if (renaming === null) return;
    if (renaming.trim() === '' || renaming === r.name || (await run({ kind: 'rename_routine', id: r.id, name: renaming }))) setRenaming(null);
  };
  const addPhrase = async (): Promise<void> => {
    if (phrase.trim() === '') return;
    if (await run({ kind: 'add_phrase', id: r.id, text: phrase })) setPhrase('');
  };

  return (
    <div className={`mem-card ${r.enabled ? '' : 'off'}`}>
      <div className="mem-card-head">
        <input
          type="checkbox"
          className="mem-check"
          checked={r.enabled}
          onChange={(e) => void run({ kind: 'set_enabled', id: r.id, enabled: e.target.checked })}
          title={r.enabled ? 'On. Eya runs it when you say one of its phrases. Untick to switch it off.' : 'Off. Eya will not run it. Tick to switch it on.'}
          aria-label={`${label(r.name)} enabled`}
        />
        {renaming === null ? (
          <button type="button" className="mem-name" onClick={() => setOpen((v) => !v)} aria-expanded={open} title="Show details">
            {label(r.name)}
          </button>
        ) : (
          <input
            className="mem-edit"
            value={renaming}
            autoFocus
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveName();
              if (e.key === 'Escape') setRenaming(null);
            }}
            aria-label="Routine name"
          />
        )}
        <span className="mem-spacer" />
        {renaming === null ? (
          <button type="button" className="mem-mini" onClick={() => setRenaming(r.name)} title="Rename">
            Rename
          </button>
        ) : (
          <button type="button" className="mem-mini" onClick={() => void saveName()}>
            Save
          </button>
        )}
        {sure ? (
          <>
            <button type="button" className="mem-mini danger" onClick={() => void run({ kind: 'delete_routine', id: r.id })}>
              Delete?
            </button>
            <button type="button" className="mem-mini" onClick={() => setSure(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="mem-mini" onClick={() => setSure(true)} title="Delete this routine">
            Delete
          </button>
        )}
      </div>
      <div className="mem-stats">
        {r.useCount === 0 ? 'Not used yet' : `Used ${r.useCount}× · ${r.successCount} worked${r.failureCount > 0 ? ` · ${r.failureCount} failed` : ''}`}
      </div>
      {open && (
        <div className="mem-detail">
          <div className="mem-sub">Say any of these</div>
          <div className="mem-phrases">
            {r.triggers.map((t) => (
              <span key={t} className="mem-phrase">
                “{t}”
                <button type="button" className="mem-x" onClick={() => void run({ kind: 'remove_phrase', id: r.id, text: t })} title="Remove this phrase" aria-label={`Remove phrase ${t}`}>
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="mem-add">
            <input
              className="mem-edit"
              value={phrase}
              placeholder="Add another phrase…"
              onChange={(e) => setPhrase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addPhrase();
              }}
            />
            <button type="button" className="mem-mini" onClick={() => void addPhrase()}>
              Add
            </button>
          </div>
          <div className="mem-sub">What it does</div>
          <ol className="mem-steps">
            {r.steps.map((s) => (
              <li key={s}>{s.replace(/^\d+\.\s*/, '')}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function MemoryRow({ m, run }: { m: MemoryItemView; run: Run }): React.ReactElement {
  const [editing, setEditing] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    if (editing === null) return;
    if (editing.trim() === '' || editing === m.value || (await run({ kind: 'edit_memory', id: m.id, text: editing }))) setEditing(null);
  };
  return (
    <div className="mem-row">
      <span className={`mem-badge ${m.type}`}>{m.type === 'preference' ? 'Preference' : 'Fact'}</span>
      {editing === null ? (
        <button type="button" className="mem-value" onClick={() => setEditing(m.value)} title="Click to edit">
          {m.value}
        </button>
      ) : (
        <input
          className="mem-edit"
          value={editing}
          autoFocus
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') setEditing(null);
          }}
          onBlur={() => void save()}
          aria-label="Memory text"
        />
      )}
      <button type="button" className="mem-x" onClick={() => void run({ kind: 'delete_memory', id: m.id })} title="Forget this" aria-label="Forget this">
        ×
      </button>
    </div>
  );
}

/**
 * The chat names Eya learned from a chat app the user allowed: all of them, listed, each removable. This is the whole of what she
 * keeps from a chat app — a name, what you call it, and how often she used it. Never a message or a number.
 */
function ChatNames({ view, run }: { view: ChatNamesView; run: Run }): React.ReactElement {
  const [sure, setSure] = useState(false);
  const on = view.learning === 'on';
  return (
    <>
      <label className="mem-toggle">
        <input type="checkbox" className="mem-check" checked={on} onChange={(e) => void run({ kind: 'set_chat_names', on: e.target.checked })} aria-label="Remember chat names" />
        <span>
          Remember the names of my chats <span className="mem-sub-inline">(names only, kept on this PC, never messages)</span>
        </span>
      </label>
      <div className="mem-list">
        {view.names.length === 0 ? (
          <div className="mem-empty">
            {on
              ? 'No names yet. They are added as you message people, or say “remember my WhatsApp contacts” while WhatsApp is open and Chats is on.'
              : view.learning === 'off'
                ? 'Off. Eya keeps no chat names. Tick the box above, or say “remember my WhatsApp contacts”, to let her find chats instantly.'
                : 'Eya has not been asked yet. Tick the box above, or say “remember my WhatsApp contacts”, and she will find chats by name without thinking. Names go away when you turn Chats off.'}
          </div>
        ) : (
          view.names.map((n) => (
            <div key={n.id} className="mem-row">
              <span className="mem-badge fact">{n.app}</span>
              <span className="mem-value static">
                {n.name}
                {n.aliases.length > 0 && <span className="mem-sub-inline"> · also “{n.aliases.join('”, “')}”</span>}
                {n.uses > 0 && <span className="mem-sub-inline"> · used {n.uses}×</span>}
              </span>
              <button type="button" className="mem-x" onClick={() => void run({ kind: 'forget_chat_name', id: n.id })} title="Forget this name" aria-label={`Forget ${n.name}`}>
                ×
              </button>
            </div>
          ))
        )}
      </div>
      {view.names.length > 0 && (
        <div className="mem-add">
          {sure ? (
            <>
              <button type="button" className="mem-mini danger" onClick={() => void run({ kind: 'forget_chat_names' }).then(() => setSure(false))}>
                Forget all {view.names.length}?
              </button>
              <button type="button" className="mem-mini" onClick={() => setSure(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" className="mem-mini" onClick={() => setSure(true)}>
              Forget all names
            </button>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Eya's memory, as the user sees and controls it: the routines she has learned (switch on or off, rename, change what you say, delete)
 * and the things she was asked to remember (read, edit, forget, add). Nothing here is hidden from the user or kept anywhere else.
 */
export function MemoryPanel({ snapshot, act }: { snapshot: MemorySnapshot | null; act: Act }): React.ReactElement {
  const [tab, setTab] = useState<'routines' | 'memories' | 'chats'>('routines');
  const [message, setMessage] = useState('');
  const [kind, setKind] = useState<'preference' | 'fact'>('preference');
  const [text, setText] = useState('');

  const run: Run = async (action) => {
    try {
      const r = await act(action);
      setMessage(r.ok ? '' : (r.message ?? 'That did not work.'));
      return r.ok;
    } catch {
      setMessage('That did not work.');
      return false;
    }
  };
  const add = async (): Promise<void> => {
    if (text.trim() === '') return;
    if (await run({ kind: 'add_memory', type: kind, text })) setText('');
  };

  if (snapshot === null) return <div className="mem-panel" role="region" aria-label="Memory"><div className="mem-empty">Loading…</div></div>;
  if (!snapshot.available) {
    return (
      <div className="mem-panel" role="region" aria-label="Memory">
        <div className="mem-title">Memory</div>
        <div className="mem-empty">Memory is not available right now: its database could not be opened. Eya works as usual without it.</div>
      </div>
    );
  }
  return (
    <div className="mem-panel" role="region" aria-label="Memory">
      <div className="mem-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'routines'} className={`mem-tab ${tab === 'routines' ? 'on' : ''}`} onClick={() => setTab('routines')}>
          Routines ({snapshot.routines.length})
        </button>
        <button type="button" role="tab" aria-selected={tab === 'memories'} className={`mem-tab ${tab === 'memories' ? 'on' : ''}`} onClick={() => setTab('memories')}>
          Memories ({snapshot.memories.length})
        </button>
        <button type="button" role="tab" aria-selected={tab === 'chats'} className={`mem-tab ${tab === 'chats' ? 'on' : ''}`} onClick={() => setTab('chats')}>
          Chat names ({snapshot.chatNames.names.length})
        </button>
      </div>
      {message !== '' && <div className="mem-msg">{message}</div>}
      {tab === 'chats' ? (
        <ChatNames view={snapshot.chatNames} run={run} />
      ) : tab === 'routines' ? (
        <div className="mem-list">
          {snapshot.routines.length === 0 ? (
            <div className="mem-empty">No routines yet. When you do the same task a few times, Eya will offer to save it. You can also say “save this as a routine” after doing one.</div>
          ) : (
            snapshot.routines.map((r) => <RoutineCard key={r.id} r={r} run={run} />)
          )}
        </div>
      ) : (
        <>
          <div className="mem-list">
            {snapshot.memories.length === 0 ? (
              <div className="mem-empty">Nothing remembered yet. Say “remember that…” or add something below.</div>
            ) : (
              snapshot.memories.map((m) => <MemoryRow key={m.id} m={m} run={run} />)
            )}
          </div>
          <div className="mem-add">
            <select className="mem-kind" value={kind} onChange={(e) => setKind(e.target.value === 'fact' ? 'fact' : 'preference')} aria-label="What kind of memory">
              <option value="preference">Preference</option>
              <option value="fact">Fact</option>
            </select>
            <input
              className="mem-edit"
              value={text}
              placeholder={kind === 'preference' ? 'e.g. Always save PDFs to Desktop' : "e.g. Ravi is my brother's contact"}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add();
              }}
            />
            <button type="button" className="mem-mini" onClick={() => void add()}>
              Add
            </button>
          </div>
        </>
      )}
      <div className="mem-foot">Kept only on this PC, in a local database. Passwords and card numbers are never stored.</div>
    </div>
  );
}
