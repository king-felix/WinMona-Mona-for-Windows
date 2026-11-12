// P01 G0 evidence run: one real tool-enabled task, durable resume, interrupt,
// and coexistence of owned runtimes. This script spends provider tokens inside
// the P01 pilot ceiling ($2). It is a spike, not product code.
//
// Usage: node tools/spike/p01-g0.mjs [--out docs/evidence/P01-g0.json]

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  RuntimeClient,
  makeToken,
  startOwnedRuntime,
} from './runtime/client.mjs';

const execFileAsync = promisify(execFile);
const ENGINE = process.env.MONA_ENGINE ?? 'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Links\\codewhale.exe';
const outIndex = process.argv.indexOf('--out');
const OUT = outIndex === -1 ? null : process.argv[outIndex + 1];
const TURN_TIMEOUT_MS = Number(process.env.MONA_TURN_TIMEOUT_MS ?? 240000);

const report = {
  schema_version: 1,
  captured_utc: new Date().toISOString(),
  engine_path: ENGINE,
  pilot_ceiling_usd: 2,
  methodology: 'live Codewhale 0.10.2 HTTP Runtime API, Victor\'s deepseek/deepseek-flash route, Full Access thread profile',
  steps: [],
  spend: [],
  events: [],
};

function step(name, ok, detail) {
  report.steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 500)}` : ''}`);
}

async function collect(api, threadId, { sinceSeq = 0, until, timeoutMs = TURN_TIMEOUT_MS }) {
  const controller = new AbortController();
  const frames = [];
  const deadline = Date.now() + timeoutMs;
  const task = (async () => {
    for await (const frame of api.subscribe(threadId, { sinceSeq, signal: controller.signal })) {
      const compact = { ...frame, data: frame.data };
      const text = JSON.stringify(compact);
      report.events.push({
        event: frame.event,
        seq: frame.data?.seq ?? null,
        turn_id: frame.data?.turn_id ?? null,
        payload: text.length > 4000 ? `${text.slice(0, 4000)}...[truncated]` : text,
      });
      frames.push(frame);
      if (until(frame)) return true;
      if (Date.now() > deadline) return false;
    }
    return false;
  })();
  return { task, frames, controller };
}

/** Wait for the next terminal frame for a turn. */
async function runTurn(api, threadId, prompt, { operationKey, label }) {
  const startedAt = Date.now();
  let turnId = null;
  const terminalStatuses = new Set(['completed', 'interrupted', 'failed', 'canceled']);
  const collected = await collect(api, threadId, {
    sinceSeq: 0,
    until: (frame) =>
      Boolean(turnId) &&
      frame.data?.turn_id === turnId &&
      (frame.event === 'turn.completed' || terminalStatuses.has(frame.data?.payload?.status)),
  });
  const submitted = await api.submitTurn(threadId, { prompt, operationKey });
  turnId = submitted.receipt?.turn?.id ?? null;
  const matchesTerminal = (frame) =>
    frame.data?.turn_id === turnId &&
    (frame.event === 'turn.completed' || terminalStatuses.has(frame.data?.payload?.status));
  step(`${label}: submit accepted`, submitted.status === 200 || submitted.status === 201, {
    status: submitted.status,
    turnId,
    replayed: submitted.replayed,
  });
  if (!collected.frames.some(matchesTerminal)) {
    await Promise.race([
      collected.task,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), TURN_TIMEOUT_MS)),
    ]);
  }
  collected.controller.abort();
  await collected.task.catch(() => {});
  const terminal = collected.frames.find(matchesTerminal);
  const elapsedMs = Date.now() - startedAt;
  const detail = await api.getThread(threadId);
  const turn = turnId ? detail.turns?.find((t) => t.id === turnId) : detail.turns?.at(-1);
  const usage = await api.threadUsage(threadId);
  report.spend.push({ label, turnId, usage: usage.totals, elapsedMs });
  report.spend_cost_usd_running = report.spend.reduce((sum, row) => sum + (row.usage?.cost_usd ?? 0), 0);
  if (report.spend_cost_usd_running > 1.5) {
    throw new Error(`pilot guard: reported spend $${report.spend_cost_usd_running.toFixed(4)} exceeds the software guard inside the $2 ceiling`);
  }
  return { submitted, terminal, turn, usage, elapsedMs, frames: collected.frames, operationKey };
}

function turnStatus(turn, terminal) {
  return terminal?.data?.payload?.status ?? turn?.status ?? 'unknown';
}

const workspace = join(tmpdir(), 'mona-p01-g0', String(Date.now()));
await mkdir(workspace, { recursive: true });
const token = makeToken();
let runtime = await startOwnedRuntime({ executable: ENGINE, workspace, port: 7894, token });
let api = new RuntimeClient({ baseUrl: runtime.baseUrl, token });

try {
  const { thread } = await api.createThread({ operationKey: `g0-thread-${crypto.randomUUID()}` });
  const threadId = thread.id;
  step('thread created with effective Full Access profile', thread.permission_posture === 'full_access' && thread.model_provider === 'deepseek' && thread.model === 'deepseek-flash', {
    threadId,
    posture: thread.permission_posture,
    provider: thread.model_provider,
    model: thread.model,
  });

  // --- real tool task -----------------------------------------------------
  const taskPrompt = [
    'Create two files in the current workspace.',
    '1. sum.js exporting function sum(a, b) { return a + b; }',
    '2. sum.test.js using node:test that imports sum and asserts sum(2, 2) === 4.',
    'Then run `node --test` in the workspace and report the number of passing tests.',
    'Do not create any other files.',
  ].join('\n');
  const taskOperationKey = `g0-turn-task-${crypto.randomUUID()}`;
  const task = await runTurn(api, threadId, taskPrompt, {
    label: 'tool task',
    operationKey: taskOperationKey,
  });
  const taskStatus = turnStatus(task.turn, task.terminal);
  step('tool task reached completed', taskStatus === 'completed', { status: taskStatus, elapsedMs: task.elapsedMs });

  const sumJs = await readFile(join(workspace, 'sum.js'), 'utf8').catch(() => null);
  const testJs = await readFile(join(workspace, 'sum.test.js'), 'utf8').catch(() => null);
  let independentTest = null;
  try {
    const { stdout } = await execFileAsync(process.execPath, ['--test'], { cwd: workspace, timeout: 60000 });
    independentTest = stdout;
  } catch (error) {
    independentTest = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
  }
  step('tool wrote both files', Boolean(sumJs && testJs), { sum_bytes: sumJs?.length ?? 0, test_bytes: testJs?.length ?? 0 });
  const passMatch = independentTest.match(/pass\s+(\d+)/i);
  const failMatch = independentTest.match(/fail\s+(\d+)/i);
  step('Mona-independent `node --test` passes the written test', Number(passMatch?.[1] ?? 0) >= 1 && Number(failMatch?.[1] ?? 1) === 0, {
    pass: passMatch?.[1] ?? null,
    fail: failMatch?.[1] ?? null,
    output: independentTest.slice(-400),
  });

  const effective = task.turn;
  step('effective route and posture verified on the turn record', effective?.effective_provider === 'deepseek' && effective?.effective_model === 'deepseek-flash' && effective?.permission_posture === 'full_access', {
    provider: effective?.effective_provider,
    model: effective?.effective_model,
    endpoint_fingerprint: effective?.effective_endpoint_fingerprint,
    posture: effective?.permission_posture,
    billing: effective?.effective_billing_surface,
  });

  const toolFrame = task.frames.find((f) => f.event === 'item.started' && f.data?.payload?.tool);
  step('tool execution events are observable', Boolean(toolFrame), { tool: toolFrame?.data?.payload?.tool?.name ?? null, frames: task.frames.length });

  const usage = task.usage.totals;
  step('usage is reported for the turn', usage.turns >= 1 && usage.priced_turns + usage.unpriced_turns >= 1, {
    turns: usage.turns,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cached_tokens: usage.cached_tokens,
    cost_usd: usage.cost_usd,
    cost_complete: usage.cost_complete,
    unpriced_reasons: usage.unpriced_reasons,
  });
  report.spend_cost_usd_running = (report.spend_cost_usd_running ?? 0) + (usage.cost_usd ?? 0);

  // --- idempotent replay --------------------------------------------------
  const turnsBeforeReplay = (await api.getThread(threadId)).turns.length;
  const replay = await api.submitTurn(threadId, { prompt: taskPrompt, operationKey: taskOperationKey });
  const turnsAfterReplay = (await api.getThread(threadId)).turns.length;
  step('replay with the original operation key does not create a second turn', replay.replayed === true && turnsAfterReplay === turnsBeforeReplay, {
    replayStatus: replay.status,
    idempotent_replay: replay.receipt?.idempotent_replay ?? null,
    sameTurnId: replay.receipt?.turn?.id === task.submitted.receipt?.turn?.id,
    turnsBeforeReplay,
    turnsAfterReplay,
  });

  // --- durable resume after runtime restart ------------------------------
  const beforeStopSeq = (await api.getThread(threadId)).latest_seq;
  await runtime.stop();
  await new Promise((resolve) => setTimeout(resolve, 500));
  runtime = await startOwnedRuntime({ executable: ENGINE, workspace, port: 7894, token });
  api = new RuntimeClient({ baseUrl: runtime.baseUrl, token });
  const reopened = await api.getThread(threadId);
  const history = await api.history(threadId);
  step('thread survives runtime restart with the same projected state', reopened.thread?.id === threadId && reopened.latest_seq >= beforeStopSeq, {
    beforeStopSeq,
    afterSeq: reopened.latest_seq,
    messages: history.session?.messages?.length ?? 0,
    model: reopened.thread?.model,
  });

  const followPrompt = 'Append a line `// resumed` to sum.js, then run `node --test` again and report the passing count.';
  const follow = await runTurn(api, threadId, followPrompt, {
    label: 'resume turn',
    operationKey: `g0-turn-resume-${crypto.randomUUID()}`,
  });
  const followStatus = turnStatus(follow.turn, follow.terminal);
  const resumed = await readFile(join(workspace, 'sum.js'), 'utf8').catch(() => '');
  step('resumed turn completes in the same thread', followStatus === 'completed' && resumed.includes('// resumed'), {
    status: followStatus,
    resumed_marker: resumed.includes('// resumed'),
    history_messages: (await api.history(threadId)).session?.messages?.length ?? 0,
  });

  // --- interrupt a long harmless command ---------------------------------
  const { thread: interruptThread } = await api.createThread({ operationKey: `g0-thread-int-${crypto.randomUUID()}` });
  const intCollected = await collect(api, interruptThread.id, {
    sinceSeq: 0,
    until: (frame) => frame.event === 'item.started' && frame.data?.payload?.tool,
  });
  const intSubmit = api.submitTurn(interruptThread.id, {
    prompt: 'Run this shell command exactly: Start-Sleep -Seconds 300; Write-Output MONA_P01_SENTINEL. Then report that it finished.',
    operationKey: `g0-turn-int-${crypto.randomUUID()}`,
  });
  const intTurn = await Promise.race([intCollected.task, new Promise((r) => setTimeout(() => r('timeout'), 90000))]).then(() => intSubmit);
  const interruptTurnId = intTurn.receipt?.turn?.id;
  step('long command reached the tool stage before interrupt', Boolean(intTurn.receipt?.turn?.id), { turnId: interruptTurnId, stage: intCollected.frames.at(-1)?.event });

  let interruptReceipt = null;
  if (interruptTurnId) {
    interruptReceipt = await api.interrupt(interruptThread.id, interruptTurnId).catch((error) => ({ error: error.message }));
  }
  // Wait for terminal state on the interrupted turn.
  const intDeadline = Date.now() + 60000;
  let interruptedDetail = null;
  while (Date.now() < intDeadline) {
    const detail = await api.getThread(interruptThread.id);
    const turn = detail.turns?.find((t) => t.id === interruptTurnId);
    if (turn && turn.status !== 'in_progress') {
      interruptedDetail = { turn, detail };
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  intCollected.controller.abort();
  await intCollected.task.catch(() => {});
  step('interrupt is honoured by the engine', interruptedDetail?.turn?.status === 'interrupted' || interruptedDetail?.turn?.status === 'canceled', {
    status: interruptedDetail?.turn?.status ?? 'not terminal within 60s',
    receipt: interruptReceipt,
  });

  const lingering = await findSentinelProcesses();
  step('interrupted command left no owned child process running', lingering.length === 0, { processes: lingering });
  const intUsage = await api.threadUsage(interruptThread.id);
  report.spend.push({ label: 'interrupt turn', turnId: interruptTurnId, usage: intUsage.totals });
  report.spend_cost_usd_running = (report.spend_cost_usd_running ?? 0) + (intUsage.totals?.cost_usd ?? 0);

  // --- two runtimes: same workspace vs different workspace ----------------
  const otherWorkspace = join(tmpdir(), 'mona-p01-g0b', String(Date.now()));
  await mkdir(otherWorkspace, { recursive: true });
  const tokenB = makeToken();
  const runtimeB = await startOwnedRuntime({ executable: ENGINE, workspace: otherWorkspace, port: 7895, token: tokenB });
  const apiB = new RuntimeClient({ baseUrl: runtimeB.baseUrl, token: tokenB });
  try {
    const { thread: otherThread } = await apiB.createThread({ operationKey: `g0-thread-b-${crypto.randomUUID()}` });
    step('second owned runtime serves a different workspace', otherThread.workspace === otherWorkspace, {
      workspace: otherThread.workspace,
    });

    // Same workspace: the Windows runtime did not refuse thread creation. Test
    // sequential then simultaneous tiny turns and record the honest outcome.
    const tokenC = makeToken();
    let sameWorkspace;
    try {
      sameWorkspace = await startOwnedRuntime({ executable: ENGINE, workspace, port: 7896, token: tokenC });
    } catch (error) {
      sameWorkspace = { error: error.message };
    }
    let sameResult;
    if (sameWorkspace.error) {
      sameResult = { outcome: 'startup-refused', detail: sameWorkspace.error };
    } else {
      const apiC = new RuntimeClient({ baseUrl: sameWorkspace.baseUrl, token: tokenC });
      sameResult = await apiC
        .createThread({ operationKey: `g0-thread-c-${crypto.randomUUID()}` })
        .then((v) => ({ outcome: 'thread-created', id: v.thread?.id }))
        .catch((error) => ({ outcome: 'refused', status: error.status, body: String(error.body ?? '').slice(0, 300) }));
      step('same-workspace second runtime: thread creation outcome recorded', true, sameResult);

      if (sameResult.outcome === 'thread-created') {
        const { thread: threadA2 } = await api.createThread({ operationKey: `g0-thread-a2-${crypto.randomUUID()}` });
        const { thread: threadC2 } = await apiC.createThread({ operationKey: `g0-thread-c2-${crypto.randomUUID()}` });
        const [runA, runC] = await Promise.all([
          runTurn(api, threadA2.id, 'Reply with exactly MONA_A and nothing else.', {
            label: 'concurrent A',
            operationKey: `g0-turn-a2-${crypto.randomUUID()}`,
          }),
          runTurn(apiC, threadC2.id, 'Reply with exactly MONA_C and nothing else.', {
            label: 'concurrent C',
            operationKey: `g0-turn-c2-${crypto.randomUUID()}`,
          }),
        ]);
        const statusA = turnStatus(runA.turn, runA.terminal);
        const statusC = turnStatus(runC.turn, runC.terminal);
        const historyA = await api.history(threadA2.id);
        const historyC = await apiC.history(threadC2.id);
        step('two owned runtimes completed simultaneous turns without cross-thread corruption', statusA === 'completed' && statusC === 'completed' && historyA.runtime_thread_id === threadA2.id && historyC.runtime_thread_id === threadC2.id, {
          statusA,
          statusC,
          messagesA: historyA.session?.messages?.length ?? 0,
          messagesC: historyC.session?.messages?.length ?? 0,
          note: 'one observation is not a safety proof; serialized execution remains the default until P04/P07 own the lease explicitly',
        });
      }
      await sameWorkspace.stop().catch(() => {});
    }
    step('workspace concurrency posture recorded honestly', true, { mode: 'serialized default pending P04/P07 lease ownership' });
  } finally {
    await runtimeB.stop().catch(() => {});
  }
} catch (error) {
  step('G0 run aborted', false, error.stack ?? error.message);
  process.exitCode = 1;
} finally {
  await runtime.stop().catch(() => {});
  report.finished_utc = new Date().toISOString();
  report.total_reported_cost_usd = report.spend.reduce((sum, row) => sum + (row.usage?.cost_usd ?? 0), 0);
  if (OUT) {
    await mkdir(dirname(OUT), { recursive: true });
    await writeFile(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`wrote ${OUT}`);
  }
  console.log(`reported spend for this run: $${report.total_reported_cost_usd.toFixed(6)}`);
}

async function findSentinelProcesses() {
  // Exclude this query process: its own command line contains the marker.
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'Start-Sleep -Seconds 300' -and $_.CommandLine -notmatch 'Get-CimInstance' } | Select-Object ProcessId,Name,CreationDate | ConvertTo-Json -Compress";
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20000 });
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [{ check: 'process-query-failed' }];
  }
}
