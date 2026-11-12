// P15 write-surface discovery: send deliberately invalid POST bodies so the
// runtime reports its required schema. Refused requests create nothing; no turn
// is dispatched and no provider call is made. Configuration writes are excluded
// on purpose: Mona's build must not mutate Victor's global engine config.
// Usage: node tools/spike/p15-write-shape.mjs

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeClient, makeToken, startOwnedRuntime } from './runtime/client.mjs';

const ENGINE = process.env.MONA_ENGINE ?? 'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Links\\codewhale.exe';
const workspace = join(tmpdir(), 'mona-p15-shape', String(Date.now()));
await mkdir(workspace, { recursive: true });
const token = makeToken();
const runtime = await startOwnedRuntime({ executable: ENGINE, workspace, port: 7894, token });
const api = new RuntimeClient({ baseUrl: runtime.baseUrl, token });

const attempts = [
  ['POST', '/v1/fleet/runs', {}],
  ['POST', '/v1/fleet/runs', { task_spec: {} }],
  ['POST', '/v1/agent-runs', {}],
  ['POST', '/v1/agent-runs', { prompt: 'x' }],
  ['POST', '/v1/goals', {}],
];

for (const [method, path, body] of attempts) {
  try {
    const res = await api.request(method, path, body);
    console.log(`OK ${method} ${path} ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`);
  } catch (error) {
    console.log(
      `REFUSED ${method} ${path} ${error.status ?? 'error'} ${String(error.body ?? error.message).slice(0, 400)}`,
    );
  }
}
await runtime.stop();
