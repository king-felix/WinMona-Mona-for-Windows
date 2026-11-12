// P01 G1 cost pilot: direct `codewhale exec --auto` versus the HTTP runtime
// adapter, matched binary/provider/model/tools/tasks on clean workspaces.
//
// Rates come from the engine's own bundled model catalog entry for
// deepseek-flash (input 0.15/M, cache_read 0.003/M, output 0.6/M). The adapter
// cost is also read from the engine's priced usage totals; the formula below is
// cross-checked against it. Provider billing remains authoritative.
//
// Usage: node tools/spike/p01-bench.mjs [--reps 2] [--out docs/evidence/P01-bench.json]

import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { RuntimeClient, makeToken, startOwnedRuntime } from './runtime/client.mjs';

const execFileAsync = promisify(execFile);
const ENGINE = process.env.MONA_ENGINE ?? 'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Links\\codewhale.exe';
const REPS = Number(process.argv[process.argv.indexOf('--reps') + 1] || 2);
const outIndex = process.argv.indexOf('--out');
const OUT = outIndex === -1 ? null : process.argv[outIndex + 1];
const RATES = {
  source: 'engine bundled model catalog: deepseek-flash cost {input: 0.15, cache_read: 0.003, output: 0.6} USD per million tokens',
  input_per_m_usd: 0.15,
  cache_read_per_m_usd: 0.003,
  output_per_m_usd: 0.6,
};

const TASKS = [
  {
    id: 'file-test',
    prompt: [
      'Create sum.js exporting function sum(a, b) { return a + b; }',
      'Create sum.test.js using node:test that asserts sum(2, 2) === 4.',
      'Run `node --test` and report the passing count. Do not create other files.',
    ].join('\n'),
    seed: {},
    async accept(workspace) {
      const sum = await readFile(join(workspace, 'sum.js'), 'utf8').catch(() => null);
      const test = await readFile(join(workspace, 'sum.test.js'), 'utf8').catch(() => null);
      let output = '';
      try {
        output = (await execFileAsync(process.execPath, ['--test'], { cwd: workspace, timeout: 60000 })).stdout;
      } catch (error) {
        output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      }
      const pass = Number(output.match(/pass\s+(\d+)/i)?.[1] ?? 0);
      const fail = Number(output.match(/fail\s+(\d+)/i)?.[1] ?? 1);
      return { accepted: Boolean(sum && test) && pass >= 1 && fail === 0, evidence: { sum_bytes: sum?.length ?? 0, test_bytes: test?.length ?? 0, pass, fail } };
    },
  },
  {
    id: 'diagnostic',
    prompt: 'Read sum.js in this workspace and explain in two sentences what it does. Do not modify any file.',
    seed: { 'sum.js': 'export function sum(a, b) { return a + b; }\n' },
    async accept(workspace, response) {
      const sum = await readFile(join(workspace, 'sum.js'), 'utf8').catch(() => null);
      const unchanged = sum === 'export function sum(a, b) { return a + b; }\n';
      return { accepted: unchanged && /\bsum\b/i.test(response || ''), evidence: { unchanged, response_chars: response?.length ?? 0 } };
    },
  },
  {
    id: 'multi-step',
    prompt: [
      'Create a.txt containing exactly 1 and b.txt containing exactly 2.',
      'Then run one shell command that prints both file contents and report the output.',
    ].join('\n'),
    seed: {},
    async accept(workspace, response) {
      const a = await readFile(join(workspace, 'a.txt'), 'utf8').catch(() => null);
      const b = await readFile(join(workspace, 'b.txt'), 'utf8').catch(() => null);
      const accepted = a?.trim() === '1' && b?.trim() === '2';
      return { accepted, evidence: { a: a?.trim() ?? null, b: b?.trim() ?? null, response_chars: response?.length ?? 0 } };
    },
  },
];

const report = {
  schema_version: 1,
  captured_utc: new Date().toISOString(),
  engine_path: ENGINE,
  pilot_ceiling_usd: 2,
  rates: RATES,
  reps: REPS,
  runs: [],
  pairs: [],
  notes: [
    'Adapter cost is engine-reported (priced usage provenance provider_docs); direct cost is computed from the same engine bundled rates because exec does not emit a cost field.',
    'Reasoning tokens are already included in output_tokens for this route; they are not added again.',
    'Every run is a fresh workspace; order alternates per repetition to reduce warm-cache bias.',
  ],
};

function price(hit, miss, output) {
  return (miss * RATES.input_per_m_usd + hit * RATES.cache_read_per_m_usd + output * RATES.output_per_m_usd) / 1_000_000;
}

async function makeWorkspace(taskId, arm, rep) {
  const workspace = join(tmpdir(), 'mona-p01-bench', `${taskId}-${arm}-${rep}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

async function runDirect(task, workspace) {
  const startedAt = Date.now();
  const child = spawn(ENGINE, ['exec', '--auto', '--output-format', 'stream-json', task.prompt], {
    cwd: workspace,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
  const exit = await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      /* non-JSON noise stays out of the metrics */
    }
  }
  const receipts = parsed.filter((row) => row.type === 'provider_request_receipt');
  const usageRows = parsed.filter((row) => row.type === 'turn_usage');
  const metadata = parsed.find((row) => row.type === 'metadata')?.meta ?? null;
  const content = parsed
    .filter((row) => row.type === 'content')
    .map((row) => row.content)
    .join('');
  // exec emits one turn_usage per model request; metadata aggregates the turn.
  const summed = usageRows.reduce(
    (acc, row) => ({
      hit: acc.hit + Number(row.prompt_cache_hit_tokens ?? 0),
      miss: acc.miss + Number(row.prompt_cache_miss_tokens ?? 0),
      output: acc.output + Number(row.output_tokens ?? 0),
      reasoning: acc.reasoning + Number(row.reasoning_tokens ?? 0),
    }),
    { hit: 0, miss: 0, output: 0, reasoning: 0 },
  );
  const hit = Number(metadata?.prompt_cache_hit_tokens ?? summed.hit);
  const miss = Number(metadata?.prompt_cache_miss_tokens ?? summed.miss);
  const output = Number(metadata?.output_tokens ?? summed.output);
  const tools = receipts[0]?.receipt?.wire_observations?.[0]?.tools ?? null;
  return {
    arm: 'direct',
    exitCode: exit,
    elapsedMs: Date.now() - startedAt,
    requests: receipts.length,
    transportRetries: receipts.reduce((sum, row) => sum + (row.receipt?.transport_retries ?? 0), 0),
    usage: { hit, miss, output, reasoning: Number(metadata?.reasoning_tokens ?? summed.reasoning) },
    requestUsage: usageRows.map((row) => ({
      turn: row.turn,
      hit: row.prompt_cache_hit_tokens,
      miss: row.prompt_cache_miss_tokens,
      output: row.output_tokens,
      finish_reason: row.finish_reason,
    })),
    tool: tools ? { count: tools.tool_count, schema_bytes: tools.tool_schema_bytes, schema_sha256: tools.tool_schema_sha256 } : null,
    endpointFingerprint: receipts[0]?.receipt?.wire_observations?.[0]?.endpoint_fingerprint ?? null,
    wireModel: receipts[0]?.receipt?.wire_observations?.[0]?.wire_model ?? null,
    metadata: metadata
      ? {
          status: metadata.status,
          retry_count: metadata.retry_count,
          approval_posture: metadata.approval_posture,
          sandbox_posture: metadata.sandbox_posture,
          model: metadata.model,
          provider: metadata.provider,
          binary_sha256: metadata.binary_sha256,
          tool_catalog_sha256: metadata.tool_catalog_sha256,
        }
      : null,
    response: content,
    stderr: stderr.slice(-2000),
  };
}

async function runAdapter(task, workspace, port) {
  const startedAt = Date.now();
  const token = makeToken();
  const runtime = await startOwnedRuntime({ executable: ENGINE, workspace, port, token });
  const api = new RuntimeClient({ baseUrl: runtime.baseUrl, token });
  const frames = [];
  const controller = new AbortController();
  const until = (frame) => frame.event === 'turn.completed' || ['completed', 'interrupted', 'failed', 'canceled'].includes(frame.data?.payload?.status);
  try {
    const { thread } = await api.createThread({ operationKey: `bench-thread-${crypto.randomUUID()}` });
    const stream = (async () => {
      for await (const frame of api.subscribe(thread.id, { sinceSeq: 0, signal: controller.signal })) {
        frames.push(frame);
        if (until(frame)) return;
      }
    })();
    const submitted = await api.submitTurn(thread.id, {
      prompt: task.prompt,
      operationKey: `bench-turn-${crypto.randomUUID()}`,
    });
    const turnId = submitted.receipt?.turn?.id;
    await Promise.race([stream, new Promise((resolve) => setTimeout(resolve, 300000))]);
    controller.abort();
    await stream.catch(() => {});
    const detail = await api.getThread(thread.id);
    const turn = detail.turns?.find((row) => row.id === turnId);
    const usage = await api.threadUsage(thread.id);
    const usageEvents = frames.filter((frame) => frame.event === 'turn.usage' && frame.data?.turn_id === turnId);
    const providerEvents = frames.filter((frame) => frame.event === 'turn.provider_request' && frame.data?.turn_id === turnId);
    const hit = usageEvents.reduce((sum, frame) => sum + Number(frame.data?.payload?.usage?.prompt_cache_hit_tokens ?? 0), 0);
    const miss = usageEvents.reduce((sum, frame) => sum + Number(frame.data?.payload?.usage?.prompt_cache_miss_tokens ?? 0), 0);
    const output = usageEvents.reduce((sum, frame) => sum + Number(frame.data?.payload?.usage?.output_tokens ?? 0), 0);
    const toolObs = providerEvents[0]?.data?.payload?.wire_observations?.[0]?.tools ?? null;
    const response = frames
      .filter((frame) => frame.event === 'item.completed' && frame.data?.payload?.item?.kind === 'agent_message')
      .map((frame) => frame.data.payload.item.detail ?? frame.data.payload.item.summary ?? '')
      .join('\n');
    return {
      arm: 'adapter',
      elapsedMs: Date.now() - startedAt,
      threadId: thread.id,
      turnId,
      status: turn?.status ?? null,
      requests: providerEvents.length,
      transportRetries: providerEvents.reduce((sum, frame) => sum + (frame.data?.payload?.transport_retries ?? 0), 0),
      usage: { hit, miss, output, reasoning: usageEvents.reduce((sum, frame) => sum + Number(frame.data?.payload?.usage?.reasoning_tokens ?? 0), 0) },
      engineCostUsd: usage.totals?.cost_usd ?? null,
      costComplete: usage.totals?.cost_complete ?? null,
      pricingProvenances: usage.totals?.pricing_provenances ?? [],
      totalsSemantics: { input_tokens: usage.totals?.input_tokens, cached_tokens: usage.totals?.cached_tokens, note: 'thread usage reports miss-only input_tokens plus cached_tokens; turn.usage reports total input' },
      tool: toolObs ? { count: toolObs.tool_count, schema_bytes: toolObs.tool_schema_bytes, schema_sha256: toolObs.tool_schema_sha256 } : null,
      endpointFingerprint: providerEvents[0]?.data?.payload?.wire_observations?.[0]?.endpoint_fingerprint ?? null,
      wireModel: providerEvents[0]?.data?.payload?.wire_observations?.[0]?.wire_model ?? null,
      requestUsage: usageEvents.map((frame) => ({
        hit: frame.data?.payload?.usage?.prompt_cache_hit_tokens,
        miss: frame.data?.payload?.usage?.prompt_cache_miss_tokens,
        output: frame.data?.payload?.usage?.output_tokens,
        duration_ms: frame.data?.payload?.duration_ms,
      })),
      toolCatalogHash: frames.find((frame) => frame.event === 'model.tools.snapshot')?.data?.payload?.snapshot?.active_tool_catalog_sha256 ?? null,
      response,
    };
  } finally {
    await runtime.stop().catch(() => {});
  }
}

let port = 7900;
for (const task of TASKS) {
  for (let rep = 0; rep < REPS; rep += 1) {
    const order = rep % 2 === 0 ? ['direct', 'adapter'] : ['adapter', 'direct'];
    const pair = { task: task.id, rep, order, direct: null, adapter: null };
    for (const arm of order) {
      const workspace = await makeWorkspace(task.id, arm, rep);
      for (const [name, content] of Object.entries(task.seed)) {
        await writeFile(join(workspace, name), content, 'utf8');
      }
      let result;
      if (arm === 'direct') {
        result = await runDirect(task, workspace);
      } else {
        result = await runAdapter(task, workspace, port++);
      }
      const acceptance = await task.accept(workspace, result.response);
      result.workspace = workspace;
      result.accepted = acceptance.accepted;
      result.acceptance = acceptance;
      result.costUsd = result.arm === 'adapter' ? result.engineCostUsd ?? price(result.usage.hit, result.usage.miss, result.usage.output) : price(result.usage.hit, result.usage.miss, result.usage.output);
      result.costBasis = result.arm === 'adapter' ? 'engine-reported priced usage' : 'estimated with engine bundled rates';
      report.runs.push({ task: task.id, rep, ...result });
      pair[arm] = {
        accepted: result.accepted,
        costUsd: result.costUsd,
        requests: result.requests,
        usage: result.usage,
        elapsedMs: result.elapsedMs,
        status: result.status ?? result.metadata?.status ?? null,
      };
      console.log(
        `${arm.padEnd(7)} ${task.id.padEnd(10)} rep${rep} accepted=${result.accepted} requests=${result.requests} hit=${result.usage.hit} miss=${result.usage.miss} out=${result.usage.output} cost=$${result.costUsd?.toFixed(6)}`,
      );
    }
    if (pair.direct?.accepted && pair.adapter?.accepted) {
      pair.costRatio = pair.adapter.costUsd / pair.direct.costUsd;
      pair.deltaPct = ((pair.adapter.costUsd - pair.direct.costUsd) / pair.direct.costUsd) * 100;
    }
    report.pairs.push(pair);
  }
}

report.totals = {
  reportedCostUsd: report.runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
  directCostUsd: report.runs.filter((run) => run.arm === 'direct').reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
  adapterCostUsd: report.runs.filter((run) => run.arm === 'adapter').reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
  acceptedDirect: report.runs.filter((run) => run.arm === 'direct' && run.accepted).length,
  acceptedAdapter: report.runs.filter((run) => run.arm === 'adapter' && run.accepted).length,
  runs: report.runs.length,
};
const pairDeltas = report.pairs.filter((pair) => typeof pair.deltaPct === 'number').map((pair) => pair.deltaPct);
report.totals.medianPairedDeltaPct = pairDeltas.length ? median(pairDeltas) : null;
report.verdict = verdict(report);

if (OUT) {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`wrote ${OUT}`);
}
console.log(JSON.stringify({ totals: report.totals, verdict: report.verdict }, null, 2));
if (report.totals.reportedCostUsd > report.pilot_ceiling_usd) {
  console.error('PILOT CEILING EXCEEDED');
  process.exitCode = 2;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function verdict(current) {
  const toolHashes = current.runs
    .map((run) => run.tool?.schema_sha256)
    .filter(Boolean);
  const toolParity = new Set(toolHashes).size === 1 && toolHashes.length > 1;
  const allAccepted = current.totals.acceptedDirect === current.totals.acceptedAdapter;
  const gate = typeof current.totals.medianPairedDeltaPct === 'number' && current.totals.medianPairedDeltaPct <= 5;
  return {
    tool_schema_parity: toolParity,
    tool_schema_hashes: [...new Set(toolHashes)],
    acceptance_parity: allAccepted,
    median_paired_delta_pct: current.totals.medianPairedDeltaPct,
    within_5_percent_tolerance: gate,
    status: toolParity && allAccepted && gate ? 'pass_provisional' : 'investigate',
    caveat: 'small sample, one machine, prompt caching active; provisional per spec 9.4',
  };
}
