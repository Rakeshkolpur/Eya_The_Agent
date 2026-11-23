import React, { useMemo, useRef, useState } from 'react';
import type { ChatsControl } from '../control';
import { timeAgo } from './format';
import { Icon } from './icons';

/** The button that starts a new conversation (the plus in the folded sidebar). */
export function NewChatButton({ chats, onNew, folded }: { chats: ChatsControl; onNew: () => void; folded: boolean }): React.ReactElement {
  return (
    <button type="button" className="new-chat" onClick={onNew} disabled={chats.busy} title={chats.busy ? 'Eya is answering: wait for her to finish, or press Stop' : 'Start a new chat'} aria-label="New chat">
      <Icon name="plus" size={folded ? 18 : 16} />
      {!folded && <span>New chat</span>}
    </button>
  );
}

/**
 * The conversations Eya keeps, newest first, like the task list of Manus or Gemini's agent: click one to carry on with it, rename or delete it
 * with the small buttons that appear beside it. Nothing is in the list while the app has not kept a conversation yet.
 */
export function ChatHistory({ chats, onOpen }: { chats: ChatsControl; onOpen: (id: string) => void }): React.ReactElement {
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const field = useRef<HTMLInputElement | null>(null);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === '' ? chats.items : chats.items.filter((c) => c.title.toLowerCase().includes(q));
  }, [chats.items, query]);

  const commit = (id: string): void => {
    const title = draft.trim();
    if (title !== '') chats.renameChat(id, title);
    setRenaming(null);
  };

  return (
    <div className="chat-history" aria-label="Your chats">
      <div className="chat-history-head">
        <span>Your chats</span>
        {chats.items.length > 0 && <span className="chat-count">{chats.items.length}</span>}
      </div>
      {chats.items.length > 6 && (
        <label className="chat-search">
          <Icon name="search" size={13} />
          <input value={query} placeholder="Search chats" spellCheck={false} aria-label="Search chats" onChange={(e) => setQuery(e.target.value)} />
        </label>
      )}
      {chats.items.length === 0 ? (
        <div className="chat-empty-note">{chats.keeping ? 'Your conversations are kept here, so you can come back to them.' : 'Keeping chats is off (Settings → Privacy).'}</div>
      ) : shown.length === 0 ? (
        <div className="chat-empty-note">No chat matches that.</div>
      ) : (
        <ul className="chat-list">
          {shown.map((c) => {
            const on = c.id === chats.currentId;
            return (
              <li key={c.id} className={`chat-item ${on ? 'on' : ''}`}>
                {renaming === c.id ? (
                  <input
                    ref={field}
                    className="chat-rename"
                    value={draft}
                    maxLength={60}
                    autoFocus
                    aria-label="Chat name"
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commit(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commit(c.id);
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                ) : asking === c.id ? (
                  <div className="chat-ask" role="alert">
                    <span>Delete this chat?</span>
                    <button type="button" className="chat-mini danger" onClick={() => { chats.deleteChat(c.id); setAsking(null); }} aria-label="Yes, delete it" title="Yes, delete it">
                      <Icon name="check" size={13} />
                    </button>
                    <button type="button" className="chat-mini" onClick={() => setAsking(null)} aria-label="Keep it" title="Keep it">
                      <Icon name="close" size={13} />
                    </button>
                  </div>
                ) : (
                  <>
                    <button type="button" className="chat-open" onClick={() => onOpen(c.id)} disabled={chats.busy && !on} title={chats.busy && !on ? 'Eya is answering: open another chat when she has finished' : c.title} aria-current={on ? 'true' : undefined}>
                      <span className="chat-title">{c.title}</span>
                      <span className="chat-when">{timeAgo(new Date(c.updatedAt).toISOString())}</span>
                    </button>
                    <span className="chat-actions">
                      <button type="button" className="chat-mini" onClick={() => { setDraft(c.title); setRenaming(c.id); }} aria-label={`Rename ${c.title}`} title="Rename">
                        <Icon name="edit" size={13} />
                      </button>
                      <button type="button" className="chat-mini" onClick={() => setAsking(c.id)} disabled={chats.busy && on} aria-label={`Delete ${c.title}`} title={chats.busy && on ? 'Eya is answering this chat' : 'Delete'}>
                        <Icon name="trash" size={13} />
                      </button>
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
