import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, clipboard, desktopCapturer, ipcMain, screen, session, shell } from 'electron';
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
import { createOpenTools } from '@main/tools/impl/openTools';
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
import { BrowserWorldTracker } from '@main/chrome/browserWorld';
import { createChromeConnector } from '@main/chrome/chromeConnector';
import { openExtensionsPage } from '@main/chrome/extensionsPage';
import { findAppExe, launchBrowser } from '@main/windowsApi/appPaths';
import { registerLiveBridge } from '@main/live/liveBridge';
import { loadWakeWordDetector } from '@main/wake/loadWakeWordDetector';
import type { KnownFolders } from '@main/security/pathPolicy';
import { RendererTTSBridge } from '@main/providers/tts/RendererTTSBridge';
import { GeminiTTS } from '@main/providers/tts/GeminiTTS';
import { TtsStreamService } from '@main/providers/tts/TtsStreamService';
import { OllamaAIProvider } from '@main/providers/ai/OllamaAIProvider';
import { GeminiAIProvider } from '@main/providers/ai/GeminiAIProvider';
import { ChainedAIProvider } from '@main/providers/ai/ChainedAIProvider';
import type { AIProvider } from '@main/providers/ai/AIProvider';
import { PermissionManager } from '@main/permissions/PermissionManager';
import { MemoryManager } from '@main/memory/MemoryManager';
import { ConversationContext } from '@main/context/ConversationContext';
import { loadDotEnv } from '@main/config/env';
import { rootLogger } from '@main/logging/logger';
import { APP_ID, GREETING } from '@shared/constants';
import { IpcChannels } from '@shared/ipcContract';
import type { StatusMessage } from '@shared/ipcContract';

const log = rootLogger.child('main');

async function bootstrap(): Promise<void> {
  app.setAppUserModelId(APP_ID);

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    log.warn('another instance is running; exiting');
    app.quit();
    return;
  }

  await app.whenReady();
  loadDotEnv();

  // Cross-origin isolation unlocks SharedArrayBuffer, which lets the speech
  // engine's WebAssembly run on several threads instead of one. "credentialless"
  // isolates without demanding CORP headers from every third-party response.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['credentialless'],
      },
    });
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media') { callback(true); return; }
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  const orb = new OrbWindow();
  const shortcuts = new GlobalShortcutManager();
  const permissions = new PermissionManager();
  const memory = new MemoryManager();
  await memory.init();
  const context = new ConversationContext();

  // Build Gemini and (optional) chained provider. The tools that read
  // documents and search the web use it directly; so does voice transcription.
  const gemini = new GeminiAIProvider();
  const ai = buildAIProvider(gemini);

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

  const tools = new ToolRegistry();
  tools.register(createOpenApplicationTool({ ...defaultOpenApplicationDeps, openExternal: (url) => shell.openExternal(url) }));
  tools.register(closeApplicationTool);
  for (const tool of createFileTools(folders)) tools.register(tool);
  tools.register(createDocumentTool(folders, gemini));
  // Browser tasks happen in the user's OWN Chrome / Edge — their profile, their tabs, their sign-ins — through the Eya
  // Browser Bridge extension. One session manager decides which browser, reuses their tabs, and never quietly swaps in a
  // separate browser. Eya's own window (a separate, signed-out profile) exists only for when the user explicitly agrees to
  // it; a second, invisible one does web-search lookups when no browser of theirs is connected.
  // EYA_BROWSER_MODE = user_browser (default) | eya_browser | auto. EYA_PREFERRED_BROWSER = chrome | edge.
  const bridgePort = Number(process.env['EYA_BRIDGE_PORT']);
  const chromeBridge = new ChromeBridge({
    secrets: new FileSecretStore(join(app.getPath('userData'), 'chrome-bridge.json')),
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
  const extensionFolder =
    [join(app.getAppPath(), 'eya-chrome-extension'), join(process.resourcesPath ?? '', 'eya-chrome-extension')].find((p) => existsSync(p)) ??
    join(app.getAppPath(), 'eya-chrome-extension');
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
  for (const tool of createOpenTools(folders, {
    opener: {
      openPath: (path) => shell.openPath(path),
      openExternal: (url) => shell.openExternal(url),
    },
    launchBrowser,
  })) {
    tools.register(tool);
  }
  for (const tool of createFileOpsTools(folders)) tools.register(tool);
  for (const tool of createClipboardTools(clipboard)) tools.register(tool);
  tools.register(closeFileTool);
  // Real control of other applications' windows (list, minimise, maximise, restore, close, switch), checked from Windows itself.
  for (const tool of createWindowTools({
    control: createWindowControl(),
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
  })) {
    tools.register(tool);
  }
  // Finding a chat, attaching a file to it, checking it went — and zipping a folder, since a chat app only takes files.
  for (const tool of createChatTools({ service: browserService, policy: communication, session: chatSession, folders })) tools.register(tool);
  for (const tool of createArchiveTools(folders)) tools.register(tool);
  tools.register(createCommunicationStatusTool(communication));
  tools.register(
    createScreenshotTool({
      capture: browserService,
      folders,
      describeLabel: (title) => communication.appForWindow({ process: '', title })?.name ?? title,
      // The screen the mouse is on, or any application's window, through Electron's own capturer.
      screen: createScreenCapture({
        getSources: (options) => desktopCapturer.getSources(options),
        cursorDisplay: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),
        // The capturer enlarges a window's picture to whatever size it is asked for, so ask Windows for the window's real size first.
        windowSize: (sourceId) => queryWindowSize(sourceId),
      }),
    }),
  );

  const window = orb.create();
  const getSender = () => (window.isDestroyed() ? null : window.webContents);

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
  const speechStream = new TtsStreamService(new GeminiTTS(), getSender);
  speechStream.register();

  const router = new IntentRouter();
  const composer = new ResponseComposer();
  const engine = new AgentEngine({
    router,
    tools,
    composer,
    tts,
    context,
    browserContext: () => [browserWorld.summary(), communication.summary()].filter((x) => x !== '').join('\n'),
    ...(ai !== undefined ? { ai } : {}),
    ...(gemini.hasKey() ? { gemini } : {}),
  });
  void permissions; void memory;

  registerLiveBridge({ gemini, tools });
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

  shortcuts.register(() => orb.toggleInput());
  ipcMain.on(IpcChannels.setExpanded, (_evt, expanded: unknown) => orb.setExpanded(expanded === true));

  // Once the renderer is loaded, greet the user so they know Eya is alive
  // and show the input panel so they can immediately act.
  window.webContents.on('did-finish-load', () => {
    const aiKind: StatusMessage['ai'] = gemini.hasKey() ? 'gemini' : 'ollama';
    const status: StatusMessage = {
      ai: gemini.hasKey() ? 'gemini' : (ai !== undefined ? 'ollama' : 'none'),
      aiReady: gemini.hasKey() || ai !== undefined,
      ttsEngine: 'pending',
    };
    getSender()?.send(IpcChannels.status, status);
    getSender()?.send(IpcChannels.showPanel);
    void aiKind;
    // Slight delay to let the renderer wire up TTS listeners.
    setTimeout(() => {
      void tts.speak(GREETING);
    }, 800);
  });

  app.on('window-all-closed', () => { /* orb-only lifecycle */ });
  app.on('will-quit', () => {
    shortcuts.unregisterAll();
    speechStream.cancelAll();
    void tts.dispose();
    void browserService.close();
    void chromeBridge.stop();
  });
  app.on('second-instance', () => orb.show());
}

function buildAIProvider(gemini: GeminiAIProvider): AIProvider | undefined {
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
  providers.push(ollama);

  if (providers.length === 0) return undefined;
  if (providers.length === 1) return providers[0];
  return new ChainedAIProvider(providers);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  app.quit();
});
