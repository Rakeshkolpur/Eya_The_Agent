import React, { useState } from 'react';
import type { AppPage, EyaControl } from '../control';
import { Icon } from '../ui/icons';
import type { IconName } from '../ui/icons';
import { timeAgo } from '../ui/format';
import { BigOrb, KindIcon } from '../ui/widgets';
import { AiPicker } from '../ui/AiPicker';
import { TasksCard } from '../ui/TasksCard';

interface Tile {
  readonly icon: IconName;
  readonly title: string;
  readonly sub: string;
  readonly go: () => void;
}

/** Home: Eya, how she is, a box to ask her anything, a few doors, and what she did lately. */
export function HomePage({ c, go, onAddKey }: { c: EyaControl; go: (page: AppPage) => void; onAddKey: () => void }): React.ReactElement {
  const [text, setText] = useState('');
  const ask = (): void => {
    const t = text.trim();
    if (t === '') return;
    setText('');
    void c.submit(t);
    go('chat'); // the answer appears where the conversation is
  };
  const chatsOn = c.comm?.enabled === true;
  const tiles: Tile[] = [
    { icon: 'mic', title: c.talk === 'off' ? 'Talk' : 'End talk', sub: c.talk === 'off' ? 'Live conversation' : 'Live conversation is on', go: c.toggleTalk },
    { icon: 'screen', title: c.share.active ? 'Live Screen' : 'Share screen', sub: c.share.active ? 'Eya can see it' : 'Ask about your screen', go: () => go('screen') },
    { icon: 'folder', title: 'Files', sub: 'Find & open files', go: () => go('files') },
    { icon: 'memory', title: 'Memory', sub: 'Preferences & routines', go: () => go('memory') },
    { icon: 'clock', title: 'Recent', sub: 'What Eya did', go: () => go('recent') },
    { icon: 'chat', title: `Chats ${chatsOn ? 'ON' : 'OFF'}`, sub: 'Chat apps & privacy', go: () => go('settings') },
  ];
  const recent = c.activity?.items.slice(0, 7) ?? [];

  return (
    <div className="home">
      <section className="home-main">
        <BigOrb state={c.state} />
        <h1 className="home-name">Eya</h1>
        <div className="home-sub">Your Advanced Laptop Assistant</div>
        <div className="home-status">
          <span className={`status-dot ${c.listening || c.talk === 'on' ? 'live' : ''}`} />
          {c.statusText}
        </div>
        <div className="home-ai">
          <AiPicker c={c} />
        </div>
        <div className="home-bubble">How can I help you today?</div>
        {c.geminiKey?.source === 'none' && (
          <div className="home-key">
            <span>Everyday requests work on this PC without a key. Add your free Gemini key to chat, read documents and your screen, and talk live.</span>
            <button type="button" className="btn primary" onClick={onAddKey}>
              Add your Gemini key
            </button>
          </div>
        )}
        <div className="ask-bar">
          <input
            className="ask-input"
            value={text}
            placeholder="Ask Eya anything…"
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') ask();
            }}
          />
          <button type="button" className={`ask-mic ${c.talk !== 'off' ? 'on' : ''}`} onClick={c.toggleTalk} disabled={c.talk === 'off' && !c.voiceOn} title={c.talk === 'off' ? 'Talk to Eya' : 'End the conversation'} aria-label="Talk to Eya">
            <Icon name="mic" size={18} />
          </button>
          <button type="button" className="ask-send" onClick={ask} title="Send" aria-label="Send">
            <Icon name="send" size={17} />
          </button>
        </div>
        <div className="tiles">
          {tiles.map((t) => (
            <button key={t.title} type="button" className="tile" onClick={t.go}>
              <Icon name={t.icon} size={20} />
              <span className="tile-title">{t.title}</span>
              <span className="tile-sub">{t.sub}</span>
            </button>
          ))}
        </div>
      </section>
      <div className="home-side">
      <TasksCard c={c} variant="card" />
      <aside className="home-recent card">
        <div className="card-head">
          <h2>Recent</h2>
          <button type="button" className="link" onClick={() => go('recent')}>
            View all →
          </button>
        </div>
        {recent.length === 0 ? (
          <div className="empty">{c.activity?.enabled === false ? 'History is off. You can turn it on in Settings → Privacy.' : 'Nothing yet. Ask Eya to do something and it shows up here.'}</div>
        ) : (
          <ul className="recent-list compact">
            {recent.map((a) => (
              <li key={a.id}>
                <KindIcon kind={a.kind} ok={a.ok} />
                <div className="recent-text">
                  <div className="recent-title">{a.title}</div>
                  <div className="recent-meta">{timeAgo(a.at)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </aside>
      </div>
    </div>
  );
}
