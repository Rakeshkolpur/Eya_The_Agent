import React, { useEffect, useRef, useState } from 'react';
import { ATTACH_ACCEPT, kindWord } from '../../shared/attachments';
import type { AttachmentChip, AttachmentKind, AttachmentRef } from '../../shared/attachments';
import type { EyaControl } from '../control';
import { useMotion } from '../motion';
import { AiPicker } from './AiPicker';
import { formatSize } from './format';
import { Icon } from './icons';
import type { IconName } from './icons';
import { useAttachments } from './useAttachments';
import type { DraftAttachment } from './useAttachments';

const KIND_ICON: Record<AttachmentKind, IconName> = { image: 'image', document: 'file', audio: 'audio', video: 'film' };

/** Whether the files can be read right now by the AI that is chosen: a reason in words when they cannot, null when they can. */
export function attachProblem(c: EyaControl): string | null {
  if (c.aiRoute?.prefer === 'local-only') return "Local AI only cannot read attached files. Choose \"Local AI first\" or Automatic in the AI list, or send without the file.";
  const haveGemini = c.geminiKey?.source !== 'none' || (c.geminiKeys?.entries.length ?? 0) > 0;
  if (c.geminiKey !== null && !haveGemini) return 'Reading a file needs a Gemini key (Settings → Gemini keys). The other AIs cannot read files.';
  return null;
}

function Chip({ item, onRemove }: { item: DraftAttachment; onRemove: () => void }): React.ReactElement {
  return (
    <span className={`attach-chip k-${item.kind} ${item.state}`} title={`${item.name} (${formatSize(item.size)})`}>
      {item.preview !== undefined ? <img className="attach-thumb" src={item.preview} alt="" /> : (
        <span className="attach-icon">
          <Icon name={KIND_ICON[item.kind]} size={16} />
        </span>
      )}
      <span className="attach-text">
        <span className="attach-name">{item.name}</span>
        <span className="attach-sub">{item.state === 'preparing' ? 'Getting it ready…' : `${kindWord(item.kind)} · ${formatSize(item.size)}`}</span>
      </span>
      <button type="button" className="attach-x" onClick={onRemove} aria-label={`Remove ${item.name}`} title="Remove">
        <Icon name="close" size={13} />
      </button>
    </span>
  );
}

/** The files shown next to a message in the conversation. */
function Sent({ files }: { files: readonly AttachmentChip[] }): React.ReactElement {
  return (
    <div className="sent-files">
      {files.map((f, i) => (
        <span key={`${f.name}-${i}`} className={`sent-file k-${f.kind}`} title={`${f.name} (${formatSize(f.size)})`}>
          <Icon name={KIND_ICON[f.kind]} size={14} />
          <span>{f.name}</span>
        </span>
      ))}
    </div>
  );
}

/** The conversation: what was typed or said, what Eya answered (as it is written), and the files that went with a message. */
export function Conversation({ c, empty }: { c: EyaControl; empty: React.ReactNode }): React.ReactElement {
  const end = useRef<HTMLDivElement | null>(null);
  const working = c.state === 'thinking' || c.state === 'working';
  useMotion(working);
  const last = c.thread[c.thread.length - 1];
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [c.thread.length, last?.text, c.streaming, working]);
  return (
    <div className="conv scroll" role="log" aria-live="polite">
      <div className="conv-inner">
        {c.thread.length === 0 && c.streaming === '' && !working ? empty : null}
        {c.thread.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.attachments !== undefined && <Sent files={m.attachments} />}
            <div className="msg-bubble">{m.text}</div>
            <div className="msg-meta">
              {m.role === 'user' ? 'You' : 'Eya'}
              {m.via === 'voice' ? ' · voice' : m.via === 'live' ? ' · live' : ''}
              {m.role === 'eya' && m.tokens !== undefined && (
                <span className="msg-tokens" title={`${m.tokens.prompt.toLocaleString()} tokens sent + ${m.tokens.completion.toLocaleString()} in the answer, over ${m.tokens.calls} AI answer${m.tokens.calls === 1 ? '' : 's'}${m.tokens.cached !== undefined ? `. ${m.tokens.cached.toLocaleString()} of the tokens sent were ones the AI had already seen: it counts them in the total, but they cost less` : ''}`}>
                  {' · '}
                  {m.tokens.total.toLocaleString()} tokens
                </span>
              )}
            </div>
            {m.suggestAgent === true && m.id === last?.id && !c.agentMode && (
              <button
                type="button"
                className="agent-suggest"
                onClick={() => {
                  const asked = [...c.thread].reverse().find((x) => x.role === 'user');
                  c.setAgentMode(true);
                  if (asked !== undefined) void c.submit(asked.text, undefined, { agent: true });
                }}
              >
                <Icon name="bolt" size={14} /> Turn on Agent and do it
              </button>
            )}
          </div>
        ))}
        {c.streaming !== '' && (
          <div className="msg eya" aria-live="off">
            <div className="msg-bubble streaming">{c.streaming}</div>
            <div className="msg-meta">Eya · writing…</div>
          </div>
        )}
        {working && c.streaming === '' && (
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
    </div>
  );
}

/**
 * The box a message is written in: grows as it is typed, takes files (the clip, a drop on the workspace, a paste), shows each before it goes,
 * has the AI list and the microphone, and says plainly when a file cannot be read.
 */
export function ChatWorkspace({
  c,
  header,
  empty,
  className = '',
}: {
  c: EyaControl;
  header?: React.ReactNode;
  /** What the empty conversation shows (given a way to put words into the box). */
  empty: (fill: (text: string) => void) => React.ReactNode;
  className?: string;
}): React.ReactElement {
  const files = useAttachments();
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const depth = useRef(0);
  const busy = c.state === 'thinking' || c.state === 'working';
  // (while she is reading the answer aloud, Send stays: the next message can be sent, and a small button silences her)
  const speaking = c.state === 'speaking';
  const problem = files.items.length > 0 ? attachProblem(c) : null;
  const canSend = (text.trim() !== '' || files.items.length > 0) && !files.preparing && problem === null && !busy;

  // The box grows with what is typed, up to a limit, and goes back to one line when it is sent.
  useEffect(() => {
    const el = area.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  useEffect(() => {
    area.current?.focus();
  }, []);

  const fill = (words: string): void => {
    setText(words);
    area.current?.focus();
  };
  const send = (): void => {
    if (!canSend) return;
    const words = text.trim() !== '' ? text.trim() : files.items.length === 1 ? 'Summarize this file.' : 'Summarize these files.';
    const attached: readonly AttachmentRef[] = files.ready;
    setText('');
    files.clear();
    void c.submit(words, attached);
  };

  const pick = (list: FileList | null): void => {
    if (list !== null && list.length > 0) files.add([...list]);
    if (picker.current !== null) picker.current.value = '';
  };

  return (
    <div
      className={`cw ${dragging ? 'dragging' : ''} ${className}`.trim()}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        depth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        files.add([...e.dataTransfer.files]);
      }}
    >
      {header}
      <Conversation c={c} empty={empty(fill)} />
      <div className="composer">
        {files.items.length > 0 && (
          <div className="attach-row">
            {files.items.map((i) => (
              <Chip key={i.id} item={i} onRemove={() => files.remove(i.id)} />
            ))}
          </div>
        )}
        {problem !== null && (
          <div className="composer-note bad" role="alert">
            <Icon name="info" size={14} /> {problem}
          </div>
        )}
        {files.notes.map((n) => (
          <div key={n.id} className="composer-note" role="status">
            <Icon name="info" size={14} />
            <span>{n.text}</span>
            <button type="button" className="attach-x" onClick={() => files.dismissNote(n.id)} aria-label="Dismiss" title="Dismiss">
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        <textarea
          ref={area}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={busy ? 'Eya is working… you can keep typing' : c.agentMode ? 'Tell Eya what to do, or drop files here' : 'Message Eya, or drop files here'}
          spellCheck={false}
          aria-label="Message Eya"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files];
            if (pasted.length === 0) return;
            e.preventDefault();
            files.add(pasted);
          }}
        />
        <div className="composer-bar">
          <button type="button" className="ask-tool" onClick={() => picker.current?.click()} title="Attach pictures, PDFs, Word or text files, audio or video" aria-label="Attach files">
            <Icon name="clip" size={18} />
          </button>
          <input ref={picker} type="file" multiple hidden accept={ATTACH_ACCEPT} onChange={(e) => pick(e.target.files)} aria-hidden="true" tabIndex={-1} />
          <AiPicker c={c} className="in-composer" />
          <button
            type="button"
            className={`agent-toggle ${c.agentMode ? 'on' : ''}`}
            role="switch"
            aria-checked={c.agentMode}
            onClick={() => c.setAgentMode(!c.agentMode)}
            title={c.agentMode ? 'Agent is on: Eya uses the browser and your PC to do what you ask. Click to go back to plain chat.' : 'Agent is off: Eya only chats. Switch it on and she will use the browser and your PC to do what you ask.'}
            aria-label="Agent mode"
          >
            <Icon name="bolt" size={14} />
            <span>Agent</span>
            <span className="agent-state">{c.agentMode ? 'On' : 'Off'}</span>
          </button>
          <span className="sec-spacer" />
          {speaking && (
            <button type="button" className="ask-tool stop-speaking" onClick={c.stopAll} title="Stop her talking" aria-label="Stop speaking">
              <Icon name="stop" size={16} />
            </button>
          )}
          <button type="button" className={`ask-tool ${c.talk !== 'off' ? 'on' : ''}`} onClick={c.toggleTalk} disabled={c.talk === 'off' && !c.voiceOn} title={c.talk === 'off' ? 'Talk to Eya' : 'End the conversation'} aria-label="Talk to Eya">
            <Icon name="mic" size={18} />
          </button>
          {busy ? (
            <button type="button" className="ask-go stop" onClick={c.stopAll} title="Stop: Eya stops what she is doing at once" aria-label="Stop">
              <Icon name="stop" size={15} />
            </button>
          ) : (
            <button type="button" className="ask-go" onClick={send} disabled={!canSend} title={files.preparing ? 'Getting the files ready' : 'Send'} aria-label="Send">
              <Icon name="send" size={17} />
            </button>
          )}
        </div>
      </div>
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <Icon name="clip" size={28} />
          <div>Drop files to attach them</div>
          <small>Pictures, PDFs, Word and text files, audio and video</small>
        </div>
      )}
    </div>
  );
}
