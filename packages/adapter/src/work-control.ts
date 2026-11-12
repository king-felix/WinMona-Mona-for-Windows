import type { ThreadId, TurnId } from '@mona/contracts';
import type { InterruptReceipt } from './adapter.js';
import type { Result } from './errors.js';
import type { ShutdownReceipt } from './supervisor.js';

/**
 * Queue boundaries are Mona's. Interrupt is the engine's. They are different
 * transitions and never share a receipt.
 */
export type WorkQueueState = 'idle' | 'running' | 'paused' | 'blocked' | 'stopping' | 'stopped';

export type QueuedTask = {
  taskId: string;
  label: string;
  enqueuedAt: string;
};

export type ActiveWork = {
  taskId: string;
  threadId: ThreadId;
  turnId: TurnId;
  startedAt: string;
  label: string;
  /** Who dispatches this run. A native owner is not Mona's queue. */
  owner?: 'mona_queue' | 'native_workflow';
};

export type ControlReceipt = {
  action:
    'pause_after_task' | 'interrupt_now' | 'cancel_queued' | 'resume_queue' | 'block_on_problem' | 'release_problem';
  accepted: boolean;
  at: string;
  outcome: 'applied' | 'no_active_work' | 'rejected' | 'outcome_unknown' | 'partial';
  detail?: string;
  engine_receipt?: InterruptReceipt;
  rollback_claimed: false;
};

export type QuitReceipt = {
  action: 'quit_and_stop';
  accepted: boolean;
  at: string;
  outcome: 'applied' | 'no_active_work' | 'partial' | 'outcome_unknown';
  interrupt: ControlReceipt;
  stop: { outcome: ShutdownReceipt['outcome']; detail?: string } | null;
  detail?: string;
  rollback_claimed: false;
};

export type WorkSnapshot = {
  state: WorkQueueState;
  active: ActiveWork | null;
  queued: QueuedTask[];
  pauseRequested: boolean;
  blocked: { problemId: string; taskId: string | null; detail: string } | null;
  lastOutcome: string | null;
};

export type WorkQueueOptions = {
  now?: () => Date;
  onEvent?: (event: { type: string; at: string; detail?: string }) => void;
};

/**
 * One mutating unit of work per workspace. The queue never starts work by
 * itself after an interrupt: resumption is a separate, reconciled decision.
 */
export class WorkQueue {
  private readonly now: () => Date;
  private readonly onEvent: WorkQueueOptions['onEvent'];
  private state: WorkQueueState = 'idle';
  private active: ActiveWork | null = null;
  private queued: QueuedTask[] = [];
  private pauseRequested = false;
  private blocked: WorkSnapshot['blocked'] = null;
  private lastOutcome: string | null = null;

  constructor(options: WorkQueueOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.onEvent = options.onEvent;
  }

  snapshot(): WorkSnapshot {
    return {
      state: this.state,
      active: this.active ? { ...this.active } : null,
      queued: this.queued.map((task) => ({ ...task })),
      pauseRequested: this.pauseRequested,
      blocked: this.blocked ? { ...this.blocked } : null,
      lastOutcome: this.lastOutcome,
    };
  }

  enqueue(task: Omit<QueuedTask, 'enqueuedAt'> & { enqueuedAt?: string }): QueuedTask {
    if (this.state === 'stopping' || this.state === 'stopped') {
      throw new Error('queue is stopping; new work is refused');
    }
    const entry: QueuedTask = {
      taskId: task.taskId,
      label: task.label,
      enqueuedAt: task.enqueuedAt ?? this.now().toISOString(),
    };
    if (this.queued.some((item) => item.taskId === entry.taskId)) return entry;
    if (this.active?.taskId === entry.taskId) return entry;
    this.queued.push(entry);
    this.onEvent?.({ type: 'queued', at: entry.enqueuedAt, detail: entry.taskId });
    return entry;
  }

  /** Called by the scheduler at a boundary. Returns null when paused/empty. */
  startNext(): QueuedTask | null {
    if (this.state === 'stopping' || this.state === 'stopped') return null;
    if (this.active !== null) return null;
    if (this.blocked) {
      this.state = 'blocked';
      return null;
    }
    if (this.pauseRequested) {
      this.state = 'paused';
      return null;
    }
    const next = this.queued.shift();
    if (!next) {
      this.state = 'idle';
      return null;
    }
    this.state = 'running';
    this.onEvent?.({ type: 'started', at: this.now().toISOString(), detail: next.taskId });
    return next;
  }

  markActive(input: Omit<ActiveWork, 'startedAt'> & { startedAt?: string }): ActiveWork {
    if (this.state !== 'running') throw new Error('cannot mark active work while the queue is not running');
    this.active = {
      ...input,
      startedAt: input.startedAt ?? this.now().toISOString(),
    };
    return { ...this.active };
  }

  completeActive(outcome: string): WorkSnapshot {
    this.active = null;
    this.lastOutcome = outcome;
    if (this.blocked) this.state = 'blocked';
    else if (this.pauseRequested) this.state = 'paused';
    else this.state = 'idle';
    this.onEvent?.({ type: 'completed', at: this.now().toISOString(), detail: outcome });
    return this.snapshot();
  }

  /**
   * Stop after the current task. Never interrupts the running turn. When a
   * native workflow owns the run, Mona's queue boundary cannot stop that
   * dispatcher, and the receipt says so instead of implying a full pause.
   */
  pauseAfterTask(options: { nativeDispatcherActive?: boolean } = {}): ControlReceipt {
    const at = this.now().toISOString();
    if (this.state === 'stopping' || this.state === 'stopped') {
      return {
        action: 'pause_after_task',
        accepted: false,
        at,
        outcome: 'rejected',
        detail: 'queue is stopping',
        rollback_claimed: false,
      };
    }
    this.pauseRequested = true;
    if (this.active === null) this.state = this.blocked ? 'blocked' : 'paused';
    this.onEvent?.({ type: 'pause_requested', at });
    const nativeOwned = options.nativeDispatcherActive === true || this.active?.owner === 'native_workflow';
    if (nativeOwned) {
      return {
        action: 'pause_after_task',
        accepted: true,
        at,
        outcome: 'partial',
        detail:
          'Mona will not start another queued task, but a native workflow owns this run and continues independently; pause it through its own owner',
        rollback_claimed: false,
      };
    }
    return {
      action: 'pause_after_task',
      accepted: true,
      at,
      outcome: 'applied',
      detail: this.active === null ? 'paused before the next start' : 'will stop at the next queue boundary',
      rollback_claimed: false,
    };
  }

  resumeQueue(): ControlReceipt {
    const at = this.now().toISOString();
    if (this.blocked) {
      return {
        action: 'resume_queue',
        accepted: false,
        at,
        outcome: 'rejected',
        detail: `problem ${this.blocked.problemId} is blocked; reopen it with new evidence before resuming`,
        rollback_claimed: false,
      };
    }
    this.pauseRequested = false;
    if (this.state === 'paused') this.state = this.active ? 'running' : 'idle';
    return { action: 'resume_queue', accepted: true, at, outcome: 'applied', rollback_claimed: false };
  }

  /**
   * Blocker-paused state. The queue refuses to start anything until the linked
   * problem is reopened with new evidence; independent work is not cancelled.
   */
  blockOnProblem(input: { problemId: string; taskId?: string | null; detail: string }): ControlReceipt {
    const at = this.now().toISOString();
    this.blocked = { problemId: input.problemId, taskId: input.taskId ?? null, detail: input.detail };
    this.pauseRequested = true;
    if (this.active === null) this.state = 'blocked';
    this.onEvent?.({ type: 'blocked', at, detail: input.problemId });
    return {
      action: 'block_on_problem',
      accepted: true,
      at,
      outcome: 'applied',
      detail: input.detail,
      rollback_claimed: false,
    };
  }

  /** Clear a blocker-paused queue after the problem reopens with new evidence. */
  releaseProblem(problemId: string): ControlReceipt {
    const at = this.now().toISOString();
    if (!this.blocked) {
      return {
        action: 'release_problem',
        accepted: false,
        at,
        outcome: 'rejected',
        detail: 'the queue is not blocked',
        rollback_claimed: false,
      };
    }
    if (this.blocked.problemId !== problemId) {
      return {
        action: 'release_problem',
        accepted: false,
        at,
        outcome: 'rejected',
        detail: `the queue is blocked by ${this.blocked.problemId}, not ${problemId}`,
        rollback_claimed: false,
      };
    }
    this.blocked = null;
    this.pauseRequested = false;
    this.state = this.active ? 'running' : 'idle';
    this.onEvent?.({ type: 'released', at, detail: problemId });
    return { action: 'release_problem', accepted: true, at, outcome: 'applied', rollback_claimed: false };
  }

  /** Cancels future starts only. It cannot cancel a running turn. */
  cancelQueued(taskId: string): ControlReceipt {
    const at = this.now().toISOString();
    if (this.active?.taskId === taskId) {
      return {
        action: 'cancel_queued',
        accepted: false,
        at,
        outcome: 'rejected',
        detail: 'task is running; use Interrupt now for the engine operation',
        rollback_claimed: false,
      };
    }
    const index = this.queued.findIndex((task) => task.taskId === taskId);
    if (index === -1) {
      return {
        action: 'cancel_queued',
        accepted: false,
        at,
        outcome: 'rejected',
        detail: 'task is not queued',
        rollback_claimed: false,
      };
    }
    this.queued.splice(index, 1);
    this.onEvent?.({ type: 'cancelled', at, detail: taskId });
    return { action: 'cancel_queued', accepted: true, at, outcome: 'applied', rollback_claimed: false };
  }

  /**
   * Engine operation with a real receipt. A failed or lost response is reported
   * as outcome unknown; active work is not cleared by this method.
   */
  async interruptNow(
    interrupt: ((input: ActiveWork) => Promise<Result<InterruptReceipt>>) | null,
  ): Promise<ControlReceipt> {
    const at = this.now().toISOString();
    if (!this.active) {
      return { action: 'interrupt_now', accepted: false, at, outcome: 'no_active_work', rollback_claimed: false };
    }
    if (!interrupt) {
      return {
        action: 'interrupt_now',
        accepted: false,
        at,
        outcome: 'outcome_unknown',
        detail: 'no engine interrupt channel is available for this runtime',
        rollback_claimed: false,
      };
    }
    const result = await interrupt({ ...this.active });
    this.onEvent?.({ type: 'interrupt', at, detail: result.ok ? 'acknowledged' : result.error.code });
    if (!result.ok) {
      return {
        action: 'interrupt_now',
        accepted: true,
        at,
        outcome: 'outcome_unknown',
        detail: `${result.error.code}: ${result.error.message}; the interrupted request may still be running`,
        rollback_claimed: false,
      };
    }
    return {
      action: 'interrupt_now',
      accepted: true,
      at,
      outcome: 'applied',
      detail: `engine acknowledged status ${result.value.acknowledgedStatus}; external side effects are not rolled back`,
      engine_receipt: result.value,
      rollback_claimed: false,
    };
  }

  /**
   * Quit and stop work: interrupt first (best effort with a receipt), then stop
   * the owned runtime. A partial outcome is labeled partial, never success.
   */
  async quitAndStop(input: {
    interrupt: ((work: ActiveWork) => Promise<Result<InterruptReceipt>>) | null;
    stopRuntime: () => Promise<Result<ShutdownReceipt>>;
  }): Promise<QuitReceipt> {
    if (this.state === 'stopping' || this.state === 'stopped') {
      return {
        action: 'quit_and_stop',
        accepted: false,
        at: this.now().toISOString(),
        outcome: 'outcome_unknown',
        interrupt: {
          action: 'interrupt_now',
          accepted: false,
          at: this.now().toISOString(),
          outcome: 'rejected',
          detail: 'queue is already stopping',
          rollback_claimed: false,
        },
        stop: null,
        rollback_claimed: false,
      };
    }
    this.state = 'stopping';
    const interrupt = await this.interruptNow(input.interrupt);
    const stopped = await input.stopRuntime();
    const stop = stopped.ok
      ? {
          outcome: stopped.value.outcome,
          ...(stopped.value.detail ? { detail: stopped.value.detail } : {}),
        }
      : { outcome: 'uncertain' as const, detail: `${stopped.error.code}: ${stopped.error.message}` };
    this.state = 'stopped';
    this.active = null;
    this.queued = [];
    const interruptApplied = interrupt.outcome === 'applied' || interrupt.outcome === 'no_active_work';
    const stopClean =
      stop.outcome === 'stopped' || stop.outcome === 'stopped_forced' || stop.outcome === 'already_stopped';
    const outcome: QuitReceipt['outcome'] = interruptApplied && stopClean ? 'applied' : 'partial';
    const detail =
      interruptApplied && stopClean
        ? undefined
        : 'interrupt or stop is uncertain; work already sent is not rolled back';
    return {
      action: 'quit_and_stop',
      accepted: true,
      at: this.now().toISOString(),
      outcome,
      interrupt,
      stop,
      ...(detail ? { detail } : {}),
      rollback_claimed: false,
    };
  }
}
