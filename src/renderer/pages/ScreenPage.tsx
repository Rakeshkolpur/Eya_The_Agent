import React, { useState } from 'react';
import type { EyaControl } from '../control';
import { Icon } from '../ui/icons';
import { ShareConsent } from '../ui/ShareConsent';
import { Spinner } from '../ui/widgets';

/** Live Screen: share your screen with Eya, see what she sees, and ask her what it is or what to do. */
export function ScreenPage({ c }: { c: EyaControl }): React.ReactElement {
  const [question, setQuestion] = useState('');
  const { share, frame, screenAsk: ask } = c;
  const paused = share.paused;
  const working = ask.phase === 'working';
  const canAsk = share.active && paused === null && !working;

  const send = (): void => {
    const q = question.trim();
    if (q === '' || !canAsk) return;
    setQuestion('');
    c.askScreen({ mode: 'ask', question: q });
  };

  const statusPill = !share.active ? (
    <span className="share-pill off">Screen sharing off</span>
  ) : paused !== null ? (
    <span className="share-pill paused">Paused · {paused.app} is showing</span>
  ) : (
    <span className="share-pill on">
      <span className="status-dot live" />
      Screen Active
    </span>
  );

  return (
    <div className="screen-page">
      <div className="page-head">
        <h1>Live Screen</h1>
        <span className="mem-spacer" />
        {statusPill}
        {share.active && (
          <button type="button" className="btn danger" onClick={c.stopShare}>
            Stop sharing
          </button>
        )}
      </div>

      {!share.active ? (
        <div className="screen-off">
          <div className="card screen-off-card">
            <ShareConsent onStart={c.startShare} />
            {share.stopped !== undefined && share.stopped !== 'user' && share.message !== undefined && <div className="screen-stopped">{share.message}</div>}
          </div>
          <div className="card screen-off-side">
            <div className="card-head">
              <h2>What you can do</h2>
            </div>
            <ul className="side-steps">
              <li>
                <Icon name="check" size={15} /> Ask “what is on my screen?” or “explain this”.
              </li>
              <li>
                <Icon name="check" size={15} /> Ask “what should I do next?” or “how do I do this?”.
              </li>
              <li>
                <Icon name="check" size={15} /> Press the mic and just talk: she sees the same screen while you speak.
              </li>
              <li>
                <Icon name="check" size={15} /> Capture saves a picture on your Desktop.
              </li>
            </ul>
          </div>
        </div>
      ) : (
        <div className="screen-body">
          <section className="screen-main">
            <div className={`screen-view ${paused !== null ? 'paused' : ''}`}>
              {paused !== null ? (
                <div className="screen-pause">
                  <Icon name="lock" size={30} />
                  <div className="screen-pause-title">Paused</div>
                  <div>
                    {paused.app} is open and Chats are OFF for it, so I am not looking at the screen. It carries on by itself when it is closed.
                  </div>
                </div>
              ) : frame !== null ? (
                <img className="screen-img" src={`data:image/jpeg;base64,${frame.jpeg}`} alt="What Eya can see on your screen" />
              ) : (
                <div className="screen-wait">Waiting for the first picture…</div>
              )}
            </div>
            <div className="ask-bar">
              <input
                className="ask-input"
                value={question}
                placeholder="Ask about this screen…"
                spellCheck={false}
                disabled={!canAsk && !working}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') send();
                }}
              />
              <button type="button" className={`ask-mic ${c.talk !== 'off' ? 'on' : ''}`} onClick={c.toggleTalk} disabled={c.talk === 'off' && !c.voiceOn} title={c.talk === 'off' ? 'Talk to Eya about this screen' : 'End the conversation'} aria-label="Talk to Eya about this screen">
                <Icon name="mic" size={18} />
              </button>
              <button type="button" className="ask-send" onClick={send} disabled={!canAsk} title="Ask" aria-label="Ask">
                <Icon name="send" size={17} />
              </button>
            </div>
            <div className="screen-actions">
              <button type="button" className="btn" disabled={!canAsk} onClick={() => c.askScreen({ mode: 'analyze' })}>
                <Icon name="screen" size={15} /> Analyze
              </button>
              <button type="button" className="btn" disabled={!canAsk} onClick={() => c.askScreen({ mode: 'explain' })}>
                <Icon name="info" size={15} /> Explain
              </button>
              <button type="button" className="btn" disabled={!canAsk} onClick={() => c.askScreen({ mode: 'next' })}>
                <Icon name="bolt" size={15} /> What next?
              </button>
              <button type="button" className="btn" disabled title="Letting Eya click for you comes later">
                Control <span className="soon-tag">Soon</span>
              </button>
              <button type="button" className="btn" disabled={paused !== null} onClick={c.captureScreen} title="Save a picture of the screen on your Desktop">
                <Icon name="file" size={15} /> Capture
              </button>
            </div>
            {ask.note !== '' && <div className="screen-note">{ask.note}</div>}
          </section>

          <aside className="card screen-side">
            <div className="card-head">
              <h2>{working ? 'Eya is working…' : ask.phase === 'done' ? 'Eya says' : 'Eya can see your screen'}</h2>
            </div>
            {ask.phase === 'idle' && (
              <div className="side-text">
                Ask a question below the picture, press a button, or press the mic and talk. {c.talk === 'on' ? 'Live conversation is on: she sees this screen while you speak.' : ''}
              </div>
            )}
            {ask.phase !== 'idle' && (
              <ul className="side-steps">
                <li className="done">
                  <Icon name="check" size={15} /> Asked: <em>{ask.question}</em>
                </li>
                {working ? (
                  <li className="running">
                    <Spinner /> Looking at your screen and reading it…
                  </li>
                ) : ask.phase === 'done' ? (
                  <>
                    <li className="done">
                      <Icon name="check" size={15} /> Looked at your screen
                    </li>
                    <li className="done">
                      <Icon name="check" size={15} /> Worked out an answer
                    </li>
                  </>
                ) : (
                  <li className="failed">
                    <Icon name="close" size={15} /> It did not work
                  </li>
                )}
              </ul>
            )}
            {ask.phase === 'done' && (
              <div className="screen-answer">
                {ask.answer}
                <button type="button" className="btn small" onClick={c.speakAnswer}>
                  Read it aloud
                </button>
              </div>
            )}
            {ask.phase === 'error' && <div className="screen-error">{ask.error}</div>}
            <div className="side-foot">Pictures are only used to answer you and are never saved.</div>
          </aside>
        </div>
      )}
    </div>
  );
}
