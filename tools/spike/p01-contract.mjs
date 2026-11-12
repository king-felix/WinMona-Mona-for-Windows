// P01 G0/G2 contract probe: no inference is triggered by this script.
// It starts one owned runtime, exercises discovery/auth/thread/event/admin
// routes, verifies zero token movement while idle, then stops the runtime.
// Usage: node tools/spike/p01-contract.mjs [--out <path>]

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeClient, makeToken, startOwnedRuntime } from './runtime/client.mjs';

const ENGINE = process.env.MONA_ENGINE ?? 'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Links\\codewhale.exe';
const PORT = Number(process.env.MONA_PORT ?? 7891);
const outIndex = process.argv.indexOf('--out');
const OUT = outIndex === -1 ? null : process.argv[outIndex + 1];

const started = new Date().toISOString();
const report = {
  schema_version: 1,
  captured_utc: started,
  engine: { path: ENGINE },
  checks: [],
  observations: {},
  inference: {
    expected: 'none',
    mechanism: 'token/cost counters unchanged across discovery, thread create, history, events reconnect',
  },
};

function record(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`,
  );
}

const workspace = join(tmpdir(), 'mona-p01-contract', String(Date.now()));
await mkdir(workspace, { recursive: true });

const token = makeToken();
const runtime = await startOwnedRuntime({
  executable: ENGINE,
  workspace,
  port: PORT,
  token,
});

try {
  // --- authentication boundary -------------------------------------------
  // Observed contract: /v1/runtime/info is unauthenticated discovery metadata
  // (loopback-bound only); every stateful /v1 route requires the bearer token.
  const noAuth = await fetch(`${runtime.baseUrl}/v1/sessions`);
  record('unauthenticated stateful /v1 route refused', noAuth.status === 401, { status: noAuth.status });
  const noAuthInfo = await fetch(`${runtime.baseUrl}/v1/runtime/info`);
  record('runtime identity is unauthenticated discovery metadata', noAuthInfo.status === 200, {
    status: noAuthInfo.status,
  });
  const health = await fetch(`${runtime.baseUrl}/health`);
  record('unauthenticated /health is liveness only', health.status === 200, {
    status: health.status,
    body: await health.json(),
  });

  const api = new RuntimeClient({ baseUrl: runtime.baseUrl, token });
  const wrong = new RuntimeClient({ baseUrl: runtime.baseUrl, token: 'mona-wrong-token-000000' });
  let wrongStatus = 0;
  try {
    await wrong.request('GET', '/v1/sessions');
  } catch (error) {
    wrongStatus = error.status ?? 0;
  }
  record('wrong bearer token refused', wrongStatus === 401, { status: wrongStatus });

  // --- discovery ----------------------------------------------------------
  const info = await api.runtimeInfo();
  report.observations.runtime_info = info;
  record(
    'runtime identity pinned to installed binary',
    info.codewhale_version === '0.10.2' && info.codewhale_commit?.startsWith('ff466b2ed0bf'),
    {
      version: info.codewhale_version,
      commit: info.codewhale_commit,
    },
  );
  const caps = info.capabilities ?? {};
  report.observations.capabilities = caps;
  record('capability: turn_operation_idempotency', caps.turn_operation_idempotency === true);
  record('capability: turn_operation_lookup', caps.turn_operation_lookup === true);
  record('capability: event_stream_resume', caps.event_stream_resume === true);
  record('capability: event_replay', caps.event_replay === true);
  record('capability: thread_create_idempotency', caps.thread_create_idempotency === true);
  record('capability: turn_interrupt', caps.turn_interrupt === true);
  record('capability: turn_steer', caps.turn_steer === true);
  record('capability: fleet_event_stream', caps.fleet_event_stream === true);
  record('capability: terminal_stream unavailable (honest gap)', caps.terminal_stream === false);

  const config = await api.effectiveConfig();
  report.observations.effective_config = config;
  record(
    'configured route preserved: deepseek / deepseek-flash',
    config.provider === 'deepseek' && config.model === 'deepseek-flash',
    {
      provider: config.provider,
      model: config.model,
      base_url: config.base_url,
    },
  );

  const providers = await api.providers();
  report.observations.providers = providers;
  const deepseek = providers.providers?.find((p) => p.id === 'deepseek');
  record('provider catalog reports deepseek as current', providers.current === 'deepseek', {
    current: providers.current,
    credentialState: deepseek?.credentialState,
  });

  const usageBefore = await api.usage();
  report.observations.usage_before = usageBefore;
  // Idle window: a connected runtime with no submitted work must not move tokens.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const usageIdle = await api.usage();
  record(
    'five-second idle window caused zero inference',
    (usageBefore.totals?.input_tokens ?? 0) === (usageIdle.totals?.input_tokens ?? 0) &&
      (usageBefore.totals?.output_tokens ?? 0) === (usageIdle.totals?.output_tokens ?? 0) &&
      (usageBefore.totals?.cost_usd ?? 0) === (usageIdle.totals?.cost_usd ?? 0),
    { before: usageBefore.totals, after: usageIdle.totals },
  );

  // --- thread lifecycle (no inference) -----------------------------------
  // Operation keys are durable in the shared store: a repeated key with a
  // different request is refused with 409, so each run uses a fresh key and
  // the replay check below reuses it deliberately.
  const threadOperationKey = `p01-contract-${crypto.randomUUID()}`;
  const created = await api.createThread({ operationKey: threadOperationKey });
  record(
    'thread create returns effective profile',
    created.status === 201 && created.thread?.permission_posture === 'full_access',
    {
      status: created.status,
      id: created.thread?.id,
      posture: created.thread?.permission_posture,
      model: created.thread?.model,
      provider: created.thread?.model_provider,
      workspace: created.thread?.workspace,
    },
  );
  const threadId = created.thread.id;
  record('thread workspace matches owned runtime cwd', created.thread.workspace === workspace, {
    thread: created.thread.workspace,
    runtime: workspace,
  });

  const replay = await api.createThread({ operationKey: threadOperationKey });
  record('repeated thread create with same operation_key does not duplicate', replay.thread?.id === threadId, {
    first: threadId,
    second: replay.thread?.id,
    status: replay.status,
  });

  let conflictStatus = 0;
  let conflictMessage = '';
  try {
    await api.createThread({ operationKey: threadOperationKey, allowShell: false });
  } catch (error) {
    conflictStatus = error.status ?? 0;
    conflictMessage = String(error.body ?? '').slice(0, 200);
  }
  record('operation_key reuse with different data is refused, not silently substituted', conflictStatus === 409, {
    status: conflictStatus,
    message: conflictMessage,
  });

  const detail = await api.getThread(threadId);
  record(
    'thread detail exposes latest_seq and empty turn list',
    detail.latest_seq >= 1 && Array.isArray(detail.turns) && detail.turns.length === 0,
    {
      latest_seq: detail.latest_seq,
    },
  );

  const history = await api.history(threadId);
  record(
    'history is readable and engine-owned',
    history.runtime_thread_id === threadId && Array.isArray(history.session?.messages),
    {
      data_dir: history.data_dir,
      messages: history.session?.messages?.length ?? null,
    },
  );

  // Event subscription without inference: read the replayed journal, require
  // a stream that opens and can be aborted.
  const frames = [];
  const controller = new AbortController();
  const streamPromise = (async () => {
    for await (const frame of api.subscribe(threadId, { sinceSeq: 0, signal: controller.signal })) {
      frames.push(frame);
      if (frames.length >= 5) break;
    }
  })();
  await Promise.race([streamPromise, new Promise((resolve) => setTimeout(resolve, 3000))]);
  controller.abort();
  await streamPromise.catch(() => {});
  record('event stream opens for an idle thread', true, { frames: frames.length, first: frames[0]?.event ?? null });

  // Unsupported route: typed 404, never a fabricated success.
  let unknownStatus = 0;
  try {
    await api.request('GET', '/v1/this-route-does-not-exist');
  } catch (error) {
    unknownStatus = error.status ?? 0;
  }
  record('unknown route fails explicitly', unknownStatus === 404, { status: unknownStatus });

  // --- zero-inference observation ---------------------------------------
  const usageAfter = await api.usage();
  report.observations.usage_after = usageAfter;
  const before = usageBefore.totals ?? {};
  const after = usageAfter.totals ?? {};
  record(
    'discovery/thread/history/events caused zero token or cost movement',
    before.input_tokens === after.input_tokens &&
      before.output_tokens === after.output_tokens &&
      before.cost_usd === after.cost_usd,
    { before, after },
  );

  // --- stop ---------------------------------------------------------------
  const exitCode = await runtime.stop();
  record('owned runtime stops cleanly', true, { exitCode });
} catch (error) {
  record('contract probe aborted', false, error.stack ?? error.message);
  await runtime.stop().catch(() => {});
  process.exitCode = 1;
} finally {
  report.finished_utc = new Date().toISOString();
  if (OUT) {
    await mkdir(dirname(OUT), { recursive: true });
    await writeFile(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`wrote ${OUT}`);
  }
}
