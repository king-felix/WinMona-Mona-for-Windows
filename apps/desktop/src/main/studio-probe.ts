import type { BrowserWindow } from 'electron';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { EngineHost } from './engine-host.js';

/**
 * End-to-end P08 probe in a real Electron window, against the real pinned
 * runtime and the real provider route. It opens a fixture project, starts the
 * owned runtime, submits one bounded task through the rendered composer, waits
 * for the runtime's own completion event, then proves the file change and the
 * test result on disk match what the timeline says.
 */
export type StudioProbeResult = {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; detail?: unknown }>;
  shots: Array<{ file: string; label: string }>;
  timeline: { kinds: string[]; outcome: string | null; permission: string | null; sessionId: string | null };
  evidence: {
    helloFile: string | null;
    checkExitCode: number | null;
    changedFilesOnDisk: string[];
  };
  spend: { turnCount: number; knownCostMicros: number; unknownCostRecords: number };
  engine: { state: string; workspace: string | null; version: string | null };
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  capturedAt: string;
};

export type StudioProbeInput = {
  window: BrowserWindow;
  rendererIndex: string;
  workspace: string;
  shotsDirectory: string;
  outputPath: string;
  engine: EngineHost;
  taskText: string;
};

type Envelope<T> = { ok: boolean; data?: T; error?: { code: string; message: string } };

type ProjectView = { id: string; label: string; canonicalPath: string };
type StudioView = {
  sessionId: string | null;
  thread: { threadId: string; permissionPosture: string; allowShell: boolean; autoApprove: boolean } | null;
  items: Array<{ kind: string; title: string; body: string }>;
  run: { state: string; detail: string };
  pending: unknown;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loaded(window: BrowserWindow): Promise<void> {
  if (!window.webContents.isLoading()) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 20_000);
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function createWorkspace(root: string): string {
  const folder = path.join(root, 'p08-fixture-project');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, 'check.mjs'),
    [
      "import { readFileSync } from 'node:fs';",
      "const text = readFileSync(new URL('./hello.txt', import.meta.url), 'utf8').trim();",
      "if (text !== 'MONA_STUDIO_OK') {",
      "  console.error('unexpected hello.txt content:', JSON.stringify(text));",
      '  process.exit(1);',
      '}',
      "console.log('MONA_STUDIO_CHECK_PASS');",
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(folder, 'README.md'),
    '# P08 fixture\n\nA small project for the live studio probe.\n',
    'utf8',
  );
  return folder;
}

export async function runStudioProbe(input: StudioProbeInput): Promise<StudioProbeResult> {
  const steps: StudioProbeResult['steps'] = [];
  const shots: StudioProbeResult['shots'] = [];
  const window = input.window;
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    process.stdout.write(
      `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 600)}`}\n`,
    );
  };
  const evaluate = async <T>(expression: string): Promise<T> =>
    (await window.webContents.executeJavaScript(expression, true)) as T;
  const call = async <T>(expression: string): Promise<Envelope<T>> => evaluate<Envelope<T>>(expression);
  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await delay(250);
    }
    return false;
  };
  const clickText = async (prefix: string): Promise<boolean> =>
    evaluate<boolean>(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find((node) => (node.textContent ?? '').trim().startsWith(${JSON.stringify(prefix)}));
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
  const text = async (selector: string): Promise<string | null> =>
    evaluate<string | null>(
      `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node ? (node.textContent ?? '') : null; })()`,
    );
  const shot = async (label: string): Promise<boolean> => {
    const file = path.join(input.shotsDirectory, `${String(shots.length + 1).padStart(2, '0')}-${label}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The compositor can serve the previous frame under software rendering;
    // let the rendered state settle before capturing evidence.
    await delay(700);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const image = await window.webContents.capturePage();
        fs.writeFileSync(file, image.toPNG());
        shots.push({ file, label });
        return true;
      } catch (error) {
        process.stdout.write(`capture ${label} attempt ${attempt} failed: ${String(error)}\n`);
        await delay(600);
      }
    }
    return false;
  };
  const studio = async (projectId: string, sessionId: string): Promise<StudioView | null> => {
    const result = await call<StudioView>(
      `window.mona.studioGet({ projectId: ${JSON.stringify(projectId)}, sessionId: ${JSON.stringify(sessionId)}, mode: 'agent' })`,
    );
    return result.ok ? (result.data ?? null) : null;
  };

  const folder = createWorkspace(input.workspace);
  fs.mkdirSync(input.shotsDirectory, { recursive: true });
  await loaded(window);
  await delay(700);

  const opened = await call<{ status: string; project: ProjectView }>(
    `window.mona.openProject(${JSON.stringify(folder)})`,
  );
  check(
    'the fixture project opens in the real catalog',
    opened.ok && opened.data?.project.canonicalPath.toLowerCase() === folder.toLowerCase(),
    opened.ok ? { status: opened.data?.status } : opened.error,
  );
  const projectId = opened.ok ? (opened.data?.project.id ?? null) : null;
  if (!projectId) throw new Error('the probe could not register its fixture project');

  // Reload so the rendered shell opens on the studio for this project.
  await window.loadFile(input.rendererIndex);
  await loaded(window);
  await delay(900);
  const uiState = await call<{ projects: Record<string, { currentSessionId: string }> }>('window.mona.getUiState()');
  const sessionId = uiState.ok ? (uiState.data?.projects[projectId]?.currentSessionId ?? null) : null;
  check('the studio has a session to bind a thread to', Boolean(sessionId), { sessionId });
  if (!sessionId) throw new Error('the probe has no session id');

  const studioTitle = await text('[data-testid="studio-title"]');
  check('the shell is on the project studio', studioTitle === 'p08-fixture-project', { studioTitle });
  const before = await studio(projectId, sessionId);
  check(
    'nothing is sent just by opening and rendering the studio',
    before !== null && before.thread === null && before.items.length === 0 && before.run.state === 'idle',
    before ? { thread: before.thread, items: before.items.length, run: before.run.state } : null,
  );
  const runBefore = await text('[data-testid="studio-run-state"]');
  check('the control strip reports a ready state before any work', runBefore === 'Ready', { runBefore });
  await shot('studio-ready');

  // Start the owned runtime through the rendered control.
  const connected = await clickText('Connect engine');
  check('the Connect engine control starts the owned runtime', connected, { connected });
  const engineReady = await waitFor(async () => {
    const state = await text('[data-testid="engine-state"]');
    return state === 'Engine connected';
  }, 120_000);
  check('the runtime connects and the shell reports it', engineReady, {
    engine: engineReady ? await text('[data-testid="engine-state"]') : null,
  });

  // No thread or prompt is created by connecting; only a deliberate submit is.
  const afterConnect = await studio(projectId, sessionId);
  check(
    'connecting the engine creates no thread and no message',
    afterConnect !== null && afterConnect.thread === null && afterConnect.items.length === 0,
    afterConnect ? { thread: afterConnect.thread, items: afterConnect.items.length } : null,
  );

  // Type the task into the real composer and submit it once.
  const filled = await evaluate<boolean>(`(() => {
    const node = document.querySelector('#draft');
    if (!node) return false;
    node.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(node, ${JSON.stringify(input.taskText)});
    node.dispatchEvent(new Event('input', { bubbles: true }));
    return document.activeElement === node;
  })()`);
  await delay(500);
  const draftValue = await evaluate<string | null>(
    `(() => { const node = document.querySelector('#draft'); return node ? node.value : null; })()`,
  );
  check('the typed prompt is in the composer before sending', filled && draftValue === input.taskText, {
    filled,
    length: draftValue?.length ?? null,
  });
  await shot('composer-filled');

  const submitted = await clickText('Submit');
  check('the Submit control sends the prompt', submitted, { submitted });
  const running = await waitFor(async () => {
    const state = await text('[data-testid="studio-run-state"]');
    return state === 'Running' || state === 'Preparing';
  }, 20_000);
  check('the control strip shows the turn running', running, {
    state: running ? await text('[data-testid="studio-run-state"]') : null,
  });
  await shot('turn-running');

  const settled = await waitFor(async () => {
    const state = await text('[data-testid="studio-run-state"]');
    return state === 'Ready' || state === 'Needs attention';
  }, 240_000);
  const finalState = settled ? await text('[data-testid="studio-run-state"]') : null;
  check('the turn reaches a terminal state reported by the runtime', settled, { finalState });
  await shot('turn-complete');

  const final = await studio(projectId, sessionId);
  const kinds = final?.items.map((item) => item.kind) ?? [];
  const outcome = final?.items.find((item) => item.kind === 'outcome') ?? null;
  check(
    'the timeline shows the prompt, tool work and an outcome',
    ['user', 'tool', 'outcome'].every((kind) => kinds.includes(kind)),
    {
      kinds,
    },
  );
  check('the outcome item reports completion, not an invention', (outcome?.body ?? '').includes('Status: completed'), {
    outcome: outcome?.body?.slice(0, 500) ?? null,
  });
  check(
    'the observed permission is Full Access from the runtime thread',
    final?.thread?.permissionPosture === 'full_access' &&
      ((await text('[data-testid="studio-permission"]')) ?? '').includes('Full'),
    { thread: final?.thread ?? null, permission: await text('[data-testid="studio-permission"]') },
  );

  // The on-disk truth, checked independently of the model's claim.
  const helloPath = path.join(folder, 'hello.txt');
  const hello = fs.existsSync(helloPath) ? fs.readFileSync(helloPath, 'utf8').trim() : null;
  check('the task changed a real file in the fixture project', hello === 'MONA_STUDIO_OK', { hello });

  const testRun = spawnSync(process.execPath, ['check.mjs'], {
    cwd: folder,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  check(
    'the project’s own test passes against that file',
    testRun.status === 0 && `${testRun.stdout}${testRun.stderr}`.includes('MONA_STUDIO_CHECK_PASS'),
    { status: testRun.status, output: `${testRun.stdout}${testRun.stderr}`.slice(0, 400) },
  );
  const toolBodies = (final?.items ?? []).filter((item) => item.kind === 'tool').map((item) => item.body);
  check('a tool card records the runtime’s own tool input', toolBodies.length > 0, {
    toolCards: toolBodies.length,
    first: toolBodies[0]?.slice(0, 300) ?? null,
  });
  await evaluate<boolean>(`(() => {
    const timeline = document.querySelector('.timeline');
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
    return true;
  })()`);
  await delay(250);
  await shot('outcome-card');

  const spendResult = await call<{ turnCount: number; knownCostMicros: number; unknownCostRecords: number }>(
    `window.mona.projectSpend(${JSON.stringify(projectId)})`,
  );
  const spend = spendResult.ok
    ? (spendResult.data ?? { turnCount: 0, knownCostMicros: 0, unknownCostRecords: 0 })
    : { turnCount: 0, knownCostMicros: 0, unknownCostRecords: 0 };
  check('the turn recorded usage for the project', spend.turnCount >= 1, spend);

  // Re-render the studio: opening and re-rendering still makes no request.
  await window.loadFile(input.rendererIndex);
  await loaded(window);
  await delay(1_500);
  const afterReload = await studio(projectId, sessionId);
  check(
    're-rendering the studio replays stored events without sending anything',
    afterReload !== null && afterReload.items.length === (final?.items.length ?? -1),
    { before: final?.items.length ?? null, after: afterReload?.items.length ?? null },
  );
  await shot('studio-reloaded');

  const stopped = await clickText('Stop engine');
  check('Stop engine reaches the owned runtime', stopped, { stopped });
  const stoppedState = await waitFor(
    async () => (await text('[data-testid="engine-state"]')) === 'Engine stopped',
    60_000,
  );
  check('the shell reports the runtime stopped', stoppedState, {
    engine: stoppedState ? await text('[data-testid="engine-state"]') : null,
  });
  const engine = input.engine.summary();

  const changedFilesOnDisk = fs
    .readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(folder, path.join(entry.parentPath ?? folder, entry.name))
        .split(path.sep)
        .join('/'),
    );

  const result: StudioProbeResult = {
    ok: steps.every((step) => step.ok),
    steps,
    shots,
    timeline: {
      kinds,
      outcome: outcome?.body ?? null,
      permission: final?.thread?.permissionPosture ?? null,
      sessionId,
    },
    evidence: { helloFile: hello, checkExitCode: testRun.status, changedFilesOnDisk },
    spend,
    engine: { state: engine.state, workspace: engine.workspace, version: null },
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
