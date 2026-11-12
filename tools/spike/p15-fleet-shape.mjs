import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeClient, makeToken, startOwnedRuntime } from './runtime/client.mjs';
const ENGINE = process.env.MONA_ENGINE ?? 'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Links\\codewhale.exe';
const workspace = join(tmpdir(), 'mona-p15-shape4', String(Date.now()));
await mkdir(workspace, { recursive: true });
const token = makeToken();
const runtime = await startOwnedRuntime({ executable: ENGINE, workspace, port: 7897, token });
const api = new RuntimeClient({ baseUrl: runtime.baseUrl, token });
const base = { name: 'probe', target: 'this_computer', roles: [{ name: 'worker', agent_profile: 'worker' }] };
const bodies = [
  {
    ...base,
    workflow: {
      id: 'probe',
      kind: 'parallel',
      tasks: [{ id: 't1', name: 'worker', instructions: 'Say OK', worker: { role: 'worker' } }],
    },
  },
  {
    ...base,
    workflow: {
      id: 'probe',
      kind: 'parallel',
      tasks: [{ id: 't1', name: 'worker', instructions: 'Say OK', worker: { role: 'worker' }, role: 'worker' }],
    },
  },
  {
    ...base,
    roles: [{ role: 'worker', agent_profile: 'worker' }],
    workflow: {
      id: 'probe',
      kind: 'parallel',
      tasks: [{ id: 't1', name: 'worker', instructions: 'Say OK', worker: { role: 'worker' } }],
    },
  },
  {
    ...base,
    workflow: {
      id: 'probe',
      kind: 'parallel',
      tasks: [
        { id: 't1', name: 'worker', instructions: 'Say OK', worker: { role: 'worker' }, agent_profile: 'worker' },
      ],
    },
  },
];
for (const body of bodies) {
  try {
    const res = await api.request('POST', '/v1/fleet/runs', body);
    console.log(`OK -> ${res.status} ${JSON.stringify(res.json).slice(0, 900)}`);
  } catch (error) {
    console.log(`REFUSED -> ${error.status ?? 'error'} ${String(error.body ?? error.message).slice(0, 500)}`);
  }
}
await runtime.stop();
