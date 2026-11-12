import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { EffectiveProfile, EngineIdentity } from '@mona/contracts';
import { EngineAdapter, type SubmissionReceipt } from './adapter.js';
import { RuntimeInfoWire, assessCompatibility, type CompatibilityReport } from './compatibility.js';
import { fail, ok, redact, type AdapterFailure, type Result } from './errors.js';
import { HttpTransport } from './http.js';
import type { SubmissionJournal } from './journal.js';
import {
  OwnershipStore,
  emptyRecord,
  normalizeWorkspacePath,
  resolveWorkspace,
  tokenDigest,
  workspaceKeyFor,
  type RuntimeOwnershipRecord,
} from './ownership.js';
import { findFreePort, portOpen, systemProcessInspector, type ProcessInspector } from './process.js';

const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;

export const SupervisorState = z.enum([
  'idle',
  'starting',
  'running',
  'crashed',
  'restarting',
  'stopping',
  'stopped',
  'failed',
]);
export type SupervisorState = z.infer<typeof SupervisorState>;

export type SupervisorStatus = {
  state: SupervisorState;
  workspace: string | null;
  runtimeId: string | null;
  pid: number | null;
  endpoint: string | null;
  startedAt: string | null;
  restartCount: number;
  lastFailure: AdapterFailure | null;
  reason: string | null;
};

export type ShutdownReceipt = {
  runtime_id: string;
  requested_at: string;
  completed_at: string;
  reason: string;
  outcome: 'stopped' | 'stopped_forced' | 'already_stopped' | 'uncertain';
  root_exited: boolean;
  observed_descendants: number[];
  remaining_pids: number[];
  endpoint_closed: boolean;
  /** A stop is not rollback: external side effects and sent requests stand. */
  rollback_claimed: false;
  detail?: string;
};

export type SupervisorEvent =
  | { type: 'starting'; workspace: string; executable: string; at: string }
  | { type: 'ready'; runtimeId: string; pid: number; endpoint: string; at: string }
  | { type: 'startup_failed'; failure: AdapterFailure; at: string }
  | {
      type: 'exited';
      runtimeId: string;
      code: number | null;
      signal: NodeJS.Signals | null;
      expected: boolean;
      at: string;
    }
  | { type: 'restart_scheduled'; attempt: number; delayMs: number; at: string }
  | { type: 'restart_exhausted'; attempts: number; at: string }
  | { type: 'restarted'; runtimeId: string; pid: number; endpoint: string; at: string }
  | { type: 'stop_requested'; runtimeId: string; reason: string; at: string }
  | { type: 'stopped'; receipt: ShutdownReceipt; at: string }
  | { type: 'stale_record'; workspace: string; reason: string; at: string }
  | { type: 'reclaimed_previous_owner'; runtimeId: string; pid: number; at: string }
  | { type: 'port_occupied'; port: number; occupant: 'codewhale' | 'other'; at: string };

export type SupervisedRuntime = {
  runtimeId: string;
  pid: number;
  workspace: string;
  endpoint: string;
  /** Kept in process memory only; never written to the ownership record or logs. */
  token: string;
  identity: EngineIdentity;
  report: CompatibilityReport;
  record: RuntimeOwnershipRecord;
  owned: true;
  createAdapter: (journal: SubmissionJournal) => EngineAdapter;
  alive: () => Promise<boolean>;
};

export type ExternalRuntime = {
  baseUrl: string;
  identity: EngineIdentity;
  report: CompatibilityReport;
  owned: false;
  createAdapter: (journal: SubmissionJournal) => EngineAdapter;
  stop: () => Promise<Result<never>>;
};

export type RuntimeSupervisorOptions = {
  executable: string;
  workspace: string;
  ownershipDir: string;
  /** Omit or pass 0 to allocate a free loopback port. */
  port?: number;
  token?: string;
  startupTimeoutMs?: number;
  healthPollMs?: number;
  desktopInstanceId?: string;
  parentPid?: number | null;
  command?: { executable: string; args: string[] };
  /** Test-only extra environment; the runtime token is always applied last. */
  env?: NodeJS.ProcessEnv;
  inspector?: ProcessInspector;
  restart?: { maxRestarts?: number; windowMs?: number; baseDelayMs?: number };
  now?: () => Date;
  onEvent?: (event: SupervisorEvent) => void;
  fetchImpl?: typeof fetch;
};

export type ReconcileReport = {
  inspected: number;
  stale: Array<{ workspace: string; pid: number; reason: string }>;
  reclaimed: Array<{ workspace: string; pid: number }>;
  unverifiable: Array<{ workspace: string; pid: number; reason: string }>;
  invalid_records: string[];
};

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_POLL_MS = 150;

function newRuntimeId(): string {
  return `rt_${randomBytes(12).toString('hex')}`;
}

function newDesktopInstanceId(): string {
  return `dsk_${randomBytes(12).toString('hex')}`;
}

export function classifySpawnFailure(error: unknown, executable: string): AdapterFailure {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return {
      code: 'engine_unavailable',
      message: 'Codewhale executable was not found',
      retryable: false,
      detail: executable,
    };
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return {
      code: 'permission_denied',
      message: 'The operating system denied permission to start Codewhale',
      retryable: false,
      detail: `${executable}: ${code}`,
    };
  }
  return {
    code: 'engine_unavailable',
    message: 'Codewhale could not be started',
    retryable: false,
    detail: String(error).slice(0, 500),
  };
}

async function probeOccupant(port: number, fetchImpl: typeof fetch): Promise<'free' | 'codewhale' | 'other'> {
  if (!(await portOpen(port))) return 'free';
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_200),
    });
    const body = (await response.json()) as { service?: unknown };
    if (body.service === 'codewhale-runtime-api') return 'codewhale';
  } catch {
    /* a listener that is not a runtime */
  }
  return 'other';
}

export class RuntimeSupervisor {
  private readonly options: RuntimeSupervisorOptions;
  private readonly store: OwnershipStore;
  private readonly inspector: ProcessInspector;
  private readonly fetchImpl: typeof fetch;
  private readonly desktopInstanceId: string;
  private readonly now: () => Date;
  private readonly restartTimes: number[] = [];
  private runtime: SupervisedRuntime | null = null;
  private child: ChildProcess | null = null;
  private childExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private startPromise: Promise<Result<SupervisedRuntime>> | null = null;
  private stopPromise: Promise<Result<ShutdownReceipt>> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private state: SupervisorState = 'idle';
  private lastFailure: AdapterFailure | null = null;
  private reason: string | null = null;
  private startedAt: string | null = null;
  private restartCount = 0;
  private workspace: string | null = null;
  private endpoint: string | null = null;

  constructor(options: RuntimeSupervisorOptions) {
    this.options = options;
    this.store = new OwnershipStore(options.ownershipDir);
    this.inspector = options.inspector ?? systemProcessInspector;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.desktopInstanceId = options.desktopInstanceId ?? newDesktopInstanceId();
    this.now = options.now ?? (() => new Date());
  }

  status(): SupervisorStatus {
    return {
      state: this.state,
      workspace: this.workspace,
      runtimeId: this.runtime?.runtimeId ?? null,
      pid: this.runtime?.pid ?? this.child?.pid ?? null,
      endpoint: this.endpoint,
      startedAt: this.startedAt,
      restartCount: this.restartCount,
      lastFailure: this.lastFailure,
      reason: this.reason,
    };
  }

  existing(): SupervisedRuntime | null {
    return this.runtime;
  }

  private emit(event: SupervisorEvent): void {
    this.options.onEvent?.(event);
  }

  async start(): Promise<Result<SupervisedRuntime>> {
    if (this.runtime && this.state === 'running') return ok(this.runtime);
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.startInternal();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startInternal(): Promise<Result<SupervisedRuntime>> {
    this.stopping = false;
    this.childExit = null;
    this.lastFailure = null;
    this.reason = null;
    this.state = 'starting';

    const workspace = await resolveWorkspace(this.options.workspace);
    if (workspace === null) {
      return this.fail('invalid_request', 'workspace directory does not exist or is not a directory');
    }
    this.workspace = workspace;
    this.emit({ type: 'starting', workspace, executable: this.options.executable, at: this.now().toISOString() });

    let executableRealPath: string;
    let executableSize: number;
    let executableMtimeMs: number;
    try {
      executableRealPath = await realpath(this.options.executable);
      const info = await stat(executableRealPath);
      if (!info.isFile()) return this.fail('engine_unavailable', 'Codewhale executable path is not a file');
      executableSize = info.size;
      executableMtimeMs = info.mtimeMs;
    } catch (error) {
      const failure = classifySpawnFailure(error, this.options.executable);
      this.lastFailure = failure;
      this.state = 'failed';
      this.emit({ type: 'startup_failed', failure, at: this.now().toISOString() });
      return { ok: false, error: failure };
    }
    // A symlinked WinGet shim reports zero size; keep the resolved target size
    // but never treat the link's metadata as executable identity.
    const executable = normalizeWorkspacePath(this.options.executable);
    const workspaceKey = workspaceKeyFor(workspace);

    const previous = await this.store.read(workspaceKey);
    if (previous.ok && previous.record.state === 'running') {
      const reclaimed = await this.reclaimIfStale(previous.record);
      if (!reclaimed.ok) return reclaimed;
    } else if (previous.ok) {
      this.emit({
        type: 'stale_record',
        workspace: previous.record.workspace,
        reason: `superseded_${previous.record.state}`,
        at: this.now().toISOString(),
      });
    }

    let port = this.options.port ?? 0;
    if (port > 0) {
      const occupant = await probeOccupant(port, this.fetchImpl);
      if (occupant !== 'free') {
        this.state = 'failed';
        this.emit({ type: 'port_occupied', port, occupant, at: this.now().toISOString() });
        return this.fail(
          'port_occupied',
          `loopback port ${port} is already in use by ${
            occupant === 'codewhale' ? 'another Codewhale runtime' : 'another process'
          }`,
          {
            detail:
              occupant === 'codewhale'
                ? 'Mona did not start or stop that runtime. Choose another port or close the external runtime.'
                : 'Choose another port; Mona will not kill a process it did not start.',
          },
        );
      }
    } else {
      try {
        port = await findFreePort();
      } catch (error) {
        return this.fail('engine_unavailable', 'no loopback port could be allocated', {
          detail: String(error).slice(0, 300),
        });
      }
    }

    const token =
      typeof this.options.token === 'string' && this.options.token.length >= 8
        ? this.options.token
        : randomBytes(32).toString('base64url');
    if (this.options.token !== undefined && token !== this.options.token) {
      return this.fail('invalid_request', 'runtime token must be at least 8 characters');
    }

    const command = this.options.command ?? {
      executable: this.options.executable,
      args: ['app-server', '--http', '--host', '127.0.0.1', '--port', String(port)],
    };
    // Mechanism, not discipline: the token must never be representable on a
    // command line, where the process list exposes it.
    if (token.length >= 8 && command.args.some((arg) => arg.includes(token))) {
      return this.fail('invalid_request', 'runtime token must not appear in process arguments');
    }

    let child: ChildProcess;
    try {
      child = spawn(command.executable, command.args, {
        cwd: workspace,
        env: { ...process.env, ...this.options.env, CODEWHALE_RUNTIME_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      const failure = classifySpawnFailure(error, command.executable);
      this.lastFailure = failure;
      this.state = 'failed';
      this.emit({ type: 'startup_failed', failure, at: this.now().toISOString() });
      return { ok: false, error: failure };
    }
    this.child = child;
    const spawned = await new Promise<Result<null>>((resolve) => {
      child.once('spawn', () => resolve(ok(null)));
      child.once('error', (error) => resolve({ ok: false, error: classifySpawnFailure(error, command.executable) }));
    });
    if (!spawned.ok) {
      this.lastFailure = spawned.error;
      this.state = 'failed';
      this.emit({ type: 'startup_failed', failure: spawned.error, at: this.now().toISOString() });
      return spawned;
    }

    let stderr = '';
    child.stdout?.resume();
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8_000);
    });
    child.once('exit', (code, signal) => {
      this.childExit = { code, signal };
      this.handleExit(child, code, signal);
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const startedAt = this.now().toISOString();
    const ready = await this.waitForReadiness(child, baseUrl, () => stderr, token);
    if (!ready.ok) {
      await this.terminateStartupFailure(child);
      this.lastFailure = ready.error;
      this.state = 'failed';
      this.emit({ type: 'startup_failed', failure: ready.error, at: this.now().toISOString() });
      return ready;
    }

    const pid = child.pid;
    if (!pid) {
      await this.terminateStartupFailure(child);
      const failure: AdapterFailure = {
        code: 'engine_unavailable',
        message: 'runtime started without a process id',
        retryable: false,
      };
      this.lastFailure = failure;
      this.state = 'failed';
      return { ok: false, error: failure };
    }

    const infoResult = await this.readRuntimeInfo(baseUrl, token);
    if (!infoResult.ok) {
      await this.terminateStartupFailure(child);
      this.lastFailure = infoResult.error;
      this.state = 'failed';
      this.emit({ type: 'startup_failed', failure: infoResult.error, at: this.now().toISOString() });
      return infoResult;
    }
    // A runtime that answers readiness and then exits before Mona records it is
    // a startup failure, not a running runtime with a stale pid.
    const exit = this.observedExit();
    const diedDuringStartup = exit !== null || !(await this.inspector.probe(child.pid as number)).alive;
    if (diedDuringStartup) {
      const failure: AdapterFailure = {
        code: 'engine_unavailable',
        message: 'runtime exited during startup after reporting readiness',
        retryable: true,
        detail: `exit code ${exit?.code ?? 'unknown'}${
          exit?.signal ? ` signal ${exit.signal}` : ''
        }; no work was submitted`,
      };
      this.lastFailure = failure;
      this.state = 'failed';
      this.emit({ type: 'startup_failed', failure, at: this.now().toISOString() });
      return { ok: false, error: failure };
    }
    const info = infoResult.value.raw;
    const identityPort = typeof info.port === 'number' ? info.port : port;
    if (identityPort !== port) {
      await this.terminateStartupFailure(child);
      const failure: AdapterFailure = {
        code: 'identity_mismatch',
        message: 'the process listening on the port does not match the runtime Mona started',
        retryable: false,
        detail: `expected port ${port}, runtime reported ${identityPort}`,
      };
      this.lastFailure = failure;
      this.state = 'failed';
      return { ok: false, error: failure };
    }

    const probe = await this.inspector.probe(pid);
    const runtimeId = newRuntimeId();
    const version = info.codewhale_version;
    const commit = info.codewhale_commit;
    const record = emptyRecord({
      runtimeId,
      workspace,
      workspaceKey,
      executable,
      executableRealPath,
      executableSize,
      executableMtimeMs,
      version,
      commit,
      pid,
      processCreationTime: probe.creationTime,
      parentPid: this.options.parentPid ?? process.pid,
      desktopInstanceId: this.desktopInstanceId,
      endpoint: baseUrl,
      token,
      startedAt,
      state: 'running',
    });
    await this.store.write(record);

    const transport = new HttpTransport({ baseUrl, token });
    const runtime: SupervisedRuntime = {
      runtimeId,
      pid,
      workspace,
      endpoint: baseUrl,
      token,
      identity: infoResult.value.discovery.identity,
      report: infoResult.value.discovery.report,
      record,
      owned: true,
      createAdapter: (journal: SubmissionJournal) =>
        new EngineAdapter({
          transport,
          journal,
          context: { baseUrl, pid, workspace, startedAt },
        }),
      alive: async () => {
        if (!(await this.inspector.probe(pid)).alive) return false;
        return !(await this.childExit);
      },
    };

    this.runtime = runtime;
    this.endpoint = baseUrl;
    this.startedAt = startedAt;
    this.state = 'running';
    // Final race check: a runtime that died between the readiness probe and this
    // assignment must not be reported ready. The exit handler deliberately does
    // nothing when no runtime has been recorded yet, so this closes the window.
    const lateExit = this.observedExit();
    if (lateExit !== null) {
      const failure: AdapterFailure = {
        code: 'engine_unavailable',
        message: 'runtime exited while Mona was recording ownership',
        retryable: true,
        detail: `exit code ${lateExit.code ?? 'unknown'}${
          lateExit.signal ? ` signal ${lateExit.signal}` : ''
        }; no work was submitted`,
      };
      this.runtime = null;
      this.child = null;
      this.endpoint = null;
      this.startedAt = null;
      this.lastFailure = failure;
      this.state = 'failed';
      await this.markRecord(record, 'crashed', 'exited_during_startup');
      this.emit({ type: 'startup_failed', failure, at: this.now().toISOString() });
      return { ok: false, error: failure };
    }
    this.emit({ type: 'ready', runtimeId, pid, endpoint: baseUrl, at: this.now().toISOString() });
    return ok(runtime);
  }

  private async waitForReadiness(
    child: ChildProcess,
    baseUrl: string,
    stderr: () => string,
    token: string,
  ): Promise<Result<null>> {
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    const pollMs = this.options.healthPollMs ?? DEFAULT_HEALTH_POLL_MS;
    while (Date.now() < deadline) {
      if (this.childExit !== null) {
        return {
          ok: false,
          error: {
            code: 'engine_unavailable',
            message: 'runtime exited before becoming ready',
            retryable: true,
            detail: redact(stderr(), [token]).slice(-800) || `exit code ${this.childExit.code ?? 'unknown'}`,
          },
        };
      }
      try {
        const response = await this.fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) {
          const body = (await response.json()) as { service?: unknown };
          if (body.service === 'codewhale-runtime-api') {
            return ok(null);
          }
        }
      } catch {
        /* not listening yet */
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (!child.pid)
      return { ok: false, error: { code: 'engine_unavailable', message: 'runtime has no pid', retryable: false } };
    return {
      ok: false,
      error: {
        code: 'engine_unavailable',
        message: 'runtime did not become ready before the startup deadline',
        retryable: true,
        detail: redact(stderr(), [token]).slice(-800) || undefined,
      },
    };
  }

  private async readRuntimeInfo(
    baseUrl: string,
    token: string,
  ): Promise<
    Result<{
      raw: z.infer<typeof RuntimeInfoWire>;
      discovery: { identity: EngineIdentity; report: CompatibilityReport };
    }>
  > {
    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}/v1/runtime/info`, {
        signal: AbortSignal.timeout(5_000),
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      return this.fail('engine_unavailable', 'runtime identity could not be read', {
        detail: String(error).slice(0, 300),
      });
    }
    if (!response.ok) {
      return this.fail('engine_unavailable', 'runtime identity endpoint refused the request', {
        detail: `HTTP ${response.status}`,
      });
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return this.fail('schema_drift', 'runtime identity was not JSON');
    }
    const parsed = RuntimeInfoWire.safeParse(raw);
    if (!parsed.success) {
      return this.fail('schema_drift', 'runtime identity did not match the expected contract', {
        detail: parsed.error.issues
          .map((issue) => issue.message)
          .join('; ')
          .slice(0, 500),
      });
    }
    const info = parsed.data;
    if (info.auth_required === false) {
      return this.fail('identity_mismatch', 'runtime reports that authentication is disabled', {
        detail: 'Mona never drives an unauthenticated runtime',
      });
    }
    if (info.bind_host !== undefined && !/^(127\.0\.0\.1|localhost)$/.test(info.bind_host)) {
      return this.fail('identity_mismatch', 'runtime is not bound to loopback', {
        detail: `bind_host=${info.bind_host}`,
      });
    }
    // Authentication is proven on a stateful route, not on discovery metadata.
    try {
      const authCheck = await this.fetchImpl(`${baseUrl}/v1/providers`, {
        signal: AbortSignal.timeout(5_000),
        headers: { Authorization: `Bearer ${token}` },
      });
      if (authCheck.status === 401 || authCheck.status === 403) {
        return this.fail('authentication_failed', 'runtime rejected the ownership token', {
          detail: `HTTP ${authCheck.status}`,
        });
      }
    } catch (error) {
      return this.fail('transport_failed', 'authenticated runtime check failed', {
        detail: String(error).slice(0, 300),
      });
    }
    const discovery = assessCompatibility(raw, {
      baseUrl,
      pid: this.child?.pid ?? null,
      workspace: this.workspace,
      startedAt: this.now().toISOString(),
    });
    if (!discovery.ok) return discovery;
    if (discovery.value.report.status === 'unsupported') {
      return this.fail('capability_unsupported', 'runtime version is not supported by this adapter', {
        detail: discovery.value.report.reasons.join('; '),
      });
    }
    return ok({ raw: info, discovery: discovery.value });
  }

  private async terminateStartupFailure(child: ChildProcess): Promise<void> {
    const pid = child.pid;
    if (!pid) return;
    if (await this.inspector.probe(pid).then((probe) => probe.alive)) {
      await this.inspector.terminateTree(pid, { graceMs: 500, forceAfterMs: 5_000 });
    }
  }

  /**
   * The record says Mona owns a live runtime. If the pid and creation time
   * match, it is ours to reclaim (previous desktop instance). If the pid was
   * reused, it is a stranger and must never be killed.
   */
  private async reclaimIfStale(record: RuntimeOwnershipRecord): Promise<Result<null>> {
    const probe = await this.inspector.probe(record.pid);
    if (!probe.alive) {
      await this.markRecord(record, 'stale', 'stale_pid');
      this.emit({
        type: 'stale_record',
        workspace: record.workspace,
        reason: 'stale_pid',
        at: this.now().toISOString(),
      });
      return ok(null);
    }
    if (record.process_creation_time === null || probe.creationTime === null) {
      this.state = 'failed';
      return this.fail('stale_ownership', 'a live process holds this workspace but its identity cannot be verified', {
        detail: `pid ${record.pid}; Mona will not terminate a process it cannot identify. Stop it manually if it is a stale Mona runtime.`,
      });
    }
    if (record.process_creation_time !== probe.creationTime) {
      await this.markRecord(record, 'stale', 'pid_reused');
      this.emit({
        type: 'stale_record',
        workspace: record.workspace,
        reason: 'pid_reused',
        at: this.now().toISOString(),
      });
      return ok(null);
    }
    if (record.desktop_instance_id === this.desktopInstanceId) {
      // Same desktop instance with no in-memory handle (should not happen in a
      // healthy app). Reclaim rather than run a second runtime in one workspace.
      await this.inspector.terminateTree(record.pid, { graceMs: 1_500, forceAfterMs: 8_000 });
      await this.markRecord(record, 'stale', 'same_instance_orphan');
      this.emit({
        type: 'reclaimed_previous_owner',
        runtimeId: record.runtime_id,
        pid: record.pid,
        at: this.now().toISOString(),
      });
      return ok(null);
    }
    await this.inspector.terminateTree(record.pid, { graceMs: 1_500, forceAfterMs: 8_000 });
    await this.markRecord(record, 'stale', 'previous_desktop_instance_stopped');
    this.emit({
      type: 'reclaimed_previous_owner',
      runtimeId: record.runtime_id,
      pid: record.pid,
      at: this.now().toISOString(),
    });
    return ok(null);
  }

  private async markRecord(
    record: RuntimeOwnershipRecord,
    state: RuntimeOwnershipRecord['state'],
    reason: string,
  ): Promise<void> {
    try {
      await this.store.write({
        ...record,
        state,
        reason: reason.slice(0, 500),
        updated_at: this.now().toISOString(),
      });
    } catch {
      /* a stale record that cannot be rewritten remains visibly stale */
    }
  }

  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    const runtime = this.runtime;
    if (!runtime || this.child !== child) return;
    const expected = this.stopping || this.state === 'stopping' || this.state === 'stopped';
    this.emit({
      type: 'exited',
      runtimeId: runtime.runtimeId,
      code,
      signal,
      expected,
      at: this.now().toISOString(),
    });
    void this.markRecord(
      runtime.record,
      expected ? 'stopped' : 'crashed',
      expected ? 'requested_stop' : 'runtime_exited',
    );
    if (expected) {
      this.state = 'stopped';
      return;
    }
    this.runtime = null;
    this.child = null;
    this.endpoint = null;
    this.state = 'crashed';
    this.lastFailure = {
      code: 'engine_unavailable',
      message: 'the owned runtime exited unexpectedly',
      retryable: true,
      detail: `exit code ${code ?? 'unknown'}${signal ? ` signal ${signal}` : ''}`,
    };
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopping) return;
    const maxRestarts = this.options.restart?.maxRestarts ?? 0;
    if (maxRestarts <= 0) return;
    const windowMs = this.options.restart?.windowMs ?? 300_000;
    const cutoff = Date.now() - windowMs;
    while (this.restartTimes.length > 0 && (this.restartTimes[0] as number) < cutoff) this.restartTimes.shift();
    if (this.restartTimes.length >= maxRestarts) {
      this.state = 'failed';
      this.emit({ type: 'restart_exhausted', attempts: this.restartTimes.length, at: this.now().toISOString() });
      return;
    }
    const attempt = this.restartTimes.length + 1;
    const baseDelay = this.options.restart?.baseDelayMs ?? 1_000;
    const delayMs = Math.min(baseDelay * 2 ** (attempt - 1), 30_000);
    this.restartTimes.push(Date.now());
    this.state = 'restarting';
    this.emit({ type: 'restart_scheduled', attempt, delayMs, at: this.now().toISOString() });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start().then((result) => {
        if (result.ok) {
          this.restartCount += 1;
          this.emit({
            type: 'restarted',
            runtimeId: result.value.runtimeId,
            pid: result.value.pid,
            endpoint: result.value.endpoint,
            at: this.now().toISOString(),
          });
        } else {
          this.lastFailure = result.error;
          this.state = 'failed';
          this.emit({ type: 'startup_failed', failure: result.error, at: this.now().toISOString() });
        }
      });
    }, delayMs);
    this.restartTimer.unref?.();
  }

  async stop(reason = 'requested'): Promise<Result<ShutdownReceipt>> {
    if (this.stopPromise) return await this.stopPromise;
    this.stopPromise = this.stopInternal(reason);
    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private async stopInternal(reason: string): Promise<Result<ShutdownReceipt>> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.state === 'starting' && this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        /* startup failure cleaned its own child */
      }
    }
    const runtime = this.runtime;
    if (!runtime) {
      this.state = 'stopped';
      const now = this.now().toISOString();
      const receipt: ShutdownReceipt = {
        runtime_id: 'rt_none',
        requested_at: now,
        completed_at: now,
        reason,
        outcome: 'already_stopped',
        root_exited: true,
        observed_descendants: [],
        remaining_pids: [],
        endpoint_closed: this.endpoint === null || !(await portOpen(this.portFromEndpoint())),
        rollback_claimed: false,
      };
      return ok(receipt);
    }
    const requestedAt = this.now().toISOString();
    this.state = 'stopping';
    this.emit({ type: 'stop_requested', runtimeId: runtime.runtimeId, reason, at: requestedAt });
    const termination = await this.inspector.terminateTree(runtime.pid, { graceMs: 2_000, forceAfterMs: 8_000 });
    let endpointClosed = false;
    const port = this.portFromEndpoint();
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (!(await portOpen(port))) {
        endpointClosed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const outcome: ShutdownReceipt['outcome'] =
      termination.remainingPids.length > 0
        ? 'uncertain'
        : termination.outcome === 'already_stopped'
          ? 'already_stopped'
          : termination.outcome === 'stopped_forced'
            ? 'stopped_forced'
            : 'stopped';
    const receipt: ShutdownReceipt = {
      runtime_id: runtime.runtimeId,
      requested_at: requestedAt,
      completed_at: this.now().toISOString(),
      reason,
      outcome: outcome === 'uncertain' && !termination.rootExited ? 'uncertain' : outcome,
      root_exited: termination.rootExited,
      observed_descendants: termination.observedDescendants,
      remaining_pids: termination.remainingPids,
      endpoint_closed: endpointClosed,
      rollback_claimed: false,
      ...(termination.remainingPids.length > 0
        ? {
            detail: `still alive after bounded termination: ${termination.remainingPids.join(', ')}; work already sent is not rolled back`,
          }
        : endpointClosed
          ? {}
          : { detail: 'process exited but the loopback endpoint still answers; another process may hold the port' }),
    };
    await this.markRecord(runtime.record, 'stopped', `stop_${outcome}`);
    if (receipt.outcome === 'uncertain') {
      this.lastFailure = {
        code: 'outcome_unknown',
        message: 'owned runtime did not fully stop',
        retryable: true,
        detail: receipt.detail,
      };
    }
    this.runtime = null;
    this.child = null;
    this.endpoint = null;
    this.state = 'stopped';
    this.emit({ type: 'stopped', receipt, at: receipt.completed_at });
    return ok(receipt);
  }

  private portFromEndpoint(): number {
    const endpoint = this.endpoint ?? this.runtime?.endpoint ?? 'http://127.0.0.1:0';
    const match = LOOPBACK_URL.exec(endpoint);
    return match?.[1] ? Number(match[1]) : 0;
  }

  async reconcile(): Promise<Result<ReconcileReport>> {
    const { records, invalid } = await this.store.list();
    const report: ReconcileReport = {
      inspected: records.length,
      stale: [],
      reclaimed: [],
      unverifiable: [],
      invalid_records: invalid,
    };
    for (const record of records) {
      if (this.runtime && record.runtime_id === this.runtime.runtimeId) continue;
      const probe = await this.inspector.probe(record.pid);
      if (!probe.alive) {
        await this.markRecord(record, 'stale', 'stale_pid_after_restart');
        report.stale.push({ workspace: record.workspace, pid: record.pid, reason: 'stale_pid_after_restart' });
        this.emit({
          type: 'stale_record',
          workspace: record.workspace,
          reason: 'stale_pid_after_restart',
          at: this.now().toISOString(),
        });
        continue;
      }
      if (record.process_creation_time === null || probe.creationTime === null) {
        report.unverifiable.push({
          workspace: record.workspace,
          pid: record.pid,
          reason: 'live pid without verifiable creation identity',
        });
        continue;
      }
      if (record.process_creation_time !== probe.creationTime) {
        await this.markRecord(record, 'stale', 'pid_reused_after_restart');
        report.stale.push({ workspace: record.workspace, pid: record.pid, reason: 'pid_reused_after_restart' });
        this.emit({
          type: 'stale_record',
          workspace: record.workspace,
          reason: 'pid_reused_after_restart',
          at: this.now().toISOString(),
        });
        continue;
      }
      if (record.desktop_instance_id === this.desktopInstanceId) continue;
      const termination = await this.inspector.terminateTree(record.pid, { graceMs: 1_500, forceAfterMs: 8_000 });
      await this.markRecord(
        record,
        'stale',
        termination.remainingPids.length === 0 ? 'reclaimed_after_desktop_exit' : 'reclaim_uncertain',
      );
      report.reclaimed.push({ workspace: record.workspace, pid: record.pid });
      this.emit({
        type: 'reclaimed_previous_owner',
        runtimeId: record.runtime_id,
        pid: record.pid,
        at: this.now().toISOString(),
      });
    }
    return ok(report);
  }

  private fail(
    code: AdapterFailure['code'],
    message: string,
    options: { retryable?: boolean; detail?: string } = {},
  ): Result<never> {
    this.state = 'failed';
    const failure: AdapterFailure = {
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.detail ? { detail: options.detail } : {}),
    };
    this.lastFailure = failure;
    return { ok: false, error: failure };
  }

  /** Exposed for tests: the current process id, if any. */
  childPid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Exposed for tests: whether an exit has been observed. */
  hasExited(): boolean {
    return this.observedExit() !== null;
  }

  /** Flow analysis narrows the field itself; read it through one accessor. */
  private observedExit(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.childExit;
  }

  /** Exposed for tests and diagnostics: token digest only, never the token. */
  tokenDigest(): string | null {
    return this.runtime ? tokenDigest(this.runtime.token) : null;
  }
}

/**
 * Attach to a Codewhale runtime the user started. This is read-only by
 * construction: there is no stop path and no ownership record.
 */
export async function attachExternalRuntime(input: {
  baseUrl: string;
  token: string;
  workspace?: string;
  fetchImpl?: typeof fetch;
}): Promise<Result<ExternalRuntime>> {
  if (!LOOPBACK_URL.test(input.baseUrl)) {
    return fail('invalid_request', 'external runtime must be a loopback HTTP URL');
  }
  if (typeof input.token !== 'string' || input.token.length < 8) {
    return fail('invalid_request', 'external runtime token is required');
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  let raw: unknown;
  try {
    const response = await fetchImpl(`${input.baseUrl}/v1/runtime/info`, {
      signal: AbortSignal.timeout(5_000),
      headers: { Authorization: `Bearer ${input.token}` },
    });
    if (!response.ok) {
      return fail('engine_unavailable', 'external runtime did not answer its identity endpoint', {
        detail: `HTTP ${response.status}`,
      });
    }
    raw = await response.json();
  } catch (error) {
    return fail('engine_unavailable', 'external runtime is not reachable', {
      detail: String(error).slice(0, 300),
    });
  }
  const parsed = RuntimeInfoWire.safeParse(raw);
  if (!parsed.success) return fail('schema_drift', 'external runtime identity did not match the expected contract');
  if (parsed.data.auth_required === false) {
    return fail('identity_mismatch', 'external runtime is unauthenticated; Mona will not drive it');
  }
  const discovery = assessCompatibility(raw, {
    baseUrl: input.baseUrl,
    pid: null,
    workspace: input.workspace ?? null,
    startedAt: new Date().toISOString(),
  });
  if (!discovery.ok) return discovery;
  if (discovery.value.report.status === 'unsupported') {
    return fail('capability_unsupported', 'external runtime version is not supported', {
      detail: discovery.value.report.reasons.join('; '),
    });
  }
  const transport = new HttpTransport({ baseUrl: input.baseUrl, token: input.token });
  return ok({
    baseUrl: input.baseUrl,
    identity: discovery.value.identity,
    report: discovery.value.report,
    owned: false,
    createAdapter: (journal: SubmissionJournal) =>
      new EngineAdapter({
        transport,
        journal,
        context: {
          baseUrl: input.baseUrl,
          pid: null,
          workspace: input.workspace ?? null,
          startedAt: new Date().toISOString(),
        },
      }),
    stop: async () => fail('invalid_request', 'external runtimes are not owned by Mona; this runtime was left running'),
  });
}

/**
 * P03-compatible one-shot helper. It now uses the real supervisor: identity
 * verification, authenticated readiness, bounded stop, and no name-based kills.
 */
export type RuntimeStartInput = {
  executable: string;
  workspace: string;
  port: number;
  token: string;
  startupTimeoutMs?: number;
  ownershipDir?: string;
};

export type OwnedRuntime = {
  runtimeId: string;
  pid: number;
  baseUrl: string;
  workspace: string;
  identity: EngineIdentity;
  report: CompatibilityReport;
  createAdapter: (journal: SubmissionJournal) => EngineAdapter;
  stop: () => Promise<Result<{ runtimeId: string; exitCode: number | null; stoppedAt: string }>>;
};

export async function startOwnedRuntime(input: RuntimeStartInput): Promise<Result<OwnedRuntime>> {
  const supervisor = new RuntimeSupervisor({
    executable: input.executable,
    workspace: input.workspace,
    ownershipDir: input.ownershipDir ?? path.join(tmpdir(), 'mona-runtime-ownership'),
    port: input.port,
    token: input.token,
    ...(input.startupTimeoutMs !== undefined ? { startupTimeoutMs: input.startupTimeoutMs } : {}),
  });
  const started = await supervisor.start();
  if (!started.ok) return started;
  const runtime = started.value;
  return ok({
    runtimeId: runtime.runtimeId,
    pid: runtime.pid,
    baseUrl: runtime.endpoint,
    workspace: runtime.workspace,
    identity: runtime.identity,
    report: runtime.report,
    createAdapter: runtime.createAdapter,
    stop: async () => {
      const stopped = await supervisor.stop('caller_requested');
      if (!stopped.ok) return stopped;
      return ok({
        runtimeId: runtime.runtimeId,
        exitCode: null,
        stoppedAt: stopped.value.completed_at,
      });
    },
  });
}

/** Submission receipts are re-exported so supervisor consumers do not import adapter internals. */
export type { SubmissionReceipt, EffectiveProfile };
