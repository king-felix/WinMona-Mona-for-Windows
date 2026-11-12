import { app, BrowserWindow, ipcMain, Menu, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLaunchArgs } from '@mona/adapter';
import { createAppInfo, registerIpc } from './ipc.js';
import { EngineHost } from './engine-host.js';
import { resolveEngineExecutable } from './engine-host-config.js';
import { runLifecycleProbe } from './lifecycle-probe.js';
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
const lifecycleWorkspace = process.env.MONA_LIFECYCLE_WORKSPACE ?? null;
const trustOptions = { indexPath: rendererIndex, ...(devServerUrl ? { devServerUrl } : {}) };

const engineHost = new EngineHost({
  ownershipDir: path.join(app.getPath('userData'), 'runtime'),
  executable: resolveEngineExecutable(),
  parentPid: process.pid,
});

const pendingLaunchPaths: string[] = [];
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

    registerIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: (event) =>
        isTrustedSenderFrame(event as { senderFrame?: { url: string; parent: unknown } | null }, trustOptions),
      getAppInfo: () => {
        const engine = engineHost.summary();
        return createAppInfo({
          version: app.getVersion(),
          electron: process.versions.electron ?? 'unknown',
          chrome: process.versions.chrome ?? 'unknown',
          node: process.versions.node ?? 'unknown',
          platform: process.platform,
          arch: process.arch,
          engine: { status: engine.state, detail: engine.detail, descriptors: engine.descriptors },
        });
      },
    });

    // Reconciliation never starts inference or a runtime: it inspects ownership
    // records and terminates only processes this install can still identify.
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
      hasFixtureMarker: document.documentElement.innerHTML.includes('mona.fixture.test-only')
    })`,
    true,
  );

  // The renderer-facing bridge must be a frozen single method.
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
