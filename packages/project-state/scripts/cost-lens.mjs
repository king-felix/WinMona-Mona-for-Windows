import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openState, CostLedger, TaskService } from '../dist/index.js';

/**
 * Deterministic P12 cost-ledger sample. Real SQLite, real ledger arithmetic, a
 * fake provider route. No engine and no provider request is involved.
 */

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outFile = outIndex >= 0 ? args[outIndex + 1] : null;

const root = await mkdtemp(path.join(tmpdir(), 'mona-p12-sample-'));
const workspace = path.join(root, 'sample-project');
await mkdir(workspace, { recursive: true });
const state = await openState({ directory: path.join(root, 'state') });
const steps = [];

function record(name, detail) {
  steps.push({ name, detail });
}

try {
  const registered = await state.store.registerProject(workspace, { label: 'P12 sample' });
  if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
  const projectId = registered.project.id;
  const ledger = new CostLedger(state.store, { now: () => new Date('2026-11-12T12:00:00.000Z') });
  const tasks = new TaskService(state.store);
  const task = await tasks.createTask({ projectId, title: 'Cost sample task', owner: 'mona_queue' });
  await state.store.putStudioThread({
    id: 'thr_p12_sample',
    projectId,
    engineThreadId: 'thr_p12_sample',
    workspace,
    sessionId: 'ses_p12',
    mode: 'agent',
    profileJson: '{}',
  });

  const rate1 = await ledger.putRate({
    provider: 'deepseek',
    model: 'deepseek-flash',
    cacheHitMicros: 28_000,
    cacheMissMicros: 280_000,
    outputMicros: 420_000,
    source: 'P12 sample rate revision',
    revision: 'sample-2026-11-01',
    effectiveFrom: '2026-11-01T00:00:00.000Z',
  });
  record('rate card', rate1);

  const reported = await ledger.ingest({
    projectId,
    threadId: 'thr_p12_sample',
    turnId: 'turn_reported',
    taskId: task.id,
    provider: 'deepseek',
    model: 'deepseek-flash',
    buckets: { cacheHitTokens: 1_000, cacheMissTokens: 2_000, outputTokens: 500 },
    cost: { kind: 'provider_reported', micros: 1_234, source: 'sample engine delta' },
    source: 'engine_priced:thread_delta:sample-2026-11-01',
  });
  const estimated = await ledger.ingest({
    projectId,
    threadId: 'thr_p12_sample',
    turnId: 'turn_estimated',
    taskId: task.id,
    provider: 'deepseek',
    model: 'deepseek-flash',
    buckets: { cacheHitTokens: 1_000, cacheMissTokens: 2_000, outputTokens: 500 },
    cost: { kind: 'local_estimate' },
    source: 'local_estimate',
  });
  const duplicate = await ledger.ingest({
    projectId,
    threadId: 'thr_p12_sample',
    turnId: 'turn_estimated',
    taskId: task.id,
    provider: 'deepseek',
    model: 'deepseek-flash',
    buckets: { cacheHitTokens: 1_000, cacheMissTokens: 2_000, outputTokens: 500 },
    cost: { kind: 'local_estimate' },
    source: 'local_estimate',
  });
  const unknown = await ledger.ingest({
    projectId,
    threadId: 'thr_p12_sample',
    turnId: 'turn_unknown',
    provider: 'deepseek',
    model: 'deepseek-flash',
    buckets: { cacheHitTokens: 10, cacheMissTokens: 10, outputTokens: 10 },
    cost: { kind: 'unknown', reason: 'provider did not report complete usage' },
    source: 'engine_missing_usage',
  });
  record('ingest', {
    providerReportedMicros: reported.record.costMicros,
    estimatedMicros: estimated.record.costMicros,
    estimatedRevision: estimated.record.rateRevision,
    duplicateRefused: duplicate.duplicate,
    unknownIsNull: unknown.record.costMicros === null,
  });

  const budget = await ledger.setBudget({
    projectId,
    scope: 'project',
    limitMicros: 50_000,
    warnMicros: 4_000,
    stopMicros: 5_000,
  });
  record('budget', budget);
  record('evaluation', await ledger.evaluateBudget({ projectId }));
  const lens = await ledger.lens(projectId);
  record('lens totals', lens.totals);
  record('by session', lens.bySession);
  record('rate freshness', lens.rateFreshness);

  const csv = await ledger.exportCsv(projectId);
  const csvPath = outFile ? path.join(path.dirname(outFile), 'P12-cost-export.csv') : path.join(root, 'cost.csv');
  await writeFile(csvPath, csv, 'utf8');

  const report = {
    prompt: 'P12',
    generatedUtc: new Date().toISOString(),
    providerRequests: 0,
    csvPath,
    steps,
  };
  if (outFile) await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally {
  state.store.close();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
