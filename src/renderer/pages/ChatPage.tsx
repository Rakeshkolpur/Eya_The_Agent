import React, { useEffect, useRef, useState } from 'react';
import type { EyaControl } from '../control';
import { useMotion } from '../motion';
import { Icon } from '../ui/icons';

/** The conversation: what you typed or said, and what Eya answered — typed, spoken and live all in one place. */
export function ChatPage({ c }: { c: EyaControl }): React.ReactElement {
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [c.thread.length, c.thread[c.thread.length - 1]?.text]);
  useEffect(() => {
    input.current?.focus();
  }, []);

  const send = (): void => {
    const t = text.trim();
    if (t === '') return;
    setText('');
    void c.submit(t);
  };
  const working = c.state === 'thinking' || c.state === 'working';
  useMotion(working); // the three dots ripple from the page's motion clock

  return (
    <div className="chat">
      <div className="chat-status">
        <span className={`status-dot ${c.listening || c.talk === 'on' ? 'live' : ''}`} />
        {c.statusText}
      </div>
      <div className="chat-thread" role="log" aria-live="polite">
        {c.thread.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-title">Nothing said yet</div>
            <div>Type below, or say “Hey Eya”. What you say and what she answers shows up here while the app is open.</div>
          </div>
        )}
        {c.thread.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="msg-bubble">{m.text}</div>
            <div className="msg-meta">
              {m.role === 'user' ? 'You' : 'Eya'}
              {m.via === 'voice' ? ' · voice' : m.via === 'live' ? ' · live' : ''}
            </div>
          </div>
        ))}
        {working && (
          <div className="msg eya">
            <div className="msg-bubble typing" aria-label="Eya is working">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="ask-bar">
        <input
          ref={input}
          className="ask-input"
          value={text}
          placeholder="Ask Eya anything…"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
        />
        <button type="button" className={`ask-mic ${c.talk !== 'off' ? 'on' : ''}`} onClick={c.toggleTalk} disabled={c.talk === 'off' && !c.voiceOn} title={c.talk === 'off' ? 'Talk to Eya' : 'End the conversation'} aria-label="Talk to Eya">
          <Icon name="mic" size={18} />
        </button>
        <button type="button" className="ask-send" onClick={send} title="Send" aria-label="Send">
          <Icon name="send" size={17} />
        </button>
      </div>
    </div>
  );
}
