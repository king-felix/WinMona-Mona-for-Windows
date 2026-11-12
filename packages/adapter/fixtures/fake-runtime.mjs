// Test-only fake Codewhale runtime. It implements exactly the endpoints the
// supervisor probes, requires the bearer token, and can spawn a descendant so
// tree-cleanup tests are real. It is never used by the product.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const port = Number(portFlag >= 0 ? args[portFlag + 1] : (process.env.FAKE_RUNTIME_PORT ?? 0));
const token = process.env.CODEWHALE_RUNTIME_TOKEN ?? '';
const childPidFile = process.env.FAKE_CHILD_PID_FILE;
const crashMs = Number(process.env.FAKE_CRASH_MS ?? 0);

let descendant = null;
if (process.env.FAKE_RUNTIME_CHILD === '1') {
  descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (childPidFile && descendant.pid) writeFileSync(childPidFile, String(descendant.pid), 'utf8');
}

// Mirrors the pinned 0.10.2 runtime's advertised flags so compatibility is
// exercised for real, including the unavailable terminal family.
const capabilities = {
  client_token_intents: true,
  account_session: true,
  account_model_owner: true,
  session_provider_keys: false,
  threads: true,
  thread_create_idempotency: true,
  thread_shell_consent: true,
  turns: true,
  turn_operation_idempotency: true,
  turn_operation_lookup: true,
  automation_mutation_preconditions: true,
  turn_image_inputs: true,
  turn_output_token_limit: true,
  profile_constitution: true,
  turn_steer: true,
  turn_interrupt: true,
  event_replay: true,
  external_tools: true,
  environments: false,
  worker_runtime: true,
  fleet_run_create: true,
  fleet_run_start: true,
  fleet_event_replay: true,
  fleet_event_stream: true,
  fleet_local_target: true,
  thread_goals: true,
  memory: true,
  mcp_server_management: true,
  skill_lifecycle: true,
  skill_detail: true,
  plugin_management: true,
  agent_mail: true,
  terminal_stream: false,
  terminal_input: false,
  terminal_resize: false,
  terminal_kill: false,
  event_stream_resume: true,
};

function authorized(request) {
  return request.headers.authorization === `Bearer ${token}`;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const send = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === '/health') {
    send(200, { status: 'ok', service: 'codewhale-runtime-api', mode: 'local' });
    return;
  }
  if (url.pathname === '/v1/runtime/info') {
    send(200, {
      service: 'codewhale-runtime-api',
      runtime_api_version: '1.0',
      codewhale_version: '0.10.2',
      codewhale_commit: 'ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e',
      bind_host: '127.0.0.1',
      port,
      auth_required: true,
      transports: ['http', 'sse'],
      capabilities,
      account: { schema_version: 1, state: 'signed_out', api_base: 'https://api.codewhale.net', scopes: [] },
      version: '0.10.2',
    });
    return;
  }
  if (url.pathname === '/v1/providers') {
    if (!authorized(request)) return send(401, { error: 'unauthorized' });
    send(200, []);
    return;
  }
  send(404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  if (crashMs > 0) setTimeout(() => process.exit(7), crashMs).unref();
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Keep a reference so the descendant is not orphaned by GC in test runs.
if (descendant) descendant.unref();
