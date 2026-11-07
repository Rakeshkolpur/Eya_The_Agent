import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityItemView, ActivityKind, FileEntryView } from '../../shared/ipcContract';
import type { TaskView } from '../../shared/tasks';
import type { GeminiKeyEntry, GeminiKeyState } from '../../shared/geminiKeys';
import type { AppPage, EyaControl } from '../control';
import { Icon } from '../ui/icons';
import type { IconName } from '../ui/icons';
import { formatSize, timeAgo } from '../ui/format';
import { greetingFor } from '../ui/prefs';
import { useLayout } from '../ui/layout';
import { ChatWorkspace } from '../ui/ChatWorkspace';
import { HiddenNote, Section } from '../ui/sections';
import { BigOrb, KindIcon } from '../ui/widgets';

interface AppTile {
  readonly name: string;
  readonly url: string;
  readonly glyph: string;
  readonly color: string;
}

/** The sites most people ask for. Each opens in Eya Browser, on the screen beside Eya. (Plain coloured tiles: no logos are borrowed.) */
const APPS: readonly AppTile[] = [
  { name: 'WhatsApp', url: 'https://web.whatsapp.com/', glyph: 'W', color: '#25d366' },
  { name: 'Telegram', url: 'https://web.telegram.org/', glyph: 'T', color: '#2aa3e0' },
  { name: 'Instagram', url: 'https://www.instagram.com/', glyph: 'I', color: '#e1306c' },
  { name: 'YouTube', url: 'https://www.youtube.com/', glyph: 'Y', color: '#ff0033' },
  { name: 'Gmail', url: 'https://mail.google.com/', glyph: 'M', color: '#ea4335' },
  { name: 'Google Drive', url: 'https://drive.google.com/', glyph: 'D', color: '#1ea362' },
  { name: 'Google Calendar', url: 'https://calendar.google.com/', glyph: '31', color: '#4285f4' },
  { name: 'LinkedIn', url: 'https://www.linkedin.com/', glyph: 'in', color: '#0a66c2' },
];

const KIND_PILL: Record<ActivityKind, string> = { action: 'Action', file: 'File Management', web: 'Web', chat: 'Communication' };

const OPEN: ReadonlySet<TaskView['state']> = new Set(['running', 'waiting', 'needs_you']);
const TASK_LABEL: Record<TaskView['state'], string> = {
  running: 'Working on it',
  waiting: 'Waiting to try again',
  needs_you: 'Needs you',
  done: 'Done',
  failed: "Couldn't finish",
  cancelled: 'Stopped',
};

const ago = (at: number): string => timeAgo(new Date(at).toISOString());

/** The five shortcuts that used to be a row of cards: now a few quiet suggestions in the empty conversation. */
const SUGGESTIONS: ReadonlyArray<{ readonly label: string; readonly start?: string; readonly page?: AppPage }> = [
  { label: 'Research & summarize a topic', start: 'Research and summarize ' },
  { label: 'Create a document', start: 'Create a document about ' },
  { label: 'Open a website', start: 'Open ' },
  { label: 'Send a message', start: 'Send a message to ' },
  { label: 'Find a file', page: 'files' },
  { label: 'Teach Eya a routine', page: 'memory' },
];

/**
 * Home: the conversation with Eya is the workspace (messages, the files you attach, the AI list and the microphone in one box). When the app opens
 * that is all there is besides the sidebar. While a task works, a panel opens on the right with what she is doing (the person can close it); the
 * other cards are off until they are switched on in the Layout menu.
 */
export function HomePage({ c, go, onAddKey }: { c: EyaControl; go: (page: AppPage) => void; onAddKey: () => void }): React.ReactElement {
  const layout = useLayout();
  const last = useLastRun(c);
  const name = c.settings?.info.userName ?? '';
  const openApp = (a: AppTile): void => {
    go('browser');
    void c.browserAct({ type: 'navigate', url: a.url });
  };
  const empty = (fill: (text: string) => void): React.ReactNode => (
    <div className="cw-empty">
      <BigOrb state={c.state} size={56} />
      <h1>
        {greetingFor()}
        {name !== '' ? `, ${name}` : ''}
      </h1>
      <p>Ask me anything, give me a task, or attach a file and ask about it.</p>
      {c.geminiKey?.source === 'none' && (
        <div className="home-key">
          <span>Everyday requests work on this PC without a key. Add your free Gemini key to chat, read files and your screen, and talk live.</span>
          <button type="button" className="btn small primary" onClick={onAddKey}>
            Add your Gemini key
          </button>
        </div>
      )}
      <div className="cw-suggest">
        {SUGGESTIONS.map((s) => (
          <button key={s.label} type="button" className="suggest small" onClick={() => {
              if (s.page !== undefined) go(s.page);
              else {
                // (these start a job: Agent mode goes on with them)
                c.setAgentMode(true);
                fill(s.start ?? '');
              }
            }}>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className={`dash2 ${layout.panel.shown ? '' : 'no-right'}`}>
      <div className="dash-left">
        <ChatWorkspace c={c} empty={empty} />
        <Section id="recentTasks" title="Recent Tasks" className="recent-tasks" actions={<LiveBadge c={c} />}>
          <RecentTasks c={c} go={go} />
        </Section>
      </div>

      {layout.panel.shown && (
        <aside className="dash-side scroll" aria-label="What Eya is doing">
          <HiddenNote ids={['agentTimeline', 'agentList']} />
          <Section id="agentTimeline" title="Your Agent at Work" className="side-card timeline" actions={<LiveBadge c={c} />}>
            <Timeline c={c} go={go} last={last} />
          </Section>
          <Section id="agentList" title="Tasks in progress" className="side-card">
            <TaskList c={c} />
          </Section>
          <Section id="aiKeys" title="Gemini keys" className="side-card" actions={<button type="button" className="link" onClick={onAddKey}>Manage</button>}>
            <AiKeys c={c} onManage={onAddKey} />
          </Section>
          <Section id="popularApps" title="Popular Apps" className="side-card" actions={<button type="button" className="link" onClick={() => go('settings')}>Manage</button>}>
            <div className="app-grid">
              {APPS.map((a) => (
                <button key={a.name} type="button" className="app-tile" onClick={() => openApp(a)} title={`Open ${a.name} in Eya Browser`}>
                  <span className="app-logo" style={{ background: a.color }}>
                    {a.glyph}
                  </span>
                  <span className="app-name">{a.name}</span>
                </button>
              ))}
            </div>
          </Section>
          <Section id="recentFiles" title="Recent Files" className="side-card" actions={<button type="button" className="link" onClick={() => go('files')}>View all →</button>}>
            <RecentFiles go={go} />
          </Section>
          <Section id="todayActivity" title="Today's Activity" className="side-card">
            <Today items={c.activity?.items ?? []} />
          </Section>
        </aside>
      )}
    </div>
  );
}

const KEY_STATE: Record<GeminiKeyState, string> = { ready: 'Ready', 'used-up': "Today's allowance used", busy: 'Busy for a moment', refused: 'Refused by Google' };

/** The Gemini keys, one after another: which one is answering, which are used up for the day, and the way to add more. */
function AiKeys({ c, onManage }: { c: EyaControl; onManage: () => void }): React.ReactElement {
  const entries: readonly GeminiKeyEntry[] = c.geminiKeys?.entries ?? [];
  if (entries.length === 0) {
    return (
      <div className="keys-empty">
        <p>No Gemini key yet. Add your own, and keys from family or friends (each from their own free Google account): Eya uses one until its free allowance for the day is spent, then the next.</p>
        <button type="button" className="btn small primary" onClick={onManage}>
          <Icon name="plus" size={13} /> Add keys
        </button>
      </div>
    );
  }
  return (
    <>
      <ul className="key-list">
        {entries.map((k) => (
          <li key={k.id} className={`key-item ${k.state} ${k.inUse ? 'use' : ''}`}>
            <span className="key-dot" aria-hidden="true" />
            <div className="mini-text">
              <div className="mini-title">
                {k.name}
                {k.inUse && <span className="key-using">answering now</span>}
              </div>
              <div className="mini-sub">
                {KEY_STATE[k.state]}
                {k.requests > 0 ? ` · ${k.requests} today` : ''}
                {k.hint !== '' ? ` · ${k.hint}` : ''}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <p className="keys-note">Used one after another: when one runs out for the day, the next takes over by itself.</p>
      <button type="button" className="btn small full" onClick={onManage}>
        <Icon name="plus" size={13} /> Add or manage keys
      </button>
    </>
  );
}

/** What Eya last finished (the words asked and the answer), kept so the panel can say how it ended once she stops. */
interface LastRun {
  readonly goal: string;
  readonly result: string;
  readonly at: number;
}

/** Notes the task that has just ended: it began with the tools working, and ended with her answer in the conversation. */
function useLastRun(c: EyaControl): LastRun | null {
  const [last, setLast] = useState<LastRun | null>(null);
  const worked = useRef(false);
  const lastMessage = c.thread[c.thread.length - 1];
  useEffect(() => {
    if (c.agent.working) {
      worked.current = true;
      return;
    }
    if (!worked.current || lastMessage === undefined || lastMessage.role !== 'eya') return;
    worked.current = false;
    const asked = [...c.thread].reverse().find((m) => m.role === 'user');
    setLast({ goal: asked?.text ?? '', result: lastMessage.text, at: Date.now() });
  }, [c.agent.working, c.thread, lastMessage]);
  return last;
}

/** "Live" while anything is being worked on. */
function LiveBadge({ c }: { c: EyaControl }): React.ReactElement | null {
  const p = c.browserPanel;
  const browserBusy = p !== null && (p.status === 'working' || p.status === 'waiting_you' || p.paused || p.takenOver);
  const taskBusy = (c.tasks?.items ?? []).some((t) => OPEN.has(t.state));
  if (!browserBusy && !taskBusy) return null;
  return (
    <span className="live-badge">
      <span className="status-dot live" />
      Live
    </span>
  );
}

/** The task the browser is working on right now, step by step. */
function Timeline({ c, go, last }: { c: EyaControl; go: (page: AppPage) => void; last: LastRun | null }): React.ReactElement {
  const p = c.browserPanel;
  const busy = p !== null && (p.status === 'working' || p.status === 'waiting_you' || p.paused || p.takenOver);
  const hasTask = p !== null && p.where === 'eya' && p.goal !== '' && (busy || p.steps.length > 0);
  const openTasks = (c.tasks?.items ?? []).filter((t) => OPEN.has(t.state));
  if (hasTask) {
    const steps = p.steps.slice(-8);
    return (
      <div className="tl">
        <div className="tl-goal" title={p.goal}>
          {p.goal}
        </div>
        <ol className="tl-steps">
          {steps.map((s, i) => (
            <li key={`${s.at}-${i}`} className={s.ok ? 'done' : 'bad'}>
              <span className="tl-dot">
                <Icon name={s.ok ? 'check' : 'close'} size={11} />
              </span>
              <span className="tl-text">{s.text}</span>
              <span className="tl-ago">{ago(s.at)}</span>
            </li>
          ))}
          {busy && p.current !== '' && (
            <li className="now">
              <span className="tl-dot live" />
              <span className="tl-text">{p.current}</span>
            </li>
          )}
          {!busy && (
            <li className={p.status === 'done' ? 'done' : 'bad'}>
              <span className="tl-dot">
                <Icon name={p.status === 'done' ? 'check' : 'info'} size={11} />
              </span>
              <span className="tl-text">{p.statusText}</span>
            </li>
          )}
        </ol>
        {p.blockers.length > 0 && <div className="tl-block">{p.blockers[0]}</div>}
        <div className="tl-actions">
          <button type="button" className="btn small primary" onClick={() => go('browser')}>
            <Icon name="split" size={14} /> Open workspace
          </button>
          {busy && (
            <button type="button" className="btn small" onClick={() => { c.stopAll(); void c.browserAct({ type: 'stop' }); }}>
              <Icon name="stop" size={13} /> Stop
            </button>
          )}
        </div>
      </div>
    );
  }
  const asked = [...c.thread].reverse().find((m) => m.role === 'user');
  if (c.agent.working && asked !== undefined) {
    return (
      <div className="tl">
        <div className="tl-goal" title={asked.text}>
          {asked.text}
        </div>
        <ol className="tl-steps">
          <li className="now">
            <span className="tl-dot live" />
            <span className="tl-text">{c.agent.message !== '' ? c.agent.message : 'Working on it…'}</span>
          </li>
        </ol>
      </div>
    );
  }
  if (openTasks.length > 0) {
    return (
      <div className="tl">
        <ol className="tl-steps">
          {openTasks.slice(0, 4).map((t) => (
            <li key={t.id} className="now">
              <span className="tl-dot live" />
              <span className="tl-text">{t.request}</span>
            </li>
          ))}
        </ol>
        <div className="tl-actions">
          <button type="button" className="btn small" onClick={() => { c.stopAll(); c.actOnTasks({ kind: 'cancel_all' }); }}>
            <Icon name="stop" size={13} /> Stop
          </button>
        </div>
      </div>
    );
  }
  if (last !== null) {
    return (
      <div className="tl">
        <div className="tl-goal" title={last.goal}>
          {last.goal}
        </div>
        <ol className="tl-steps">
          <li className="done">
            <span className="tl-dot">
              <Icon name="check" size={11} />
            </span>
            <span className="tl-text">{last.result.length > 220 ? `${last.result.slice(0, 219)}…` : last.result}</span>
            <span className="tl-ago">{ago(last.at)}</span>
          </li>
        </ol>
      </div>
    );
  }
  return (
    <div className="tl-empty">
      <Icon name="agents" size={22} />
      <p>Nothing is running. Ask Eya to do something and you can watch each step here — and her browser opens beside her when she works on a website.</p>
    </div>
  );
}

function TaskList({ c }: { c: EyaControl }): React.ReactElement {
  const items = c.tasks?.items ?? [];
  const open = items.filter((t) => OPEN.has(t.state));
  const shown = [...open, ...items.filter((t) => !OPEN.has(t.state)).slice(0, 3)].slice(0, 5);
  const asked = [...c.thread].reverse().find((m) => m.role === 'user');
  const now = c.agent.working && open.length === 0 && asked !== undefined ? asked.text : null;
  if (shown.length === 0 && now === null) return <div className="empty">Nothing in progress. What Eya is working on shows here.</div>;
  return (
    <>
      <ul className="mini-list">
        {now !== null && (
          <li>
            <span className="task-dot running" aria-hidden="true" />
            <div className="mini-text">
              <div className="mini-title" title={now}>
                {now}
              </div>
              <div className="mini-sub">Working on it{c.agent.message !== '' ? ` — ${c.agent.message}` : ''}</div>
            </div>
          </li>
        )}
        {shown.map((t) => (
          <li key={t.id}>
            <span className={`task-dot ${t.state}`} aria-hidden="true" />
            <div className="mini-text">
              <div className="mini-title" title={t.request}>
                {t.request}
              </div>
              <div className="mini-sub">
                {TASK_LABEL[t.state]}
                {t.note !== '' ? ` — ${t.note}` : ''}
              </div>
            </div>
            <span className="mini-ago">{ago(t.updatedAt)}</span>
          </li>
        ))}
      </ul>
      {open.length > 0 && (
        <button type="button" className="btn small full" onClick={() => { c.stopAll(); c.actOnTasks({ kind: 'cancel_all' }); }}>
          <Icon name="stop" size={13} /> Stop
        </button>
      )}
    </>
  );
}

/** The latest two tasks; "View all tasks" opens the rest right here (and "Show fewer" folds it back), with a way to the Tasks page. */
function RecentTasks({ c, go }: { c: EyaControl; go: (page: AppPage) => void }): React.ReactElement {
  const [all, setAll] = useState(false);
  const every: readonly ActivityItemView[] = c.activity?.items ?? [];
  const items = all ? every.slice(0, 30) : every.slice(0, 2);
  if (every.length === 0) {
    return <div className="empty">{c.activity?.enabled === false ? 'History is off. You can turn it on in Settings → Privacy.' : 'Nothing yet. Ask Eya to do something and it shows up here.'}</div>;
  }
  return (
    <>
      <ul className={`task-rows ${all ? 'all' : ''}`}>
        {items.map((a) => (
          <li key={a.id} className="task-row">
            <KindIcon kind={a.kind} ok={a.ok} />
            <div className="task-row-text">
              <div className="task-row-title">
                {a.title}
                <span className={`pill-kind k-${a.kind}`}>{KIND_PILL[a.kind]}</span>
              </div>
              <div className={`task-row-detail ${a.ok ? '' : 'failed'}`}>{a.detail}</div>
            </div>
            <span className={`state-pill ${a.ok ? 'ok' : 'bad'}`}>{a.ok ? 'Completed' : 'Did not finish'}</span>
            <span className="task-row-ago">{timeAgo(a.at)}</span>
            {a.canRepeat && (
              <button type="button" className="icon-btn round" onClick={() => void c.submit(a.request, undefined, { agent: true })} title="Do it again" aria-label="Do it again">
                <Icon name="repeat" size={15} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {every.length > 2 && (
        <div className="task-more">
          <button type="button" className="link" onClick={() => setAll((x) => !x)} aria-expanded={all}>
            {all ? 'Show fewer' : `View all tasks (${every.length})`}
          </button>
          {all && (
            <button type="button" className="link" onClick={() => go('recent')}>
              Open the Tasks page →
            </button>
          )}
        </div>
      )}
    </>
  );
}

function RecentFiles({ go }: { go: (page: AppPage) => void }): React.ReactElement {
  const [files, setFiles] = useState<readonly FileEntryView[] | null>(null);
  useEffect(() => {
    let alive = true;
    void window.eya
      .listFiles('recent')
      .then((l) => {
        if (alive) setFiles(l.items.filter((f) => f.kind !== 'folder').slice(0, 5));
      })
      .catch(() => {
        if (alive) setFiles([]);
      });
    return () => {
      alive = false;
    };
  }, []);
  if (files === null) return <div className="empty">Looking…</div>;
  if (files.length === 0) {
    return (
      <div className="empty">
        Nothing to show yet.{' '}
        <button type="button" className="link" onClick={() => go('files')}>
          Open Files
        </button>
      </div>
    );
  }
  return (
    <ul className="mini-list files">
      {files.map((f) => (
        <li key={f.path}>
          <button type="button" className="mini-file" onClick={() => void window.eya.openFileItem(f.path)} title={`Open ${f.name}`}>
            <span className={`mini-ext e-${f.ext}`}>{f.ext.slice(0, 4).toUpperCase() || 'FILE'}</span>
            <span className="mini-text">
              <span className="mini-title">{f.name}</span>
              <span className="mini-sub">
                {formatSize(f.size)} · {timeAgo(f.modified)}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** How many things Eya finished today, compared with yesterday, and when. */
function Today({ items }: { items: readonly ActivityItemView[] }): React.ReactElement {
  const stats = useMemo(() => {
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startYesterday = startToday - 86_400_000;
    let today = 0;
    let yesterday = 0;
    const bars = new Array<number>(12).fill(0);
    for (const a of items) {
      if (!a.ok) continue;
      const at = Date.parse(a.at);
      if (!Number.isFinite(at)) continue;
      if (at >= startToday) {
        today += 1;
        const hoursAgo = Math.floor((now.getTime() - at) / 3_600_000);
        if (hoursAgo >= 0 && hoursAgo < 12) bars[11 - hoursAgo] = (bars[11 - hoursAgo] ?? 0) + 1;
      } else if (at >= startYesterday) yesterday += 1;
    }
    return { today, yesterday, bars };
  }, [items]);
  const max = Math.max(1, ...stats.bars);
  const diff = stats.today - stats.yesterday;
  return (
    <div className="today">
      <div className="today-numbers">
        <div className="today-big">
          {stats.today} {stats.today === 1 ? 'task' : 'tasks'} completed
        </div>
        <div className={`today-diff ${diff >= 0 ? 'up' : 'down'}`}>
          {diff >= 0 ? '+' : ''}
          {diff} vs yesterday
        </div>
      </div>
      <div className="today-bars" aria-hidden="true">
        {stats.bars.map((n, i) => (
          <span key={i} style={{ height: `${Math.max(8, Math.round((n / max) * 100))}%` }} className={n > 0 ? 'on' : ''} />
        ))}
      </div>
    </div>
  );
}
