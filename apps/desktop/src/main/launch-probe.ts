import { BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { LaunchDispatcher } from './launch-dispatch.js';
import type { LaunchReceipt } from '../shared/launch.js';

/**
 * End-to-end P09 probe in a real Electron window on Windows. The app is started
 * with the documented launcher command, then real second instances are spawned
 * with the same argv shape Explorer's registered command produces. Each launch
 * must reach the ready studio with a focused composer, and no launch may submit
 * a task or duplicate a project.
 */
export type LaunchProbeResult = {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; detail?: unknown }>;
  shots: Array<{ file: string; label: string }>;
  fixtures: { a: string; b: string };
  receipts: LaunchReceipt[];
  windows: number;
  noTaskEvidence: {
    studioThread: string | null;
    timelineItems: number;
    spendA: { turnCount: number; knownCostMicros: number };
    spendB: { turnCount: number; knownCostMicros: number };
  };
  engine: { state: string; workspace: string | null };
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  capturedAt: string;
};

export type LaunchProbeInput = {
  window: BrowserWindow;
  dispatcher: LaunchDispatcher;
  fixtures: { a: string; b: string };
  shotsDirectory: string;
  outputPath: string;
  electronPath: string;
  appPath: string;
  stopEngine: () => Promise<void>;
  engineSummary: () => { state: string; workspace: string | null };
};

type Envelope<T> = { ok: boolean; data?: T; error?: { code: string; message: string } };
type ProjectView = { id: string; label: string; canonicalPath: string };
type UiState = { currentProjectId: string | null; projects: Record<string, { currentSessionId: string }> };
type StudioView = { thread: unknown; items: unknown[]; run: { state: string } };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function samePath(left: string | null | undefined, right: string): boolean {
  if (!left) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

export async function runLaunchProbe(input: LaunchProbeInput): Promise<LaunchProbeResult> {
  const steps: LaunchProbeResult['steps'] = [];
  const shots: LaunchProbeResult['shots'] = [];
  const window = input.window;
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    process.stdout.write(
      `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 700)}`}\n`,
    );
  };
  const evaluate = async <T>(expression: string): Promise<T> =>
    (await window.webContents.executeJavaScript(expression, true)) as T;
  const call = async <T>(expression: string): Promise<Envelope<T>> => evaluate<Envelope<T>>(expression);
  const text = async (selector: string): Promise<string | null> =>
    evaluate<string | null>(
      `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node ? (node.textContent ?? '') : null; })()`,
    );
  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await delay(250);
    }
    return false;
  };
  const loaded = async (): Promise<void> => {
    if (!window.webContents.isLoading()) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 20_000);
      window.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };
  const shot = async (label: string): Promise<void> => {
    const file = path.join(input.shotsDirectory, `${String(shots.length + 1).padStart(2, '0')}-${label}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await delay(800);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const image = await window.webContents.capturePage();
        fs.writeFileSync(file, image.toPNG());
        shots.push({ file, label });
        return;
      } catch (error) {
        process.stdout.write(`capture ${label} attempt ${attempt} failed: ${String(error)}\n`);
        await delay(600);
      }
    }
  };

  /** Wait for a receipt that matches, whether it already happened or arrives next. */
  const waitForReceipt = async (
    predicate: (receipt: LaunchReceipt) => boolean,
    timeoutMs: number,
  ): Promise<LaunchReceipt | null> => {
    const existing = input.dispatcher.all().find((receipt) => predicate(receipt));
    if (existing) return existing;
    return await new Promise<LaunchReceipt | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const unsubscribe = input.dispatcher.onReceipt((receipt) => {
        if (!predicate(receipt)) return;
        if (timer !== null) clearTimeout(timer);
        unsubscribe();
        resolve(receipt);
      });
      timer = setTimeout(() => {
        unsubscribe();
        resolve(null);
      }, timeoutMs);
    });
  };

  const readChild = async (tag: string): Promise<{ argv?: string[] } | null> => {
    try {
      return JSON.parse(fs.readFileSync(path.join(input.shotsDirectory, `child-${tag}.json`), 'utf8')) as {
        argv?: string[];
      };
    } catch {
      return null;
    }
  };

  const spawnSecondInstance = async (args: string[], tag: string): Promise<number> => {
    const childOut = path.join(input.shotsDirectory, `child-${tag}.json`);
    const child = spawn(input.electronPath, [input.appPath, ...args], {
      cwd: input.appPath,
      env: { ...process.env, MONA_LAUNCH_CHILD_OUT: childOut },
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 30_000);
    const code = await new Promise<number | null>((resolve) => child.on('exit', (value) => resolve(value)));
    clearTimeout(timer);
    return code ?? -1;
  };

  const launchArgs = (folder: string): string[] => ['project', 'open', '--path', folder, '--profile', 'ds-full-access'];

  const labelA = path.basename(input.fixtures.a);
  const labelB = path.basename(input.fixtures.b);

  await loaded();
  await delay(700);

  // 1. The app's own command line, exactly as the registered Explorer command
  //    produces it.
  const initial = await waitForReceipt((receipt) => receipt.source === 'startup', 90_000);
  check(
    'the startup command opens the folder Explorer selected',
    initial !== null &&
      (initial.status === 'ready' || initial.status === 'opened') &&
      samePath(initial.project?.canonicalPath, input.fixtures.a),
    initial ? { status: initial.status, project: initial.project?.canonicalPath, detail: initial.detail } : null,
  );
  const studioA = await waitFor(async () => (await text('[data-testid="studio-title"]')) === labelA, 60_000);
  check('the shell opens the studio for that folder', studioA, { title: await text('[data-testid="studio-title"]') });
  const focusedA = await waitFor(
    async () =>
      (await evaluate<string | null>('document.activeElement ? document.activeElement.id : null')) === 'draft',
    30_000,
  );
  check('the ready composer takes focus', focusedA, {
    activeElement: await evaluate<string | null>('document.activeElement ? document.activeElement.id : null'),
  });
  check(
    'the context bar shows the route and the saved profile',
    (await text('[data-testid="context-model"]')) === 'deepseek-flash' &&
      ((await text('[data-testid="context-permission"]')) ?? '').includes('Full Access'),
    {
      model: await text('[data-testid="context-model"]'),
      permission: await text('[data-testid="context-permission"]'),
    },
  );
  await shot('launched-from-explorer-command');

  // A launch is not a task: no thread, no timeline item, no spend.
  const readStudio = async (projectId: string, sessionId: string): Promise<StudioView | null> => {
    const result = await call<StudioView>(
      `window.mona.studioGet({ projectId: ${JSON.stringify(projectId)}, sessionId: ${JSON.stringify(sessionId)}, mode: 'agent' })`,
    );
    return result.ok ? (result.data ?? null) : null;
  };
  const uiState = await call<UiState>('window.mona.getUiState()');
  const initialProjectId = initial?.project?.id ?? null;
  const initialSession =
    initialProjectId && uiState.ok ? (uiState.data?.projects[initialProjectId]?.currentSessionId ?? null) : null;
  const studioBefore = initialProjectId && initialSession ? await readStudio(initialProjectId, initialSession) : null;
  check(
    'opening from Explorer creates no thread and no message',
    studioBefore !== null && studioBefore.thread === null && studioBefore.items.length === 0,
    {
      thread: studioBefore?.thread ?? null,
      items: studioBefore?.items.length ?? null,
    },
  );

  // 2. A folder-background launch arrives as a second instance and reuses the app.
  const codeB = await spawnSecondInstance(launchArgs(input.fixtures.b), 'b');
  check('the second instance exits instead of opening a second app', codeB === 0, { exitCode: codeB });
  const childB = await readChild('b');
  check(
    'the second instance received the documented launcher argv intact',
    childB?.argv?.slice(-6).join('\u0000') ===
      ['project', 'open', '--path', input.fixtures.b, '--profile', 'ds-full-access'].join('\u0000'),
    { argv: childB?.argv ?? null },
  );
  const secondB = await waitForReceipt(
    (receipt) => receipt.source === 'second-instance' && samePath(receipt.openedPath, input.fixtures.b),
    90_000,
  );
  check(
    'the running owner receives the second selection',
    secondB !== null && (secondB.status === 'ready' || secondB.status === 'opened'),
    secondB ? { status: secondB.status, seq: secondB.seq, detail: secondB.detail } : null,
  );
  const studioB = await waitFor(async () => (await text('[data-testid="studio-title"]')) === labelB, 60_000);
  check('the window switches to the second project', studioB, {
    title: await text('[data-testid="studio-title"]'),
  });
  const focusedB = await waitFor(
    async () =>
      (await evaluate<string | null>('document.activeElement ? document.activeElement.id : null')) === 'draft',
    30_000,
  );
  check('the composer is focused after the second launch', focusedB, {
    activeElement: await evaluate<string | null>('document.activeElement ? document.activeElement.id : null'),
  });
  const windows = BrowserWindow.getAllWindows().filter((entry) => !entry.isDestroyed()).length;
  check('still exactly one application window', windows === 1, { windows });
  await shot('second-launch-switched-project');

  // 3. Launching the same folder again (with a trailing separator and different
  //    case) reuses the project entry; it does not duplicate it.
  const catalogueBefore = await call<ProjectView[]>('window.mona.listProjects({ includeArchived: true })');
  const countBefore = catalogueBefore.ok ? (catalogueBefore.data?.length ?? -1) : -2;
  const projectIdBefore = secondB?.project?.id ?? null;
  const codeRepeat = await spawnSecondInstance(launchArgs(`${input.fixtures.b}${path.sep}`.toUpperCase()), 'repeat');
  check('a repeat launch exits as a second instance', codeRepeat === 0, { exitCode: codeRepeat });
  const repeat = await waitForReceipt(
    (receipt) => receipt.seq > (secondB?.seq ?? 0) && samePath(receipt.openedPath, input.fixtures.b),
    90_000,
  );
  const catalogueAfter = await call<ProjectView[]>('window.mona.listProjects({ includeArchived: true })');
  const countAfter = catalogueAfter.ok ? (catalogueAfter.data?.length ?? -1) : -2;
  check(
    'a repeat launch reuses the same project and adds no entry',
    repeat !== null && repeat.project?.id === projectIdBefore && countAfter === countBefore,
    { before: countBefore, after: countAfter, projectId: repeat?.project?.id ?? null },
  );
  check(
    'the hostile folder name arrived as one inert argument',
    repeat !== null && repeat.requestedPath?.toLowerCase() === input.fixtures.b.toLowerCase(),
    { requestedPath: repeat?.requestedPath ?? null },
  );

  // 4. Two fast launches: serialized receipts, newest ready project selected.
  const sequenceBefore = input.dispatcher.count();
  const [firstFast, secondFast] = await Promise.all([
    spawnSecondInstance(launchArgs(input.fixtures.a), 'fast-a'),
    spawnSecondInstance(launchArgs(input.fixtures.b), 'fast-b'),
  ]);
  check('both fast launches exited as second instances', firstFast === 0 && secondFast === 0, {
    firstFast,
    secondFast,
  });
  const arrived = await waitFor(async () => input.dispatcher.count() >= sequenceBefore + 2, 90_000);
  await input.dispatcher.idle();
  const fastReceipts = input.dispatcher.all().slice(-2);
  check(
    'two fast launches produce two ordered receipts',
    arrived && fastReceipts.length === 2 && (fastReceipts[0]?.seq ?? 0) < (fastReceipts[1]?.seq ?? 0),
    { seqs: fastReceipts.map((receipt) => receipt.seq), paths: fastReceipts.map((receipt) => receipt.openedPath) },
  );
  const newest = input.dispatcher.latest();
  const newestLabel = newest?.project?.label ?? null;
  const latestApplied = await waitFor(async () => (await text('[data-testid="studio-title"]')) === newestLabel, 60_000);
  check('the newest completed launch is the project on screen', latestApplied, {
    newest: newestLabel,
    title: await text('[data-testid="studio-title"]'),
  });
  await shot('two-fast-launches');

  // 5. A missing path is reported and changes nothing on screen.
  const titleBeforeMissing = await text('[data-testid="studio-title"]');
  const codeMissing = await spawnSecondInstance(
    launchArgs(path.join(path.dirname(input.fixtures.a), 'not-a-real-folder')),
    'missing',
  );
  check('a missing-folder launch exits as a second instance', codeMissing === 0, { exitCode: codeMissing });
  const missing = await waitForReceipt(
    (receipt) => receipt.status === 'rejected' && (receipt.detail ?? '').includes('was not found'),
    90_000,
  );
  await delay(700);
  check(
    'a missing folder is reported and leaves the current project alone',
    missing !== null && (await text('[data-testid="studio-title"]')) === titleBeforeMissing,
    { detail: missing?.detail ?? null, title: await text('[data-testid="studio-title"]') },
  );

  // 6. Independent no-model-work evidence for both projects.
  const spendFor = async (projectId: string | null) => {
    if (!projectId) return { turnCount: 0, knownCostMicros: 0 };
    const result = await call<{ turnCount: number; knownCostMicros: number }>(
      `window.mona.projectSpend(${JSON.stringify(projectId)})`,
    );
    return result.ok ? (result.data ?? { turnCount: 0, knownCostMicros: 0 }) : { turnCount: -1, knownCostMicros: -1 };
  };
  const spendA = await spendFor(initialProjectId);
  const spendB = await spendFor(projectIdBefore);
  check('no launch recorded a paid turn', spendA.turnCount === 0 && spendB.turnCount === 0, { spendA, spendB });

  await input.stopEngine();
  const engine = input.engineSummary();

  const result: LaunchProbeResult = {
    ok: steps.every((step) => step.ok),
    steps,
    shots,
    fixtures: input.fixtures,
    receipts: input.dispatcher.all(),
    windows,
    noTaskEvidence: {
      studioThread: studioBefore?.thread ? 'present' : null,
      timelineItems: studioBefore?.items.length ?? 0,
      spendA,
      spendB,
    },
    engine,
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    platform: process.platform,
    capturedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(path.resolve(input.outputPath)), { recursive: true });
  fs.writeFileSync(input.outputPath, JSON.stringify(result, null, 2), 'utf8');
  return result;
}
