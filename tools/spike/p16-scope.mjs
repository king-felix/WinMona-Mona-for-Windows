// P16 configuration-scope probe. Uses an isolated CODEWHALE_HOME so Victor's
// real config is untouched. Creates one empty thread, changes the saved model
// for new threads, and verifies the active thread keeps its route. No turn is
// submitted and no provider request is made.
// Usage: node tools/spike/p16-scope.mjs [--out <path>]

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { RuntimeClient, makeToken, startOwnedRuntime } from './runtime/client.mjs';

const ENGINE = process.env.MONA_ENGINE ?? 'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Links\\codewhale.exe';
const root = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'Temp',
  'mona-p16-scope',
  String(Date.now()),
);
const home = join(root, 'home');
const workspace = join(root, 'workspace');
await mkdir(home, { recursive: true });
await mkdir(workspace, { recursive: true });
await writeFile(
  join(home, 'config.toml'),
  'provider = "deepseek"\nmodel = "deepseek-flash"\n\n[providers.deepseek]\nbase_url = "https://api.deepseek.com"\n',
  'utf8',
);

function runCli(args) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(ENGINE, args, {
      env: { ...process.env, CODEWHALE_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const report = { schema_version: 1, captured_utc: new Date().toISOString(), home, workspace, checks: [] };
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${JSON.stringify(detail)}` : ''}`);
}

const token = makeToken();
process.env.CODEWHALE_HOME = home;
const runtime = await startOwnedRuntime({ executable: ENGINE, workspace, port: 7903, token });
const api = new RuntimeClient({ baseUrl: runtime.baseUrl, token });

try {
  const created = await api.createThread({ operationKey: `p16-scope-${crypto.randomUUID()}` });
  const threadId = created.thread.id;
  report.thread_before = created.thread;
  check('active thread starts on the configured Flash route', created.thread.model === 'deepseek-flash', {
    model: created.thread.model,
    provider: created.thread.model_provider,
  });

  const set = await runCli(['config', 'set', 'model', 'deepseek-chat']);
  report.config_set = { code: set.code, stdout: set.stdout.trim(), stderr: set.stderr.trim().slice(0, 300) };
  const get = await runCli(['config', 'get', 'model']);
  check('engine config CLI reports the new default for new threads', get.stdout.trim() === 'deepseek-chat', {
    model: get.stdout.trim(),
  });

  const after = await api.getThread(threadId);
  report.thread_after = after;
  check('active thread keeps deepseek-flash after the default changes', after.thread?.model === 'deepseek-flash', {
    thread_model: after.thread?.model,
    saved_default: get.stdout.trim(),
  });

  const config = await api.effectiveConfig();
  report.runtime_config_after = config;
  check('running runtime still reports its launch route', config.model === 'deepseek-flash', { model: config.model });

  const providers = await api.providers();
  report.providers = providers;
  const deepseek = providers.providers?.find((provider) => provider.id === 'deepseek');
  check('credential state is reported without a probe', deepseek?.credentialState === 'missing', {
    credentialState: deepseek?.credentialState,
    source: deepseek?.credentialSource,
  });

  const doctor = await runCli(['doctor', '--json']);
  report.doctor = { code: doctor.code, stderr: doctor.stderr.trim().slice(0, 300) };
  try {
    const parsed = JSON.parse(doctor.stdout);
    report.doctor.selected = {
      route: parsed.route,
      api_key: parsed.api_key,
      api_connectivity: parsed.api_connectivity,
      base_url: parsed.base_url,
      default_text_model: parsed.default_text_model,
    };
  } catch {
    report.doctor.raw_tail = doctor.stdout.slice(-800);
  }
  check('offline doctor did not probe the provider', report.doctor.selected?.api_connectivity?.checked === false, {
    status: report.doctor.selected?.api_connectivity?.status,
  });
} catch (error) {
  report.error = error.stack ?? String(error);
  console.log(`FAILED ${report.error}`);
  process.exitCode = 1;
} finally {
  await runtime.stop().catch(() => {});
  delete process.env.CODEWHALE_HOME;
  report.finished_utc = new Date().toISOString();
  const outIndex = process.argv.indexOf('--out');
  if (outIndex !== -1) {
    const out = process.argv[outIndex + 1];
    await mkdir(dirname(out), { recursive: true }).catch(() => {});
    await writeFile(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`wrote ${out}`);
  }
}
