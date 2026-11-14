import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { stateError } from './errors.js';
import type { ProjectStore, WriteTransaction } from './store.js';

/**
 * Prompt Runner contract and durable state model (W13).
 *
 * The runner is *not* a second task engine. It schedules the existing WorkTask
 * records from the main process and adds the identities the contract needs:
 *
 *   run        one authorized, frozen selection of tasks from one prompt file
 *   task       the existing `tasks` row (lifecycle, criteria, evidence, attempts)
 *   dispatch   one prompt submission intent, with a durable operation key
 *   thread     the engine session/conversation the dispatch was sent to
 *   turn       the engine-observed turn that actually ran
 *   report     the agent's bounded, versioned result file for one dispatch
 *   problem    the existing stable `problems` row from the attempt ledger
 *   request    the existing `human_requests` row when a native answer is needed
 *
 * Two distinctions are load-bearing and are enforced here rather than trusted:
 *
 *   - an accepted dispatch is not a completed turn (`markAccepted` vs
 *     `markTurnCompleted`, the latter only with the engine's own turn id);
 *   - a completed turn is not an accepted report (`submitReport`), and an
 *     accepted report is not a verified task (that remains TaskService.completeTask
 *     behind its evidence gate, which this module never calls).
 *
 * The result contract is a bounded JSON document written by the agent to an
 * assigned project-local path (`reportRelativePath`) and read back through
 * `readReportFile`, which refuses anything outside the workspace or over the
 * size limit. It cannot add tasks, execute commands or finish a run: unknown
 * fields are rejected, and every accepted report still has to pass the task's
 * evidence gate before anything is marked complete.
 */

export type RunnerStatus = 'draft' | 'running' | 'paused' | 'completed' | 'blocked' | 'cancelled';
export type DispatchStatus = 'recorded' | 'accepted' | 'turn_completed' | 'reported' | 'uncertain' | 'failed';
export type ReportDisposition = 'ready_for_verification' | 'needs_continuation' | 'blocked' | 'needs_human';

export const RUNNER_STATUSES: readonly RunnerStatus[] = [
  'draft',
  'running',
  'paused',
  'completed',
  'blocked',
  'cancelled',
];
export const DISPATCH_STATUSES: readonly DispatchStatus[] = [
  'recorded',
  'accepted',
  'turn_completed',
  'reported',
  'uncertain',
  'failed',
];
export const REPORT_DISPOSITIONS: readonly ReportDisposition[] = [
  'ready_for_verification',
  'needs_continuation',
  'blocked',
  'needs_human',
];

export type RunnerPolicy = {
  /** Automatic follow-up turns allowed per task after the first dispatch. */
  continuationAllowance: number;
  /** Report-repair follow-ups; the contract allows at most one. */
  reportRepairAllowance: number;
  /** Optional currency gate the controller re-checks before every dispatch. */
  budgetMicros: number | null;
};

export const DEFAULT_RUNNER_POLICY: RunnerPolicy = {
  continuationAllowance: 3,
  reportRepairAllowance: 1,
  budgetMicros: null,
};

export type PromptRun = {
  id: string;
  projectId: string;
  title: string;
  sourcePath: string;
  sourceSha256: string;
  sourceRevision: string;
  planRevision: number;
  planSha256: string;
  policy: RunnerPolicy;
  status: RunnerStatus;
  stopReason: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
};

export type PromptRunTask = {
  runId: string;
  taskId: string;
  position: number;
  promptSha256: string;
};

export type PromptDispatch = {
  id: string;
  runId: string;
  taskId: string;
  projectId: string;
  operationKey: string;
  promptSha256: string;
  sessionId: string;
  threadId: string | null;
  turnId: string | null;
  status: DispatchStatus;
  continuationIndex: number;
  recordedAt: string;
  acceptedAt: string | null;
  turnCompletedAt: string | null;
  updatedAt: string;
  lastError: string | null;
};

export type ReportReceipt = {
  reportId: string;
  dispatchId: string;
  runId: string;
  taskId: string;
  accepted: boolean;
  disposition: ReportDisposition | null;
  sha256: string;
  bytes: number;
  reasons: string[];
  receivedAt: string;
};

export type CreateRunInput = {
  projectId: string;
  title: string;
  taskIds: readonly string[];
  source: { path: string; sha256: string; revision: string };
  policy?: Partial<RunnerPolicy>;
  actor: string;
};

export type RecordDispatchInput = {
  runId: string;
  taskId: string;
  operationKey: string;
  sessionId: string;
  promptSha256: string;
  actor: string;
};

export type SubmitReportInput = {
  dispatchId: string;
  report: unknown;
  actor: string;
};

export type RunSnapshot = {
  run: PromptRun;
  tasks: PromptRunTask[];
  dispatches: PromptDispatch[];
  reports: ReportReceipt[];
};

const MAX_TITLE = 300;
const MAX_SOURCE_PATH = 1_024;
const MAX_TASKS = 500;
const MAX_OPERATION_KEY = 200;
const MAX_SUMMARY = 8_000;
const MAX_ACCEPTANCE = 100;
const MAX_EVIDENCE = 200;
const MAX_PROBLEMS = 50;
const MAX_QUESTIONS = 20;
const REPORT_MAX_BYTES = 64 * 1024;
const REPORT_VERSION = 1;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'expected a lowercase sha256 hex digest');

const EvidenceRef = z
  .object({
    path: z.string().min(1).max(1_024),
    kind: z.string().min(1).max(40).optional(),
    sha256: Sha256.optional(),
    note: z.string().max(1_000).optional(),
  })
  .strict();

const AcceptanceClaim = z
  .object({
    criterion_id: z.string().min(1).max(120).optional(),
    description: z.string().min(1).max(1_000),
    status: z.enum(['met', 'unmet', 'unknown']),
    evidence: z.array(EvidenceRef).max(20).optional(),
  })
  .strict();

const ProblemClaim = z
  .object({
    problem_id: z.string().min(1).max(120),
    symptom: z.string().min(1).max(1_000).optional(),
    attempts: z.number().int().nonnegative().max(99).optional(),
    material_progress: z.enum(['yes', 'no']).optional(),
  })
  .strict();

const Question = z
  .object({
    question: z.string().min(1).max(1_000),
    why: z.string().min(1).max(1_000),
    options: z.array(z.string().min(1).max(300)).max(10).optional(),
    recommendation: z.string().max(1_000).optional(),
  })
  .strict();

/**
 * The versioned result contract. `strict()` is the mechanism that stops an
 * agent from smuggling in new tasks, verifier commands or a run-completion
 * claim: those keys are simply not part of the schema.
 */
export const RunnerReportSchema = z
  .object({
    report_version: z.literal(REPORT_VERSION),
    run_id: z.string().min(1).max(120),
    task_id: z.string().min(1).max(120),
    dispatch_id: z.string().min(1).max(120),
    prompt_sha256: Sha256,
    disposition: z.enum(['ready_for_verification', 'needs_continuation', 'blocked', 'needs_human']),
    summary: z.string().min(1).max(MAX_SUMMARY),
    acceptance: z.array(AcceptanceClaim).max(MAX_ACCEPTANCE),
    evidence: z.array(EvidenceRef).max(MAX_EVIDENCE),
    problems: z.array(ProblemClaim).max(MAX_PROBLEMS),
    questions: z.array(Question).max(MAX_QUESTIONS),
    next_action: z.string().min(1).max(2_000),
    completed_utc: z.iso.datetime().optional(),
  })
  .strict();

export type RunnerReport = z.infer<typeof RunnerReportSchema>;

export type RunnerServiceOptions = {
  now?: () => Date;
  maxReportBytes?: number;
};

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

function sha256File(file: string): string {
  return sha256(readFileSync(file));
}

function bounded(value: string, label: string, limit: number, required: boolean): string {
  const trimmed = value.trim();
  if (required && trimmed.length === 0) throw stateError('invalid_request', `${label} is required`);
  if (value.length > limit) throw stateError('oversize', `${label} is longer than ${limit} characters`);
  return value;
}

function asStatus(value: string): RunnerStatus {
  if ((RUNNER_STATUSES as readonly string[]).includes(value)) return value as RunnerStatus;
  throw stateError('corrupt_state', `unknown runner status ${value}`);
}

function asDispatchStatus(value: string): DispatchStatus {
  if ((DISPATCH_STATUSES as readonly string[]).includes(value)) return value as DispatchStatus;
  throw stateError('corrupt_state', `unknown dispatch status ${value}`);
}

/** Same normalisation the rest of local state uses: forward slashes in stored paths. */
export function normalizeRunnerPath(value: string): string {
  return value.replaceAll('\\', '/');
}

/**
 * Containment for a report or evidence path.
 *
 * Syntactic checks run first, then the real path (junctions and symlinks
 * resolved) must still sit under the real workspace root. A link inside the
 * project that points outside it is refused, not silently followed.
 */
export function containPath(
  workspaceRoot: string,
  candidate: string,
  options: { mustExist: boolean; mustBeFile?: boolean } = { mustExist: true },
): { relativePath: string; absolutePath: string } {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw stateError('invalid_request', 'a path is required');
  }
  if (candidate.includes('\0')) throw stateError('invalid_request', 'a path may not contain NUL');
  if (isAbsolute(candidate) || /^[a-zA-Z]:/.test(candidate)) {
    throw stateError('invalid_request', `paths must be workspace-relative, not absolute: ${candidate}`);
  }
  const absolute = resolve(workspaceRoot, candidate);
  const syntactic = relative(workspaceRoot, absolute);
  if (syntactic.startsWith('..') || isAbsolute(syntactic) || syntactic === '') {
    throw stateError('invalid_request', `path escapes the workspace: ${candidate}`);
  }
  if (options.mustExist && !existsSync(absolute)) {
    throw stateError('not_found', `path does not exist: ${normalizeRunnerPath(syntactic)}`);
  }
  if (existsSync(absolute)) {
    const realRoot = realpathSync.native(workspaceRoot);
    const real = realpathSync.native(absolute);
    const contained = relative(realRoot, real);
    if (contained.startsWith('..') || isAbsolute(contained) || contained === '') {
      throw stateError(
        'unsafe_location',
        `path resolves outside the workspace through a link or junction: ${normalizeRunnerPath(syntactic)}`,
      );
    }
    if (options.mustBeFile && !statSync(real).isFile()) {
      throw stateError('invalid_request', `path is not a file: ${normalizeRunnerPath(syntactic)}`);
    }
  }
  return { relativePath: normalizeRunnerPath(syntactic), absolutePath: absolute };
}

export class RunnerService {
  private readonly store: ProjectStore;
  private readonly now: () => Date;
  private readonly maxReportBytes: number;

  constructor(store: ProjectStore, options: RunnerServiceOptions = {}) {
    this.store = store;
    this.now = options.now ?? (() => new Date());
    this.maxReportBytes = options.maxReportBytes ?? REPORT_MAX_BYTES;
  }

  /** Create a frozen run. Importing is inert: nothing is dispatched here. */
  async createRun(input: CreateRunInput): Promise<RunSnapshot> {
    return await this.store.write((tx) => {
      const project = tx.db.prepare('SELECT id, canonical_path FROM projects WHERE id = ?').get(input.projectId) as
        { id: string; canonical_path: string } | undefined;
      if (!project) throw stateError('not_found', `project ${input.projectId} does not exist`);

      const title = bounded(input.title, 'run title', MAX_TITLE, true);
      const taskIds = [...input.taskIds];
      if (taskIds.length === 0) throw stateError('invalid_request', 'a run needs at least one task');
      if (taskIds.length > MAX_TASKS) throw stateError('oversize', `a run may hold at most ${MAX_TASKS} tasks`);
      if (new Set(taskIds).size !== taskIds.length) throw stateError('invalid_request', 'run task ids must be unique');

      const sourcePath = bounded(input.source.path, 'source path', MAX_SOURCE_PATH, true);
      if (!Sha256.safeParse(input.source.sha256).success) {
        throw stateError('invalid_request', 'source sha256 must be a lowercase hex digest');
      }
      const sourceRevision = bounded(input.source.revision, 'source revision', 200, true);
      if (existsSync(sourcePath) && sha256File(sourcePath) !== input.source.sha256) {
        throw stateError('digest_mismatch', 'source file does not match the supplied sha256');
      }

      const policy = this.normalizePolicy(input.policy);
      const frozen: Array<{ taskId: string; position: number; promptSha256: string }> = [];
      taskIds.forEach((taskId, position) => {
        const row = tx.db
          .prepare('SELECT id, project_id, execution_owner, prompt_text FROM tasks WHERE id = ?')
          .get(taskId) as { id: string; project_id: string; execution_owner: string; prompt_text: string } | undefined;
        if (!row) throw stateError('not_found', `task ${taskId} does not exist`);
        if (row.project_id !== input.projectId) {
          throw stateError('invalid_request', `task ${taskId} belongs to another project`);
        }
        if (row.execution_owner !== 'mona_queue') {
          throw stateError(
            'not_eligible',
            `task ${taskId} is owned by ${row.execution_owner}; a Mona run must not schedule it`,
          );
        }
        if (row.prompt_text.trim().length === 0) {
          throw stateError('invalid_request', `task ${taskId} has no prompt text to dispatch`);
        }
        frozen.push({ taskId, position, promptSha256: sha256(row.prompt_text) });
      });

      const planSha256 = sha256(JSON.stringify(frozen));
      const runId = `run_${randomUUID().replaceAll('-', '')}`;
      const now = tx.now();
      tx.db
        .prepare(
          `INSERT INTO prompt_runs
             (id, project_id, title, source_path, source_sha256, source_revision, plan_revision, plan_sha256,
              policy_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        )
        .run(
          runId,
          input.projectId,
          title,
          sourcePath,
          input.source.sha256,
          sourceRevision,
          1,
          planSha256,
          JSON.stringify(policy),
          now,
          now,
        );
      const insertTask = tx.db.prepare(
        'INSERT INTO prompt_run_tasks(run_id, task_id, position, prompt_sha256) VALUES (?, ?, ?, ?)',
      );
      for (const entry of frozen) insertTask.run(runId, entry.taskId, entry.position, entry.promptSha256);
      this.recordRunTransition(tx, runId, null, 'draft', `frozen from ${normalizeRunnerPath(sourcePath)}`, input.actor);
      tx.bumpRevision();
      return this.loadSnapshot(tx.db, runId);
    });
  }

  async getRun(runId: string): Promise<RunSnapshot | null> {
    return await this.store.read((db) => {
      const row = db.prepare('SELECT id FROM prompt_runs WHERE id = ?').get(runId) as { id?: string } | undefined;
      if (!row?.id) return null;
      return this.loadSnapshot(db, runId);
    });
  }

  async listRuns(projectId: string): Promise<PromptRun[]> {
    return await this.store.read((db) => {
      const rows = db
        .prepare('SELECT * FROM prompt_runs WHERE project_id = ? ORDER BY created_at DESC, id DESC')
        .all(projectId) as StoredRun[];
      return rows.map((row) => this.toRun(row));
    });
  }

  /** Start a frozen run. This authorizes the finite selection; it spends nothing yet. */
  async startRun(runId: string, actor: string): Promise<PromptRun> {
    return await this.store.write((tx) => {
      const run = this.requireRun(tx.db, runId);
      if (run.status !== 'draft' && run.status !== 'paused') {
        throw stateError('invalid_request', `run ${runId} is ${run.status}; only a draft or paused run starts`);
      }
      const active = tx.db
        .prepare("SELECT id FROM prompt_dispatches WHERE project_id = ? AND status IN ('recorded','accepted') LIMIT 1")
        .get(run.projectId) as { id?: string } | undefined;
      if (active?.id) {
        throw stateError('not_eligible', `workspace already has an active dispatch ${active.id}`);
      }
      const now = tx.now();
      const startedAt = run.startedAt ?? now;
      tx.db
        .prepare("UPDATE prompt_runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?")
        .run(startedAt, now, runId);
      this.recordRunTransition(tx, runId, run.status, 'running', 'started by user selection', actor);
      tx.bumpRevision();
      return this.requireRun(tx.db, runId);
    });
  }

  /** Pause after the current dispatch settles; an active turn is not interrupted. */
  async pauseRun(runId: string, reason: string, actor: string): Promise<PromptRun> {
    return await this.store.write((tx) => {
      const run = this.requireRun(tx.db, runId);
      if (run.status !== 'running') throw stateError('invalid_request', `run ${runId} is ${run.status}, not running`);
      const now = tx.now();
      tx.db.prepare("UPDATE prompt_runs SET status = 'paused', updated_at = ? WHERE id = ?").run(now, runId);
      this.recordRunTransition(tx, runId, run.status, 'paused', bounded(reason, 'pause reason', 4_000, true), actor);
      tx.bumpRevision();
      return this.requireRun(tx.db, runId);
    });
  }

  /**
   * Cancel remaining work. This never promises to stop an in-flight turn and
   * never rewrites what already ran; the active dispatch keeps its identity.
   */
  async cancelRun(runId: string, reason: string, actor: string): Promise<PromptRun> {
    return await this.store.write((tx) => {
      const run = this.requireRun(tx.db, runId);
      if (run.status === 'completed' || run.status === 'cancelled') {
        throw stateError('invalid_request', `run ${runId} is already ${run.status}`);
      }
      const now = tx.now();
      tx.db
        .prepare(
          "UPDATE prompt_runs SET status = 'cancelled', stop_reason = ?, ended_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(bounded(reason, 'cancel reason', 4_000, true), now, now, runId);
      this.recordRunTransition(tx, runId, run.status, 'cancelled', reason, actor);
      tx.bumpRevision();
      return this.requireRun(tx.db, runId);
    });
  }

  /**
   * Finish a run. Only a run whose tasks are all completed or skipped, and with
   * no active dispatch, can complete â€” the caller cannot declare victory over
   * unfinished work.
   */
  async finishRun(
    runId: string,
    input: { status: 'completed' | 'blocked'; reason: string; actor: string },
  ): Promise<PromptRun> {
    return await this.store.write((tx) => {
      const run = this.requireRun(tx.db, runId);
      if (run.status !== 'running' && run.status !== 'paused') {
        throw stateError('invalid_request', `run ${runId} is ${run.status}; it cannot finish`);
      }
      const active = tx.db
        .prepare("SELECT id FROM prompt_dispatches WHERE run_id = ? AND status IN ('recorded','accepted') LIMIT 1")
        .get(runId) as { id?: string } | undefined;
      if (active?.id && input.status === 'blocked') {
        throw stateError('not_eligible', `run ${runId} has an active dispatch ${active.id}`);
      }
      if (input.status === 'completed') {
        const unfinished = tx.db
          .prepare(
            `SELECT t.id FROM prompt_run_tasks rt JOIN tasks t ON t.id = rt.task_id
              WHERE rt.run_id = ? AND t.status NOT IN ('completed', 'skipped')`,
          )
          .all(runId) as Array<{ id: string }>;
        if (unfinished.length > 0) {
          throw stateError(
            'criteria_unsatisfied',
            `run ${runId} still has unfinished tasks`,
            unfinished.map((row) => row.id).join(', '),
          );
        }
        if (active?.id) throw stateError('not_eligible', `run ${runId} has an active dispatch ${active.id}`);
      }
      const now = tx.now();
      tx.db
        .prepare('UPDATE prompt_runs SET status = ?, stop_reason = ?, ended_at = ?, updated_at = ? WHERE id = ?')
        .run(input.status, bounded(input.reason, 'finish reason', 4_000, true), now, now, runId);
      this.recordRunTransition(tx, runId, run.status, input.status, input.reason, input.actor);
      tx.bumpRevision();
      return this.requireRun(tx.db, runId);
    });
  }

  /**
   * Record the intent to submit one prompt. Idempotent on the operation key: a
   * retried call with the same key returns the same dispatch instead of sending
   * a second turn, and a different identity under the same key is a conflict.
   */
  async recordDispatch(input: RecordDispatchInput): Promise<PromptDispatch> {
    return await this.store.write((tx) => {
      const run = this.requireRun(tx.db, input.runId);
      if (run.status !== 'running') {
        throw stateError('not_eligible', `run ${run.id} is ${run.status}; dispatch requires a running run`);
      }
      const operationKey = bounded(input.operationKey, 'operation key', MAX_OPERATION_KEY, true);
      const sessionId = bounded(input.sessionId, 'session id', 200, true);
      const existing = tx.db
        .prepare('SELECT * FROM prompt_dispatches WHERE run_id = ? AND operation_key = ?')
        .get(run.id, operationKey) as StoredDispatch | undefined;
      if (existing) {
        if (existing.task_id !== input.taskId || existing.session_id !== sessionId) {
          throw stateError(
            'conflict',
            `operation key ${operationKey} was already used for a different dispatch; do not retry under a reused key`,
          );
        }
        return this.toDispatch(existing);
      }

      const frozen = tx.db
        .prepare('SELECT prompt_sha256 FROM prompt_run_tasks WHERE run_id = ? AND task_id = ?')
        .get(run.id, input.taskId) as { prompt_sha256: string } | undefined;
      if (!frozen) throw stateError('not_found', `task ${input.taskId} is not part of run ${run.id}`);
      if (input.promptSha256 !== frozen.prompt_sha256) {
        throw stateError('digest_mismatch', 'dispatch prompt does not match the frozen plan revision');
      }
      const task = tx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(input.taskId) as
        { status: string } | undefined;
      if (!task) throw stateError('not_found', `task ${input.taskId} does not exist`);
      if (task.status === 'completed' || task.status === 'skipped') {
        throw stateError('not_eligible', `task ${input.taskId} is ${task.status}; it needs no dispatch`);
      }

      const count = (
        tx.db
          .prepare('SELECT COUNT(*) AS count FROM prompt_dispatches WHERE run_id = ? AND task_id = ?')
          .get(run.id, input.taskId) as { count: number }
      ).count;
      if (count > run.policy.continuationAllowance) {
        throw stateError(
          'not_eligible',
          `task ${input.taskId} has used its ${run.policy.continuationAllowance} continuation turn(s)`,
          'increasing the allowance is a deliberate human decision, not a retry',
        );
      }

      const active = tx.db
        .prepare("SELECT id FROM prompt_dispatches WHERE project_id = ? AND status IN ('recorded','accepted') LIMIT 1")
        .get(run.projectId) as { id?: string } | undefined;
      if (active?.id) {
        throw stateError(
          'not_eligible',
          `workspace ${run.projectId} already has unsettled dispatch ${active.id}; one mutating run per workspace`,
        );
      }

      const id = `dsp_${randomUUID().replaceAll('-', '')}`;
      const now = tx.now();
      tx.db
        .prepare(
          `INSERT INTO prompt_dispatches
             (id, run_id, task_id, project_id, operation_key, prompt_sha256, session_id, status,
              continuation_index, recorded_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'recorded', ?, ?, ?)`,
        )
        .run(id, run.id, input.taskId, run.projectId, operationKey, input.promptSha256, sessionId, count, now, now);
      tx.bumpRevision();
      return this.requireDispatch(tx.db, id);
    });
  }

  /** A send was acknowledged. This is a transport receipt, not task success. */
  async markAccepted(dispatchId: string, input: { threadId?: string | undefined } = {}): Promise<PromptDispatch> {
    return await this.store.write((tx) => {
      const dispatch = this.requireDispatch(tx.db, dispatchId);
      if (dispatch.status !== 'recorded') {
        throw stateError('invalid_request', `dispatch ${dispatchId} is ${dispatch.status}, not awaiting acceptance`);
      }
      const now = tx.now();
      tx.db
        .prepare(
          "UPDATE prompt_dispatches SET status = 'accepted', thread_id = COALESCE(?, thread_id), accepted_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(input.threadId ?? null, now, now, dispatchId);
      tx.bumpRevision();
      return this.requireDispatch(tx.db, dispatchId);
    });
  }

  /**
   * Bind the engine's own turn identity. The controller supplies this from its
   * event stream; the agent never guesses it.
   */
  async bindTurn(
    dispatchId: string,
    input: { turnId: string; threadId?: string | undefined },
  ): Promise<PromptDispatch> {
    return await this.store.write((tx) => {
      const dispatch = this.requireDispatch(tx.db, dispatchId);
      if (dispatch.status === 'turn_completed' || dispatch.status === 'reported') {
        throw stateError('invalid_request', `dispatch ${dispatchId} already settled its turn`);
      }
      if (dispatch.turnId !== null && dispatch.turnId !== input.turnId) {
        throw stateError(
          'conflict',
          `dispatch ${dispatchId} is already bound to turn ${dispatch.turnId}; refusing to rebind`,
        );
      }
      const now = tx.now();
      tx.db
        .prepare(
          'UPDATE prompt_dispatches SET turn_id = ?, thread_id = COALESCE(?, thread_id), updated_at = ? WHERE id = ?',
        )
        .run(bounded(input.turnId, 'turn id', 200, true), input.threadId ?? null, now, dispatchId);
      tx.bumpRevision();
      return this.requireDispatch(tx.db, dispatchId);
    });
  }

  /** The engine reported the turn's terminal state. Still not task completion. */
  async markTurnCompleted(dispatchId: string, input: { turnId: string }): Promise<PromptDispatch> {
    return await this.store.write((tx) => {
      const dispatch = this.requireDispatch(tx.db, dispatchId);
      if (dispatch.status === 'turn_completed' || dispatch.status === 'reported') {
        if (dispatch.turnId === input.turnId) return dispatch;
        throw stateError('conflict', `dispatch ${dispatchId} already completed turn ${dispatch.turnId}`);
      }
      if (dispatch.status === 'uncertain' || dispatch.status === 'failed') {
        throw stateError('invalid_request', `dispatch ${dispatchId} is ${dispatch.status}; reconcile it, do not retry`);
      }
      if (dispatch.turnId !== null && dispatch.turnId !== input.turnId) {
        throw stateError('conflict', `turn ${input.turnId} does not match the bound turn ${dispatch.turnId}`);
      }
      const now = tx.now();
      tx.db
        .prepare(
          "UPDATE prompt_dispatches SET turn_id = COALESCE(turn_id, ?), status = 'turn_completed', turn_completed_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(input.turnId, now, now, dispatchId);
      tx.bumpRevision();
      return this.requireDispatch(tx.db, dispatchId);
    });
  }

  /**
   * A send whose outcome was never observed. Read-only reconciliation only: a
   * new dispatch with a new operation key is a deliberate decision, never an
   * automatic retry under a fresh key.
   */
  async markUncertain(dispatchId: string, reason: string): Promise<PromptDispatch> {
    return await this.store.write((tx) => {
      const dispatch = this.requireDispatch(tx.db, dispatchId);
      if (dispatch.status === 'reported' || dispatch.status === 'turn_completed') {
        throw stateError('invalid_request', `dispatch ${dispatchId} is already ${dispatch.status}`);
      }
      const now = tx.now();
      tx.db
        .prepare("UPDATE prompt_dispatches SET status = 'uncertain', last_error = ?, updated_at = ? WHERE id = ?")
        .run(bounded(reason, 'uncertainty reason', 4_000, true), now, dispatchId);
      tx.bumpRevision();
      return this.requireDispatch(tx.db, dispatchId);
    });
  }

  /**
   * Accept (or reject and record) the agent's bounded result report.
   *
   * Acceptance requires the engine-observed turn to have completed, the report
   * to bind to this exact run/task/dispatch/prompt revision, every evidence path
   * to exist inside the workspace, and the disposition to be internally
   * consistent. Acceptance writes no task evidence and completes nothing.
   */
  async submitReport(input: SubmitReportInput): Promise<ReportReceipt> {
    return await this.store.write((tx) => {
      const dispatch = this.requireDispatch(tx.db, input.dispatchId);
      const run = this.requireRun(tx.db, dispatch.runId);
      const project = tx.db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(run.projectId) as
        { canonical_path: string } | undefined;
      if (!project) throw stateError('not_found', `project ${run.projectId} does not exist`);
      const task = tx.db.prepare('SELECT id FROM tasks WHERE id = ?').get(dispatch.taskId) as
        { id: string } | undefined;
      if (!task) throw stateError('not_found', `task ${dispatch.taskId} does not exist`);

      const serialized = typeof input.report === 'string' ? input.report : JSON.stringify(input.report);
      const actor = bounded(input.actor, 'actor', 200, true);
      if (Buffer.byteLength(serialized, 'utf8') > this.maxReportBytes) {
        throw stateError('oversize', `result report is larger than ${this.maxReportBytes} bytes`);
      }
      const digest = sha256(serialized);
      const previouslyAccepted = tx.db
        .prepare('SELECT id FROM runner_reports WHERE dispatch_id = ? AND accepted = 1')
        .get(dispatch.id) as { id?: string } | undefined;
      if (previouslyAccepted?.id) {
        throw stateError(
          'stale_revision',
          `dispatch ${dispatch.id} already has an accepted report; a further report cannot replace it`,
          'a report-repair turn needs its own dispatch and operation key',
        );
      }

      const now = tx.now();
      const reject = (reasons: string[]): ReportReceipt => {
        const reportId = this.insertReport(tx, {
          dispatch,
          disposition: null,
          accepted: false,
          reasons,
          serialized,
          digest,
          now,
          actor,
        });
        tx.bumpRevision();
        return {
          reportId,
          dispatchId: dispatch.id,
          runId: dispatch.runId,
          taskId: dispatch.taskId,
          accepted: false,
          disposition: null,
          sha256: digest,
          bytes: Buffer.byteLength(serialized, 'utf8'),
          reasons,
          receivedAt: now,
        };
      };

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(serialized);
      } catch {
        return reject(['report is not valid JSON']);
      }
      const parsed = RunnerReportSchema.safeParse(parsedJson);
      if (!parsed.success) {
        return reject(parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`));
      }
      const report = parsed.data;

      const reasons: string[] = [];
      if (dispatch.status !== 'turn_completed') {
        reasons.push(
          `turn ${dispatch.turnId ?? '(unbound)'} is ${dispatch.status}; a report is accepted only after the engine's own turn completion`,
        );
      }
      if (report.run_id !== run.id) reasons.push(`report run_id ${report.run_id} does not match ${run.id}`);
      if (report.task_id !== dispatch.taskId)
        reasons.push(`report task_id ${report.task_id} does not match ${dispatch.taskId}`);
      if (report.dispatch_id !== dispatch.id) {
        reasons.push(`report dispatch_id ${report.dispatch_id} does not match ${dispatch.id}`);
      }
      if (report.prompt_sha256 !== dispatch.promptSha256) {
        reasons.push('report prompt_sha256 does not match the frozen plan revision');
      }
      if (report.disposition === 'ready_for_verification') {
        if (report.acceptance.length === 0) reasons.push('ready_for_verification needs at least one acceptance claim');
        const unmet = report.acceptance.filter((claim) => claim.status !== 'met');
        if (unmet.length > 0) {
          reasons.push(`ready_for_verification contradicts ${unmet.length} unmet/unknown acceptance claim(s)`);
        }
      }
      if (report.disposition === 'needs_human' && report.questions.length === 0) {
        reasons.push('needs_human needs at least one question');
      }
      if (report.disposition === 'blocked' && report.problems.length === 0 && report.questions.length === 0) {
        reasons.push('blocked needs a problem id or a question');
      }

      const criteria = tx.db
        .prepare('SELECT id, kind FROM task_acceptance WHERE task_id = ?')
        .all(dispatch.taskId) as Array<{ id: string; kind: string }>;
      const criteriaById = new Map(criteria.map((row) => [row.id, row.kind]));
      for (const claim of report.acceptance) {
        if (claim.criterion_id === undefined) continue;
        const kind = criteriaById.get(claim.criterion_id);
        if (kind === undefined) reasons.push(`acceptance claim references unknown criterion ${claim.criterion_id}`);
        else if (kind === 'human' && claim.status === 'met') {
          reasons.push(`criterion ${claim.criterion_id} is human-only; an agent report cannot satisfy it`);
        }
      }

      const problems = tx.db.prepare('SELECT id FROM problems WHERE task_id = ?').all(dispatch.taskId) as Array<{
        id: string;
      }>;
      const problemIds = new Set(problems.map((row) => row.id));
      for (const claim of report.problems) {
        if (!problemIds.has(claim.problem_id)) {
          reasons.push(`problem ${claim.problem_id} is not a recorded problem for this task`);
        }
      }

      const evidenceRefs = [...report.evidence, ...report.acceptance.flatMap((claim) => claim.evidence ?? [])];
      for (const reference of evidenceRefs) {
        try {
          const contained = containPath(project.canonical_path, reference.path, { mustExist: true, mustBeFile: true });
          if (reference.sha256 !== undefined) {
            const actual = sha256File(contained.absolutePath);
            if (actual !== reference.sha256) {
              reasons.push(`evidence ${contained.relativePath} hash does not match the file on disk`);
            }
          }
        } catch (error) {
          reasons.push(`evidence ${reference.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (reasons.length > 0) return reject(reasons);

      const reportId = this.insertReport(tx, {
        dispatch,
        disposition: report.disposition,
        accepted: true,
        reasons: [],
        serialized,
        digest,
        now,
        actor,
      });
      tx.db
        .prepare("UPDATE prompt_dispatches SET status = 'reported', updated_at = ? WHERE id = ?")
        .run(now, dispatch.id);
      tx.bumpRevision();
      return {
        reportId,
        dispatchId: dispatch.id,
        runId: dispatch.runId,
        taskId: dispatch.taskId,
        accepted: true,
        disposition: report.disposition,
        sha256: digest,
        bytes: Buffer.byteLength(serialized, 'utf8'),
        reasons: [],
        receivedAt: now,
      };
    });
  }

  async reportsFor(runId: string): Promise<ReportReceipt[]> {
    return await this.store.read((db) => {
      const rows = db
        .prepare('SELECT * FROM runner_reports WHERE run_id = ? ORDER BY received_at ASC, id ASC')
        .all(runId) as StoredReport[];
      return rows.map((row) => this.toReceipt(row));
    });
  }

  /**
   * Startup reconciliation. A dispatch that was sent but whose turn was never
   * observed becomes `uncertain` â€” read-only, never blindly retried.
   */
  async reconcile(projectId: string, liveDispatchIds: readonly string[] = []): Promise<PromptDispatch[]> {
    return await this.store.write((tx) => {
      const live = new Set(liveDispatchIds);
      const rows = tx.db
        .prepare(
          "SELECT * FROM prompt_dispatches WHERE project_id = ? AND status IN ('recorded','accepted') ORDER BY recorded_at",
        )
        .all(projectId) as StoredDispatch[];
      const settled: PromptDispatch[] = [];
      const now = tx.now();
      for (const row of rows) {
        if (live.has(row.id)) continue;
        tx.db
          .prepare("UPDATE prompt_dispatches SET status = 'uncertain', last_error = ?, updated_at = ? WHERE id = ?")
          .run('application restarted before the turn was observed; reconcile before retrying', now, row.id);
        settled.push(this.requireDispatch(tx.db, row.id));
      }
      if (settled.length > 0) tx.bumpRevision();
      return settled;
    });
  }

  /** Where the agent writes its report: a controlled path inside the workspace. */
  reportRelativePath(dispatchId: string): string {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(dispatchId)) {
      throw stateError('invalid_request', `dispatch id ${dispatchId} is not safe to use as a file name`);
    }
    return `.mona/runner/reports/${dispatchId}.json`;
  }

  /** Read an assigned report file with containment and a size cap. */
  readReportFile(projectRoot: string, dispatchId: string): unknown {
    const { absolutePath } = containPath(projectRoot, this.reportRelativePath(dispatchId), {
      mustExist: true,
      mustBeFile: true,
    });
    const size = statSync(absolutePath).size;
    if (size > this.maxReportBytes) {
      throw stateError('oversize', `report file is ${size} bytes; the limit is ${this.maxReportBytes}`);
    }
    return JSON.parse(readFileSync(absolutePath, 'utf8')) as unknown;
  }

  /** Write a report atomically (temporary file + rename) for fixtures and probes. */
  writeReportFile(projectRoot: string, dispatchId: string, report: unknown): string {
    const { relativePath, absolutePath } = containPath(projectRoot, this.reportRelativePath(dispatchId), {
      mustExist: false,
    });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > this.maxReportBytes) {
      throw stateError('oversize', `report is larger than ${this.maxReportBytes} bytes`);
    }
    mkdirSync(resolve(absolutePath, '..'), { recursive: true });
    const temporary = join(resolve(absolutePath, '..'), `.${dispatchId}.${randomUUID()}.tmp`);
    writeFileSync(temporary, serialized, 'utf8');
    renameSync(temporary, absolutePath);
    return relativePath;
  }

  private normalizePolicy(input: Partial<RunnerPolicy> | undefined): RunnerPolicy {
    const policy = { ...DEFAULT_RUNNER_POLICY, ...(input ?? {}) };
    if (
      !Number.isInteger(policy.continuationAllowance) ||
      policy.continuationAllowance < 0 ||
      policy.continuationAllowance > 10
    ) {
      throw stateError('invalid_request', 'continuationAllowance must be an integer between 0 and 10');
    }
    if (
      !Number.isInteger(policy.reportRepairAllowance) ||
      policy.reportRepairAllowance < 0 ||
      policy.reportRepairAllowance > 1
    ) {
      throw stateError('invalid_request', 'reportRepairAllowance must be 0 or 1');
    }
    if (policy.budgetMicros !== null && (!Number.isInteger(policy.budgetMicros) || policy.budgetMicros < 0)) {
      throw stateError('invalid_request', 'budgetMicros must be a non-negative integer or null');
    }
    return {
      continuationAllowance: policy.continuationAllowance,
      reportRepairAllowance: policy.reportRepairAllowance,
      budgetMicros: policy.budgetMicros,
    };
  }

  private insertReport(
    tx: WriteTransaction,
    input: {
      dispatch: PromptDispatch;
      disposition: ReportDisposition | null;
      accepted: boolean;
      reasons: string[];
      serialized: string;
      digest: string;
      now: string;
      actor: string;
    },
  ): string {
    const id = `rpt_${randomUUID().replaceAll('-', '')}`;
    const existing = tx.db
      .prepare('SELECT id FROM runner_reports WHERE dispatch_id = ? AND sha256 = ?')
      .get(input.dispatch.id, input.digest) as { id?: string } | undefined;
    if (existing?.id) return existing.id;
    tx.db
      .prepare(
        `INSERT INTO runner_reports
           (id, dispatch_id, run_id, task_id, report_version, disposition, accepted, rejection_reason,
            sha256, bytes, report_json, received_at, submitted_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.dispatch.id,
        input.dispatch.runId,
        input.dispatch.taskId,
        REPORT_VERSION,
        input.disposition ?? 'unknown',
        input.accepted ? 1 : 0,
        input.reasons.length > 0 ? input.reasons.join('; ').slice(0, 4_000) : null,
        input.digest,
        Buffer.byteLength(input.serialized, 'utf8'),
        input.serialized,
        input.now,
        input.actor,
      );
    return id;
  }

  private recordRunTransition(
    tx: WriteTransaction,
    runId: string,
    from: RunnerStatus | null,
    to: RunnerStatus,
    reason: string,
    actor: string,
  ): void {
    tx.db
      .prepare(
        'INSERT INTO prompt_run_transitions(id, run_id, from_status, to_status, reason, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        `rnt_${randomUUID().replaceAll('-', '')}`,
        runId,
        from,
        to,
        bounded(reason, 'transition reason', 4_000, true),
        bounded(actor, 'actor', 200, true),
        tx.now(),
      );
  }

  private requireRun(db: DatabaseSync, runId: string): PromptRun {
    const row = db.prepare('SELECT * FROM prompt_runs WHERE id = ?').get(runId) as StoredRun | undefined;
    if (!row) throw stateError('not_found', `run ${runId} does not exist`);
    return this.toRun(row);
  }

  private requireDispatch(db: DatabaseSync, dispatchId: string): PromptDispatch {
    const row = db.prepare('SELECT * FROM prompt_dispatches WHERE id = ?').get(dispatchId) as
      StoredDispatch | undefined;
    if (!row) throw stateError('not_found', `dispatch ${dispatchId} does not exist`);
    return this.toDispatch(row);
  }

  private loadSnapshot(db: DatabaseSync, runId: string): RunSnapshot {
    const run = this.requireRun(db, runId);
    const tasks = db
      .prepare('SELECT * FROM prompt_run_tasks WHERE run_id = ? ORDER BY position ASC')
      .all(runId) as StoredRunTask[];
    const dispatches = db
      .prepare('SELECT * FROM prompt_dispatches WHERE run_id = ? ORDER BY recorded_at ASC, id ASC')
      .all(runId) as StoredDispatch[];
    const reports = db
      .prepare('SELECT * FROM runner_reports WHERE run_id = ? ORDER BY received_at ASC, id ASC')
      .all(runId) as StoredReport[];
    return {
      run,
      tasks: tasks.map((row) => ({
        runId: row.run_id,
        taskId: row.task_id,
        position: row.position,
        promptSha256: row.prompt_sha256,
      })),
      dispatches: dispatches.map((row) => this.toDispatch(row)),
      reports: reports.map((row) => this.toReceipt(row)),
    };
  }

  private toRun(row: StoredRun): PromptRun {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      sourcePath: row.source_path,
      sourceSha256: row.source_sha256,
      sourceRevision: row.source_revision,
      planRevision: row.plan_revision,
      planSha256: row.plan_sha256,
      policy: JSON.parse(row.policy_json) as RunnerPolicy,
      status: asStatus(row.status),
      stopReason: row.stop_reason,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      updatedAt: row.updated_at,
    };
  }

  private toDispatch(row: StoredDispatch): PromptDispatch {
    return {
      id: row.id,
      runId: row.run_id,
      taskId: row.task_id,
      projectId: row.project_id,
      operationKey: row.operation_key,
      promptSha256: row.prompt_sha256,
      sessionId: row.session_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      status: asDispatchStatus(row.status),
      continuationIndex: row.continuation_index,
      recordedAt: row.recorded_at,
      acceptedAt: row.accepted_at,
      turnCompletedAt: row.turn_completed_at,
      updatedAt: row.updated_at,
      lastError: row.last_error,
    };
  }

  private toReceipt(row: StoredReport): ReportReceipt {
    return {
      reportId: row.id,
      dispatchId: row.dispatch_id,
      runId: row.run_id,
      taskId: row.task_id,
      accepted: row.accepted === 1,
      disposition: row.disposition === 'unknown' ? null : (row.disposition as ReportDisposition),
      sha256: row.sha256,
      bytes: row.bytes,
      reasons: row.rejection_reason === null ? [] : row.rejection_reason.split('; '),
      receivedAt: row.received_at,
    };
  }
}

type StoredRun = {
  id: string;
  project_id: string;
  title: string;
  source_path: string;
  source_sha256: string;
  source_revision: string;
  plan_revision: number;
  plan_sha256: string;
  policy_json: string;
  status: string;
  stop_reason: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string;
};

type StoredRunTask = {
  run_id: string;
  task_id: string;
  position: number;
  prompt_sha256: string;
};

type StoredDispatch = {
  id: string;
  run_id: string;
  task_id: string;
  project_id: string;
  operation_key: string;
  prompt_sha256: string;
  session_id: string;
  thread_id: string | null;
  turn_id: string | null;
  status: string;
  continuation_index: number;
  recorded_at: string;
  accepted_at: string | null;
  turn_completed_at: string | null;
  updated_at: string;
  last_error: string | null;
};

type StoredReport = {
  id: string;
  dispatch_id: string;
  run_id: string;
  task_id: string;
  report_version: number;
  disposition: string;
  accepted: number;
  rejection_reason: string | null;
  sha256: string;
  bytes: number;
  report_json: string;
  received_at: string;
};
