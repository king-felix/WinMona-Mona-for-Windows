import { existsSync } from 'node:fs';
import path from 'node:path';
import { WorkQueue, redact, type AdapterStreamEvent, type EngineAdapter } from '@mona/adapter';
import {
  errorResult,
  ThreadId,
  type EffectiveProfile,
  type ErrorResult,
  type ParsedEngineEvent,
  type UsageEvidence,
} from '@mona/contracts';
import type { CostLedger, ProjectStore, StudioThreadRow, TimelineItemRow } from '@mona/project-state';
import { z } from 'zod';
import type { EngineSummary } from './engine-host.js';
import type {
  StudioControl,
  StudioEvent,
  StudioMode,
  StudioPending,
  StudioProfile,
  StudioRun,
  StudioSubmission,
  StudioView,
  TimelineItem,
  TimelineKind,
} from '../shared/studio.js';

export type StudioEnginePort = {
  summary(): EngineSummary;
  /** The live adapter for the connected runtime, or null when nothing is connected. */
  adapter(): EngineAdapter | null;
};

export type StudioAttentionEvent = {
  kind: 'run_completed' | 'run_failed' | 'blocker';
  projectId: string;
  at: string;
  taskId: string | null;
  turnId: string | null;
  outcome: string | null;
};

export type StudioServiceDeps = {
  store: ProjectStore;
  engine: StudioEnginePort;
  emit: (event: StudioEvent) => void;
  now?: () => Date;
  /** Maximum characters kept per timeline item; larger output is labeled truncated. */
  maxItemChars?: number;
  /** Minimum interval between streaming body writes to the database. */
  flushIntervalMs?: number;
  pickReferences?: (project: { id: string; canonicalPath: string }) => Promise<string[] | null>;
  /** True when a native workflow is independently dispatching work for this project. */
  nativeDispatcherActive?: (projectId: string) => boolean;
  /** Optional ledger: budgets gate the next dispatch, never mid-flight work. */
  costs?: CostLedger;
  /** Local attention signal. The main process decides delivery; no model is involved. */
  attention?: (event: StudioAttentionEvent) => void;
};

type Success<T> = { ok: true; data: T };
type Failure = { ok: false; error: ErrorResult };
type ServiceResult<T> = Success<T> | Failure;

const DEFAULT_MAX_ITEM_CHARS = 64 * 1024;
const DEFAULT_FLUSH_MS = 250;
const MAX_TEXT = 100_000;
const MAX_REFERENCES = 50;
const MAX_REFERENCE_CHARS = 512;
const MAX_DIAGNOSTICS = 200;
const MAX_DIAGNOSTIC_CHARS = 400;
const LOCAL_SEQ_START = 10_000_000_000;
const HUMAN_INPUT_TOOLS = new Set(['request_user_input']);

const ItemPayload = z
  .object({
    item: z
      .object({
        id: z.string().min(1),
        kind: z.string().min(1),
        status: z.string().optional(),
        summary: z.string().optional(),
        detail: z.string().optional(),
        metadata: z
          .object({
            visibility: z.string().optional(),
            tool_name: z.string().optional(),
            tool_input: z.string().optional(),
          })
          .passthrough()
          .optional(),
        artifact_refs: z.array(z.unknown()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const TurnStartedPayload = z
  .object({ turn: z.object({ id: z.string(), input_summary: z.string().optional() }).passthrough() })
  .passthrough();

const TurnCompletedPayload = z
  .object({
    turn: z
      .object({
        id: z.string(),
        thread_id: z.string(),
        status: z.string(),
        duration_ms: z.number().nonnegative().optional(),
        usage: z.record(z.string(), z.unknown()).optional(),
        workspace_snapshots: z
          .array(z.object({ kind: z.string().optional(), changed_paths: z.array(z.string()).optional() }).passthrough())
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

const TurnUsagePayload = z
  .object({ usage: z.record(z.string(), z.unknown()), duration_ms: z.number().optional() })
  .passthrough();

const SnapshotPayload = z
  .object({ kind: z.string().optional(), changed_paths: z.array(z.string()).optional() })
  .passthrough();

const DeltaPayload = z.object({ delta: z.string(), kind: z.string().optional() }).passthrough();

const UsageShape = z
  .object({
    input_tokens: z.number().nonnegative().optional(),
    output_tokens: z.number().nonnegative().optional(),
    prompt_cache_hit_tokens: z.number().nonnegative().optional(),
    prompt_cache_miss_tokens: z.number().nonnegative().optional(),
    reasoning_tokens: z.number().nonnegative().optional(),
  })
  .passthrough();

type ItemCacheEntry = {
  item: TimelineItem;
  engineItemId: string;
  lastFlush: number;
};

type ProjectState = {
  projectId: string;
  sessionId: string | null;
  threadId: string | null;
  projectPath: string;
  profile: StudioProfile | null;
  queue: WorkQueue;
  controller: AbortController | null;
  subscription: Promise<void> | null;
  lastSeq: number;
  localSeq: number;
  run: StudioRun;
  pending: StudioPending | null;
  diagnostics: string[];
  interrupt: StudioControl['interrupt'];
  settledTurns: Set<string>;
  turnUsage: Map<string, z.infer<typeof UsageShape>>;
  changedPaths: Map<string, string[]>;
  items: Map<string, ItemCacheEntry>;
  byEngineItem: Map<string, string>;
};

function emptyRun(): StudioRun {
  return {
    state: 'idle',
    detail: 'Ready. Nothing has been sent for this session.',
    turnId: null,
    submission: null,
    startedAt: null,
  };
}

/**
 * The live studio. It owns one engine thread per Mona session, projects the
 * engine's events into a durable timeline, drives the execution control strip,
 * and never invents content: every rendered item comes from an observed event,
 * a recorded receipt, or a locally computed fact whose source is named.
 */
export class StudioService {
  private readonly store: ProjectStore;
  private readonly engine: StudioEnginePort;
  private readonly emit: (event: StudioEvent) => void;
  private readonly now: () => Date;
  private readonly maxItemChars: number;
  private readonly flushIntervalMs: number;
  private readonly pickReferences: StudioServiceDeps['pickReferences'];
  private readonly nativeDispatcherActive: StudioServiceDeps['nativeDispatcherActive'];
  private readonly costs: StudioServiceDeps['costs'];
  private readonly attention: StudioServiceDeps['attention'];
  private readonly states = new Map<string, ProjectState>();

  constructor(deps: StudioServiceDeps) {
    this.store = deps.store;
    this.engine = deps.engine;
    this.emit = deps.emit;
    this.now = deps.now ?? (() => new Date());
    this.maxItemChars = deps.maxItemChars ?? DEFAULT_MAX_ITEM_CHARS;
    this.flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_MS;
    this.pickReferences = deps.pickReferences;
    this.nativeDispatcherActive = deps.nativeDispatcherActive;
    this.costs = deps.costs;
    this.attention = deps.attention;
  }

  async view(projectId: string, sessionId: string, mode?: StudioMode): Promise<ServiceResult<StudioView>> {
    try {
      const project = await this.store.getProject(projectId);
      if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
      const state = this.stateFor(projectId, sessionId, project.canonicalPath);
      const threadRow = await this.store.studioThreadForSession(projectId, sessionId, mode);
      let warning: string | null = null;
      if (threadRow) {
        const profile = parseProfile(threadRow);
        state.profile = profile ? toStudioProfile(profile) : null;
        if (!profile) {
          warning = 'The stored thread profile could not be read; the observed permission is shown as unknown.';
        } else if (profile.workspace !== project.canonicalPath) {
          warning = `This session is bound to a runtime for ${profile.workspace}, not this project.`;
          state.profile = null;
        } else {
          state.threadId = threadRow.id;
          state.lastSeq = Math.max(state.lastSeq, threadRow.lastSeq);
          // A bound thread with a live runtime gets a stream: events that arrived
          // while the window was closed are replayed from the stored cursor.
          this.maybeSubscribe(state, project.canonicalPath);
        }
      }
      const items = threadRow ? (await this.store.listTimelineItems(threadRow.id, 500)).map(toTimelineItem) : [];
      return { ok: true, data: this.renderView(state, items, warning) };
    } catch (error) {
      return { ok: false, error: errorResult('internal', 'The studio state could not be read.', true, slice(error)) };
    }
  }

  async submit(input: {
    projectId: string;
    sessionId: string;
    text: string;
    mode: StudioMode;
    references: string[];
  }): Promise<ServiceResult<StudioSubmission>> {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) return { ok: false, error: errorResult('invalid_request', 'Write a prompt before submitting.') };
    if (text.length > MAX_TEXT) {
      return {
        ok: false,
        error: errorResult('invalid_request', `A prompt must be at most ${MAX_TEXT.toLocaleString()} characters.`),
      };
    }
    const references = this.boundReferences(input.references);
    if (!references) {
      return {
        ok: false,
        error: errorResult(
          'invalid_request',
          'File references must be project-relative paths, at most 50 of them, without control characters.',
        ),
      };
    }
    const mode: StudioMode = input.mode === 'plan' ? 'plan' : 'agent';

    const project = await this.store.getProject(input.projectId);
    if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
    if (!existsSync(project.canonicalPath)) {
      return {
        ok: false,
        error: errorResult('not_found', 'The project folder is missing. Locate it before submitting work.'),
      };
    }
    const summary = this.engine.summary();
    if (summary.state !== 'connected') {
      return {
        ok: false,
        error: errorResult(
          'engine_unavailable',
          'The engine is not connected. Connect it for this project before submitting work.',
        ),
      };
    }
    if (summary.workspace !== project.canonicalPath) {
      return {
        ok: false,
        error: errorResult(
          'invalid_request',
          `The runtime is serving ${summary.workspace ?? 'another workspace'}. Mona owns one runtime at a time; stop it before submitting here.`,
        ),
      };
    }
    const adapter = this.engine.adapter();
    if (!adapter) {
      return { ok: false, error: errorResult('engine_unavailable', 'No live runtime adapter is available yet.') };
    }

    const state = this.stateFor(input.projectId, input.sessionId, project.canonicalPath);
    if (this.nativeDispatcherActive?.(input.projectId)) {
      return {
        ok: false,
        error: errorResult(
          'invalid_request',
          'A native goal, fleet run, or agent currently owns scheduling for this project. Mona will not dispatch a second executor. Stop or finish the native run first.',
        ),
      };
    }
    if (
      state.run.state === 'running' ||
      state.run.state === 'preparing' ||
      state.run.state === 'interrupting' ||
      state.run.state === 'awaiting_approval'
    ) {
      return {
        ok: false,
        error: errorResult(
          'invalid_request',
          'A turn is already running for this project. Interrupt it or wait for it to finish.',
        ),
      };
    }
    if (state.queue.snapshot().blocked) {
      const blocked = state.queue.snapshot().blocked;
      return {
        ok: false,
        error: errorResult(
          'invalid_request',
          `Dispatch is blocked by problem ${blocked?.problemId ?? 'unknown'}. Record new evidence or a Victor decision first.`,
        ),
      };
    }
    if (state.queue.snapshot().pauseRequested) {
      return {
        ok: false,
        error: errorResult('invalid_request', 'The queue is paused after the last task. Resume to send new work.'),
      };
    }
    if (this.costs) {
      const budget = await this.costs.evaluateBudget({ projectId: input.projectId, sessionId: input.sessionId });
      if (budget.action === 'block_next_dispatch') {
        const detail = budget.decisions
          .filter((decision) => decision.action === 'block_next_dispatch')
          .map((decision) => decision.detail)
          .join('; ');
        return {
          ok: false,
          error: errorResult(
            'invalid_request',
            'The configured cost budget stops the next dispatch. In-flight work is not interrupted.',
            false,
            detail || undefined,
          ),
        };
      }
      if (budget.action === 'warn') {
        this.diagnostic(state, `budget warning: ${budget.decisions.map((decision) => decision.detail).join('; ')}`);
      }
    }

    state.run = {
      state: 'preparing',
      detail: 'Preparing the engine thread. No prompt has been sent yet.',
      turnId: null,
      submission: null,
      startedAt: null,
    };
    this.pushState(state);

    let threadRow = await this.store.studioThreadForSession(input.projectId, input.sessionId, mode);
    let profile = threadRow ? parseProfile(threadRow) : null;
    if (threadRow && (!profile || profile.workspace !== project.canonicalPath)) {
      // A thread bound to another workspace is left alone; this session needs a
      // thread of its own before anything may be sent.
      threadRow = null;
      profile = null;
    }

    if (!profile || !threadRow) {
      const opened = await adapter.createOrOpenThread({
        mode,
        allowShell: true,
        trustMode: true,
        autoApprove: true,
        expectedWorkspace: project.canonicalPath,
        operationKey: `thread:${input.sessionId}:${mode}`,
      });
      if (!opened.ok) {
        const error = explain(opened.error);
        state.run = { state: 'failed', detail: error.message, turnId: null, submission: null, startedAt: null };
        this.diagnostic(state, `thread open failed: ${opened.error.code}`);
        this.pushState(state);
        return { ok: false, error };
      }
      profile = opened.value.profile;
      threadRow = await this.store.putStudioThread({
        id: profile.threadId,
        projectId: input.projectId,
        engineThreadId: profile.threadId,
        workspace: profile.workspace,
        sessionId: input.sessionId,
        mode,
        profileJson: JSON.stringify(profile),
      });
      state.threadId = threadRow.id;
      state.lastSeq = 0;
      this.diagnostic(state, `thread ${profile.threadId} opened in ${mode} mode`);
    }

    state.threadId = threadRow.id;
    state.profile = toStudioProfile(profile);
    const threadId = ThreadId.parse(threadRow.id);
    const prompt = composePrompt(text, references);
    const submitted = await adapter.submitTurn({
      threadId,
      prompt,
      allowShell: true,
      trustMode: true,
      autoApprove: true,
    });
    if (!submitted.ok) {
      const error = explain(submitted.error);
      state.run = { state: 'failed', detail: error.message, turnId: null, submission: null, startedAt: null };
      this.diagnostic(state, `submission failed: ${submitted.error.code}`);
      this.pushState(state);
      return { ok: false, error };
    }

    const receipt = submitted.value;
    state.run = {
      state: 'running',
      detail:
        receipt.state === 'outcome_unknown'
          ? 'The runtime did not confirm the submission. Mona reconciles with the operation key before any resend.'
          : 'Turn accepted by the runtime.',
      turnId: receipt.turnId,
      submission: { submissionId: receipt.submissionId, state: receipt.state, replayed: receipt.replayed },
      startedAt: this.now().toISOString(),
    };
    state.pending = null;
    state.interrupt = null;
    if (receipt.turnId) {
      await this.store.recordTurn({ threadId, engineTurnId: receipt.turnId, status: 'in_progress' });
      const task = state.queue.enqueue({ taskId: receipt.submissionId, label: text.slice(0, 80) });
      const next = state.queue.startNext();
      if (next) {
        state.queue.markActive({
          taskId: task.taskId,
          threadId,
          turnId: receipt.turnId,
          label: task.label,
          owner: 'mona_queue',
        });
      }
    }
    this.maybeSubscribe(state, project.canonicalPath, adapter);
    this.pushState(state);
    return {
      ok: true,
      data: {
        submissionId: receipt.submissionId,
        threadId,
        turnId: receipt.turnId,
        state: receipt.state,
        replayed: receipt.replayed,
        reconciliation: receipt.reconciliation,
        prompt,
        thread: state.profile,
        run: state.run,
      },
    };
  }

  /** The active Mona-queued turn for this project, if any. */
  activeOwnership(projectId: string): { runId: string; at: string } | null {
    const state = this.findState(projectId);
    if (!state) return null;
    if (!['preparing', 'running', 'interrupting', 'awaiting_approval', 'reconnecting'].includes(state.run.state)) {
      return null;
    }
    return {
      runId: state.run.turnId ?? state.run.submission?.submissionId ?? 'mona-turn',
      at: state.run.startedAt ?? this.now().toISOString(),
    };
  }

  async interrupt(projectId: string): Promise<ServiceResult<{ run: StudioRun; control: StudioControl }>> {
    const state = this.findState(projectId);
    if (!state) {
      return { ok: false, error: errorResult('not_found', 'No studio session is open for that project.') };
    }
    if (state.run.state === 'idle') {
      return { ok: true, data: { run: state.run, control: this.controlFor(state) } };
    }
    const adapter = this.engine.adapter();
    state.run = { ...state.run, state: 'interrupting', detail: 'Asking the runtime to interrupt the active turn.' };
    this.pushState(state);
    const receipt = await state.queue.interruptNow(
      adapter && state.threadId
        ? async (work) => adapter.interrupt({ threadId: work.threadId, turnId: work.turnId })
        : null,
    );
    state.interrupt = { outcome: receipt.outcome, detail: receipt.detail ?? null, at: receipt.at };
    this.diagnostic(state, `interrupt: ${receipt.outcome}${receipt.detail ? ` (${receipt.detail})` : ''}`);
    if (receipt.outcome === 'applied') {
      state.run = {
        ...state.run,
        state: 'interrupting',
        detail: 'The runtime acknowledged the interrupt. External side effects are not rolled back.',
      };
      state.pending = null;
    } else if (receipt.outcome === 'no_active_work') {
      state.run = { ...state.run, state: 'idle', detail: 'The runtime reported no active turn.' };
    } else {
      state.run = {
        ...state.run,
        state: 'running',
        detail: 'The interrupt outcome is unknown; the turn may still be running.',
      };
    }
    this.pushState(state);
    return { ok: true, data: { run: state.run, control: this.controlFor(state) } };
  }

  pause(projectId: string): ServiceResult<{ run: StudioRun; control: StudioControl }> {
    const state = this.findState(projectId);
    if (!state) {
      return { ok: false, error: errorResult('not_found', 'No studio session is open for that project.') };
    }
    const receipt = state.queue.pauseAfterTask({
      nativeDispatcherActive: this.nativeDispatcherActive?.(projectId) === true,
    });
    this.diagnostic(state, `pause after task: ${receipt.outcome}${receipt.detail ? ` (${receipt.detail})` : ''}`);
    if (receipt.outcome === 'partial') {
      state.run = { ...state.run, detail: receipt.detail ?? state.run.detail };
    }
    this.pushState(state);
    return { ok: true, data: { run: state.run, control: this.controlFor(state) } };
  }

  /** Blocker-paused: refuse new starts until the problem reopens with evidence. */
  blockOnProblem(
    projectId: string,
    input: { problemId: string; taskId?: string | null; detail: string },
  ): ServiceResult<{ run: StudioRun; control: StudioControl }> {
    const state = this.findState(projectId);
    if (!state) {
      return { ok: false, error: errorResult('not_found', 'No studio session is open for that project.') };
    }
    const receipt = state.queue.blockOnProblem(input);
    this.diagnostic(state, `blocked: ${input.problemId} (${receipt.outcome})`);
    this.attention?.({
      kind: 'blocker',
      projectId,
      at: this.now().toISOString(),
      taskId: input.taskId ?? null,
      turnId: null,
      outcome: input.problemId,
    });
    this.pushState(state);
    return { ok: true, data: { run: state.run, control: this.controlFor(state) } };
  }

  releaseProblem(projectId: string, problemId: string): ServiceResult<{ run: StudioRun; control: StudioControl }> {
    const state = this.findState(projectId);
    if (!state) {
      return { ok: false, error: errorResult('not_found', 'No studio session is open for that project.') };
    }
    const receipt = state.queue.releaseProblem(problemId);
    this.diagnostic(state, `release ${problemId}: ${receipt.outcome}`);
    this.pushState(state);
    return { ok: true, data: { run: state.run, control: this.controlFor(state) } };
  }

  resume(projectId: string): ServiceResult<{ run: StudioRun; control: StudioControl }> {
    const state = this.findState(projectId);
    if (!state) {
      return { ok: false, error: errorResult('not_found', 'No studio session is open for that project.') };
    }
    const receipt = state.queue.resumeQueue();
    this.diagnostic(state, `resume queue: ${receipt.outcome}`);
    this.pushState(state);
    return { ok: true, data: { run: state.run, control: this.controlFor(state) } };
  }

  async references(projectId: string): Promise<ServiceResult<{ paths: string[] }>> {
    const project = await this.store.getProject(projectId);
    if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
    if (!this.pickReferences) {
      return {
        ok: false,
        error: errorResult('capability_unsupported', 'Choosing file references is not available in this window.'),
      };
    }
    if (!existsSync(project.canonicalPath)) {
      return { ok: false, error: errorResult('not_found', 'The project folder is missing.') };
    }
    const picked = await this.pickReferences({ id: project.id, canonicalPath: project.canonicalPath });
    if (!picked) return { ok: true, data: { paths: [] } };
    const paths = picked
      .map((target) => {
        const relative = path.relative(project.canonicalPath, target);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
        return relative.split(path.sep).join('/');
      })
      .filter((value): value is string => typeof value === 'string');
    return { ok: true, data: { paths: [...new Set(paths)].sort() } };
  }

  /** Called when the owned runtime stops: live turns become honestly uncertain. */
  engineStopped(detail: string): void {
    for (const state of this.states.values()) {
      if (state.run.state === 'idle' || state.run.state === 'failed') continue;
      state.controller?.abort();
      state.controller = null;
      state.subscription = null;
      state.run = {
        ...state.run,
        state: 'failed',
        detail: `The engine stopped while this turn was active. Its outcome is uncertain: ${detail}`,
      };
      state.pending = null;
      this.diagnostic(state, 'engine stopped; active turn outcome unknown');
      this.pushState(state);
    }
  }

  /** Abort every subscription; used on quit and in tests. */
  close(): void {
    for (const state of this.states.values()) {
      state.controller?.abort();
      state.controller = null;
      state.subscription = null;
    }
  }

  // --- internals ----------------------------------------------------------

  private stateFor(projectId: string, sessionId: string, projectPath: string): ProjectState {
    const key = `${projectId}:${sessionId}`;
    const existing = this.states.get(key);
    if (existing) {
      existing.sessionId = sessionId;
      existing.projectPath = projectPath;
      return existing;
    }
    const created: ProjectState = {
      projectId,
      sessionId,
      threadId: null,
      projectPath,
      profile: null,
      queue: new WorkQueue({ now: this.now }),
      controller: null,
      subscription: null,
      lastSeq: 0,
      localSeq: LOCAL_SEQ_START,
      run: emptyRun(),
      pending: null,
      diagnostics: [],
      interrupt: null,
      settledTurns: new Set(),
      turnUsage: new Map(),
      changedPaths: new Map(),
      items: new Map(),
      byEngineItem: new Map(),
    };
    this.states.set(key, created);
    return created;
  }

  private findState(projectId: string): ProjectState | null {
    const matches = [...this.states.values()].filter((state) => state.projectId === projectId);
    return matches[matches.length - 1] ?? null;
  }

  private maybeSubscribe(state: ProjectState, projectPath: string, adapter?: EngineAdapter): void {
    if (state.subscription || state.controller || !state.threadId) return;
    const summary = this.engine.summary();
    if (summary.state !== 'connected' || summary.workspace !== projectPath) return;
    const live = adapter ?? this.engine.adapter();
    if (!live) return;
    const threadId = state.threadId;
    const controller = new AbortController();
    state.controller = controller;
    state.subscription = (async () => {
      try {
        for await (const event of live.subscribe({
          threadId,
          sinceSeq: state.lastSeq,
          reconnect: true,
          maxAttempts: 6,
          baseDelayMs: 400,
          maxDelayMs: 4_000,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) return;
          await this.handleStreamEvent(state, threadId, event);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        this.diagnostic(state, `stream ended: ${slice(error)}`);
        if (state.run.state === 'running' || state.run.state === 'reconnecting') {
          state.run = { ...state.run, state: 'reconnecting', detail: 'The event stream ended unexpectedly.' };
          this.pushState(state);
        }
      } finally {
        if (state.controller === controller) {
          state.controller = null;
          state.subscription = null;
        }
      }
    })();
  }

  private async handleStreamEvent(state: ProjectState, threadId: string, event: AdapterStreamEvent): Promise<void> {
    switch (event.kind) {
      case 'event':
        await this.handleEngineEvent(state, threadId, event.event, event.seq);
        return;
      case 'reconnected':
        this.diagnostic(state, `reconnected at seq ${event.sinceSeq} (attempt ${event.attempt})`);
        if (state.run.state === 'reconnecting') {
          state.run = { ...state.run, state: 'running', detail: 'Reconnected to the runtime event stream.' };
          this.pushState(state);
        }
        return;
      case 'stream_end':
        this.diagnostic(
          state,
          `stream.end seq ${event.lastSeq}: ${event.reason}${event.retryable ? ' (retryable)' : ''}`,
        );
        if (event.retryable && (state.run.state === 'running' || state.run.state === 'interrupting')) {
          state.run = {
            ...state.run,
            state: 'reconnecting',
            detail: 'The event stream dropped; Mona is reconnecting from the last received sequence.',
          };
          this.pushState(state);
        }
        return;
      case 'diagnostic':
        await this.handleDiagnostic(state, event.failure.code, event.failure.message, event.failure.detail);
        return;
      default:
        return;
    }
  }

  private async handleDiagnostic(state: ProjectState, code: string, message: string, detail?: string): Promise<void> {
    this.diagnostic(state, `${code}: ${message}${detail ? ` — ${detail}` : ''}`);
    if (code === 'transport_failed' || code === 'stream_closed') {
      if (state.run.state === 'running' || state.run.state === 'interrupting') {
        state.run = {
          ...state.run,
          state: 'reconnecting',
          detail: 'The event stream dropped; Mona is reconnecting. The turn may still be running.',
        };
        this.pushState(state);
      }
      return;
    }
    if (code === 'oversize_event') {
      await this.pushItem(state, {
        seq: this.nextLocalSeq(state),
        turnId: state.run.turnId,
        kind: 'error',
        title: 'An event was too large',
        body: `${message}. The timeline is incomplete for that event; the raw sequence stays in Diagnostics.`,
        status: null,
        truncated: true,
      });
      return;
    }
    // Schema drift and thread mismatches are surfaced, never swallowed.
    await this.pushItem(state, {
      seq: this.nextLocalSeq(state),
      turnId: state.run.turnId,
      kind: 'error',
      title: 'The runtime sent something this build cannot read',
      body: `${code}: ${message}. Nothing was retried automatically. See Diagnostics for the raw sequence.`,
      status: null,
      truncated: false,
    });
  }

  private async handleEngineEvent(
    state: ProjectState,
    threadId: string,
    parsed: ParsedEngineEvent,
    seq: number,
  ): Promise<void> {
    const envelope = parsed.envelope;
    state.lastSeq = Math.max(state.lastSeq, seq);
    await this.store.touchThread(threadId, state.lastSeq);

    if (parsed.kind === 'unknown') {
      await this.handleUnrecognized(state, threadId, envelope.event, seq, envelope.payload, envelope.turnId);
      return;
    }

    switch (parsed.name) {
      case 'item.delta': {
        const payload = DeltaPayload.safeParse(envelope.payload);
        if (!payload.success) {
          this.diagnostic(state, `item.delta payload unreadable at seq ${seq}`);
          return;
        }
        await this.appendDelta(state, threadId, envelope.itemId, seq, payload.data.delta, envelope.turnId);
        return;
      }
      case 'approval.required': {
        const payload = z
          .object({
            approvalId: z.string().min(1),
            toolName: z.string().min(1),
            description: z.string().optional(),
          })
          .passthrough()
          .safeParse(envelope.payload);
        if (!payload.success) {
          this.diagnostic(state, `approval.required payload unreadable at seq ${seq}`);
          return;
        }
        state.pending = {
          kind: 'approval',
          approvalId: payload.data.approvalId,
          toolName: payload.data.toolName,
          description: payload.data.description ?? 'The runtime is waiting for approval to continue.',
          at: this.now().toISOString(),
        };
        state.run = {
          ...state.run,
          state: 'awaiting_approval',
          detail:
            'The runtime paused for an approval. Mona does not send approval decisions in this build; use Interrupt now to stop waiting.',
        };
        await this.pushItem(state, {
          seq,
          turnId: envelope.turnId,
          kind: 'approval',
          title: `Approval needed · ${payload.data.toolName}`,
          body: payload.data.description ?? 'No description was provided by the runtime.',
          status: 'pending',
          truncated: false,
        });
        this.pushState(state);
        return;
      }
      case 'turn.completed': {
        await this.completeTurn(state, threadId, seq, envelope.payload, envelope.turnId);
        return;
      }
      default:
        // stream.end is consumed by the adapter's stream loop, never delivered.
        this.diagnostic(state, `${parsed.name} seq ${seq}`);
        return;
    }
  }

  /**
   * The pinned runtime emits most of its lifecycle events under names Mona's
   * contract does not model. They are projected deliberately: a known shape gets
   * a timeline row, an unknown approval gets an honest pending card, and
   * everything else stays in Diagnostics instead of being invented as content.
   */
  private async handleUnrecognized(
    state: ProjectState,
    threadId: string,
    name: string,
    seq: number,
    payload: unknown,
    turnId: string | null,
  ): Promise<void> {
    switch (name) {
      case 'thread.started':
        this.diagnostic(state, `thread.started seq ${seq}`);
        return;
      case 'item.started':
      case 'item.completed': {
        const parsedItem = ItemPayload.safeParse(payload);
        if (!parsedItem.success) {
          this.diagnostic(state, `${name} payload unreadable at seq ${seq}`);
          return;
        }
        await this.projectItem(state, threadId, seq, turnId, parsedItem.data.item, name === 'item.completed');
        return;
      }
      case 'turn.started': {
        const started = TurnStartedPayload.safeParse(payload);
        const summary = started.success ? (started.data.turn.input_summary ?? '') : '';
        state.run = {
          ...state.run,
          state: 'running',
          turnId: started.success ? started.data.turn.id : state.run.turnId,
          detail: 'The runtime accepted the turn and started work.',
        };
        await this.pushItem(state, {
          seq,
          turnId,
          kind: 'status',
          title: 'Turn started',
          body: summary,
          status: 'in_progress',
          truncated: false,
        });
        this.pushState(state);
        return;
      }
      case 'turn.usage': {
        const usage = TurnUsagePayload.safeParse(payload);
        if (usage.success && turnId) {
          const shape = UsageShape.safeParse(usage.data.usage);
          if (shape.success) state.turnUsage.set(turnId, shape.data);
        }
        this.diagnostic(state, `turn.usage seq ${seq}`);
        return;
      }
      case 'turn.workspace_snapshot': {
        const snapshot = SnapshotPayload.safeParse(payload);
        if (snapshot.success && turnId) {
          const changed = snapshot.data.changed_paths ?? [];
          if (changed.length > 0) state.changedPaths.set(turnId, changed);
          this.diagnostic(
            state,
            `workspace snapshot ${snapshot.data.kind ?? 'unknown'}: ${changed.length} changed path(s)`,
          );
        }
        return;
      }
      case 'turn.lifecycle':
      case 'turn.provider_request':
      case 'model.tools.snapshot':
        this.diagnostic(state, `${name} seq ${seq}`);
        return;
      default:
        break;
    }

    this.diagnostic(state, `${name} seq ${seq}`);
    if (name.startsWith('approval.')) {
      // Never leave an unrecognized approval wait hidden behind a spinner.
      const shape = isRecord(payload) ? payload : {};
      state.pending = {
        kind: 'approval',
        approvalId: typeof shape.approvalId === 'string' ? shape.approvalId : `unknown:${seq}`,
        toolName: typeof shape.toolName === 'string' ? shape.toolName : 'unrecognized',
        description: 'The runtime asked for an approval through an event this build does not recognize.',
        at: this.now().toISOString(),
      };
      state.run = {
        ...state.run,
        state: 'awaiting_approval',
        detail: 'The runtime is waiting for an approval Mona cannot answer. Use Interrupt now to stop waiting.',
      };
      await this.pushItem(state, {
        seq,
        turnId,
        kind: 'approval',
        title: `Approval needed · ${name}`,
        body: 'This build does not recognize the runtime approval event. It is shown so it cannot wait unseen.',
        status: 'pending',
        truncated: false,
      });
      this.pushState(state);
    }
    void threadId;
  }

  private async projectItem(
    state: ProjectState,
    threadId: string,
    seq: number,
    turnId: string | null,
    item: z.infer<typeof ItemPayload>['item'],
    completed: boolean,
  ): Promise<void> {
    const visibility = item.metadata?.visibility;
    if (item.kind === 'status' && visibility === 'internal') {
      this.diagnostic(state, `internal status: ${item.summary ?? item.detail ?? '(no summary)'}`);
      return;
    }
    if (item.kind === 'status' && !(item.summary ?? item.detail ?? '').trim()) {
      this.diagnostic(state, `empty status item at seq ${seq}`);
      return;
    }
    const toolName = item.metadata?.tool_name;
    if (toolName && HUMAN_INPUT_TOOLS.has(toolName) && !completed) {
      state.pending = {
        kind: 'input',
        approvalId: item.id,
        toolName,
        description: truncate(item.detail ?? item.summary ?? 'The runtime is waiting for input.', 1_000),
        at: this.now().toISOString(),
      };
      state.run = {
        ...state.run,
        state: 'awaiting_approval',
        detail: 'The runtime asked for input Mona cannot provide in this build. Use Interrupt now to stop waiting.',
      };
    }
    if (toolName && HUMAN_INPUT_TOOLS.has(toolName) && completed && state.pending?.kind === 'input') {
      state.pending = null;
      if (state.run.state === 'awaiting_approval') {
        state.run = { ...state.run, state: 'running', detail: 'The runtime answered the input request.' };
      }
    }

    const existingId = state.byEngineItem.get(item.id) ?? null;
    let kind: TimelineKind = 'status';
    let title = `Item · ${item.kind}`;
    let body = item.detail ?? item.summary ?? '';
    if (item.kind === 'user_message') {
      kind = 'user';
      title = 'You';
    } else if (item.kind === 'agent_message') {
      kind = 'assistant';
      title = 'Assistant';
    } else if (item.kind === 'tool_call') {
      kind = 'tool';
      title = `Tool · ${toolName ?? 'unknown'}`;
      body = formatToolInput(item.metadata?.tool_input, item.detail);
    } else if (item.kind === 'tool_result') {
      kind = 'tool';
      title = `Result · ${toolName ?? 'tool'}`;
    }
    const bounded = this.bound(body);
    const itemId = existingId ?? `tl_${threadId}_${seq}`;
    const prior = state.items.get(itemId);
    const timeline: TimelineItem = {
      id: itemId,
      seq: prior?.item.seq ?? seq,
      turnId,
      kind,
      title,
      body: bounded.text,
      status: completed ? (item.status ?? 'completed') : (item.status ?? 'in_progress'),
      truncated: bounded.truncated,
      at: this.now().toISOString(),
    };
    if (!existingId) state.byEngineItem.set(item.id, itemId);
    state.items.set(itemId, {
      item: timeline,
      engineItemId: item.id,
      lastFlush: this.now().getTime(),
    });
    await this.store.putTimelineItem({
      id: timeline.id,
      projectId: state.projectId,
      threadId,
      turnId,
      seq: timeline.seq,
      kind,
      title,
      body: timeline.body,
      status: timeline.status,
      truncated: timeline.truncated,
    });
    this.emit({ type: 'item', projectId: state.projectId, item: timeline });
    if (bounded.truncated) {
      this.diagnostic(state, `timeline item ${timeline.id} truncated at ${this.maxItemChars} characters`);
    }
  }

  private async appendDelta(
    state: ProjectState,
    threadId: string,
    engineItemId: string | null,
    seq: number,
    delta: string,
    turnId: string | null,
  ): Promise<void> {
    if (!delta) return;
    const knownId = engineItemId ? state.byEngineItem.get(engineItemId) : undefined;
    const itemId = knownId ?? `tl_${threadId}_${seq}`;
    const existing = state.items.get(itemId);
    if (!existing) {
      const bounded = this.bound(delta);
      const item: TimelineItem = {
        id: itemId,
        seq,
        turnId,
        kind: 'assistant',
        title: 'Assistant',
        body: bounded.text,
        status: 'streaming',
        truncated: bounded.truncated,
        at: this.now().toISOString(),
      };
      state.items.set(itemId, {
        item,
        engineItemId: engineItemId ?? itemId,
        lastFlush: this.now().getTime(),
      });
      if (engineItemId) state.byEngineItem.set(engineItemId, itemId);
      await this.store.putTimelineItem({
        id: item.id,
        projectId: state.projectId,
        threadId,
        turnId,
        seq: item.seq,
        kind: item.kind,
        title: item.title,
        body: item.body,
        status: item.status,
        truncated: item.truncated,
      });
      this.emit({ type: 'delta', projectId: state.projectId, itemId, text: delta, seq });
      return;
    }
    const bounded = this.bound(existing.item.body + delta);
    existing.item = {
      ...existing.item,
      body: bounded.text,
      truncated: existing.item.truncated || bounded.truncated,
      status: 'streaming',
    };
    const nowMs = this.now().getTime();
    if (nowMs - existing.lastFlush >= this.flushIntervalMs) {
      existing.lastFlush = nowMs;
      await this.store.putTimelineItem({
        id: existing.item.id,
        projectId: state.projectId,
        threadId,
        turnId: existing.item.turnId,
        seq: existing.item.seq,
        kind: existing.item.kind,
        title: existing.item.title,
        body: existing.item.body,
        status: existing.item.status,
        truncated: existing.item.truncated,
      });
    }
    this.emit({ type: 'delta', projectId: state.projectId, itemId, text: delta, seq });
  }

  private async completeTurn(
    state: ProjectState,
    threadId: string,
    seq: number,
    rawPayload: unknown,
    envelopeTurnId: string | null,
  ): Promise<void> {
    const payload = TurnCompletedPayload.safeParse(rawPayload);
    if (!payload.success) {
      this.diagnostic(state, `turn.completed payload unreadable at seq ${seq}`);
      return;
    }
    const turn = payload.data.turn;
    // The envelope and the payload carry the same engine turn id in practice;
    // matching both keeps a mismatch from orphaning streamed items.
    const turnKeys = new Set([turn.id, envelopeTurnId].filter((value): value is string => typeof value === 'string'));
    const alreadySettled = [...turnKeys].some((key) => state.settledTurns.has(key));
    if (alreadySettled) return;
    for (const key of turnKeys) state.settledTurns.add(key);

    for (const entry of state.items.values()) {
      if (entry.item.turnId && turnKeys.has(entry.item.turnId) && entry.item.status === 'streaming') {
        entry.item = { ...entry.item, status: 'completed' };
        await this.store.putTimelineItem({
          id: entry.item.id,
          projectId: state.projectId,
          threadId,
          turnId: entry.item.turnId,
          seq: entry.item.seq,
          kind: entry.item.kind,
          title: entry.item.title,
          body: entry.item.body,
          status: entry.item.status,
          truncated: entry.item.truncated,
        });
        this.emit({ type: 'item', projectId: state.projectId, item: entry.item });
      }
    }

    const changed =
      firstDefined(turnKeys, (key) => state.changedPaths.get(key)) ??
      turn.workspace_snapshots?.find((snapshot) => snapshot.kind === 'post_turn')?.changed_paths ??
      [];
    const usage = await this.recordTurnUsage(state, threadId, turn.id, turn.usage);
    await this.store.recordTurn({ threadId, engineTurnId: turn.id, status: turn.status });
    state.queue.completeActive(turn.status);
    state.pending = null;
    const snapshot = state.queue.snapshot();
    state.run = {
      state: 'idle',
      detail: `Turn ${turn.status}. ${usage.summary}`,
      turnId: turn.id,
      submission: state.run.submission,
      startedAt: state.run.startedAt,
    };
    const body = [
      `Status: ${turn.status}`,
      turn.duration_ms !== undefined ? `Duration: ${(turn.duration_ms / 1000).toFixed(1)} s` : null,
      usage.lines.length > 0 ? `Usage: ${usage.lines.join(' · ')}` : null,
      usage.costLine,
      changed.length > 0 ? `Changed paths: ${changed.join(', ')}` : 'Changed paths: none reported by the runtime',
      snapshot.pauseRequested ? 'Queue: paused after this task' : null,
    ]
      .filter((line): line is string => typeof line === 'string' && line.length > 0)
      .join('\n');
    await this.pushItem(state, {
      seq,
      turnId: turn.id,
      kind: 'outcome',
      title: `Turn ${turn.status}`,
      body,
      status: turn.status,
      truncated: false,
    });
    this.attention?.({
      kind: turn.status === 'completed' ? 'run_completed' : 'run_failed',
      projectId: state.projectId,
      at: this.now().toISOString(),
      taskId: null,
      turnId: turn.id,
      outcome: turn.status,
    });
    this.pushState(state);
  }

  private async recordTurnUsage(
    state: ProjectState,
    threadId: string,
    turnId: string,
    rawUsage: unknown,
  ): Promise<{ summary: string; lines: string[]; costLine: string | null }> {
    const adapter = this.engine.adapter();
    const recorded = await this.store.threadUsageTotals(threadId);
    let evidence: UsageEvidence | null = null;
    let readError: string | null = null;
    if (adapter) {
      const read = await adapter.readUsage({ threadId });
      if (read.ok) evidence = read.value;
      else readError = `${read.error.code}: ${read.error.message}`;
    }

    const shapes = UsageShape.safeParse(rawUsage);
    const fallback = (shapes.success ? shapes.data : null) ?? state.turnUsage.get(turnId) ?? null;
    if (evidence) {
      const miss = Math.max(0, evidence.buckets.inputMissTokens - recorded.cacheMissTokens);
      const hit = Math.max(0, evidence.buckets.cacheHitTokens - recorded.cacheHitTokens);
      const out = Math.max(0, evidence.buckets.outputTokens - recorded.outputTokens);
      let costMicros: number | null = null;
      let costKnown = false;
      if (evidence.cost.status === 'known') {
        costMicros = Math.max(0, Math.round(evidence.cost.usd * 1_000_000) - recorded.knownCostMicros);
        costKnown = true;
      }
      const alreadyRecorded =
        recorded.records > 0 && miss === 0 && hit === 0 && out === 0 && (!costKnown || costMicros === 0);
      if (!alreadyRecorded) {
        this.store.recordUsage({
          projectId: state.projectId,
          threadId,
          turnId,
          cacheHitTokens: hit,
          cacheMissTokens: miss,
          outputTokens: out,
          costMicros,
          costKnown,
          source:
            evidence.cost.status === 'known'
              ? `engine_priced:thread_delta:${evidence.cost.rateRevision}`.slice(0, 200)
              : `engine_unpriced:${evidence.cost.reason}`.slice(0, 200),
        });
      }
      const lines = [
        `in ${miss.toLocaleString()} (${hit.toLocaleString()} cached)`,
        `out ${out.toLocaleString()}`,
        fallback?.reasoning_tokens ? `reasoning ${fallback.reasoning_tokens.toLocaleString()}` : null,
      ].filter((line): line is string => typeof line === 'string');
      return {
        summary:
          evidence.cost.status === 'known'
            ? 'Cost for this turn is engine-priced.'
            : `Token usage recorded; the engine reported no price (${evidence.cost.reason}).`,
        lines,
        costLine:
          evidence.cost.status === 'known'
            ? `Cost: $${(((costKnown ? costMicros : 0) ?? 0) / 1_000_000).toFixed(4)} (engine-priced thread delta; ${evidence.cost.rateRevision})`
            : `Cost: unknown (${evidence.cost.reason})`,
      };
    }

    // No priced usage could be read: record the engine's own token counts and
    // label the cost unknown rather than showing $0.00.
    if (fallback) {
      this.store.recordUsage({
        projectId: state.projectId,
        threadId,
        turnId,
        cacheHitTokens: fallback.prompt_cache_hit_tokens ?? null,
        cacheMissTokens: fallback.prompt_cache_miss_tokens ?? null,
        outputTokens: fallback.output_tokens ?? null,
        costKnown: false,
        source: 'engine_turn_usage_price_unknown',
      });
      return {
        summary: 'Token usage recorded; no pricing was available.',
        lines: [
          `${(fallback.input_tokens ?? 0).toLocaleString()} in`,
          `${(fallback.output_tokens ?? 0).toLocaleString()} out`,
        ],
        costLine: 'Cost: unknown (the runtime did not report a complete price)',
      };
    }
    if (readError) this.diagnostic(state, `usage read failed: ${readError}`);
    return {
      summary: 'No usage was reported for this turn.',
      lines: [],
      costLine: 'Cost: unknown (no usage reported)',
    };
  }

  private async pushItem(state: ProjectState, input: Omit<TimelineItem, 'id' | 'at'> & { id?: string }): Promise<void> {
    const threadId = state.threadId;
    if (!threadId) return;
    const bounded = this.bound(input.body);
    const item: TimelineItem = {
      id: input.id ?? `tl_${threadId}_${input.seq}`,
      seq: input.seq,
      turnId: input.turnId,
      kind: input.kind,
      title: input.title,
      body: bounded.text,
      status: input.status,
      truncated: input.truncated || bounded.truncated,
      at: this.now().toISOString(),
    };
    state.items.set(item.id, {
      item,
      engineItemId: item.id,
      lastFlush: this.now().getTime(),
    });
    await this.store.putTimelineItem({
      id: item.id,
      projectId: state.projectId,
      threadId,
      turnId: item.turnId,
      seq: item.seq,
      kind: item.kind,
      title: item.title,
      body: item.body,
      status: item.status,
      truncated: item.truncated,
    });
    this.emit({ type: 'item', projectId: state.projectId, item });
  }

  private nextLocalSeq(state: ProjectState): number {
    state.localSeq += 1;
    return state.localSeq;
  }

  private bound(text: string): { text: string; truncated: boolean } {
    if (text.length <= this.maxItemChars) return { text, truncated: false };
    return {
      text: `${text.slice(0, this.maxItemChars)}\n\n[output truncated at ${this.maxItemChars.toLocaleString()} characters]`,
      truncated: true,
    };
  }

  private boundReferences(references: unknown): string[] | null {
    if (references === undefined) return [];
    if (!Array.isArray(references) || references.length > MAX_REFERENCES) return null;
    const out: string[] = [];
    for (const raw of references) {
      if (typeof raw !== 'string') return null;
      const value = raw.trim();
      if (!value || value.length > MAX_REFERENCE_CHARS) return null;
      if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.split(/[\\/]/).includes('..')) return null;
      for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) return null;
      }
      out.push(value.split(path.sep).join('/'));
    }
    return [...new Set(out)];
  }

  private diagnostic(state: ProjectState, line: string): void {
    const text = redact(truncate(line, MAX_DIAGNOSTIC_CHARS));
    state.diagnostics.push(`${this.now().toISOString()} ${text}`);
    if (state.diagnostics.length > MAX_DIAGNOSTICS) {
      state.diagnostics.splice(0, state.diagnostics.length - MAX_DIAGNOSTICS);
    }
    this.emit({ type: 'diagnostic', projectId: state.projectId, line: text });
  }

  private controlFor(state: ProjectState): StudioControl {
    const snapshot = state.queue.snapshot();
    return {
      pauseRequested: snapshot.pauseRequested,
      queueState: snapshot.state,
      lastOutcome: snapshot.lastOutcome,
      interrupt: state.interrupt,
      blockedProblem: snapshot.blocked
        ? { problemId: snapshot.blocked.problemId, taskId: snapshot.blocked.taskId, detail: snapshot.blocked.detail }
        : null,
    };
  }

  private pushState(state: ProjectState): void {
    this.emit({
      type: 'state',
      projectId: state.projectId,
      thread: state.profile ? { ...state.profile } : null,
      run: { ...state.run },
      control: this.controlFor(state),
      pending: state.pending ? { ...state.pending } : null,
    });
  }

  private renderView(state: ProjectState, items: TimelineItem[], warning: string | null): StudioView {
    return {
      projectId: state.projectId,
      sessionId: state.sessionId,
      thread: state.profile ? { ...state.profile } : null,
      items,
      run: { ...state.run },
      control: this.controlFor(state),
      pending: state.pending ? { ...state.pending } : null,
      diagnostics: [...state.diagnostics],
      capabilities: {
        planMode: {
          status: 'supported',
          reason: 'Thread mode is chosen when the engine thread is created; switching modes starts a new thread.',
        },
        approvalResponse: {
          status: 'unsupported',
          reason:
            'The pinned runtime emits approval events, but Mona does not yet send approval decisions. A waiting approval is shown with Interrupt now.',
        },
        attachments: {
          status: 'unsupported',
          reason:
            'Mona’s turn contract sends text and explicit file references. This runtime API does not accept attachments here.',
        },
      },
      warning,
    };
  }
}

function firstDefined<T>(keys: Iterable<string>, get: (key: string) => T | undefined): T | undefined {
  for (const key of keys) {
    const value = get(key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function toTimelineItem(row: TimelineItemRow): TimelineItem {
  return {
    id: row.id,
    seq: row.seq,
    turnId: row.turnId,
    kind: row.kind as TimelineKind,
    title: row.title,
    body: row.body,
    status: row.status,
    truncated: row.truncated,
    at: row.createdAt,
  };
}

function parseProfile(row: StudioThreadRow): EffectiveProfile | null {
  if (!row.profileJson) return null;
  try {
    const raw = JSON.parse(row.profileJson) as unknown;
    const shape = z
      .object({
        threadId: z.string().min(1),
        workspace: z.string().min(1),
        provider: z.string().min(1),
        model: z.string().min(1),
        mode: z.enum(['agent', 'plan']),
        permissionPosture: z.enum(['full_access', 'workspace_write', 'read_only', 'unknown']),
        allowShell: z.boolean(),
        trustMode: z.boolean(),
        autoApprove: z.boolean(),
        observedAt: z.string(),
      })
      .strict()
      .safeParse(raw);
    return shape.success ? (shape.data as EffectiveProfile) : null;
  } catch {
    return null;
  }
}

export function toStudioProfile(profile: EffectiveProfile): StudioProfile {
  return {
    threadId: profile.threadId,
    workspace: profile.workspace,
    provider: profile.provider,
    model: profile.model,
    mode: profile.mode,
    permissionPosture: profile.permissionPosture,
    allowShell: profile.allowShell,
    trustMode: profile.trustMode,
    autoApprove: profile.autoApprove,
    observedAt: profile.observedAt,
  };
}

export function composePrompt(text: string, references: string[]): string {
  if (references.length === 0) return text;
  const lines = references.map((reference) => `- ${reference}`).join('\n');
  return `${text}\n\nFiles referenced by this request:\n${lines}`;
}

function formatToolInput(rawInput: string | undefined, detail: string | undefined): string {
  const candidate = rawInput ?? detail ?? '';
  if (!candidate) return '';
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return candidate;
  }
}

function explain(failure: {
  code: string;
  message: string;
  retryable: boolean;
  detail?: string | undefined;
}): ErrorResult {
  const code = failure.code as ErrorResult['code'];
  if (code === 'authentication_failed') {
    return errorResult(
      'authentication_failed',
      'The runtime could not authenticate with the provider. Fix the Codewhale credentials, then submit again.',
      false,
      failure.detail,
    );
  }
  if (code === 'permission_denied') {
    return errorResult(
      'permission_denied',
      'Windows denied the runtime access to this folder. Check the folder permissions.',
      false,
      failure.detail,
    );
  }
  if (code === 'capability_unsupported') {
    return errorResult(
      'capability_unsupported',
      'This runtime does not advertise the capability that action needs.',
      false,
      failure.detail,
    );
  }
  if (code === 'schema_drift' || code === 'thread_mismatch') {
    return errorResult(
      code,
      'The runtime answered in an unexpected shape. Nothing was retried; see Diagnostics.',
      false,
      failure.detail,
    );
  }
  if (code === 'transport_failed' || code === 'outcome_unknown') {
    return errorResult(
      code,
      'The request may not have reached the runtime. Mona reconciles with the operation key instead of resending.',
      failure.retryable,
      failure.detail,
    );
  }
  return errorResult(code, failure.message, failure.retryable, failure.detail);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function slice(error: unknown): string {
  return truncate(String(error), 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
