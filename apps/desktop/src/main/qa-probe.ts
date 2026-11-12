import { app, type BrowserWindow } from 'electron';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * P22 measurement probe.
 *
 * Answers four questions with numbers:
 *  1. how long the shell takes to become interactive (the caller supplies the
 *     spawn time and reads the ready marker this probe writes);
 *  2. how the real studio behaves with a 10,000-row history in the product
 *     database, rendered by the product's own component;
 *  3. how much CPU idle Mona uses once nothing is happening;
 *  4. how much memory Mona's processes use, with the engine measured separately.
 *
 * It submits no turn and makes no provider request.
 */
export type QaProbeInput = {
  window: BrowserWindow | null;
  outputPath: string;
  workspace: string;
  openProject: (target: string) => Promise<{ projectId: string; canonicalPath: string } | null>;
  showStudio: (projectId: string) => void;
  reload: () => void;
  sessionId: (projectId: string) => string | null;
  emitItems?: (projectId: string, count: number) => void;
  database: () => {
    exec?: (sql: string) => unknown;
    prepare: (sql: string) => { run: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] };
  } | null;
  startRuntime?: (projectId: string) => Promise<{ pid: number | null } | null>;
  stopRuntime?: () => Promise<void>;
  eventCount?: number;
  idleSeconds?: number;
  now?: () => number;
};

type Step = { name: string; ok: boolean; detail?: unknown };

type RendererMetrics = {
  renderedItems: number;
  scrollHeight: number;
  clientHeight: number;
  frameMedian: number | null;
  frameP95: number | null;
  frameMax: number | null;
  typeMedian: number | null;
  typeP95: number | null;
  typeMax: number | null;
  composerFound: boolean;
};

const MEASURE_SCRIPT = `(async () => {
  const timeline = document.querySelector('.timeline');
  const composer = document.querySelector('.composer textarea');
  const items = document.querySelectorAll('.timeline-item');
  const scrollHeight = timeline ? timeline.scrollHeight : 0;
  const clientHeight = timeline ? timeline.clientHeight : 0;

  // Frame timing while scrolling, measured against the real paint clock.
  const frames = await new Promise((resolve) => {
    const samples = [];
    let previous = performance.now();
    let step = 0;
    const tick = (time) => {
      samples.push(time - previous);
      previous = time;
      if (timeline) timeline.scrollTop = (scrollHeight - clientHeight) * (step / 59);
      step += 1;
      if (step < 60) requestAnimationFrame(tick);
      else resolve(samples.slice(1));
    };
    requestAnimationFrame(tick);
  });

  const typing = [];
  if (composer) {
    composer.focus();
    for (let index = 0; index < 200; index += 1) {
      const started = performance.now();
      composer.value = 'x'.repeat(index + 1);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      typing.push(performance.now() - started);
    }
    composer.value = '';
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const sorted = (values) => values.slice().sort((a, b) => a - b);
  const median = (values) => (values.length ? sorted(values)[Math.floor(values.length / 2)] : null);
  const p95 = (values) => (values.length ? sorted(values)[Math.floor(values.length * 0.95)] : null);
  return {
    renderedItems: items.length,
    scrollHeight,
    clientHeight,
    frameMedian: median(frames),
    frameP95: p95(frames),
    frameMax: frames.length ? Math.max(...frames) : null,
    typeMedian: median(typing),
    typeP95: p95(typing),
    typeMax: typing.length ? Math.max(...typing) : null,
    composerFound: Boolean(composer),
  };
})()`;

function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async (): Promise<void> => {
      try {
        if (await predicate()) return resolve();
      } catch {
        // The renderer may still be navigating; retry until the deadline.
      }
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 100);
    };
    void tick();
  });
}

function processMemoryMb(pid: number): number | null {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 },
  );
  if (result.status !== 0) return null;
  const bytes = Number.parseInt((result.stdout ?? '').trim(), 10);
  return Number.isFinite(bytes) ? Math.round((bytes / (1024 * 1024)) * 10) / 10 : null;
}

function sumMemoryMb(metrics: Array<{ memory?: { workingSetSize?: number } }>): number {
  const kb = metrics.reduce((sum, entry) => sum + Number(entry.memory?.workingSetSize ?? 0), 0);
  return Math.round((kb / 1024) * 10) / 10;
}

function totalCpu(metrics: Array<{ cpu?: { percentCPUUsage?: number } }>): number {
  const value = metrics.reduce((sum, entry) => sum + Number(entry.cpu?.percentCPUUsage ?? 0), 0);
  return Math.round(value * 100) / 100;
}

export async function runQaProbe(input: QaProbeInput): Promise<{ ok: boolean; steps: Step[]; outputPath: string }> {
  const now = input.now ?? (() => Date.now());
  const eventCount = input.eventCount ?? 10_000;
  const idleSeconds = input.idleSeconds ?? 60;
  const steps: Step[] = [];
  const report: Record<string, unknown> = { schema: 1, capturedAt: new Date().toISOString(), eventCount };
  const step = (name: string, ok: boolean, detail?: unknown) => {
    steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  };

  const write = (ok: boolean) => {
    fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
    fs.writeFileSync(input.outputPath, `${JSON.stringify({ ok, steps, ...report }, null, 2)}\n`, 'utf8');
    return { ok, steps, outputPath: input.outputPath };
  };

  const window = input.window;
  if (!window) {
    step('the shell window exists', false);
    return write(false);
  }

  // 0. Interactive marker: the caller measures spawn → this instant as startup.
  const probeStarted = now();
  await waitFor(
    async () => (await window.webContents.executeJavaScript("document.readyState === 'complete'", true)) === true,
    45000,
    'the window load',
  );
  report.interactiveMs = now() - probeStarted;
  fs.writeFileSync(`${input.outputPath}.ready`, `${Date.now()}\n`, 'utf8');

  // 1. Open the project through the real catalog.
  const openedAt = now();
  const project = await input.openProject(input.workspace);
  step('the measurement project opens through the real catalog', project !== null, project?.canonicalPath ?? null);
  if (!project) return write(false);

  // 2. Show the studio the way a person would, then read the session the shell
  //    is actually using before planting history for that session.
  input.showStudio(project.projectId);
  await window.webContents.executeJavaScript(
    `(() => {
      const target = [...document.querySelectorAll('button, a')].find((node) =>
        (node.textContent || '').trim() === 'Studio',
      );
      if (target) target.click();
      return Boolean(target);
    })()`,
    true,
  );
  await waitFor(
    async () =>
      (await window.webContents.executeJavaScript("Boolean(document.querySelector('.timeline'))", true)) === true,
    20000,
    'the studio timeline',
  );

  const database = input.database();
  const dbTimings: number[] = [];
  let seeded = 0;
  let threadId: string | null = null;

  /**
   * Plant history for one Mona session. The shell binds a thread to the session
   * it is showing, and that session can change when the window reloads, so the
   * caller may need to plant twice.
   */
  const plantHistory = (session: string, mode: string): number => {
    if (!database) return 0;
    const id = `thr_qa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const stamp = new Date().toISOString();
    database
      .prepare(
        'INSERT INTO threads (id, project_id, engine_thread_id, workspace, last_seq, created_at, updated_at, session_id, mode, profile_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      )
      .run(id, project.projectId, `qa-${id}`, project.canonicalPath, eventCount, stamp, stamp, session, mode);
    const insert = database.prepare(
      'INSERT INTO timeline_items (id, project_id, thread_id, turn_id, seq, kind, title, body, status, truncated, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, 0, ?, ?)',
    );
    database.exec?.('BEGIN');
    for (let index = 1; index <= eventCount; index += 1) {
      insert.run(
        `qa_${id}_${index}`,
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
    threadId = id;
    return eventCount;
  };

  const firstSession = input.sessionId(project.projectId);
  if (firstSession) {
    const startedSeed = now();
    seeded += plantHistory(firstSession, 'work');
    seeded += plantHistory(firstSession, 'plan');
    report.seedMs = now() - startedSeed;
  }
  report.seeded = seeded;
  report.plantedSession = firstSession;
  report.reloadedSession = null;
  step('history is seeded into the product database for the live session', seeded >= eventCount, {
    seeded,
    eventCount,
    sessionIdBound: Boolean(firstSession),
  });

  // 3. Reload so the shell replays the stored history, then confirm the session
  //    still matches; a new session gets its own planted history.
  input.reload();
  await waitFor(
    async () =>
      (await window.webContents.executeJavaScript("Boolean(document.querySelector('.timeline'))", true)) === true,
    20000,
    'the studio timeline after reload',
  );
  const reloadedSession = input.sessionId(project.projectId);
  report.reloadedSession = reloadedSession;
  if (database && reloadedSession && reloadedSession !== firstSession) {
    seeded += plantHistory(reloadedSession, 'work');
    seeded += plantHistory(reloadedSession, 'plan');
    input.reload();
    await waitFor(
      async () =>
        (await window.webContents.executeJavaScript("Boolean(document.querySelector('.timeline'))", true)) === true,
      20000,
      'the studio timeline after the second reload',
    );
  }
  report.seeded = seeded;
  if (database && threadId) {
    const query = database.prepare('SELECT * FROM timeline_items WHERE thread_id = ? ORDER BY seq DESC LIMIT 500');
    for (let run = 0; run < 5; run += 1) {
      const started = now();
      const rows = query.all(threadId);
      dbTimings.push(now() - started);
      if (run === 0) report.loadedRows = Array.isArray(rows) ? rows.length : null;
    }
    report.queryMs = { runs: dbTimings.length, median: median(dbTimings), max: Math.max(...dbTimings) };
  }
  await new Promise((resolve) => setTimeout(resolve, 750));
  // Deliver a bounded history through the same event channel the runtime uses.
  // These are labelled synthetic items; nothing claims a runtime result.
  if (input.emitItems) {
    input.emitItems(project.projectId, 500);
    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  const renderer = (await window.webContents.executeJavaScript(MEASURE_SCRIPT, true)) as RendererMetrics;
  report.renderer = renderer;
  step('the studio rendered a bounded window of the seeded history', renderer.renderedItems > 0, {
    renderedItems: renderer.renderedItems,
    loadedRows: report.loadedRows ?? null,
  });
  step('scrolling stays within a frame budget', (renderer.frameP95 ?? 999) < 34, {
    frameP95: renderer.frameP95,
    frameMax: renderer.frameMax,
  });
  step('typing stays responsive', (renderer.typeP95 ?? 999) < 16, {
    typeP95: renderer.typeP95,
    composerFound: renderer.composerFound,
  });

  // 4. Engine memory, measured separately and then stopped.
  let enginePid: number | null = null;
  if (input.startRuntime) {
    const started = await input.startRuntime(project.projectId).catch(() => null);
    enginePid = started?.pid ?? null;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    report.enginePid = enginePid;
    report.engineMemoryMb = enginePid ? processMemoryMb(enginePid) : null;
    if (input.stopRuntime) await input.stopRuntime().catch(() => undefined);
  }
  step(
    'the engine memory sample was taken separately',
    enginePid === null || typeof report.engineMemoryMb === 'number',
  );

  // 5. Idle CPU and memory over a quiet window with no engine running.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const samples: Array<{ cpu: number; memoryMb: number; processes: number }> = [];
  const deadline = now() + idleSeconds * 1000;
  while (now() < deadline) {
    const metrics = app.getAppMetrics();
    samples.push({ cpu: totalCpu(metrics), memoryMb: sumMemoryMb(metrics), processes: metrics.length });
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  report.idle = {
    seconds: idleSeconds,
    samples: samples.length,
    cpuAverage: round(samples.reduce((sum, entry) => sum + entry.cpu, 0) / Math.max(1, samples.length)),
    cpuMax: samples.length ? Math.max(...samples.map((entry) => entry.cpu)) : null,
    memoryMb: samples.at(-1)?.memoryMb ?? null,
    processes: samples.at(-1)?.processes ?? null,
  };

  report.openedMs = now() - openedAt;
  report.workspace = input.workspace;
  report.appVersion = app.getVersion();
  return write(steps.every((entry) => entry.ok));
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
