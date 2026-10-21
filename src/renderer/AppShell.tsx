import React, { useEffect, useState } from 'react';
import './app.css';
import type { AppPage, EyaControl } from './control';
import { Icon } from './ui/icons';
import type { IconName } from './ui/icons';
import { ChatPage } from './pages/ChatPage';
import { HomePage } from './pages/HomePage';
import { MemoryPage } from './pages/MemoryPage';
import { FilesPage } from './pages/FilesPage';
import { RecentPage } from './pages/RecentPage';
import { ScreenPage } from './pages/ScreenPage';
import { SettingsPage } from './pages/SettingsPage';

interface NavItem {
  readonly id: AppPage;
  readonly label: string;
  readonly icon: IconName;
  /** Not built yet: shown so the plan is visible, but it does nothing. */
  readonly soon?: true;
}

const NAV: readonly NavItem[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'screen', label: 'Live Screen', icon: 'screen' },
  { id: 'recent', label: 'Recent', icon: 'clock' },
  { id: 'memory', label: 'Memory', icon: 'memory' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/** A request to open on a particular screen (the tray's "set up Chats in Settings", say). `n` makes a repeat request count as new. */
export interface PageRequest {
  readonly page: AppPage;
  readonly n: number;
}

/** The full Eya window: a sidebar and the screens. It is another face of the same assistant — the voice and the conversation carry on underneath. */
export function AppShell({ c, request }: { c: EyaControl; request: PageRequest | null }): React.ReactElement {
  const [page, setPage] = useState<AppPage>(request?.page ?? 'home');
  // Opened FOR Chats setup (the tray's "set up in Settings"): land on the Privacy section until the user goes anywhere else.
  const [landOnPrivacy, setLandOnPrivacy] = useState(request?.page === 'settings');
  // Sent to the Gemini key section by the Home screen's "add your key" button.
  const [settingsStart, setSettingsStart] = useState<'gemini' | null>(null);

  useEffect(() => {
    if (request !== null) {
      setPage(request.page);
      setLandOnPrivacy(request.page === 'settings');
    }
  }, [request]);

  const chatsOn = c.comm?.enabled === true;
  const go = (next: AppPage): void => {
    setLandOnPrivacy(false);
    setPage(next);
  };

  return (
    <div className="appwin">
      <header className="titlebar">
        <span className="titlebar-logo" />
        <span className="titlebar-text">Eya - Your Laptop Agent</span>
        <span className="mem-spacer" />
        <button type="button" className="tb-btn" onClick={() => go('settings')} title="Settings" aria-label="Settings">
          <Icon name="settings" size={16} />
        </button>
        <button type="button" className="tb-btn" onClick={() => c.setWindowMode('bubble')} title="Minimize to the bubble" aria-label="Minimize to the bubble">
          <Icon name="minus" size={16} />
        </button>
        <button type="button" className="tb-btn close" onClick={() => c.setWindowMode('bubble')} title="Close (Eya keeps running as a bubble)" aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="appbody">
        <nav className="sidebar" aria-label="Eya">
          {NAV.map((n) =>
            n.soon === true ? (
              <button key={n.id} type="button" className="nav-item soon" disabled title="Coming soon">
                <Icon name={n.icon} size={19} />
                {n.label}
                <span className="soon-tag">Soon</span>
              </button>
            ) : (
              <button key={n.id} type="button" className={`nav-item ${page === n.id ? 'on' : ''}`} onClick={() => go(n.id as AppPage)} aria-current={page === n.id ? 'page' : undefined}>
                <Icon name={n.icon} size={19} />
                {n.label}
              </button>
            ),
          )}
          <span className="mem-spacer" />
          {c.share.active && (
            <button type="button" className={`side-sharing ${c.share.paused !== null ? 'paused' : ''}`} onClick={() => go('screen')} title="Eya can see your screen. Click to open Live Screen.">
              <span className="status-dot live" />
              {c.share.paused !== null ? 'Sharing paused' : 'Sharing screen'}
            </button>
          )}
          <button type="button" className={`side-chats ${chatsOn ? 'on' : ''}`} onClick={() => go('settings')} title={chatsOn ? 'Eya may use the chat apps you allowed. Click to review.' : 'Eya does not look at chat apps. Click to set up.'}>
            <Icon name="chat" size={15} />
            Chats {chatsOn ? 'ON' : 'OFF'}
          </button>
        </nav>
        <main className="content">
          {page === 'home' && (
            <HomePage
              c={c}
              go={go}
              onAddKey={() => {
                setLandOnPrivacy(false);
                setSettingsStart('gemini');
                setPage('settings');
              }}
            />
          )}
          {page === 'chat' && <ChatPage c={c} />}
          {page === 'screen' && <ScreenPage c={c} />}
          {page === 'files' && <FilesPage c={c} />}
          {page === 'recent' && <RecentPage c={c} go={go} />}
          {page === 'memory' && <MemoryPage c={c} go={go} />}
          {page === 'settings' && (
            <SettingsPage
              key={landOnPrivacy ? `privacy-${request?.n ?? 0}` : settingsStart === 'gemini' ? 'gemini' : 'settings'}
              c={c}
              {...(landOnPrivacy ? { startOn: 'privacy' as const } : settingsStart === 'gemini' ? { startOn: 'gemini' as const } : {})}
            />
          )}
        </main>
      </div>
    </div>
  );
}
