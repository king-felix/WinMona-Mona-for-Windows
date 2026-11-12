// P15 one real native fleet run. Minimal single-worker, single-task workflow in
// a throwaway workspace. Records the run object, fleet events, receipts, agent
// runs, artifacts and the usage delta. Nothing else is started.
// Usage: node tools/spike/p15-real-run.mjs [--out <path>]

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeClient, makeToken, startOwnedRuntime, parseSseFrame } from './runtime/client.mjs';

const ENGINE = process.env.MONA_ENGINE ?? 'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Links\\codewhale.exe';
const PORT = Number(process.env.MONA_PORT ?? 7899);
const outIndex = process.argv.indexOf('--out');
const OUT = outIndex === -1 ? null : process.argv[outIndex + 1];

const workspace = join(tmpdir(), 'mona-p15-real', String(Date.now()));
await mkdir(workspace, { recursive: true });
const token = makeToken();
const runtime = await startOwnedRuntime({ executable: ENGINE, workspace, port: PORT, token });
const api = new RuntimeClient({ baseUrl: runtime.baseUrl, token });
const report = { schema_version: 1, captured_utc: new Date().toISOString(), workspace, events: [], failures: [] };

async function snapshot(name, path) {
  try {
    const res = await api.request('GET', path);
    report[name] = res.json;
    console.log(`snapshot ${name} ${res.status}`);
    return res.json;
  } catch (error) {
    report.failures.push({
      name,
      path,
      status: error.status ?? 0,
      body: String(error.body ?? error.message).slice(0, 400),
    });
    console.log(`snapshot FAIL ${name} ${error.status ?? 'error'}`);
    return null;
  }
}

try {
  report.usage_before = (await api.request('GET', '/v1/usage')).json;
  const created = await api.request('POST', '/v1/fleet/runs', {
    name: 'mona-p15-probe',
    target: 'this_computer',
    roles: [{ name: 'worker', agent_profile: 'worker' }],
    max_workers: 1,
    labels: { source: 'mona-p15' },
    workflow: {
      id: 'mona-p15-probe',
      kind: 'parallel',
      tasks: [
        {
          id: 't1',
          name: 'worker',
          instructions: 'Reply with exactly OK. Do not use tools and do not change files.',
          worker: { role: 'worker' },
        },
      ],
    },
  });
  const run = created.json.run;
  report.run_created = created.json;
  console.log(`created ${run.id}`);

  const started = await api.request('POST', `/v1/fleet/runs/${encodeURIComponent(run.id)}/start`, {});
  report.run_started = started.json;
  console.log(`started ${started.status}`);

  // Fleet SSE stream. Keep the parser local so the evidence records raw frames.
  const controller = new AbortController();
  const url = `${runtime.baseUrl}/v1/fleet/runs/${encodeURIComponent(run.id)}/events?since_seq=0`;
  const streamPromise = (async () => {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    report.fleet_stream_status = res.status;
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2));
        const frame = parseSseFrame(raw);
        if (frame) {
          report.events.push(frame);
          console.log(`event ${frame.event} ${JSON.stringify(frame.data).slice(0, 200)}`);
        }
      }
    }
  })();

  let terminal = false;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const current = await snapshot('run_current', `/v1/fleet/runs/${encodeURIComponent(run.id)}`);
    const status = current?.lifecycle_status;
    if (status && ['completed', 'partial', 'failed', 'cancelled'].includes(status)) {
      terminal = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  controller.abort();
  await streamPromise.catch(() => {});

  report.terminal = terminal;
  await snapshot('run_final', `/v1/fleet/runs/${encodeURIComponent(run.id)}`);
  await snapshot('run_receipts', `/v1/fleet/runs/${encodeURIComponent(run.id)}/receipts`);
  await snapshot('agent_runs', '/v1/agent-runs');
  await snapshot('goals', '/v1/goals');
  await snapshot('tasks', '/v1/tasks');
  report.usage_after = (await api.request('GET', '/v1/usage')).json;

  if (!terminal) {
    await api.request('POST', `/v1/fleet/runs/${encodeURIComponent(run.id)}/stop`, {}).catch((error) => {
      report.failures.push({ name: 'stop', status: error.status ?? 0, body: String(error.body ?? error.message) });
    });
  }
} catch (error) {
  report.failures.push({ name: 'run', status: null, body: error.stack ?? String(error) });
  console.log(`FAILED ${error.stack ?? error.message}`);
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
