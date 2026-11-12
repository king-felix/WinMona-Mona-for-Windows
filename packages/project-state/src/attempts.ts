import { createHash, randomUUID } from 'node:crypto';
import { stateError } from './errors.js';
import type { ProjectStore, WriteTransaction } from './store.js';

/**
 * The three-attempt rule as durable local state (spec 8.4, O3).
 *
 * One problem id, one append-only attempt ledger, two separate counters. The
 * consecutive counter is reset only by a linked-evidence material-progress
 * attempt; acknowledgement never touches it. At the threshold the problem
 * blocks and a fourth attempt is refused by this service, not by a model's
 * promise to stop.
 */
export type ProblemStatus = 'open' | 'blocked' | 'resolved';

export type ProblemRecord = {
  id: string;
  projectId: string | null;
  taskId: string | null;
  requirementId: string | null;
  title: string;
  symptomFingerprint: string;
  status: ProblemStatus;
  totalAttempts: number;
  consecutiveNoProgress: number;
  stopThreshold: number;
  helpNeeded: string | null;
  blockedAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AttemptRecord = {
  id: string;
  problemId: string;
  attemptNo: number;
  requirementId: string | null;
  symptomFingerprint: string;
  hypothesis: string;
  action: string;
  observedResult: string;
  evidencePath: string | null;
  materialProgress: boolean;
  progressReason: string | null;
  consecutiveNoProgress: number;
  actor: string;
  createdAt: string;
};

export type ProblemTransition = {
  id: string;
  problemId: string;
  fromStatus: ProblemStatus | null;
  toStatus: ProblemStatus;
  reason: string;
  actor: string;
  evidencePath: string | null;
  at: string;
};

export type OpenProblemInput = {
  projectId: string | null;
  taskId?: string | null;
  requirementId?: string | null;
  title: string;
  symptomFingerprint: string;
  helpNeeded?: string | null;
};

export type AttemptRecordInput = {
  problemId: string;
  hypothesis: string;
  action: string;
  observedResult: string;
  evidencePath: string;
  /** True only for independently observable advancement. */
  materialProgress: boolean;
  /** Required when materialProgress is true; the observable reason. */
  progressReason?: string;
  /** Required when this attempt crosses the stop threshold. */
  helpNeeded?: string;
  actor?: string;
  requirementId?: string | null;
};

export type AttemptOutcome = {
  problem: ProblemRecord;
  attempt: AttemptRecord;
  blockedNow: boolean;
  taskBlocked: boolean;
  handoff: ProblemHandoffCard | null;
};

/** A human-facing card. It says what happened and what exact help is required. */
export type ProblemHandoffCard = {
  problemId: string;
  title: string;
  status: ProblemStatus;
  requirementId: string | null;
  taskId: string | null;
  totalAttempts: number;
  consecutiveNoProgress: number;
  stopThreshold: number;
  blockedAt: string | null;
  helpNeeded: string;
  attempts: AttemptRecord[];
  evidencePaths: string[];
  acknowledgmentDoesNotReset: true;
};

export type AttemptSummary = {
  projectId: string;
  open: number;
  blocked: number;
  resolved: number;
  blockedProblemIds: string[];
  totalAttempts: number;
};

export type AttemptServiceOptions = {
  now?: () => Date;
  /** Spec 8.4 fixes the threshold at three; it is configurable only to test it. */
  stopThreshold?: number;
  /** Optional task bridge so a blocked problem blocks its task in the same pass. */
  tasks?: TaskGate;
};

export type TaskGate = {
  blockTask(taskId: string, reason: string, actor?: string): Promise<unknown>;
  unblockTask(taskId: string, input: { reason: string; actor: string; evidencePath?: string }): Promise<unknown>;
};

/**
 * The stable cooperative instruction for engine-internal loops Mona cannot see.
 * Mona enforces its own dispatch counters mechanically; for a loop inside one
 * engine turn it can only state this rule and collect the agent's report.
 */
export const ENGINE_ATTEMPT_INSTRUCTION = [
  'Three-attempt rule (applies inside one engine turn):',
  'One attempt is one hypothesis followed by an observed result. Keep a stable problem id and the symptom fingerprint.',
  'Material progress means a narrowed reproduction, an isolated cause, a required test that now passes, or an obtained prerequisite.',
  'After three consecutive attempts without material progress, stop that problem, record the three attempts and evidence, and state the exact human help needed.',
  'Do not make a fourth disguised attempt, delete a test, lower a criterion, or substitute fake behavior to clear the block.',
  'Acknowledging a notification is not progress and does not reset the counter.',
].join('\n');

const MAX_SHORT = 4_000;
const MAX_EVIDENCE = 1_024;
const MAX_ACTOR = 200;

function bounded(value: string | undefined, field: string, max: number, required: boolean): string {
  const text = (value ?? '').trim();
  if (!text) {
    if (required) throw stateError('invalid_request', `${field} is required`);
    return '';
  }
  if (text.length > max) throw stateError('invalid_request', `${field} exceeds ${max} characters`);
  return text;
}

function stableProblemId(projectId: string | null, fingerprint: string): string {
  const digest = createHash('sha256')
    .update(`${projectId ?? 'global'}\u0000${fingerprint}`, 'utf8')
    .digest('hex');
  return `prb_${digest.slice(0, 32)}`;
}

function rowToProblem(row: Record<string, unknown>): ProblemRecord {
  return {
    id: String(row.id),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    requirementId: row.requirement_id === null || row.requirement_id === undefined ? null : String(row.requirement_id),
    title: String(row.title),
    symptomFingerprint: String(row.symptom_fingerprint),
    status: String(row.status) as ProblemStatus,
    totalAttempts: Number(row.total_attempts),
    consecutiveNoProgress: Number(row.consecutive_no_progress),
    stopThreshold: Number(row.stop_threshold),
    helpNeeded: row.help_needed === null || row.help_needed === undefined ? null : String(row.help_needed),
    blockedAt: row.blocked_at === null || row.blocked_at === undefined ? null : String(row.blocked_at),
    resolvedAt: row.resolved_at === null || row.resolved_at === undefined ? null : String(row.resolved_at),
    resolution: row.resolution === null || row.resolution === undefined ? null : String(row.resolution),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToAttempt(row: Record<string, unknown>): AttemptRecord {
  return {
    id: String(row.id),
    problemId: String(row.problem_id),
    attemptNo: Number(row.attempt_no),
    requirementId: row.requirement_id === null || row.requirement_id === undefined ? null : String(row.requirement_id),
    symptomFingerprint: String(row.symptom_fingerprint),
    hypothesis: String(row.hypothesis),
    action: String(row.action),
    observedResult: String(row.observed_result),
    evidencePath: row.evidence_path === null || row.evidence_path === undefined ? null : String(row.evidence_path),
    materialProgress: Number(row.material_progress) === 1,
    progressReason:
      row.progress_reason === null || row.progress_reason === undefined ? null : String(row.progress_reason),
    consecutiveNoProgress: Number(row.consecutive_no_progress),
    actor: String(row.actor ?? 'mona'),
    createdAt: String(row.created_at),
  };
}

export class AttemptService {
  private readonly now: () => Date;
  private readonly stopThreshold: number;
  private readonly tasks: TaskGate | undefined;

  constructor(
    private readonly store: ProjectStore,
    options: AttemptServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const threshold = options.stopThreshold ?? 3;
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw stateError('invalid_request', 'stopThreshold must be a positive integer');
    }
    this.stopThreshold = threshold;
    this.tasks = options.tasks;
  }

  /**
   * Open (or find) one stable problem. The id is derived from the project and
   * symptom fingerprint, so a new session cannot start a fresh counter for the
   * same symptom under a different id.
   */
  async openProblem(input: OpenProblemInput): Promise<ProblemRecord> {
    const title = bounded(input.title, 'title', 200, true);
    const fingerprint = bounded(input.symptomFingerprint, 'symptomFingerprint', MAX_SHORT, true);
    const id = stableProblemId(input.projectId, fingerprint);
    return await this.store.write((tx) => {
      if (input.projectId) {
        const project = tx.db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId) as
          { id: string } | undefined;
        if (!project) throw stateError('not_found', `project ${input.projectId} does not exist`);
      }
      const existing = this.loadProblem(tx, id);
      if (existing) return existing;
      const now = tx.now();
      const threshold = this.stopThreshold;
      tx.db
        .prepare(
          `INSERT INTO problems(id, project_id, task_id, requirement_id, title, symptom_fingerprint, status,
             total_attempts, consecutive_no_progress, stop_threshold, help_needed, blocked_at, resolved_at,
             resolution, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', 0, 0, ?, ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.taskId ?? null,
          input.requirementId ?? null,
          title,
          fingerprint,
          threshold,
          input.helpNeeded ?? null,
          now,
          now,
        );
      this.writeTransition(tx, id, null, 'open', 'problem opened', 'mona', null);
      tx.bumpRevision();
      return this.loadProblem(tx, id) as ProblemRecord;
    });
  }

  async getProblem(problemId: string): Promise<ProblemRecord | null> {
    return await this.store.read((db) => {
      const row = db.prepare('SELECT * FROM problems WHERE id = ?').get(problemId) as
        Record<string, unknown> | undefined;
      return row ? rowToProblem(row) : null;
    });
  }

  async listProblems(projectId: string | null, options: { status?: ProblemStatus } = {}): Promise<ProblemRecord[]> {
    return await this.store.read((db) => {
      const rows = projectId
        ? (db
            .prepare('SELECT * FROM problems WHERE project_id = ? ORDER BY created_at ASC, id ASC')
            .all(projectId) as Array<Record<string, unknown>>)
        : (db.prepare('SELECT * FROM problems ORDER BY created_at ASC, id ASC').all() as Array<
            Record<string, unknown>
          >);
      const mapped = rows.map(rowToProblem);
      return options.status ? mapped.filter((problem) => problem.status === options.status) : mapped;
    });
  }

  async attemptsFor(problemId: string): Promise<AttemptRecord[]> {
    return await this.store.read((db) => {
      const rows = db
        .prepare('SELECT * FROM attempts WHERE problem_id = ? ORDER BY attempt_no ASC, created_at ASC')
        .all(problemId) as Array<Record<string, unknown>>;
      return rows.map(rowToAttempt);
    });
  }

  async transitionsFor(problemId: string): Promise<ProblemTransition[]> {
    return await this.store.read((db) => {
      const rows = db
        .prepare('SELECT * FROM problem_transitions WHERE problem_id = ? ORDER BY at ASC, id ASC')
        .all(problemId) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: String(row.id),
        problemId: String(row.problem_id),
        fromStatus:
          row.from_status === null || row.from_status === undefined ? null : (String(row.from_status) as ProblemStatus),
        toStatus: String(row.to_status) as ProblemStatus,
        reason: String(row.reason),
        actor: String(row.actor),
        evidencePath: row.evidence_path === null || row.evidence_path === undefined ? null : String(row.evidence_path),
        at: String(row.at),
      }));
    });
  }

  /**
   * Record one hypothesis-and-result cycle. Persisting the attempt and the
   * counters is the precondition for any continuation decision: when this
   * refuses, no fourth attempt exists anywhere.
   */
  async recordAttempt(input: AttemptRecordInput): Promise<AttemptOutcome> {
    const hypothesis = bounded(input.hypothesis, 'hypothesis', MAX_SHORT, true);
    const action = bounded(input.action, 'action', MAX_SHORT, true);
    const observed = bounded(input.observedResult, 'observedResult', MAX_SHORT, true);
    const evidencePath = bounded(input.evidencePath, 'evidencePath', MAX_EVIDENCE, true);
    const progressReason = bounded(input.progressReason, 'progressReason', MAX_SHORT, false);
    const actor = bounded(input.actor, 'actor', MAX_ACTOR, false) || 'mona';
    if (input.materialProgress && !progressReason) {
      throw stateError(
        'invalid_request',
        'material progress requires a recorded reason; more code or a new theory is not progress',
      );
    }
    if (!input.materialProgress && progressReason) {
      throw stateError('invalid_request', 'a progress reason was supplied for an attempt that claims no progress');
    }

    const outcome = await this.store.write((tx) => {
      const problem = this.loadProblem(tx, input.problemId);
      if (!problem) throw stateError('not_found', `problem ${input.problemId} does not exist`);
      if (problem.status === 'blocked') {
        throw stateError(
          'not_eligible',
          `problem ${problem.id} is blocked after ${problem.consecutiveNoProgress} no-progress attempts`,
          'record new evidence or a Victor decision with reopenProblem; acknowledgement does not reset the counter',
        );
      }
      if (problem.status === 'resolved') {
        throw stateError('invalid_request', `problem ${problem.id} is resolved; open a new problem for a new symptom`);
      }
      const attemptNo = problem.totalAttempts + 1;
      const consecutive = input.materialProgress ? 0 : problem.consecutiveNoProgress + 1;
      const blocking = consecutive >= problem.stopThreshold;
      const helpNeeded = bounded(input.helpNeeded, 'helpNeeded', MAX_SHORT, false) || problem.helpNeeded || '';
      if (blocking && !helpNeeded) {
        throw stateError(
          'invalid_request',
          'this attempt reaches the stop threshold, so the exact human help needed must be recorded',
        );
      }
      const now = tx.now();
      const attemptId = `att_${randomUUID().replaceAll('-', '')}`;
      tx.db
        .prepare(
          `INSERT INTO attempts(id, project_id, problem_id, requirement_id, symptom_fingerprint, hypothesis, action,
             observed_result, evidence_path, material_progress, progress_reason, attempt_no, actor, kind,
             consecutive_no_progress, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'attempt', ?, ?)`,
        )
        .run(
          attemptId,
          problem.projectId,
          problem.id,
          input.requirementId ?? problem.requirementId,
          problem.symptomFingerprint,
          hypothesis,
          action,
          observed,
          evidencePath,
          input.materialProgress ? 1 : 0,
          input.materialProgress ? progressReason : null,
          attemptNo,
          actor,
          consecutive,
          now,
        );
      if (blocking) {
        tx.db
          .prepare(
            `UPDATE problems SET status = 'blocked', total_attempts = ?, consecutive_no_progress = ?,
               help_needed = ?, blocked_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run(attemptNo, consecutive, helpNeeded, now, now, problem.id);
        this.writeTransition(
          tx,
          problem.id,
          problem.status,
          'blocked',
          `stop threshold reached: ${consecutive} attempts without material progress`,
          actor,
          evidencePath,
        );
      } else {
        tx.db
          .prepare('UPDATE problems SET total_attempts = ?, consecutive_no_progress = ?, updated_at = ? WHERE id = ?')
          .run(attemptNo, consecutive, now, problem.id);
      }
      tx.bumpRevision();
      const updated = this.loadProblem(tx, problem.id) as ProblemRecord;
      const row = tx.db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId) as Record<string, unknown>;
      const handoff = blocking ? this.buildHandoff(updated, this.loadAttempts(tx, problem.id)) : null;
      return { problem: updated, attempt: rowToAttempt(row), blockedNow: blocking, handoff };
    });

    let taskBlocked = false;
    if (outcome.blockedNow && outcome.problem.taskId && this.tasks) {
      try {
        await this.tasks.blockTask(
          outcome.problem.taskId,
          `blocked by problem ${outcome.problem.id}: ${outcome.problem.title}`,
          'attempt-rule',
        );
        taskBlocked = true;
      } catch {
        // The task may be pending or already closed. Its ineligibility is still
        // enforced by the blocked problem, so the refusal is not swallowed.
      }
    }
    return { ...outcome, taskBlocked };
  }

  /**
   * Acknowledge a notification. This is an audited event that never changes the
   * counters: a person saying "seen it" is not material progress.
   */
  async acknowledge(problemId: string, input: { actor: string; note?: string }): Promise<ProblemRecord> {
    const actor = bounded(input.actor, 'actor', MAX_ACTOR, true);
    const note = bounded(input.note, 'note', MAX_SHORT, false);
    return await this.store.write((tx) => {
      const problem = this.loadProblem(tx, problemId);
      if (!problem) throw stateError('not_found', `problem ${problemId} does not exist`);
      this.writeTransition(
        tx,
        problemId,
        problem.status,
        problem.status,
        `acknowledged${note ? `: ${note}` : ''}; counters unchanged`,
        actor,
        null,
      );
      tx.db.prepare('UPDATE problems SET updated_at = ? WHERE id = ?').run(tx.now(), problemId);
      tx.bumpRevision();
      return this.loadProblem(tx, problemId) as ProblemRecord;
    });
  }

  /**
   * Reopen a blocked problem with material new evidence or an explicit decision.
   * The total attempt count survives; only the consecutive counter resets, and
   * the evidence and reason are recorded.
   */
  async reopenProblem(
    problemId: string,
    input: { actor: string; reason: string; evidencePath?: string },
  ): Promise<ProblemRecord> {
    const actor = bounded(input.actor, 'actor', MAX_ACTOR, true);
    const reason = bounded(input.reason, 'reason', MAX_SHORT, true);
    const evidencePath = bounded(input.evidencePath, 'evidencePath', MAX_EVIDENCE, false);
    if (!evidencePath && actor !== 'victor') {
      throw stateError(
        'invalid_request',
        'reopening a blocked problem requires material new evidence or a Victor decision',
      );
    }
    const reopened = await this.store.write((tx) => {
      const problem = this.loadProblem(tx, problemId);
      if (!problem) throw stateError('not_found', `problem ${problemId} does not exist`);
      if (problem.status !== 'blocked') {
        throw stateError('invalid_request', `problem ${problemId} is ${problem.status}, not blocked`);
      }
      const now = tx.now();
      tx.db
        .prepare(
          `UPDATE problems SET status = 'open', consecutive_no_progress = 0, blocked_at = NULL,
             help_needed = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(now, problemId);
      this.writeTransition(
        tx,
        problemId,
        'blocked',
        'open',
        `reopened: ${reason} (total attempts preserved at ${problem.totalAttempts})`,
        actor,
        evidencePath || null,
      );
      tx.bumpRevision();
      return this.loadProblem(tx, problemId) as ProblemRecord;
    });
    if (reopened.taskId && this.tasks) {
      try {
        await this.tasks.unblockTask(reopened.taskId, {
          reason: `problem ${problemId} reopened: ${reason}`,
          actor,
          ...(evidencePath ? { evidencePath } : {}),
        });
      } catch {
        // Pending or already-running work needs no unblock; the problem is open again.
      }
    }
    return reopened;
  }

  async resolveProblem(
    problemId: string,
    input: { actor: string; reason: string; evidencePath?: string },
  ): Promise<ProblemRecord> {
    const actor = bounded(input.actor, 'actor', MAX_ACTOR, true);
    const reason = bounded(input.reason, 'reason', MAX_SHORT, true);
    const evidencePath = bounded(input.evidencePath, 'evidencePath', MAX_EVIDENCE, false);
    return await this.store.write((tx) => {
      const problem = this.loadProblem(tx, problemId);
      if (!problem) throw stateError('not_found', `problem ${problemId} does not exist`);
      if (problem.status === 'resolved')
        throw stateError('invalid_request', `problem ${problemId} is already resolved`);
      tx.db
        .prepare(
          "UPDATE problems SET status = 'resolved', resolved_at = ?, resolution = ?, updated_at = ? WHERE id = ?",
        )
        .run(tx.now(), reason, tx.now(), problemId);
      this.writeTransition(tx, problemId, problem.status, 'resolved', reason, actor, evidencePath || null);
      tx.bumpRevision();
      return this.loadProblem(tx, problemId) as ProblemRecord;
    });
  }

  /** The Victor handoff card for a blocked problem. */
  async handoffCard(problemId: string): Promise<ProblemHandoffCard> {
    return await this.store.read((db) => {
      const problem = this.loadProblemFromDb(db, problemId);
      if (!problem) throw stateError('not_found', `problem ${problemId} does not exist`);
      const rows = db
        .prepare('SELECT * FROM attempts WHERE problem_id = ? ORDER BY attempt_no ASC, created_at ASC')
        .all(problemId) as Array<Record<string, unknown>>;
      return this.buildHandoff(problem, rows.map(rowToAttempt));
    });
  }

  async summary(projectId: string): Promise<AttemptSummary> {
    return await this.store.read((db) => {
      const rows = db
        .prepare('SELECT id, status, total_attempts FROM problems WHERE project_id = ? ORDER BY id ASC')
        .all(projectId) as Array<{ id: string; status: string; total_attempts: number }>;
      return {
        projectId,
        open: rows.filter((row) => row.status === 'open').length,
        blocked: rows.filter((row) => row.status === 'blocked').length,
        resolved: rows.filter((row) => row.status === 'resolved').length,
        blockedProblemIds: rows.filter((row) => row.status === 'blocked').map((row) => row.id),
        totalAttempts: rows.reduce((sum, row) => sum + Number(row.total_attempts ?? 0), 0),
      };
    });
  }

  /**
   * Mechanical dispatch guard: a task linked to a blocked problem cannot be
   * claimed, regardless of what any model says about being ready to continue.
   */
  async assertDispatchable(taskId: string): Promise<void> {
    await this.store.read((db) => {
      const row = db.prepare("SELECT id FROM problems WHERE task_id = ? AND status = 'blocked' LIMIT 1").get(taskId) as
        { id?: string } | undefined;
      if (row?.id) {
        throw stateError(
          'not_eligible',
          `task ${taskId} is blocked by problem ${row.id}`,
          'record new evidence or a Victor decision before dispatching it again',
        );
      }
    });
  }

  private buildHandoff(problem: ProblemRecord, attempts: AttemptRecord[]): ProblemHandoffCard {
    return {
      problemId: problem.id,
      title: problem.title,
      status: problem.status,
      requirementId: problem.requirementId,
      taskId: problem.taskId,
      totalAttempts: problem.totalAttempts,
      consecutiveNoProgress: problem.consecutiveNoProgress,
      stopThreshold: problem.stopThreshold,
      blockedAt: problem.blockedAt,
      helpNeeded: problem.helpNeeded ?? 'Victor: review the recorded attempts and decide the next scope.',
      attempts,
      evidencePaths: [
        ...new Set(attempts.map((attempt) => attempt.evidencePath).filter((path): path is string => Boolean(path))),
      ],
      acknowledgmentDoesNotReset: true,
    };
  }

  private loadProblem(tx: WriteTransaction, problemId: string): ProblemRecord | null {
    const row = tx.db.prepare('SELECT * FROM problems WHERE id = ?').get(problemId) as
      Record<string, unknown> | undefined;
    return row ? rowToProblem(row) : null;
  }

  private loadProblemFromDb(db: WriteTransaction['db'], problemId: string): ProblemRecord | null {
    const row = db.prepare('SELECT * FROM problems WHERE id = ?').get(problemId) as Record<string, unknown> | undefined;
    return row ? rowToProblem(row) : null;
  }

  private loadAttempts(tx: WriteTransaction, problemId: string): AttemptRecord[] {
    const rows = tx.db
      .prepare('SELECT * FROM attempts WHERE problem_id = ? ORDER BY attempt_no ASC, created_at ASC')
      .all(problemId) as Array<Record<string, unknown>>;
    return rows.map(rowToAttempt);
  }

  private writeTransition(
    tx: WriteTransaction,
    problemId: string,
    from: ProblemStatus | null,
    to: ProblemStatus,
    reason: string,
    actor: string,
    evidencePath: string | null,
  ): void {
    tx.db
      .prepare(
        `INSERT INTO problem_transitions(id, problem_id, from_status, to_status, reason, actor, evidence_path, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`ptr_${randomUUID().replaceAll('-', '')}`, problemId, from, to, reason, actor, evidencePath, tx.now());
  }
}
