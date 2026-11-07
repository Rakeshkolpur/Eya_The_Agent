import React, { useEffect, useState } from 'react';
import { LIVE_RELATIONS } from '../../shared/liveChat';
import type { LiveChatPause, LiveChatRequest, LiveChatState, LiveChatView, LiveDraftStatus, LiveRelation } from '../../shared/liveChat';
import type { EyaControl } from '../control';
import { Icon } from '../ui/icons';

/** What each state means to a person. */
const STATE_WORD: Readonly<Record<LiveChatState, string>> = {
  IDLE: 'Not running',
  RESOLVING_CONTACT: 'Finding the chat…',
  CONNECTING: 'Connecting…',
  ACTIVE: 'Watching for new messages',
  PROCESSING_MESSAGE: 'Writing a reply…',
  DRAFT_READY: 'Reply ready',
  WAITING_FOR_APPROVAL: 'A reply is waiting for you',
  SENDING: 'Sending…',
  VERIFYING: 'Checking it was sent…',
  PAUSED: 'Paused',
  WAITING_FOR_USER: 'Needs you',
  STOPPING: 'Stopping…',
  STOPPED: 'Stopped',
  FAILED: 'Could not run',
};

const PAUSE_WORD: Readonly<Record<LiveChatPause, string>> = {
  user: 'You paused it.',
  chat_switched: 'The open chat is not the chosen one any more. It carries on by itself when the chosen chat is open again.',
  chat_closed: 'The chat was closed. It carries on by itself when the chosen chat is open again.',
  browser_lost: 'The connection to your browser was lost.',
  restart: 'Eya was restarted. Nothing was sent.',
  extension_old: 'The Eya browser extension needs reloading once (extensions page → the circular arrow on its card).',
  access_off: 'Chats, or the live chat permission, were switched off.',
  unreadable: "The page's layout cannot be read reliably.",
  standby: 'Waiting for its turn: several live chats are running, and Eya looks after each in turn.',
};

const RELATION_WORD: Readonly<Record<LiveRelation, string>> = {
  friend: 'a friend',
  partner: 'partner',
  family: 'family',
  senior: 'sir / madam / boss',
  client: 'a client',
  other: 'someone else',
};

const DRAFT_WORD: Readonly<Record<LiveDraftStatus, string>> = {
  ready: 'Ready to review',
  edited: 'Edited by you',
  approved: 'Approved — not sent yet',
  in_box: 'Typed in WhatsApp’s box — press Send there',
  sending: 'Sending…',
  sent: 'Sent',
  uncertain: 'Not confirmed — check the chat',
  failed: 'Failed',
  discarded: 'Discarded',
  stale: 'Out of date',
};

const isRunning = (v: LiveChatView): boolean => v.active;

function minutesSince(from: number | null, now: number): string {
  if (from === null) return '—';
  const s = Math.max(0, Math.floor((now - from) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function LiveChatPage({ c }: { c: EyaControl }): React.ReactElement {
  const v = c.liveChat;
  const [name, setName] = useState('');
  const [startMode, setStartMode] = useState<'draft' | 'assisted'>('draft');
  /** Who the other person is to the person: how Eya sounds. Empty: not said (she is natural and polite). */
  const [startRelation, setStartRelation] = useState<LiveRelation | ''>('');
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const [aware, setAware] = useState(false);
  // Off by default: the person is watching the chat, so each reply goes out as the message comes in. On: replies that promise something or mention figures/links wait.
  const [holdBack, setHoldBack] = useState(false);
  // Empty = no limit: a live chat waits for the next message until the person pauses or stops it.
  const [maxReplies, setMaxReplies] = useState('');
  const [maxMinutes, setMaxMinutes] = useState('');
  const [gap, setGap] = useState(10);
  // "Reply automatically" chosen on the start form: switched on (with the person's confirmation given there) as soon as the chat is the confirmed one
  const [startAuto, setStartAuto] = useState(false);
  const [startAware, setStartAware] = useState(false);
  // What the person wants from the chat, in their words (it guides the replies), and whether Eya is to write the first message
  const [purpose, setPurpose] = useState('');
  const [startOpening, setStartOpening] = useState(true);
  // What Eya calls the person in the chat ("I am Eya, <name>'s assistant"): typed here, saved with the button.
  const savedOwner = c.liveChat?.enable.ownerName ?? '';
  const [ownerDraft, setOwnerDraft] = useState(savedOwner);
  useEffect(() => setOwnerDraft(savedOwner), [savedOwner]);
  const [pendingAuto, setPendingAuto] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // A new reply replaces what was being edited; the person's own edits are kept while they are typing.
  const draftId = v?.draft?.id ?? null;
  const draftText = v?.draft?.text ?? '';
  useEffect(() => {
    setText(draftText);
    setEditing(false);
  }, [draftId, draftText]);

  /** What was typed in the two limit boxes, as numbers; a box left empty sets no limit. */
  const limits = (): { maxReplies?: number; maxMinutes?: number; minGapSeconds: number } => {
    const replies = maxReplies.trim() === '' ? NaN : Number(maxReplies);
    const minutes = maxMinutes.trim() === '' ? NaN : Number(maxMinutes);
    return { ...(Number.isFinite(replies) ? { maxReplies: replies } : {}), ...(Number.isFinite(minutes) ? { maxMinutes: minutes } : {}), minGapSeconds: gap };
  };

  const act = (request: LiveChatRequest): void => {
    setBusy(true);
    void c
      .liveChatAct(request)
      .then((r) => setMessage({ ok: r.ok, text: r.message }))
      .catch(() => setMessage({ ok: false, text: 'That did not work.' }))
      .finally(() => setBusy(false));
  };

  const state = v?.state;
  const verified = v?.verified === true;
  const autoNow = v?.auto ?? null;
  const sendOk = v?.sendAllowed === true;
  useEffect(() => {
    if (!pendingAuto) return;
    if (state === 'FAILED' || state === 'STOPPED') {
      setPendingAuto(false);
      return;
    }
    if (state === 'ACTIVE' && verified && autoNow === null && sendOk) {
      setPendingAuto(false);
      act({ kind: 'enable_auto', confirmedAware: true, ...limits(), ...(holdBack ? { holdBack: true } : {}), ...(startOpening ? {} : { introduce: false }) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAuto, state, verified, autoNow, sendOk]);

  if (v === null) return <div className="livechat-page"><div className="empty">Loading…</div></div>;
  const running = isRunning(v);
  const draft = v.draft;
  const canAct = draft !== null && (draft.status === 'ready' || draft.status === 'edited' || draft.status === 'approved');
  const sending = v.state === 'SENDING' || v.state === 'VERIFYING' || v.state === 'STOPPING';
  const autoLeft = v.auto === null || v.auto.until === null ? 0 : Math.max(0, v.auto.until - now);

  return (
    <div className="livechat-page">
      <div className="livechat-intro">
        <h1>Live chat</h1>
        <p>
          Eya watches ONE WhatsApp chat you choose, reads its new messages as they arrive, and writes a reply for you. In <strong>Draft</strong> mode she never sends. In
          <strong> Assisted</strong> mode she sends only when you press Send. She never reads your other chats.
          {v.idleStopMinutes !== null
            ? ` If the other person says nothing for ${v.idleStopMinutes} minutes, Eya checks in once with a friendly message (when automatic replies are on), and the live chat stops by itself if they stay quiet for ${v.idleStopMinutes} more minutes.`
            : ''}
        </p>
      </div>

      {v.chats !== undefined && v.chats.length > 1 && (
        <section className="card livechat-card" aria-label="All the live chats">
          <h2>{v.chats.length} live chats are running</h2>
          <p className="muted">WhatsApp shows one chat at a time, so Eya looks after them in turn: the one in front answers at once, and the others wait a short while for their turn.</p>
          <ul className="livechat-notes">
            {v.chats.map((x) => (
              <li key={x.id}>
                <strong>{x.chat}</strong> · {x.front ? 'in front' : x.pause === 'standby' ? 'waiting for its turn' : STATE_WORD[x.state]}
                {x.relation !== null ? ` · ${RELATION_WORD[x.relation]}` : ''} · {x.replies} {x.replies === 1 ? 'reply' : 'replies'}
                {!x.front && (
                  <button type="button" className="btn" disabled={busy} onClick={() => act({ kind: 'focus', chat: x.id })}>
                    Show this one
                  </button>
                )}
                <button type="button" className="btn" disabled={busy} onClick={() => act({ kind: 'stop', chat: x.id })}>
                  Stop
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn" disabled={busy} onClick={() => act({ kind: 'stop', all: true })}>
            Stop all
          </button>
        </section>
      )}

      {message !== null && (
        <div className={`plugins-message ${message.ok ? 'ok' : 'bad'}`} role="status">
          {message.text}
        </div>
      )}

      <section className={`card livechat-card livechat-enable ${v.enable.ready ? 'livechat-enable-on' : ''}`} aria-label="Enable live chat">
        <h2>Enable live chat</h2>
        <label className="livechat-check livechat-switch">
          <input type="checkbox" role="switch" aria-label="Enable live chat" checked={v.enable.on} disabled={busy} onChange={(e) => act({ kind: e.target.checked ? 'enable_live' : 'disable_live' })} />
          <span>
            <strong>{!v.enable.on ? 'Off' : v.enable.ready ? 'On: a live chat replies by itself, with no question each time' : 'On, but something it needs was taken away'}</strong>
          </span>
        </label>
        <p className="livechat-note">
          One switch for everything the live chat needs. By turning it on <strong>you confirm that the people you live-chat with know that replies are written with AI help</strong> (Eya never hides it, and says so if asked). Turn it off at any moment: only what it
          gave is taken back.
        </p>
        <div className="livechat-owner">
          <label>
            Your name: in the chat Eya says "I am Eya, {ownerDraft.trim() !== '' ? ownerDraft.trim() : 'your'}{ownerDraft.trim() !== '' ? "'s" : ''} assistant"
            <input className="ask-input" aria-label="Your name" placeholder="your name" maxLength={40} value={ownerDraft} onChange={(e) => setOwnerDraft(e.target.value)} />
          </label>
          <button type="button" className="btn" disabled={busy || ownerDraft.trim() === v.enable.ownerName} onClick={() => act({ kind: 'set_owner_name', name: ownerDraft.trim() })}>
            Save name
          </button>
        </div>
        <ul className="livechat-enable-items">
          {v.enable.items.map((i) => (
            <li key={i.id} className={i.ok ? 'ok' : 'missing'}>
              <span aria-hidden="true">{i.ok ? '✓' : '○'}</span> {i.label}
              <span className="sr-only">{i.ok ? ' (in place)' : ' (not in place)'}</span>
            </li>
          ))}
        </ul>
        {v.enable.on && !v.enable.ready && (
          <button type="button" className="btn primary" disabled={busy} onClick={() => act({ kind: 'enable_live' })}>
            Allow what is missing again
          </button>
        )}
      </section>

      {v.forYou.length > 0 && (
        <section className="card livechat-card livechat-notes" aria-label="For you from the chat">
          <h2>For you, from the chat</h2>
          <p className="livechat-note">What the other person asked Eya to pass on to you. Kept here until you clear it.</p>
          <ul className="livechat-notes-list">
            {v.forYou.map((n) => (
              <li key={n.id}>
                <span className="livechat-notes-time">{clock(n.at)}</span> {n.text}
              </li>
            ))}
          </ul>
          <button type="button" className="btn" disabled={busy} onClick={() => act({ kind: 'clear_notes' })}>
            Clear
          </button>
        </section>
      )}

      {(!running || c.settings?.settings.multiLiveChats !== false) && (
        <section className="card livechat-card" aria-label="Start a live chat">
          <h2>{running ? 'Start another live chat' : 'Start a live chat'}</h2>
          <div className="livechat-start">
            <input className="ask-input" aria-label="Who is the chat with?" placeholder="Who is the chat with? (a name or a phone number)" value={name} onChange={(e) => setName(e.target.value)} />
            <select className="ask-input" aria-label="Who is this person to you?" value={startRelation} onChange={(e) => setStartRelation((LIVE_RELATIONS.find((x) => x === e.target.value) ?? '') as LiveRelation | '')}>
              <option value="">Who are they to you? (optional)</option>
              <option value="friend">A friend</option>
              <option value="partner">My partner (girlfriend, wife, husband)</option>
              <option value="family">Family</option>
              <option value="senior">Sir / madam / boss / teacher</option>
              <option value="client">A client</option>
              <option value="other">Someone else</option>
            </select>
            <select className="ask-input" aria-label="Mode" value={startMode} onChange={(e) => setStartMode(e.target.value === 'assisted' ? 'assisted' : 'draft')}>
              <option value="draft">Draft: suggest replies, never send</option>
              <option value="assisted">Assisted: send when I approve</option>
            </select>
            <button
              type="button"
              className="btn primary"
              disabled={busy || name.trim() === '' || (startAuto && !startAware)}
              onClick={() => {
                const about = purpose.replace(/\s+/g, ' ').trim();
                act({ kind: 'start', name: name.trim(), mode: startMode, ...(startRelation !== '' ? { relation: startRelation } : {}), ...(about !== '' ? { purpose: about } : {}), ...(startAuto ? { opening: startOpening } : {}) });
                if (startAuto) setPendingAuto(true);
              }}
            >
              <Icon name="play" size={16} /> {startAuto ? 'Start and reply automatically' : 'Start'}
            </button>
          </div>
          <input
            className="ask-input"
            aria-label="What should Eya do in this chat?"
            placeholder="What should Eya do in this chat? (optional, e.g. she is my close friend, make her happy)"
            maxLength={300}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          />
          <label className="livechat-check">
            <input type="checkbox" checked={startAuto} onChange={(e) => setStartAuto(e.target.checked)} />
            <span>Reply automatically (AI-assisted): Eya answers this chat herself, without asking me each time</span>
          </label>
          {startAuto && (
            <div className="livechat-autoform">
              <label className="livechat-check">
                <input type="checkbox" checked={startAware} onChange={(e) => setStartAware(e.target.checked)} />
                <span>The other person knows and agrees that replies in this chat are written with AI assistance. (Eya never hides it, and never uses this to deceive anyone.)</span>
              </label>
              <label className="livechat-check">
                <input type="checkbox" checked={startOpening} onChange={(e) => setStartOpening(e.target.checked)} />
                <span>Eya introduces herself in the chat first ("I am Eya, your assistant — tell me what you want"), instead of waiting for them to write</span>
              </label>
              <div className="livechat-limits">
                <label>
                  Most replies (empty: no limit)
                  <input className="ask-input" type="number" min={1} max={1000} placeholder="no limit" value={maxReplies} onChange={(e) => setMaxReplies(e.target.value)} />
                </label>
                <label>
                  Minutes (empty: until I pause it)
                  <input className="ask-input" type="number" min={1} max={1440} placeholder="no limit" value={maxMinutes} onChange={(e) => setMaxMinutes(e.target.value)} />
                </label>
                <label>
                  Seconds apart
                  <input className="ask-input" type="number" min={5} max={600} value={gap} onChange={(e) => setGap(Number(e.target.value))} />
                </label>
              </div>
              <label className="livechat-check">
                <input type="checkbox" checked={holdBack} onChange={(e) => setHoldBack(e.target.checked)} />
                <span>Hold back for my approval any reply that promises something or mentions figures or links</span>
              </label>
              <div className="livechat-note">Each reply goes out as the message comes in, so keep an eye on the chat: you can stop it at any moment. Eya never sends a password, a one-time code or a card or account number, and never makes up a time, an amount or a link.</div>
            </div>
          )}
          {v.state === 'FAILED' && v.error !== null && <div className="livechat-error" role="alert">{v.error}</div>}
          {v.state === 'STOPPED' && <div className="livechat-note">The last live chat{v.chat !== null ? ` with ${v.chat}` : ''} was stopped. {v.replies} {v.replies === 1 ? 'reply was' : 'replies were'} sent.</div>}
          {!v.sendAllowed && <div className="livechat-note">Sending is switched off for now (the WhatsApp plugin needs the “Send text messages” permission, and Chats must be on). Drafts still work.</div>}
        </section>
      )}

      {running && (
        <>
          <section className="card livechat-card" aria-label="The live chat">
            <div className="livechat-head">
              <div>
                <h2>{v.chat ?? 'Chat'}</h2>
                <div className="livechat-sub">
                  {v.app} · {v.verified ? 'chat confirmed' : 'not confirmed yet'} · monitoring:{' '}
                  {v.monitoring === 'event' ? 'on (the page tells Eya when something changes)' : v.monitoring === 'checking' ? 'checking every few seconds (this page did not announce a message by itself)' : 'off'}
                  {v.monitoring !== 'off' && v.lastCheckAt !== null && ` · last checked ${Math.max(0, Math.round((now - v.lastCheckAt) / 1000))}s ago`}
                </div>
              </div>
              <span className={`plugin-status ${v.state === 'ACTIVE' || v.state === 'WAITING_FOR_APPROVAL' ? 'ready' : v.state === 'FAILED' || v.state === 'WAITING_FOR_USER' ? 'error' : 'not_connected'}`} role="status">
                {STATE_WORD[v.state]}
              </span>
            </div>
            <div className="livechat-stats">
              <span>Session {minutesSince(v.startedAt, now)}</span>
              <span>
                {v.replies} {v.replies === 1 ? 'reply' : 'replies'} sent
              </span>
              <span>{v.auto !== null ? 'Automatic sending: ON' : 'Automatic sending: off'}</span>
            </div>

            {v.purpose !== '' && <div className="livechat-note">What you asked Eya to do in this chat: {v.purpose}</div>}
            {v.pause !== null && v.state === 'PAUSED' && <div className="livechat-note">{PAUSE_WORD[v.pause]}</div>}
            {v.error !== null && <div className="livechat-error" role="alert">{v.error}</div>}
            {v.notice !== null && <div className="livechat-note" role="status">{v.notice}</div>}

            {v.confirmChat !== null && (
              <div className="livechat-ask">
                <div>
                  Is <strong>{v.confirmChat}</strong> the right chat?
                </div>
                <button type="button" className="btn primary" disabled={busy} onClick={() => act({ kind: 'confirm_chat' })}>
                  <Icon name="check" size={16} /> Yes, this chat
                </button>
              </div>
            )}
            {v.choices.length > 0 && (
              <div className="livechat-ask">
                <div>Which chat?</div>
                {v.choices.map((ch) => (
                  <button key={ch.choice} type="button" className="btn" disabled={busy} onClick={() => act({ kind: 'choose', choice: ch.choice })}>
                    {ch.choice}. {ch.label}
                  </button>
                ))}
              </div>
            )}

            <div className="livechat-controls">
              {v.state === 'PAUSED' || (v.state === 'WAITING_FOR_USER' && v.confirmChat === null && v.choices.length === 0) ? (
                <button type="button" className="btn primary" disabled={busy} onClick={() => act({ kind: 'resume' })}>
                  <Icon name="play" size={16} /> Resume
                </button>
              ) : (
                <button type="button" className="btn" disabled={busy || sending || v.state === 'RESOLVING_CONTACT' || v.state === 'CONNECTING'} onClick={() => act({ kind: 'pause' })}>
                  <Icon name="pause" size={16} /> Pause
                </button>
              )}
              <button type="button" className="btn" disabled={busy && v.state !== 'SENDING'} onClick={() => act({ kind: 'stop' })}>
                <Icon name="stop" size={16} /> Stop
              </button>
              <label className="livechat-mode">
                Mode
                <select
                  className="ask-input"
                  aria-label="Reply mode"
                  value={v.mode === 'auto' ? 'auto' : v.mode}
                  disabled={busy || sending}
                  onChange={(e) => {
                    if (e.target.value === 'draft' || e.target.value === 'assisted') act({ kind: 'set_mode', mode: e.target.value });
                  }}
                >
                  <option value="draft">Draft: never sends</option>
                  <option value="assisted">Assisted: sends when I approve</option>
                  {v.mode === 'auto' && <option value="auto">Auto-reply (ON)</option>}
                </select>
              </label>
            </div>
          </section>

          <section className={`card livechat-card ${v.auto !== null ? 'livechat-auto-on' : ''}`} aria-label="Automatic replies">
            <h2>Automatic replies</h2>
            {v.auto !== null ? (
              <>
                <div className="livechat-banner" role="alert">
                  AI-ASSISTED AUTOMATIC REPLIES ARE ON FOR THIS CHAT · {v.auto.repliesSent}
                  {v.auto.maxReplies !== null ? ` of ${v.auto.maxReplies}` : ''} sent ·{' '}
                  {v.auto.until === null ? 'no time limit: it waits until you pause or stop it' : `ends at ${clock(v.auto.until)} (${Math.ceil(autoLeft / 60000)} min left)`}
                  {v.idleStopMinutes !== null ? ` · checks in once if they go quiet for ${v.idleStopMinutes} minutes, and stops if they stay quiet` : ''} · at least {v.auto.minGapSeconds}s apart
                </div>
                <p className="livechat-note">
                  {v.auto.holdBack
                    ? 'A reply that promises something or mentions figures or links stops automatic replies and comes to you.'
                    : 'Each reply goes out as the message comes in, so keep an eye on the chat. Eya never sends a password, a one-time code or a card or account number; if a reply would, automatic replies stop and it comes to you.'}
                </p>
                <button type="button" className="btn primary" disabled={busy} onClick={() => act({ kind: 'disable_auto' })}>
                  Turn automatic replies off
                </button>
              </>
            ) : (
              <>
                <p className="livechat-note">Off. You can let Eya reply by herself, as each message comes in, in THIS chat, for this run only, within limits you set.</p>
                {!autoOpen ? (
                  <button type="button" className="btn" disabled={busy || v.state === 'PAUSED' || v.state === 'WAITING_FOR_USER' || !v.sendAllowed || !v.verified} onClick={() => setAutoOpen(true)}>
                    Set up automatic replies…
                  </button>
                ) : (
                  <div className="livechat-autoform">
                    <label className="livechat-check">
                      <input type="checkbox" checked={aware} onChange={(e) => setAware(e.target.checked)} />
                      <span>
                        The other person knows and agrees that replies in this chat are written with AI assistance. (Eya never hides it, and never uses this to deceive anyone.)
                      </span>
                    </label>
                    <label className="livechat-check">
                      <input type="checkbox" checked={holdBack} onChange={(e) => setHoldBack(e.target.checked)} />
                      <span>Hold back for my approval any reply that promises something or mentions figures or links</span>
                    </label>
                    <div className="livechat-limits">
                      <label>
                        Most replies (empty: no limit)
                        <input className="ask-input" type="number" min={1} max={1000} placeholder="no limit" value={maxReplies} onChange={(e) => setMaxReplies(e.target.value)} />
                      </label>
                      <label>
                        Minutes (empty: until I pause it)
                        <input className="ask-input" type="number" min={1} max={1440} placeholder="no limit" value={maxMinutes} onChange={(e) => setMaxMinutes(e.target.value)} />
                      </label>
                      <label>
                        Seconds apart
                        <input className="ask-input" type="number" min={5} max={600} value={gap} onChange={(e) => setGap(Number(e.target.value))} />
                      </label>
                    </div>
                    <div className="livechat-controls">
                      <button
                        type="button"
                        className="btn primary"
                        disabled={busy || !aware}
                        onClick={() => {
                          act({ kind: 'enable_auto', confirmedAware: aware, ...limits(), ...(holdBack ? { holdBack: true } : {}) });
                          setAutoOpen(false);
                          setAware(false);
                        }}
                      >
                        Switch automatic replies on
                      </button>
                      <button type="button" className="btn" onClick={() => setAutoOpen(false)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>

          <section className="card livechat-card" aria-label="Recent messages">
            <h2>Recent messages</h2>
            {v.recent.length === 0 ? (
              <div className="empty">Nothing yet.</div>
            ) : (
              <ul className="livechat-messages">
                {v.recent.map((m) => (
                  <li key={m.id} className={`livechat-msg ${m.dir}`}>
                    <span className="livechat-who">{m.dir === 'in' ? 'Them' : 'Me'}</span>
                    <span className="livechat-text">{m.kind === 'text' || m.text !== '' ? m.text : `[${m.kind}]`}</span>
                    {m.dir === 'in' && !m.handled && <span className="plugin-tag send">new</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card livechat-card" aria-label="Suggested reply">
            <h2>Suggested reply</h2>
            {draft === null ? (
              <div className="empty">No reply is waiting. Eya writes one when a message needs it — or write your own below.</div>
            ) : (
              <div className="livechat-status">
                {DRAFT_WORD[draft.status]}
                {draft.by === 'eya' && ` · Eya is ${draft.confidence === 'high' ? 'confident' : draft.confidence === 'medium' ? 'fairly sure' : 'unsure'}${draft.commitment ? ' · this reply states or promises something for you' : ''}`}
                {draft.by === 'you' && ' · written by you'}
              </div>
            )}
            <textarea
              className="ask-input livechat-textarea"
              aria-label="The reply"
              rows={3}
              placeholder={draft === null ? 'Write your own reply…' : ''}
              value={text}
              disabled={busy || sending || (draft !== null && !canAct)}
              onChange={(e) => {
                setText(e.target.value);
                setEditing(true);
              }}
            />
            {draft?.note != null && <div className="livechat-note">{draft.note}</div>}
            <div className="livechat-controls">
              <button type="button" className="btn" disabled={busy || sending || text.trim() === '' || (draft !== null && !canAct) || (!editing && draft !== null)} onClick={() => act({ kind: 'edit_draft', text })}>
                Save edit
              </button>
              <button type="button" className="btn" disabled={busy || sending || !canAct || editing} onClick={() => act({ kind: 'approve' })}>
                <Icon name="check" size={16} /> {v.mode === 'draft' ? 'Approve: put in WhatsApp’s box' : 'Approve'}
              </button>
              <button
                type="button"
                className="btn primary"
                title={v.mode === 'draft' ? 'Draft mode never sends. Switch to Assisted mode to send from here.' : !v.sendAllowed ? 'Sending is switched off (plugin permission or Chats).' : ''}
                disabled={busy || sending || !canAct || editing || v.mode === 'draft' || !v.sendAllowed}
                onClick={() => act({ kind: 'send' })}
              >
                <Icon name="send" size={16} /> Send
              </button>
              <button type="button" className="btn" disabled={busy || sending || draft === null || draft.status === 'sent' || draft.status === 'sending'} onClick={() => act({ kind: 'discard' })}>
                <Icon name="trash" size={16} /> Discard
              </button>
              <button type="button" className="btn" disabled={busy || sending || v.state === 'PAUSED'} onClick={() => act({ kind: 'regenerate' })}>
                <Icon name="repeat" size={16} /> Write it again
              </button>
            </div>
            {editing && draft !== null && <div className="livechat-note">Save your edit first — then you can approve or send it. A reply you edit is yours, so it is never sent automatically.</div>}
          </section>
        </>
      )}
    </div>
  );
}
