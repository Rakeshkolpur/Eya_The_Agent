import { app, clipboard, ipcMain, session, shell } from 'electron';
import { OrbWindow } from '@main/windows/OrbWindow';
import { GlobalShortcutManager } from '@main/shortcuts/GlobalShortcut';
import { IpcRouter } from '@main/ipc/ipcRouter';
import { AgentEngine } from '@main/agent/AgentEngine';
import { IntentRouter } from '@main/agent/IntentRouter';
import { ResponseComposer } from '@main/agent/ResponseComposer';
import { ToolRegistry } from '@main/tools/ToolRegistry';
import { openApplicationTool } from '@main/tools/impl/openApplication';
import { closeApplicationTool } from '@main/tools/impl/closeApplication';
import { createFileTools } from '@main/tools/impl/fileTools';
import { createDocumentTool, createWebSearchTool } from '@main/tools/impl/documentTools';
import { createOpenTools } from '@main/tools/impl/openTools';
import { createFileOpsTools } from '@main/tools/impl/fileOpsTools';
import { createClipboardTools } from '@main/tools/impl/clipboardTools';
import { closeFileTool } from '@main/tools/impl/closeFile';
import { createSystemTools, defaultSystemControlDeps } from '@main/tools/impl/systemTools';
import { createRecycleBinTools } from '@main/tools/impl/recycleBinTools';
import { launchBrowser } from '@main/windowsApi/appPaths';
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
  tools.register(openApplicationTool);
  tools.register(closeApplicationTool);
  for (const tool of createFileTools(folders)) tools.register(tool);
  tools.register(createDocumentTool(folders, gemini));
  tools.register(createWebSearchTool(gemini));
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
  for (const tool of createSystemTools({ ...defaultSystemControlDeps, openExternal: (url) => shell.openExternal(url) })) {
    tools.register(tool);
  }
  for (const tool of createRecycleBinTools(folders)) tools.register(tool);

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
    ...(ai !== undefined ? { ai } : {}),
    ...(gemini.hasKey() ? { gemini } : {}),
  });
  void permissions; void memory;

  registerLiveBridge({ gemini, tools });

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
