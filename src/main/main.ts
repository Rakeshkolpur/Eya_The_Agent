import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { app, clipboard, desktopCapturer, ipcMain, nativeImage, net, Notification, screen, session, shell } from 'electron';
import { createScreenCapture } from '@main/screen/screenCapture';
import { queryWindowSize } from '@main/screen/windowSize';
import { OrbWindow } from '@main/windows/OrbWindow';
import { GlobalShortcutManager } from '@main/shortcuts/GlobalShortcut';
import { IpcRouter } from '@main/ipc/ipcRouter';
import { AgentEngine } from '@main/agent/AgentEngine';
import { IntentRouter } from '@main/agent/IntentRouter';
import { ResponseComposer } from '@main/agent/ResponseComposer';
import { ToolRegistry } from '@main/tools/ToolRegistry';
import { createOpenApplicationTool, defaultOpenApplicationDeps } from '@main/tools/impl/openApplication';
import { closeApplicationTool } from '@main/tools/impl/closeApplication';
import { createFileTools } from '@main/tools/impl/fileTools';
import { createDocumentTool, createWebSearchTool } from '@main/tools/impl/documentTools';
import { Researcher } from '@main/research/Researcher';
import { WebFetcher } from '@main/research/webFetch';
import { createResearchTool } from '@main/tools/impl/researchTools';
import { createYoutubeTools } from '@main/tools/impl/youtubeTools';
import { searchYoutube } from '@main/research/youtube';
import { createOpenTools } from '@main/tools/impl/openTools';
import { createDownloadTool } from '@main/tools/impl/downloadTools';
import { AppCatalog } from '@main/local/AppCatalog';
import { FileIndex } from '@main/local/FileIndex';
import { LocalCommands } from '@main/local/LocalCommands';
import { ChatCommands } from '@main/local/ChatCommands';
import { CardWindow } from '@main/writing/CardWindow';
import { createCloudCheck } from '@main/writing/CloudCheck';
import { FocusedTextSource, ReaderProcess, WordSource } from '@main/writing/ReaderProcess';
import { WordControl } from '@main/word/WordControl';
import { ReferenceService } from '@main/word/ReferenceService';
import { ReferenceCommands } from '@main/word/ReferenceCommands';
import { ReferenceStore } from '@main/word/ReferenceStore';
import { createReferenceTools } from '@main/tools/impl/referenceTools';
import { WordCommands, workingInWord } from '@main/word/WordCommands';
import { CommandChain } from '@main/local/CommandChain';
import WORD_HELPER from '@main/word/word-helper.ps1?raw';
import { createWordTools } from '@main/tools/impl/wordTools';
import { WritingCommands } from '@main/writing/WritingCommands';
import { WritingWatch } from '@main/writing/WritingWatch';
import { registerWritingIpc, writingView } from '@main/writing/writingIpc';
import type { FileLocation } from '@main/local/ChatCommands';
import { currentHardware, readSavedPerformance } from '@main/perf/earlyProfile';
import { createGeminiKeyService, registerGeminiKeyIpc } from '@main/config/geminiKeyIpc';
import { handleModelProtocol, modelsDir } from '@main/models/modelProtocol';
import { appRoot, handleAppProtocol } from '@main/windows/appProtocol';
import { registerPrivateSchemes } from '@main/privateSchemes';
import { withIsolationHeaders } from '@main/isolationHeaders';
import { describeHardware, resolvePerformance } from '@shared/performance';
import type { PerformanceInfo } from '@shared/performance';
import { QuickCommands } from '@main/local/QuickCommands';
import { listStartApps } from '@main/windowsApi/appDiscovery';
import { createFileOpsTools } from '@main/tools/impl/fileOpsTools';
import { createClipboardTools } from '@main/tools/impl/clipboardTools';
import { closeFileTool } from '@main/tools/impl/closeFile';
import { createSystemTools, defaultSystemControlDeps } from '@main/tools/impl/systemTools';
import { createRecycleBinTools } from '@main/tools/impl/recycleBinTools';
import { createBrowserTools } from '@main/tools/impl/browserTools';
import { createScreenshotTool } from '@main/tools/impl/screenshotTool';
import { createWindowTools } from '@main/tools/impl/windowTools';
import { createCommunicationStatusTool } from '@main/tools/impl/communicationTools';
import { createChatSendGate, createChatTools } from '@main/tools/impl/chatTools';
import { createArchiveTools } from '@main/tools/impl/archiveTools';
import { createScreenTools } from '@main/tools/impl/screenTools';
import { createUiAutomation } from '@main/screen/uiAutomation';
import { ChatSession } from '@main/chat/chatSession';
import { CommunicationPolicy } from '@main/privacy/communicationAccess';
import { CommunicationAccessStore } from '@main/privacy/communicationAccessStore';
import { registerCommunicationAccessIpc } from '@main/privacy/communicationAccessIpc';
import { startPolicySync } from '@main/privacy/policySync';
import { createWindowControl } from '@main/windowsApi/windowControl';
import { PlaywrightBrowserService } from '@main/browser/PlaywrightBrowserService';
import { BrowserSessionManager, parseBrowserMode } from '@main/browser/BrowserSessionManager';
import { createBrowserLauncher } from '@main/browser/browserLauncher';
import { ChromeBridge, FileSecretStore } from '@main/chrome/ChromeBridge';
import { publishBootstrap } from '@main/chrome/bootstrapFile';
import { BrowserWorldTracker } from '@main/chrome/browserWorld';
import { createChromeConnector } from '@main/chrome/chromeConnector';
import { openExtensionsPage } from '@main/chrome/extensionsPage';
import { findAppExe, launchBrowser } from '@main/windowsApi/appPaths';
import { registerLiveBridge } from '@main/live/liveBridge';
import type { AgentResult, AgentUpdate } from '@shared/types';
import { TaskStore } from '@main/tasks/TaskStore';
import { TaskCompleter } from '@main/tasks/TaskCompleter';
import { describeProgress } from '@main/tasks/progress';
import { runWithUserWords } from '@main/security/userWords';
import { TaskCommands } from '@main/tasks/TaskCommands';
import { trackRequest } from '@main/tasks/trackRequest';
import { createTaskNotifier, registerTasksIpc } from '@main/tasks/tasksIpc';
import { loadWakeWordDetector } from '@main/wake/loadWakeWordDetector';
import type { KnownFolders } from '@main/security/pathPolicy';
import { RendererTTSBridge } from '@main/providers/tts/RendererTTSBridge';
import { GeminiTTS } from '@main/providers/tts/GeminiTTS';
import { OpenAITTS } from '@main/providers/tts/OpenAITTS';
import { TtsStreamService } from '@main/providers/tts/TtsStreamService';
import { OllamaAIProvider } from '@main/providers/ai/OllamaAIProvider';
import { GeminiAIProvider } from '@main/providers/ai/GeminiAIProvider';
import { ChainedAIProvider } from '@main/providers/ai/ChainedAIProvider';
import type { ChainStore } from '@main/providers/ai/ChainedAIProvider';
import { SwitchableAIProvider } from '@main/providers/ai/SwitchableAIProvider';
import { MAX_BACKUPS } from '@shared/backupAi';
import { createChosenAiNotice, describeRoute } from '@shared/aiRoute';
import type { AiRouteStatus } from '@shared/aiRoute';
import { createBackupAiService, createChainStore, registerBackupAiIpc } from '@main/config/backupAiIpc';
import type { AIProvider } from '@main/providers/ai/AIProvider';
import { PermissionManager } from '@main/permissions/PermissionManager';
import { memoryDbPath, startMemory } from '@main/memory/startMemory';
import { registerMemoryIpc } from '@main/memory/ipc';
import { snapshotOf } from '@main/memory/panel';
import type { MemoryService } from '@main/memory/MemoryService';
import { createMemoryTools } from '@main/tools/impl/memoryTools';
import { ActivityLog } from '@main/memory/activityLog';
import { AppSettingsStore, WindowStateStore } from '@main/settings/appSettings';
import { appIcon, createTray } from '@main/windows/tray';
import type { EyaTray } from '@main/windows/tray';
import type { MenuHost } from '@main/windows/trayMenu';
import { registerWindowIpc } from '@main/windows/windowIpc';
import { activitySnapshot } from '@main/windows/snapshots';
import { FileBrowser } from '@main/files/fileBrowser';
import { FilesService } from '@main/files/filesService';
import { registerFilesIpc } from '@main/files/filesIpc';
import { ScreenShare } from '@main/screen/screenShare';
import { registerScreenShareIpc } from '@main/screen/screenShareIpc';
import { createScreenShareTools } from '@main/tools/impl/screenShareTools';
import { scrubSecrets } from '@main/tools/impl/screenTools';
import { describeAIFailure } from '@main/agent/AgentEngine';
import { ConversationContext } from '@main/context/ConversationContext';
import { loadDotEnv } from '@main/config/env';
import { rootLogger } from '@main/logging/logger';
import { APP_ID, GREETING } from '@shared/constants';
import { IpcChannels } from '@shared/ipcContract';
import type { StatusMessage } from '@shared/ipcContract';

const log = rootLogger.child('main');

// How hard Eya works, matched to this laptop (or the user's choice in Settings). Decided before the app is ready because Chromium's
// graphics acceleration can only be turned off before it starts: on a small laptop that alone is about half of Eya's memory.
const hardware = currentHardware();
const savedPerformance = readSavedPerformance(join(app.getPath('userData'), 'settings.json'));
const perf = resolvePerformance(savedPerformance, hardware, process.env['EYA_PROFILE']);
const profile = perf.profile;
if (!profile.hardwareAcceleration) app.disableHardwareAcceleration();
// Eya's page and the speech models are served to her from files on this PC (eya-app://, eya-models://); the schemes have to be declared,
// together and once, before the app is ready.
registerPrivateSchemes();

async function bootstrap(): Promise<void> {
  log.info('performance level', { running: profile.tier, detected: perf.detected, saved: savedPerformance, ...describeHardware(hardware), hardwareAcceleration: profile.hardwareAcceleration });
  app.setAppUserModelId(APP_ID);

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    log.warn('another instance is running; exiting');
    app.quit();
    return;
  }

  await app.whenReady();
  handleModelProtocol(modelsDir());
  handleAppProtocol(appRoot(__dirname));
  loadDotEnv();
  // An installed Eya has no .env beside it: the user's own key, saved (encrypted by Windows) from Settings, is put where the rest of Eya looks
  // for it — before anything reads it. A key from the environment or a .env file still wins, as it always did.
  const geminiKey = createGeminiKeyService(join(app.getPath('userData'), 'gemini-key.bin'));
  geminiKey.start();
  registerGeminiKeyIpc(geminiKey);

  // Cross-origin isolation unlocks SharedArrayBuffer, which lets the speech
  // engine's WebAssembly run on several threads instead of one. "credentialless"
  // isolates without demanding CORP headers from every third-party response.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: withIsolationHeaders(details.responseHeaders) });
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media') { callback(true); return; }
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  // Eya's own small settings and where the bubble was left, kept in her data folder.
  const settingsStore = new AppSettingsStore(join(app.getPath('userData'), 'settings.json'));
  settingsStore.load();
  const windowState = new WindowStateStore(join(app.getPath('userData'), 'window-state.json'));
  const icon = appIcon();
  const orb = new OrbWindow({ settings: settingsStore, state: windowState, icon });
  const shortcuts = new GlobalShortcutManager();
  const permissions = new PermissionManager();
  const context = new ConversationContext();

  // Build Gemini and (optional) chained provider. The tools that read
  // documents and search the web use it directly; so does voice transcription.
  const gemini = new GeminiAIProvider();
  // The backup AI: a second online service (the user's own key, set in Settings) that takes over when Gemini's free allowance for the
  // day is used up or Gemini is overloaded. It starts empty and is filled — without a restart — when a key is saved.
  // One slot per backup AI the user can have, asked in order after Gemini; an empty slot is skipped.
  const backupSlots = Array.from({ length: MAX_BACKUPS }, (_, i) => new SwitchableAIProvider(`backup${i + 1}`));
  const chain = buildAIProvider(gemini, backupSlots, createChainStore(join(app.getPath('userData'), 'ai-state.json')));
  const ai: AIProvider = chain;
  for (const slot of backupSlots) slot.onChange(() => chain.clearRests());
  const backupAi = createBackupAiService(join(app.getPath('userData'), 'backup-ai.bin'), backupSlots, (id) => chain.clearRests(id), (id, kind) => chain.markFailed(id, kind));
  backupAi.start();
  // Which AI is answering (and which model), for the badge in the interface: it changes when Gemini's allowance runs out or comes back,
  // when the backup is added or its model is picked, and when the user chooses to have the backup asked first.
  const aiRouteStatus = (): AiRouteStatus => {
    const b = backupAi.status();
    return describeRoute({
      entries: chain.route(),
      geminiKey: gemini.hasKey(),
      backups: b.entries.map((e) => ({ id: e.id, label: e.label, model: e.model, models: e.models })),
      prefer: settingsStore.get().aiFirst,
      now: Date.now(),
    });
  };
  const chosenAiNotice = createChosenAiNotice(aiRouteStatus);
  let announceAiRoute: () => void = () => undefined;
  chain.onChange(() => announceAiRoute());
  const applyAiFirst = (): void => chain.setPreferred(settingsStore.get().aiFirst === 'backup' ? (backupSlots[0] ?? null) : null);
  applyAiFirst();
  settingsStore.onChange(() => applyAiFirst());
  registerBackupAiIpc(backupAi, () => chain.summary(), aiRouteStatus);

  const folders: KnownFolders = {
    home: app.getPath('home'),
    desktop: app.getPath('desktop'),
    documents: app.getPath('documents'),
    downloads: app.getPath('downloads'),
    pictures: app.getPath('pictures'),
    videos: app.getPath('videos'),
    music: app.getPath('music'),
    temp: app.getPath('temp'),
  };

  // The folders the Files screen lists and the fast file search looks through. EYA_FILES_ROOT (for testing only) points them at one
  // throwaway folder instead of the user's own.
  const filesRoot = process.env['EYA_FILES_ROOT']?.trim();
  const browsedFolders: KnownFolders =
    filesRoot !== undefined && filesRoot !== ''
      ? {
          home: filesRoot,
          desktop: join(filesRoot, 'Desktop'),
          documents: join(filesRoot, 'Documents'),
          downloads: join(filesRoot, 'Downloads'),
          pictures: join(filesRoot, 'Pictures'),
          videos: join(filesRoot, 'Videos'),
          music: join(filesRoot, 'Music'),
          temp: folders.temp,
        }
      : folders;

  // Remembered, so everyday commands do not each start a PowerShell: the apps in the Start Menu, and the names of the files in the
  // user's folders. Both are read in the background shortly after start-up and kept current; a miss falls back to the slow, complete
  // search, so being incomplete only ever costs time.
  const appCatalog = new AppCatalog({ list: () => listStartApps() });
  appCatalog.start(profile.appCatalogStartMs);
  const fileIndex = new FileIndex({
    roots: [browsedFolders.desktop, browsedFolders.documents, browsedFolders.downloads, browsedFolders.pictures, browsedFolders.videos, browsedFolders.music],
    maxFiles: profile.fileIndexMaxFiles,
  });
  fileIndex.start(profile.fileIndexStartMs);

  const tools = new ToolRegistry();
  tools.register(
    createOpenApplicationTool({
      ...defaultOpenApplicationDeps,
      listStartApps: () => appCatalog.get(),
      listStartAppsFresh: () => appCatalog.refresh(),
      openExternal: (url) => shell.openExternal(url),
    }),
  );
  tools.register(closeApplicationTool);
  for (const tool of createFileTools(folders)) tools.register(tool);
  tools.register(createDocumentTool(folders, gemini));
  // Microsoft Word, in the document the user has open: write, format, page numbers, contents, list of events, running index.
  const wordControl = new WordControl(
    new ReaderProcess(join(app.getPath('userData'), 'scripts'), undefined, 30_000, { fileName: 'word-helper.ps1', text: WORD_HELPER }),
  );
  for (const tool of createWordTools({ word: wordControl })) tools.register(tool);
  // Learning from an old, finished document and using it on a half-done one (kept on this PC only).
  const referenceService = new ReferenceService(wordControl, new ReferenceStore(join(app.getPath('userData'), 'references')));
  for (const tool of createReferenceTools({ service: referenceService, folders })) tools.register(tool);
  // Browser tasks happen in the user's OWN Chrome / Edge — their profile, their tabs, their sign-ins — through the Eya
  // Browser Bridge extension. One session manager decides which browser, reuses their tabs, and never quietly swaps in a
  // separate browser. Eya's own window (a separate, signed-out profile) exists only for when the user explicitly agrees to
  // it; a second, invisible one does web-search lookups when no browser of theirs is connected.
  // EYA_BROWSER_MODE = user_browser (default) | eya_browser | auto. EYA_PREFERRED_BROWSER = chrome | edge.
  const bridgePort = Number(process.env['EYA_BRIDGE_PORT']);
  const extensionFolder =
    [join(app.getAppPath(), 'eya-chrome-extension'), join(process.resourcesPath ?? '', 'eya-chrome-extension')].find((p) => existsSync(p)) ??
    join(app.getAppPath(), 'eya-chrome-extension');
  const bridgeSecrets = new FileSecretStore(join(app.getPath('userData'), 'chrome-bridge.json'));
  // The extension pairs by itself with the key left in its own folder; nobody has to say "connect my browser" for a loaded extension.
  publishBootstrap(extensionFolder, bridgeSecrets.bootstrapToken());
  const chromeBridge = new ChromeBridge({
    secrets: bridgeSecrets,
    ...(Number.isInteger(bridgePort) && bridgePort > 0 ? { port: bridgePort } : {}),
  });
  const browserWorld = new BrowserWorldTracker();
  browserWorld.attach(chromeBridge);
  chromeBridge.onConnectionChange((e) => log.info(`${e.browser === 'edge' ? 'Edge' : e.browser === 'chrome' ? 'Chrome' : 'Browser'} extension: ${e.connected ? 'CONNECTED' : 'DISCONNECTED'}`));
  void chromeBridge.start().then(() => {
    setTimeout(() => {
      const info = chromeBridge.info();
      log.info('browser extensions at startup', {
        connected: chromeBridge.connectedBrowsers(),
        waitingToPair: info.waitingToPair,
        paired: Object.entries(info.browsers).filter(([, b]) => b?.paired === true).map(([n]) => n),
      });
      if (info.outdated.length > 0) {
        log.warn(`The Eya extension in ${info.outdated.join(' and ')} is an older version: open its extensions page and click reload on "Eya Browser Bridge" (or restart that browser).`);
      }
    }, 6000);
  });
  // Communication Access: the user's privacy switch for chat apps (WhatsApp, Telegram, Instagram…). OFF unless they turn it on in
  // Eya's panel; a missing or damaged settings file means OFF. The browser extension is kept in step with it.
  const communicationStore = new CommunicationAccessStore(join(app.getPath('userData'), 'communication-access.json'));
  communicationStore.load();
  const communication = new CommunicationPolicy(() => communicationStore.get());
  startPolicySync({ bridge: chromeBridge, blockRules: () => communication.blockRules(), onPolicyChange: (cb) => communicationStore.onChange(() => cb()) });
  // What Eya remembers about the chat she is working in (memory only): forgotten the moment Communication Access is narrowed.
  const chatSession = new ChatSession();
  // Eya's memory database (opened further down). Declared here because the chat tools below tell its contact book which chats they see.
  let memory: MemoryService | null = null;
  communicationStore.onChange((s) => {
    if (!s.enabled || Object.values(s.apps).some((allowed) => !allowed)) chatSession.clear();
  });
  const browserMode = parseBrowserMode(process.env['EYA_BROWSER_MODE']);
  const preferredEnv = (process.env['EYA_PREFERRED_BROWSER'] ?? '').toLowerCase();
  log.info('browser mode', { browserMode, ...(preferredEnv !== '' ? { preferred: preferredEnv } : {}) });
  const browserService = new BrowserSessionManager({
    bridge: chromeBridge,
    world: browserWorld,
    isolated: new PlaywrightBrowserService({
      profileDir: join(app.getPath('userData'), 'browser-profile'),
      downloadsDir: app.getPath('downloads'),
    }),
    lookup: new PlaywrightBrowserService({
      profileDir: join(app.getPath('userData'), 'lookup-profile'),
      downloadsDir: join(app.getPath('userData'), 'lookup-downloads'),
      headless: true,
    }),
    launcher: createBrowserLauncher({
      findExe: findAppExe,
      launch: (browser, url) => launchBrowser(browser, url),
      listProcessNames: defaultOpenApplicationDeps.listRunningProcessNames,
    }),
    mode: browserMode,
    preferred: preferredEnv === 'chrome' || preferredEnv === 'edge' ? preferredEnv : null,
    policy: communication,
  });
  const chromeConnector = createChromeConnector({
    bridge: chromeBridge,
    extensionFolder,
    openExtensionsPage: async () => {
      await openExtensionsPage({
        listRunningProcessNames: defaultOpenApplicationDeps.listRunningProcessNames,
        launchBrowser,
      });
    },
    revealFolder: async (path) => {
      await shell.openPath(path);
    },
  });
  tools.register(createWebSearchTool(gemini, { search: (query) => browserService.searchWeb(query) }));
  // Deep research over the open internet (plain HTTP through Electron's own fetch, so the system proxy applies; the user's browser is the
  // fallback when the search engines will not answer a script). It uses no AI of its own, so it spends none of the allowance.
  const webFetcher = new WebFetcher({ fetch: (url, init) => net.fetch(url, init) });
  const researcher = new Researcher({
    fetcher: webFetcher,
    fallbackSearch: async (query) => (await browserService.searchWeb(query)).map((h) => ({ ...h, engine: 'duckduckgo' as const })),
  });
  tools.register(createResearchTool({ researcher }));
  // Playing a song or film on YouTube: the right result chosen, adverts skipped by themselves (the user's own browser, extension 0.7.0).
  for (const tool of createYoutubeTools({ browser: browserService, search: (query) => searchYoutube(webFetcher, query) })) tools.register(tool);
  for (const tool of createOpenTools(folders, {
    opener: {
      openPath: (path) => shell.openPath(path),
      openExternal: (url) => shell.openExternal(url),
    },
    launchBrowser,
  })) {
    tools.register(tool);
  }
  // Downloading a link into the Downloads folder (never a program or script, always on the user's yes). Electron's own fetch follows
  // the system's proxy and certificates; a download that is still going when the answer is given tells the user when it ends.
  tools.register(
    createDownloadTool({
      folders,
      fetch: (url, init) => net.fetch(url, init),
      notify: (notice) => {
        if (!Notification.isSupported()) return;
        new Notification({
          title: 'Eya',
          body: notice.ok ? `Downloaded ${notice.name}` : `The download of ${notice.name} didn't finish`,
          silent: false,
        }).show();
      },
    }),
  );
  for (const tool of createFileOpsTools(folders)) tools.register(tool);
  for (const tool of createClipboardTools(clipboard)) tools.register(tool);
  tools.register(closeFileTool);
  const windowControl = createWindowControl();
  // The screen the mouse is on, or any application's window, through Electron's own capturer.
  const screenCapture = createScreenCapture({
    getSources: (options) => desktopCapturer.getSources(options),
    cursorDisplay: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),
    // The capturer enlarges a window's picture to whatever size it is asked for, so ask Windows for the window's real size first.
    windowSize: (sourceId) => queryWindowSize(sourceId),
  });
  // Real control of other applications' windows (list, minimise, maximise, restore, close, switch), checked from Windows itself.
  for (const tool of createWindowTools({
    control: windowControl,
    // Eya's own windows are never listed or touched.
    ownPids: () => [process.pid, ...app.getAppMetrics().map((m) => m.pid)],
    tabs: browserService,
    // A chat app's window title can be a contact's name: the model is told which app it is, nothing more.
    describeTitle: (w) => communication.appForWindow(w)?.name ?? w.title,
  })) {
    tools.register(tool);
  }
  for (const tool of createSystemTools({ ...defaultSystemControlDeps, openExternal: (url) => shell.openExternal(url) })) {
    tools.register(tool);
  }
  for (const tool of createRecycleBinTools(folders)) tools.register(tool);
  for (const tool of createBrowserTools(browserService, undefined, {
    tabs: browserService,
    connector: chromeConnector,
    session: browserService,
    // A send in a chat app names who it goes to and asks first.
    chatGate: createChatSendGate(chatSession, communication),
    // A verification code the user said and Eya typed: whatever was waiting for that code is over, and the conversation carries on.
    onCodeEntered: () => {
      taskCompleter.userContinued();
    },
  })) {
    tools.register(tool);
  }
  // Finding a chat, attaching a file to it, checking it went — and zipping a folder, since a chat app only takes files.
  // The contact book hears only chat NAMES (the rows that fit what was asked for, and the chat opened) and keeps them only if the user
  // said yes to Eya remembering chat names; until then, and without a memory database, it hears and keeps nothing.
  let chatCommandsRef: ChatCommands | undefined; // set below, once the chat commands exist (the names sink is needed first)
  const chatNames = {
    learn: (appId: string, labels: readonly string[]): number => memory?.contacts.learn(appId, labels) ?? 0,
    used: (appId: string, label: string): void => memory?.contacts.used(appId, label),
    learning: (): boolean => memory?.contacts.learning() === 'on',
    favourite: (appId: string, labels: readonly string[]): string | null => (memory?.contacts.learning() === 'on' ? memory.contacts.favourite(appId, labels) : null),
    offerConsent: (appId: string, label: string): string | null => chatCommandsRef?.offerConsent(appId, label) ?? null,
  };
  for (const tool of createChatTools({ service: browserService, policy: communication, session: chatSession, folders, names: chatNames })) tools.register(tool);
  for (const tool of createArchiveTools(folders)) tools.register(tool);
  tools.register(createCommunicationStatusTool(communication));
  tools.register(
    createScreenshotTool({
      capture: browserService,
      folders,
      describeLabel: (title) => communication.appForWindow({ process: '', title })?.name ?? title,
      screen: screenCapture,
    }),
  );
  // Eya's eyes and hands on the screen: look (asked first), list a window's parts, click one, check what changed.
  // A picture is shrunk (and made a JPEG) before it is sent to be read.
  const shrinkForReading = (png: Buffer): { bytes: Buffer; mime: 'image/jpeg' } => {
    const image = nativeImage.createFromBuffer(png);
    const { width, height } = image.getSize();
    const longest = Math.max(width, height);
    const scaled = longest > 1600 ? image.resize({ width: Math.round((width * 1600) / longest), height: Math.round((height * 1600) / longest), quality: 'good' }) : image;
    return { bytes: scaled.toJPEG(82), mime: 'image/jpeg' };
  };
  for (const tool of createScreenTools({
    control: windowControl,
    ui: createUiAutomation(),
    screen: screenCapture,
    ...(gemini.hasKey() ? { brain: gemini } : {}),
    policy: communication,
    ownPids: () => [process.pid, ...app.getAppMetrics().map((m) => m.pid)],
    // A picture is shrunk before it is sent to be read.
    prepareImage: shrinkForReading,
  })) {
    tools.register(tool);
  }

  const window = orb.create();
  const getSender = () => (window.isDestroyed() ? null : window.webContents);
  announceAiRoute = () => getSender()?.send(IpcChannels.aiRoute, aiRouteStatus());

  // Forward renderer console.* to the structured main-process log. The mic
  // capture and TTS pipelines run entirely in the renderer, so without this
  // any failure there (permission denied, recorder errors, playback issues)
  // is invisible outside the (rarely opened) DevTools console.
  const rendererLog = log.child('renderer');
  window.webContents.on('console-message', (_evt, level, message) => {
    const levelName = ['debug', 'info', 'warn', 'error'][level] ?? 'info';
    const fn = levelName === 'error' || levelName === 'warn' ? rendererLog.warn : rendererLog.info;
    fn.call(rendererLog, message);
  });

  const tts = new RendererTTSBridge(getSender);
  await tts.init();
  // ChatGPT's voice uses the OpenAI key saved in Settings (the key stays in this process).
  const speechStream = new TtsStreamService(new GeminiTTS(), getSender, new OpenAITTS({ getKey: () => backupAi.keyFor('openai'), ...(process.env['EYA_OPENAI_BASE_URL']?.trim() ? { config: { baseUrl: process.env['EYA_OPENAI_BASE_URL'].trim() } } : {}) }));
  speechStream.register();

  // Eya's memory: a local SQLite database (preferences, facts, saved routines). It uses the same tools as the model, so a routine
  // is held to every confirmation rule; and if it cannot open, Eya simply runs without it.
  memory = startMemory({
    dbPath: memoryDbPath(app.getPath('userData')),
    tools,
    policy: communication,
    notify: (event) => {
      if (event.type === 'changed') getSender()?.send(IpcChannels.memoryChanged, snapshotOf(memory));
      else getSender()?.send(IpcChannels.memorySuggestion, event.text);
    },
  });
  if (memory !== null) for (const tool of createMemoryTools(memory)) tools.register(tool);
  registerMemoryIpc(() => memory);

  // The history shown on the Recent screen (titles only, in the same database; the user can switch it off or clear it).
  const activityLog =
    memory === null
      ? undefined
      : new ActivityLog(memory.activity, { enabled: () => settingsStore.get().keepHistory, isChatUrl: (url) => communication.appForUrl(url) !== null });
  memory?.activity.onChange(() => getSender()?.send(IpcChannels.activityChanged, activitySnapshot(memory?.activity ?? null, settingsStore.get().keepHistory)));

  // Messaging by name without the model ("message Ravi that I'll be late"): the same chat tools in a fixed order, the same question
  // before anything is sent. Needs the memory database for the saved chat names.
  // Sending a file by name ("send the latest pdf to Akka") finds the file in the same in-memory index "open the latest pdf" uses.
  let locateFileForChat: ((words: string) => Promise<FileLocation | null>) | undefined;
  const chatCommands =
    memory === null
      ? undefined
      : new ChatCommands({
          tools,
          contacts: memory.contacts,
          policy: communication,
          session: chatSession,
          files: { locate: (words) => locateFileForChat?.(words) ?? Promise.resolve(null) },
          // "send it to Uber": the file found most recently (by the fast search, by the model, or by opening it), if that was a few minutes ago.
          lastFile: () => {
            for (const turn of [...context.recent()].reverse()) {
              if (Date.now() - turn.at > 15 * 60_000) return null;
              const ref = [...turn.refs].reverse().find((r) => r.kind === 'file');
              if (ref !== undefined) return { path: ref.value, name: typeof ref.meta?.['name'] === 'string' ? ref.meta['name'] : basename(ref.value) };
            }
            return null;
          },
          chatAppOpen: () => (['chrome', 'edge'] as const).some((b) => browserWorld.tabsOf(b).some((t) => communication.appForUrl(t.url) !== null)),
          extensionIsOld: () => Object.values(chromeBridge.info().browsers).some((b) => b?.connected === true && !(b.capabilities ?? []).includes('quick_actions')),
        });
  chatCommandsRef = chatCommands;
  // The names Eya learned from a chat app are erased the moment Chats is switched off for that app (and when Eya starts with it off),
  // and a question waiting for a "yes" is dropped.
  const eraseNamesOfAppsThatAreOff = (): void => {
    chatCommands?.reset();
    for (const chatApp of communication.apps()) if (!communication.allowed(chatApp)) memory?.contacts.forgetApp(chatApp.id);
  };
  eraseNamesOfAppsThatAreOff();
  communicationStore.onChange(eraseNamesOfAppsThatAreOff);

  // Writing Watch: while the user switches it on, Eya reads the document being written (Word, or a few plain editors) on this PC and shows
  // a small card when she sees a slip. It is off at every start-up, changes nothing without a click, and keeps nothing she reads.
  let refreshTray: () => void = () => undefined;
  const readerProcess = new ReaderProcess(join(app.getPath('userData'), 'scripts'));
  const writingCard = new CardWindow(() => orb.bubbleBounds(), join(__dirname, '../preload/card.js'));
  const writingWatch: WritingWatch = new WritingWatch({
    sources: [new WordSource(readerProcess), new FocusedTextSource(readerProcess)],
    ...(gemini.hasKey() ? { cloud: createCloudCheck(gemini) } : {}),
    onChange: (state) => {
      const view = writingView(state, gemini.hasKey());
      getSender()?.send(IpcChannels.writingChanged, view);
      writingCard.update(view);
      refreshTray();
    },
  });
  const writingCommands = new WritingCommands({
    state: () => writingWatch.state(),
    start: () => writingWatch.start(),
    stop: () => writingWatch.stop(),
    checkAll: () => writingWatch.checkAll(),
    setCloudAllowed: (on) => writingWatch.setCloudAllowed(on),
    fix: (id) => writingWatch.fix(id),
    dismiss: (id) => writingWatch.dismiss(id),
    cloudAvailable: () => gemini.hasKey(),
  });
  registerWritingIpc({ watch: writingWatch, cloudAvailable: () => gemini.hasKey(), card: writingCard });
  // The everyday Word commands ("add page numbers", "bold this", "undo that", "save it") at once, without the model. Document commands need
  // Word to have a document open; the ones that act at the cursor need Word to be the window the user is in.
  const wordIsInFront = async (): Promise<boolean> =>
    workingInWord(await windowControl.list(), new Set([process.pid, ...app.getAppMetrics().map((m) => m.pid)]));
  const wordCommands = new WordCommands({ run: (cmd, args) => wordControl.run(cmd, args), wordIsInFront });
  // "learn this document as my writ petition", "what have you learned", "format this like my writ petition"
  const referenceCommands = new ReferenceCommands({ service: referenceService, wordIsInFront });
  const writingAndWord = new CommandChain([writingCommands, wordCommands, referenceCommands]);

  const router = new IntentRouter(appCatalog);
  const composer = new ResponseComposer();
  // Everyday commands (open a site or folder, search a site, find or open a file, download a link) without the model.
  const local = new LocalCommands({
    tools,
    index: fileIndex,
    folders: browsedFolders,
    clipboardText: () => clipboard.readText(),
  });
  locateFileForChat = (words) => local.locateFile(words);
  // What the person asked for is kept until it is done: a slow page, an AI that is out for the day, a CAPTCHA to tick, a question waiting for a
  // yes. The completer tries again by itself (through the same engine, told what was already done), watches the browser while the person
  // does a check, and tells them by notification when it is finished or needs them.
  const taskCompleter: TaskCompleter = new TaskCompleter({
    store: new TaskStore(join(app.getPath('userData'), 'tasks.json')),
    run: (task): Promise<AgentResult> =>
      engine.handle(
        { requestId: `task-${task.id}-${task.attempts}`, text: task.request, source: 'text', resume: { steps: task.steps, note: task.note } },
        (update: AgentUpdate) => getSender()?.send(IpcChannels.agentUpdate, update),
      ),
    notify: createTaskNotifier(() => orb.openApp()),
    say: (text, kind) => getSender()?.send(IpcChannels.tasksSay, { text, kind }),
    watchBrowser: async (ms) => (await browserService.waitForUserChange(ms)).changed,
    onChange: () => getSender()?.send(IpcChannels.tasksChanged, taskCompleter.snapshot()),
  });
  registerTasksIpc(taskCompleter);
  const taskCommands: TaskCommands = new TaskCommands(taskCompleter);
  const engine = new AgentEngine({
    router,
    tools,
    composer,
    tts,
    context,
    local,
    tasks: taskCommands,
    // (Run with the person's own words attached: a verification code is typed only if they said it.)
    around: (req, run) => runWithUserWords(req.text, () => trackRequest(taskCompleter, req, run)),
    progress: () => describeProgress(taskCompleter.openTasks(), Date.now()),
    aiNote: chosenAiNotice,
    ...(chatCommands !== undefined ? { chat: chatCommands } : {}),
    writing: writingAndWord,
    browserContext: () => [browserWorld.summary(), communication.summary()].filter((x) => x !== '').join('\n'),
    ...(ai !== undefined ? { ai } : {}),
    ...(gemini.hasKey() ? { gemini } : {}),
    ...(memory !== null ? { memory } : {}),
    ...(activityLog !== undefined ? { activity: activityLog } : {}),
  });
  void permissions;

  // Talk mode: the live model gets ONE extra tool, quick_command, that runs the same chat and everyday-command layers on what the user
  // actually said (so messaging by name, files, folders, sites and downloads work there without a model step per page action).
  const quick = new QuickCommands([taskCommands, writingAndWord, ...(chatCommands !== undefined ? [chatCommands] : []), local]);
  registerLiveBridge({ gemini, tools, quick, context, tasks: taskCompleter, progress: () => describeProgress(taskCompleter.openTasks(), Date.now()), ...(memory !== null ? { memory } : {}), ...(activityLog !== undefined ? { activity: activityLog } : {}) });

  // Screen sharing: Eya looks at the screen about once a second ONLY while the user has turned it on; her own windows are left out of
  // the picture, and it pauses while a chat app that Chats are OFF for is showing.
  const frameImage = (png: Buffer) => {
    const image = nativeImage.createFromBuffer(png);
    const { width, height } = image.getSize();
    const longest = Math.max(width, height);
    const widest = profile.screenShareMaxWidth;
    const scaled = longest > widest ? image.resize({ width: Math.round((width * widest) / longest), height: Math.round((height * widest) / longest), quality: 'good' }) : image;
    const size = scaled.getSize();
    return { bytes: scaled.toJPEG(70), width: size.width, height: size.height };
  };
  const screenShare = new ScreenShare({
    intervalMs: profile.screenShareIntervalMs,
    capture: () => screenCapture.screen(),
    toFrame: frameImage,
    toAnswerImage: shrinkForReading,
    windowTitles: async () =>
      (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 16, height: 16 }, fetchWindowIcons: false })).map((s) => s.name).filter((n) => n.trim() !== ''),
    blockedBy: (title) => {
      const chatApp = communication.appForWindow({ process: '', title });
      return chatApp !== null && !communication.allowed(chatApp) ? chatApp.name : null;
    },
    analyze: (bytes, mime, prompt) => {
      if (!gemini.hasKey()) throw new Error('no Gemini key');
      return gemini.analyzeFile(bytes.toString('base64'), mime, prompt);
    },
    scrub: scrubSecrets,
    // Windows' "exclude from capture" for Eya's own window: she never sees herself, and the preview is not a hall of mirrors.
    protectOwnWindows: (on) => {
      if (!window.isDestroyed()) window.setContentProtection(on);
    },
    emitFrame: (frame) => getSender()?.send(IpcChannels.screenShareFrame, frame),
    emitStatus: (status) => getSender()?.send(IpcChannels.screenShareStatus, status),
    explainError: (err) => (gemini.hasKey() ? describeAIFailure(err) : "I need a Gemini key to read the screen."),
  });
  for (const tool of createScreenShareTools(screenShare)) tools.register(tool);
  registerScreenShareIpc({ share: screenShare, invokeTool: (name, args) => tools.invoke(name, args), ...(activityLog !== undefined ? { activity: activityLog } : {}) });

  // The Files screen: your own folders as lists (names, sizes and dates only). Opening, searching and reading go through the same tools,
  // and so the same rules, as when Eya is asked in words. EYA_FILES_ROOT (for testing only) points the lists at one throwaway folder.
  registerFilesIpc(
    new FilesService({
      folders,
      browser: new FileBrowser(browsedFolders),
      invoke: (name, args) => tools.invoke(name, args),
      reveal: (path) => shell.showItemInFolder(path),
      thumbnail: async (path) => {
        const image = await nativeImage.createThumbnailFromPath(path, { width: 96, height: 96 });
        return image.isEmpty() ? null : image.toDataURL();
      },
      ...(activityLog !== undefined ? { activity: activityLog } : {}),
    }),
  );

  // The tray icon and the bubble's right-click menu: the user's own controls for opening Eya, Chats, the bubble, and quitting.
  const loginItem = {
    get: (): boolean | null => (app.isPackaged ? app.getLoginItemSettings().openAtLogin : null),
    set: (on: boolean): void => {
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: on });
    },
  };
  let eyaTray: EyaTray | null = null;
  const menuHost: MenuHost = {
    chatsOn: () => communicationStore.get().enabled,
    writingWatchOn: () => writingWatch.isWatching(),
    setWritingWatch: (on) => (on ? writingWatch.start() : writingWatch.stop()),
    turnChatsOff: () => void communicationStore.set({ ...communicationStore.get(), enabled: false }),
    showBubble: () => settingsStore.get().showBubble,
    setShowBubble: (on) => void settingsStore.update({ showBubble: on }),
    startWithWindows: () => loginItem.get(),
    setStartWithWindows: (on) => {
      loginItem.set(on);
      eyaTray?.refresh();
    },
    openApp: (page) => orb.openApp(page),
    askEya: () => orb.setMode('assistant'),
    quit: () => app.quit(),
  };
  eyaTray = createTray(menuHost, icon);
  refreshTray = () => eyaTray?.refresh();
  communicationStore.onChange(() => eyaTray?.refresh());
  settingsStore.onChange(() => eyaTray?.refresh());
  // What Settings → Performance shows: what is chosen, what this laptop would pick, and what is running now (it only changes on a restart).
  const performanceInfo = (): PerformanceInfo => {
    const chosen = settingsStore.get().performance;
    return {
      setting: chosen,
      detected: perf.detected,
      running: profile.tier,
      wanted: resolvePerformance(chosen, hardware, process.env['EYA_PROFILE']).profile.tier,
      motionPerSecond: profile.motionPerSecond,
      offlineVoice: profile.offlineVoice,
      hardwareAcceleration: profile.hardwareAcceleration,
      ...describeHardware(hardware),
    };
  };
  registerWindowIpc({
    orb,
    settings: settingsStore,
    performance: performanceInfo,
    activity: () => memory?.activity ?? null,
    memoryPath: memoryDbPath(app.getPath('userData')),
    startWithWindows: loginItem,
    onQuit: () => app.quit(),
    onRelaunch: () => {
      app.relaunch();
      app.quit();
    },
    showBubbleMenu: () => eyaTray?.popupFor(window),
    send: (channel, payload) => getSender()?.send(channel, payload),
  });
  registerCommunicationAccessIpc({
    store: communicationStore,
    policy: communication,
    notify: (state) => getSender()?.send(IpcChannels.communicationAccessChanged, state),
  });

  // On-device wake word ("hey Eya", heard as sound). Optional: if the native
  // model can't load on this machine, the renderer falls back to noticing the
  // name in transcribed speech, as before.
  const wake = loadWakeWordDetector();
  ipcMain.handle(IpcChannels.wakeAvailable, () => wake !== null);
  ipcMain.on(IpcChannels.wakeAudioChunk, (evt, samples16k: unknown) => {
    if (wake === null || !(samples16k instanceof Float32Array)) return;
    const which = wake.push(samples16k);
    if (which !== null) {
      log.info('wake word heard', { which });
      evt.sender.send(IpcChannels.wakeDetected, which);
    }
  });

  const ipc = new IpcRouter(engine, engine);
  ipc.register(getSender);
  taskCompleter.start();

  shortcuts.register(() => orb.toggleAssistant());

  // Once the renderer is loaded, greet the user so they know Eya is alive. The bubble stays a bubble: it must not
  // throw a panel over whatever the user is doing (least of all when Eya starts with Windows).
  window.webContents.on('did-finish-load', () => {
    const aiKind: StatusMessage['ai'] = gemini.hasKey() ? 'gemini' : 'ollama';
    const status: StatusMessage = {
      ai: gemini.hasKey() ? 'gemini' : (ai !== undefined ? 'ollama' : 'none'),
      aiReady: gemini.hasKey() || ai !== undefined,
      ttsEngine: 'pending',
    };
    getSender()?.send(IpcChannels.status, status);
    void aiKind;
    // Slight delay to let the renderer wire up TTS listeners.
    setTimeout(() => {
      void tts.speak(GREETING);
    }, 800);
  });

  app.on('window-all-closed', () => { /* orb-only lifecycle */ });
  app.on('before-quit', () => orb.prepareToQuit());
  app.on('will-quit', () => {
    taskCompleter.stop();
    screenShare.dispose();
    wordControl.close();
    writingWatch.stop();
    writingCard.dispose();
    fileIndex.stop();
    appCatalog.stop();
    eyaTray?.destroy();
    shortcuts.unregisterAll();
    speechStream.cancelAll();
    void tts.dispose();
    void browserService.close();
    void chromeBridge.stop();
    memory?.close();
  });
  app.on('second-instance', () => orb.openApp());
}

function buildAIProvider(gemini: GeminiAIProvider, backups: readonly AIProvider[], store: ChainStore): ChainedAIProvider {
  const providers: AIProvider[] = [];
  if (gemini.hasKey()) {
    log.info('AI: Gemini enabled (primary)');
    providers.push(gemini);
  } else {
    log.info('AI: Gemini disabled (no EYA_GEMINI_API_KEY)');
  }
  const ollama = new OllamaAIProvider();
  ollama.checkAvailability().then((ok) => {
    log.info(ok ? 'AI: Ollama reachable (backup)' : 'AI: Ollama unreachable');
  }).catch(() => undefined);
  // Order: Gemini, then the user's online backup (if they set one), then the local Ollama if it happens to be running.
  providers.push(...backups, ollama);
  return new ChainedAIProvider(providers, { store });
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  app.quit();
});
