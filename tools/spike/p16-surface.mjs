// P16 configuration surface probe. GET only: no configuration write, no provider
// probe, no inference. Records the catalog/schema shapes Mona must render.
// Usage: node tools/spike/p16-surface.mjs [--out <path>]

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeClient, makeToken, startOwnedRuntime } from './runtime/client.mjs';

const ENGINE = process.env.MONA_ENGINE ?? 'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Links\\codewhale.exe';
const outIndex = process.argv.indexOf('--out');
const OUT = outIndex === -1 ? null : process.argv[outIndex + 1];
const workspace = join(tmpdir(), 'mona-p16-surface', String(Date.now()));
await mkdir(workspace, { recursive: true });
const token = makeToken();
const runtime = await startOwnedRuntime({ executable: ENGINE, workspace, port: 7898, token });
const api = new RuntimeClient({ baseUrl: runtime.baseUrl, token });
const report = { schema_version: 1, captured_utc: new Date().toISOString(), observations: {}, failures: [] };

async function read(name, path) {
  try {
    const res = await api.request('GET', path);
    report.observations[name] = { status: res.status, json: res.json };
    console.log(`PASS ${name} ${res.status}`);
  } catch (error) {
    report.failures.push({
      name,
      path,
      status: error.status ?? 0,
      body: String(error.body ?? error.message).slice(0, 400),
    });
    console.log(`FAIL ${name} ${error.status ?? 'error'}`);
  }
}

try {
  await read('runtime_info', '/v1/runtime/info');
  await read('config', '/v1/config');
  await read('providers', '/v1/providers');
  await read('models', '/v1/models');
  await read('deepseek_models', '/v1/providers/deepseek/models');
  await read('settings_schema', '/v1/settings/schema');
  await read('diagnostics', '/v1/diagnostics');
  await read('auth_keys', '/v1/auth/keys');
} finally {
  await runtime.stop().catch(() => {});
  if (OUT) {
    await mkdir(dirname(OUT), { recursive: true });
    await writeFile(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`wrote ${OUT}`);
  }
}
