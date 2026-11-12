import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLaunchArgs } from '@mona/adapter';
import { CatalogService } from './catalog-service.js';
import { registerCatalogIpc } from './catalog-ipc.js';
import { createAppInfo, registerIpc } from './ipc.js';
import { EngineHost } from './engine-host.js';
import { resolveEngineExecutable } from './engine-host-config.js';
import { openLocalState, type LocalState } from './local-state.js';
import { runLifecycleProbe } from './lifecycle-probe.js';
import { runCatalogProbe } from './catalog-probe.js';
import { runShots } from './shots.js';
import { UiStateStore } from './ui-state.js';
import { cspFor, isTrustedSenderFrame, isTrustedAppUrl, windowOptions } from './security.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererIndex = path.join(here, '..', 'renderer', 'index.html');
const preloadPath = path.join(here, '..', 'preload', 'preload.cjs');
const devServerUrl = process.env.MONA_DEV_SERVER_URL;
const isDev = Boolean(devServerUrl);
const smokeTest = process.argv.includes('--smoke-test');
const lifecycleTest = process.argv.includes('--lifecycle-test');
const smokeOut = process.env.MONA_SMOKE_OUT ?? path.join(process.cwd(), 'mona-smoke.json');
const lifecycleOut = process.env.MONA_LIFECYCLE_OUT ?? path.join(process.cwd(), 'mona-lifecycle.json');
const shotsTest = process.argv.includes('--shots');
const shotsDir = process.env.MONA_SHOTS_DIR ?? path.join(process.cwd(), 'mona-shots');
const shotsManifest = process.env.MONA_SHOTS_MANIFEST ?? path.join(shotsDir, 'manifest.json');
const lifecycleWorkspace = process.env.MONA_LIFECYCLE_WORKSPACE ?? null;
const catalogTest = process.argv.includes('--catalog-test');
const catalogOut = process.env.MONA_CATALOG_OUT ?? path.join(process.cwd(), 'mona-catalog.json');
const catalogWorkspace = process.env.MONA_CATALOG_WORKSPACE ?? null;
const catalogShots = process.env.MONA_CATALOG_SHOTS ?? path.join(process.cwd(), 'mona-catalog-shots');
// The P06 fixture harness is development-only. A production window must never
// render fixture projects, fake spend, or fake engine badges.
const harnessEnabled = isDev || process.env.MONA_ALLOW_HARNESS === '1';
const trustOptions = { indexPath: rendererIndex, ...(devServerUrl ? { devServerUrl } : {}) };

// Evidence runs and tests must never write into the real user profile.
const userDataOverride = process.env.MONA_USER_DATA;
if (userDataOverride && userDataOverride.trim()) {
  app.setPath('userData', path.resolve(userDataOverride));
}

// Screenshot capture is unreliable on a headless or remote desktop with GPU
// compositing; software rendering makes capturePage deterministic.
if (shotsTest) app.disableHardwareAcceleration();

const engineHost = new EngineHost({
  ownershipDir: path.join(app.getPath('userData'), 'runtime'),
  executable: resolveEngineExecutable(),
  parentPid: process.pid,
});

const pendingLaunchPaths: string[] = [];
let localState: LocalState | null = null;
let quitRequested = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let mainWindow: BrowserWindow | null = null;

if (!app.requestSingleInstanceLock()) {
  // The existing owner receives this argv through its own second-instance event.
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const paths = parseLaunchArgs(['mona', ...argv.slice(1)], process.cwd());
    pendingLaunchPaths.push(...paths);
    engineHost.handleSignal('second-instance');
    if (!mainWindow) {
      mainWindow = createMainWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (!isTrustedAppUrl(url, trustOptions)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!isTrustedAppUrl(url, trustOptions)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [cspFor(devServerUrl ? { devServerUrl } : {})],
          'X-Content-Type-Options': ['nosniff'],
        },
      });
    });

    const trustedSender = (event: unknown): boolean =>
      isTrustedSenderFrame(event as { senderFrame?: { url: string; parent: unknown } | null }, trustOptions);

    // Reconciliation never starts inference or a runtime: it inspects ownership
    // records and terminates only processes this install can still identify.
    // Local state opens before any project work: migrations run under the
    // maintenance barrier and a pre-migration backup is kept. A state failure is
    // reported, never hidden, and it never starts inference.
    let stateDetail = 'Local state is not open yet.';
    try {
      localState = await openLocalState(path.join(app.getPath('userData'), 'state'));
      engineHost.bindJournal(localState.journal);
      stateDetail = `Local state open at schema v${localState.schemaVersion}.`;
      if (localState.migrations.applied.length > 0) {
        process.stderr.write(
          `mona: applied ${localState.migrations.applied.length} state migration(s) to version ${localState.schemaVersion}\n`,
        );
      }
    } catch (error) {
      stateDetail = `Local state unavailable: ${String(error).slice(0, 200)}`;
      process.stderr.write(`mona: local state unavailable: ${String(error)}\n`);
    }

    let catalogService: CatalogService | null = null;
    if (localState) {
      const uiState = new UiStateStore({ file: path.join(app.getPath('userData'), 'state', 'ui-state.json') });
      catalogService = new CatalogService({
        store: localState.store,
        ui: uiState,
        engine: engineHost,
        pickFolder: async (purpose) => {
          const options = {
            title: purpose === 'open' ? 'Open a project folder' : 'Choose where to create the project',
            properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
          };
          const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
          const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
          return picked.canceled ? null : (picked.filePaths[0] ?? null);
        },
        reveal: async (target) => {
          const failure = await shell.openPath(target);
          return {
            ok: failure === '',
            detail: failure === '' ? 'Opened the folder in File Explorer.' : failure,
          };
        },
      });
    }

    registerIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      getAppInfo: () => {
        const engine = engineHost.summary();
        return createAppInfo({
          version: app.getVersion(),
          electron: process.versions.electron ?? 'unknown',
          chrome: process.versions.chrome ?? 'unknown',
          node: process.versions.node ?? 'unknown',
          platform: process.platform,
          arch: process.arch,
          engine: {
            status: engine.state,
            detail: engine.detail,
            descriptors: engine.descriptors,
            workspace: engine.workspace,
            pid: engine.pid,
            endpoint: engine.endpoint,
            compatibility: engine.compatibility,
          },
          localState: {
            available: localState !== null,
            schemaVersion: localState?.schemaVersion ?? null,
            detail: stateDetail,
          },
          harnessEnabled,
        });
      },
    });
    registerCatalogIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      service: catalogService,
    });

    const reconciled = await engineHost.reconcile();
    if (reconciled.unverifiable > 0) {
      process.stderr.write(
        `mona: ${reconciled.unverifiable} ownership record(s) name a live process Mona cannot identify; leaving them alone\n`,
      );
    }

    mainWindow = createMainWindow();
    if (smokeTest) {
      runSmoke(mainWindow, smokeOut).catch((error: unknown) => {
        fs.writeFileSync(smokeOut, JSON.stringify({ ok: false, error: String(error) }, null, 2), 'utf8');
        app.exit(1);
      });
    }
    if (shotsTest) {
      const window = mainWindow;
      runShots({
        rendererIndex,
        outputDirectory: shotsDir,
        manifestFile: shotsManifest,
        window,
      }).catch((error: unknown) => {
        fs.writeFileSync(shotsManifest, JSON.stringify({ ok: false, error: String(error) }, null, 2), 'utf8');
        app.exit(1);
      });
      return;
    }
    if (lifecycleTest && lifecycleWorkspace) {
      runLifecycleProbe({
        host: engineHost,
        workspace: lifecycleWorkspace,
        getWindow: () => mainWindow,
        signalSecondInstance: () => {
          app.emit('second-instance', { preventDefault() {} }, ['mona', lifecycleWorkspace]);
        },
        outputPath: lifecycleOut,
      })
        .then((result) => {
          const window = mainWindow as BrowserWindow | null;
          if (window && !window.isDestroyed()) window.destroy();
          app.exit(result.ok ? 0 : 1);
        })
        .catch((error: unknown) => {
          fs.writeFileSync(lifecycleOut, JSON.stringify({ ok: false, error: String(error) }, null, 2), 'utf8');
          app.exit(1);
        });
    }
    if (catalogTest && catalogWorkspace) {
      runCatalogProbe({
        window: mainWindow,
        rendererIndex,
        workspace: catalogWorkspace,
        shotsDirectory: catalogShots,
        outputPath: catalogOut,
        engine: engineHost,
      })
        .then((result) => {
          const window = mainWindow as BrowserWindow | null;
          if (window && !window.isDestroyed()) window.destroy();
          app.exit(result.ok ? 0 : 1);
        })
        .catch((error: unknown) => {
          fs.writeFileSync(catalogOut, JSON.stringify({ ok: false, error: String(error) }, null, 2), 'utf8');
          app.exit(1);
        });
    }
  });

  // Quit and stop work: interrupt the active turn, then stop owned children.
  // Electron stays alive until the bounded stop finishes.
  app.on('before-quit', (event) => {
    if (quitRequested) return;
    const status = engineHost.status();
    if (!status || status.state === 'stopped' || status.state === 'idle') return;
    quitRequested = true;
    event.preventDefault();
    void engineHost
      .quitAndStopWork()
      .catch(() => undefined)
      .finally(() => {
        app.quit();
      });
  });

  app.on('will-quit', () => {
    localState?.close();
    localState = null;
  });

  app.on('window-all-closed', () => {
    // Losing the last window is not a reason to abandon owned work. A renderer
    // crash recreates a window; a hidden window keeps the runtime. Mona quits
    // here only when it owns nothing.
    const status = engineHost.status();
    const ownsRuntime = status !== null && status.state !== 'stopped' && status.state !== 'idle';
    if (process.platform !== 'darwin' && !ownsRuntime) app.quit();
  });
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow(windowOptions(preloadPath, { isDev }));
  window.once('ready-to-show', () => {
    if (!smokeTest) window.show();
  });
  // A renderer crash is presentation loss, not task loss: recreate the window
  // and keep the runtime, queue, and any active turn untouched.
  window.webContents.on('render-process-gone', (_event, details) => {
    engineHost.handleSignal('renderer-process-gone');
    process.stderr.write(`mona: renderer gone (${details.reason}); recreating window\n`);
    if (smokeTest) return;
    const crashed = window;
    if (mainWindow === crashed) mainWindow = null;
    setTimeout(() => {
      // Destroy the dead window so the app keeps exactly one window; a crashed
      // BrowserWindow can never render again.
      if (!crashed.isDestroyed()) crashed.destroy();
      if (!mainWindow) mainWindow = createMainWindow();
    }, 250);
  });
  // Closing the window while Mona still owns a runtime hides it and keeps the
  // work alive; relaunching the app restores this same window. With no owned
  // runtime, closing behaves normally. The tray affordance arrives with the
  // desktop shell (P07); the preservation guarantee does not wait for it.
  window.on('close', (event) => {
    const owned = engineHost.status();
    const hasOwnedRuntime = owned !== null && owned.state !== 'stopped' && owned.state !== 'idle';
    if (smokeTest) return;
    if (hasOwnedRuntime && !quitRequested) {
      event.preventDefault();
      window.hide();
      engineHost.handleSignal('window-closed', { closeToTray: true });
      return;
    }
    engineHost.handleSignal('window-closed', { closeToTray: false });
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(rendererIndex);
  }
  return window;
}

type SmokeResult = {
  ok: boolean;
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  dom: unknown;
  bridge: unknown;
  security: {
    remoteNavigationAttempted: string;
    urlAfterNavigation: string;
    navigationRefused: boolean;
    popupAttempted: string;
    popupRefused: boolean;
    windowCount: number;
    devToolsAllowed: boolean;
  };
  metrics: Array<{ type: string; pid: number; workingSetSizeKb: number; peakWorkingSetSizeKb: number }>;
  rendererProcessCount: number;
  totalWorkingSetMb: number;
  capturedAt: string;
};

async function runSmoke(window: BrowserWindow, outputPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!window.webContents.isLoading()) return resolve();
    window.webContents.once('did-finish-load', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const dom = await window.webContents.executeJavaScript(
    `({
      title: document.title,
      version: document.querySelector('[data-testid="app-version"]')?.textContent ?? null,
      nav: Array.from(document.querySelectorAll('[data-testid^="nav-"]')).map((node) => node.textContent),
      engine: document.querySelector('[data-testid="engine-state"]')?.textContent ?? null,
      theme: document.documentElement.getAttribute('data-theme'),
      hasFixtureMarker: document.documentElement.innerHTML.includes('mona.fixture.test-only'),
      hasHarness: Boolean(document.querySelector('[data-testid="harness"]')),
      emptyCatalog: (document.body.textContent ?? '').includes('Choose a folder to begin'),
      palette: Boolean(document.querySelector('[data-testid="palette-trigger"]')),
      contextModel: document.querySelector('[data-testid="context-model"]')?.textContent ?? null,
      contextPermission: document.querySelector('[data-testid="context-permission"]')?.textContent ?? null
    })`,
    true,
  );

  // The renderer-facing bridge must be a frozen set of named methods.
  const bridge = await window.webContents.executeJavaScript(
    `({
      keys: Object.keys(window.mona ?? {}),
      frozen: Object.isFrozen(window.mona),
      hasNodeRequire: typeof window.require !== 'undefined',
      hasProcess: typeof window.process !== 'undefined',
      hasIpcRenderer: typeof window.ipcRenderer !== 'undefined'
    })`,
    true,
  );

  // Live security behaviour: these must be refused by the main process, not by
  // the renderer's own good manners.
  const urlBefore = window.webContents.getURL();
  await window.webContents
    .executeJavaScript(
      `(() => { try { window.location.assign('https://example.com/'); return 'assigned'; } catch (error) { return 'threw:' + error.name; } })()`,
      true,
    )
    .catch((error: unknown) => `execute-failed:${String(error)}`);
  await delay(1200);
  const urlAfter = window.webContents.getURL();
  const popupResult = await window.webContents
    .executeJavaScript(
      `(() => { try { const handle = window.open('https://example.com/', '_blank'); return handle === null ? 'null-returned' : 'window-created'; } catch (error) { return 'threw:' + error.name; } })()`,
      true,
    )
    .catch((error: unknown) => `execute-failed:${String(error)}`);
  await delay(600);

  const metrics = app.getAppMetrics().map((metric) => ({
    type: metric.type,
    pid: metric.pid,
    workingSetSizeKb: metric.memory.workingSetSize,
    peakWorkingSetSizeKb: metric.memory.peakWorkingSetSize,
  }));
  const result: SmokeResult = {
    ok: true,
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
    dom,
    bridge,
    security: {
      remoteNavigationAttempted: 'https://example.com/',
      urlAfterNavigation: urlAfter,
      navigationRefused: urlAfter === urlBefore,
      popupAttempted: 'https://example.com/',
      popupRefused: popupResult === 'null-returned',
      windowCount: BrowserWindow.getAllWindows().length,
      devToolsAllowed: window.webContents.isDevToolsOpened(),
    },
    metrics,
    rendererProcessCount: metrics.filter((metric) => metric.type === 'Tab').length,
    totalWorkingSetMb: Math.round(metrics.reduce((sum, metric) => sum + metric.workingSetSizeKb, 0) / 1024),
    capturedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');
  app.quit();
}
