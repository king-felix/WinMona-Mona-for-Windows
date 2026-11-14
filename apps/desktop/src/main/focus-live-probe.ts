import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { DatabaseSync } from 'node:sqlite';

/**
 * W06 live probe: Focus Studio and native fullscreen during an actual streaming
 * turn.
 *
 * The offline probe (`focus-probe.ts`) proved the layout and the window boundary
 * with no runtime. This one starts the owned runtime, submits one bounded task
 * through the real composer, and then repeats the transitions while the engine's
 * own delta frames are arriving: Focus on/off, native fullscreen through the
 * button and F11, minimize/restore, and an open drawer. It records the delta
 * count before and after each transition, so "while streaming" is an
 * observation rather than an assumption.
 *
 * Exactly one prompt is submitted. The probe asserts afterwards that the project
 * recorded one turn, that the thread identity never changed, and that the engine
 * was never restarted or remounted.
 */
export type FocusLiveProbeInput = {
  window: BrowserWindow;
  rendererIndex: string;
  outputPath: string;
  shotsDirectory: string;
  workspace: string;
  taskText: string;
  database: () => DatabaseSync | null;
  sessionId: (projectId: string) => string | null;
};

type Step = { name: string; ok: boolean; detail?: unknown };
type Shot = { file: string; label: string };
type Envelope<T> = { ok: boolean; data?: T; error?: { code: string; message: string } };

type StudioView = {
  sessionId: string | null;
  thread: { threadId: string; permissionPosture: string } | null;
  items: Array<{ kind: string; title: string; status: string | null; body: string }>;
  run: { state: string; detail: string; turnId: string | null };
  pending: unknown;
};

type TransitionSample = {
  label: string;
  runState: string;
  deltas: number;
  items: number;
  /** Characters of assistant text the studio has projected so far. */
  answerChars: number;
  draft: string;
  caret: number;
  topSeq: number | null;
  fullScreen: boolean;
  focus: boolean;
  threadId: string | null;
  engineState: string | null;
  alive: boolean;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runFocusLiveProbe(input: FocusLiveProbeInput): Promise<{
  ok: boolean;
  steps: Step[];
  shots: Shot[];
  samples: TransitionSample[];
  windows: Array<{ window: string; runState: string; gainedWork: boolean }>;
  providerRequests: number;
  capturedAt: string;
  limitation: string;
}> {
  const steps: Step[] = [];
  const shots: Shot[] = [];
  const samples: TransitionSample[] = [];
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
  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate().catch(() => false)) return true;
      await delay(150);
    }
    return false;
  };
  const text = async (selector: string): Promise<string | null> =>
    evaluate<string | null>(
      `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node ? (node.textContent ?? '') : null; })()`,
    );
  const clickText = async (prefix: string): Promise<boolean> =>
    evaluate<boolean>(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find((node) => (node.textContent ?? '').trim().startsWith(${JSON.stringify(prefix)}));
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
  const click = async (testId: string): Promise<boolean> =>
    (await evaluate<boolean>(`(() => {
      const node = document.querySelector('[data-testid="${testId}"]');
      if (!node) return false;
      node.click();
      return true;
    })()`)) === true;
  const shot = async (label: string): Promise<void> => {
    const file = path.join(input.shotsDirectory, `${label}.png`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const image = await window.webContents.capturePage();
      fs.writeFileSync(file, image.toPNG());
      shots.push({ file, label });
    } catch {
      /* a capture failure is not a contract failure */
    }
  };
  const nativeState = async (): Promise<{ fullScreen: boolean; maximized: boolean; width: number; height: number }> => {
    const result = (await evaluate<unknown>(`window.mona.windowStateGet().then((r) => (r.ok ? r.data : null))`)) as {
      fullScreen: boolean;
      maximized: boolean;
      width: number;
      height: number;
    } | null;
    if (!result) throw new Error('window state unavailable');
    return result;
  };
  const focusMode = async (): Promise<boolean> =>
    (await evaluate<boolean>(`document.querySelector('.app-shell')?.classList.contains('focus-mode') === true`)) ===
    true;
  const studio = async (projectId: string, sessionId: string): Promise<StudioView | null> => {
    const result = await call<StudioView>(
      `window.mona.studioGet({ projectId: ${JSON.stringify(projectId)}, sessionId: ${JSON.stringify(sessionId)}, mode: 'agent' })`,
    );
    return result.ok ? (result.data ?? null) : null;
  };
  // The renderer counts the studio's own delta pushes. A transition that reports
  // a higher count afterwards happened while text was streaming.
  const deltas = async (): Promise<number> => evaluate<number>('window.__w06Deltas ?? 0');
  const alive = async (): Promise<boolean> => evaluate<boolean>("window.__w06Mark === 'kept'");
  const sample = async (label: string, projectId: string, sessionId: string): Promise<TransitionSample> => {
    const view = await studio(projectId, sessionId);
    const row: TransitionSample = {
      label,
      runState: view?.run.state ?? 'unknown',
      deltas: await deltas(),
      items: view?.items.length ?? -1,
      answerChars: (view?.items ?? [])
        .filter((item) => item.kind === 'assistant')
        .reduce((total, item) => total + item.body.length, 0),
      draft: await evaluate<string>('document.querySelector("#draft")?.value ?? ""'),
      caret: await evaluate<number>('document.querySelector("#draft")?.selectionStart ?? -1'),
      topSeq: await evaluate<number | null>(`(() => {
        const node = document.querySelector('.timeline');
        if (!node) return null;
        const top = node.getBoundingClientRect().top;
        const first = [...node.querySelectorAll('[data-seq]')].find((item) => item.getBoundingClientRect().bottom > top + 1);
        return first ? Number(first.getAttribute('data-seq')) : null;
      })()`),
      fullScreen: (await nativeState()).fullScreen,
      focus: await focusMode(),
      threadId: view?.thread?.threadId ?? null,
      engineState: await text('[data-testid="engine-state"]'),
      alive: await alive(),
    };
    samples.push(row);
    return row;
  };

  await waitFor(async () => (await evaluate<boolean>("document.readyState === 'complete'")) === true, 45_000);
  const opened = await call<{ project: { id: string; canonicalPath: string } }>(
    `window.mona.openProject(${JSON.stringify(input.workspace)})`,
  );
  const projectId = opened.ok ? (opened.data?.project.id ?? null) : null;
  check(
    'the fixture project opens in the real catalog',
    projectId !== null && opened.data?.project.canonicalPath.toLowerCase() === input.workspace.toLowerCase(),
    opened.ok ? { canonicalPath: opened.data?.project.canonicalPath } : opened.error,
  );
  if (!projectId) {
    return {
      ok: false,
      steps,
      shots,
      samples,
      windows: [],
      providerRequests: 0,
      capturedAt: new Date().toISOString(),
      limitation: 'no project opened',
    };
  }

  // A long stored conversation gives the reader somewhere to scroll back to
  // before the live turn starts. It is seeded as stored rows, not engine events.
  const session = input.sessionId(projectId);
  const database = input.database();
  let seeded = 0;
  if (session && database) {
    const threadId = `thr_w06live_${Date.now().toString(36)}`;
    const stamp = new Date().toISOString();
    database
      .prepare(
        'INSERT INTO threads (id, project_id, engine_thread_id, workspace, last_seq, created_at, updated_at, session_id, mode, profile_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      )
      .run(threadId, projectId, `w06live-${threadId}`, input.workspace, 300, stamp, stamp, session, 'agent');
    const insert = database.prepare(
      'INSERT INTO timeline_items (id, project_id, thread_id, turn_id, seq, kind, title, body, status, truncated, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, 0, ?, ?)',
    );
    database.exec?.('BEGIN');
    for (let index = 1; index <= 300; index += 1) {
      insert.run(
        `w06live_${threadId}_${index}`,
        projectId,
        threadId,
        index,
        index % 6 === 0 ? 'tool' : 'assistant',
        `Stored event ${index}`,
        `Fixture body ${index}: the reader keeps this row while the engine streams.`,
        stamp,
        stamp,
      );
      seeded += 1;
    }
    database.exec?.('COMMIT');
  }
  check('a stored conversation exists for the scroll test', seeded > 0, { seeded });

  await window.loadFile(input.rendererIndex);
  await waitFor(async () => (await evaluate<boolean>("document.readyState === 'complete'")) === true, 45_000);
  await delay(900);
  check('the shell is on the project studio', (await text('[data-testid="studio-title"]')) !== null, {
    title: await text('[data-testid="studio-title"]'),
  });
  if (!session) {
    return {
      ok: false,
      steps,
      shots,
      samples,
      windows: [],
      providerRequests: 0,
      capturedAt: new Date().toISOString(),
      limitation: 'the probe has no session id',
    };
  }
  await evaluate(`(() => {
    window.__w06Mark = 'kept';
    window.__w06Deltas = 0;
    window.mona.onStudioEvent((event) => {
      if (event && event.type === 'delta') window.__w06Deltas += 1;
    });
    return true;
  })()`);

  // Start the owned runtime through the rendered control.
  const connected = await clickText('Connect engine');
  const engineReady = await waitFor(
    async () => (await text('[data-testid="engine-state"]')) === 'Engine connected',
    150_000,
  );
  check('the Connect engine control starts the owned runtime', connected && engineReady, {
    engine: await text('[data-testid="engine-state"]'),
  });
  if (!engineReady) {
    return {
      ok: false,
      steps,
      shots,
      samples,
      windows: [],
      providerRequests: 0,
      capturedAt: new Date().toISOString(),
      limitation: 'the owned runtime did not connect; no live turn was attempted',
    };
  }

  // One bounded prompt, submitted once through the real composer.
  await evaluate(`(() => {
    const node = document.querySelector('#draft');
    if (!node) return false;
    node.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(node, ${JSON.stringify(input.taskText)});
    node.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await delay(400);
  const submitted = await clickText('Submit');
  const running = await waitFor(async () => {
    const state = await text('[data-testid="studio-run-state"]');
    return state === 'Running' || state === 'Preparing';
  }, 30_000);
  check('the bounded prompt is accepted and the turn starts', submitted && running, {
    state: await text('[data-testid="studio-run-state"]'),
  });
  if (!running) {
    return {
      ok: false,
      steps,
      shots,
      samples,
      windows: [],
      providerRequests: 0,
      capturedAt: new Date().toISOString(),
      limitation: 'the turn never reached a running state; no transitions were exercised',
    };
  }
  await shot('focus-live-01-streaming');

  // A second draft is typed while the runtime is answering. It must never be
  // sent and must survive every transition (W01's guarantee, under live load).
  const unsent = 'this draft was typed while the engine was streaming and must not be sent';
  await evaluate(`(() => {
    const node = document.querySelector('#draft');
    if (!node) return false;
    node.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(node, ${JSON.stringify(unsent)});
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.setSelectionRange(14, 14);
    return true;
  })()`);
  await evaluate(`(() => {
    const node = document.querySelector('.timeline');
    if (!node) return false;
    node.scrollTop = Math.max(0, Math.round(node.scrollHeight * 0.3));
    return true;
  })()`);
  await delay(350);

  // Wait for the runtime's first work before changing the window: the engine
  // spends several seconds reasoning before its first streamed frame, and a
  // transition that happens in that gap would prove nothing about streaming.
  const firstWork = await waitFor(async () => {
    const view = await studio(projectId, session);
    if (!view) return false;
    const chars = view.items
      .filter((item) => item.kind === 'assistant')
      .reduce((total, item) => total + item.body.length, 0);
    return chars > 0 || (await deltas()) > 0 || view.items.length > 2;
  }, 180_000);
  check('the runtime has begun producing output for this turn', firstWork, {
    firstWork,
    runState: (await studio(projectId, session))?.run.state ?? null,
  });

  const before = await sample('before transitions', projectId, session);
  const firstThreadId = before.threadId;
  check('the turn is live before any window change', before.runState === 'running', {
    deltas: before.deltas,
    runState: before.runState,
    items: before.items,
    answerChars: before.answerChars,
  });
  // "Streaming" is observed, not assumed: a delta frame, a new timeline row or
  // longer assistant text must arrive between two samples taken across a
  // transition. The pinned engine may complete short answers without deltas.
  const progressed = (from: TransitionSample, to: TransitionSample): boolean =>
    to.deltas > from.deltas || to.items > from.items || to.answerChars > from.answerChars;

  // 1. Focus on, streaming.
  await click('studio-focus-toggle');
  const focused = await waitFor(async () => (await focusMode()) === true);
  await delay(250);
  const inFocus = await sample('focus on', projectId, session);
  check(
    'Focus during streaming keeps the draft, caret, scroll anchor and the live turn',
    focused &&
      inFocus.draft === unsent &&
      inFocus.caret === before.caret &&
      inFocus.topSeq === before.topSeq &&
      inFocus.runState === 'running' &&
      inFocus.threadId === firstThreadId &&
      inFocus.engineState === 'Engine connected' &&
      inFocus.alive,
    {
      focus: inFocus.focus,
      draftKept: inFocus.draft === unsent,
      caret: [before.caret, inFocus.caret],
      topSeq: [before.topSeq, inFocus.topSeq],
      runState: inFocus.runState,
      deltasBefore: before.deltas,
      deltasAfter: inFocus.deltas,
    },
  );
  check(
    'the live turn progressed across the Focus transition',
    progressed(before, inFocus) || progressed(inFocus, await sample('after focus', projectId, session)),
    {
      before: { deltas: before.deltas, items: before.items, answerChars: before.answerChars },
      inFocus: { deltas: inFocus.deltas, items: inFocus.items, answerChars: inFocus.answerChars },
    },
  );
  await shot('focus-live-02-focus-streaming');

  // 2. Native fullscreen, streaming.
  await click('studio-fullscreen-toggle');
  const entered = await waitFor(async () => (await nativeState()).fullScreen === true);
  await delay(250);
  const inFull = await sample('fullscreen on', projectId, session);
  check(
    'fullscreen during streaming keeps the draft, caret, anchor and the live turn',
    entered &&
      inFull.fullScreen &&
      inFull.draft === unsent &&
      inFull.caret === before.caret &&
      inFull.topSeq === before.topSeq &&
      inFull.runState === 'running' &&
      inFull.threadId === firstThreadId &&
      inFull.engineState === 'Engine connected' &&
      inFull.alive,
    {
      fullScreen: inFull.fullScreen,
      focus: inFull.focus,
      draftKept: inFull.draft === unsent,
      topSeq: [before.topSeq, inFull.topSeq],
      runState: inFull.runState,
      deltas: inFull.deltas,
    },
  );
  await shot('focus-live-03-fullscreen-streaming');

  // 3. F11 out and back in, streaming.
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F11' });
  const leftFull = await waitFor(async () => (await nativeState()).fullScreen === false);
  const afterF11 = await sample('F11 out', projectId, session);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F11' });
  const backFull = await waitFor(async () => (await nativeState()).fullScreen === true);
  check(
    'F11 leaves and re-enters full screen once each while the turn streams',
    leftFull && backFull && afterF11.draft === unsent && afterF11.runState === 'running',
    { leftFull, backFull, runState: afterF11.runState, draftKept: afterF11.draft === unsent },
  );

  // 4. A drawer held open across a transition, streaming.
  const drawerOpened = await clickText('Terminal');
  await delay(500);
  const drawerBefore = await evaluate<boolean>(`Boolean(document.querySelector('.terminal-drawer'))`);
  await click('studio-fullscreen-toggle');
  const drawerAfter = await waitFor(async () => (await nativeState()).fullScreen === false);
  const drawerStillOpen = await evaluate<boolean>(`Boolean(document.querySelector('.terminal-drawer'))`);
  check(
    'a drawer stays open across leaving fullscreen during streaming',
    drawerOpened && drawerBefore && drawerStillOpen,
    {
      drawerOpened,
      drawerBefore,
      drawerStillOpen,
      leftFullscreen: drawerAfter,
    },
  );
  await clickText('Terminal');
  await delay(300);

  // 5. Minimize and restore, streaming.
  window.minimize();
  await delay(600);
  const minimized = window.isMinimized();
  window.restore();
  await delay(900);
  const restored = !window.isMinimized() && !window.isDestroyed();
  const afterRestore = await sample('minimize/restore', projectId, session);
  check(
    'minimize and restore keep the streaming turn and the window usable',
    minimized && restored && afterRestore.draft === unsent && afterRestore.alive,
    {
      minimized,
      restored,
      draftKept: afterRestore.draft === unsent,
      runState: afterRestore.runState,
      engineState: afterRestore.engineState,
      threadId: afterRestore.threadId,
    },
  );

  // 6. Leave Focus and fullscreen, then let the turn settle.
  await click('studio-focus-toggle');
  await waitFor(async () => (await focusMode()) === false);
  await sample('focus off', projectId, session);
  const settled = await waitFor(async () => {
    const view = await studio(projectId, session);
    return view !== null && ['idle', 'failed'].includes(view.run.state);
  }, 300_000);
  const final = await studio(projectId, session);
  check('the live turn reaches a terminal state', settled, { runState: final?.run.state ?? null });
  check(
    'the typed draft was never sent and is still in the composer',
    (await evaluate<string>('document.querySelector("#draft")?.value ?? ""')) === unsent &&
      (final?.items ?? []).every((item) => item.kind !== 'user' || !item.body.includes(unsent)),
    { draft: await evaluate<string>('document.querySelector("#draft")?.value ?? ""') },
  );
  check('the thread identity never changed across the transitions', final?.thread?.threadId === firstThreadId, {
    before: firstThreadId,
    after: final?.thread?.threadId ?? null,
  });
  const outcome = (final?.items ?? []).find((item) => item.kind === 'outcome') ?? null;
  check('the timeline records the turn and its outcome', outcome !== null, {
    kinds: (final?.items ?? []).map((item) => item.kind).slice(0, 24),
    outcome: outcome?.body?.slice(0, 300) ?? null,
  });
  const spend = await call<{ turnCount: number; knownCostMicros: number; unknownCostRecords: number }>(
    `window.mona.projectSpend(${JSON.stringify(projectId)})`,
  );
  const usage = spend.ok ? (spend.data ?? null) : null;
  check('exactly one turn was recorded for this project', usage?.turnCount === 1, usage);
  await shot('focus-live-04-complete');

  await clickText('Stop engine');
  const stopped = await waitFor(async () => (await text('[data-testid="engine-state"]')) === 'Engine stopped', 60_000);
  check('the owned runtime stops cleanly after the probe', stopped);

  const transitionsRanWhileStreaming = samples
    .filter((row) => ['focus on', 'after focus', 'fullscreen on', 'F11 out', 'minimize/restore'].includes(row.label))
    .every((row) => row.runState === 'running');
  const windows = samples.slice(1).map((row, index) => {
    const from = samples[index] as TransitionSample;
    return { window: `${from.label} -> ${row.label}`, gained: progressed(from, row) };
  });
  const windowsWithWork = windows.filter((entry) => entry.gained).length;
  check('every recorded transition happened during the running state', transitionsRanWhileStreaming, {
    states: samples.map((row) => `${row.label}:${row.runState}`),
  });
  check('runtime work arrived inside the transition windows', windowsWithWork > 0, {
    windows,
    observed: {
      deltas: samples.map((row) => row.deltas),
      answerChars: samples.map((row) => row.answerChars),
    },
  });

  return {
    ok: steps.every((step) => step.ok),
    steps,
    shots,
    samples,
    capturedAt: new Date().toISOString(),
    limitation:
      'The "answering input" variant needs a real pending native request; that surface is W08. This run covers streaming, typing, scrolled back and an open drawer with one bounded paid turn.',
    providerRequests: 1,
    windows: samples.slice(1).map((row, index) => ({
      window: `${(samples[index] as TransitionSample).label} -> ${row.label}`,
      runState: row.runState,
      gainedWork:
        row.deltas > (samples[index] as TransitionSample).deltas ||
        row.answerChars > (samples[index] as TransitionSample).answerChars ||
        row.items > (samples[index] as TransitionSample).items,
    })),
  };
}
