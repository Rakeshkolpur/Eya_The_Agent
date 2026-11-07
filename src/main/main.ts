import { existsSync } from 'node:fs';
import { traceAI, traceFileFromEnv, traceTools } from '@main/agent/trace';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BrowserWindow } from 'electron';
import { app, clipboard, desktopCapturer, ipcMain, nativeImage, net, Notification, powerSaveBlocker, screen, session, shell } from 'electron';
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
import { AttachedFiles } from '@main/files/attachedFiles';
import { ChatStore } from '@main/chats/ChatStore';
import { registerChatsIpc } from '@main/chats/chatsIpc';
import { purgeAttachments, registerAttachmentsIpc } from '@main/files/attachmentsIpc';
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
import { makeRefiner } from '@main/local/messageRefine';
import { LiveChatHub } from '@main/livechat/LiveChatHub';
import { RelationBook } from '@main/livechat/RelationBook';
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
import { createSiteTools } from '@main/tools/impl/siteTools';
import { showRecoveryEvent } from '@main/browser/recoveryProgress';
import { createScreenshotTool } from '@main/tools/impl/screenshotTool';
import { createWindowTools } from '@main/tools/impl/windowTools';
import { createCommunicationStatusTool } from '@main/tools/impl/communicationTools';
import { createChatSendGate, createChatTools } from '@main/tools/impl/chatTools';
import { createArchiveTools } from '@main/tools/impl/archiveTools';
import { createScreenTools } from '@main/tools/impl/screenTools';
import { createUiAutomation } from '@main/screen/uiAutomation';
import { ChatSession } from '@main/chat/chatSession';
import { FileSendJournal } from '@main/chat/sendJournal';
import { whatsappConnector } from '@main/plugins/builtin/whatsapp';
import { LocalCatalog } from '@main/plugins/catalog';
import { ChatTaskJournal } from '@main/plugins/chatTaskJournal';
import { PluginManager } from '@main/plugins/PluginManager';
import { PluginStateStore } from '@main/plugins/PluginStateStore';
import { registerPluginsIpc } from '@main/plugins/pluginsIpc';
import { LiveChatController } from '@main/livechat/LiveChatController';
import { LiveChatStore } from '@main/livechat/LiveChatStore';
import { userInfo } from 'node:os';
import { LiveChatSwitch, LiveChatSwitchStore } from '@main/livechat/LiveChatSwitch';
import { EMPTY_LIVE_CHAT_VIEW } from '@shared/liveChat';
import { registerLiveChatIpc } from '@main/livechat/liveChatIpc';
import { KeepAwake, trackAgentWork } from '@main/power/KeepAwake';
import { createChatActions, createChatWatcher } from '@main/livechat/liveChatWiring';
import { createChatMedia } from '@main/livechat/liveChatMedia';
import { createLiveChatTool } from '@main/tools/impl/liveChatTool';
import { ChatTask } from '@main/chat/chatTask';
import { diagnoseChatTools, FileDiagnostics } from '@main/chat/chatDiagnostics';
import { startPageProbe } from '@main/chat/pageProbeRunner';
import { browserAccessLine } from '@main/browser/browserAccess';
import { CommunicationPolicy } from '@main/privacy/communicationAccess';
import { CommunicationAccessStore } from '@main/privacy/communicationAccessStore';
import { registerCommunicationAccessIpc } from '@main/privacy/communicationAccessIpc';
import { startPolicySync } from '@main/privacy/policySync';
import { createWindowControl } from '@main/windowsApi/windowControl';
import { EmbeddedBrowserService } from '@main/browser/EmbeddedBrowserService';
import { ElectronBrowserEnvironment } from '@main/browser/ElectronBrowserEnvironment';
import { BrowserSessionManager, parseBrowserMode } from '@main/browser/BrowserSessionManager';
import { BrowserPanel } from '@main/browser/BrowserPanel';
import { registerBrowserPanelIpc } from '@main/browser/browserPanelIpc';
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
import { currentUserWords, runWithUserWords } from '@main/security/userWords';
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
import { GeminiKeyPool } from '@main/config/geminiKeyPool';
import { createGeminiKeysService, createPoolStateStore, registerGeminiKeysIpc } from '@main/config/geminiKeysIpc';
import { ChainedAIProvider } from '@main/providers/ai/ChainedAIProvider';
import type { ChainStore } from '@main/providers/ai/ChainedAIProvider';
import { SwitchableAIProvider } from '@main/providers/ai/SwitchableAIProvider';
import { MAX_BACKUPS } from '@shared/backupAi';
import { createChosenAiNotice, describeRoute } from '@shared/aiRoute';
import { registerLocalAiIpc } from '@main/config/localAiIpc';
import { languageRule } from '@shared/language';
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

  // (EYA_NO_MIC is only for testing: a test copy of Eya must not react to whatever is said in the room)
  const micAllowed = process.env['EYA_NO_MIC'] !== '1';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media' && micAllowed) { callback(true); return; }
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media' && micAllowed);

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
  // Gemini: the person's own key and any extra keys (family, friends) from Settings, used one after another: when one key's free allowance
  // for the day is spent the next takes over, for answers, documents, transcribing, speech and the live voice alike.
  const gemini = new GeminiKeyPool({
    makeAi: (apiKey) => new GeminiAIProvider({ apiKey }),
    makeSpeech: (apiKey) => new GeminiTTS({ apiKey }),
    state: createPoolStateStore(join(app.getPath('userData'), 'gemini-key-state.json')),
  });
  const geminiKeys = createGeminiKeysService(join(app.getPath('userData'), 'gemini-keys.bin'), gemini, () => process.env['EYA_GEMINI_API_KEY']?.trim() || null, () => chain.clearRests('gemini'));
  geminiKeys.start();
  registerGeminiKeysIpc(geminiKeys, gemini);
  let announceGeminiKeys: () => void = () => undefined;
  gemini.onChange(() => announceGeminiKeys());
  // The backup AI: a second online service (the user's own key, set in Settings) that takes over when Gemini's free allowance for the
  // day is used up or Gemini is overloaded. It starts empty and is filled — without a restart — when a key is saved.
  // One slot per backup AI the user can have, asked in order after Gemini; an empty slot is skipped.
  const backupSlots = Array.from({ length: MAX_BACKUPS }, (_, i) => new SwitchableAIProvider(`backup${i + 1}`));
  // The local AI (Ollama): no key, nothing leaves this PC. Its model, language and whether it may hand a hard request to a cloud AI follow Settings.
  const ollama = new OllamaAIProvider({
    model: () => process.env['EYA_OLLAMA_MODEL']?.trim() || settingsStore.get().localModel,
    languageRule: () => languageRule(settingsStore.get().language),
    mayHandOver: () => settingsStore.get().aiFirst !== 'local-only',
    // (only for testing: so a model that never answers is given up on quickly)
    ...(Number(process.env['EYA_OLLAMA_FIRST_WORD_MS']) > 0 ? { firstWordMs: Number(process.env['EYA_OLLAMA_FIRST_WORD_MS']) } : {}),
  });
  const chain = buildAIProvider(gemini, backupSlots, ollama, createChainStore(join(app.getPath('userData'), 'ai-state.json')));
  // (EYA_TRACE_FILE is only for diagnosing: the AI's raw answers and every tool run are written to that file)
  const traceFile = traceFileFromEnv();
  const ai: AIProvider = traceFile !== null ? traceAI(chain, traceFile) : chain;
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
      local: { ready: ollama.isReady(), model: ollama.currentModel() ?? '' },
      now: Date.now(),
    });
  };
  const chosenAiNotice = createChosenAiNotice(aiRouteStatus);
  let announceAiRoute: () => void = () => undefined;
  chain.onChange(() => announceAiRoute());
  // Which AI is asked first: Gemini (auto), the first backup, the local AI first with the cloud as a help, or the local AI alone (nothing is
  // handed to a cloud AI). The local model is loaded into memory ahead of the first question only while it is the one being used.
  const applyAiFirst = (): void => {
    const first = settingsStore.get().aiFirst;
    chain.restrictTo(first === 'local-only' ? ollama : null);
    chain.setPreferred(first === 'backup' ? (backupSlots[0] ?? null) : first === 'local' ? ollama : null);
    if (first === 'local' || first === 'local-only') void ollama.warm();
  };
  applyAiFirst();
  settingsStore.onChange(() => applyAiFirst());
  ollama.onChange(() => announceAiRoute());
  ollama.startMonitoring();
  registerLocalAiIpc(ollama, settingsStore, () => (process.env['EYA_OLLAMA_MODEL']?.trim() ?? '') !== '');
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
  if (traceFile !== null) traceTools(tools, traceFile);
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
  // A file attached to a message with no place on disk (a pasted picture) is kept here for a few days and read from here.
  const attachmentsDir = join(app.getPath('userData'), 'attachments');
  void purgeAttachments(attachmentsDir);
  registerAttachmentsIpc(attachmentsDir);
  const attachedFiles = new AttachedFiles();
  tools.register(createDocumentTool(folders, gemini, { attachmentsDir, attached: attachedFiles }));
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
  // (only for finding out how a real chat page is built: writes its structure, never its content, to page-probe.jsonl; reads only)
  if (process.env['EYA_PAGE_PROBE'] !== undefined && process.env['EYA_PAGE_PROBE'] !== '') {
    startPageProbe({ bridge: chromeBridge, file: join(app.getPath('userData'), 'page-probe.jsonl'), host: process.env['EYA_PAGE_PROBE'] === '1' ? 'web.whatsapp.com' : (process.env['EYA_PAGE_PROBE'] as string) });
  }
  // Communication Access: the user's privacy switch for chat apps (WhatsApp, Telegram, Instagram…). OFF unless they turn it on in
  // Eya's panel; a missing or damaged settings file means OFF. The browser extension is kept in step with it.
  const communicationStore = new CommunicationAccessStore(join(app.getPath('userData'), 'communication-access.json'));
  communicationStore.load();
  const communication = new CommunicationPolicy(() => communicationStore.get());
  startPolicySync({ bridge: chromeBridge, blockRules: () => communication.blockRules(), onPolicyChange: (cb) => communicationStore.onChange(() => cb()) });
  // What Eya remembers about the chat she is working in (memory only): forgotten the moment Communication Access is narrowed.
  // (and a fingerprint of each recent send — never a name or a word — so that a repeat after Eya was closed is looked at, not sent a second time)
  const chatSession = new ChatSession(undefined, undefined, new FileSendJournal(join(app.getPath('userData'), 'send-journal.json')));
  // Plugins: what is installed, connected and allowed. Built once the tools they name are registered (below); until then nothing is held back.
  let pluginManager: PluginManager | null = null;
  // Eya's memory database (opened further down). Declared here because the chat tools below tell its contact book which chats they see.
  let memory: MemoryService | null = null;
  communicationStore.onChange((s) => {
    if (!s.enabled || Object.values(s.apps).some((allowed) => !allowed)) chatSession.clear();
  });
  const browserMode = parseBrowserMode(process.env['EYA_BROWSER_MODE']);
  const preferredEnv = (process.env['EYA_PREFERRED_BROWSER'] ?? '').toLowerCase();
  log.info('browser mode', { browserMode, ...(preferredEnv !== '' ? { preferred: preferredEnv } : {}) });
  // The Browser page: where the task works, what it is doing, and the user's controls (pause, stop, take over).
  const browserPanel = new BrowserPanel({ preference: settingsStore.get().browser });
  settingsStore.onChange((s) => browserPanel.setPreference(s.browser));
  // Eya Browser: Eya's own browser, drawn inside the Eya window by the Chromium that is already part of Eya (nothing to install). It has a
  // profile of its own that keeps its sign-ins; the Browser page says where on the window it is drawn.
  let appWindow: BrowserWindow | null = null;
  const eyaEnvironment = new ElectronBrowserEnvironment({
    getWindow: () => appWindow,
    partition: 'persist:eya-browser',
    // (only for testing: so a test never fills the real Downloads folder)
    downloadsDir: process.env['EYA_BROWSER_DOWNLOADS'] ?? app.getPath('downloads'),
    reveal: () => orb.openApp('browser'),
  });
  const eyaBrowser = new EmbeddedBrowserService({
    env: eyaEnvironment,
    // (only for testing: so a page that never answers is given up on quickly)
    ...(Number(process.env['EYA_BROWSER_NAV_TIMEOUT_MS']) > 0 ? { navTimeoutMs: Number(process.env['EYA_BROWSER_NAV_TIMEOUT_MS']) } : {}),
  });
  // Reading a search results page: a browser nobody sees, with nothing kept.
  const lookupEnvironment = new ElectronBrowserEnvironment({
    getWindow: () => null,
    partition: 'eya-lookup',
    downloadsDir: join(app.getPath('userData'), 'lookup-downloads'),
    reveal: () => undefined,
    hidden: true,
  });
  const browserService = new BrowserSessionManager({
    bridge: chromeBridge,
    world: browserWorld,
    isolated: eyaBrowser,
    activity: browserPanel,
    words: () => currentUserWords(),
    preference: () => settingsStore.get().browser,
    lookup: new EmbeddedBrowserService({ env: lookupEnvironment }),
    launcher: createBrowserLauncher({
      findExe: findAppExe,
      // (only for testing: a test must not start the real Chrome or Edge of whoever is running it)
      launch: (browser, url) => (process.env['EYA_NO_BROWSER_LAUNCH'] === '1' ? Promise.resolve(false) : launchBrowser(browser, url)),
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
    chatGate: createChatSendGate(chatSession, communication, { permitsApp: (appId, permission) => pluginManager?.permitsApp(appId, permission) ?? null }),
    // A verification code the user said and Eya typed: whatever was waiting for that code is over, and the conversation carries on.
    onCodeEntered: () => {
      taskCompleter.userContinued();
    },
  })) {
    tools.register(tool);
  }
  // A site that may have moved (its new address found and checked) and a download carried out from start to finish and checked: what they are
  // doing shows in "Your Agent at Work".
  for (const tool of createSiteTools({
    service: browserService,
    folders,
    // (where the browser saves what it downloads: the Downloads folder)
    downloadsDir: process.env['EYA_BROWSER_DOWNLOADS'] ?? app.getPath('downloads'),
    progress: (event) => showRecoveryEvent(browserPanel, event),
    // (the page's own direct link, when clicking its control starts nothing; the user's yes was given to download_from_site)
    directDownload: (url) => tools.invoke('download_file', { url, confirm: true }),
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
  for (const tool of createChatTools({ service: browserService, policy: communication, session: chatSession, folders, names: chatNames, country: () => settingsStore.get().country })) tools.register(tool);
  // The Live Chat Companion: ONE chat the person chose is watched (the page tells Eya when it changes), each new message is read, a reply is drafted, and it is sent
  // only as far as the person allowed. It works through the same tools (find_chat, fill_on_page and click_on_page behind the Send gate, verify_sent) and the same
  // plugin permissions as every other WhatsApp action; the tool below can start, pause, resume and stop it but never approve or send a reply.
  // The ONE "Enable live chat" switch (made below, once the plugins exist): it puts everything the live chat needs in place with one click on Eya's own page.
  let liveChatSwitch: LiveChatSwitch | null = null;
  // (one controller per live chat that runs: the first keeps the file it always had, the others have a file each; the hub below lets them take turns)
  const makeLiveChat = (slot: number): LiveChatController => new LiveChatController({
    store: new LiveChatStore(join(app.getPath('userData'), slot === 0 ? 'live-chat.json' : `live-chat-${slot + 1}.json`)),
    enable: {
      view: () => liveChatSwitch?.view() ?? EMPTY_LIVE_CHAT_VIEW.enable,
      standing: () => liveChatSwitch?.standing() === true,
      turnOn: () => liveChatSwitch?.turnOn() ?? { ok: false, message: 'The live chat switch is not ready yet.' },
      turnOff: () => liveChatSwitch?.turnOff() ?? { ok: false, message: 'The live chat switch is not ready yet.' },
      ownerName: () => liveChatSwitch?.ownerName() ?? '',
      setOwnerName: (name) => liveChatSwitch?.setOwnerName(name) ?? { ok: false, message: 'The live chat switch is not ready yet.' },
    },
    ai,
    watcher: createChatWatcher(chromeBridge, browserService),
    chat: createChatActions({
      tools: { invoke: (name, args) => tools.invoke(name, args) },
      service: browserService,
      session: chatSession,
      // (a send is kept as a task like any other WhatsApp send: the Tasks card and the send journal)
      beginTask: (label, text) =>
        new ChatTask(
          'whatsapp',
          'message',
          { query: label, isNumber: false },
          text,
          chatDiagnostics,
          undefined,
          new ChatTaskJournal({
            beginPlugin: (info) => taskCompleter.beginPlugin(info),
            pluginUpdate: (key, change) => taskCompleter.pluginUpdate(key, change),
            pluginFinish: (key, outcome, note) => taskCompleter.pluginFinish(key, outcome, note),
          }),
        ),
    }),
    permits: (permission) => pluginManager?.permitsApp('whatsapp', permission) ?? null,
    allowed: () => {
      const whatsapp = communication.apps().find((a) => a.id === 'whatsapp');
      return whatsapp !== undefined && communication.allowed(whatsapp) ? null : 'Chats are switched off for WhatsApp in Eya.';
    },
    // (why a live chat stopped or could not start: a category and counts, written to the same privacy-safe file as every other chat step)
    diagnose: (event) => chatDiagnostics.record({ task: 'livechat', op: event.op, ...(event.category !== undefined ? { category: event.category } : {}), ...(event.counts !== undefined ? { counts: event.counts } : {}) }),
    // (never the words of a message: only that something needs the person)
    alert: (message) => {
      if (Notification.isSupported()) new Notification({ title: 'Eya — live chat', body: message, silent: false }).show();
    },
    // What the other person asked Eya to pass on, said TO the person: shown in the chat with Eya, and spoken (see orb.tsx `onTasksSay`)
    say: (spoken, shown) => getSender()?.send(IpcChannels.tasksSay, { text: spoken, kind: 'relay', display: shown }),
    // Pictures and documents the other person sends: taken into the Downloads folder (and nowhere else) and read, so Eya can say what it is and ask why it was sent
    media: createChatMedia({ service: browserService, downloadsDir: folders.downloads, tools: { invoke: (name, args) => tools.invoke(name, args) } }),
  });
  // Several live chats at once (the setting "Several live chats at once"; on by default): they take turns in the one WhatsApp page, see LiveChatHub.
  const liveChat = new LiveChatHub({ make: makeLiveChat, multi: () => settingsStore.get().multiLiveChats });
  // Who each person is to the person (asked once before a live chat; a hash of the name or number is kept, never the name or the number)
  const liveRelations = new RelationBook(join(app.getPath('userData'), 'live-chat-relations.json'));
  tools.register(createLiveChatTool(liveChat));
  // The plugins that ship with Eya (WhatsApp first), over the tools registered above. A tool of a plugin that is not installed, switched on, connected and
  // allowed is not offered to the AI and is refused if called; installing a plugin connects and allows nothing; WhatsApp's connection is the same switch as
  // Communication Access, not a second one.
  pluginManager = new PluginManager({
    catalog: new LocalCatalog(),
    store: new PluginStateStore(join(app.getPath('userData'), 'plugins.json')),
    connectors: { whatsapp: whatsappConnector(communication, communicationStore) },
    eyaVersion: app.getVersion(),
    knownTools: () => new Set(tools.list().map((t) => t.schema.name)),
  });
  const plugins: PluginManager = pluginManager;
  // (what Eya calls the person in the chat: the name they set on the Live chat page, else their Windows account's name unless it is a generic one)
  const windowsName = (): string => {
    try {
      const raw = userInfo().username.trim();
      return /^(admin|administrator|user|owner|pc|guest|default|home)$/i.test(raw) ? '' : raw.charAt(0).toUpperCase() + raw.slice(1);
    } catch {
      return '';
    }
  };
  liveChatSwitch = new LiveChatSwitch(plugins, new LiveChatSwitchStore(join(app.getPath('userData'), 'live-chat-switch.json')), Date.now, windowsName);
  // (what the switch shows follows the plugin and Chats: a permission taken away on the Plugins page shows on the Live chat page at once)
  plugins.onChange(() => liveChat.refresh());
  communicationStore.onChange(() => liveChat.refresh());
  tools.setGuard({ blocked: (name) => plugins.blockFor(name), observe: (name, result) => plugins.observe(name, result) });
  // (Communication Access is how WhatsApp is connected: when it changes, the Plugins page shows the new state)
  communicationStore.onChange(() => plugins.refresh());
  // Why a chat action failed, written down in a way that holds no message, name or number (see chat/chatDiagnostics.ts): the model's own chat steps and the
  // fast layer's alike. Kept small, on this PC only.
  const chatDiagnostics = new FileDiagnostics(join(app.getPath('userData'), 'chat-diagnostics.jsonl'));
  diagnoseChatTools(tools, chatDiagnostics);
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
  appWindow = window;
  const getSender = () => (window.isDestroyed() ? null : window.webContents);
  announceAiRoute = () => getSender()?.send(IpcChannels.aiRoute, aiRouteStatus());
  announceGeminiKeys = () => getSender()?.send(IpcChannels.geminiKeysChanged, geminiKeys.status());
  // The conversations kept on this PC (the chat history in the sidebar); opening or starting one also resets what the assistant remembers of the talk.
  const chatStore = new ChatStore(join(app.getPath('userData'), 'chats.json'), undefined, 300);
  app.on('will-quit', () => chatStore.flush());
  registerChatsIpc({ store: chatStore, context, enabled: () => settingsStore.get().keepChats, send: (channel, payload) => getSender()?.send(channel, payload) });
  // (set once the engine exists: the Stop of the Browser page ends the request being worked on)
  let stopWork: () => number = () => 0;
  const browserPanelIpc = registerBrowserPanelIpc({
    panel: browserPanel,
    eya: eyaBrowser,
    bridge: chromeBridge,
    connector: chromeConnector,
    openExternal: (url) => void shell.openExternal(url),
    send: (channel, payload) => getSender()?.send(channel, payload),
    setPreference: (kind) => settingsStore.update({ browser: kind }),
    onStop: () => void stopWork(),
  });
  app.on('will-quit', () => {
    browserPanelIpc.dispose();
    eyaEnvironment.dispose();
    lookupEnvironment.dispose();
  });

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
  const speechStream = new TtsStreamService(gemini.speech, getSender, new OpenAITTS({ getKey: () => backupAi.keyFor('openai'), ...(process.env['EYA_OPENAI_BASE_URL']?.trim() ? { config: { baseUrl: process.env['EYA_OPENAI_BASE_URL'].trim() } } : {}) }));
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
  // Whether WhatsApp for Windows is installed: its web-address handler (whatsapp:) is registered. Looked at at most every few minutes.
  let whatsappSeen: { at: number; yes: boolean } | null = null;
  const whatsappInstalled = (): boolean => {
    if (whatsappSeen !== null && Date.now() - whatsappSeen.at < 5 * 60_000) return whatsappSeen.yes;
    let yes = false;
    try {
      execFileSync('reg.exe', ['query', 'HKCR\\whatsapp', '/ve'], { stdio: 'ignore', windowsHide: true, timeout: 3000 });
      yes = true;
    } catch {
      yes = false;
    }
    whatsappSeen = { at: Date.now(), yes };
    return yes;
  };
  const chatCommands =
    memory === null
      ? undefined
      : new ChatCommands({
          tools,
          contacts: memory.contacts,
          policy: communication,
          session: chatSession,
          // (what the person says to tell someone is written properly, shown, and sent only on their yes; a readable message even when no AI answers in time)
          refine: makeRefiner(ai),
          relations: liveRelations,
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
          // The installed program of a chat app (WhatsApp for Windows), checked first; its own link is opened for a message to a phone number.
          installedApp: (id) => id === 'whatsapp' && whatsappInstalled(),
          openAppLink: async (url) => {
            if (!/^whatsapp:\/\/send\?phone=\d{10,15}&text=/.test(url)) return false;
            try {
              await shell.openExternal(url);
              return true;
            } catch {
              return false;
            }
          },
          chatAppOpen: () => (['chrome', 'edge'] as const).some((b) => browserWorld.tabsOf(b).some((t) => communication.appForUrl(t.url) !== null)),
          diagnostics: chatDiagnostics,
          // Every request is kept as a task through the plugin for its app (what it settled on, what was seen, where it stands), as it happens.
          journal: new ChatTaskJournal({
            beginPlugin: (info) => taskCompleter.beginPlugin(info),
            pluginUpdate: (key, change) => taskCompleter.pluginUpdate(key, change),
            pluginFinish: (key, outcome, note) => taskCompleter.pluginFinish(key, outcome, note),
          }),
          permits: (appId, permission) => plugins.permitsApp(appId, permission),
          liveChat,
          // A phone number said without its country code is read as a number of this country (Settings; India until another is chosen).
          country: () => settingsStore.get().country,
          // A browser with the Eya extension is connected: a chat is worked in the app's web page (typed, sent and checked), not in the installed program.
          browserReady: () => Object.values(chromeBridge.info().browsers).some((b) => b?.connected === true),
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
    // An address the person typed that is not one of the well-known sites is looked at first: a dead one is handed to the assistant, who finds the right one.
    probe: async (url) => {
      try {
        const r = await net.fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) });
        void r.body?.cancel();
        // (a site that refuses a visitor like this one, or limits it, is alive: only "gone" and "broken" count as dead)
        return r.status !== 404 && r.status !== 410 && r.status < 500;
      } catch {
        return false;
      }
    },
  });
  locateFileForChat = (words) => local.locateFile(words);
  // What the person asked for is kept until it is done: a slow page, an AI that is out for the day, a CAPTCHA to tick, a question waiting for a
  // yes. The completer tries again by itself (through the same engine, told what was already done), watches the browser while the person
  // does a check, and tells them by notification when it is finished or needs them.
  // While Eya works for the person (a request, a task, a tool of the live voice) the PC is kept from sleeping, so she does not go offline in the middle of it.
  const keepAwake = new KeepAwake(powerSaveBlocker);
  setInterval(() => keepAwake.sweep(), 60_000).unref();
  app.on('will-quit', () => keepAwake.releaseAll());
  const taskCompleter: TaskCompleter = new TaskCompleter({
    store: new TaskStore(join(app.getPath('userData'), 'tasks.json')),
    run: (task): Promise<AgentResult> =>
      engine.handle(
        { requestId: `task-${task.id}-${task.attempts}`, text: task.request, source: 'text', resume: { steps: task.steps, note: task.note, ...(task.done !== undefined && task.done.length > 0 ? { done: task.done } : {}) } },
        (update: AgentUpdate) => getSender()?.send(IpcChannels.agentUpdate, update),
      ),
    // (a task that is stopped ends the request behind it at once)
    stopRequest: (requestId) => void engine.stopRequest(requestId),
    notify: createTaskNotifier(() => orb.openApp()),
    say: (text, kind) => getSender()?.send(IpcChannels.tasksSay, { text, kind }),
    watchBrowser: async (ms) => (await browserService.waitForUserChange(ms)).changed,
    onChange: () => {
      const snapshot = taskCompleter.snapshot();
      keepAwake.setTasksOpen(snapshot.open); // a task Eya is keeping holds the PC awake until it is over
      getSender()?.send(IpcChannels.tasksChanged, snapshot);
    },
  });
  registerTasksIpc(taskCompleter);
  const taskCommands: TaskCommands = new TaskCommands(taskCompleter);
  // The requests that tools have started working on: only those can be shown as tasks (a greeting that a slow AI took long over is not one).
  const workedOn = new Set<string>();
  const engine = new AgentEngine({
    router,
    tools,
    composer,
    tts,
    context,
    local,
    tasks: taskCommands,
    attached: attachedFiles,
    workStarted: (requestId) => workedOn.add(requestId),
    // (what a request has done that cannot be done twice is kept with its task as it happens, so being cut off does not repeat it)
    checkpoint: (requestId, progress) => taskCompleter.checkpoint(requestId, progress),
    // (a task the person has stopped does not go on with the rest of its steps)
    shouldStop: (requestId) => taskCompleter.wasStopped(requestId),
    // (Pause holds the whole request: no new AI step and no new tool until it is resumed)
    waitWhilePaused: (signal) => browserPanel.waitWhilePaused(signal),
    // (Run with the person's own words attached: a verification code is typed only if they said it.)
    around: async (req, run) => {
      browserPanel.beginRequest(req.text);
      try {
        return await runWithUserWords(req.text, () => trackRequest(taskCompleter, req, run, { isWork: () => workedOn.has(req.requestId) }));
      } finally {
        workedOn.delete(req.requestId);
        browserPanel.endRequest();
      }
    },
    progress: () => describeProgress(taskCompleter.openTasks(), Date.now()),
    aiNote: chosenAiNotice,
    language: () => settingsStore.get().language,
    ...(chatCommands !== undefined ? { chat: chatCommands } : {}),
    writing: writingAndWord,
    browserContext: () => [browserWorld.summary(), communication.summary(), plugins.summary()].filter((x) => x !== '').join('\n'),
    // (what the model's hands in the browser are, for a request about a website: connected and ready, or exactly what is missing)
    browserAccess: () => browserAccessLine(browserService.describe()),
    // (a click that found nothing: she looks at the person's browser window herself unless they turned that off; their own Chrome or Edge only, never her own browser)
    autoLook: async (question) => {
      if (settingsStore.get().autoScreenLook === false) return null;
      const browser = browserService.pinnedBrowser();
      if (browser === null) return null;
      const r = await tools.invoke('describe_screen', { target: 'window', window: browser === 'edge' ? 'Edge' : 'Chrome', question, confirm: true });
      const description = r.data?.['description'];
      return r.ok && typeof description === 'string' ? description : null;
    },
    ...(ai !== undefined ? { ai } : {}),
    ...(gemini.hasKey() ? { gemini } : {}),
    ...(memory !== null ? { memory } : {}),
    ...(activityLog !== undefined ? { activity: activityLog } : {}),
  });
  // The Stop of the Browser page ends the request being worked on, on the spot (not only the browser steps after it).
  stopWork = () => engine.stopAll();
  void permissions;

  // Talk mode: the live model gets ONE extra tool, quick_command, that runs the same chat and everyday-command layers on what the user
  // actually said (so messaging by name, files, folders, sites and downloads work there without a model step per page action).
  const quick = new QuickCommands([taskCommands, writingAndWord, ...(chatCommands !== undefined ? [chatCommands] : []), local]);
  let liveWork = 0;
  registerLiveBridge({ gemini, tools, quick, context, tasks: taskCompleter, work: { begin: () => { const name = `live:${++liveWork}`; keepAwake.hold(name); return () => keepAwake.release(name); } }, browserRequest: { begin: (text) => browserPanel.beginRequest(text), end: () => browserPanel.endRequest() }, language: () => settingsStore.get().language, progress: () => describeProgress(taskCompleter.openTasks(), Date.now()), ...(memory !== null ? { memory } : {}), ...(activityLog !== undefined ? { activity: activityLog } : {}) });

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
  registerPluginsIpc({ manager: plugins, notify: (snapshot) => getSender()?.send(IpcChannels.pluginsChanged, snapshot) });
  registerLiveChatIpc({ controller: liveChat, notify: (view) => getSender()?.send(IpcChannels.liveChatChanged, view) });
  // A live chat that was running when Eya closed comes back PAUSED: nothing is watched or sent until the person resumes it.
  liveChat.restore();
  // Switching Chats off, or taking the plugin's permission away, pauses it at once (it does not wait for the next message to find out).
  const pauseLiveChatIfNotAllowed = (): void => {
    if (!liveChat.view().active) return;
    const why = pluginManager?.permitsApp('whatsapp', 'chats.live') ?? null;
    const whatsapp = communication.apps().find((a) => a.id === 'whatsapp');
    if (why !== null || whatsapp === undefined || !communication.allowed(whatsapp)) void liveChat.pause('access_off', 'Chats or the live chat permission were switched off, so the live chat is paused.');
  };
  communicationStore.onChange(pauseLiveChatIfNotAllowed);
  plugins.onChange(pauseLiveChatIfNotAllowed);

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

  const ipc = new IpcRouter(engine, engine, (update) => trackAgentWork(keepAwake, update));
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
    ollama.stopMonitoring();
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

function buildAIProvider(gemini: GeminiKeyPool, backups: readonly AIProvider[], ollama: OllamaAIProvider, store: ChainStore): ChainedAIProvider {
  const providers: AIProvider[] = [];
  if (gemini.hasKey()) {
    log.info('AI: Gemini enabled (primary)');
    providers.push(gemini);
  } else {
    log.info('AI: Gemini disabled (no EYA_GEMINI_API_KEY)');
  }
  // Order: Gemini, then the user's online backups (if they set any), then the local Ollama if it is running (or first, or alone, when the
  // person chooses the local AI: see applyAiFirst).
  providers.push(...backups, ollama);
  return new ChainedAIProvider(providers, { store });
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  app.quit();
});
