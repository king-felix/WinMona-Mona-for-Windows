// P15 one real delegated agent run. A parent turn instructs the native agent
// tool to spawn one child for a read-only one-word task. Records the full event
// journal (including agent/subagent events), the resulting agent-run list and
// the usage delta. One small paid run; no other work.
// Usage: node tools/spike/p15-agent-run.mjs [--out <path>]

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeClient, makeToken, startOwnedRuntime } from './runtime/client.mjs';

const ENGINE = process.env.MONA_ENGINE ?? 'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Links\\codewhale.exe';
const PORT = Number(process.env.MONA_PORT ?? 7900);
const outIndex = process.argv.indexOf('--out');
const OUT = outIndex === -1 ? null : process.argv[outIndex + 1];

const workspace = join(tmpdir(), 'mona-p15-agent', String(Date.now()));
await mkdir(workspace, { recursive: true });
const token = makeToken();
const runtime = await startOwnedRuntime({ executable: ENGINE, workspace, port: PORT, token });
const api = new RuntimeClient({ baseUrl: runtime.baseUrl, token });
const report = { schema_version: 1, captured_utc: new Date().toISOString(), workspace, events: [], failures: [] };

const PROMPT = [
  'Use the agent tool exactly once to delegate this read-only task to one child:',
  '"Reply with exactly the word OK and nothing else. Do not use tools."',
  'Wait for the child, then reply with exactly: Parent received OK.',
  'Do not call any other tool and do not change any file.',
].join(' ');

try {
  report.usage_before = (await api.request('GET', '/v1/usage')).json;
  const created = await api.createThread({ operationKey: `p15-agent-${crypto.randomUUID()}` });
  const threadId = created.thread.id;
  report.thread = created.thread;

  const submitted = await api.submitTurn(threadId, { prompt: PROMPT, operationKey: `p15-turn-${crypto.randomUUID()}` });
  report.submission = submitted.receipt;
  console.log(`submitted turn ${submitted.receipt?.turn?.id ?? 'unknown'}`);

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 150_000);
  try {
    for await (const frame of api.subscribe(threadId, { sinceSeq: 0, signal: controller.signal })) {
      report.events.push(frame);
      console.log(`event ${frame.event} seq=${frame.id ?? ''} ${JSON.stringify(frame.data).slice(0, 180)}`);
      if (frame.event === 'turn.completed') break;
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    report.timed_out = true;
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }

  report.final_thread = await api.getThread(threadId);
  report.agent_runs = (await api.request('GET', '/v1/agent-runs')).json;
  report.goals = (await api.request('GET', '/v1/goals')).json;
  report.tasks = (await api.request('GET', '/v1/tasks')).json;
  report.thread_usage = await api.threadUsage(threadId);
  report.usage_after = (await api.request('GET', '/v1/usage')).json;
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
