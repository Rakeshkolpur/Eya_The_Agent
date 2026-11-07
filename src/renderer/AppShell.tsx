import React, { useEffect, useRef, useState } from 'react';
import './app.css';
import './shell.css';
import type { AppPage, EyaControl } from './control';
import { Icon } from './ui/icons';
import type { IconName } from './ui/icons';
import { getTheme, setTheme } from './ui/prefs';
import type { Theme } from './ui/prefs';
import { ChatHistory, NewChatButton } from './ui/ChatHistory';
import { isTaskActive } from './ui/activity';
import { LayoutProvider, useLayout } from './ui/layout';
import { LayoutMenu, Section, SectionsProvider } from './ui/sections';
import { BrowserPage } from './pages/BrowserPage';
import { ChatPage } from './pages/ChatPage';
import { HomePage } from './pages/HomePage';
import { MemoryPage } from './pages/MemoryPage';
import { FilesPage } from './pages/FilesPage';
import { LiveChatPage } from './pages/LiveChatPage';
import { PluginsPage } from './pages/PluginsPage';
import { RecentPage } from './pages/RecentPage';
import { ScreenPage } from './pages/ScreenPage';
import { SettingsPage } from './pages/SettingsPage';

interface NavItem {
  readonly id: AppPage;
  readonly label: string;
  readonly icon: IconName;
}

const NAV: readonly NavItem[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'recent', label: 'Tasks', icon: 'tasks' },
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'livechat', label: 'Live chat', icon: 'bolt' },
  { id: 'browser', label: 'Browser', icon: 'globe' },
  { id: 'screen', label: 'Live Screen', icon: 'screen' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'plugins', label: 'Plugins', icon: 'plug' },
  { id: 'memory', label: 'Memory', icon: 'memory' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

const APP_COLORS = ['#25d366', '#2aa3e0', '#e1306c', '#ff0033', '#ea4335', '#1ea362', '#4285f4', '#0a66c2'];

/** A request to open on a particular screen (the tray's "set up Chats in Settings", say). `n` makes a repeat request count as new. */
export interface PageRequest {
  readonly page: AppPage;
  readonly n: number;
}

/** The full Eya window: a sidebar, a top bar and the screens. It is another face of the same assistant — the voice and the conversation carry on underneath. */
export function AppShell({ c, request }: { c: EyaControl; request: PageRequest | null }): React.ReactElement {
  return (
    <SectionsProvider>
      <LayoutProvider>
        <Shell c={c} request={request} />
      </LayoutProvider>
    </SectionsProvider>
  );
}

function Shell({ c, request }: { c: EyaControl; request: PageRequest | null }): React.ReactElement {
  const layout = useLayout();
  const [page, setPage] = useState<AppPage>(request?.page ?? 'home');
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
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

  // Ctrl+K: straight to the message box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const chatsOn = c.comm?.enabled === true;
  // While Eya is working on a task in Agent mode the panel about it opens on the right of Home (see LayoutProvider). Plain chat never opens it.
  const taskActive = isTaskActive(c) && c.agentMode;
  const { setTaskActive } = layout;
  useEffect(() => setTaskActive(taskActive), [taskActive, setTaskActive]);
  const go = (next: AppPage): void => {
    setLandOnPrivacy(false);
    setSettingsStart(null);
    setPage(next);
  };
  // The Gemini keys (the person's own and the family's, used one after another) live in Settings: straight to them.
  const openKeys = (): void => {
    setLandOnPrivacy(false);
    setSettingsStart('gemini');
    setPage('settings');
  };
  const toggleTheme = (): void => {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    setThemeState(next);
  };
  const startNewChat = (): void => {
    c.chats.newChat();
    go('home');
  };
  const openOldChat = (id: string): void => {
    c.chats.openChat(id);
    go('home');
  };
  const needYou = (c.tasks?.items ?? []).filter((t) => t.state === 'needs_you').length + (c.browserPanel?.status === 'waiting_you' ? 1 : 0);
  const userName = c.settings?.info.userName ?? '';
  const route = c.aiRoute?.using ?? null;
  const apps = c.comm?.apps ?? [];
  const keyCount = c.geminiKeys?.entries.length ?? 0;

  return (
    <div className={`appwin ${theme === 'dark' ? 'dark' : 'light'} ${c.maximized ? 'maxed' : ''}`.trim()}>
      <div className={`shell ${layout.sideFolded ? 'side-folded' : ''}`}>
        <nav className="sidebar" aria-label="Eya">
          <div className="brand">
            <span className="brand-logo">
              <span className="brand-eye" />
              <span className="brand-eye" />
            </span>
            <div className="brand-text">
              <div className="brand-name">
                Eya <span className="brand-tag">AI Agent</span>
              </div>
              <div className="brand-sub">Your AI Agent</div>
            </div>
            <button type="button" className="side-toggle" onClick={layout.toggleSide} title={layout.sideFolded ? 'Open the sidebar' : 'Close the sidebar'} aria-label={layout.sideFolded ? 'Open the sidebar' : 'Close the sidebar'} aria-pressed={layout.sideFolded}>
              <Icon name="panel" size={17} />
            </button>
          </div>
          <NewChatButton chats={c.chats} onNew={startNewChat} folded={layout.sideFolded} />
          <div className="nav-list">
            {NAV.map((n) => (
              <button key={n.id} type="button" className={`nav-item ${page === n.id ? 'on' : ''}`} onClick={() => go(n.id)} aria-current={page === n.id ? 'page' : undefined}>
                <Icon name={n.icon} size={19} />
                {n.label}
              </button>
            ))}
          </div>

          {!layout.sideFolded && <ChatHistory chats={c.chats} onOpen={openOldChat} />}

          <Section id="connectedApps" title="Connected Apps" className="side-apps" actions={<button type="button" className="link" onClick={() => go('settings')}>Manage</button>}>
            {apps.length === 0 ? (
              <div className="empty">Chat apps appear here once you allow them in Settings.</div>
            ) : (
              <ul className="conn-list">
                {apps.slice(0, 4).map((a, i) => {
                  const on = chatsOn && a.allowed;
                  return (
                    <li key={a.id}>
                      <span className="conn-logo" style={{ background: APP_COLORS[i % APP_COLORS.length] }}>
                        {a.name.charAt(0).toUpperCase()}
                      </span>
                      <span className="conn-text">
                        <span className="conn-name">{a.name}</span>
                        <span className={`conn-state ${on ? 'on' : ''}`}>{on ? 'Allowed' : 'Off'}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <button type="button" className="add-app" onClick={() => go('settings')}>
              <Icon name="plus" size={14} /> Add App
            </button>
          </Section>

          <span className="mem-spacer" />
          {c.share.active && (
            <button type="button" className={`side-sharing ${c.share.paused !== null ? 'paused' : ''}`} onClick={() => go('screen')} title="Eya can see your screen. Click to open Live Screen.">
              <span className="status-dot live" />
              {c.share.paused !== null ? 'Sharing paused' : 'Sharing screen'}
            </button>
          )}
          <Section id="aiStatus" className="ai-card">
            <button type="button" className="ai-card-btn" onClick={openKeys} title="Gemini keys: add several and Eya uses them one after another">
              <span className={`ai-dot ${route === null ? 'off' : ''}`} />
              <span className="ai-text">
                <span className="ai-name">{route === null ? 'On-PC commands' : route.label}</span>
                <span className={`ai-state ${route === null ? 'warn' : ''}`}>{route === null ? 'AI limit reached' : 'Running'}</span>
                <span className="ai-note">{keyCount > 1 ? `${keyCount} Gemini keys, used one after another` : route === null ? 'Everyday requests still work on this PC' : route.model !== null ? route.model : 'Privacy first · everyday requests run on this PC'}</span>
              </span>
            </button>
          </Section>
          <button type="button" className={`side-chats ${chatsOn ? 'on' : ''}`} onClick={() => go('settings')} title={chatsOn ? 'Eya may use the chat apps you allowed. Click to review.' : 'Eya does not look at chat apps. Click to set up.'}>
            <Icon name="chat" size={15} />
            Chats {chatsOn ? 'ON' : 'OFF'}
          </button>
        </nav>

        <div className="mainarea">
          <header className="topbar">
            <span className="mem-spacer" />
            <button type="button" className="tb-btn round" onClick={() => go('recent')} title={needYou > 0 ? `${needYou} waiting for you` : 'Nothing is waiting for you'} aria-label="Notifications">
              <Icon name="bell" size={17} />
              {needYou > 0 && <span className="tb-badge">{needYou}</span>}
            </button>
            <button type="button" className="tb-btn round" onClick={toggleTheme} title={theme === 'light' ? 'Dark mode' : 'Light mode'} aria-label="Switch between light and dark">
              <Icon name={theme === 'light' ? 'moon' : 'sun'} size={17} />
            </button>
            {page === 'home' && layout.panel.canToggle && (
              <button type="button" className={`tb-btn round ${layout.panel.shown ? 'on' : ''}`} onClick={layout.panel.toggle} title={layout.panel.shown ? 'Close the panel on the right' : 'Show what Eya is doing'} aria-label={layout.panel.shown ? 'Close the panel on the right' : 'Show what Eya is doing'} aria-pressed={layout.panel.shown}>
                <Icon name="panelright" size={17} />
              </button>
            )}
            <LayoutMenu />
            <button type="button" className="user-chip" onClick={() => go('settings')} title="Settings">
              <span className="user-avatar">{(userName.charAt(0) || 'E').toUpperCase()}</span>
              <span className="user-name">{userName === '' ? 'You' : userName}</span>
            </button>
            <button type="button" className="tb-btn" onClick={() => c.setWindowMode('bubble')} title="Minimize to the bubble" aria-label="Minimize to the bubble">
              <Icon name="minus" size={16} />
            </button>
            <button type="button" className="tb-btn" onClick={c.toggleMaximize} title={c.maximized ? 'Restore down' : 'Maximize'} aria-label={c.maximized ? 'Restore down' : 'Maximize'} aria-pressed={c.maximized}>
              <Icon name={c.maximized ? 'winrestore' : 'winmax'} size={15} />
            </button>
            <button type="button" className="tb-btn close" onClick={() => c.setWindowMode('bubble')} title="Close (Eya keeps running as a bubble)" aria-label="Close">
              <Icon name="close" size={16} />
            </button>
          </header>
          <main className={`content page-${page}`}>
            {page === 'home' && (
              <HomePage
                c={c}
                go={go}
                onAddKey={openKeys}
              />
            )}
            {page === 'chat' && <ChatPage c={c} />}
            {page === 'plugins' && <PluginsPage c={c} />}
            {page === 'livechat' && <LiveChatPage c={c} />}
            {page === 'screen' && <ScreenPage c={c} />}
            {page === 'browser' && <BrowserPage c={c} go={go} />}
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
    </div>
  );
}
