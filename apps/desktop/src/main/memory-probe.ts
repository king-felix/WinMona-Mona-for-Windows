import { app, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * P23 memory probe.
 *
 * The P22 number was one aggregate: the sum of `workingSetSize` across
 * `app.getAppMetrics()`. That aggregate is real but opaque — it cannot say
 * whether a Megabyte lives in the main process, the renderer's JavaScript heap,
 * the GPU process, or a utility process, and working-set sums count shared pages
 * once per process. This probe keeps the original metric (so the comparison
 * stays honest) and adds the breakdown and the JavaScript heap, with a forced
 * garbage collection before each sample so "retained" means retained.
 *
 * Two workloads are measured with the same idle interval:
 *   A. idle — one project open on Studio, no engine, no interaction;
 *   B. changes — the same project with the Changes view showing a large diff,
 *      then navigated away, to see whether the panel and its diff stay resident.
 *
 * It submits nothing and starts no engine.
 */
export type MemoryProbeInput = {
  window: BrowserWindow | null;
  outputPath: string;
  workspace: string;
  openProject: (target: string) => Promise<{ projectId: string; canonicalPath: string } | null>;
  /** Clicks a rail section the way a person does; persistence alone does not navigate. */
  showView: (projectId: string, view: string) => void;
  prepareChanges: (projectId: string) => Promise<{ path: string; available: boolean } | null>;
  idleSeconds?: number;
  sampleIntervalSeconds?: number;
  now?: () => number;
  /** Mirrors P22's workload exactly when > 0: timeline rows for the live session. */
  historyRows?: number;
  sessionId?: (projectId: string) => string | null;
  database?: () => {
    exec?: (sql: string) => unknown;
    prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
  } | null;
  reload?: () => void;
};

type Step = { name: string; ok: boolean; detail?: unknown };

type ProcessSample = {
  pid: number;
  type: string;
  serviceName: string | null;
  name: string;
  workingSetMb: number;
  privateMb: number | null;
  cpuPercent: number;
};

type HeapSample = {
  heapUsedMb: number | null;
  heapTotalMb: number | null;
  documents: number | null;
  nodes: number | null;
  jsEventListeners: number | null;
  error: string | null;
};

function mb(kb: number): number {
  return Math.round((kb / 1024) * 10) / 10;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One forced-GC heap reading from the renderer through its own debugger session. */
async function rendererHeap(window: BrowserWindow): Promise<HeapSample> {
  const empty: HeapSample = {
    heapUsedMb: null,
    heapTotalMb: null,
    documents: null,
    nodes: null,
    jsEventListeners: null,
    error: null,
  };
  const attached = window.webContents.debugger.isAttached();
  try {
    if (!attached) window.webContents.debugger.attach('1.3');
    // Collected first: a heap reading that includes garbage is not a retention
    // measurement, and every sample below uses the same protocol sequence.
    await window.webContents.debugger.sendCommand('HeapProfiler.collectGarbage');
    const usage = (await window.webContents.debugger.sendCommand('Runtime.getHeapUsage')) as {
      usedSize: number;
      totalSize: number;
    };
    const counters = (await window.webContents.debugger.sendCommand('Memory.getDOMCounters')) as {
      documents: number;
      nodes: number;
      jsEventListeners: number;
    };
    return {
      heapUsedMb: Math.round((usage.usedSize / (1024 * 1024)) * 10) / 10,
      heapTotalMb: Math.round((usage.totalSize / (1024 * 1024)) * 10) / 10,
      documents: counters.documents,
      nodes: counters.nodes,
      jsEventListeners: counters.jsEventListeners,
      error: null,
    };
  } catch (error) {
    return { ...empty, error: String(error).slice(0, 200) };
  } finally {
    if (!attached && window.webContents.debugger.isAttached()) {
      try {
        window.webContents.debugger.detach();
      } catch {
        /* the window may already be gone */
      }
    }
  }
}

function processSamples(): { samples: ProcessSample[]; totalMb: number; cpuPercent: number } {
  const metrics = app.getAppMetrics();
  const samples = metrics.map((entry) => ({
    pid: entry.pid,
    type: String(entry.type),
    serviceName: entry.serviceName ?? null,
    name: entry.name ?? '',
    workingSetMb: mb(Number(entry.memory?.workingSetSize ?? 0)),
    privateMb:
      typeof (entry.memory as { privateBytes?: number })?.privateBytes === 'number'
        ? mb(Number((entry.memory as { privateBytes?: number }).privateBytes))
        : null,
    cpuPercent: Math.round(Number(entry.cpu?.percentCPUUsage ?? 0) * 100) / 100,
  }));
  const totalMb = Math.round(samples.reduce((sum, entry) => sum + entry.workingSetMb, 0) * 10) / 10;
  const cpuPercent = Math.round(samples.reduce((sum, entry) => sum + entry.cpuPercent, 0) * 100) / 100;
  return { samples, totalMb, cpuPercent };
}

function mainHeapMb(): { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number } {
  const usage = process.memoryUsage();
  const round = (bytes: number): number => Math.round((bytes / (1024 * 1024)) * 10) / 10;
  return {
    rssMb: round(usage.rss),
    heapUsedMb: round(usage.heapUsed),
    heapTotalMb: round(usage.heapTotal),
    externalMb: round(usage.external),
  };
}

export async function runMemoryProbe(input: MemoryProbeInput): Promise<{ ok: boolean; steps: Step[] }> {
  const steps: Step[] = [];
  const idleSeconds = input.idleSeconds ?? 60;
  const sampleInterval = input.sampleIntervalSeconds ?? 5;
  const step = (name: string, ok: boolean, detail?: unknown): void => {
    steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  };
  const report: Record<string, unknown> = {
    schema: 1,
    capturedAt: new Date().toISOString(),
    metric: {
      budget: 'sum of workingSetSize across app.getAppMetrics(), the same metric P22 recorded',
      unit: 'MiB (1 MiB = 1024 KiB)',
      inclusion: 'every process Electron reports for this app: browser, renderer, GPU, utility',
      caveat:
        'working-set sums count shared pages once per process, so the aggregate overstates unique physical memory; privateBytes is reported alongside as supplemental, and the budget is judged on the original metric only',
      idleIntervalSeconds: idleSeconds,
      workload: 'one project open on Studio, no engine running, no interaction, no provider request',
      heap: 'renderer JavaScript heap from CDP Runtime.getHeapUsage after HeapProfiler.collectGarbage; DOM counters from Memory.getDOMCounters',
    },
  };

  const window = input.window;
  if (!window) {
    step('the shell window exists', false);
    fs.writeFileSync(input.outputPath, `${JSON.stringify({ ok: false, steps, ...report }, null, 2)}\n`, 'utf8');
    return { ok: false, steps };
  }

  // What the GPU path actually is on this machine. A software fallback inflates
  // the GPU process and must be visible in the report rather than guessed at.
  try {
    report.gpu = {
      featureStatus: app.getGPUFeatureStatus(),
      info: await app.getGPUInfo('basic'),
      hardwareAccelerationDisabled: false,
    };
  } catch (error) {
    report.gpu = { error: String(error).slice(0, 200) };
  }

  const evaluate = async <T>(expression: string): Promise<T> =>
    (await window.webContents.executeJavaScript(expression, true)) as T;

  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate().catch(() => false)) return true;
      await delay(150);
    }
    return false;
  };

  await waitFor(async () => (await evaluate<boolean>("document.readyState === 'complete'")) === true, 45_000);
  const project = await input.openProject(input.workspace);
  step('a real project opens through the catalog', project !== null, project?.canonicalPath ?? null);
  if (!project) {
    fs.writeFileSync(input.outputPath, `${JSON.stringify({ ok: false, steps, ...report }, null, 2)}\n`, 'utf8');
    return { ok: false, steps };
  }
  input.showView(project.projectId, 'studio');
  await waitFor(async () => (await evaluate<boolean>("Boolean(document.querySelector('.timeline'))")) === true);

  // Optional: reproduce P22's workload exactly. Two modes of history for the
  // live session, then a reload so the studio replays the stored rows.
  const historyRows = input.historyRows ?? 0;
  if (historyRows > 0 && input.database && input.sessionId) {
    const session = input.sessionId(project.projectId);
    const database = input.database();
    if (session && database) {
      const stamp = new Date().toISOString();
      const plant = (mode: string): void => {
        const id = `thr_mem_${mode}_${Date.now().toString(36)}`;
        database
          .prepare(
            'INSERT INTO threads (id, project_id, engine_thread_id, workspace, last_seq, created_at, updated_at, session_id, mode, profile_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
          )
          .run(id, project.projectId, `mem-${id}`, project.canonicalPath, historyRows, stamp, stamp, session, mode);
        const insert = database.prepare(
          'INSERT INTO timeline_items (id, project_id, thread_id, turn_id, seq, kind, title, body, status, truncated, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, 0, ?, ?)',
        );
        database.exec?.('BEGIN');
        for (let index = 1; index <= historyRows; index += 1) {
          insert.run(
            `mem_${id}_${index}`,
            project.projectId,
            id,
            index,
            index % 7 === 0 ? 'tool' : index % 3 === 0 ? 'status' : 'assistant',
            `Measurement event ${index}`,
            `Fixture body ${index}: the timeline must render a bounded window of the newest items without sending anything.`,
            stamp,
            stamp,
          );
        }
        database.exec?.('COMMIT');
      };
      plant('agent');
      plant('plan');
      report.historyRows = historyRows * 2;
      input.reload?.();
      await waitFor(async () => (await evaluate<boolean>("Boolean(document.querySelector('.timeline'))")) === true);
      // The shell replays stored rows after its own boot; give it a real window.
      await waitFor(
        async () => (await evaluate<number>("document.querySelectorAll('.timeline-item').length")) > 0,
        20_000,
      );
      await delay(1_000);
      const rendered = await evaluate<number>("document.querySelectorAll('.timeline-item').length");
      report.renderedItems = rendered;
      step('the P22 history workload is in place and rendered', rendered > 0, { historyRows, rendered });
    }
  }

  // A. Idle sample window. The first reading is discarded as warm-up; the rest
  //    are averaged, exactly like the idle CPU window in P22.
  const idleSamples: Array<{ atMs: number; totalMb: number; cpuPercent: number; processes: ProcessSample[] }> = [];
  const heapSamples: HeapSample[] = [];
  const totalMs = idleSeconds * 1000;
  const startedAt = (input.now ?? Date.now)();
  await delay(sampleInterval * 1000);
  while ((input.now ?? Date.now)() - startedAt < totalMs) {
    const snapshot = processSamples();
    idleSamples.push({
      atMs: (input.now ?? Date.now)() - startedAt,
      totalMb: snapshot.totalMb,
      cpuPercent: snapshot.cpuPercent,
      processes: snapshot.samples,
    });
    await delay(sampleInterval * 1000);
  }
  const finalIdle = processSamples();
  const idleHeap = await rendererHeap(window);
  heapSamples.push(idleHeap);
  const averageMb =
    idleSamples.length > 0
      ? Math.round((idleSamples.reduce((sum, entry) => sum + entry.totalMb, 0) / idleSamples.length) * 10) / 10
      : finalIdle.totalMb;
  const averageCpu =
    idleSamples.length > 0
      ? Math.round((idleSamples.reduce((sum, entry) => sum + entry.cpuPercent, 0) / idleSamples.length) * 100) / 100
      : finalIdle.cpuPercent;

  report.idle = {
    seconds: idleSeconds,
    samples: idleSamples.length,
    totalWorkingSetMb: finalIdle.totalMb,
    averageWorkingSetMb: averageMb,
    cpuAverage: averageCpu,
    cpuMax: idleSamples.length > 0 ? Math.max(...idleSamples.map((entry) => entry.cpuPercent)) : finalIdle.cpuPercent,
    processes: finalIdle.samples,
    mainProcess: mainHeapMb(),
    renderer: idleHeap,
  };
  step('the idle window produced samples with a per-process breakdown', idleSamples.length >= 3, {
    samples: idleSamples.length,
    totalMb: finalIdle.totalMb,
  });
  step('the renderer JavaScript heap was read after a forced collection', idleHeap.heapUsedMb !== null, idleHeap);
  step(
    'every Mona process is attributed to a named process type',
    finalIdle.samples.every((entry) => typeof entry.type === 'string' && entry.type.length > 0),
    finalIdle.samples.map((entry) => `${entry.type}:${entry.workingSetMb}MB`),
  );

  // B. Changes workload: a large diff in the panel, then navigate away.
  const changes = await input.prepareChanges(project.projectId);
  step('a large diff is available through the real change service', changes?.available === true, changes);
  const openedChanges = await (async () => {
    input.showView(project.projectId, 'changes');
    // Persistence alone does not navigate a live window; click the rail entry.
    await evaluate(`document.querySelector('[data-testid="nav-changes"]')?.click()`);
    const panelShown = await waitFor(
      async () => await evaluate<boolean>("Boolean(document.querySelector('#changes-title'))"),
    );
    if (!panelShown) return false;
    await evaluate(`document.querySelector('[data-testid="changes-refresh"]')?.click()`);
    await waitFor(async () => (await evaluate<number>("document.querySelectorAll('.change-row').length")) >= 1);
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.change-row')].find((node) => (node.textContent || '').includes(${JSON.stringify(changes?.path ?? '')}));
      if (row) row.click();
      return Boolean(row);
    })()`);
    const shown = await waitFor(
      async () => (await evaluate<number>("document.querySelectorAll('.diff-line').length")) > 0,
    );
    await delay(1_500);
    return shown;
  })();
  const changesSample = processSamples();
  const changesHeap = await rendererHeap(window);
  heapSamples.push(changesHeap);
  step('the diff rendered and was measured with the panel open', openedChanges, {
    totalMb: changesSample.totalMb,
    rendererHeapMb: changesHeap.heapUsedMb,
    domNodes: changesHeap.nodes,
    jsEventListeners: changesHeap.jsEventListeners,
  });

  input.showView(project.projectId, 'studio');
  await evaluate(`document.querySelector('[data-testid="nav-studio"]')?.click()`);
  await waitFor(async () => (await evaluate<boolean>("Boolean(document.querySelector('.timeline'))")) === true);
  await delay(2_000);
  const afterSample = processSamples();
  const afterHeap = await rendererHeap(window);
  heapSamples.push(afterHeap);
  report.afterLeavingChanges = {
    totalWorkingSetMb: afterSample.totalMb,
    processes: afterSample.samples,
    renderer: afterHeap,
  };
  const diffRowsLeft = await evaluate<number>("document.querySelectorAll('.diff-line').length");
  step('leaving the diff removes its rows from the DOM', diffRowsLeft === 0, { diffRowsLeft });

  // C. Render-window experiment. This does not change the product: it removes
  //    the render window, by expanding it to every loaded item and measuring the
  //    cost of doing so. It answers "what does rendering the whole history cost?"
  //    with a number instead of a guess.
  await (async () => {
    input.showView(project.projectId, 'studio');
    await evaluate(`document.querySelector('[data-testid="nav-studio"]')?.click()`);
    await waitFor(
      async () => (await evaluate<number>("document.querySelectorAll('.timeline-item').length")) > 0,
      20_000,
    );
    await delay(1_000);
    const before = processSamples();
    const beforeHeap = await rendererHeap(window);
    const windowedRows = await evaluate<number>("document.querySelectorAll('.timeline-item').length");
    // Expand through the product's own control until every loaded item renders.
    let clicks = 0;
    while (clicks < 10) {
      const present = await evaluate<boolean>(
        'Boolean(document.querySelector(\'[data-testid="timeline-earlier"] button\'))',
      );
      if (!present) break;
      await evaluate(`document.querySelector('[data-testid="timeline-earlier"] button')?.click()`);
      clicks += 1;
      await delay(300);
    }
    await rendererHeap(window);
    await delay(2_000);
    const after = processSamples();
    const afterHeap = await rendererHeap(window);
    const fullRows = await evaluate<number>("document.querySelectorAll('.timeline-item').length");
    report.renderWindowExperiment = {
      windowedRows,
      fullRows,
      expansionClicks: clicks,
      windowed: { totalWorkingSetMb: before.totalMb, renderer: beforeHeap, processes: before.samples },
      full: { totalWorkingSetMb: after.totalMb, renderer: afterHeap, processes: after.samples },
      costOfFullRenderMb: Math.round((after.totalMb - before.totalMb) * 10) / 10,
    };
    step(
      'the render-window experiment produced a measurable delta',
      clicks > 0 && fullRows > windowedRows,
      report.renderWindowExperiment,
    );
  })();

  report.changes = {
    totalWorkingSetMb: changesSample.totalMb,
    processes: changesSample.samples,
    renderer: changesHeap,
    path: changes?.path ?? null,
  };
  report.history = idleSamples.map((entry) => ({
    atMs: entry.atMs,
    totalMb: entry.totalMb,
    cpuPercent: entry.cpuPercent,
  }));

  const ok = steps.every((entry) => entry.ok);
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
  fs.writeFileSync(input.outputPath, `${JSON.stringify({ ok, steps, ...report }, null, 2)}\n`, 'utf8');
  return { ok, steps };
}
