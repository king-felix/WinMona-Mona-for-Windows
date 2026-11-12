// P15 goal shape probe: create one inert goal on a throwaway thread, read it,
// verify no turn/token movement, then complete it. No prompt is submitted.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeClient, makeToken, startOwnedRuntime } from './runtime/client.mjs';

const ENGINE = process.env.MONA_ENGINE ?? 'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Links\\codewhale.exe';
const workspace = join(tmpdir(), 'mona-p15-goal2', String(Date.now()));
await mkdir(workspace, { recursive: true });
const token = makeToken();
const runtime = await startOwnedRuntime({ executable: ENGINE, workspace, port: 7902, token });
const api = new RuntimeClient({ baseUrl: runtime.baseUrl, token });
const created = await api.createThread({ operationKey: `p15-goal2-${crypto.randomUUID()}` });
const threadId = created.thread.id;
const before = (await api.request('GET', '/v1/usage')).json;

try {
  const put = await api.request('PUT', `/v1/threads/${threadId}/goal`, {
    objective: 'Record an inert probe objective. Do not start work.',
  });
  console.log(`PUT ${put.status} ${JSON.stringify(put.json)}`);
  const read = await api.request('GET', `/v1/threads/${threadId}/goal`);
  console.log(`GET ${read.status} ${JSON.stringify(read.json)}`);
  const list = await api.request('GET', '/v1/goals');
  console.log(`LIST ${list.status} ${JSON.stringify(list.json)}`);
  const detail = await api.getThread(threadId);
  console.log(`TURNS ${JSON.stringify(detail.turns)}`);
  const complete = await api.request('POST', `/v1/threads/${threadId}/goal/complete`, {});
  console.log(`COMPLETE ${complete.status} ${JSON.stringify(complete.json)}`);
  const after = (await api.request('GET', '/v1/usage')).json;
  console.log(
    `ZERO_INFERENCE=${before.totals.input_tokens === after.totals.input_tokens && before.totals.cost_usd === after.totals.cost_usd}`,
  );
} catch (error) {
  console.log(`FAILED ${error.status ?? ''} ${String(error.body ?? error.message)}`);
}
await runtime.stop();
