// P15 goal control-surface discovery by refused requests only. No turn, no goal
// and no provider request is created by an invalid body.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeClient, makeToken, startOwnedRuntime } from './runtime/client.mjs';

const ENGINE = process.env.MONA_ENGINE ?? 'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Links\\codewhale.exe';
const workspace = join(tmpdir(), 'mona-p15-goal', String(Date.now()));
await mkdir(workspace, { recursive: true });
const token = makeToken();
const runtime = await startOwnedRuntime({ executable: ENGINE, workspace, port: 7901, token });
const api = new RuntimeClient({ baseUrl: runtime.baseUrl, token });
const created = await api.createThread({ operationKey: `p15-goal-${crypto.randomUUID()}` });
const threadId = created.thread.id;

for (const [method, path, body] of [
  ['POST', `/v1/threads/${threadId}/goal`, {}],
  ['PUT', `/v1/threads/${threadId}/goal`, {}],
  ['POST', `/v1/threads/${threadId}/goal/complete`, {}],
  ['POST', `/v1/threads/${threadId}/goal/block`, {}],
  ['POST', `/v1/threads/${threadId}/agent-mail`, {}],
  ['POST', `/v1/agent-runs/unknown/cancel`, {}],
]) {
  try {
    const res = await api.request(method, path, body);
    console.log(`OK ${method} ${path} ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`);
  } catch (error) {
    console.log(
      `REFUSED ${method} ${path} ${error.status ?? 'error'} ${String(error.body ?? error.message).slice(0, 300)}`,
    );
  }
}
await runtime.stop();
