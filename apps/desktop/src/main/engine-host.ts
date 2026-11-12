import path from 'node:path';
import {
  RuntimeSupervisor,
  attachExternalRuntime,
  decideLifecycle,
  type ExternalRuntime,
  type InterruptReceipt,
  type LifecycleAction,
  type LifecycleSignal,
  type Result,
  type RuntimeSupervisorOptions,
  type ShutdownReceipt,
  type SubmissionJournal,
  type SupervisorEvent,
  type SupervisorStatus,
  type WorkQueue,
} from '@mona/adapter';
import type { ErrorResult, ThreadId, TurnId } from '@mona/contracts';

/**
 * The desktop's single owner of runtime processes. Electron entry points report
 * lifecycle signals here; this module makes the decision and executes it. It
 * never starts a runtime just because the app launched: idle Mona causes zero
 * provider requests and zero child processes.
 */
export type EngineState = 'not_started' | 'starting' | 'connected' | 'failed' | 'stopping' | 'stopped' | 'crashed';

export type EngineSummary = {
  state: EngineState;
  detail: string;
  workspace: string | null;
  pid: number | null;
  endpoint: string | null;
  compatibility: 'qualified' | 'compatible_unqualified' | 'unsupported' | null;
  descriptors: string[];
};

export type EngineHostDeps = {
  /** Directory for machine-local ownership records; must not be a project path. */
  ownershipDir: string;
  executable: string;
  parentPid?: number | null;
  supervisorFactory?: (options: RuntimeSupervisorOptions) => RuntimeSupervisor;
  attachExternal?: typeof attachExternalRuntime;
  onEvent?: (event: SupervisorEvent) => void;
};

export type StartRuntimeInput = {
  workspace: string;
  port?: number;
  token?: string;
  startupTimeoutMs?: number;
};

export class EngineHost {
  private readonly deps: EngineHostDeps;
  private supervisor: RuntimeSupervisor | null = null;
  private external: ExternalRuntime | null = null;
  private queue: WorkQueue | null = null;
  private state: EngineState = 'not_started';
  private detail = 'No runtime is running. Mona starts one only for a project you open.';
  private quitReceipt: ShutdownReceipt | null = null;
  private journal: SubmissionJournal | null = null;
  private lastOutcomeUnknown = false;

  constructor(deps: EngineHostDeps) {
    this.deps = deps;
  }

  bindQueue(queue: WorkQueue): void {
    this.queue = queue;
  }

  summary(): EngineSummary {
    const runtime = this.supervisor?.existing() ?? null;
    return {
      state: this.state,
      detail: this.detail,
      workspace: runtime?.workspace ?? this.external?.identity.workspace ?? null,
      pid: runtime?.pid ?? null,
      endpoint: runtime?.endpoint ?? this.external?.baseUrl ?? null,
      compatibility: runtime?.report.status ?? this.external?.report.status ?? null,
      descriptors: this.descriptors(),
    };
  }

  private descriptors(): string[] {
    const list: string[] = [];
    if (this.external) list.push('external runtime: read-only attach, never stopped by Mona');
    if (this.lastOutcomeUnknown) list.push('last stop outcome unknown; inspect running processes before retrying');
    if (this.quitReceipt) {
      list.push(
        `quit receipt: ${this.quitReceipt.outcome}${this.quitReceipt.detail ? ` — ${this.quitReceipt.detail}` : ''}`,
      );
    }
    return list;
  }

  status(): SupervisorStatus | null {
    return this.supervisor?.status() ?? null;
  }

  shutdownReceipt(): ShutdownReceipt | null {
    return this.quitReceipt;
  }

  async startProjectRuntime(
    input: StartRuntimeInput,
  ): Promise<{ ok: true; endpoint: string } | { ok: false; error: ErrorResult }> {
    if (this.external) {
      return {
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'An external runtime is attached; Mona will not start a second runtime in this workspace.',
          retryable: false,
        },
      };
    }
    if (this.supervisor?.existing()) {
      const existing = this.supervisor.existing();
      if (existing && existing.workspace !== input.workspace) {
        return {
          ok: false,
          error: {
            code: 'invalid_request',
            message: `Mona already owns a runtime for ${existing.workspace}. Stop it before starting another project.`,
            retryable: false,
          },
        };
      }
      return { ok: true, endpoint: existing?.endpoint ?? '' };
    }
    const options: RuntimeSupervisorOptions = {
      executable: this.deps.executable,
      workspace: input.workspace,
      ownershipDir: this.deps.ownershipDir,
      parentPid: this.deps.parentPid ?? null,
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.token !== undefined ? { token: input.token } : {}),
      ...(input.startupTimeoutMs !== undefined ? { startupTimeoutMs: input.startupTimeoutMs } : {}),
      onEvent: (event) => {
        this.applyEvent(event);
        this.deps.onEvent?.(event);
      },
      restart: { maxRestarts: 2, baseDelayMs: 1_000, windowMs: 300_000 },
    };
    this.supervisor = (this.deps.supervisorFactory ?? ((opts) => new RuntimeSupervisor(opts)))(options);
    this.state = 'starting';
    this.detail = 'Starting the owned Codewhale runtime.';
    const started = await this.supervisor.start();
    if (!started.ok) {
      this.state = 'failed';
      this.detail = `${started.error.code}: ${started.error.message}`;
      return { ok: false, error: started.error };
    }
    this.state = 'connected';
    this.detail = `Owned runtime ${started.value.runtimeId} on ${started.value.endpoint}`;
    return { ok: true, endpoint: started.value.endpoint };
  }

  async attachUserRuntime(input: {
    baseUrl: string;
    token: string;
  }): Promise<{ ok: true; endpoint: string } | { ok: false; error: ErrorResult }> {
    if (this.supervisor?.existing()) {
      return {
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'Mona already owns a runtime for this session; stop it before attaching an external one.',
          retryable: false,
        },
      };
    }
    const attached = await (this.deps.attachExternal ?? attachExternalRuntime)(input);
    if (!attached.ok) {
      this.state = 'failed';
      this.detail = `${attached.error.code}: ${attached.error.message}`;
      return { ok: false, error: attached.error };
    }
    this.external = attached.value;
    this.state = 'connected';
    this.detail = `Attached read-only to an external runtime at ${attached.value.baseUrl}; Mona will not stop it.`;
    return { ok: true, endpoint: attached.value.baseUrl };
  }

  /** Interrupt the active turn (if any) and stop the owned runtime. */
  async quitAndStopWork(): Promise<{ receipt: unknown }> {
    const queue = this.queue;
    if (queue) {
      const result = await queue.quitAndStop({
        interrupt: this.interruptActive(),
        stopRuntime: async () => await this.stopOwned('app_quit'),
      });
      return { receipt: result };
    }
    const stopped = await this.stopOwned('app_quit');
    return { receipt: stopped.ok ? stopped.value : { outcome: 'uncertain', detail: stopped.error.message } };
  }

  private interruptActive():
    ((work: { threadId: ThreadId; turnId: TurnId }) => Promise<Result<InterruptReceipt>>) | null {
    const runtime = this.supervisor?.existing() ?? null;
    if (!runtime) return null;
    // A live interrupt needs the submission journal to build an adapter. Until a
    // project binds one (P05/P08), the honest answer is "no channel" rather than
    // a fabricated acknowledgement.
    if (!this.journal) return null;
    const journal = this.journal;
    return async (work) => {
      const adapter = runtime.createAdapter(journal);
      return await adapter.interrupt({ threadId: work.threadId, turnId: work.turnId });
    };
  }

  bindJournal(journal: SubmissionJournal): void {
    this.journal = journal;
  }

  async stopOwned(reason: string): Promise<Awaited<ReturnType<RuntimeSupervisor['stop']>>> {
    if (!this.supervisor) {
      this.state = this.state === 'not_started' ? 'not_started' : 'stopped';
      return {
        ok: true,
        value: {
          runtime_id: 'rt_none',
          requested_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          reason,
          outcome: 'already_stopped',
          root_exited: true,
          observed_descendants: [],
          remaining_pids: [],
          endpoint_closed: true,
          rollback_claimed: false,
        },
      };
    }
    this.state = 'stopping';
    const stopped = await this.supervisor.stop(reason);
    if (stopped.ok) {
      this.state = 'stopped';
      this.quitReceipt = stopped.value;
      this.lastOutcomeUnknown = stopped.value.outcome === 'uncertain';
      this.detail = `Runtime stopped (${stopped.value.outcome}). Work already sent is not rolled back.`;
    } else {
      this.state = 'failed';
      this.lastOutcomeUnknown = true;
      this.detail = `${stopped.error.code}: ${stopped.error.message}`;
    }
    return stopped;
  }

  /** Reconcile ownership records left by a previous run or a machine restart. */
  async reconcile(): Promise<{ reclaimed: number; stale: number; unverifiable: number }> {
    if (!this.supervisor) {
      this.supervisor = new RuntimeSupervisor({
        executable: this.deps.executable,
        workspace: process.cwd(),
        ownershipDir: this.deps.ownershipDir,
        parentPid: this.deps.parentPid ?? null,
        onEvent: (event) => {
          this.applyEvent(event);
          this.deps.onEvent?.(event);
        },
      });
    }
    const report = await this.supervisor.reconcile();
    if (!report.ok) return { reclaimed: 0, stale: 0, unverifiable: 0 };
    return {
      reclaimed: report.value.reclaimed.length,
      stale: report.value.stale.length,
      unverifiable: report.value.unverifiable.length,
    };
  }

  /**
   * Electron lifecycle entry point. Returns the actions taken so the caller can
   * perform window work (recreate, hide) that belongs to Electron, not here.
   */
  handleSignal(
    signal: LifecycleSignal,
    context: { hasActiveWork?: boolean; closeToTray?: boolean; staleOwnershipRecords?: number } = {},
  ): LifecycleAction[] {
    const supervisorStatus = this.supervisor?.status() ?? null;
    const actions = decideLifecycle(signal, {
      hasActiveWork: context.hasActiveWork ?? Boolean(this.queue?.snapshot().active),
      queuedWork: this.queue?.snapshot().queued.length ?? 0,
      runtimeOwned: this.supervisor?.existing() !== null && this.supervisor !== null,
      runtimeAlive: supervisorStatus?.state === 'running',
      closeToTray: context.closeToTray ?? false,
      quitInProgress: this.state === 'stopping',
      staleOwnershipRecords: context.staleOwnershipRecords ?? 0,
    });
    for (const action of actions) {
      switch (action.type) {
        case 'mark-outcome-unknown':
          this.lastOutcomeUnknown = true;
          this.detail = `Outcome unknown: ${action.reason}. Sent work is not rolled back.`;
          break;
        case 'mark-runtime-crashed':
          this.state = 'crashed';
          this.detail = 'The owned runtime exited unexpectedly; restart is bounded and no work is resubmitted.';
          break;
        case 'reconcile-stale-ownership':
          void this.reconcile();
          break;
        default:
          break;
      }
    }
    return actions;
  }

  private applyEvent(event: SupervisorEvent): void {
    switch (event.type) {
      case 'ready':
        this.state = 'connected';
        this.detail = `Owned runtime on ${event.endpoint}`;
        break;
      case 'exited':
        if (!event.expected) {
          this.state = 'crashed';
          this.detail = `Runtime exited unexpectedly (code ${event.code ?? 'unknown'}); no work is resubmitted automatically.`;
        }
        break;
      case 'restart_exhausted':
        this.state = 'failed';
        this.detail = 'Runtime restart limit reached. Start it again deliberately; Mona will not loop.';
        break;
      case 'stale_record':
        this.detail = `Ignored a stale ownership record (${event.reason}).`;
        break;
      case 'reclaimed_previous_owner':
        this.detail = `Reclaimed a runtime left by a previous Mona session (pid ${event.pid}).`;
        break;
      case 'startup_failed':
        this.state = 'failed';
        this.detail = `${event.failure.code}: ${event.failure.message}`;
        break;
      default:
        break;
    }
  }

  /** Test and diagnostics helper: the ownership directory in use. */
  ownershipDir(): string {
    return path.resolve(this.deps.ownershipDir);
  }
}
