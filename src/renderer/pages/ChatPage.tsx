import React from 'react';
import type { EyaControl } from '../control';
import { ChatWorkspace } from '../ui/ChatWorkspace';

/** The conversation, full width: the same workspace as on Home (messages, attached files, the AI list, the microphone), nothing else beside it. */
export function ChatPage({ c }: { c: EyaControl }): React.ReactElement {
  return (
    <div className="chat-page">
      <ChatWorkspace
        c={c}
        className="full"
        header={
          <div className="chat-status">
            <span className={`status-dot ${c.listening || c.talk === 'on' ? 'live' : ''}`} />
            {c.statusText}
          </div>
        }
        empty={() => (
          <div className="chat-empty">
            <div className="chat-empty-title">Nothing said yet</div>
            <div>Type below, attach a file, or say "Hey Eya". What you say and what she answers shows up here while the app is open.</div>
          </div>
        )}
      />
    </div>
  );
}
