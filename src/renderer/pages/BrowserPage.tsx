import React, { useEffect, useRef, useState } from 'react';
import type { BrowserKind, BrowserPanelAction, BrowserViewBounds, PanelStatus } from '../../shared/browserPanel';
import type { AppPage, EyaControl } from '../control';
import { ChatWorkspace } from '../ui/ChatWorkspace';
import { Icon } from '../ui/icons';
import { useLayout } from '../ui/layout';
import { getAutoSplit, setAutoSplit } from '../ui/prefs';
import { Toggle } from '../ui/widgets';

const STATUS_TONE: Record<PanelStatus, string> = {
  idle: '',
  working: 'busy',
  waiting_you: 'warn',
  paused: 'warn',
  taken_over: 'warn',
  stopped: 'bad',
  done: 'ok',
  problem: 'bad',
};

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 5 ? 'now' : s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

/**
 * The room for Eya Browser. The browser itself is drawn by the app on top of this rectangle (it is a real Chromium view, not a picture), so all this
 * does is say where the rectangle is, whenever it moves or changes size, and say "not here" when the page goes away.
 */
function ViewArea({ show, report }: { show: boolean; report: (bounds: BrowserViewBounds | null) => void }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!show || el === null) {
      report(null);
      return undefined;
    }
    let last = '';
    const send = (): void => {
      const r = el.getBoundingClientRect();
      const b = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      const key = `${b.x},${b.y},${b.width},${b.height}`;
      if (key === last) return;
      last = key;
      report(b.width > 0 && b.height > 0 ? b : null);
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    window.addEventListener('resize', send);
    // (a banner appearing above moves the area without resizing it, which no observer reports)
    const t = window.setInterval(send, 250);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', send);
      window.clearInterval(t);
      report(null);
    };
  }, [show, report]);
  return <div ref={ref} className="bp-surface" />;
}

/**
 * The workspace: Eya on the left (the task, its steps, what holds it up, what she says, and a box to tell her more) and her browser on the right,
 * doing the work where you can see it — the way a task is watched in Manus or Gemini's agent. Every control the Browser page had is here.
 */
export function BrowserPage({ c, go }: { c: EyaControl; go?: (page: AppPage) => void }): React.ReactElement {
  const p = c.browserPanel;
  const { setBrowserView } = c;
  const [address, setAddress] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [leftOpen, setLeftOpen] = useState(true);
  const [details, setDetails] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [auto, setAuto] = useState(() => getAutoSplit());
  const editing = useRef(false);
  const { setSideAuto } = useLayout();
  useEffect(() => {
    setSideAuto(true);
    return () => setSideAuto(false);
  }, [setSideAuto]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);
  // The address bar follows the page, unless the user is typing in it.
  const url = p?.url ?? '';
  useEffect(() => {
    if (!editing.current) setAddress(url);
  }, [url]);

  const act = (action: BrowserPanelAction): void => {
    setBusy(true);
    setNote(null);
    void c
      .browserAct(action)
      .then((r) => {
        if (r.message !== '') setNote(r.message);
      })
      .catch(() => setNote("That didn't work. Try again."))
      .finally(() => setBusy(false));
  };

  const where = p?.where ?? null;
  const mine = where === 'mine';
  const badge = where === null ? 'Eya Browser' : mine ? `My Browser · ${p?.browserName ?? 'your browser'}` : 'Eya Browser';
  const status = p?.status ?? 'idle';
  const working = status === 'working' || status === 'waiting_you' || p?.paused === true || p?.takenOver === true;
  const pref: BrowserKind = p?.preference ?? 'eya';
  const myConnected = (p?.myBrowsers.length ?? 0) > 0;
  const steps = p?.steps ?? [];

  return (
    <div className={`workspace ${leftOpen ? '' : 'left-closed'}`}>
      {leftOpen && (
        <aside className="ws-left" aria-label="Eya">
          <ChatWorkspace
            c={c}
            className="in-ws"
            header={
              <div className="ws-top">
                <div className="ws-head">
                  <span className="ws-orb" data-state={c.state}>
                    <span className="eye left" />
                    <span className="eye right" />
                  </span>
                  <div className="ws-title">
                    <div className="ws-name">Eya</div>
                    <div className="ws-sub">{c.statusText}</div>
                  </div>
                  <span className={`pill bp-status ${STATUS_TONE[status]}`}>{p?.loading === true && status === 'working' ? 'Loading…' : (p?.statusText ?? 'Ready')}</span>
                  <button type="button" className="icon-btn round" onClick={() => setLeftOpen(false)} title="Hide the chat to give the browser the whole window" aria-label="Hide the chat">
                    <Icon name="panel" size={16} />
                  </button>
                </div>

                <div className="ws-controls">
                  {p?.paused === true ? (
                    <button type="button" className="btn small primary" disabled={busy} onClick={() => act({ type: 'resume' })}>
                      <Icon name="play" size={13} /> Resume
                    </button>
                  ) : (
                    <button type="button" className="btn small" disabled={busy || p?.takenOver === true} title="Eya waits before her next step until you press Resume" onClick={() => act({ type: 'pause' })}>
                      <Icon name="pause" size={13} /> Pause
                    </button>
                  )}
                  <button type="button" className="btn small danger" disabled={busy} title="Stop the task: Eya takes no more steps until you ask for something new" onClick={() => act({ type: 'stop' })}>
                    <Icon name="stop" size={13} /> Stop
                  </button>
                  {p?.takenOver === true ? (
                    <button type="button" className="btn small primary" disabled={busy} onClick={() => act({ type: 'hand_back' })}>
                      <Icon name="hand" size={13} /> Hand back to Eya
                    </button>
                  ) : (
                    <button type="button" className="btn small" disabled={busy || mine} title={mine ? 'It is your own browser: just use it, then tell Eya to carry on.' : 'Pause Eya so you can click and type in the browser yourself.'} onClick={() => act({ type: 'take_over' })}>
                      <Icon name="hand" size={13} /> Take over
                    </button>
                  )}
                </div>

                {p?.goal !== undefined && p.goal !== '' && (
                  <div className="ws-task">
                    <div className="ws-task-goal" title={p.goal}>
                      {p.goal}
                    </div>
                    {p.current !== undefined && p.current !== '' && working && (
                      <div className="ws-now">
                        <span className="tl-dot live" /> {p.current}
                      </div>
                    )}
                  </div>
                )}

                {(p?.blockers.length ?? 0) > 0 && (
                  <div className="ws-blockers">
                    <div className="ws-label">Waiting on you</div>
                    {p?.blockers.map((bl) => (
                      <p key={bl}>{bl}</p>
                    ))}
                    <p className="bp-hint">Do it in the browser, or tell Eya what to click. She carries on from this very page.</p>
                  </div>
                )}

                <button type="button" className="link ws-steps-toggle" onClick={() => setStepsOpen((o) => !o)} aria-expanded={stepsOpen}>
                  {stepsOpen ? 'Hide the steps' : `Show the steps (${steps.length})`}
                </button>
                {stepsOpen && (
                  <div className="ws-steps-box scroll">
                    {steps.length === 0 ? (
                      <p className="bp-dim">No steps yet.</p>
                    ) : (
                      <ol className="tl-steps ws-steps">
                        {steps.slice(-14).map((s, i) => (
                          <li key={`${s.at}-${i}`} className={s.ok ? 'done' : 'bad'}>
                            <span className="tl-dot">
                              <Icon name={s.ok ? 'check' : 'close'} size={11} />
                            </span>
                            <span className="tl-text">{s.text}</span>
                            <span className="tl-ago">{ago(s.at, now)}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                    <button type="button" className="link ws-details-btn" onClick={() => setDetails((d) => !d)}>
                      {details ? 'Hide activity' : 'Show activity'}
                    </button>
                    {details && (
                      <ul className="bp-log">
                        {(p?.log ?? [])
                          .slice(-30)
                          .reverse()
                          .map((l, i) => (
                            <li key={`${l.at}-${i}`} className={l.kind}>
                              <span className="bp-ago">{ago(l.at, now)}</span> {l.text}
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            }
            empty={() => (
              <div className="chat-empty">
                <div className="chat-empty-title">Tell Eya what to do</div>
                <div>Type below, or say it, and watch her do it on the right.</div>
              </div>
            )}
          />
        </aside>
      )}

      <section className="ws-right">
        <div className="ws-chrome">
          {!leftOpen && (
            <button type="button" className="btn small" onClick={() => setLeftOpen(true)} title="Show Eya's panel">
              <Icon name="panel" size={14} /> Eya
            </button>
          )}
          <span className={`pill bp-mode ${mine ? 'mine' : 'eya'}`} title={mine ? 'Eya is working in your own browser, in the tab it opened. Nothing else of yours is touched.' : "Eya's own browser, built into Eya: its own sign-ins, kept between tasks."}>
            <Icon name={mine ? 'user' : 'globe'} size={13} /> {badge}
          </span>
          {(p?.tabs.length ?? 0) > 1 && !mine && (
            <div className="bp-tabs" role="tablist">
              {p?.tabs.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={t.active} className={`bp-tab ${t.active ? 'on' : ''}`} title={t.url} onClick={() => act({ type: 'focus_tab', id: t.id })}>
                  {t.title === '' ? t.url.replace(/^https?:\/\//, '').slice(0, 24) : t.title.slice(0, 24)}
                </button>
              ))}
            </div>
          )}
          <span className="sec-spacer" />
          <button type="button" className="btn small" disabled={busy || url === ''} onClick={() => act({ type: 'open_in_my_browser' })} title="Open this page in your normal browser">
            <Icon name="external" size={13} /> Open in my browser
          </button>
          {go !== undefined && (
            <button type="button" className="icon-btn round" onClick={() => go('home')} title="Back to Home" aria-label="Back to Home">
              <Icon name="close" size={16} />
            </button>
          )}
        </div>

        <form
          className="bp-bar"
          onSubmit={(e) => {
            e.preventDefault();
            editing.current = false;
            act({ type: 'navigate', url: address });
          }}
        >
          <button type="button" className="icon-btn round" aria-label="Back" title="Back" disabled={busy || mine} onClick={() => act({ type: 'back' })}>
            <Icon name="back" size={16} />
          </button>
          <button type="button" className="icon-btn round" aria-label="Forward" title="Forward" disabled={busy || mine} onClick={() => act({ type: 'forward' })}>
            <Icon name="forward" size={16} />
          </button>
          {p?.loading === true ? (
            <button type="button" className="icon-btn round" aria-label="Stop loading" title="Stop loading" disabled={mine} onClick={() => act({ type: 'stop_loading' })}>
              <Icon name="close" size={16} />
            </button>
          ) : (
            <button type="button" className="icon-btn round" aria-label="Reload" title="Reload" disabled={busy || mine} onClick={() => act({ type: 'reload' })}>
              <Icon name="reload" size={16} />
            </button>
          )}
          <input
            className="bp-address"
            aria-label="Address"
            spellCheck={false}
            autoComplete="off"
            value={address}
            placeholder="Type a web address, then press Enter"
            disabled={mine}
            onFocus={() => (editing.current = true)}
            onBlur={() => (editing.current = false)}
            onChange={(e) => setAddress(e.target.value)}
          />
          <button type="submit" className="btn small primary" disabled={busy || mine || address.trim() === ''}>
            Go
          </button>
          <button type="button" className="icon-btn round" aria-label="New tab" title="New tab" disabled={busy || mine} onClick={() => act({ type: 'new_tab' })}>
            <Icon name="plus" size={16} />
          </button>
        </form>

        {p?.error != null && (
          <div className="bp-error" role="alert">
            <Icon name="info" size={15} />
            <span>{p.error}</span>
          </div>
        )}
        {p?.needsMyBrowser === true && (
          <div className="bp-error" role="alert">
            <Icon name="user" size={15} />
            <span>This needs your own browser (for a sign-in that is only there). </span>
            <button type="button" className="btn small primary" disabled={busy} onClick={() => act({ type: 'connect_my_browser' })}>
              Connect My Browser
            </button>
          </div>
        )}

        <div className="ws-view">
          {mine ? (
            <div className="bp-empty">
              <Icon name="user" size={34} />
              <p>
                Working in your own {p?.browserName ?? 'browser'}, in the tab Eya opened. Watch it there. {p?.title !== '' ? `Now on: ${p?.title}` : ''}
              </p>
            </div>
          ) : (
            <>
              {p?.url === '' && (
                <div className="bp-empty">
                  <Icon name="globe" size={34} />
                  <p>Eya Browser is Eya's own browser, built into Eya. It opens here when a task needs a website, or type an address above.</p>
                </div>
              )}
              <ViewArea show={!mine} report={setBrowserView} />
            </>
          )}
        </div>

        <div className="bp-foot">
          {note !== null && <span className="bp-note">{note}</span>}
          <span className="sec-spacer" />
          <label className="bp-pref" title="When Eya starts working on a website, open this screen by itself">
            Open beside Eya automatically
            <Toggle
              on={auto}
              label="Open the browser beside Eya automatically"
              onChange={(on) => {
                setAuto(on);
                setAutoSplit(on);
              }}
            />
          </label>
          {myConnected ? (
            <button type="button" className="btn small" disabled={busy} onClick={() => act({ type: 'disconnect_my_browser' })} title="Eya stops using your own browser until you connect it again">
              Disconnect My Browser ({p?.myBrowsers.join(', ')})
            </button>
          ) : (
            <button type="button" className="btn small" disabled={busy} onClick={() => act({ type: 'connect_my_browser' })} title="Link your own Chrome or Edge, for when a task needs a sign-in that is only there">
              Connect My Browser
            </button>
          )}
          <label className="bp-pref">
            Use{' '}
            <select aria-label="Browser Eya uses" value={pref} onChange={(e) => c.changeSettings({ browser: e.target.value === 'mine' ? 'mine' : 'eya' })}>
              <option value="eya">Eya Browser (default)</option>
              <option value="mine">My Browser</option>
            </select>
          </label>
        </div>
      </section>
    </div>
  );
}
