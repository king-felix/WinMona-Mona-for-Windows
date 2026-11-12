// P15 native-orchestration surface probe. No inference: it starts one owned
// runtime, creates one empty thread, reads the native goal/fleet/agent/artifact
// surfaces, and stops. Every route is one observed in the installed 0.10.2
// binary; responses are recorded verbatim for contract mapping.
// Usage: node tools/spike/p15-surface.mjs [--out <path>]

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeClient, makeToken, startOwnedRuntime } from './runtime/client.mjs';

const ENGINE = process.env.MONA_ENGINE ?? 'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Links\\codewhale.exe';
const PORT = Number(process.env.MONA_PORT ?? 7893);
const outIndex = process.argv.indexOf('--out');
const OUT = outIndex === -1 ? null : process.argv[outIndex + 1];

const report = {
  schema_version: 1,
  captured_utc: new Date().toISOString(),
  engine: { path: ENGINE },
  inference: { expected: 'none', mechanism: 'only GET routes plus one empty thread create; usage totals compared' },
  observations: {},
  failures: [],
};

async function read(api, name, path) {
  try {
    const res = await api.request('GET', path);
    report.observations[name] = { status: res.status, json: res.json };
    console.log(`PASS ${name} ${path} ${res.status}`);
  } catch (error) {
    report.failures.push({
      name,
      path,
      status: error.status ?? 0,
      body: String(error.body ?? error.message).slice(0, 500),
    });
    console.log(`FAIL ${name} ${path} ${error.status ?? 'error'}`);
  }
}

const workspace = join(tmpdir(), 'mona-p15-surface', String(Date.now()));
await mkdir(workspace, { recursive: true });

const token = makeToken();
const runtime = await startOwnedRuntime({ executable: ENGINE, workspace, port: PORT, token });
const api = new RuntimeClient({ baseUrl: runtime.baseUrl, token });

try {
  const info = await api.runtimeInfo();
  report.observations.runtime_info = info;
  const usageBefore = await api.usage();
  report.observations.usage_before = usageBefore;

  const created = await api.createThread({ operationKey: `p15-surface-${crypto.randomUUID()}` });
  const threadId = created.thread.id;
  report.observations.thread = created.thread;

  await read(api, 'goals_list', '/v1/goals');
  await read(api, 'tasks_list', '/v1/tasks');
  await read(api, 'agent_runs_list', '/v1/agent-runs');
  await read(api, 'fleet_runs_list', '/v1/fleet/runs');
  await read(api, 'fleet_profiles', '/v1/fleet/profiles');
  await read(api, 'fleet_placement', '/v1/fleet/placement');
  await read(api, 'thread_goal', `/v1/threads/${encodeURIComponent(threadId)}/goal`);
  await read(api, 'thread_agent_mail', `/v1/threads/${encodeURIComponent(threadId)}/agent-mail`);
  await read(api, 'thread_jobs', `/v1/threads/${encodeURIComponent(threadId)}/jobs`);
  await read(api, 'thread_todo', `/v1/threads/${encodeURIComponent(threadId)}/todo`);

  const usageAfter = await api.usage();
  report.observations.usage_after = usageAfter;
  report.zero_inference =
    (usageBefore.totals?.input_tokens ?? 0) === (usageAfter.totals?.input_tokens ?? 0) &&
    (usageBefore.totals?.output_tokens ?? 0) === (usageAfter.totals?.output_tokens ?? 0) &&
    (usageBefore.totals?.cost_usd ?? 0) === (usageAfter.totals?.cost_usd ?? 0);
  console.log(`zero_inference=${report.zero_inference}`);
} catch (error) {
  report.failures.push({ name: 'probe', status: null, body: error.stack ?? String(error) });
  console.log(`PROBE FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  await runtime.stop().catch(() => {});
  report.finished_utc = new Date().toISOString();
  if (OUT) {
    await mkdir(dirname(OUT), { recursive: true });
    await writeFile(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`wrote ${OUT}`);
  }
}
