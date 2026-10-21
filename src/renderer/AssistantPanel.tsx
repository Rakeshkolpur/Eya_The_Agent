import React, { useEffect, useRef, useState } from 'react';
import type { OrbState } from '../shared/types';
import { VOICE_OPTIONS } from '../shared/constants';
import { MemoryPanel } from './MemoryPanel';
import { Icon } from './ui/icons';
import { AiPicker } from './ui/AiPicker';
import { TasksCard } from './ui/TasksCard';
import { ShareConsent } from './ui/ShareConsent';
import type { EyaControl } from './control';

const STATUS_LABEL: Record<OrbState, string> = {
  idle: 'idle',
  listening: 'listening',
  thinking: 'thinking',
  working: 'working',
  speaking: 'speaking',
  error: 'error',
};

/**
 * The quick assistant: the small panel that opens from the bubble. Ask by typing or by voice, start or end a live conversation,
 * switch Chats, look at memory — and open the full app for the rest.
 */
export function AssistantPanel({ c }: { c: EyaControl }): React.ReactElement {
  const [input, setInput] = useState('');
  const [commOpen, setCommOpen] = useState(false);
  const [memOpen, setMemOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Opening the panel puts the cursor in the box.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const { providerStatus: ps } = c;
  const canHear = (ps?.ai === 'gemini' && ps.aiReady) || c.sttState === 'ready';
  const aiStatusLine =
    ps === null
      ? 'Connecting…'
      : ps.aiReady && ps.ai === 'gemini'
        ? 'Gemini connected'
        : ps.aiReady && ps.ai === 'ollama'
          ? 'Ollama connected'
          : ps.ai === 'none'
            ? 'No LLM — local commands only'
            : `${ps.ai}: checking`;
  const earsHint = c.sttState === 'ready' ? 'hears on this PC · ' : c.sttState === 'loading' ? 'loading speech model… · ' : '';
  const voiceLabel = !c.voiceOn ? 'Voice OFF' : c.listening ? 'Voice ON' : 'Starting…';
  const voiceTitle = !c.voiceOn
    ? 'Voice is off. Click to let Eya listen and speak.'
    : !canHear && ps !== null
      ? 'Waiting for speech recognition (the on-device model is loading, or add a Gemini key). Click to turn off.'
      : 'Eya is listening and speaking. Click to turn voice off.';
  const { comm, memory } = c;

  const send = (): void => {
    const text = input;
    setInput('');
    void c.submit(text);
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">Eya</span>
        <span className="mem-spacer" />
        <button type="button" className="panel-icon" onClick={() => c.setWindowMode('app')} title="Open the full Eya window" aria-label="Open the full Eya window">
          <Icon name="expand" size={15} />
        </button>
        <button type="button" className="panel-icon" onClick={() => c.setWindowMode('bubble')} title="Put Eya away (Esc)" aria-label="Close">
          <Icon name="close" size={15} />
        </button>
      </div>
      <div className="status-row">
        <span className="status">{STATUS_LABEL[c.state]}</span>
        <button
          type="button"
          className={`talk-pill ${c.talk !== 'off' ? 'on' : ''}`}
          onClick={c.toggleTalk}
          disabled={c.talk === 'off' && !c.voiceOn}
          title={c.talk === 'off' ? (c.voiceOn ? 'Start a live conversation with Eya (or just say "Hey Eya")' : 'Turn voice on first') : 'End the conversation'}
          aria-pressed={c.talk !== 'off'}
        >
          {c.talk === 'off' ? 'Talk' : c.talk === 'connecting' ? 'Connecting…' : 'Live · End'}
        </button>
        <button
          type="button"
          className={`interrupt-pill ${c.interruptOn ? 'on' : ''}`}
          onClick={c.toggleInterrupt}
          title={c.interruptOn ? 'You can talk over Eya and she will stop. Turn off if she cuts herself off.' : 'Let me interrupt Eya while she talks. Works best with headphones.'}
          aria-pressed={c.interruptOn}
        >
          Interrupt
        </button>
        <button
          type="button"
          className={`memory-pill ${memOpen ? 'open' : ''} ${memory?.suggestion != null ? 'offer' : ''}`}
          onClick={() => {
            setMemOpen((v) => !v);
            setCommOpen(false);
          }}
          title={memory?.available === false ? 'Memory is not available right now.' : 'What Eya remembers, and the routines she has learned. Click to see or change them.'}
          aria-expanded={memOpen}
        >
          Memory
        </button>
        <button
          type="button"
          className={`share-pill-btn ${c.share.active ? 'on' : ''}`}
          onClick={() => {
            if (c.share.active) c.stopShare();
            else setShareOpen((v) => !v);
            setCommOpen(false);
            setMemOpen(false);
          }}
          title={c.share.active ? 'Eya can see your screen. Click to stop.' : 'Share your screen so Eya can help with what you are looking at.'}
          aria-pressed={c.share.active}
        >
          {c.share.active ? (c.share.paused !== null ? 'Sharing · paused' : 'Sharing ●') : 'Share screen'}
        </button>
        <button
          type="button"
          className={`chats-pill ${comm?.enabled === true ? 'on' : ''}`}
          onClick={() => {
            setCommOpen((v) => !v);
            setMemOpen(false);
            setShareOpen(false);
          }}
          title={comm?.enabled === true ? 'Eya may use the chat apps you allowed. Click to review or turn off.' : 'Eya does not look at chat apps. Click to read what turning this on allows.'}
          aria-expanded={commOpen}
        >
          Chats {comm?.enabled === true ? 'ON' : 'OFF'}
        </button>
        <AiPicker c={c} whileLoading={aiStatusLine} />
      </div>
      <TasksCard c={c} variant="strip" />
      {memory?.suggestion != null && (
        <div className="mem-offer" role="alert">
          <div>{memory.suggestion.text}</div>
          <div className="mem-offer-actions">
            <button type="button" className="comm-on" onClick={() => void c.actOnMemory({ kind: 'answer_suggestion', answer: 'yes' })}>
              {memory.suggestion.kind === 'update' ? 'Yes, update it' : 'Yes, save it'}
            </button>
            <button type="button" className="comm-off" onClick={() => void c.actOnMemory({ kind: 'answer_suggestion', answer: 'no' })}>
              No thanks
            </button>
          </div>
        </div>
      )}
      {shareOpen && !c.share.active && (
        <ShareConsent
          compact
          onStart={() => {
            c.startShare();
            setShareOpen(false);
          }}
          onCancel={() => setShareOpen(false)}
        />
      )}
      {memOpen && <MemoryPanel snapshot={memory} act={c.actOnMemory} />}
      {commOpen && comm !== null && <CommunicationBox comm={comm} change={c.changeComm} close={() => setCommOpen(false)} />}
      <div className="transcript">{c.transcript || (c.listening ? 'Listening. Just say a command.' : 'Type a command.')}</div>
      {c.screenAsk.phase !== 'idle' && (
        <div className={`screen-reply ${c.screenAsk.phase}`}>
          {c.screenAsk.phase === 'working' ? 'Looking at your screen…' : c.screenAsk.phase === 'done' ? c.screenAsk.answer : c.screenAsk.error}
        </div>
      )}
      <div className="input">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
            if (e.key === 'Escape') c.setWindowMode('bubble');
          }}
          placeholder="Type a command…"
          spellCheck={false}
          autoFocus
        />
        {c.share.active && (
          <button
            type="button"
            className="screen-ask-btn"
            disabled={c.share.paused !== null || c.screenAsk.phase === 'working'}
            onClick={() => {
              const q = input.trim();
              setInput('');
              c.askScreen(q === '' ? { mode: 'analyze' } : { mode: 'ask', question: q });
            }}
            title="Ask Eya about your screen (type a question first, or leave it empty to hear what is on it)"
          >
            Ask screen
          </button>
        )}
        <button type="button" className={`voice-toggle ${c.voiceOn ? 'on' : ''}`} onClick={c.toggleVoice} title={voiceTitle} aria-pressed={c.voiceOn}>
          <span className="voice-dot" style={{ transform: `scale(${1 + c.level * 0.9})` }} />
          {voiceLabel}
        </button>
      </div>
      <div className="hint-row">
        <span className="hint">
          {c.voiceOn ? `Just speak · ${earsHint}` : 'Voice off · '}Ctrl + Space to hide
        </span>
        <select className="voice-select" value={c.voiceName} onChange={(e) => c.changeVoiceName(e.target.value)} title="Choose Eya's voice" aria-label="Eya's voice">
          <optgroup label="Female">
            {VOICE_OPTIONS.filter((v) => v.gender === 'female').map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </optgroup>
          <optgroup label="Male">
            {VOICE_OPTIONS.filter((v) => v.gender === 'male').map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </optgroup>
        </select>
      </div>
    </div>
  );
}

/** The Communication Access switch: what turning chats on allows, the apps, and the confirm. (The same box is used in Settings.) */
export function CommunicationBox({ comm, change, close }: { comm: NonNullable<EyaControl['comm']>; change: EyaControl['changeComm']; close?: () => void }): React.ReactElement {
  return (
    <div className="comm-panel" role="region" aria-label="Communication Access">
      <div className="comm-title">Communication Access: {comm.enabled ? 'ON' : 'OFF'}</div>
      <div className="comm-explain">
        Allows Eya to read and interact with communication apps and websites such as WhatsApp, Telegram and Instagram, so she can find chats and contacts and send
        files or messages when you ask. It is off unless you turn it on, and you can turn it off at any time.
      </div>
      {comm.enabled ? (
        <>
          <div className="comm-apps">
            {comm.apps.map((a) => (
              <label key={a.id} className="comm-app">
                <input type="checkbox" checked={a.allowed} onChange={(e) => change({ app: { id: a.id, allowed: e.target.checked } })} />
                {a.name}
              </label>
            ))}
          </div>
          <div className="comm-actions">
            <button type="button" className="comm-off" onClick={() => change({ enabled: false })}>
              Turn off
            </button>
          </div>
        </>
      ) : (
        <div className="comm-actions">
          <button type="button" className="comm-on" onClick={() => change({ enabled: true })}>
            I understand, turn on
          </button>
          {close !== undefined && (
            <button type="button" className="comm-off" onClick={close}>
              Not now
            </button>
          )}
        </div>
      )}
      <div className="comm-foot">Eya looks only at what a task needs, keeps no copy of your chats, and never sees your passwords.</div>
    </div>
  );
}
