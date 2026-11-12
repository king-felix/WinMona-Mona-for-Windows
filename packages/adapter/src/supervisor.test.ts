import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OwnershipStore,
  RuntimeSupervisor,
  attachExternalRuntime,
  classifySpawnFailure,
  findFreePort,
  normalizeWorkspacePath,
  systemProcessInspector,
  workspaceKeyFor,
  type RuntimeOwnershipRecord,
  type SupervisorEvent,
} from './index.js';

const fakeRuntime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-runtime.mjs');
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p04-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForPidFile(file: string): Promise<number> {
  let pid = 0;
  await waitFor(
    async () => {
      try {
        pid = Number((await readFile(file, 'utf8')).trim());
        return Number.isInteger(pid) && pid > 0;
      } catch {
        return false;
      }
    },
    10_000,
    'pid file',
  );
  return pid;
}

function killQuietly(child: ChildProcess | null): void {
  if (child && child.exitCode === null) child.kill('SIGKILL');
}

function record(overrides: Partial<RuntimeOwnershipRecord>): RuntimeOwnershipRecord {
  const base: RuntimeOwnershipRecord = {
    schema_version: 1,
    runtime_id: 'rt_0123456789abcdef01234567',
    workspace: 'c:\\temp\\mona',
    workspace_key: '0123456789abcdef01234567',
    executable: 'c:\\codewhale.exe',
    executable_real_path: 'c:\\codewhale.exe',
    executable_size: 10,
    executable_mtime_ms: 1,
    version: '0.10.2',
    commit: 'ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e',
    pid: 4242,
    process_creation_time: '2026-01-01T00:00:00.000Z',
    parent_pid: 100,
    desktop_instance_id: 'dsk_other_instance',
    endpoint: 'http://127.0.0.1:7903',
    token_sha256: 'a'.repeat(64),
    started_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    state: 'running',
  };
  return { ...base, ...overrides };
}

describe('process tree ownership', () => {
  it('stops a real owned process tree and leaves an unrelated node process alive', async () => {
    const dir = await tempDir('tree');
    const pidFile = path.join(dir, 'child.pid');
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      'fs.writeFileSync(process.argv[1], String(child.pid));',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const root = spawn(process.execPath, ['-e', script, pidFile], { stdio: 'ignore', windowsHide: true });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      expect(root.pid).toBeGreaterThan(0);
      const descendantPid = await waitForPidFile(pidFile);
      expect(alive(root.pid as number)).toBe(true);
      expect(alive(descendantPid)).toBe(true);
      const observed = await systemProcessInspector.descendants(root.pid as number);
      expect(observed).toContain(descendantPid);

      const result = await systemProcessInspector.terminateTree(root.pid as number, {
        graceMs: 400,
        forceAfterMs: 6_000,
      });
      expect(['stopped', 'stopped_forced']).toContain(result.outcome);
      expect(result.rootExited).toBe(true);
      expect(result.remainingPids).toEqual([]);
      await waitFor(() => !alive(root.pid as number), 5_000, 'root exit');
      await waitFor(() => !alive(descendantPid), 5_000, 'descendant exit');
      expect(alive(unrelated.pid as number)).toBe(true);
    } finally {
      killQuietly(root);
      killQuietly(unrelated);
    }
  }, 30_000);
});

describe('RuntimeSupervisor', () => {
  it('starts the runtime with an authenticated loopback identity and a token-free ownership record', async () => {
    const workspace = await tempDir('workspace');
    const ownershipDir = await tempDir('ownership');
    const port = await findFreePort();
    const token = 'p04-test-token-0123456789';
    const events: SupervisorEvent[] = [];
    const supervisor = new RuntimeSupervisor({
      executable: process.execPath,
      workspace,
      ownershipDir,
      port,
      token,
      command: { executable: process.execPath, args: [fakeRuntime, '--port', String(port)] },
      onEvent: (event) => events.push(event),
      startupTimeoutMs: 10_000,
    });

    const started = await supervisor.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.report.status).toBe('qualified');
    expect(started.value.identity.version).toBe('0.10.2');
    expect(started.value.endpoint).toBe(`http://127.0.0.1:${port}`);
    expect(events.map((event) => event.type)).toContain('ready');

    const key = workspaceKeyFor(normalizeWorkspacePath(await fsRealpath(workspace)));
    const stored = await new OwnershipStore(ownershipDir).read(key);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.record.token_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.record.pid).toBe(started.value.pid);
    expect(stored.record.process_creation_time).not.toBeNull();
    expect(stored.record.state).toBe('running');
    expect(JSON.stringify(stored.record)).not.toContain(token);
    const rawFile = await readFile(new OwnershipStore(ownershipDir).fileFor(key), 'utf8');
    expect(rawFile).not.toContain(token);

    const second = await supervisor.start();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.runtimeId).toBe(started.value.runtimeId);

    const stopped = await supervisor.stop('test_done');
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(['stopped', 'stopped_forced']).toContain(stopped.value.outcome);
    expect(stopped.value.root_exited).toBe(true);
    expect(stopped.value.endpoint_closed).toBe(true);
    expect(stopped.value.rollback_claimed).toBe(false);
    await waitFor(() => !alive(started.value.pid), 5_000, 'runtime exit');
  }, 40_000);

  it('stops a real descendant spawned by the owned runtime', async () => {
    const workspace = await tempDir('descendants');
    const ownershipDir = await tempDir('descendants-own');
    const childPidFile = path.join(workspace, 'runtime-child.pid');
    const port = await findFreePort();
    const supervisor = new RuntimeSupervisor({
      executable: process.execPath,
      workspace,
      ownershipDir,
      port,
      token: '[redacted]',
      command: { executable: process.execPath, args: [fakeRuntime, '--port', String(port)] },
      env: { FAKE_RUNTIME_CHILD: '1', FAKE_CHILD_PID_FILE: childPidFile },
    });
    const started = await supervisor.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const descendantPid = await waitForPidFile(childPidFile);
    expect(alive(descendantPid)).toBe(true);
    const stopped = await supervisor.stop('test_done');
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.value.observed_descendants).toContain(descendantPid);
    await waitFor(() => !alive(descendantPid), 8_000, 'descendant cleanup');
  }, 40_000);

  it('never kills a stranger that already holds the requested port', async () => {
    const workspace = await tempDir('stranger');
    const ownershipDir = await tempDir('stranger-own');
    const port = await findFreePort();
    const token = 'stranger-token-0123456789';
    const stranger = spawn(process.execPath, [fakeRuntime, '--port', String(port)], {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, CODEWHALE_RUNTIME_TOKEN: token },
    });
    try {
      await waitFor(
        async () => {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            return response.ok;
          } catch {
            return false;
          }
        },
        10_000,
        'stranger readiness',
      );

      const events: SupervisorEvent[] = [];
      const supervisor = new RuntimeSupervisor({
        executable: process.execPath,
        workspace,
        ownershipDir,
        port,
        token,
        command: { executable: process.execPath, args: [fakeRuntime, '--port', String(port)] },
        onEvent: (event) => events.push(event),
      });
      const started = await supervisor.start();
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.error.code).toBe('port_occupied');
      expect(started.error.detail).toContain('did not start or stop');
      expect(events.some((event) => event.type === 'port_occupied')).toBe(true);
      expect(alive(stranger.pid as number)).toBe(true);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.ok).toBe(true);
    } finally {
      killQuietly(stranger);
    }
  }, 30_000);

  it('reports a missing executable as an actionable engine failure', async () => {
    const workspace = await tempDir('missing');
    const ownershipDir = await tempDir('missing-own');
    const supervisor = new RuntimeSupervisor({
      executable: path.join(workspace, 'does-not-exist.exe'),
      workspace,
      ownershipDir,
    });
    const started = await supervisor.start();
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe('engine_unavailable');
    expect(supervisor.status().state).toBe('failed');
  });

  it('classifies permission failures without inventing a runtime', () => {
    expect(classifySpawnFailure({ code: 'EACCES' }, 'x.exe').code).toBe('permission_denied');
    expect(classifySpawnFailure({ code: 'EPERM' }, 'x.exe').code).toBe('permission_denied');
    expect(classifySpawnFailure({ code: 'ENOENT' }, 'x.exe').code).toBe('engine_unavailable');
  });

  it('clears a stale pid record and starts a fresh runtime', async () => {
    const workspace = await tempDir('stale');
    const ownershipDir = await tempDir('stale-own');
    const realWorkspace = await fsRealpath(workspace);
    const key = workspaceKeyFor(normalizeWorkspacePath(realWorkspace));
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await new Promise((resolve) => dead.once('exit', resolve));
    const store = new OwnershipStore(ownershipDir);
    await store.write(
      record({
        workspace: normalizeWorkspacePath(realWorkspace),
        workspace_key: key,
        pid: dead.pid as number,
        process_creation_time: '2000-01-01T00:00:00.000Z',
      }),
    );

    const events: SupervisorEvent[] = [];
    const port = await findFreePort();
    const supervisor = new RuntimeSupervisor({
      executable: process.execPath,
      workspace,
      ownershipDir,
      port,
      token: 'stale-test-token-0123456789',
      command: { executable: process.execPath, args: [fakeRuntime, '--port', String(port)] },
      onEvent: (event) => events.push(event),
    });
    const started = await supervisor.start();
    expect(started.ok).toBe(true);
    expect(events.some((event) => event.type === 'stale_record')).toBe(true);
    await supervisor.stop('cleanup');
  }, 30_000);

  it('does not kill a live pid whose creation identity changed', async () => {
    const workspace = await tempDir('reuse');
    const ownershipDir = await tempDir('reuse-own');
    const key = workspaceKeyFor(normalizeWorkspacePath(await fsRealpath(workspace)));
    const store = new OwnershipStore(ownershipDir);
    await store.write(
      record({
        workspace: normalizeWorkspacePath(await fsRealpath(workspace)),
        workspace_key: key,
        pid: process.pid,
        process_creation_time: '2000-01-01T00:00:00.000Z',
        state: 'running',
      }),
    );
    const supervisor = new RuntimeSupervisor({
      executable: process.execPath,
      workspace,
      ownershipDir,
    });
    const report = await supervisor.reconcile();
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.stale.some((entry) => entry.reason === 'pid_reused_after_restart')).toBe(true);
    expect(alive(process.pid)).toBe(true);
    const stored = await store.read(key);
    expect(stored.ok && stored.record.state === 'stale').toBe(true);
  }, 20_000);

  it('restarts a crashed runtime a bounded number of times without submitting work', async () => {
    const workspace = await tempDir('restart');
    const ownershipDir = await tempDir('restart-own');
    const port = await findFreePort();
    const events: SupervisorEvent[] = [];
    const supervisor = new RuntimeSupervisor({
      executable: process.execPath,
      workspace,
      ownershipDir,
      port,
      token: 'restart-test-token-0123456789',
      command: { executable: process.execPath, args: [fakeRuntime, '--port', String(port)] },
      env: { FAKE_CRASH_MS: '2500' },
      restart: { maxRestarts: 2, baseDelayMs: 50, windowMs: 60_000 },
      onEvent: (event) => events.push(event),
    });
    const started = await supervisor.start();
    expect(started.ok).toBe(true);
    await waitFor(() => events.some((event) => event.type === 'restart_exhausted'), 25_000, 'restart exhaustion');
    expect(events.filter((event) => event.type === 'restarted').length).toBeLessThanOrEqual(2);
    expect(events.filter((event) => event.type === 'exited' && !event.expected).length).toBe(3);
    expect(events.some((event) => event.type === 'restart_scheduled')).toBe(true);
    expect(supervisor.status().state).toBe('failed');
    await supervisor.stop('test_cleanup');
  }, 40_000);

  it('fails the start when the runtime exits before it is usable', async () => {
    const workspace = await tempDir('dies');
    const ownershipDir = await tempDir('dies-own');
    const events: SupervisorEvent[] = [];
    const supervisor = new RuntimeSupervisor({
      executable: process.execPath,
      workspace,
      ownershipDir,
      token: '[redacted]',
      command: { executable: process.execPath, args: ['-e', 'process.exit(3)'] },
      startupTimeoutMs: 8_000,
      onEvent: (event) => events.push(event),
    });
    const started = await supervisor.start();
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe('engine_unavailable');
    expect(started.error.message).toContain('exited');
    expect(supervisor.status().state).toBe('failed');
    expect(events.some((event) => event.type === 'startup_failed')).toBe(true);
    expect(events.some((event) => event.type === 'ready')).toBe(false);
  }, 30_000);
});

describe('external runtime attachment', () => {
  it('attaches read-only and refuses to stop a runtime Mona did not start', async () => {
    const workspace = await tempDir('external');
    const port = await findFreePort();
    const token = 'external-token-0123456789';
    const external = spawn(process.execPath, [fakeRuntime, '--port', String(port)], {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, CODEWHALE_RUNTIME_TOKEN: token },
    });
    try {
      await waitFor(
        async () => {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            return response.ok;
          } catch {
            return false;
          }
        },
        10_000,
        'external readiness',
      );
      const attached = await attachExternalRuntime({ baseUrl: `http://127.0.0.1:${port}`, token, workspace });
      expect(attached.ok).toBe(true);
      if (!attached.ok) return;
      expect(attached.value.owned).toBe(false);
      const stop = await attached.value.stop();
      expect(stop.ok).toBe(false);
      if (!stop.ok) expect(stop.error.message).toContain('not owned');
      expect(alive(external.pid as number)).toBe(true);
    } finally {
      killQuietly(external);
    }
  }, 30_000);
});

async function fsRealpath(value: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return await realpath(value);
}
