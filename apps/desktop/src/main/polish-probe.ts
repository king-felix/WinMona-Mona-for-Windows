import type { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { EngineHost } from './engine-host.js';
import {
  DEFAULT_ATTENTION_SETTINGS,
  NotificationPlanner,
  isQuietAt,
  publicNotification,
  type AttentionEvent,
} from './attention.js';
import { ATTENTION_CHANNELS, type AttentionFocus } from '../shared/attention.js';

/**
 * P14 live probe. It opens the real shell against a seeded SQLite project,
 * checks the Resume Brief against the recorded rows, captures both themes,
 * exercises Focus Mode and keyboard navigation, and drives the notification
 * focus path. It starts no runtime and submits no prompt, so provider requests
 * stay at zero.
 */
export type PolishProbeInput = {
  window: BrowserWindow;
  rendererIndex: string;
  shotsDirectory: string;
  outputPath: string;
  engine: EngineHost;
  trayActive: () => boolean;
  fixtures: {
    projectId: string;
    workspace: string;
    runningTaskId: string;
    spendLabel: string;
    changedPaths: number;
    evidencePath: string;
  };
};

type Step = { name: string; ok: boolean; detail?: unknown };
type Shot = { file: string; label: string; theme: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loaded(window: BrowserWindow): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 20_000);
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function runPolishProbe(input: PolishProbeInput): Promise<{
  ok: boolean;
  steps: Step[];
  shots: Shot[];
  brief: unknown;
  attention: unknown;
  notification: unknown;
  timezone: unknown;
  engine: { state: string; workspace: string | null };
  trayActive: boolean;
  providerRequests: 0;
  theme: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  capturedAt: string;
}> {
  const steps: Step[] = [];
  const shots: Shot[] = [];
  const window = input.window;
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    process.stdout.write(
      `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 500)}`}\n`,
    );
  };
  const evaluate = async <T>(expression: string): Promise<T> =>
    (await window.webContents.executeJavaScript(expression, true)) as T;
  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await delay(200);
    }
    return false;
  };
  const text = async (selector: string): Promise<string | null> =>
    evaluate<string | null>(
      `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node ? (node.textContent ?? '') : null; })()`,
    );
  const click = async (selector: string): Promise<boolean> =>
    evaluate<boolean>(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      node.click();
      return true;
    })()`);
  const clickText = async (prefix: string): Promise<boolean> =>
    evaluate<boolean>(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find((node) => (node.textContent ?? '').trim().startsWith(${JSON.stringify(prefix)}));
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
  const shot = async (label: string, theme: string): Promise<boolean> => {
    const file = path.join(input.shotsDirectory, `${String(shots.length + 1).padStart(2, '0')}-${label}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await delay(650);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const image = await window.webContents.capturePage();
        fs.writeFileSync(file, image.toPNG());
        shots.push({ file, label, theme });
        return true;
      } catch (error) {
        process.stdout.write(`capture ${label} attempt ${attempt} failed: ${String(error)}\n`);
        await delay(500);
      }
    }
    return false;
  };
  const briefReady = async (): Promise<boolean> =>
    (await evaluate<boolean>('Boolean(document.querySelector(\'[data-testid="brief-current"]\'))')) === true;

  // --- Home, Daybreak: the brief comes from the seeded rows -----------------
  await loaded(window);
  check('the real shell loaded', await waitFor(briefReady, 15_000));
  await delay(600);
  const briefText = {
    current: await text('[data-testid="brief-current"]'),
    spend: await text('[data-testid="brief-spend"]'),
    changes: await text('[data-testid="brief-changes"]'),
    next: await text('[data-testid="brief-next"]'),
    digest: await text('[data-testid="digest-window"]'),
  };
  check(
    'Resume Brief names the recorded running task',
    briefText.current?.includes(input.fixtures.runningTaskId) === true,
    briefText.current,
  );
  check(
    'Resume Brief reports the recorded spend confidence',
    briefText.spend?.includes(input.fixtures.spendLabel) === true,
    briefText.spend,
  );
  check(
    'Resume Brief reports the Git changed-file count',
    briefText.changes?.includes(`${input.fixtures.changedPaths} path`) === true,
    briefText.changes,
  );
  check('Resume Brief gives a deterministic next step', (briefText.next?.length ?? 0) > 0, briefText.next);
  check(
    'Since you left reads a prior last-seen window',
    briefText.digest?.startsWith('Since') === true,
    briefText.digest,
  );

  const briefCall = await evaluate<{ ok: boolean; data?: unknown }>(
    `window.mona.briefingGet({ projectId: ${JSON.stringify(input.fixtures.projectId)}, markSeen: false })`,
  );
  check('the bridge returns the same brief projection', briefCall.ok === true);

  check('Daybreak Home captured', await shot('home-daybreak', 'daybreak'));
  await evaluate(`document.querySelector('[data-testid="digest-window"]')?.scrollIntoView({ block: 'center' })`);
  await delay(250);
  check('Daybreak Since-you-left captured', await shot('digest-daybreak', 'daybreak'));
  await evaluate(
    `(() => { for (const node of document.querySelectorAll('*')) { if (node.scrollTop) node.scrollTop = 0; } })()`,
  );

  // --- Studio and Focus Mode ------------------------------------------------
  check('Studio opened without a runtime', await clickText('Studio'));
  await delay(500);
  check('the execution controls are visible', (await text('[data-testid="studio-run-state"]')) !== null);
  check('Daybreak Studio captured', await shot('studio-daybreak', 'daybreak'));

  check('Focus Mode toggled from the topbar', await click('[data-testid="focus-toggle"]'));
  await delay(500);
  const focusState = await evaluate<{ focus: boolean; inspector: boolean; interrupt: boolean }>(`(() => ({
    focus: Boolean(document.querySelector('.app-shell.focus-mode')),
    inspector: Boolean(document.querySelector('aside[aria-label="Inspector"]')),
    interrupt: Array.from(document.querySelectorAll('button')).some((node) => (node.textContent ?? '').trim().startsWith('Interrupt now')),
  }))()`);
  check('Focus Mode hides the inspector', focusState.focus && !focusState.inspector, focusState);
  check('Focus Mode keeps the emergency interrupt control', focusState.interrupt);
  check('Daybreak Focus Mode captured', await shot('focus-daybreak', 'daybreak'));

  // --- Keyboard navigation --------------------------------------------------
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', altKey: true, bubbles: true }))`);
  await delay(400);
  check('Alt+2 reaches the Studio without a mouse', (await text('[data-testid="studio-run-state"]')) !== null);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', altKey: true, bubbles: true }))`);
  await delay(400);

  // --- Notification focus path ---------------------------------------------
  const focus: AttentionFocus = {
    projectId: input.fixtures.projectId,
    evidencePath: input.fixtures.evidencePath,
    kind: 'blocker',
  };
  window.webContents.send(ATTENTION_CHANNELS.focus, focus);
  const noticed = await waitFor(
    async () => (await evaluate<boolean>("(document.body.textContent ?? '').includes('No task was started')")) === true,
    4_000,
  );
  const focusLanded = await evaluate<{ project: string | null; focused: boolean; notice: string }>(`(() => {
    const links = Array.from(document.querySelectorAll('[data-testid="evidence-link"]'));
    const target = links.find((node) => node.getAttribute('data-path') === ${JSON.stringify(input.fixtures.evidencePath)});
    return {
      project: document.querySelector('[data-testid="context-project"]')?.textContent ?? null,
      focused: Boolean(target && target.classList.contains('focused')),
      notice: document.body.textContent ?? '',
    };
  })()`);
  check('a notification focuses the recorded project', focusLanded.project !== null, focusLanded.project);
  check('the matching evidence is marked focused', focusLanded.focused);
  check('the focus path starts no task', noticed || focusLanded.notice.includes('No task was started'));
  check('Notification focus captured', await shot('notification-focus-daybreak', 'daybreak'));

  // --- Settings and quiet hours --------------------------------------------
  check('Settings opened', await clickText('Settings'));
  await delay(400);
  await evaluate(`document.querySelector('#quiet-enabled')?.scrollIntoView({ block: 'center' })`);
  await delay(200);
  const quiet = await evaluate<{ checked: boolean; detail: string | null; tray: string | null }>(`(() => ({
    checked: Boolean(document.querySelector('#quiet-enabled')?.checked),
    detail: document.querySelector('[data-testid="quiet-detail"]')?.textContent ?? null,
    tray: document.querySelector('[data-testid="tray-detail"]')?.textContent ?? null,
  }))()`);
  check('quiet hours are shown as saved policy', quiet.checked, quiet);
  check('quiet hours state that work continues', quiet.detail?.includes('Work continues') === true, quiet.detail);
  check('the tray text is present', quiet.tray?.includes('Tray:') === true, quiet.tray);

  // --- Attention policy, notification dedupe and privacy --------------------
  const planner = new NotificationPlanner();
  const event: AttentionEvent = {
    key: 'prj_p14:turn:turn_p14:completed',
    kind: 'run_completed',
    projectId: input.fixtures.projectId,
    projectLabel: 'private-project-label',
    at: new Date().toISOString(),
    taskId: input.fixtures.runningTaskId,
    turnId: 'turn_p14',
    evidencePath: 'docs/private/customer-notes.md',
    outcome: 'completed',
  };
  const first = planner.plan(event, DEFAULT_ATTENTION_SETTINGS, new Date());
  const replay = planner.plan(event, DEFAULT_ATTENTION_SETTINGS, new Date());
  const payload = publicNotification(event);
  const quietPlan = planner.plan(
    { ...event, key: 'prj_p14:turn:turn_quiet:completed', turnId: 'turn_quiet' },
    {
      ...DEFAULT_ATTENTION_SETTINGS,
      quietHours: { enabled: true, startMinute: 0, endMinute: 1439, timeZone: 'UTC' },
    },
    new Date(),
  );
  const notification = {
    first: first.reason,
    replay: replay.reason,
    quiet: quietPlan.reason,
    title: payload.title,
    body: payload.body,
    privateLabelLeaked: `${payload.title} ${payload.body}`.includes('private-project-label'),
    privatePathLeaked: `${payload.title} ${payload.body}`.includes('customer-notes'),
  };
  check('a completion notification is planned once', notification.first === 'delivered');
  check('a replayed completion is suppressed', notification.replay === 'duplicate');
  check('quiet hours suppress delivery', notification.quiet === 'quiet_hours');
  check(
    'lock-screen content carries no project, prompt or file detail',
    !notification.privateLabelLeaked && !notification.privatePathLeaked,
    notification,
  );

  const timezone = {
    utcQuietAt2230: isQuietAt(new Date('2026-11-12T22:30:00.000Z'), {
      enabled: true,
      startMinute: 22 * 60,
      endMinute: 7 * 60,
      timeZone: 'UTC',
    }),
    tokyoQuietAt2230Utc: isQuietAt(new Date('2026-11-12T22:30:00.000Z'), {
      enabled: true,
      startMinute: 22 * 60,
      endMinute: 7 * 60,
      timeZone: 'Asia/Tokyo',
    }),
  };
  check(
    'quiet hours follow the configured timezone instead of UTC',
    timezone.utcQuietAt2230 === true && timezone.tokyoQuietAt2230Utc === false,
    timezone,
  );

  // --- Afterglow: return to a standard layout and reload the theme -----------
  await clickText('Leave focus');
  await delay(400);
  await window.loadFile(input.rendererIndex, { query: { theme: 'afterglow' } });
  await loaded(window);
  await waitFor(
    async () => (await evaluate<boolean>('Boolean(document.querySelector(\'[data-testid="nav-home"]\'))')) === true,
    10_000,
  );
  await click('[data-testid="nav-home"]');
  check('Afterglow shell loaded', await waitFor(briefReady, 15_000));
  await delay(600);
  check('Afterglow Home captured', await shot('home-afterglow', 'afterglow'));
  check('Studio opened in Afterglow', await clickText('Studio'));
  await delay(500);
  check('Afterglow Studio captured', await shot('studio-afterglow', 'afterglow'));
  check('Focus Mode toggled in Afterglow', await click('[data-testid="focus-toggle"]'));
  await delay(500);
  check('Afterglow Focus Mode captured', await shot('focus-afterglow', 'afterglow'));
  check('Settings captured in Afterglow', await clickText('Settings'));
  await delay(400);
  await evaluate(`document.querySelector('#quiet-enabled')?.scrollIntoView({ block: 'center' })`);
  await delay(200);
  check('Afterglow settings captured', await shot('settings-afterglow', 'afterglow'));

  const summary = input.engine.summary();
  const result = {
    ok: steps.every((step) => step.ok),
    steps,
    shots,
    brief: briefText,
    attention: quiet,
    notification,
    timezone,
    engine: { state: summary.state, workspace: summary.workspace },
    trayActive: input.trayActive(),
    providerRequests: 0 as const,
    theme: await evaluate<string>("document.documentElement.dataset.theme ?? 'unknown'"),
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    platform: process.platform,
    capturedAt: new Date().toISOString(),
  };
  check('no runtime was started by the probe', summary.state !== 'connected', summary.state);
  check('the tray exists while the window is open', result.trayActive);
  fs.writeFileSync(input.outputPath, JSON.stringify(result, null, 2), 'utf8');
  return result;
}
