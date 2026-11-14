import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WorkQueue, redact, type AdapterStreamEvent, type EngineAdapter } from '@mona/adapter';
import {
  errorResult,
  newOperationKey,
  normalizeApprovalRequired,
  normalizeUserInputRequired,
  ThreadId,
  type EffectiveProfile,
  type ErrorResult,
  type ParsedEngineEvent,
  type UsageEvidence,
} from '@mona/contracts';
import type { CostLedger, ProjectStore, StudioThreadRow, TimelineItemRow, TimelinePage } from '@mona/project-state';
import { z } from 'zod';
import { conversationFileName, renderConversationMarkdown } from './conversation-export.js';
import type { EngineSummary } from './engine-host.js';
import type {
  StudioControl,
  StudioEvent,
  StudioExport,
  StudioHistoryPage,
  StudioHistoryWindow,
  StudioMode,
  StudioHumanAnswer,
  StudioPending,
  StudioQuestion,
  StudioProfile,
  StudioRun,
  StudioUsage,
  StudioSearchResult,
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
  /** Asks the user where an exported file should go; null means they cancelled. */
  saveFile?: (input: { title: string; defaultName: string; extensions: string[] }) => Promise<string | null>;
  /** The running application version, recorded in exported files. */
  appVersion?: () => string;
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
/** Rows returned for one stored-history window (initial load and each page). */
export const HISTORY_PAGE = 500;
/** Hard ceiling on a requested page, so a renderer cannot ask for a whole log. */
export const HISTORY_MAX_PAGE = 2_000;
const HISTORY_SEARCH_LIMIT = 100;
const HUMAN_INPUT_TOOLS = new Set(['request_user_input']);

/** One clarification question in the shape Mona records and renders. */
type HumanQuestionInput = {
  id: string;
  header: string | null;
  question: string | null;
  multiSelect: boolean;
  options: Array<{ label: string; description: string | null }>;
};
/** Statuses that mean a card will not grow again. */
const FINAL_ITEM_STATUSES = new Set(['completed', 'interrupted', 'failed', 'cancelled']);
/** Statuses that still accept streamed text. */
const STREAM_OPEN_STATUSES = new Set(['streaming', 'in_progress']);
const EMPTY_TIMELINE_PAGE: TimelinePage = {
  items: [],
  total: 0,
  oldestSeq: null,
  newestSeq: null,
  hasOlder: false,
  hasNewer: false,
};

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
  /** The thread this row belongs to: events never re-home across threads. */
  threadId: string;
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
  /** The thread the live subscription belongs to, so a mode switch rebinds. */
  subscriptionThreadId: string | null;
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
  /** `${threadId}:${engineItemId}` -> timeline item id, so threads never merge. */
  byEngineItem: Map<string, string>;
  /** turn key -> the row receiving deltas the runtime sent without an item id. */
  streamByTurn: Map<string, string>;
  /** `threadId:engineItemId` values whose item already reported completion. */
  completedEngineItems: Set<string>;
  /** Turn keys whose anonymous stream was already settled by a completion. */
  completedStreamTurns: Set<string>;
  lateDeltas: number;
  gaps: number;
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
  private readonly saveFile: StudioServiceDeps['saveFile'];
  private readonly appVersion: StudioServiceDeps['appVersion'];
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
    this.saveFile = deps.saveFile;
    this.appVersion = deps.appVersion;
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
          this.bindThread(state, threadRow.id, threadRow.lastSeq);
          // A bound thread with a live runtime gets a stream: events that arrived
          // while the window was closed are replayed from the stored cursor.
          this.maybeSubscribe(state, project.canonicalPath);
          await this.rehydratePending(state, threadRow.id);
        }
      }
      const page = threadRow
        ? await this.store.timelinePage(threadRow.id, { limit: HISTORY_PAGE })
        : EMPTY_TIMELINE_PAGE;
      const usage = await this.sessionUsage(projectId, sessionId);
      return {
        ok: true,
        data: this.renderView(state, page.items.map(toTimelineItem), windowOf(page), warning, usage),
      };
    } catch (error) {
      return { ok: false, error: errorResult('internal', 'The studio state could not be read.', true, slice(error)) };
    }
  }

  /**
   * One stored-history window by cursor. The studio's first load is the newest
   * window; older pages are fetched from here, so history is not capped at the
   * number of rows a single read returned. No model is involved.
   */
  async history(input: {
    projectId: string;
    sessionId: string;
    mode?: StudioMode;
    beforeSeq?: number;
    aroundSeq?: number;
    limit?: number;
  }): Promise<ServiceResult<StudioHistoryPage>> {
    try {
      const threadRow = await this.store.studioThreadForSession(input.projectId, input.sessionId, input.mode);
      if (!threadRow) {
        return { ok: false, error: errorResult('not_found', 'This session has no stored conversation yet.') };
      }
      const limit = boundPageLimit(input.limit);
      const page = await this.store.timelinePage(threadRow.id, {
        limit,
        ...(typeof input.beforeSeq === 'number' ? { beforeSeq: Math.trunc(input.beforeSeq) } : {}),
        ...(typeof input.aroundSeq === 'number' ? { aroundSeq: Math.trunc(input.aroundSeq) } : {}),
      });
      return { ok: true, data: { items: page.items.map(toTimelineItem), window: windowOf(page) } };
    } catch (error) {
      return { ok: false, error: errorResult('internal', 'Stored history could not be read.', true, slice(error)) };
    }
  }

  /**
   * Search the stored conversation for this thread. Older content stays
   * reachable after its window has been released from memory, and a result is
   * only a sequence number the UI can page to.
   */
  async searchHistory(input: {
    projectId: string;
    sessionId: string;
    mode?: StudioMode;
    query: string;
  }): Promise<ServiceResult<StudioSearchResult>> {
    try {
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (!query) return { ok: true, data: { query, items: [], total: 0 } };
      if (query.length > 200) {
        return { ok: false, error: errorResult('invalid_request', 'Search for at most 200 characters.') };
      }
      const threadRow = await this.store.studioThreadForSession(input.projectId, input.sessionId, input.mode);
      if (!threadRow) return { ok: true, data: { query, items: [], total: 0 } };
      const found = await this.store.searchTimelineItems(threadRow.id, query, HISTORY_SEARCH_LIMIT);
      return {
        ok: true,
        data: { query, items: found.matches.map(toTimelineItem), total: found.total },
      };
    } catch (error) {
      return {
        ok: false,
        error: errorResult('internal', 'The stored conversation could not be searched.', true, slice(error)),
      };
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
    const mode: StudioMode = input.mode === 'plan' ? 'plan' : 'agent';

    const project = await this.store.getProject(input.projectId);
    if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
    const references = this.boundReferences(input.references, project.canonicalPath);
    if (!references.ok) {
      return { ok: false, error: errorResult('invalid_request', references.reason) };
    }
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
    // Claim the dispatch slot in the same tick as the guard above. The budget
    // evaluation and the thread lookup below await, so a second invoke arriving
    // while they are in flight would otherwise pass the same guard and send the
    // prompt twice. `preparing` is already a refused run state, so the claim is
    // visible to the UI and to the next caller immediately.
    const previousRun = state.run;
    state.run = {
      state: 'preparing',
      detail: 'Checking the budget and preparing the engine thread. No prompt has been sent yet.',
      turnId: null,
      submission: null,
      startedAt: null,
    };
    this.pushState(state);
    const release = (error: ErrorResult): ServiceResult<StudioSubmission> => {
      state.run = previousRun;
      this.pushState(state);
      return { ok: false, error };
    };

    if (state.queue.snapshot().blocked) {
      const blocked = state.queue.snapshot().blocked;
      return release(
        errorResult(
          'invalid_request',
          `Dispatch is blocked by problem ${blocked?.problemId ?? 'unknown'}. Record new evidence or a Victor decision first.`,
        ),
      );
    }
    if (state.queue.snapshot().pauseRequested) {
      return release(
        errorResult('invalid_request', 'The queue is paused after the last task. Resume to send new work.'),
      );
    }
    if (this.costs) {
      const budget = await this.costs.evaluateBudget({ projectId: input.projectId, sessionId: input.sessionId });
      if (budget.action === 'block_next_dispatch') {
        const detail = budget.decisions
          .filter((decision) => decision.action === 'block_next_dispatch')
          .map((decision) => decision.detail)
          .join('; ');
        return release(
          errorResult(
            'invalid_request',
            'The configured cost budget stops the next dispatch. In-flight work is not interrupted.',
            false,
            detail || undefined,
          ),
        );
      }
      if (budget.action === 'warn') {
        this.diagnostic(state, `budget warning: ${budget.decisions.map((decision) => decision.detail).join('; ')}`);
      }
    }

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
    const prompt = composePrompt(text, references.paths);
    const submitted = await adapter.submitTurn({
      threadId,
      prompt,
      // One key per accepted user action. The adapter journals it before the POST,
      // so an uncertain outcome reconciles against this exact key rather than
      // minting a fresh one and risking a second paid turn.
      operationKey: newOperationKey('turn'),
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

  /**
   * Whether a turn is in flight for exactly this project session. A new
   * conversation refuses while this is non-null so busy work stays attached to
   * the thread that owns it.
   */
  sessionBusy(projectId: string, sessionId: string): { turnId: string | null; state: string } | null {
    const state = this.states.get(`${projectId}:${sessionId}`);
    if (!state) return null;
    if (!['preparing', 'running', 'interrupting', 'awaiting_approval', 'reconnecting'].includes(state.run.state)) {
      return null;
    }
    return { turnId: state.run.turnId, state: state.run.state };
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

  /**
   * Answer the pending runtime request.
   *
   * The reply is addressed to the runtime request id recorded with the request,
   * never to "the current card": a stale window, a project switch or a second
   * click cannot decide a newer question. The right to send is claimed in the
   * database, so two clicks produce one decision, and the claim is released when
   * the send fails so the human can try again. Nothing here retries with a new
   * identity: a lost acknowledgement keeps the card and says so.
   */
  async respond(input: {
    projectId: string;
    sessionId: string;
    mode?: StudioMode;
    requestId: string;
    decision?: 'allow' | 'deny';
    remember?: boolean;
    answers?: Array<{ id: string; label: string; value: string }>;
  }): Promise<ServiceResult<StudioHumanAnswer>> {
    const state = this.states.get(`${input.projectId}:${input.sessionId}`);
    const threadId = state?.threadId ?? null;
    if (!state || !threadId) {
      return {
        ok: false,
        error: errorResult('not_found', 'No live studio thread is bound to this session, so nothing can be answered.'),
      };
    }
    const records = await this.store.listHumanRequests(input.projectId, { threadId, limit: 50 });
    const record = records.find((row) => row.engineRequestId === input.requestId) ?? null;
    if (!record) {
      return {
        ok: false,
        error: errorResult('not_found', 'That request is not one Mona recorded for this thread.'),
      };
    }
    if (record.status === 'answered') {
      return {
        ok: false,
        error: errorResult('conflict', 'That request was already answered. Nothing was sent again.'),
      };
    }
    if (record.status === 'expired' || record.status === 'canceled') {
      return {
        ok: false,
        error: errorResult(
          'conflict',
          record.status === 'expired'
            ? 'The runtime timed this request out. Nothing was sent.'
            : 'The runtime canceled this request. Nothing was sent.',
        ),
      };
    }

    // Validate the answer against the schema recorded with the request, not the
    // one the renderer happens to show.
    let payload: {
      decision?: 'allow' | 'deny';
      remember: boolean;
      answers: Array<{ id: string; label: string; value: string }>;
    };
    if (record.kind === 'approval') {
      const decision = input.decision ?? null;
      if (decision === null || !record.permitted.decisions.includes(decision)) {
        return {
          ok: false,
          error: errorResult('invalid_request', 'That approval accepts only an allow or deny decision.'),
        };
      }
      payload = { decision, remember: input.remember === true, answers: [] };
    } else {
      const questions = record.question.questions;
      const answers = (input.answers ?? []).map((answer) => ({
        id: String(answer.id ?? '').slice(0, 200),
        label: String(answer.label ?? '').slice(0, 200),
        value: String(answer.value ?? '').slice(0, 2_000),
      }));
      const byId = new Map<string, typeof answers>();
      for (const answer of answers) {
        if (!answer.id) continue;
        byId.set(answer.id, [...(byId.get(answer.id) ?? []), answer]);
      }
      for (const question of questions) {
        const given = byId.get(question.id) ?? [];
        if (given.length === 0) {
          return {
            ok: false,
            error: errorResult('invalid_request', `Question "${question.header ?? question.id}" needs an answer.`),
          };
        }
        if (!question.multiSelect && given.length > 1) {
          return {
            ok: false,
            error: errorResult('invalid_request', `Question "${question.header ?? question.id}" accepts one answer.`),
          };
        }
        const allowed = new Set(question.options.map((option) => option.label));
        for (const answer of given) {
          if (answer.label !== 'Other' && !allowed.has(answer.label)) {
            return { ok: false, error: errorResult('invalid_request', 'That option is not part of this question.') };
          }
        }
      }
      for (const id of byId.keys()) {
        if (!questions.some((question) => question.id === id)) {
          return {
            ok: false,
            error: errorResult('invalid_request', 'The answer named a question this request does not have.'),
          };
        }
      }
      payload = { remember: false, answers };
    }

    const claimed = await this.store.claimHumanRequest({
      projectId: input.projectId,
      threadId,
      engineRequestId: record.engineRequestId,
    });
    if (!claimed) {
      return { ok: false, error: errorResult('not_found', 'That request is no longer recorded for this thread.') };
    }
    if (!claimed.claimed) {
      return {
        ok: false,
        error: errorResult('conflict', 'That answer is already being sent. Wait for the runtime to acknowledge it.'),
      };
    }

    const adapter = this.engine.adapter();
    if (!adapter) {
      await this.store.releaseHumanRequest({ threadId, engineRequestId: record.engineRequestId });
      return {
        ok: false,
        error: errorResult('engine_unavailable', 'The runtime is not connected, so nothing was sent.', true),
      };
    }

    const receipt =
      record.kind === 'approval'
        ? await adapter.respondToApproval({
            threadId,
            approvalId: record.engineRequestId,
            decision: payload.decision as 'allow' | 'deny',
            remember: payload.remember,
          })
        : await adapter.respondToUserInput({ threadId, requestId: record.engineRequestId, answers: payload.answers });

    if (!receipt.ok) {
      await this.store.releaseHumanRequest({ threadId, engineRequestId: record.engineRequestId });
      this.diagnostic(state, `reply ${record.kind} ${record.engineRequestId}: refused (${receipt.error.code})`);
      const message =
        receipt.error.code === 'not_found'
          ? 'The runtime no longer holds that request. It may have expired or already been answered elsewhere. Nothing was sent again.'
          : receipt.error.message;
      const expired = receipt.error.code === 'not_found';
      if (expired) {
        await this.store.settleHumanRequest({
          threadId,
          engineRequestId: record.engineRequestId,
          status: 'expired',
          acknowledgement: { code: receipt.error.code, detail: receipt.error.detail ?? null },
        });
        state.pending = null;
        this.pushState(state);
      }
      return { ok: false, error: errorResult(receipt.error.code, message, receipt.error.retryable === true) };
    }

    const acknowledgement = receipt.value;
    await this.store.settleHumanRequest({
      threadId,
      engineRequestId: record.engineRequestId,
      status: 'answered',
      answer: { ...payload },
      acknowledgement,
    });
    state.pending = null;
    if (state.run.state === 'awaiting_approval') {
      state.run = {
        ...state.run,
        state: 'running',
        detail:
          record.kind === 'approval'
            ? `Decision acknowledged by the runtime (${payload.decision}).`
            : 'Answer acknowledged by the runtime.',
      };
    }
    await this.pushItem(state, threadId, {
      seq: this.nextLocalSeq(state),
      turnId: state.run.turnId,
      kind: 'status',
      title: record.kind === 'approval' ? `Approval answered · ${payload.decision}` : 'Answer sent',
      body:
        record.kind === 'approval'
          ? `Mona sent ${payload.decision} for ${record.toolName ?? 'the tool request'} and the runtime acknowledged it.`
          : `Mona sent ${payload.answers.length} answer(s) and the runtime acknowledged them.`,
      status: 'completed',
      truncated: false,
    });
    this.pushState(state);
    return {
      ok: true,
      data: {
        requestId: record.engineRequestId,
        status: 'answered',
        decision: record.kind === 'approval' ? (payload.decision as 'allow' | 'deny') : null,
        answers: payload.answers,
        acknowledged: true,
        detail:
          record.kind === 'approval'
            ? 'The runtime acknowledged the decision.'
            : 'The runtime acknowledged the answer.',
      },
    };
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

  /**
   * Export the recorded conversation as Markdown. This is a copy of what the
   * runtime already produced, written to a path the user picks: no model call,
   * no summarization, and no item is silently dropped (a truncated item keeps
   * its truncation note in the file).
   */
  async exportConversation(input: {
    projectId: string;
    sessionId: string;
    mode?: StudioMode;
  }): Promise<ServiceResult<StudioExport>> {
    const project = await this.store.getProject(input.projectId);
    if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
    if (!this.saveFile) {
      return {
        ok: false,
        error: errorResult('capability_unsupported', 'Saving a file is not available in this window.'),
      };
    }
    const threadRow = await this.store.studioThreadForSession(input.projectId, input.sessionId, input.mode);
    // The whole stored conversation is exported, page by page, so a session
    // larger than one window is not silently published as a shorter one.
    const items: TimelineItem[] = [];
    let stored = 0;
    if (threadRow) {
      for await (const rows of this.store.iterateTimelineItems(threadRow.id, HISTORY_PAGE)) {
        stored += rows.length;
        items.push(...rows.map(toTimelineItem));
      }
    }
    if (items.length === 0) {
      return {
        ok: false,
        error: errorResult('not_found', 'This session has no recorded events, so there is nothing to export.'),
      };
    }
    const profile = threadRow ? parseProfile(threadRow) : null;
    const thread = profile ? toStudioProfile(profile) : null;
    const at = this.now();
    const fileName = conversationFileName(project.label, input.sessionId, at);
    const target = await this.saveFile({
      title: 'Export this conversation',
      defaultName: fileName,
      extensions: ['md'],
    });
    const truncatedItems = items.filter((item) => item.truncated).length;
    if (!target) {
      return {
        ok: true,
        data: {
          saved: false,
          path: null,
          fileName,
          bytes: 0,
          sha256: null,
          items: items.length,
          truncatedItems,
          note: 'Export cancelled. Nothing was written.',
        },
      };
    }
    if (!path.isAbsolute(target)) {
      return { ok: false, error: errorResult('invalid_request', 'The export path must be absolute.') };
    }
    const text = renderConversationMarkdown({
      projectLabel: project.label,
      workspace: project.canonicalPath,
      sessionId: input.sessionId,
      thread,
      items,
      exportedAt: at.toISOString(),
      appVersion: this.appVersion?.() ?? 'version unknown',
      totalStored: stored,
    });
    // Write through a temporary name so an interrupted export never leaves a
    // half file where a complete one used to be.
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, text, 'utf8');
      renameSync(temp, target);
    } catch {
      rmSync(temp, { recursive: false, force: true });
      return {
        ok: false,
        error: errorResult('internal', 'The conversation could not be written to that location.'),
      };
    }
    return {
      ok: true,
      data: {
        saved: true,
        path: target,
        fileName,
        bytes: Buffer.byteLength(text, 'utf8'),
        sha256: createHash('sha256').update(text).digest('hex'),
        items: items.length,
        truncatedItems,
        note: 'Exported the recorded timeline exactly as stored. No model was called.',
      },
    };
  }

  /** Called when the owned runtime stops: live turns become honestly uncertain. */
  engineStopped(detail: string): void {
    for (const state of this.states.values()) {
      if (state.run.state === 'idle' || state.run.state === 'failed') continue;
      state.controller?.abort();
      state.controller = null;
      state.subscription = null;
      state.subscriptionThreadId = null;
      state.run = {
        ...state.run,
        state: 'failed',
        detail: `The engine stopped while this turn was active. Its outcome is uncertain: ${detail}`,
      };
      state.pending = null;
      this.diagnostic(state, 'engine stopped; active turn outcome unknown');
      // Text that was still arriving is not a finished answer: close the cards
      // so a reload cannot show them as complete.
      if (state.threadId) {
        void this.interruptOpenStreams(state, state.threadId, `the engine stopped: ${detail}`).catch(() => undefined);
      }
      this.pushState(state);
    }
  }

  /** Abort every subscription; used on quit and in tests. */
  close(): void {
    for (const state of this.states.values()) {
      state.controller?.abort();
      state.controller = null;
      state.subscription = null;
      state.subscriptionThreadId = null;
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
      subscriptionThreadId: null,
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
      streamByTurn: new Map(),
      completedEngineItems: new Set(),
      completedStreamTurns: new Set(),
      lateDeltas: 0,
      gaps: 0,
    };
    this.states.set(key, created);
    return created;
  }

  private findState(projectId: string): ProjectState | null {
    const matches = [...this.states.values()].filter((state) => state.projectId === projectId);
    return matches[matches.length - 1] ?? null;
  }

  private bindThread(state: ProjectState, threadId: string, lastSeq: number): void {
    if (state.threadId !== threadId) {
      // A different engine thread owns a different cursor and different item
      // identities. Nothing from the previous thread may carry over.
      state.threadId = threadId;
      state.lastSeq = lastSeq;
      state.streamByTurn.clear();
      this.detachSubscription(state);
      return;
    }
    state.lastSeq = Math.max(state.lastSeq, lastSeq);
  }

  private detachSubscription(state: ProjectState): void {
    state.controller?.abort();
    state.controller = null;
    state.subscription = null;
    state.subscriptionThreadId = null;
  }

  private maybeSubscribe(state: ProjectState, projectPath: string, adapter?: EngineAdapter): void {
    if (!state.threadId) return;
    if (state.controller && state.subscriptionThreadId !== state.threadId) {
      // The user switched thread (Plan/Work or another session); the old stream
      // must not keep delivering another thread's events.
      this.detachSubscription(state);
    }
    if (state.subscription || state.controller) return;
    const summary = this.engine.summary();
    if (summary.state !== 'connected' || summary.workspace !== projectPath) return;
    const live = adapter ?? this.engine.adapter();
    if (!live) return;
    const threadId = state.threadId;
    const controller = new AbortController();
    state.controller = controller;
    state.subscriptionThreadId = threadId;
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
      case 'reconnected': {
        this.diagnostic(state, `reconnected at seq ${event.sinceSeq} (attempt ${event.attempt})`);
        // The subscription resumes from its own last delivered frame. If that is
        // beyond what this process saw, frames were genuinely lost: an answer
        // that was mid-stream is closed as interrupted instead of completed.
        if (event.sinceSeq > state.lastSeq + 1) {
          const skipped = event.sinceSeq - state.lastSeq - 1;
          state.gaps += skipped;
          await this.interruptOpenStreams(
            state,
            threadId,
            `the stream resumed at seq ${event.sinceSeq} after ${skipped} undelivered frame(s)`,
          );
          await this.pushItem(state, threadId, {
            seq: this.nextLocalSeq(state),
            turnId: state.run.turnId,
            kind: 'status',
            title: 'Event stream resumed past missing frames',
            body: `The runtime resumed the stream at sequence ${event.sinceSeq}. ${skipped} frame(s) were not delivered to Mona, so any answer that was mid-stream is marked interrupted rather than completed. Nothing was retried.`,
            status: 'interrupted',
            truncated: false,
          });
        }
        if (state.run.state === 'reconnecting') {
          state.run = { ...state.run, state: 'running', detail: 'Reconnected to the runtime event stream.' };
          this.pushState(state);
        }
        return;
      }
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
        await this.handleDiagnostic(state, threadId, event.failure.code, event.failure.message, event.failure.detail);
        return;
      default:
        return;
    }
  }

  private async handleDiagnostic(
    state: ProjectState,
    threadId: string,
    code: string,
    message: string,
    detail?: string,
  ): Promise<void> {
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
      await this.pushItem(state, threadId, {
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
    await this.pushItem(state, threadId, {
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
    // The subscription and the envelope must agree on the thread. A mismatch is
    // a runtime defect; its payload is never projected into this thread.
    if (envelope.threadId !== threadId) {
      this.diagnostic(state, `event for another thread at seq ${seq} ignored (thread_mismatch)`);
      return;
    }
    // A skipped sequence number is recorded as a fact, never silently treated as
    // lost text: the runtime may filter frames (heartbeats, internal status) and
    // arriving seqs stay contiguous for content Mona renders.
    if (state.lastSeq > 0 && seq > state.lastSeq + 1) {
      const missed = seq - state.lastSeq - 1;
      state.gaps += missed;
      this.diagnostic(state, `sequence gap ${state.lastSeq} → ${seq} (${missed} frame(s) not delivered)`);
    }
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
        const request = normalizeApprovalRequired(envelope.payload);
        if (!request) {
          this.diagnostic(state, `approval.required payload unreadable at seq ${seq}`);
          return;
        }
        await this.recordHumanRequest(state, threadId, seq, envelope.turnId, {
          kind: 'approval',
          engineRequestId: request.approvalId,
          toolName: request.toolName,
          description: request.description,
          intentSummary: request.intentSummary,
          questions: [],
        });
        return;
      }
      case 'user_input.required': {
        const request = normalizeUserInputRequired(envelope.payload);
        if (!request) {
          this.diagnostic(state, `user_input.required payload unreadable at seq ${seq}`);
          return;
        }
        await this.recordHumanRequest(state, threadId, seq, envelope.turnId, {
          kind: 'input',
          engineRequestId: request.requestId,
          toolName: 'request_user_input',
          description:
            request.questions
              .map((question) => question.question ?? question.header ?? question.id)
              .join(' · ')
              .slice(0, 1_000) || 'The runtime asked a question.',
          intentSummary: null,
          questions: request.questions.map((question) => ({
            id: question.id,
            header: question.header ?? null,
            question: question.question ?? null,
            multiSelect: question.multi_select === true,
            options: (question.options ?? []).map((option) => ({
              label: option.label,
              description: option.description ?? null,
            })),
          })),
        });
        return;
      }
      case 'approval.decided':
      case 'approval.timeout':
      case 'user_input.answered':
      case 'user_input.canceled': {
        await this.settleHumanRequestEvent(
          state,
          threadId,
          parsed.name,
          envelope.payload,
          parsed.name === 'approval.timeout' || parsed.name === 'user_input.canceled' ? 'canceled' : 'answered',
        );
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
        await this.pushItem(state, threadId, {
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
      const fallbackId = typeof shape.approvalId === 'string' ? shape.approvalId : `unknown:${seq}`;
      state.pending = {
        kind: 'approval',
        requestId: fallbackId,
        approvalId: fallbackId,
        toolName: typeof shape.toolName === 'string' ? shape.toolName : 'unrecognized',
        description: 'The runtime asked for an approval through an event this build does not recognize.',
        intentSummary: null,
        decisions: ['allow', 'deny'],
        at: this.now().toISOString(),
      };
      state.run = {
        ...state.run,
        state: 'awaiting_approval',
        detail: 'The runtime is waiting for an approval Mona cannot answer. Use Interrupt now to stop waiting.',
      };
      await this.pushItem(state, threadId, {
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
  }

  /**
   * Restore the pending request from the database. The engine may not replay it
   * after a reload, reconnect or restart, and a waiting turn whose card vanished
   * would silently block the session.
   */
  private async rehydratePending(state: ProjectState, threadId: string): Promise<void> {
    if (state.pending) return;
    const rows = await this.store.listHumanRequests(state.projectId, { threadId, status: 'pending', limit: 5 });
    const row = rows[0];
    if (!row) return;
    state.pending =
      row.kind === 'approval'
        ? {
            kind: 'approval',
            requestId: row.engineRequestId,
            approvalId: row.engineRequestId,
            toolName: row.toolName ?? 'unknown',
            description: row.question.description,
            intentSummary: row.question.intentSummary,
            decisions: row.permitted.decisions,
            at: row.createdAt,
          }
        : {
            kind: 'input',
            requestId: row.engineRequestId,
            approvalId: row.engineRequestId,
            toolName: row.toolName ?? 'request_user_input',
            description: row.question.description,
            questions: row.question.questions,
            freeText: row.permitted.freeText,
            at: row.createdAt,
          };
    // A pending request *is* the run state: something is waiting, whatever the
    // fresh process would otherwise have assumed about the turn.
    state.run = {
      ...state.run,
      state: 'awaiting_approval',
      detail:
        'A recorded request is still waiting for an answer. Answer it here; Interrupt now stops waiting without deciding.',
    };
    this.diagnostic(state, `restored pending ${row.kind} request ${row.engineRequestId} from local state`);
  }

  /**
   * Usage for the session on screen, read from recorded rows only. A session with
   * nothing recorded reports null rather than a zero that would look like a free
   * turn, and unpriced records stay counted as unknown.
   */
  private async sessionUsage(projectId: string, sessionId: string): Promise<StudioUsage | null> {
    if (!this.costs) return null;
    try {
      const lens = await this.costs.lens(projectId);
      const session = lens.bySession.find((entry) => entry.sessionId === sessionId);
      if (!session || session.totals.records === 0) return null;
      return {
        scope: 'session',
        sessionId,
        records: session.totals.records,
        knownMicros: session.totals.knownMicros,
        unknownRecords: session.totals.unknownRecords,
        tokens: {
          input: session.totals.tokens.input,
          output: session.totals.tokens.output,
          cacheHit: session.totals.tokens.cacheHit,
          cacheMiss: session.totals.tokens.cacheMiss,
          reasoning: session.totals.tokens.reasoning,
        },
        // The pinned deepseek route reports reasoning inside the output count
        // (D-0014); the label says so instead of implying a separate bucket.
        reasoningIncludedInOutput: true,
        capturedAt: this.now().toISOString(),
      };
    } catch {
      // Usage is a readout, not a gate: a failed read must not break the studio.
      return null;
    }
  }

  /**
   * Record a pending human request durably, then project it. The database row is
   * what makes the card survive a reload, a reconnect or a restart: the engine
   * may not replay the request, and a card that only lives in memory would leave
   * a waiting turn unanswered.
   */
  private async recordHumanRequest(
    state: ProjectState,
    threadId: string,
    seq: number,
    turnId: string | null,
    input: {
      kind: 'approval' | 'input';
      engineRequestId: string;
      toolName: string;
      description: string;
      intentSummary: string | null;
      questions: HumanQuestionInput[];
    },
  ): Promise<void> {
    const questions = input.questions;
    let recorded: Awaited<ReturnType<ProjectStore['recordHumanRequest']>>;
    try {
      recorded = await this.store.recordHumanRequest({
        projectId: state.projectId,
        threadId,
        turnId,
        kind: input.kind,
        engineRequestId: input.engineRequestId,
        toolName: input.toolName,
        question: { description: input.description, intentSummary: input.intentSummary, questions },
        permitted: { decisions: ['allow', 'deny'], freeText: true },
      });
    } catch (error) {
      this.diagnostic(state, `human request ${input.engineRequestId} could not be recorded: ${slice(error)}`);
      return;
    }
    if (recorded.request.status !== 'pending') {
      this.diagnostic(
        state,
        `request ${input.engineRequestId} is already ${recorded.request.status}; the card is not shown again`,
      );
      return;
    }
    state.pending =
      input.kind === 'approval'
        ? {
            kind: 'approval',
            requestId: input.engineRequestId,
            approvalId: input.engineRequestId,
            toolName: input.toolName,
            description: input.description,
            intentSummary: input.intentSummary,
            decisions: recorded.request.permitted.decisions,
            at: recorded.request.createdAt,
          }
        : {
            kind: 'input',
            requestId: input.engineRequestId,
            approvalId: input.engineRequestId,
            toolName: input.toolName,
            description: input.description,
            questions,
            freeText: recorded.request.permitted.freeText,
            at: recorded.request.createdAt,
          };
    state.run = {
      ...state.run,
      state: 'awaiting_approval',
      detail:
        input.kind === 'approval'
          ? 'The runtime paused for an approval. Answer it here; Interrupt now stops waiting without deciding.'
          : 'The runtime asked a question. Answer it here; Interrupt now stops waiting without answering.',
    };
    if (recorded.created) {
      await this.pushItem(state, threadId, {
        seq,
        turnId,
        kind: 'approval',
        title:
          input.kind === 'approval'
            ? `Approval needed · ${input.toolName}`
            : `Input needed · ${questions.length} question(s)`,
        body: input.description,
        status: 'pending',
        truncated: false,
      });
    }
    this.pushState(state);
  }

  /**
   * Project the runtime's own terminal event for a request Mona may be showing.
   * The durable row settles either way, so a decision Mona did not send (another
   * client, a timeout) cannot leave a card that still looks answerable.
   */
  private async settleHumanRequestEvent(
    state: ProjectState,
    threadId: string,
    name: string,
    payload: unknown,
    status: 'answered' | 'canceled',
  ): Promise<void> {
    const shape = isRecord(payload) ? payload : {};
    const id = [shape.approval_id, shape.approvalId, shape.request_id, shape.input_id, shape.id].find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    if (!id) {
      this.diagnostic(state, `${name} carried no request id; nothing was settled`);
      return;
    }
    const settled = await this.store.settleHumanRequest({
      threadId,
      engineRequestId: id,
      status: status === 'canceled' ? 'canceled' : 'answered',
      acknowledgement: { source: name },
    });
    if (!settled) {
      this.diagnostic(state, `${name} for ${id}, which Mona has no record of`);
      return;
    }
    if (state.pending?.requestId === id) {
      state.pending = null;
      if (state.run.state === 'awaiting_approval') {
        state.run = {
          ...state.run,
          state: 'running',
          detail:
            status === 'canceled'
              ? 'The runtime ended that request without an answer from Mona.'
              : 'The runtime reported that request answered.',
        };
      }
    }
    this.diagnostic(state, `${name}: request ${id} settled as ${settled.status}`);
    this.pushState(state);
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
      // A request_user_input tool call is the second way the runtime announces a
      // clarification. The item carries the questions as JSON; the item id is the
      // only identity this event offers, so a refusal from the runtime is
      // reported as such rather than retried under a guessed id.
      const asked = parseAskedQuestions(item.metadata?.tool_input);
      state.pending = {
        kind: 'input',
        requestId: item.id,
        approvalId: item.id,
        toolName,
        description: truncate(item.detail ?? item.summary ?? 'The runtime is waiting for input.', 1_000),
        questions: asked.questions,
        freeText: true,
        at: this.now().toISOString(),
      };
      state.run = {
        ...state.run,
        state: 'awaiting_approval',
        detail:
          asked.questions.length > 0
            ? 'The runtime asked a question. Answer it here; Interrupt now stops waiting without answering.'
            : 'The runtime asked for input Mona cannot shape into an answer. Use Interrupt now to stop waiting.',
      };
    }
    if (toolName && HUMAN_INPUT_TOOLS.has(toolName) && completed && state.pending?.kind === 'input') {
      state.pending = null;
      if (state.run.state === 'awaiting_approval') {
        state.run = { ...state.run, state: 'running', detail: 'The runtime answered the input request.' };
      }
    }

    const engineKey = engineItemKey(threadId, item.id);
    const existingId = state.byEngineItem.get(engineKey) ?? null;
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
    // A completion for an answer whose deltas arrived without an item id adopts
    // that row instead of adding a second card for the same text. Adoption is
    // refused when the open stream is ambiguous: two answers are never merged.
    const adoptedId =
      !existingId && completed && kind === 'assistant' ? this.adoptableStream(state, threadId, turnId) : null;
    const itemId = existingId ?? adoptedId ?? `tl_${threadId}_${seq}`;
    const prior = state.items.get(itemId);
    const timeline: TimelineItem = {
      id: itemId,
      // An adopted row keeps the sequence where its text began; the card must
      // stay where the reader saw it start, not jump to the completion frame.
      seq: prior?.item.seq ?? seq,
      turnId: turnId ?? prior?.item.turnId ?? null,
      kind,
      title,
      body: bounded.text,
      status: completed ? (item.status ?? 'completed') : (item.status ?? 'in_progress'),
      truncated: bounded.truncated || (prior?.item.truncated ?? false),
      at: this.now().toISOString(),
    };
    const outcome = await this.store.putTimelineItem({
      id: timeline.id,
      projectId: state.projectId,
      threadId,
      turnId: timeline.turnId,
      seq: timeline.seq,
      kind,
      title,
      body: timeline.body,
      status: timeline.status,
      truncated: timeline.truncated,
    });
    if (outcome === 'duplicate') {
      // Another row already owns this sequence number: a replayed event is not a
      // second event, and it must not replace that row's identity.
      this.diagnostic(state, `replayed ${item.kind} at seq ${seq} ignored (sequence already recorded)`);
      return;
    }
    state.byEngineItem.set(engineKey, itemId);
    state.items.set(itemId, {
      item: timeline,
      engineItemId: item.id,
      threadId,
      lastFlush: this.now().getTime(),
    });
    if (completed) {
      state.completedEngineItems.add(engineKey);
      if (kind === 'assistant') state.completedStreamTurns.add(streamKey(threadId, turnId));
      this.releaseStream(state, threadId, turnId, itemId);
    }
    this.emit({ type: 'item', projectId: state.projectId, threadId, item: timeline });
    if (bounded.truncated) {
      this.diagnostic(state, `timeline item ${timeline.id} truncated at ${this.maxItemChars} characters`);
    }
  }

  /**
   * The one open anonymous stream for this turn, if exactly one exists. Deltas
   * the runtime sent without an item id leave a row with no engine identity; a
   * later completion may take that row over. Anything ambiguous returns null.
   */
  private adoptableStream(state: ProjectState, threadId: string, turnId: string | null): string | null {
    const candidates = new Set<string>();
    if (turnId) {
      const scoped = state.streamByTurn.get(streamKey(threadId, turnId));
      if (scoped) candidates.add(scoped);
    }
    for (const [key, itemId] of state.streamByTurn) {
      if (key.startsWith(`${threadId}:`)) candidates.add(itemId);
    }
    const open = [...candidates].filter((id) => {
      const entry = state.items.get(id);
      return entry !== undefined && entry.threadId === threadId && entry.item.status === 'streaming';
    });
    return open.length === 1 ? (open[0] ?? null) : null;
  }

  private releaseStream(state: ProjectState, threadId: string, turnId: string | null, itemId: string): void {
    if (turnId) {
      const key = streamKey(threadId, turnId);
      if (state.streamByTurn.get(key) === itemId) state.streamByTurn.delete(key);
    }
    for (const [key, value] of state.streamByTurn) {
      if (key.startsWith(`${threadId}:`) && value === itemId) state.streamByTurn.delete(key);
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
    const engineKey = engineItemId ? engineItemKey(threadId, engineItemId) : null;
    if (engineKey && state.completedEngineItems.has(engineKey)) {
      this.lateDelta(state, `item ${engineItemId}`, seq);
      return;
    }
    let itemId = engineKey ? state.byEngineItem.get(engineKey) : undefined;
    if (!itemId) {
      // An anonymous stream belongs to one turn. Binding it here keeps a
      // heartbeat or a filtered frame from starting a second answer card.
      const key = streamKey(threadId, turnId);
      if (!engineKey && state.completedStreamTurns.has(key)) {
        // This turn's id-less answer already finished; an id-less frame now is
        // late, and a new card would be invented text.
        this.lateDelta(state, `turn ${turnId ?? '(untagged)'}`, seq);
        return;
      }
      const candidate = turnId ? state.streamByTurn.get(key) : undefined;
      const entry = candidate ? state.items.get(candidate) : undefined;
      const anonymousOpen =
        candidate !== undefined &&
        entry !== undefined &&
        entry.threadId === threadId &&
        entry.item.status === 'streaming' &&
        entry.engineItemId === candidate;
      itemId = anonymousOpen && candidate !== undefined ? candidate : `tl_${threadId}_${seq}`;
      if (turnId) state.streamByTurn.set(streamKey(threadId, turnId), itemId);
      if (engineKey) state.byEngineItem.set(engineKey, itemId);
    }
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
        threadId,
        lastFlush: this.now().getTime(),
      });
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
      this.emit({ type: 'delta', projectId: state.projectId, threadId, itemId, text: delta, seq });
      return;
    }
    if (FINAL_ITEM_STATUSES.has(existing.item.status ?? '')) {
      // Text that arrives after its own card was closed is recorded as a late
      // frame, never appended into a finished answer.
      this.lateDelta(state, `item ${existing.item.id}`, seq);
      return;
    }
    const bounded = this.bound(existing.item.body + delta);
    existing.item = {
      ...existing.item,
      turnId: existing.item.turnId ?? turnId,
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
    this.emit({ type: 'delta', projectId: state.projectId, threadId, itemId, text: delta, seq });
  }

  private lateDelta(state: ProjectState, what: string, seq: number): void {
    state.lateDeltas += 1;
    this.diagnostic(
      state,
      `late delta at seq ${seq} for ${what} ignored (${state.lateDeltas} late frame(s) this session)`,
    );
  }

  /**
   * Closes every answer still marked streaming for one thread. Used when the
   * stream demonstrably lost frames or the runtime stopped: the text shown stays
   * as it was, and the card is labeled interrupted rather than completed.
   */
  private async interruptOpenStreams(state: ProjectState, threadId: string, reason: string): Promise<number> {
    let closed = 0;
    for (const entry of state.items.values()) {
      if (entry.threadId !== threadId) continue;
      if (!STREAM_OPEN_STATUSES.has(entry.item.status ?? '')) continue;
      entry.item = { ...entry.item, status: 'interrupted' };
      closed += 1;
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
      this.emit({ type: 'item', projectId: state.projectId, threadId, item: entry.item });
    }
    if (closed > 0) this.diagnostic(state, `closed ${closed} open item(s): ${reason}`);
    return closed;
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
      if (
        entry.threadId === threadId &&
        entry.item.turnId &&
        turnKeys.has(entry.item.turnId) &&
        entry.item.status === 'streaming'
      ) {
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
        // The card is closed: any frame that arrives after this is late, not
        // text to append to a finished answer.
        state.completedEngineItems.add(engineItemKey(threadId, entry.engineItemId));
        state.completedStreamTurns.add(streamKey(threadId, entry.item.turnId));
        this.releaseStream(state, threadId, entry.item.turnId, entry.item.id);
        this.emit({ type: 'item', projectId: state.projectId, threadId, item: entry.item });
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
    await this.pushItem(state, threadId, {
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

  private async pushItem(
    state: ProjectState,
    threadId: string | null,
    input: Omit<TimelineItem, 'id' | 'at'> & { id?: string },
  ): Promise<void> {
    // The event's own thread, not "whatever thread the user is looking at": a
    // mode switch must never re-home another thread's rows.
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
      threadId,
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
    this.emit({ type: 'item', projectId: state.projectId, threadId, item });
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

  /**
   * Validate the file references a submit carries.
   *
   * A reference is a *path in the prompt*, never attached content, so the checks
   * are about honesty: the path must be project-relative, it must still exist,
   * and it must resolve inside the project after every link and junction is
   * followed. A path that escapes through a reparse point is refused rather than
   * sent as if it were part of this project.
   */
  private boundReferences(
    references: unknown,
    projectRoot?: string,
  ): { ok: true; paths: string[] } | { ok: false; reason: string } {
    if (references === undefined) return { ok: true, paths: [] };
    if (!Array.isArray(references) || references.length > MAX_REFERENCES) {
      return { ok: false, reason: `At most ${MAX_REFERENCES} file references can be sent.` };
    }
    const out: string[] = [];
    for (const raw of references) {
      if (typeof raw !== 'string') return { ok: false, reason: 'A file reference must be a path string.' };
      const value = raw.trim();
      if (!value || value.length > MAX_REFERENCE_CHARS) {
        return { ok: false, reason: 'A file reference is empty or too long.' };
      }
      if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.split(/[\\/]/).includes('..')) {
        return { ok: false, reason: `"${value}" is not a project-relative path.` };
      }
      for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) {
          return { ok: false, reason: 'A file reference contains a control character.' };
        }
      }
      const normalized = value.split(path.sep).join('/');
      if (projectRoot) {
        const verdict = referenceOnDisk(projectRoot, normalized);
        if (!verdict.ok) return verdict;
      }
      out.push(normalized);
    }
    return { ok: true, paths: [...new Set(out)] };
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
      threadId: state.threadId,
      thread: state.profile ? { ...state.profile } : null,
      run: { ...state.run },
      control: this.controlFor(state),
      pending: state.pending ? { ...state.pending } : null,
    });
  }

  private renderView(
    state: ProjectState,
    items: TimelineItem[],
    history: StudioHistoryWindow,
    warning: string | null,
    usage: StudioUsage | null,
  ): StudioView {
    return {
      projectId: state.projectId,
      sessionId: state.sessionId,
      thread: state.profile ? { ...state.profile } : null,
      items,
      history,
      run: { ...state.run },
      control: this.controlFor(state),
      pending: state.pending ? { ...state.pending } : null,
      usage,
      diagnostics: [...state.diagnostics],
      capabilities: {
        planMode: {
          status: 'supported',
          reason: 'Thread mode is chosen when the engine thread is created; switching modes starts a new thread.',
        },
        approvalResponse: {
          status: 'supported',
          reason:
            'Approvals go to POST /v1/approvals/{approval_id} and clarifications to POST /v1/user-input/{thread_id}/{request_id} on the connected runtime; every reply needs the runtime\u2019s acknowledgement before the card closes.',
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

/**
 * Resolve one project-relative reference against the real filesystem.
 *
 * Missing files are refused: a prompt that lists a path the project does not have
 * would ask the agent to read something that is not there. Containment is checked
 * on the resolved path, so a junction or symlink cannot smuggle an outside file
 * into the reference list.
 */
function referenceOnDisk(root: string, reference: string): { ok: true } | { ok: false; reason: string } {
  const absolute = path.resolve(root, reference);
  let resolvedRoot: string;
  let resolvedFile: string;
  try {
    resolvedRoot = realpathSync.native(root);
  } catch {
    return { ok: false, reason: 'The project folder cannot be resolved, so references cannot be checked.' };
  }
  try {
    resolvedFile = realpathSync.native(absolute);
  } catch {
    return { ok: false, reason: `"${reference}" is not a file in this project.` };
  }
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, reason: `"${reference}" resolves outside this project and was not sent.` };
  }
  return { ok: true };
}

export function composePrompt(text: string, references: string[]): string {
  if (references.length === 0) return text;
  const lines = references.map((reference) => `- ${reference}`).join('\n');
  return `${text}\n\nFiles referenced by this request:\n${lines}`;
}

/** Engine item identity is per thread; two threads may reuse an item id. */
function engineItemKey(threadId: string, engineItemId: string): string {
  return `${threadId}:${engineItemId}`;
}

function streamKey(threadId: string, turnId: string | null): string {
  return `${threadId}:${turnId ?? 'untagged'}`;
}

function windowOf(page: TimelinePage): StudioHistoryWindow {
  return {
    total: page.total,
    oldestSeq: page.oldestSeq,
    newestSeq: page.newestSeq,
    hasOlder: page.hasOlder,
    hasNewer: page.hasNewer,
  };
}

function boundPageLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return HISTORY_PAGE;
  return Math.max(1, Math.min(HISTORY_MAX_PAGE, Math.trunc(limit)));
}

/**
 * Read clarification questions out of a request_user_input tool call. The tool
 * input is a JSON string in the runtime's own vocabulary; only the fields Mona
 * can render and validate are taken, and an unreadable payload yields no
 * questions rather than invented ones.
 */
function parseAskedQuestions(raw: string | undefined): { questions: StudioQuestion[] } {
  if (!raw || raw.length > 64 * 1024) return { questions: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { questions: [] };
  }
  const shape = isRecord(parsed) ? parsed : {};
  const list = Array.isArray(shape.questions) ? shape.questions : [];
  const questions: StudioQuestion[] = [];
  for (const entry of list.slice(0, 20)) {
    const row = isRecord(entry) ? entry : {};
    const id = typeof row.id === 'string' && row.id ? row.id : null;
    if (!id) continue;
    const options = Array.isArray(row.options) ? row.options : [];
    questions.push({
      id,
      header: typeof row.header === 'string' ? row.header : null,
      question: typeof row.question === 'string' ? row.question : null,
      multiSelect: row.multi_select === true,
      options: options
        .slice(0, 20)
        .map((option) => (isRecord(option) ? option : {}))
        .filter(
          (option): option is Record<string, unknown> => typeof option.label === 'string' && option.label.length > 0,
        )
        .map((option) => ({
          label: String(option.label).slice(0, 200),
          description: typeof option.description === 'string' ? option.description.slice(0, 400) : null,
        })),
    });
  }
  return { questions };
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
