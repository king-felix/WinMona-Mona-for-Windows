// P04 live supervisor qualification against the installed Codewhale binary.
// No provider request is made: starting a runtime is free, and this script does
// not submit a turn. It proves ownership, identity, stopping, and that unrelated
// processes survive.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RuntimeSupervisor,
  attachExternalRuntime,
  findFreePort,
  normalizeWorkspacePath,
  portOpen,
  resolveWorkspace,
  systemProcessInspector,
  workspaceKeyFor,
  OwnershipStore,
} from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = process.env.MONA_ENGINE ?? 'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Links\\codewhale.exe';
const OUT = process.env.MONA_P04_OUT ?? path.resolve(here, '..', '..', '..', 'docs', 'evidence', 'P04-live.json');
const OUT_LOG =
  process.env.MONA_P04_LOG ?? path.resolve(here, '..', '..', '..', 'docs', 'evidence', 'P04-live-log.txt');

const lines = [];
const report = {
  schema_version: 1,
  captured_utc: new Date().toISOString(),
  engine_path: ENGINE,
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  steps: [],
};

function log(line) {
  lines.push(line);
  console.log(line);
}

function step(name, ok, detail) {
  report.steps.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 600)}`}`);
  return ok;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function settle(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  log(`timeout waiting for ${label}`);
  return false;
}

const root = await mkdtemp(path.join(tmpdir(), 'mona-p04-live-'));
const workspace = path.join(root, 'workspace');
const ownershipDir = path.join(root, 'ownership');
await mkdir(workspace, { recursive: true });
await mkdir(ownershipDir, { recursive: true });

const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  windowsHide: true,
});
const port = await findFreePort();
const events = [];
const supervisor = new RuntimeSupervisor({
  executable: ENGINE,
  workspace,
  ownershipDir,
  port,
  desktopInstanceId: 'dsk_p04_live',
  onEvent: (event) => events.push({ type: event.type, at: event.at }),
  startupTimeoutMs: 45_000,
});

let runtime = null;
try {
  const started = await supervisor.start();
  if (
    !step(
      'owned runtime reaches authenticated readiness',
      started.ok,
      started.ok
        ? { runtimeId: started.value.runtimeId, pid: started.value.pid, endpoint: started.value.endpoint }
        : started.error,
    )
  ) {
    throw new Error('start failed');
  }
  runtime = started.value;

  step('runtime identity matches the pinned engine', `${runtime.identity.version}` === '0.10.2', {
    version: runtime.identity.version,
    commit: runtime.identity.commit,
    compatibility: runtime.report.status,
    gaps: runtime.report.capabilityGaps,
  });

  const realWorkspace = await resolveWorkspace(workspace);
  const store = new OwnershipStore(ownershipDir);
  const key = workspaceKeyFor(normalizeWorkspacePath(realWorkspace));
  const record = await store.read(key);
  step(
    'ownership record is machine-local and token-free',
    record.ok,
    record.ok
      ? {
          file: store.fileFor(key),
          pid: record.record.pid,
          creation_time_recorded: record.record.process_creation_time !== null,
          state: record.record.state,
          token_digest_only: /^[0-9a-f]{64}$/.test(record.record.token_sha256),
        }
      : record,
  );

  if (record.ok) {
    const raw = await readFile(store.fileFor(key), 'utf8');
    step('ownership file contains no bearer token', !raw.includes(runtime.token), {});
    const probe = await systemProcessInspector.probe(record.record.pid);
    step(
      'recorded creation identity matches the live process',
      probe.creationTime === record.record.process_creation_time,
      {
        pid: probe.pid,
        name: probe.name,
        recorded: record.record.process_creation_time,
        observed: probe.creationTime,
      },
    );
  }

  const external = await attachExternalRuntime({
    baseUrl: runtime.endpoint,
    token: runtime.token,
    workspace: realWorkspace,
  });
  if (external.ok) {
    const refused = await external.value.stop();
    step('external attach is read-only and refuses to stop the runtime', !refused.ok && alive(runtime.pid), {
      owned: external.value.owned,
      refusal: refused.ok ? null : refused.error.message,
    });
  } else {
    step('external attach is read-only and refuses to stop the runtime', false, external.error);
  }

  const descriptorCheck = await fetch(`${runtime.endpoint}/health`)
    .then((response) => response.ok)
    .catch(() => false);
  step('loopback endpoint answers before the stop', descriptorCheck, { endpoint: runtime.endpoint });

  const stopped = await supervisor.stop('p04_live_qualification');
  if (!step('owned runtime stops with a receipt', stopped.ok, stopped.ok ? stopped.value : stopped.error)) {
    throw new Error('stop failed');
  }
  step(
    'stop receipt reports root exit, descendants and endpoint closure',
    stopped.value.root_exited && stopped.value.endpoint_closed,
    {
      outcome: stopped.value.outcome,
      forced: stopped.value.outcome === 'stopped_forced',
      observed_descendants: stopped.value.observed_descendants.length,
      remaining_pids: stopped.value.remaining_pids,
      rollback_claimed: stopped.value.rollback_claimed,
    },
  );
  const rootGone = await settle(() => !alive(runtime.pid), 10_000, 'runtime exit');
  step('the runtime process is gone', rootGone, { pid: runtime.pid });
  step('the loopback port is closed', !(await portOpen(port)), { port });

  const staleRecord = await store.read(key);
  step(
    'ownership record is marked stopped',
    staleRecord.ok && staleRecord.record.state === 'stopped',
    staleRecord.ok ? { state: staleRecord.record.state, reason: staleRecord.record.reason } : staleRecord,
  );

  step('an unrelated node process survived the whole run', alive(unrelated.pid), { pid: unrelated.pid });

  // Occupied-port behaviour against the real binary: another Codewhale runtime
  // must be reported, never adopted or killed.
  const holder = spawn(ENGINE, ['app-server', '--http', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: workspace,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, CODEWHALE_RUNTIME_TOKEN: 'p04-live-stranger-token-value' },
  });
  const holderReady = await settle(async () => await portOpen(port), 30_000, 'stranger runtime readiness');
  const busy = new RuntimeSupervisor({
    executable: ENGINE,
    workspace,
    ownershipDir,
    port,
    desktopInstanceId: 'dsk_p04_live',
    startupTimeoutMs: 20_000,
  });
  const busyStart = await busy.start();
  step(
    'a port already held by another Codewhale runtime is refused without killing it',
    holderReady && !busyStart.ok && busyStart.error.code === 'port_occupied' && alive(holder.pid),
    {
      error: busyStart.ok ? null : busyStart.error,
      holder_pid: holder.pid,
    },
  );
  await systemProcessInspector.terminateTree(holder.pid, { graceMs: 2_000, forceAfterMs: 8_000 });

  const missing = new RuntimeSupervisor({
    executable: path.join(root, 'no-such-codewhale.exe'),
    workspace,
    ownershipDir,
  });
  const missingStart = await missing.start();
  step(
    'a missing executable is an actionable failure',
    !missingStart.ok && missingStart.error.code === 'engine_unavailable',
    missingStart.ok ? null : missingStart.error,
  );

  report.ok = report.steps.every((entry) => entry.ok);
  report.events = events;
} catch (error) {
  report.ok = false;
  report.error = String(error);
  log(`FAILED: ${String(error)}`);
} finally {
  if (runtime) {
    await supervisor.stop('cleanup').catch(() => undefined);
  }
  try {
    process.kill(unrelated.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  report.finished_utc = new Date().toISOString();
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(OUT_LOG, `${lines.join('\n')}\n`, 'utf8');
  await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  process.exit(report.ok ? 0 : 1);
}
