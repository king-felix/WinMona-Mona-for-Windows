// P03 live smoke: run the built adapter against the pinned engine. This spends
// a few thousand tokens on Victor's existing deepseek route. No setting changes.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newOperationKey, newSubmissionId } from '@mona/contracts';
import { FileSubmissionJournal, startOwnedRuntime } from '../dist/index.js';

const ENGINE = process.env.MONA_ENGINE ?? 'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Links\\codewhale.exe';
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.MONA_P03_OUT ?? path.resolve(here, '..', '..', '..', 'docs', 'evidence', 'P03-live.json');
const PORT = Number(process.env.MONA_P03_PORT ?? 7903);
const report = {
  schema_version: 1,
  captured_utc: new Date().toISOString(),
  engine_path: ENGINE,
  steps: [],
  spend: [],
  reconnects: [],
  events: { total: 0, kinds: {} },
};

function step(name, ok, detail) {
  report.steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
}

function observe(frame) {
  report.events.total += 1;
  const kind = frame.kind === 'event' ? `event:${frame.event.name}` : frame.kind;
  report.events.kinds[kind] = (report.events.kinds[kind] ?? 0) + 1;
  if (frame.kind === 'diagnostic') {
    report.events.diagnostics ??= [];
    report.events.diagnostics.push(frame.failure);
  }
}

async function collect(adapter, threadId, predicate, timeoutMs) {
  const controller = new AbortController();
  const frames = [];
  const task = (async () => {
    for await (const frame of adapter.subscribe({
      threadId,
      sinceSeq: 0,
      signal: controller.signal,
      maxAttempts: 2,
      baseDelayMs: 200,
      maxDelayMs: 1000,
    })) {
      frames.push(frame);
      observe(frame);
      if (predicate(frame)) return 'matched';
    }
    return 'ended';
  })();
  const result = await Promise.race([task, new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs))]);
  controller.abort();
  await task.catch(() => {});
  return { result, frames };
}

const workspace = path.join(tmpdir(), 'mona-p03-live', String(Date.now()));
const journalDir = path.join(tmpdir(), 'mona-p03-journal', String(Date.now()));
await mkdir(workspace, { recursive: true });
await mkdir(journalDir, { recursive: true });

const runtime = await startOwnedRuntime({
  executable: ENGINE,
  workspace,
  port: PORT,
  token: `mona-p03-${crypto.randomUUID().replaceAll('-', '')}`,
});
if (!runtime.ok) {
  step('owned runtime started', false, runtime.error);
  await writeFile(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
  process.exit(1);
}
report.runtime = {
  runtimeId: runtime.value.runtimeId,
  pid: runtime.value.pid,
  baseUrl: runtime.value.baseUrl,
  identity: runtime.value.identity,
  compatibility: runtime.value.report,
};
step('owned runtime started with pinned identity', runtime.value.report.status === 'qualified', {
  version: runtime.value.identity.version,
  commit: runtime.value.identity.commit.slice(0, 12),
});

const adapter = runtime.value.createAdapter(new FileSubmissionJournal(journalDir));
try {
  const discovery = await adapter.discover();
  step(
    'discover() returned a capability report',
    discovery.ok,
    discovery.ok ? discovery.value.report : discovery.error,
  );
  const thread = await adapter.createOrOpenThread({ expectedWorkspace: workspace });
  step(
    'createOrOpenThread() verified Full Access route',
    thread.ok &&
      thread.value.profile.permissionPosture === 'full_access' &&
      thread.value.profile.provider === 'deepseek' &&
      thread.value.profile.model === 'deepseek-flash',
    thread.ok ? thread.value.profile : thread.error,
  );
  if (!thread.ok) throw new Error('thread creation failed');
  const threadId = thread.value.threadId;

  const turnIdRef = { value: null };
  const collection = collect(
    adapter,
    threadId,
    (frame) =>
      frame.kind === 'event' &&
      frame.event.kind === 'known' &&
      frame.event.name === 'turn.completed' &&
      frame.event.envelope.turnId === turnIdRef.value,
    120000,
  );
  const submissionId = newSubmissionId();
  const operationKey = newOperationKey('p03-live');
  const submitted = await adapter.submitTurn({
    threadId,
    prompt: 'Reply with exactly MONA_P03_ADAPTER and nothing else.',
    submissionId,
    operationKey,
  });
  step(
    'submitTurn() accepted with a persisted intent',
    submitted.ok && submitted.value.state === 'accepted',
    submitted.ok ? submitted.value : submitted.error,
  );
  if (!submitted.ok) throw new Error('submit failed');
  turnIdRef.value = submitted.value.turnId;
  const collected = await collection;
  step('turn completed on the event stream', collected.result === 'matched', {
    result: collected.result,
    frames: collected.frames.length,
    last: collected.frames.at(-1)?.kind ?? null,
  });

  const usage = await adapter.readUsage({ threadId });
  step(
    'readUsage() returned priced buckets',
    usage.ok && usage.value.cost.status === 'known',
    usage.ok ? usage.value : usage.error,
  );
  report.spend.push(usage.ok ? usage.value : null);
  const history = await adapter.readHistory({ threadId, limit: 20 });
  step(
    'readHistory() projected engine-owned history',
    history.ok && history.value.messageCount >= 2,
    history.ok ? { messageCount: history.value.messageCount } : history.error,
  );

  const replay = await adapter.submitTurn({
    threadId,
    prompt: 'Reply with exactly MONA_P03_ADAPTER and nothing else.',
    submissionId,
    operationKey,
  });
  step(
    'same operation key reconciles instead of creating a second turn',
    replay.ok && replay.value.replayed === true && replay.value.turnId === submitted.value.turnId,
    replay.ok ? replay.value : replay.error,
  );

  const replayStream = await collect(adapter, threadId, () => false, 1500);
  const seqs = replayStream.frames.filter((frame) => frame.kind === 'event').map((frame) => frame.seq);
  const monotonic = seqs.every((value, index) => index === 0 || value > seqs[index - 1]);
  step('replayed journal is strictly increasing (no duplicate projection)', monotonic && seqs.length > 0, {
    seqs: seqs.slice(0, 12),
    count: seqs.length,
  });

  // --- interrupt -----------------------------------------------------------
  const interruptThread = await adapter.createOrOpenThread({ expectedWorkspace: workspace });
  if (!interruptThread.ok) throw new Error('interrupt thread creation failed');
  const intThreadId = interruptThread.value.threadId;
  const intCollection = collect(
    adapter,
    intThreadId,
    (frame) => {
      if (frame.kind !== 'event') return false;
      const item = frame.event.envelope.payload?.item;
      return Boolean(item?.metadata?.tool_name || item?.kind === 'tool_call');
    },
    90000,
  );
  const intSubmissionId = newSubmissionId();
  const intSubmitted = await adapter.submitTurn({
    threadId: intThreadId,
    prompt:
      'Run this shell command exactly: Start-Sleep -Seconds 300; Write-Output MONA_P03_SENTINEL. Then report that it finished.',
    submissionId: intSubmissionId,
    operationKey: newOperationKey('p03-int'),
  });
  const intCollected = await intCollection;
  step('interrupt candidate reached the tool stage', intSubmitted.ok && intCollected.result === 'matched', {
    submitted: intSubmitted.ok ? intSubmitted.value : intSubmitted.error,
    stream: intCollected.result,
    frames: intCollected.frames.length,
  });
  const intTurnId = intSubmitted.ok ? intSubmitted.value.turnId : null;
  if (intTurnId) {
    const interruptReceipt = await adapter.interrupt({ threadId: intThreadId, turnId: intTurnId });
    step(
      'interrupt() acknowledged the exact turn',
      interruptReceipt.ok,
      interruptReceipt.ok ? interruptReceipt.value : interruptReceipt.error,
    );
    const deadline = Date.now() + 60000;
    let final = null;
    while (Date.now() < deadline) {
      const reconciled = await adapter.reconcileSubmission({ submissionId: intSubmissionId });
      if (reconciled.ok && ['interrupted', 'canceled', 'completed', 'failed'].includes(reconciled.value.state)) {
        final = reconciled.value;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    step(
      'interrupted turn converged to a terminal state',
      final?.state === 'interrupted' || final?.state === 'canceled',
      final ?? { state: 'timeout' },
    );
    report.interrupt = { frames: intCollected.frames.length, final };
  }

  report.total_reported_cost_usd = report.spend.reduce(
    (sum, row) => sum + (row?.cost?.status === 'known' ? row.cost.usd : 0),
    0,
  );
  step('live smoke stayed inside the P03 pilot budget', report.total_reported_cost_usd < 1, {
    usd: report.total_reported_cost_usd,
  });
} catch (error) {
  step('live smoke aborted', false, error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  await runtime.value.stop().catch(() => {});
  report.finished_utc = new Date().toISOString();
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`wrote ${OUT}`);
  console.log(`reported spend: $${(report.total_reported_cost_usd ?? 0).toFixed(6)}`);
}
