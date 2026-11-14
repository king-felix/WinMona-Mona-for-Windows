import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  Tray,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coerceLaunchCommand, parseLaunchCommand, stripLauncherArgs, type LaunchCommand } from '@mona/adapter';
import { AttemptService, BriefingService, ChangeService, CostLedger, TaskService } from '@mona/project-state';
import { CatalogService } from './catalog-service.js';
import { registerCatalogIpc } from './catalog-ipc.js';
import { createAppInfo, registerIpc } from './ipc.js';
import { EngineHost } from './engine-host.js';
import { LaunchDispatcher, type LaunchIntent } from './launch-dispatch.js';
import { registerLaunchIpc } from './launch-ipc.js';
import { StudioService, type StudioAttentionEvent } from './studio-service.js';
import { registerStudioIpc } from './studio-ipc.js';
import { CommandService } from './command-service.js';
import { registerCommandIpc } from './command-ipc.js';
import { attachWindowState, registerWindowIpc } from './window-state.js';
import { ChangesService } from './changes-service.js';
import { registerChangesIpc } from './changes-ipc.js';
import { registerCostIpc } from './cost-ipc.js';
import { registerTaskIpc } from './tasks-ipc.js';
import { AgentObservatoryService } from './agent-observatory.js';
import { registerAgentIpc } from './agents-ipc.js';
import { EngineConfigCli } from './engine-config.js';
import { ProviderWorkbenchService } from './provider-workbench.js';
import { registerProviderIpc } from './provider-ipc.js';
import { ExtensionsService } from './extensions-service.js';
import { registerExtensionIpc } from './extensions-ipc.js';
import { CapabilityService } from './capability-service.js';
import { registerCapabilityIpc } from './capability-ipc.js';
import { TerminalHost } from './terminal-host.js';
import { TerminalService } from './terminal-service.js';
import { registerTerminalIpc } from './terminal-ipc.js';
import { STUDIO_CHANNELS, type StudioEvent, type StudioRun } from '../shared/studio.js';
import { TERMINAL_CHANNELS } from '../shared/terminal.js';
import { LAUNCH_CHANNELS, type LaunchReceipt, type LaunchSource } from '../shared/launch.js';
import {
  ATTENTION_CHANNELS,
  type AttentionEventView,
  type AttentionFocus,
  type AttentionView,
} from '../shared/attention.js';
import { APPEARANCE_CHANNELS, type AppearanceView } from '../shared/appearance.js';
import { openLocalState, type LocalState } from './local-state.js';
import { resolveEngineExecutable } from './engine-host-config.js';
import { runLifecycleProbe } from './lifecycle-probe.js';
import { runCatalogProbe } from './catalog-probe.js';
import { runStudioProbe } from './studio-probe.js';
import { runLaunchProbe } from './launch-probe.js';
import { runShots } from './shots.js';
import { runPolishProbe } from './polish-probe.js';
import { runTerminalProbe, writeTerminalProbe } from './terminal-probe.js';
import { runQaProbe } from './qa-probe.js';
import { runChangesProbe } from './changes-probe.js';
import { runMemoryProbe } from './memory-probe.js';
import { runA11yProbe } from './a11y-probe.js';
import { runAppearanceProbe } from './appearance-probe.js';
import { runComposerProbe } from './composer-probe.js';
import { runSlashProbe } from './slash-probe.js';
import { runFocusProbe } from './focus-probe.js';
import { runSurfacesProbe } from './surfaces-probe.js';
import { ActivityRecorder, activityFile } from './install-gate.js';
import { UiStateStore } from './ui-state.js';
import {
  DEFAULT_ATTENTION_SETTINGS,
  NotificationPlanner,
  describeQuiet,
  isQuietAt,
  trayView,
  type AttentionEvent,
} from './attention.js';
import { registerAttentionIpc } from './attention-ipc.js';
import { appearanceView, nextZoomFactor, readZoom, writeZoom, zoomShortcut } from './appearance.js';
import { registerAppearanceIpc } from './appearance-ipc.js';
import { registerBriefingIpc } from './briefing-ipc.js';
import { MemoryService } from './memory-service.js';
import { registerMemoryIpc } from './memory-ipc.js';
import { brandIconPath } from './icons.js';
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
const studioTest = process.argv.includes('--studio-test');
const studioOut = process.env.MONA_STUDIO_OUT ?? path.join(process.cwd(), 'mona-studio.json');
const studioWorkspace = process.env.MONA_STUDIO_WORKSPACE ?? null;
const studioShots = process.env.MONA_STUDIO_SHOTS ?? path.join(process.cwd(), 'mona-studio-shots');
const studioTask =
  process.env.MONA_STUDIO_TASK ??
  'Create a file named hello.txt in this project containing exactly MONA_STUDIO_OK with no extra text. Then run `node check.mjs` and report the result. Do not change any other file.';
const polishTest = process.argv.includes('--polish-test');
const polishOut = process.env.MONA_POLISH_OUT ?? path.join(process.cwd(), 'mona-polish.json');
const polishShots = process.env.MONA_POLISH_SHOTS ?? path.join(process.cwd(), 'mona-polish-shots');
const polishFixturesFile = process.env.MONA_POLISH_FIXTURES ?? null;
// The launch probe uses the real launcher command line, so its mode flag lives
// in the environment rather than in argv (argv is the thing under test).
const launchTest = process.env.MONA_LAUNCH_TEST === '1';
const launchOut = process.env.MONA_LAUNCH_OUT ?? path.join(process.cwd(), 'mona-launch.json');
const launchShots = process.env.MONA_LAUNCH_SHOTS ?? path.join(process.cwd(), 'mona-launch-shots');
const launchFixturesFile = process.env.MONA_LAUNCH_FIXTURES ?? null;
// P22 measurement run: real shell, real database, no engine work.
const qaTest = process.env.MONA_QA === '1';
const qaOut = process.env.MONA_QA_OUT ?? path.join(process.cwd(), 'mona-qa.json');
const qaWorkspace = process.env.MONA_QA_WORKSPACE ?? null;
const qaEvents = Number.parseInt(process.env.MONA_QA_EVENTS ?? '10000', 10);
const qaIdleSeconds = Number.parseInt(process.env.MONA_QA_IDLE_SECONDS ?? '60', 10);
// P23 release-candidate probe: the real Changes surface against a real workspace.
const changesTest = process.argv.includes('--changes-test');
// P23 memory investigation: per-process breakdown and the renderer JS heap.
const memoryTest = process.argv.includes('--memory-probe');
const memoryOut = process.env.MONA_MEMORY_OUT ?? path.join(process.cwd(), 'mona-memory.json');
const memoryWorkspace = process.env.MONA_MEMORY_WORKSPACE ?? null;
const memoryIdleSeconds = Number.parseInt(process.env.MONA_MEMORY_IDLE_SECONDS ?? '60', 10);
const memoryDiffPath = process.env.MONA_MEMORY_DIFF_PATH ?? 'big.txt';
const memoryHistoryRows = Number.parseInt(process.env.MONA_MEMORY_HISTORY ?? '0', 10);
// P23 accessibility probe: names, dialog focus contract, keyboard navigation, 200% zoom.
const a11yTest = process.argv.includes('--a11y-probe');
const a11yOut = process.env.MONA_A11Y_OUT ?? path.join(process.cwd(), 'mona-a11y.json');
const a11yWorkspace = process.env.MONA_A11Y_WORKSPACE ?? null;
const a11yHistoryRows = Number.parseInt(process.env.MONA_A11Y_HISTORY ?? '300', 10);
const changesOut = process.env.MONA_CHANGES_OUT ?? path.join(process.cwd(), 'mona-changes.json');
const changesWorkspace = process.env.MONA_CHANGES_WORKSPACE ?? null;
const changesShots = process.env.MONA_CHANGES_SHOTS ?? path.join(process.cwd(), 'mona-changes-shots');
// P24 appearance probe: collapsible Inspector and Ctrl +/-/0 window scaling.
const appearanceTest = process.argv.includes('--appearance-probe');
const appearanceOut = process.env.MONA_APPEARANCE_OUT ?? path.join(process.cwd(), 'mona-appearance.json');
const appearanceWorkspace = process.env.MONA_APPEARANCE_WORKSPACE ?? null;
const appearanceShots = process.env.MONA_APPEARANCE_SHOTS ?? path.join(process.cwd(), 'mona-appearance-shots');
// W01 composer probe: Enter/Ctrl+Enter pressed through Electron's input path.
const composerTest = process.argv.includes('--composer-probe');
const composerOut = process.env.MONA_COMPOSER_OUT ?? path.join(process.cwd(), 'mona-composer.json');
const composerWorkspace = process.env.MONA_COMPOSER_WORKSPACE ?? null;
const composerShots = process.env.MONA_COMPOSER_SHOTS ?? path.join(process.cwd(), 'mona-composer-shots');
// W04 slash-command autocomplete probe: types into the real composer and reads
// the list back. No runtime starts and no prompt is accepted.
const slashTest = process.argv.includes('--slash-probe');
const slashOut = process.env.MONA_SLASH_OUT ?? path.join(process.cwd(), 'mona-slash.json');
const slashWorkspace = process.env.MONA_SLASH_WORKSPACE ?? null;
const slashShots = process.env.MONA_SLASH_SHOTS ?? path.join(process.cwd(), 'mona-slash-shots');
// W06 Focus and fullscreen probe: real window transitions, no runtime.
const focusTest = process.argv.includes('--focus-probe');
const focusOut = process.env.MONA_FOCUS_OUT ?? path.join(process.cwd(), 'mona-focus.json');
const focusWorkspace = process.env.MONA_FOCUS_WORKSPACE ?? null;
const focusShots = process.env.MONA_FOCUS_SHOTS ?? path.join(process.cwd(), 'mona-focus-shots');
// P25 surfaces probe: the Cost lens and the Work board, driven against real rows.
const surfacesTest = process.argv.includes('--surfaces-probe');
const surfacesOut = process.env.MONA_SURFACES_OUT ?? path.join(process.cwd(), 'mona-surfaces.json');
const surfacesWorkspace = process.env.MONA_SURFACES_WORKSPACE ?? null;
const surfacesShots = process.env.MONA_SURFACES_SHOTS ?? path.join(process.cwd(), 'mona-surfaces-shots');
const surfacesExport = process.env.MONA_SURFACES_EXPORT ?? path.join(process.cwd(), 'mona-cost-export.csv');
const terminalTest = process.argv.includes('--terminal-test');
const terminalOut = process.env.MONA_TERMINAL_OUT ?? path.join(process.cwd(), 'mona-terminal.json');
const terminalWorkspace = process.env.MONA_TERMINAL_WORKSPACE ?? null;
const terminalShots = process.env.MONA_TERMINAL_SHOTS ?? path.join(process.cwd(), 'mona-terminal-shots');
// Screenshot capture needs deterministic compositing on a headless or remote
// desktop; the P08 probe captures five live frames.
// Memory measurement deliberately keeps hardware acceleration: the GPU process
// is part of the real process set and must be measured, not designed away.
if (
  shotsTest ||
  studioTest ||
  launchTest ||
  polishTest ||
  terminalTest ||
  changesTest ||
  appearanceTest ||
  composerTest ||
  slashTest ||
  focusTest ||
  surfacesTest
)
  app.disableHardwareAcceleration();
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
  onEvent: (event) => {
    if (
      (event.type === 'exited' && !event.expected) ||
      event.type === 'restart_exhausted' ||
      event.type === 'startup_failed'
    ) {
      studioService?.engineStopped('the owned runtime is no longer running');
    }
  },
});

let localState: LocalState | null = null;
let studioService: StudioService | null = null;
let changesService: ChangesService | null = null;
/** The same ChangeService the briefing and Changes surfaces read; kept for the release probe. */
let ownedChangeService: ChangeService | null = null;
// The task service and cost ledger outlive the boot block so the Work and Cost
// surfaces can read them; both were previously only reachable from Studio.
let ownedTaskService: TaskService | null = null;
let ownedCostLedger: CostLedger | null = null;
let observatoryService: AgentObservatoryService | null = null;
let providerService: ProviderWorkbenchService | null = null;
let extensionsService: ExtensionsService | null = null;
let capabilityService: CapabilityService | null = null;
let terminalService: TerminalService | null = null;
let uiStateStore: UiStateStore | null = null;
let briefingService: BriefingService | null = null;
let tray: Tray | null = null;
const attentionPlanner = new NotificationPlanner();
let lastAttentionEvent: AttentionEventView | null = null;
let lastCompletedAt: string | null = null;
let latestStudio: { projectId: string; run: StudioRun; blocked: boolean } | null = null;

// Window scale. Persisted beside the other UI preferences so a scale chosen for a
// television survives a restart; applied to every window this process creates.
const appearanceFile = path.join(app.getPath('userData'), 'state', 'appearance.json');
let zoomFactor = readZoom(appearanceFile);

/** Push the observed scale to every live window, including a recreated one. */
function broadcastAppearance(): void {
  const view = appearanceView(zoomFactor);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.setZoomFactor(zoomFactor);
      window.webContents.send(APPEARANCE_CHANNELS.event, view);
    }
  }
}

/** Step the window scale and persist it. Structural change only: no data, no inference. */
function stepZoom(direction: 'in' | 'out' | 'reset'): AppearanceView {
  zoomFactor = nextZoomFactor(zoomFactor, direction);
  writeZoom(appearanceFile, zoomFactor);
  broadcastAppearance();
  return appearanceView(zoomFactor);
}

/**
 * Victor's DS Full Access profile, recorded once in local state. It states the
 * posture Mona will request; the effective posture is always read back from the
 * engine's thread record and displayed separately.
 */
type SavedProfile = {
  label: string;
  profile: string;
  provider: string;
  model: string;
  endpoint: string;
  permissionPosture: 'full_access';
  allowShell: boolean;
  trustMode: boolean;
  autoApprove: boolean;
};

const DEFAULT_PROFILE: SavedProfile = {
  label: 'Full Access',
  profile: 'DS',
  provider: 'deepseek',
  model: 'deepseek-flash',
  endpoint: 'https://api.deepseek.com',
  permissionPosture: 'full_access',
  allowShell: true,
  trustMode: true,
  autoApprove: true,
};

let savedProfile: SavedProfile = DEFAULT_PROFILE;

function readSavedProfile(values: unknown): SavedProfile | null {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return null;
  const record = values as Record<string, unknown>;
  if (typeof record.label !== 'string' || typeof record.profile !== 'string') return null;
  return {
    ...DEFAULT_PROFILE,
    label: record.label.slice(0, 80),
    profile: record.profile.slice(0, 40),
  };
}

const earlyLaunchIntents: LaunchIntent[] = [];
let launchDispatcher: LaunchDispatcher | null = null;
let latestLaunch: LaunchReceipt | null = null;
let launchCount = 0;

// The installer reads this to decide whether an upgrade may proceed. It never
// changes behaviour: a failed write is ignored rather than failing a task.
let activityRecorder: ActivityRecorder | null = null;

/** One push per receipt for every live window; the snapshot covers an early event. */
function broadcastLaunch(receipt: LaunchReceipt): void {
  latestLaunch = receipt;
  launchCount += 1;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(LAUNCH_CHANNELS.event, receipt);
  }
}

function launchIntentFrom(command: LaunchCommand, source: LaunchSource): LaunchIntent | null {
  if (command.kind === 'app') return null;
  if (command.kind === 'invalid') {
    return { source, paths: [], profile: null, problem: { code: command.problem, detail: command.detail } };
  }
  return { source, paths: command.paths, profile: command.profile, problem: null };
}

/**
 * Explorer may deliver a selection before the app is ready. Early intents wait
 * here and are drained, in order, once the catalog exists; nothing is dropped
 * and nothing is executed by the shell.
 */
function submitLaunch(intent: LaunchIntent | null): void {
  if (!intent) return;
  if (launchDispatcher) {
    void launchDispatcher.enqueue(intent);
    return;
  }
  earlyLaunchIntents.push(intent);
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

/** A notification click focuses the project and its evidence; it never starts work. */
function focusAttention(focus: AttentionFocus): void {
  showMainWindow();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(ATTENTION_CHANNELS.focus, focus);
  }
}

function attentionSettings() {
  return (
    uiStateStore?.preferences() ?? {
      ...DEFAULT_ATTENTION_SETTINGS,
      density: 'comfortable' as const,
      firstCloseNotified: false,
    }
  );
}

function attentionView(): AttentionView {
  const settings = attentionSettings();
  const summary = engineHost.summary();
  const running =
    latestStudio !== null &&
    ['preparing', 'running', 'interrupting', 'awaiting_approval'].includes(latestStudio.run.state);
  const failed = latestStudio?.run.state === 'failed';
  return {
    settings,
    tray: trayView({
      running,
      blocked: latestStudio?.blocked ?? false,
      failed,
      engineState: summary.state,
      activeProjectLabel: null,
      lastCompletedAt,
    }),
    quietNow: isQuietAt(new Date(), settings.quietHours),
    quietDetail: describeQuiet(settings.quietHours),
    lastEvent: lastAttentionEvent,
  };
}

/**
 * One recorded transition becomes at most one notification. Delivery policy is
 * local and idempotent; a reconnect that replays the same turn cannot alert
 * twice, and quiet hours never pause the turn itself.
 */
function raiseAttention(event: StudioAttentionEvent): void {
  const settings = attentionSettings();
  const key =
    event.kind === 'blocker'
      ? `${event.projectId}:problem:${event.outcome ?? 'blocked'}:blocked`
      : `${event.projectId}:turn:${event.turnId ?? event.at}:${event.outcome ?? event.kind}`;
  const full: AttentionEvent = {
    key,
    kind: event.kind,
    projectId: event.projectId,
    projectLabel: '',
    at: event.at,
    taskId: event.taskId,
    turnId: event.turnId,
    evidencePath: null,
    outcome: event.outcome,
  };
  const foreground = mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isFocused();
  const plan = attentionPlanner.plan(full, settings, new Date(), { foreground });
  lastAttentionEvent = {
    kind: event.kind,
    projectId: event.projectId,
    projectLabel: '',
    at: event.at,
    taskId: event.taskId,
    turnId: event.turnId,
    evidencePath: null,
    outcome: event.outcome,
  };
  if (event.kind === 'run_completed') lastCompletedAt = event.at;
  updateTray();
  if (!plan.deliver) {
    process.stderr.write(`mona: attention ${event.kind} suppressed (${plan.reason})\n`);
    return;
  }
  const notification = new Notification({ title: plan.title, body: plan.body, silent: false });
  notification.on('click', () => focusAttention({ projectId: event.projectId, evidencePath: null, kind: event.kind }));
  notification.show();
}

function updateTray(): void {
  if (!tray || tray.isDestroyed()) return;
  const view = attentionView();
  tray.setToolTip(view.tray.tooltip);
  const running =
    latestStudio !== null &&
    ['preparing', 'running', 'interrupting', 'awaiting_approval'].includes(latestStudio.run.state);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Mona', click: () => showMainWindow() },
      {
        label: 'Interrupt now',
        enabled: running && latestStudio !== null,
        click: () => {
          if (latestStudio) void studioService?.interrupt(latestStudio.projectId);
        },
      },
      { type: 'separator' },
      { label: 'Quit and stop work', click: () => app.quit() },
    ]),
  );
}

function createTray(): void {
  if (tray && !tray.isDestroyed()) return;
  try {
    // The tray mark is the same artwork as the window icon, rendered at the
    // size Windows asks for. A missing file is reported as an unavailable tray
    // rather than replaced by a different logo.
    const trayIconPath = brandIconPath(here, 'mona-32.png');
    if (!trayIconPath) throw new Error('brand icon mona-32.png was not built');
    const image = nativeImage.createFromPath(trayIconPath);
    if (image.isEmpty()) throw new Error(`brand icon did not decode: ${trayIconPath}`);
    tray = new Tray(image);
    tray.on('click', () => {
      if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
      else showMainWindow();
    });
    updateTray();
  } catch (error) {
    process.stderr.write(`mona: tray unavailable: ${String(error).slice(0, 200)}\n`);
  }
}

const startupCommand = parseLaunchCommand(
  stripLauncherArgs(process.argv, { isPackaged: app.isPackaged, appPath: app.getAppPath() }),
  process.cwd(),
);
submitLaunch(launchIntentFrom(startupCommand, 'startup'));

// Windows re-serializes a second instance's command line through Chromium and
// loses `--path` values. The second instance therefore parses its own argv and
// sends the result as structured data through the single-instance lock.
const singleInstanceData = { monaLaunch: startupCommand };

let quitRequested = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let mainWindow: BrowserWindow | null = null;

if (!app.requestSingleInstanceLock(singleInstanceData)) {
  // The existing owner receives this argv through its own second-instance event.
  if (process.env.MONA_LAUNCH_CHILD_OUT) {
    try {
      fs.writeFileSync(
        process.env.MONA_LAUNCH_CHILD_OUT,
        JSON.stringify({ argv: process.argv, executable: process.execPath, appPath: app.getAppPath() }, null, 2),
        'utf8',
      );
    } catch {
      /* diagnostics are best effort */
    }
  }
  app.quit();
} else {
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    const bridged =
      typeof additionalData === 'object' && additionalData !== null
        ? coerceLaunchCommand((additionalData as Record<string, unknown>).monaLaunch)
        : null;
    const command =
      bridged ??
      parseLaunchCommand(
        stripLauncherArgs(argv, { isPackaged: app.isPackaged, appPath: app.getAppPath() }),
        process.cwd(),
      );
    if (process.env.MONA_LAUNCH_TEST === '1') {
      process.stderr.write(
        `mona: second-instance bridged=${bridged !== null} argv=${JSON.stringify(argv.slice(0, 8))}\n`,
      );
    }
    submitLaunch(launchIntentFrom(command, 'second-instance'));
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

    // Victor's DS Full Access profile is recorded once in local state and then
    // read back on every launch. It states the posture Mona requests; the
    // effective posture is always displayed from the engine's own thread record.
    if (localState) {
      try {
        const existing = await localState.store.latestSettingVersion('profile');
        const stored = existing ? readSavedProfile(existing.values) : null;
        if (stored) {
          savedProfile = stored;
        } else {
          await localState.store.saveSettingVersion('profile', 1, DEFAULT_PROFILE);
          savedProfile = DEFAULT_PROFILE;
        }
      } catch (error) {
        process.stderr.write(`mona: saved profile unavailable: ${String(error).slice(0, 200)}\n`);
      }
    }

    // One engine port for every surface. Stopping the runtime also tells the
    // studio, so a live turn becomes an honest "outcome uncertain" instead of a
    // spinner that never resolves.
    const enginePort = {
      summary: () => engineHost.summary(),
      startProjectRuntime: (input: { workspace: string }) => engineHost.startProjectRuntime(input),
      stopOwned: async (reason: string) => {
        const stopped = await engineHost.stopOwned(reason);
        studioService?.engineStopped(`runtime stopped (${reason})`);
        return stopped;
      },
      adapter: () => engineHost.adapter(),
    };

    let catalogService: CatalogService | null = null;
    let memoryService: MemoryService | null = null;
    if (localState) {
      uiStateStore = new UiStateStore({ file: path.join(app.getPath('userData'), 'state', 'ui-state.json') });
      // P14 reads the same rows the task, attempt, cost and change services
      // already own. No second store and no summarizer is introduced.
      const taskService = new TaskService(localState.store);
      const attemptService = new AttemptService(localState.store, { tasks: taskService });
      const costLedger = new CostLedger(localState.store);
      ownedTaskService = taskService;
      ownedCostLedger = costLedger;
      const changeService = new ChangeService(localState.store);
      ownedChangeService = changeService;
      briefingService = new BriefingService(localState.store, {
        tasks: taskService,
        attempts: attemptService,
        costs: costLedger,
        changes: changeService,
      });
      catalogService = new CatalogService({
        store: localState.store,
        ui: uiStateStore,
        engine: enginePort,
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

      // The live studio: one engine thread per Mona session, streamed into a
      // durable timeline. It sends nothing until a prompt is submitted.
      studioService = new StudioService({
        store: localState.store,
        engine: enginePort,
        costs: costLedger,
        attention: raiseAttention,
        nativeDispatcherActive: (projectId) => observatoryService?.nativeDispatcherActive(projectId) === true,
        emit: (event: StudioEvent) => {
          if (event.type === 'state') {
            latestStudio = {
              projectId: event.projectId,
              run: event.run,
              blocked: event.control.blockedProblem !== null,
            };
            activityRecorder?.record(event.run.state, event.projectId);
            updateTray();
          }
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.webContents.send(STUDIO_CHANNELS.event, event);
          }
        },
        pickReferences: async (project) => {
          const options = {
            title: 'Reference files from this project',
            properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
            defaultPath: project.canonicalPath,
          };
          const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
          const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
          return picked.canceled ? null : picked.filePaths;
        },
        saveFile: async ({ title, defaultName, extensions }) => {
          const options = {
            title,
            defaultPath: path.join(app.getPath('documents'), defaultName),
            filters: [{ name: 'Markdown', extensions }],
          };
          const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
          const picked = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
          return picked.canceled || !picked.filePath ? null : picked.filePath;
        },
        appVersion: () => app.getVersion(),
      });

      // The Changes surface reads real workspace state: Git status, a diff
      // against a captured baseline, Git text diffs and recorded test receipts.
      changesService = new ChangesService(localState.store, changeService);

      // The observatory reads engine-owned goals, fleets, runs and agent
      // children, and is the only component that may hand a start to the
      // engine. It never schedules a task Mona's queue already owns.
      observatoryService = new AgentObservatoryService({
        store: localState.store,
        engine: enginePort,
        monaQueueActive: (projectId) => studioService?.activeOwnership(projectId) ?? null,
      });
      providerService = new ProviderWorkbenchService({
        store: localState.store,
        engine: enginePort,
        config: new EngineConfigCli({ executable: resolveEngineExecutable() }),
        backupRoot: path.join(app.getPath('userData'), 'config-backups'),
      });
      extensionsService = new ExtensionsService({
        store: localState.store,
        engine: enginePort,
      });
      capabilityService = new CapabilityService({ engine: enginePort });
      // Project memory is local and deterministic: search, the prompt shelf,
      // portable handoff/resume bundles, settings backup and a redacted
      // diagnostic preview. It never talks to the provider.
      memoryService = new MemoryService({
        store: localState.store,
        ui: uiStateStore,
        artifactRoot: localState.artifactRoot,
        app: () => ({
          name: 'Mona',
          version: app.getVersion(),
          electron: process.versions.electron ?? 'unknown',
          chrome: process.versions.chrome ?? 'unknown',
          node: process.versions.node ?? 'unknown',
          platform: process.platform,
          arch: process.arch,
        }),
        engine: () => {
          const summary = engineHost.summary();
          return {
            status: summary.state,
            detail: summary.detail,
            version: null,
            commit: null,
            endpoint: summary.endpoint,
            pid: summary.pid,
            compatibility: summary.compatibility,
          };
        },
        dialogs: {
          saveFile: async ({ title, defaultName, extensions }) => {
            const options = {
              title,
              defaultPath: path.join(app.getPath('documents'), defaultName),
              filters: [{ name: 'Mona files', extensions }],
            };
            const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
            const picked = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
            return picked.canceled || !picked.filePath ? null : picked.filePath;
          },
          openFile: async ({ title, extensions }) => {
            const options = {
              title,
              properties: ['openFile'] as Array<'openFile'>,
              filters: [{ name: 'Mona files', extensions }],
            };
            const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
            const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
            return picked.canceled ? null : (picked.filePaths[0] ?? null);
          },
          chooseFolder: async ({ title }) => {
            const options = { title, properties: ['openDirectory'] as Array<'openDirectory'> };
            const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
            const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
            return picked.canceled ? null : (picked.filePaths[0] ?? null);
          },
        },
      });
      // A local ConPTY driven by the user. It never talks to the runtime API and
      // no tool output, Markdown or hook can reach it.
      terminalService = new TerminalService({
        store: localState.store,
        host: new TerminalHost({
          emit: (event) => {
            for (const window of BrowserWindow.getAllWindows()) {
              if (!window.isDestroyed()) window.webContents.send(TERMINAL_CHANNELS.event, event);
            }
          },
        }),
      });
    }

    // Launches share one serialized queue: the path is resolved and validated,
    // the project is opened or reused, the studio view is recorded, and the
    // owned runtime is started. No prompt is submitted on the user's behalf.
    const launchCatalog = catalogService;
    if (launchCatalog) {
      launchDispatcher = new LaunchDispatcher({
        service: launchCatalog,
        ui: launchCatalog,
        engine: enginePort,
        profile: () => savedProfile,
        pickFolder: async () => {
          const picked = await launchCatalog.pickFolder('open');
          return picked.ok ? picked.data.path : null;
        },
        emit: broadcastLaunch,
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
          permission: {
            label: savedProfile.label,
            profile: savedProfile.profile,
            detail:
              'Saved once in Mona’s local state. The engine applies it when a thread is created; the studio shows the observed posture from the runtime.',
          },
          harnessEnabled,
        });
      },
    });
    const commandService = localState
      ? new CommandService({
          store: localState.store,
          ensureSession: (projectId, sessionId) => {
            if (!uiStateStore) throw new Error('local UI state is unavailable');
            return uiStateStore.ensureSession(projectId, sessionId);
          },
          sessionBusy: (projectId, sessionId) => studioService?.sessionBusy(projectId, sessionId) ?? null,
        })
      : null;
    registerCatalogIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      service: catalogService,
    });
    registerStudioIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      service: () => studioService,
    });
    registerCommandIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      service: () => commandService,
    });
    registerWindowIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      window: () => mainWindow,
    });
    registerChangesIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      service: () => changesService,
    });
    registerAgentIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      service: () => observatoryService,
    });
    registerProviderIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      service: () => providerService,
    });
    registerExtensionIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      service: () => extensionsService,
    });
    registerCapabilityIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      service: () => capabilityService,
    });
    registerTerminalIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      service: () => terminalService,
      clipboard: (text) => clipboard.writeText(text),
    });
    registerLaunchIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      state: () => ({ latest: latestLaunch, count: launchCount }),
    });
    registerAttentionIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      view: () => attentionView(),
      update: (patch) => {
        if (!uiStateStore) throw new Error('Local UI state is unavailable.');
        uiStateStore.updatePreferences(patch);
        updateTray();
        return attentionView();
      },
      quitAndStop: () => {
        // The reply reaches the renderer before the quit path starts; stopping
        // owned work is handled by before-quit with its own receipt.
        setTimeout(() => app.quit(), 0);
      },
    });
    registerAppearanceIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      view: () => appearanceView(zoomFactor),
      zoom: (direction) => stepZoom(direction),
    });
    registerCostIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      ledger: () => ownedCostLedger,
      saveCsv: async ({ projectId, content }) => {
        // Probe seam: a native save dialog cannot be clicked from a probe. This is
        // reachable only with --surfaces-probe plus an explicit destination, and
        // the probe report says the dialog itself is not covered.
        if (surfacesTest && process.env.MONA_SURFACES_EXPORT) {
          const target = path.resolve(surfacesExport);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, content, 'utf8');
          return {
            saved: true,
            path: target,
            note: `Probe wrote the recorded usage rows to ${target}. The save dialog is not exercised in a probe.`,
          };
        }
        const options = {
          title: 'Export recorded cost as CSV',
          defaultPath: path.join(app.getPath('documents'), `mona-cost-${projectId}.csv`),
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        };
        const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
        const picked = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
        if (picked.canceled || !picked.filePath) {
          return { saved: false, path: null, note: 'Export cancelled. Nothing was written.' };
        }
        // Temp file then rename, so a failed write can never truncate a real file.
        const temporary = `${picked.filePath}.tmp-${process.pid}`;
        fs.writeFileSync(temporary, content, 'utf8');
        fs.renameSync(temporary, picked.filePath);
        return {
          saved: true,
          path: picked.filePath,
          note: `Wrote the recorded usage rows to ${picked.filePath}.`,
        };
      },
    });
    registerTaskIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      service: () => ownedTaskService,
    });
    registerBriefingIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      service: () => briefingService,
      ui: () => uiStateStore,
    });
    registerMemoryIpc({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      isTrustedSender: trustedSender,
      service: () => memoryService,
    });

    const reconciled = await engineHost.reconcile();
    if (reconciled.unverifiable > 0) {
      process.stderr.write(
        `mona: ${reconciled.unverifiable} ownership record(s) name a live process Mona cannot identify; leaving them alone\n`,
      );
    }

    // A failed identify pass leaves the record alone; the working tree is not
    // a reason to guess. Then the shell appears and the tray reflects state.
    mainWindow = createMainWindow();
    createTray();

    // Publish an idle/idle-again record so the installer and a future upgrade
    // path can tell "not running" from "running with work in flight".
    activityRecorder = new ActivityRecorder({
      file: activityFile(app.getPath('userData')),
      version: app.getVersion(),
    });
    activityRecorder.record(latestStudio?.run.state ?? null, latestStudio?.projectId ?? null);

    // Drain shell selections in arrival order. A launch that arrived before the
    // catalog existed is still handled; a missing catalog is reported, never
    // silently accepted.
    for (const intent of earlyLaunchIntents.splice(0, earlyLaunchIntents.length)) {
      if (launchDispatcher) {
        void launchDispatcher.enqueue(intent);
        continue;
      }
      broadcastLaunch({
        seq: launchCount + 1,
        at: new Date().toISOString(),
        source: intent.source,
        requestedPath: intent.paths[0] ?? null,
        openedPath: null,
        status: 'failed',
        detail:
          'Local project state is unavailable, so Mona cannot open a project from Explorer. See Settings → Diagnostics.',
        warnings: [],
        project: null,
        engine: null,
        profile: null,
        focusComposer: false,
      });
    }

    if (appearanceTest && appearanceWorkspace && mainWindow) {
      const probeWindow = mainWindow;
      void runAppearanceProbe({
        window: probeWindow,
        outputPath: appearanceOut,
        shotsDirectory: appearanceShots,
        workspace: appearanceWorkspace,
        openProject: async (target) => {
          if (!catalogService) return null;
          const opened = await catalogService.open(target);
          if (!opened.ok) return null;
          return { projectId: opened.data.project.id, canonicalPath: opened.data.project.canonicalPath };
        },
        zoomFile: appearanceFile,
      })
        .then((result) => {
          fs.mkdirSync(path.dirname(appearanceOut), { recursive: true });
          fs.writeFileSync(appearanceOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
          if (!probeWindow.isDestroyed()) probeWindow.destroy();
          app.exit(result.ok ? 0 : 1);
        })
        .catch((error: unknown) => {
          fs.writeFileSync(appearanceOut, JSON.stringify({ ok: false, error: String(error) }, null, 2), 'utf8');
          app.exit(1);
        });
    }

    if (composerTest && composerWorkspace && mainWindow) {
      const probeWindow = mainWindow;
      void runComposerProbe({
        window: probeWindow,
        outputPath: composerOut,
        shotsDirectory: composerShots,
        workspace: composerWorkspace,
        openProject: async (target) => {
          if (!catalogService) return null;
          const opened = await catalogService.open(target);
          if (!opened.ok) return null;
          return { projectId: opened.data.project.id, canonicalPath: opened.data.project.canonicalPath };
        },
      })
        .then((result) => {
          fs.mkdirSync(path.dirname(composerOut), { recursive: true });
          fs.writeFileSync(composerOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
          if (!probeWindow.isDestroyed()) probeWindow.destroy();
          app.exit(result.ok ? 0 : 1);
        })
        .catch((error: unknown) => {
          fs.writeFileSync(composerOut, JSON.stringify({ ok: false, error: String(error) }, null, 2), 'utf8');
          app.exit(1);
        });
    }

    if (slashTest && slashWorkspace && mainWindow) {
      const probeWindow = mainWindow;
      void runSlashProbe({
        window: probeWindow,
        outputPath: slashOut,
        shotsDirectory: slashShots,
        workspace: slashWorkspace,
        openProject: async (target) => {
          if (!catalogService) return null;
          const opened = await catalogService.open(target);
          if (!opened.ok) return null;
          return { projectId: opened.data.project.id, canonicalPath: opened.data.project.canonicalPath };
        },
      })
        .then((result) => {
          fs.mkdirSync(path.dirname(slashOut), { recursive: true });
          fs.writeFileSync(slashOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
          if (!probeWindow.isDestroyed()) probeWindow.destroy();
          app.exit(result.ok ? 0 : 1);
        })
        .catch((error: unknown) => {
          fs.writeFileSync(slashOut, JSON.stringify({ ok: false, error: String(error) }, null, 2), 'utf8');
          app.exit(1);
        });
    }

    if (focusTest && focusWorkspace && mainWindow) {
      const probeWindow = mainWindow;
      void runFocusProbe({
        window: probeWindow,
        outputPath: focusOut,
        shotsDirectory: focusShots,
        workspace: focusWorkspace,
        openProject: async (target) => {
          if (!catalogService) return null;
          const opened = await catalogService.open(target);
          if (!opened.ok) return null;
          return { projectId: opened.data.project.id, canonicalPath: opened.data.project.canonicalPath };
        },
        database: () => localState?.store.database ?? null,
        sessionId: (projectId) => {
          if (!uiStateStore) return null;
          const state = uiStateStore.view();
          const existing = state.projects[projectId]?.currentSessionId ?? null;
          if (existing) return existing;
          return uiStateStore.newSession(projectId).projects[projectId]?.currentSessionId ?? null;
        },
        reload: () => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
        },
      })
        .then((result) => {
          fs.mkdirSync(path.dirname(focusOut), { recursive: true });
          fs.writeFileSync(focusOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
          if (!probeWindow.isDestroyed()) probeWindow.destroy();
          app.exit(result.ok ? 0 : 1);
        })
        .catch((error: unknown) => {
          fs.writeFileSync(focusOut, JSON.stringify({ ok: false, error: String(error) }, null, 2), 'utf8');
          app.exit(1);
        });
    }

    if (surfacesTest && surfacesWorkspace && mainWindow) {
      const probeWindow = mainWindow;
      // Seeding goes through the real services, so the probe reads rows a user
      // could have produced. Nothing here opens a thread or submits a prompt.
      const seedTask = async (projectId: string): Promise<{ titles: string[]; ids: string[] }> => {
        const service = ownedTaskService;
        if (!service) return { titles: [], ids: [] };
        const first = await service.createTask({
          projectId,
          title: 'Wire the probe',
          owner: 'mona_queue',
          ordinal: 1,
          steps: [{ title: 'write the code' }, { title: 'run it' }],
          criteria: [{ description: 'the tests pass' }],
        });
        const second = await service.createTask({
          projectId,
          title: 'Ship it',
          owner: 'mona_queue',
          ordinal: 2,
          dependsOn: [first.id],
        });
        return { titles: [first.title, second.title], ids: [first.id, second.id] };
      };
      const seedCost = async (
        projectId: string,
        taskId: string | null,
      ): Promise<{ knownMicros: number; unknownRecords: number }> => {
        const ledger = ownedCostLedger;
        if (!ledger) return { knownMicros: 0, unknownRecords: 0 };
        await ledger.putRate({
          provider: 'deepseek',
          model: 'deepseek-flash',
          cacheMissMicros: 1_000_000,
          outputMicros: 2_000_000,
          unitTokens: 1_000_000,
          revision: 'probe-1',
          source: 'probe rate card, not a provider price',
        });
        await ledger.ingest({
          projectId,
          taskId,
          turnId: 'turn_probe_provider',
          provider: 'deepseek',
          model: 'deepseek-flash',
          buckets: { inputTokens: 1_200, outputTokens: 300, cacheKnown: false },
          cost: { kind: 'provider_reported', micros: 2_500, source: 'probe provider report' },
          source: 'surfaces probe',
          dedupeKey: 'probe-provider-report',
        });
        await ledger.ingest({
          projectId,
          taskId,
          turnId: 'turn_probe_estimate',
          provider: 'deepseek',
          model: 'deepseek-flash',
          buckets: { cacheHitTokens: 0, cacheMissTokens: 1_000, outputTokens: 0, cacheKnown: true },
          cost: { kind: 'local_estimate' },
          source: 'surfaces probe',
          dedupeKey: 'probe-local-estimate',
        });
        await ledger.ingest({
          projectId,
          taskId: null,
          turnId: 'turn_probe_unknown',
          provider: 'deepseek',
          model: 'deepseek-flash',
          buckets: {},
          cost: { kind: 'unknown', reason: 'provider did not report usage' },
          source: 'surfaces probe',
          dedupeKey: 'probe-unknown-cost',
        });
        const totals = await ledger.totals(projectId);
        return { knownMicros: totals.knownMicros, unknownRecords: totals.unknownRecords };
      };
      void runSurfacesProbe({
        window: probeWindow,
        outputPath: surfacesOut,
        shotsDirectory: surfacesShots,
        workspace: surfacesWorkspace,
        exportPath: surfacesExport,
        openProject: async (target) => {
          if (!catalogService) return null;
          const opened = await catalogService.open(target);
          if (!opened.ok) return null;
          return { projectId: opened.data.project.id, canonicalPath: opened.data.project.canonicalPath };
        },
        seedTask,
        seedCost,
      })
        .then((result) => {
          fs.mkdirSync(path.dirname(surfacesOut), { recursive: true });
          fs.writeFileSync(surfacesOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
          if (!probeWindow.isDestroyed()) probeWindow.destroy();
          app.exit(result.ok ? 0 : 1);
        })
        .catch((error: unknown) => {
          fs.writeFileSync(surfacesOut, JSON.stringify({ ok: false, error: String(error) }, null, 2), 'utf8');
          app.exit(1);
        });
    }

    if (a11yTest && a11yWorkspace && mainWindow) {
      const probeWindow = mainWindow;
      void runA11yProbe({
        window: probeWindow,
        outputPath: a11yOut,
        workspace: a11yWorkspace,
        historyRows: Number.isFinite(a11yHistoryRows) ? a11yHistoryRows : 300,
        openProject: async (target) => {
          if (!catalogService) return null;
          const opened = await catalogService.open(target);
          if (!opened.ok) return null;
          return { projectId: opened.data.project.id, canonicalPath: opened.data.project.canonicalPath };
        },
        showView: (projectId, view) => {
          catalogService?.select(projectId);
          catalogService?.setView(projectId, view as 'studio' | 'changes');
        },
        seedHistory: async (projectId, rows) => {
          if (!localState || !uiStateStore) return 0;
          const state = uiStateStore.view();
          const sessionId = state.projects[projectId]?.currentSessionId ?? null;
          const project = await localState.store.getProject(projectId);
          if (!sessionId || !project) return 0;
          const database = localState.store.database;
          const stamp = new Date().toISOString();
          const id = `thr_a11y_${Date.now().toString(36)}`;
          database
            .prepare(
              'INSERT INTO threads (id, project_id, engine_thread_id, workspace, last_seq, created_at, updated_at, session_id, mode, profile_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
            )
            .run(id, projectId, `a11y-${id}`, project.canonicalPath, rows, stamp, stamp, sessionId, 'agent');
          const insert = database.prepare(
            'INSERT INTO timeline_items (id, project_id, thread_id, turn_id, seq, kind, title, body, status, truncated, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, 0, ?, ?)',
          );
          database.exec('BEGIN');
          for (let index = 1; index <= rows; index += 1) {
            insert.run(
              `a11y_${id}_${index}`,
              projectId,
              id,
              index,
              index % 7 === 0 ? 'tool' : index % 3 === 0 ? 'status' : 'assistant',
              `Keyboard event ${index}`,
              `Accessibility fixture ${index}: a bounded window of history alongside the newest rows.`,
              stamp,
              stamp,
            );
          }
          database.exec('COMMIT');
          return rows;
        },
        reload: () => {
          if (!probeWindow.isDestroyed()) probeWindow.webContents.reload();
        },
        prepareDiff: async (projectId) => {
          if (!changesService) return null;
          await changesService.capture(projectId, 'a11y probe baseline');
          const project = await localState?.store.getProject(projectId);
          if (!project) return null;
          const target = path.join(project.canonicalPath, 'big.txt');
          fs.writeFileSync(
            target,
            Array.from({ length: 4_000 }, (_, index) => `line ${index} edited for the a11y probe`).join('\n'),
            'utf8',
          );
          const diff = await changesService.diff(projectId, 'big.txt');
          return diff.ok ? { path: 'big.txt', available: diff.data.available } : null;
        },
      })
        .then((result) => {
          if (!probeWindow.isDestroyed()) probeWindow.destroy();
          app.exit(result.ok ? 0 : 1);
        })
        .catch((error: unknown) => {
          fs.writeFileSync(a11yOut, JSON.stringify({ ok: false, error: String(error) }, null, 2), 'utf8');
          app.exit(1);
        });
    }

    if (memoryTest && memoryWorkspace && mainWindow) {
      const probeWindow = mainWindow;
      void runMemoryProbe({
        window: probeWindow,
        outputPath: memoryOut,
        workspace: memoryWorkspace,
        idleSeconds: Number.isFinite(memoryIdleSeconds) ? memoryIdleSeconds : 60,
        openProject: async (target) => {
          if (!catalogService) return null;
          const opened = await catalogService.open(target);
          if (!opened.ok) return null;
          return { projectId: opened.data.project.id, canonicalPath: opened.data.project.canonicalPath };
        },
        showView: (projectId, view) => {
          catalogService?.select(projectId);
          catalogService?.setView(projectId, view as 'studio' | 'changes');
        },
        prepareChanges: async (projectId) => {
          if (!changesService) return null;
          // A baseline first, then one large edited file: the diff is real Git
          // output for a real workspace, and nothing is sent anywhere.
          await changesService.capture(projectId, 'memory probe baseline');
          const project = await localState?.store.getProject(projectId);
          if (!project) return null;
          const target = path.join(project.canonicalPath, memoryDiffPath);
          const body = Array.from({ length: 4_000 }, (_, index) => `line ${index} edited for the memory probe`).join(
            '\n',
          );
          fs.writeFileSync(target, body, 'utf8');
          const diff = await changesService.diff(projectId, memoryDiffPath);
          return diff.ok ? { path: memoryDiffPath, available: diff.data.available } : null;
        },
        historyRows: Number.isFinite(memoryHistoryRows) ? memoryHistoryRows : 0,
        sessionId: (projectId) => {
          if (!uiStateStore) return null;
          const state = uiStateStore.view();
          const existing = state.projects[projectId]?.currentSessionId ?? null;
          if (existing) return existing;
          return uiStateStore.newSession(projectId).projects[projectId]?.currentSessionId ?? null;
        },
        database: () => (localState ? (localState.store.database as never) : null),
        reload: () => {
          if (!probeWindow.isDestroyed()) probeWindow.webContents.reload();
        },
      })
        .then((result) => {
          if (!probeWindow.isDestroyed()) probeWindow.destroy();
          app.exit(result.ok ? 0 : 1);
        })
        .catch((error: unknown) => {
          fs.writeFileSync(memoryOut, JSON.stringify({ ok: false, error: String(error) }, null, 2), 'utf8');
          app.exit(1);
        });
    }

    if (changesTest && changesWorkspace && mainWindow) {
      const probeWindow = mainWindow;
      void runChangesProbe({
        window: probeWindow,
        outputPath: changesOut,
        shotsDirectory: changesShots,
        workspace: changesWorkspace,
        openProject: async (target) => {
          if (!catalogService) return null;
          const opened = await catalogService.open(target);
          if (!opened.ok) return null;
          return { projectId: opened.data.project.id, canonicalPath: opened.data.project.canonicalPath };
        },
        prepare: (projectId) => {
          catalogService?.select(projectId);
          catalogService?.setView(projectId, 'changes');
        },
        reload: () => {
          if (!probeWindow.isDestroyed()) probeWindow.webContents.reload();
        },
        recordReceipt: async (projectId) => {
          if (!ownedChangeService) return null;
          const receipt = await ownedChangeService.recordTestReceipt({
            projectId,
            command: 'npm test',
            exitCode: 0,
            outcome: 'passed',
            output: 'P23 probe: the project test command exited 0.\n',
          });
          return { id: receipt.id, outcome: receipt.outcome };
        },
      })
        .then((result) => {
          if (!probeWindow.isDestroyed()) probeWindow.destroy();
          app.exit(result.ok ? 0 : 1);
        })
        .catch((error: unknown) => {
          fs.writeFileSync(changesOut, JSON.stringify({ ok: false, error: String(error) }, null, 2), 'utf8');
          app.exit(1);
        });
    }

    if (qaTest && qaWorkspace && mainWindow) {
      const probeWindow = mainWindow;
      void runQaProbe({
        window: probeWindow,
        outputPath: qaOut,
        workspace: qaWorkspace,
        eventCount: Number.isFinite(qaEvents) ? qaEvents : 10000,
        idleSeconds: Number.isFinite(qaIdleSeconds) ? qaIdleSeconds : 60,
        openProject: async (target) => {
          if (!catalogService) return null;
          const opened = await catalogService.open(target);
          if (!opened.ok) return null;
          return { projectId: opened.data.project.id, canonicalPath: opened.data.project.canonicalPath };
        },
        showStudio: (projectId) => {
          catalogService?.select(projectId);
          catalogService?.setView(projectId, 'studio');
        },
        reload: () => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
        },
        sessionId: (projectId) => {
          if (!uiStateStore) return null;
          const state = uiStateStore.view();
          const existing = state.projects[projectId]?.currentSessionId ?? null;
          if (existing) return existing;
          return uiStateStore.newSession(projectId).projects[projectId]?.currentSessionId ?? null;
        },
        emitItems: (projectId, count) => {
          const target = mainWindow;
          if (!target || target.isDestroyed()) return;
          const at = new Date().toISOString();
          for (let index = 0; index < count; index += 1) {
            target.webContents.send(STUDIO_CHANNELS.event, {
              type: 'item',
              projectId,
              item: {
                id: `qa_load_${index}`,
                seq: 900000 + index,
                turnId: null,
                kind: index % 7 === 0 ? 'tool' : index % 3 === 0 ? 'status' : 'assistant',
                title: `Synthetic event ${index}`,
                body: `Load-fixture body ${index}: this item exists to measure rendering and never claims a runtime result.`,
                status: null,
                truncated: false,
                at,
              },
            });
          }
        },
        database: () => (localState ? (localState.store.database as never) : null),
        startRuntime: async (projectId) => {
          if (!catalogService) return null;
          const started = await catalogService.startEngine(projectId);
          if (!started.ok) return null;
          const summary = engineHost.summary();
          return { pid: summary.pid ?? null };
        },
        stopRuntime: async () => {
          await engineHost.stopOwned('qa_probe');
        },
      })
        .then((result) => {
          process.stdout.write(`mona-qa: ${result.ok ? 'ok' : 'failed'}\n`);
        })
        .catch((error) => {
          fs.writeFileSync(qaOut, JSON.stringify({ ok: false, error: String(error) }, null, 2), 'utf8');
        })
        .finally(() => {
          setTimeout(() => app.exit(0), 500);
        });
      return;
    }

    if (launchTest && launchFixturesFile && launchDispatcher) {
      const probeWindow = mainWindow;
      const probeDispatcher = launchDispatcher;
      let fixtures: { a: string; b: string };
      try {
        fixtures = JSON.parse(fs.readFileSync(launchFixturesFile, 'utf8')) as { a: string; b: string };
      } catch (error) {
        fs.writeFileSync(
          launchOut,
          JSON.stringify({ ok: false, error: `launch fixtures unavailable: ${String(error)}` }, null, 2),
          'utf8',
        );
        app.exit(1);
        return;
      }
      runLaunchProbe({
        window: probeWindow,
        dispatcher: probeDispatcher,
        fixtures,
        shotsDirectory: launchShots,
        outputPath: launchOut,
        electronPath: process.execPath,
        appPath: app.getAppPath(),
        stopEngine: async () => {
          await engineHost.stopOwned('launch_probe');
        },
        engineSummary: () => {
          const summary = engineHost.summary();
          return { state: summary.state, workspace: summary.workspace };
        },
      })
        .then((result) => {
          if (!probeWindow.isDestroyed()) probeWindow.destroy();
          app.exit(result.ok ? 0 : 1);
        })
        .catch((error: unknown) => {
          fs.writeFileSync(launchOut, JSON.stringify({ ok: false, error: String(error) }, null, 2), 'utf8');
          app.exit(1);
        });
      return;
    }

    if (terminalTest && terminalWorkspace) {
      runTerminalProbe({
        window: mainWindow,
        rendererIndex,
        workspace: terminalWorkspace,
        shotsDirectory: terminalShots,
        outputPath: terminalOut,
      })
        .then((result) => {
          writeTerminalProbe(result, terminalOut);
          const probeWindow = mainWindow as BrowserWindow | null;
          if (probeWindow && !probeWindow.isDestroyed()) probeWindow.destroy();
          app.exit(result.ok ? 0 : 1);
        })
        .catch((error: unknown) => {
          fs.writeFileSync(terminalOut, JSON.stringify({ ok: false, error: String(error) }, null, 2), 'utf8');
          app.exit(1);
        });
      return;
    }
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
      return;
    }
    if (studioTest && studioWorkspace) {
      runStudioProbe({
        window: mainWindow,
        rendererIndex,
        workspace: studioWorkspace,
        shotsDirectory: studioShots,
        outputPath: studioOut,
        engine: engineHost,
        taskText: studioTask,
      })
        .then((result) => {
          const window = mainWindow as BrowserWindow | null;
          if (window && !window.isDestroyed()) window.destroy();
          app.exit(result.ok ? 0 : 1);
        })
        .catch((error: unknown) => {
          fs.writeFileSync(studioOut, JSON.stringify({ ok: false, error: String(error) }, null, 2), 'utf8');
          app.exit(1);
        });
    }
    if (polishTest && polishFixturesFile) {
      const polishWindow = mainWindow;
      let fixtures: Parameters<typeof runPolishProbe>[0]['fixtures'];
      try {
        fixtures = JSON.parse(fs.readFileSync(polishFixturesFile, 'utf8')) as typeof fixtures;
      } catch (error) {
        fs.writeFileSync(
          polishOut,
          JSON.stringify({ ok: false, error: `polish fixtures unavailable: ${String(error)}` }, null, 2),
          'utf8',
        );
        app.exit(1);
        return;
      }
      runPolishProbe({
        window: polishWindow,
        rendererIndex,
        shotsDirectory: polishShots,
        outputPath: polishOut,
        engine: engineHost,
        trayActive: () => tray !== null && !tray.isDestroyed(),
        fixtures,
      })
        .then((result) => {
          if (!polishWindow.isDestroyed()) polishWindow.destroy();
          app.exit(result.ok ? 0 : 1);
        })
        .catch((error: unknown) => {
          fs.writeFileSync(polishOut, JSON.stringify({ ok: false, error: String(error) }, null, 2), 'utf8');
          app.exit(1);
        });
      return;
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
    activityRecorder?.clear();
    activityRecorder = null;
    studioService?.close();
    studioService = null;
    observatoryService = null;
    providerService = null;
    extensionsService = null;
    capabilityService = null;
    // No owned shell may outlive the app that started it.
    terminalService?.closeAll();
    terminalService = null;
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
  const window = new BrowserWindow(windowOptions(preloadPath, { isDev, icon: brandIconPath(here, 'mona.ico') }));
  // Scale first, then show: a window that opens at one size and jumps to another
  // is worse than a slightly later paint.
  window.webContents.setZoomFactor(zoomFactor);
  // Ctrl +/-/0 wherever focus is, including the terminal drawer. Handled here
  // rather than in the renderer so a focused iframe, textarea or xterm cannot
  // swallow it, and so the same code path serves every window.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const direction = zoomShortcut({
      key: input.key,
      code: input.code,
      control: input.control,
      meta: input.meta,
      alt: input.alt,
    });
    if (!direction) return;
    event.preventDefault();
    stepZoom(direction);
  });
  const detachWindowState = attachWindowState(window);
  window.once('closed', () => detachWindowState());
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
  // work alive; relaunching the app restores this same window. The tray says so
  // and offers explicit Interrupt now and Quit and stop work actions. With no
  // owned runtime, closing behaves normally.
  window.on('close', (event) => {
    const owned = engineHost.status();
    const hasOwnedRuntime = owned !== null && owned.state !== 'stopped' && owned.state !== 'idle';
    if (smokeTest) return;
    if (hasOwnedRuntime && !quitRequested) {
      event.preventDefault();
      window.hide();
      engineHost.handleSignal('window-closed', { closeToTray: true });
      // Say it once, on the first close, rather than leaving the window's
      // disappearance unexplained. Work continues; this is not a completion alert.
      if (uiStateStore?.markFirstCloseNotified()) {
        const notice = new Notification({
          title: 'Mona is still running',
          body: 'Closing the window hides Mona. Work continues in the tray; use Quit and stop work to end it. This message is shown once.',
          silent: true,
        });
        notice.on('click', () => showMainWindow());
        notice.show();
      }
      updateTray();
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
